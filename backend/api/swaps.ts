import { randomUUID } from "node:crypto";
import { APIError } from "encore.dev/api";
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
import { db } from "./db";
import { settingsFor, type SubaccountRow } from "./data";
import { NATIVE_TOKEN_ADDRESS, robinhoodChain, robinhoodClient } from "./portfolio";
import { requestBestSwapQuote, type SwapQuoteSelection } from "./swapAggregator";
import {
  assertNativeReserveAfterTransaction,
  reserveRequiredBeforeNativeCredit,
} from "./swapReserve";
import { SWAP_SLIPPAGE_BPS } from "./tradingPolicy";
import { acquireWalletLock } from "./walletLock";

interface ExecutionRow {
  id: string;
  run_id: string;
  tool_call_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  minimum_amount_out: string | null;
  quoted_amount_out: string | null;
  status: "preparing" | "submitted" | "confirmed" | "failed" | "submission_unknown";
  transaction_hash: string | null;
  approval_transaction_hash: string | null;
  routing: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AutonomousSwapRequest {
  run_id: string;
  tool_call_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  reason: string;
}

export interface AutonomousSwapResult {
  execution_id: string;
  status: ExecutionRow["status"];
  token_in: string;
  token_out: string;
  amount_in: string;
  quoted_amount_out: string | null;
  minimum_amount_out: string | null;
  transaction_hash: string | null;
  approval_transaction_hash: string | null;
  routing: string | null;
  explorer_url: string | null;
  error: string | null;
}

function resultFor(row: ExecutionRow): AutonomousSwapResult {
  return {
    execution_id: row.id,
    status: row.status,
    token_in: row.token_in,
    token_out: row.token_out,
    amount_in: row.amount_in,
    quoted_amount_out: row.quoted_amount_out,
    minimum_amount_out: row.minimum_amount_out,
    transaction_hash: row.transaction_hash,
    approval_transaction_hash: row.approval_transaction_hash,
    routing: row.routing,
    explorer_url: row.transaction_hash
      ? `https://robinhoodchain.blockscout.com/tx/${row.transaction_hash}`
      : null,
    error: row.failure_reason,
  };
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}

function normalizedToken(value: string, field: string): Address {
  if (!isAddress(value)) throw APIError.invalidArgument(`${field} must be an EVM token address`);
  return getAddress(value);
}

function unsignedAmount(value: string): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(value)) {
    throw APIError.invalidArgument("amount_in must be a positive base-unit integer");
  }
  return BigInt(value);
}

async function sendAndConfirm(
  sendTransaction: (transaction: { to: Address; data: Hex; value: bigint }) => Promise<Hex>,
  publicClient: ReturnType<typeof robinhoodClient>,
  wallet: Address,
  minimumReserve: bigint,
  transaction: { to: Address; data: Hex; value: bigint },
): Promise<Hex> {
  await assertGasReserve(publicClient, wallet, minimumReserve, transaction);
  const hash = await sendTransaction(transaction);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

async function assertGasReserve(
  publicClient: ReturnType<typeof robinhoodClient>,
  wallet: Address,
  minimumReserve: bigint,
  transaction: { to: Address; data: Hex; value: bigint },
  nativeCredit = 0n,
): Promise<void> {
  const [balance, gas, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: wallet }),
    publicClient.estimateGas({ account: wallet, ...transaction }),
    publicClient.getGasPrice(),
  ]);
  const bufferedGasCost = gas * gasPrice * 12n / 10n;
  assertNativeReserveAfterTransaction({
    balance,
    transactionValue: transaction.value,
    bufferedGasCost,
    nativeCredit,
    minimumReserve,
  });
}

async function ensureExactApproval(
  sendTransaction: (transaction: { to: Address; data: Hex; value: bigint }) => Promise<Hex>,
  publicClient: ReturnType<typeof robinhoodClient>,
  wallet: Address,
  minimumReserve: bigint,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<Hex | null> {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet, spender],
  });
  if (allowance === amount) return null;

  const approvalTransaction = (approvalAmount: bigint) => ({
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, approvalAmount],
    }),
    value: 0n,
  });

  let latestHash: Hex | null = null;
  if (allowance > 0n) {
    latestHash = await sendAndConfirm(
      sendTransaction,
      publicClient,
      wallet,
      minimumReserve,
      approvalTransaction(0n),
    );
  }
  if (amount === 0n) return latestHash;
  latestHash = await sendAndConfirm(
    sendTransaction,
    publicClient,
    wallet,
    minimumReserve,
    approvalTransaction(amount),
  );
  const confirmedAllowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet, spender],
  });
  if (confirmedAllowance !== amount) throw new Error("swap approval did not set the exact allowance");
  return latestHash;
}

async function assertQuoteTarget(
  publicClient: ReturnType<typeof robinhoodClient>,
  target: Address,
): Promise<void> {
  const targetCode = await publicClient.getCode({ address: target });
  if (!targetCode || targetCode === "0x") {
    throw new Error("swap transaction target is not a contract on Robinhood Chain mainnet");
  }
}

function quoteSelectionMetadata(selection: SwapQuoteSelection) {
  return {
    selected_provider: selection.quote.provider,
    quoted_slippage_bps: selection.quote.slippageBps,
    quote_candidates: selection.candidates,
    quote_provider_errors: selection.provider_errors,
  };
}

async function executionByToolCall(subaccountID: string, toolCallID: string): Promise<ExecutionRow | null> {
  return db.queryRow<ExecutionRow>`
    SELECT
      id, run_id, tool_call_id, token_in, token_out, amount_in::text AS amount_in,
      minimum_amount_out::text AS minimum_amount_out,
      quoted_amount_out::text AS quoted_amount_out, status, transaction_hash,
      approval_transaction_hash, routing, failure_reason, created_at, updated_at
    FROM swap_executions
    WHERE subaccount_id = ${subaccountID} AND tool_call_id = ${toolCallID}
  `;
}

export async function executeAutonomousSwap(
  subaccount: SubaccountRow,
  request: AutonomousSwapRequest,
): Promise<AutonomousSwapResult> {
  const existing = await executionByToolCall(subaccount.id, request.tool_call_id);
  if (existing) return resultFor(existing);

  const settings = await settingsFor(subaccount.id);
  if (settings.agent_status !== "active") throw APIError.failedPrecondition("the autonomous agent is paused");
  if (subaccount.chain_id !== 4663) throw APIError.failedPrecondition("only Robinhood Chain mainnet is supported");

  const tokenIn = normalizedToken(request.token_in, "token_in");
  const tokenOut = normalizedToken(request.token_out, "token_out");
  if (tokenIn === tokenOut) throw APIError.invalidArgument("input and output tokens must differ");
  const amount = unsignedAmount(request.amount_in);

  const id = randomUUID();
  const inserted = await db.queryRow<ExecutionRow>`
    INSERT INTO swap_executions (
      id, subaccount_id, run_id, tool_call_id, chain_id, token_in, token_out,
      amount_in, status, metadata
    ) VALUES (
      ${id}, ${subaccount.id}, ${request.run_id}, ${request.tool_call_id}, 4663,
      ${tokenIn}, ${tokenOut}, ${amount.toString()}, 'preparing',
      ${JSON.stringify({ reason: request.reason.slice(0, 1000), maximum_slippage_bps: SWAP_SLIPPAGE_BPS })}::jsonb
    )
    ON CONFLICT (subaccount_id, tool_call_id) DO NOTHING
    RETURNING
      id, run_id, tool_call_id, token_in, token_out, amount_in::text AS amount_in,
      minimum_amount_out::text AS minimum_amount_out,
      quoted_amount_out::text AS quoted_amount_out, status, transaction_hash,
      approval_transaction_hash, routing, failure_reason, created_at, updated_at
  `;
  if (!inserted) return resultFor((await executionByToolCall(subaccount.id, request.tool_call_id))!);

  let approvalHash: Hex | null = null;
  let submittedHash: Hex | null = null;
  let submissionKnownFailed = false;
  let releaseWalletLock: (() => Promise<void>) | undefined;
  try {
    releaseWalletLock = await acquireWalletLock(subaccount.id);
    const publicClient = robinhoodClient(4663);
    const chainID = await publicClient.getChainId();
    if (chainID !== 4663) throw new Error(`refusing RPC chain ${chainID}; Robinhood Chain mainnet is 4663`);

    const wallet = getAddress(subaccount.agent_wallet_address);
    const privateKey = openSecret(subaccount.encrypted_agent_private_key, `agent-key:${subaccount.id}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("stored agent key is invalid");
    const account = privateKeyToAccount(privateKey);
    if (account.address !== wallet) throw new Error("stored agent key does not match the subaccount address");

    const chain = robinhoodChain(4663);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(process.env.ROBINHOOD_MAINNET_RPC_URL?.trim() || chain.rpcUrls.default.http[0]),
    });

    const nativeBalance = await publicClient.getBalance({ address: wallet });
    const minimumReserve = BigInt(settings.minimum_native_reserve_wei);
    const receivesNative = tokenOut === NATIVE_TOKEN_ADDRESS;
    const reserveBeforeNativeCredit = reserveRequiredBeforeNativeCredit(minimumReserve, receivesNative);
    let inputBalance = nativeBalance;
    for (const token of [tokenIn, tokenOut]) {
      if (token === NATIVE_TOKEN_ADDRESS) continue;
      const code = await publicClient.getCode({ address: token });
      if (!code || code === "0x") throw new Error(`${token} is not a contract on Robinhood Chain mainnet`);
    }
    if (tokenIn !== NATIVE_TOKEN_ADDRESS) {
      inputBalance = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      });
      if (nativeBalance < reserveBeforeNativeCredit) {
        throw new Error("native ETH balance is below the automatic network-fee reserve");
      }
    } else if (amount + minimumReserve > nativeBalance) {
      throw new Error("swap would spend the automatic native ETH network-fee reserve");
    }
    if (amount > inputBalance) throw new Error("swap amount exceeds the input token balance");

    const quoteRequest = {
      chainId: 4663 as const,
      wallet,
      tokenIn,
      tokenOut,
      amount,
      slippageBps: SWAP_SLIPPAGE_BPS,
      nativeToken: getAddress(NATIVE_TOKEN_ADDRESS),
    };
    let selection = await requestBestSwapQuote(quoteRequest);
    let quote = selection.quote;
    await assertQuoteTarget(publicClient, quote.transaction.to);
    await db.exec`
      UPDATE swap_executions SET
        metadata = metadata || ${JSON.stringify(quoteSelectionMetadata(selection))}::jsonb,
        updated_at = now()
      WHERE id = ${id}
    `;
    if (tokenIn !== NATIVE_TOKEN_ADDRESS) {
      approvalHash = await ensureExactApproval(
        (transaction) => walletClient.sendTransaction(transaction),
        publicClient,
        wallet,
        reserveBeforeNativeCredit,
        tokenIn,
        quote.approvalAddress,
        amount,
      );
      if (approvalHash) {
        await db.exec`
          UPDATE swap_executions SET approval_transaction_hash = ${approvalHash}, updated_at = now()
          WHERE id = ${id}
        `;
      }
      if (Date.now() - quote.quotedAtMs > 45_000) {
        const previousSpender = quote.approvalAddress;
        selection = await requestBestSwapQuote(quoteRequest);
        quote = selection.quote;
        await assertQuoteTarget(publicClient, quote.transaction.to);
        await db.exec`
          UPDATE swap_executions SET
            metadata = metadata || ${JSON.stringify(quoteSelectionMetadata(selection))}::jsonb,
            updated_at = now()
          WHERE id = ${id}
        `;
        if (previousSpender.toLowerCase() !== quote.approvalAddress.toLowerCase()) {
          const revocationHash = await ensureExactApproval(
            (transaction) => walletClient.sendTransaction(transaction),
            publicClient,
            wallet,
            reserveBeforeNativeCredit,
            tokenIn,
            previousSpender,
            0n,
          );
          if (revocationHash) {
            approvalHash = revocationHash;
            await db.exec`
              UPDATE swap_executions SET approval_transaction_hash = ${approvalHash}, updated_at = now()
              WHERE id = ${id}
            `;
          }
        }
        const refreshedApprovalHash = await ensureExactApproval(
          (transaction) => walletClient.sendTransaction(transaction),
          publicClient,
          wallet,
          reserveBeforeNativeCredit,
          tokenIn,
          quote.approvalAddress,
          amount,
        );
        if (refreshedApprovalHash) {
          approvalHash = refreshedApprovalHash;
          await db.exec`
            UPDATE swap_executions SET approval_transaction_hash = ${approvalHash}, updated_at = now()
            WHERE id = ${id}
          `;
        }
      }
    }
    if (Date.now() - quote.quotedAtMs > 45_000) {
      throw new Error("swap quote expired while preparing the transaction; retry on the next cycle");
    }

    const transaction = quote.transaction;
    const guaranteedNativeOutput = receivesNative
      ? quote.minimumAmountOut
      : 0n;
    await assertGasReserve(
      publicClient,
      wallet,
      minimumReserve,
      transaction,
      guaranteedNativeOutput,
    );
    submittedHash = await walletClient.sendTransaction({
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
    });
    await db.exec`
      UPDATE swap_executions SET
        status = 'submitted', transaction_hash = ${submittedHash}, routing = ${quote.routing},
        quoted_amount_out = ${quote.quotedAmountOut.toString()},
        minimum_amount_out = ${quote.minimumAmountOut.toString()}, updated_at = now()
      WHERE id = ${id}
    `;
    const receipt = await publicClient.waitForTransactionReceipt({ hash: submittedHash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") {
      submissionKnownFailed = true;
      throw new Error(`swap transaction ${submittedHash} reverted`);
    }
    await db.exec`
      UPDATE swap_executions SET status = 'confirmed', updated_at = now() WHERE id = ${id}
    `;
  } catch (error) {
    const status = submittedHash && !submissionKnownFailed ? "submission_unknown" : "failed";
    await db.exec`
      UPDATE swap_executions SET
        status = ${status}, failure_reason = ${safeMessage(error)},
        transaction_hash = COALESCE(transaction_hash, ${submittedHash}),
        approval_transaction_hash = COALESCE(approval_transaction_hash, ${approvalHash}),
        updated_at = now()
      WHERE id = ${id}
    `;
  } finally {
    await releaseWalletLock?.().catch(() => undefined);
  }
  return resultFor((await executionByToolCall(subaccount.id, request.tool_call_id))!);
}
