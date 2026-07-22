import { randomUUID } from "node:crypto";
import { APIError, api } from "encore.dev/api";
import { MaxLen } from "encore.dev/validate";
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openSecret } from "./crypto";
import { currentSubaccount, settingsFor } from "./data";
import { db } from "./db";
import { NATIVE_TOKEN_ADDRESS, robinhoodChain, robinhoodClient } from "./portfolio";
import { acquireWalletLock } from "./walletLock";
import {
  bufferedGasLimit,
  nativeWithdrawalAmount,
  parseWithdrawalRequest,
  tokenWithdrawalAmount,
} from "./withdrawalValue";

interface WithdrawRequest {
  request_id: string & MaxLen<64>;
  asset_address: string & MaxLen<64>;
  amount: string & MaxLen<79>;
}

interface WithdrawalRow {
  id: string;
  request_id: string;
  asset_address: string;
  asset_symbol: string;
  asset_decimals: number;
  requested_amount: string;
  amount: string | null;
  recipient: string;
  status: "preparing" | "submitted" | "confirmed" | "failed" | "submission_unknown";
  transaction_hash: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WithdrawalResult {
  id: string;
  request_id: string;
  asset_address: string;
  asset_symbol: string;
  asset_decimals: number;
  amount: string | null;
  recipient: string;
  status: WithdrawalRow["status"];
  transaction_hash: string | null;
  explorer_url: string | null;
  error: string | null;
}

function resultFor(row: WithdrawalRow): WithdrawalResult {
  return {
    id: row.id,
    request_id: row.request_id,
    asset_address: row.asset_address,
    asset_symbol: row.asset_symbol,
    asset_decimals: row.asset_decimals,
    amount: row.amount,
    recipient: row.recipient,
    status: row.status,
    transaction_hash: row.transaction_hash,
    explorer_url: row.transaction_hash
      ? `https://robinhoodchain.blockscout.com/tx/${row.transaction_hash}`
      : null,
    error: row.failure_reason,
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]")
    .slice(0, 600);
}

async function withdrawalByRequest(subaccountID: string, requestID: string): Promise<WithdrawalRow | null> {
  return db.queryRow<WithdrawalRow>`
    SELECT
      id, request_id, asset_address, asset_symbol, asset_decimals, requested_amount,
      amount::text AS amount, recipient, status, transaction_hash,
      failure_reason, created_at, updated_at
    FROM withdrawal_executions
    WHERE subaccount_id = ${subaccountID} AND request_id = ${requestID}
  `;
}

function validRequestID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const withdrawFunds = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/wallet/withdraw" },
  async (request: WithdrawRequest): Promise<WithdrawalResult> => {
    if (!validRequestID(request.request_id)) throw APIError.invalidArgument("A valid withdrawal request ID is required");
    if (!isAddress(request.asset_address)) throw APIError.invalidArgument("A valid asset address is required");
    let requested: "all" | bigint;
    try {
      requested = parseWithdrawalRequest(request.amount);
    } catch (error) {
      throw APIError.invalidArgument(safeMessage(error));
    }

    const subaccount = await currentSubaccount();
    const settings = await settingsFor(subaccount.id);
    if (settings.agent_status !== "paused") {
      throw APIError.failedPrecondition("Pause the agent before withdrawing funds");
    }
    const existing = await withdrawalByRequest(subaccount.id, request.request_id);
    if (existing) return resultFor(existing);

    const asset = getAddress(request.asset_address);
    const recipient = getAddress(subaccount.owner_wallet_address);
    const id = randomUUID();
    const inserted = await db.queryRow<WithdrawalRow>`
      INSERT INTO withdrawal_executions (
        id, subaccount_id, request_id, asset_address, asset_symbol, asset_decimals,
        requested_amount, recipient
      ) VALUES (
        ${id}, ${subaccount.id}, ${request.request_id}, ${asset},
        ${asset === NATIVE_TOKEN_ADDRESS ? "ETH" : "TOKEN"}, 18,
        ${request.amount}, ${recipient}
      )
      ON CONFLICT (subaccount_id, request_id) DO NOTHING
      RETURNING
        id, request_id, asset_address, asset_symbol, asset_decimals, requested_amount,
        amount::text AS amount, recipient, status, transaction_hash,
        failure_reason, created_at, updated_at
    `;
    if (!inserted) {
      return resultFor((await withdrawalByRequest(subaccount.id, request.request_id))!);
    }

    let releaseWalletLock: (() => Promise<void>) | undefined;
    let submittedHash: Hex | null = null;
    let broadcastAttempted = false;
    let submissionKnownFailed = false;
    try {
      releaseWalletLock = await acquireWalletLock(subaccount.id);
      const client = robinhoodClient(4663);
      if (await client.getChainId() !== 4663) throw new Error("The wallet RPC is not connected to Robinhood Chain mainnet");
      const wallet = getAddress(subaccount.agent_wallet_address);
      const privateKey = openSecret(subaccount.encrypted_agent_private_key, `agent-key:${subaccount.id}`) as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Stored agent key is invalid");
      const account = privateKeyToAccount(privateKey);
      if (account.address !== wallet) throw new Error("Stored agent key does not match the agent wallet");
      const chain = robinhoodChain(4663);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(process.env.ROBINHOOD_MAINNET_RPC_URL?.trim() || chain.rpcUrls.default.http[0]),
      });
      const nativeBalance = await client.getBalance({ address: wallet });
      const gasPrice = await client.getGasPrice();
      let amount: bigint;
      let tokenBalanceBefore: bigint | null = null;
      let assetSymbol = "ETH";
      let assetDecimals = 18;
      let transaction: { to: Address; data?: Hex; value?: bigint; gas: bigint; gasPrice: bigint };

      if (asset === NATIVE_TOKEN_ADDRESS) {
        if (nativeBalance === 0n) throw new Error("The agent wallet has no native ETH to withdraw");
        const estimateValue = requested === "all" ? 1n : requested;
        const estimate = await client.estimateGas({ account: wallet, to: recipient, value: estimateValue });
        const gas = bufferedGasLimit(estimate);
        amount = nativeWithdrawalAmount(requested, nativeBalance, gas * gasPrice);
        transaction = { to: recipient, value: amount, gas, gasPrice };
      } else {
        const code = await client.getCode({ address: asset });
        if (!code || code === "0x") throw new Error("The selected token is not a contract on Robinhood Chain mainnet");
        tokenBalanceBefore = await client.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        });
        amount = tokenWithdrawalAmount(requested, tokenBalanceBefore);
        try {
          const [symbol, decimals] = await Promise.all([
            client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
            client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
          ]);
          if (typeof symbol === "string" && symbol.trim()) assetSymbol = symbol.trim().slice(0, 24);
          if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) assetDecimals = decimals;
        } catch {
          assetSymbol = "TOKEN";
          assetDecimals = 18;
        }
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        });
        const estimate = await client.estimateGas({ account: wallet, to: asset, data });
        const gas = bufferedGasLimit(estimate);
        if (nativeBalance < gas * gasPrice) throw new Error("The agent wallet needs native ETH for token withdrawal gas");
        transaction = { to: asset, data, gas, gasPrice };
      }

      await db.exec`
        UPDATE withdrawal_executions SET
          amount = ${amount.toString()}, asset_symbol = ${assetSymbol},
          asset_decimals = ${assetDecimals}, updated_at = NOW()
        WHERE id = ${id}
      `;
      broadcastAttempted = true;
      submittedHash = await walletClient.sendTransaction(transaction);
      await db.exec`
        UPDATE withdrawal_executions SET
          status = 'submitted', transaction_hash = ${submittedHash}, updated_at = NOW()
        WHERE id = ${id}
      `;
      const receipt = await client.waitForTransactionReceipt({ hash: submittedHash, confirmations: 1, timeout: 120_000 });
      if (receipt.status !== "success") {
        submissionKnownFailed = true;
        throw new Error(`Withdrawal transaction ${submittedHash} reverted`);
      }
      if (asset !== NATIVE_TOKEN_ADDRESS) {
        const remaining = await client.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        });
        if (tokenBalanceBefore === null || tokenBalanceBefore - remaining < amount) {
          submissionKnownFailed = true;
          throw new Error("The token contract did not debit the expected withdrawal amount");
        }
      }
      await db.exec`
        UPDATE withdrawal_executions SET status = 'confirmed', updated_at = NOW() WHERE id = ${id}
      `;
    } catch (error) {
      const status = broadcastAttempted && !submissionKnownFailed ? "submission_unknown" : "failed";
      await db.exec`
        UPDATE withdrawal_executions SET
          status = ${status}, failure_reason = ${safeMessage(error)},
          transaction_hash = COALESCE(transaction_hash, ${submittedHash}),
          updated_at = NOW()
        WHERE id = ${id}
      `;
    } finally {
      await releaseWalletLock?.().catch(() => undefined);
    }
    return resultFor((await withdrawalByRequest(subaccount.id, request.request_id))!);
  },
);
