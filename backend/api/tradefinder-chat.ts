import { APIError, api } from "encore.dev/api";
import { getAuthData } from "encore.dev/internal/codegen/auth";
import {
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  type Address,
} from "viem";
import type { AuthData } from "./gateway";
import { robinhoodClient } from "./portfolio";
import { hasTradeFinderAccess } from "./tradefinder-access";
import {
  readOptionalSecret,
  tinkerApiKey,
  tradeFinderAccessTokenAddress,
} from "./secrets";

const REQUIRED_TOKEN_BALANCE = "100";
const TINKER_BASE_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1";
const TRADEFINDER_CHECKPOINT = [
  "tinker://7613dcda-5329-5a58-a3fb-22709db35383:train:0",
  "sampler_weights/sampler-step-671",
].join("/");
const MAX_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_CONVERSATION_LENGTH = 24_000;

const SYSTEM_PROMPT = [
  "You are TradeFinder 1, an AI model by RobinArena.",
  "Help the user analyze trading decisions with clear evidence, explicit uncertainty, and disciplined risk management.",
  "Distinguish observed facts from inference. Never promise returns or present a trade as guaranteed.",
  "When context is missing, ask for the asset, time horizon, position size, and invalidation condition.",
].join(" ");

export interface TradeFinderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TradeFinderAccessResponse {
  configured: boolean;
  eligible: boolean;
  chain_id: 4663;
  wallet_address: string;
  token_address?: string;
  token_symbol: string;
  token_decimals: number;
  balance: string;
  formatted_balance: string;
  required_balance: string;
  checked_at: Date;
}

export interface TradeFinderChatRequest {
  messages: TradeFinderMessage[];
}

export interface TradeFinderChatResponse {
  message: TradeFinderMessage;
  model: "TradeFinder 1";
}

interface TinkerChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: unknown;
  };
}

function userWallet(): Address {
  const auth = getAuthData() as AuthData | null;
  if (auth?.role !== "user" || !isAddress(auth.userID)) {
    throw APIError.unauthenticated("connect and sign in with a wallet to continue");
  }
  return getAddress(auth.userID);
}

function configuredTokenAddress(): Address | null {
  const configured = readOptionalSecret(tradeFinderAccessTokenAddress)
    || process.env.TRADEFINDER_ACCESS_TOKEN_ADDRESS?.trim();
  if (!configured) return null;
  if (!isAddress(configured)) {
    throw APIError.failedPrecondition("TradeFinderAccessTokenAddress is not a valid contract address");
  }
  return getAddress(configured);
}

function cleanSymbol(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) || "TOKEN";
}

async function accessForWallet(wallet: Address): Promise<TradeFinderAccessResponse> {
  const token = configuredTokenAddress();
  const checkedAt = new Date();
  if (!token) {
    return {
      configured: false,
      eligible: false,
      chain_id: 4663,
      wallet_address: wallet,
      token_symbol: "TOKEN",
      token_decimals: 18,
      balance: "0",
      formatted_balance: "0",
      required_balance: REQUIRED_TOKEN_BALANCE,
      checked_at: checkedAt,
    };
  }

  const client = robinhoodClient(4663);
  try {
    const [chainID, code, balance, decimals, symbol] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: token }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ]);
    if (chainID !== 4663) throw new Error(`unexpected chain ${chainID}`);
    if (!code || code === "0x") throw new Error("configured token has no contract code");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error("configured token returned invalid decimals");
    }
    return {
      configured: true,
      eligible: hasTradeFinderAccess(balance, decimals),
      chain_id: 4663,
      wallet_address: wallet,
      token_address: token,
      token_symbol: cleanSymbol(symbol),
      token_decimals: decimals,
      balance: balance.toString(),
      formatted_balance: formatUnits(balance, decimals),
      required_balance: REQUIRED_TOKEN_BALANCE,
      checked_at: checkedAt,
    };
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
    throw APIError.internal(`the Robinhood Chain token balance could not be verified${detail}`);
  }
}

function validatedMessages(messages: TradeFinderMessage[]): TradeFinderMessage[] {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw APIError.invalidArgument(`send between 1 and ${MAX_MESSAGES} messages`);
  }
  let totalLength = 0;
  const cleaned = messages.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw APIError.invalidArgument("chat messages must use the user or assistant role");
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      throw APIError.invalidArgument(
        `each chat message must contain 1 to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters`,
      );
    }
    totalLength += content.length;
    return { role: message.role, content };
  });
  if (totalLength > MAX_CONVERSATION_LENGTH) {
    throw APIError.invalidArgument("the conversation is too long; start a new chat");
  }
  if (cleaned.at(-1)?.role !== "user") {
    throw APIError.invalidArgument("the final chat message must come from the user");
  }
  return cleaned;
}

function tinkerKey(): string {
  const key = readOptionalSecret(tinkerApiKey) || process.env.TINKER_API_KEY?.trim();
  if (!key) throw APIError.failedPrecondition("TradeFinder chat is not configured");
  return key;
}

async function requestTradeFinder(messages: TradeFinderMessage[]): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${TINKER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tinkerKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TRADEFINDER_CHECKPOINT,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 1_024,
        temperature: 0.55,
        top_p: 0.9,
        separate_reasoning: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw APIError.internal("TradeFinder took too long to answer; try again");
    }
    throw APIError.internal("TradeFinder could not be reached; try again");
  }

  const payload = await response.json().catch(() => ({})) as TinkerChatResponse;
  if (!response.ok) {
    const detail = typeof payload.error?.message === "string"
      ? payload.error.message.slice(0, 240)
      : `Tinker returned HTTP ${response.status}`;
    throw APIError.internal(`TradeFinder could not answer: ${detail}`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw APIError.internal("TradeFinder returned an empty response");
  }
  return content.trim();
}

export const getTradeFinderAccess = api(
  { expose: true, auth: true, method: "GET", path: "/tradefinder/access" },
  async (): Promise<TradeFinderAccessResponse> => accessForWallet(userWallet()),
);

export const chatWithTradeFinder = api(
  { expose: true, auth: true, method: "POST", path: "/tradefinder/chat", sensitive: true },
  async (request: TradeFinderChatRequest): Promise<TradeFinderChatResponse> => {
    const wallet = userWallet();
    const access = await accessForWallet(wallet);
    if (!access.configured) {
      throw APIError.failedPrecondition("TradeFinder token access is not configured");
    }
    if (!access.eligible) {
      throw APIError.permissionDenied(
        `hold at least ${access.required_balance} ${access.token_symbol} on Robinhood Chain to chat`,
      );
    }
    const content = await requestTradeFinder(validatedMessages(request.messages));
    return {
      message: { role: "assistant", content },
      model: "TradeFinder 1",
    };
  },
);
