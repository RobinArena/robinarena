import { getAddress, isAddress } from "viem";

const DEX_SCREENER_API = "https://api.dexscreener.com";
const DEX_SCREENER_CHAIN = "robinhood";
const CACHE_TTL_MS = 30_000;
const MAX_PAIRS = 12;

interface DexScreenerToken {
  address?: string;
  name?: string;
  symbol?: string;
}

export interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[] | null;
  baseToken?: DexScreenerToken;
  quoteToken?: DexScreenerToken;
  priceNative?: string;
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: { usd?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
}

export interface DexScreenerPairSummary {
  pair_address: string;
  dex_id: string;
  url: string;
  labels: string[];
  base_token: { address: string; name: string; symbol: string };
  quote_token: { address: string; name: string; symbol: string };
  price_native: string | null;
  price_usd: string | null;
  liquidity_usd: number | null;
  fdv_usd: number | null;
  market_cap_usd: number | null;
  transactions: Record<string, { buys: number; sells: number }>;
  volume_usd: Record<string, number>;
  price_change_percent: Record<string, number>;
  pair_created_at: string | null;
}

export interface DexScreenerReadResult {
  source: "DEX Screener";
  source_url: string;
  chain_id: "robinhood";
  query_address: string;
  as_of: string;
  pairs: DexScreenerPairSummary[];
  note: string | null;
}

const cache = new Map<string, { expiresAt: number; value: DexScreenerReadResult }>();
const inFlight = new Map<string, Promise<DexScreenerReadResult>>();

function cleanText(value: unknown, maximum = 120): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum);
}

function cleanAddress(value: unknown): string {
  const text = cleanText(value, 42);
  return isAddress(text) ? getAddress(text) : text;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, number> = {};
  for (const period of ["m5", "h1", "h6", "h24"]) {
    const number = finiteNumber((value as Record<string, unknown>)[period]);
    if (number !== null) output[period] = number;
  }
  return output;
}

function transactionMap(value: unknown): Record<string, { buys: number; sells: number }> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, { buys: number; sells: number }> = {};
  for (const period of ["m5", "h1", "h6", "h24"]) {
    const entry = (value as Record<string, unknown>)[period];
    if (!entry || typeof entry !== "object") continue;
    const buys = finiteNumber((entry as Record<string, unknown>).buys);
    const sells = finiteNumber((entry as Record<string, unknown>).sells);
    if (buys !== null || sells !== null) output[period] = { buys: buys ?? 0, sells: sells ?? 0 };
  }
  return output;
}

function tokenSummary(value: DexScreenerToken | undefined) {
  return {
    address: cleanAddress(value?.address),
    name: cleanText(value?.name, 80),
    symbol: cleanText(value?.symbol, 24),
  };
}

function pairCreatedAt(value: unknown): string | null {
  const milliseconds = finiteNumber(value);
  if (milliseconds === null || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pairSummary(pair: DexScreenerPair): DexScreenerPairSummary {
  return {
    pair_address: cleanAddress(pair.pairAddress),
    dex_id: cleanText(pair.dexId, 40),
    url: cleanText(pair.url, 300),
    labels: (pair.labels ?? []).map((label) => cleanText(label, 30)).filter(Boolean).slice(0, 6),
    base_token: tokenSummary(pair.baseToken),
    quote_token: tokenSummary(pair.quoteToken),
    price_native: cleanText(pair.priceNative, 80) || null,
    price_usd: cleanText(pair.priceUsd, 80) || null,
    liquidity_usd: finiteNumber(pair.liquidity?.usd),
    fdv_usd: finiteNumber(pair.fdv),
    market_cap_usd: finiteNumber(pair.marketCap),
    transactions: transactionMap(pair.txns),
    volume_usd: numberMap(pair.volume),
    price_change_percent: numberMap(pair.priceChange),
    pair_created_at: pairCreatedAt(pair.pairCreatedAt),
  };
}

export function summarizeDexScreenerPairs(
  address: string,
  pairs: readonly DexScreenerPair[],
  asOf = new Date(),
): DexScreenerReadResult {
  const normalizedAddress = getAddress(address);
  const unique = new Map<string, DexScreenerPair>();
  for (const pair of pairs) {
    if (pair.chainId !== DEX_SCREENER_CHAIN || !isAddress(pair.pairAddress ?? "")) continue;
    unique.set(getAddress(pair.pairAddress!).toLowerCase(), pair);
  }
  const summaries = [...unique.values()]
    .sort((left, right) => {
      const liquidity = (finiteNumber(right.liquidity?.usd) ?? 0) - (finiteNumber(left.liquidity?.usd) ?? 0);
      if (liquidity !== 0) return liquidity;
      return (finiteNumber(right.volume?.h24) ?? 0) - (finiteNumber(left.volume?.h24) ?? 0);
    })
    .slice(0, MAX_PAIRS)
    .map(pairSummary);

  return {
    source: "DEX Screener",
    source_url: `https://dexscreener.com/${DEX_SCREENER_CHAIN}/${normalizedAddress}`,
    chain_id: DEX_SCREENER_CHAIN,
    query_address: normalizedAddress,
    as_of: asOf.toISOString(),
    pairs: summaries,
    note: summaries.length ? null : "DEX Screener returned no Robinhood Chain pairs for this address.",
  };
}

async function dexScreenerJson(path: string): Promise<unknown> {
  const response = await fetch(`${DEX_SCREENER_API}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "RobinArenaUserAgents/1.0",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`DEX Screener returned HTTP ${response.status}`);
  return response.json();
}

async function fetchDexScreener(address: string): Promise<DexScreenerReadResult> {
  const encoded = encodeURIComponent(address);
  const [tokenResult, pairResult] = await Promise.allSettled([
    dexScreenerJson(`/token-pairs/v1/${DEX_SCREENER_CHAIN}/${encoded}`),
    dexScreenerJson(`/latest/dex/pairs/${DEX_SCREENER_CHAIN}/${encoded}`),
  ]);
  if (tokenResult.status === "rejected" && pairResult.status === "rejected") {
    throw new Error("DEX Screener could not read this address");
  }

  const pairs: DexScreenerPair[] = [];
  if (tokenResult.status === "fulfilled" && Array.isArray(tokenResult.value)) {
    pairs.push(...tokenResult.value as DexScreenerPair[]);
  }
  if (pairResult.status === "fulfilled" && pairResult.value && typeof pairResult.value === "object") {
    const payload = pairResult.value as { pairs?: DexScreenerPair[] | null; pair?: DexScreenerPair | null };
    if (Array.isArray(payload.pairs)) pairs.push(...payload.pairs);
    else if (payload.pair) pairs.push(payload.pair);
  }
  return summarizeDexScreenerPairs(address, pairs);
}

export async function readDexScreener(addressValue: string): Promise<DexScreenerReadResult> {
  const address = addressValue.trim();
  if (!isAddress(address)) throw new Error("DEX Screener requires a valid Robinhood Chain token or pair address");
  const normalized = getAddress(address);
  const key = normalized.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const running = inFlight.get(key);
  if (running) return running;

  const request = fetchDexScreener(normalized)
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export async function searchDexScreener(queryValue: string): Promise<DexScreenerReadResult> {
  const query = queryValue.trim().slice(0, 100);
  if (query.length < 2) throw new Error("DEX Screener search requires at least two characters");
  const payload = await dexScreenerJson(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  const pairs = payload && typeof payload === "object" && Array.isArray((payload as { pairs?: unknown }).pairs)
    ? (payload as { pairs: DexScreenerPair[] }).pairs
    : [];
  const robinhoodPairs = pairs.filter((pair) => pair.chainId === DEX_SCREENER_CHAIN);
  const firstAddress = robinhoodPairs.find((pair) => isAddress(pair.baseToken?.address ?? ""))?.baseToken?.address;
  const queryAddress = firstAddress && isAddress(firstAddress)
    ? getAddress(firstAddress)
    : "0x0000000000000000000000000000000000000000";
  return summarizeDexScreenerPairs(queryAddress, robinhoodPairs);
}
