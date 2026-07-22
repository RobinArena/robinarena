import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { transactionQuantity } from "./swapQuantity";

const LIFI_QUOTE_URL = "https://li.quest/v1/quote";
const LIFI_INTEGRATOR = "robinarena";
const MAX_PRICE_IMPACT = 0.05;
const MAX_PROVIDER_FEE_BPS = 100;
const LIFI_PROVIDER_FALLBACK_SLIPPAGE_BPS = 1_000;
const BASIS_POINTS = 10_000n;
let preferredSlippageBps: number | undefined;

type JsonObject = Record<string, unknown>;

export interface LiFiQuoteRequest {
  chainId: 4663;
  wallet: Address;
  tokenIn: Address;
  tokenOut: Address;
  amount: bigint;
  slippageBps: number;
  nativeToken: Address;
}

export interface ValidatedLiFiQuote {
  provider: "lifi";
  id: string;
  tool: string;
  routing: string;
  approvalAddress: Address;
  quotedAmountOut: bigint;
  minimumAmountOut: bigint;
  slippageBps: number;
  quotedAtMs: number;
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
  };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`LI.FI quote omitted ${label}`);
  }
  return value as JsonObject;
}

function stringValue(object: JsonObject, key: string, label = key): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`LI.FI quote omitted ${label}`);
  }
  return value;
}

function addressValue(object: JsonObject, key: string, label = key): Address {
  const value = stringValue(object, key, label);
  if (!isAddress(value)) throw new Error(`LI.FI quote returned an invalid ${label}`);
  return getAddress(value);
}

function amountValue(object: JsonObject, key: string, label = key): bigint {
  const value = stringValue(object, key, label);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`LI.FI quote returned an invalid ${label}`);
  }
  return BigInt(value);
}

function chainValue(object: JsonObject, key: string, label = key): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) throw new Error(`LI.FI quote returned an invalid ${label}`);
  return value as number;
}

function sameAddress(actual: Address, expected: Address, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`LI.FI quote ${label} does not match the request`);
  }
}

function validateProviderFees(estimate: JsonObject, tokenIn: Address, amount: bigint): void {
  const feeCosts = estimate.feeCosts;
  if (!Array.isArray(feeCosts)) throw new Error("LI.FI quote omitted fee costs");

  let inputTokenFees = 0n;
  let percentageBps = 0;
  for (const entry of feeCosts) {
    const fee = objectValue(entry, "fee cost");
    const percentage = fee.percentage;
    if (typeof percentage === "string" || typeof percentage === "number") {
      const numeric = Number(percentage);
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error("LI.FI quote returned an invalid provider fee");
      }
      percentageBps += numeric * 10_000;
    }

    if (fee.token !== undefined && fee.amount !== undefined) {
      const feeToken = objectValue(fee.token, "fee token");
      const feeAddress = addressValue(feeToken, "address", "fee token address");
      if (feeAddress === tokenIn) inputTokenFees += amountValue(fee, "amount", "provider fee amount");
    }
  }

  const maximumFee = amount * BigInt(MAX_PROVIDER_FEE_BPS) / BASIS_POINTS;
  if (percentageBps > MAX_PROVIDER_FEE_BPS + Number.EPSILON || inputTokenFees > maximumFee) {
    throw new Error(`LI.FI provider fee exceeds ${MAX_PROVIDER_FEE_BPS} basis points`);
  }
}

export function validateLiFiQuote(payload: unknown, request: LiFiQuoteRequest): ValidatedLiFiQuote {
  if (request.amount <= 0n) throw new Error("LI.FI quote request amount must be positive");
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > 10_000) {
    throw new Error("LI.FI quote request slippage is invalid");
  }
  const quote = objectValue(payload, "response");
  const id = stringValue(quote, "id", "quote id");
  const type = stringValue(quote, "type", "route type");
  if (type !== "lifi" && type !== "swap") throw new Error(`unsupported LI.FI route type ${type}`);
  const tool = stringValue(quote, "tool");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(tool)) throw new Error("LI.FI quote returned an invalid tool name");

  const action = objectValue(quote.action, "action");
  if (chainValue(action, "fromChainId", "source chain") !== request.chainId
    || chainValue(action, "toChainId", "destination chain") !== request.chainId) {
    throw new Error("LI.FI quote returned a route outside Robinhood Chain mainnet");
  }
  const fromToken = objectValue(action.fromToken, "input token");
  const toToken = objectValue(action.toToken, "output token");
  if (chainValue(fromToken, "chainId", "input token chain") !== request.chainId
    || chainValue(toToken, "chainId", "output token chain") !== request.chainId) {
    throw new Error("LI.FI quote returned a token on another chain");
  }
  sameAddress(addressValue(fromToken, "address", "input token"), request.tokenIn, "input token");
  sameAddress(addressValue(toToken, "address", "output token"), request.tokenOut, "output token");
  sameAddress(addressValue(action, "fromAddress", "sender"), request.wallet, "sender");
  sameAddress(addressValue(action, "toAddress", "recipient"), request.wallet, "recipient");
  if (amountValue(action, "fromAmount", "input amount") !== request.amount) {
    throw new Error("LI.FI quote input amount does not match the request");
  }
  const quotedSlippage = action.slippage;
  if (typeof quotedSlippage !== "number" || !Number.isFinite(quotedSlippage)
    || quotedSlippage < 0 || quotedSlippage > request.slippageBps / 10_000 + Number.EPSILON) {
    throw new Error("LI.FI quote exceeds the configured slippage limit");
  }

  const estimate = objectValue(quote.estimate, "estimate");
  if (amountValue(estimate, "fromAmount", "estimated input amount") !== request.amount) {
    throw new Error("LI.FI estimate input amount does not match the request");
  }
  const quotedAmountOut = amountValue(estimate, "toAmount", "quoted output amount");
  const minimumAmountOut = amountValue(estimate, "toAmountMin", "minimum output amount");
  if (quotedAmountOut === 0n || minimumAmountOut === 0n || minimumAmountOut > quotedAmountOut) {
    throw new Error("LI.FI quote returned invalid output amount limits");
  }
  const configuredFloor = quotedAmountOut
    * (BASIS_POINTS - BigInt(request.slippageBps))
    / BASIS_POINTS;
  if (minimumAmountOut < configuredFloor) {
    throw new Error("LI.FI minimum output exceeds the configured slippage limit");
  }
  const approvalAddress = addressValue(estimate, "approvalAddress", "approval address");
  validateProviderFees(estimate, request.tokenIn, request.amount);

  const transactionRequest = objectValue(quote.transactionRequest, "transaction request");
  if (chainValue(transactionRequest, "chainId", "transaction chain") !== request.chainId) {
    throw new Error("LI.FI returned a transaction for another chain");
  }
  sameAddress(addressValue(transactionRequest, "from", "transaction sender"), request.wallet, "transaction sender");
  const to = addressValue(transactionRequest, "to", "transaction target");
  if (to !== approvalAddress) {
    throw new Error("LI.FI transaction target does not match its approval address");
  }
  const data = stringValue(transactionRequest, "data", "transaction calldata");
  if (!isHex(data) || data === "0x") throw new Error("LI.FI returned invalid transaction calldata");
  const value = transactionQuantity(stringValue(transactionRequest, "value", "transaction value"));
  const expectedValue = request.tokenIn === request.nativeToken ? request.amount : 0n;
  if (value !== expectedValue) throw new Error("LI.FI transaction value does not match the exact input amount");

  return {
    provider: "lifi",
    id,
    tool,
    routing: `LI.FI/${tool}`,
    approvalAddress,
    quotedAmountOut,
    minimumAmountOut,
    slippageBps: Math.ceil(quotedSlippage * 10_000),
    quotedAtMs: Date.now(),
    transaction: { to, data: data as Hex, value },
  };
}

function apiKey(): string | undefined {
  return process.env.LIFI_API_KEY?.trim() || undefined;
}

function errorDetail(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const object = payload as JsonObject;
    for (const key of ["message", "detail", "error"]) {
      if (typeof object[key] === "string" && object[key]) return object[key];
    }
  }
  return `HTTP ${status}`;
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) throw new Error("LI.FI quote returned invalid JSON");
    return null;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function quoteUrl(request: LiFiQuoteRequest, slippageBps: number): URL {
  const url = new URL(LIFI_QUOTE_URL);
  url.searchParams.set("fromChain", String(request.chainId));
  url.searchParams.set("toChain", String(request.chainId));
  url.searchParams.set("fromToken", request.tokenIn);
  url.searchParams.set("toToken", request.tokenOut);
  url.searchParams.set("fromAmount", request.amount.toString());
  url.searchParams.set("fromAddress", request.wallet);
  url.searchParams.set("toAddress", request.wallet);
  url.searchParams.set("slippage", String(slippageBps / 10_000));
  url.searchParams.set("integrator", LIFI_INTEGRATOR);
  url.searchParams.set("order", "CHEAPEST");
  url.searchParams.set("maxPriceImpact", String(MAX_PRICE_IMPACT));
  url.searchParams.set("allowBridges", "none");
  url.searchParams.set("skipSimulation", "false");
  return url;
}

function slippageCandidates(maximumSlippageBps: number): number[] {
  if (preferredSlippageBps && preferredSlippageBps <= maximumSlippageBps) {
    return [...new Set([preferredSlippageBps, maximumSlippageBps])];
  }
  return [...new Set([
    maximumSlippageBps,
    Math.min(maximumSlippageBps, LIFI_PROVIDER_FALLBACK_SLIPPAGE_BPS),
  ])];
}

interface QuoteFailure {
  error: Error;
  status: number;
}

async function requestAtSlippage(
  request: LiFiQuoteRequest,
  slippageBps: number,
  headers: Record<string, string>,
): Promise<ValidatedLiFiQuote | QuoteFailure> {
  const url = quoteUrl(request, slippageBps);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(250 * 2 ** attempt);
      continue;
    }

    let payload: unknown;
    try {
      payload = await responsePayload(response);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(250 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      return validateLiFiQuote(payload, { ...request, slippageBps });
    }

    const failure = new Error(`LI.FI quote failed: ${errorDetail(payload, response.status)}`);
    lastError = failure;
    if (response.status !== 429 && response.status < 500) {
      return { error: failure, status: response.status };
    }
    if (attempt < 2) await wait(250 * 2 ** attempt);
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(message.startsWith("LI.FI") ? message : `LI.FI quote failed: ${message}`);
}

export async function requestLiFiQuote(request: LiFiQuoteRequest): Promise<ValidatedLiFiQuote> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = apiKey();
  if (key) headers["x-lifi-api-key"] = key;

  const candidates = slippageCandidates(request.slippageBps);
  let lastFailure: QuoteFailure | undefined;
  for (const [index, slippageBps] of candidates.entries()) {
    const result = await requestAtSlippage(request, slippageBps, headers);
    if (!("error" in result)) {
      preferredSlippageBps = slippageBps;
      return result;
    }
    lastFailure = result;
    const canTryProviderFallback = index < candidates.length - 1
      && [400, 404, 422].includes(result.status);
    if (!canTryProviderFallback) throw result.error;
  }
  throw lastFailure?.error ?? new Error("LI.FI quote failed without a response");
}
