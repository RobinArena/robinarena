import { api } from "encore.dev/api";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { currentSubaccount, type RobinhoodChainID, type SubaccountRow } from "./data";
import { db } from "./db";

export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface TokenBalance {
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  formatted_balance: string;
}

export interface PortfolioSnapshot {
  chain_id: RobinhoodChainID;
  chain_name: string;
  wallet_address: string;
  native_balance: string;
  native_formatted_balance: string;
  tokens: TokenBalance[];
  token_discovery_complete: boolean;
  token_discovery_error: string | null;
  block_number: string;
  as_of: Date;
}

export function robinhoodChain(chainID: RobinhoodChainID) {
  return defineChain({
    id: chainID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: {
        http: ["https://rpc.mainnet.chain.robinhood.com"],
      },
    },
    blockExplorers: {
      default: {
        name: "Blockscout",
        url: "https://robinhoodchain.blockscout.com",
      },
    },
  });
}

export function robinhoodClient(chainID: RobinhoodChainID): PublicClient {
  const chain = robinhoodChain(chainID);
  const configured = process.env.ROBINHOOD_MAINNET_RPC_URL?.trim();
  return createPublicClient({
    chain,
    transport: http(configured || chain.rpcUrls.default.http[0], {
      timeout: 12_000,
      retryCount: 2,
    }),
  });
}

interface TokenDiscoveryState {
  addresses: Set<Address>;
  next_block: bigint;
  limited: boolean;
}

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const tokenDiscovery = new Map<string, TokenDiscoveryState>();
const TOKEN_SCAN_CHUNK = 250_000n;
const MAX_TRACKED_TOKENS = 250;

function initialTokenScanBlock(blockNumber: bigint, blockTimestamp: bigint, createdAt: Date): bigint {
  const createdAtSeconds = BigInt(Math.floor(createdAt.getTime() / 1000));
  const ageSeconds = blockTimestamp > createdAtSeconds ? blockTimestamp - createdAtSeconds : 0n;
  const historyBlocks = ageSeconds * 20n + 360_000n;
  return blockNumber > historyBlocks ? blockNumber - historyBlocks : 0n;
}

function trackTokenAddresses(state: TokenDiscoveryState, logs: readonly { address: Address }[]): void {
  for (const log of logs) {
    if (state.addresses.size >= MAX_TRACKED_TOKENS) {
      state.limited = true;
      return;
    }
    state.addresses.add(getAddress(log.address));
  }
}

async function tokenBalance(
  client: PublicClient,
  wallet: Address,
  address: Address,
): Promise<TokenBalance | null> {
  try {
    const balance = await client.readContract({
      address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    });
    if (balance === 0n) return null;
    const [symbolResult, decimalsResult] = await Promise.allSettled([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    if (decimalsResult.status !== "fulfilled") return null;
    const decimals = decimalsResult.value;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
    const rawSymbol = symbolResult.status === "fulfilled" ? symbolResult.value : "TOKEN";
    const symbol = rawSymbol.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) || "TOKEN";
    return {
      address,
      symbol,
      decimals,
      balance: balance.toString(),
      formatted_balance: formatUnits(balance, decimals),
    };
  } catch {
    return null;
  }
}

async function discoveredTokenBalances(
  client: PublicClient,
  wallet: Address,
  blockNumber: bigint,
  blockTimestamp: bigint,
  createdAt: Date,
  recordedTokens: readonly Address[],
): Promise<{
  tokens: TokenBalance[];
  complete: boolean;
  error: string | null;
}> {
  const key = `${client.chain?.id ?? 4663}:${wallet}`;
  let state = tokenDiscovery.get(key);
  if (!state || state.next_block > blockNumber + 1n) {
    state = {
      addresses: new Set<Address>(),
      next_block: initialTokenScanBlock(blockNumber, blockTimestamp, createdAt),
      limited: false,
    };
    tokenDiscovery.set(key, state);
  }
  trackTokenAddresses(state, recordedTokens.map((address) => ({ address })));
  let scanComplete = true;
  try {
    while (state.next_block <= blockNumber) {
      const fromBlock = state.next_block;
      const toBlock = fromBlock + TOKEN_SCAN_CHUNK - 1n < blockNumber
        ? fromBlock + TOKEN_SCAN_CHUNK - 1n
        : blockNumber;
      const [incoming, outgoing] = await Promise.all([
        client.getLogs({
          event: transferEvent,
          args: { to: wallet },
          fromBlock,
          toBlock,
          strict: false,
        }),
        client.getLogs({
          event: transferEvent,
          args: { from: wallet },
          fromBlock,
          toBlock,
          strict: false,
        }),
      ]);
      trackTokenAddresses(state, incoming);
      trackTokenAddresses(state, outgoing);
      state.next_block = toBlock + 1n;
    }
  } catch {
    scanComplete = false;
  }

  const tokens: TokenBalance[] = [];
  const addresses = [...state.addresses];
  for (let index = 0; index < addresses.length; index += 20) {
    const page = await Promise.all(
      addresses.slice(index, index + 20).map((address) => tokenBalance(client, wallet, address)),
    );
    for (const token of page) if (token) tokens.push(token);
  }
  tokens.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address));
  const complete = scanComplete && !state.limited;
  return {
    tokens,
    complete,
    error: complete
      ? null
      : state.limited
        ? "Token discovery is capped at 250 contracts."
        : "Token history is still being indexed. Refresh to continue.",
  };
}

async function recordedTokenAddresses(subaccountID: string): Promise<Address[]> {
  const addresses: Address[] = [];
  for await (const row of db.query<{ address: string }>`
    SELECT DISTINCT address
    FROM (
      SELECT token_in AS address FROM swap_executions WHERE subaccount_id = ${subaccountID}
      UNION ALL
      SELECT token_out AS address FROM swap_executions WHERE subaccount_id = ${subaccountID}
      UNION ALL
      SELECT asset_address AS address FROM withdrawal_executions WHERE subaccount_id = ${subaccountID}
    ) AS recorded
    WHERE address <> ${NATIVE_TOKEN_ADDRESS}
    LIMIT ${MAX_TRACKED_TOKENS}
  `) {
    if (isAddress(row.address)) addresses.push(getAddress(row.address));
  }
  return addresses;
}

export async function portfolioForSubaccount(subaccount: SubaccountRow): Promise<PortfolioSnapshot> {
  const client = robinhoodClient(subaccount.chain_id);
  const wallet = getAddress(subaccount.agent_wallet_address);
  const [actualChainID, nativeBalance, block, recordedTokens] = await Promise.all([
    client.getChainId(),
    client.getBalance({ address: wallet }),
    client.getBlock(),
    recordedTokenAddresses(subaccount.id),
  ]);
  if (actualChainID !== 4663) throw new Error(`refusing RPC chain ${actualChainID}; Robinhood Chain mainnet is 4663`);
  if (block.number === null) throw new Error("the Robinhood Chain RPC omitted the latest block number");
  const discovery = await discoveredTokenBalances(
    client,
    wallet,
    block.number,
    block.timestamp,
    subaccount.created_at,
    recordedTokens,
  );
  const chain = robinhoodChain(subaccount.chain_id);
  return {
    chain_id: subaccount.chain_id,
    chain_name: chain.name,
    wallet_address: wallet,
    native_balance: nativeBalance.toString(),
    native_formatted_balance: formatUnits(nativeBalance, 18),
    tokens: discovery.tokens,
    token_discovery_complete: discovery.complete,
    token_discovery_error: discovery.error,
    block_number: block.number.toString(),
    as_of: new Date(),
  };
}

export const getPortfolio = api(
  { expose: true, auth: true, method: "GET", path: "/portfolio" },
  async (): Promise<PortfolioSnapshot> => portfolioForSubaccount(await currentSubaccount()),
);

