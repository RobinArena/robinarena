import { api } from "encore.dev/api";
import { arenaOperatorKey, openRouterApiKey, readOptionalSecret } from "./secrets";
import type { ArenaAction, OpenRouterIntegration } from "./types";

export const OPENROUTER_MODELS = [
  { agent_id: "gpt-5-6-sol", name: "GPT-5.6 Sol", model: "openai/gpt-5.6-sol", structured_outputs: true },
  { agent_id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", model: "deepseek/deepseek-v4-pro", structured_outputs: true },
  { agent_id: "claude-fable-5", name: "Claude Fable 5", model: "anthropic/claude-fable-5", structured_outputs: true },
  { agent_id: "grok-4-5", name: "Grok 4.5", model: "x-ai/grok-4.5", structured_outputs: true },
] as const;

export interface OpenRouterMarketInput {
  symbol: string;
  price: number;
  previous_close: number;
  change_pct: number;
  bid?: number;
  ask?: number;
  as_of: string;
  source: "robinhood_mcp";
}

export interface OpenRouterPositionInput {
  symbol: string;
  quantity: number;
  average_entry_price: number;
  current_price: number;
  unrealized_pnl: number;
  stop_loss: number;
  take_profit: number;
}

export interface OpenRouterDecisionInput {
  round_number: number;
  cycle_number: number;
  model: string;
  agent: {
    name: string;
    strategy: string;
    thesis: string;
  };
  portfolio: {
    initial_balance: number;
    cash_balance: number;
    equity: number;
    realized_pnl: number;
    unrealized_pnl: number;
    positions: OpenRouterPositionInput[];
  };
  risk: {
    long_only: true;
    risk_per_trade_pct: number;
    max_position_pct: number;
    min_confidence: number;
    max_daily_loss: number;
    hard_stop_pct: number;
    take_profit_pct: number;
  };
  market: OpenRouterMarketInput[];
}

export interface OpenRouterModelDecision {
  action: Exclude<ArenaAction, "skip">;
  symbol: string;
  confidence: number;
  allocation_pct: number;
  rationale: string;
}

export interface OpenRouterDecisionResult {
  decision: OpenRouterModelDecision;
  request_id?: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  generation_cost?: number;
  latency_ms: number;
}

interface CompletionPayload {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

interface CompletionChoice {
  message?: {
    content?: unknown;
  };
}

export class OpenRouterRequestError extends Error {
  constructor(message: string, public readonly latencyMs: number) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function openRouterKey(): string | undefined {
  return readOptionalSecret(openRouterApiKey) || process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

function endpoint(): string {
  const base = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function completionText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((item) => {
    const part = record(item);
    return part?.type === "text" && typeof part.text === "string" ? part.text : "";
  }).join("");
  return text || undefined;
}

function parseDecision(
  content: string,
  symbols: Set<string>,
  openingPositionRequired: boolean,
): OpenRouterModelDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenRouter returned malformed decision JSON");
  }
  const value = record(parsed);
  if (!value) throw new Error("OpenRouter returned an empty decision");

  const action = value.action;
  if (action !== "buy" && action !== "sell" && action !== "hold") {
    throw new Error("OpenRouter returned an invalid trade action");
  }
  const symbol = typeof value.symbol === "string" ? value.symbol.trim().toUpperCase() : "";
  if (!symbols.has(symbol)) throw new Error("OpenRouter selected a symbol outside the shared market");
  const confidence = optionalNumber(value.confidence);
  if (confidence === undefined || confidence < 0 || confidence > 1) {
    throw new Error("OpenRouter returned invalid confidence");
  }
  const allocation = optionalNumber(value.allocation_pct);
  if (allocation === undefined || allocation < 0 || allocation > 40) {
    throw new Error("OpenRouter returned invalid allocation");
  }
  if (openingPositionRequired && (action !== "buy" || allocation < 20)) {
    throw new Error("OpenRouter did not satisfy the required opening allocation");
  }
  const rationale = typeof value.rationale === "string" ? value.rationale.trim() : "";
  if (!rationale || rationale.length > 320) throw new Error("OpenRouter returned invalid rationale");

  return {
    action,
    symbol,
    confidence,
    allocation_pct: action === "buy" ? allocation : 0,
    rationale,
  };
}

function errorMessage(payload: CompletionPayload): string | undefined {
  const error = record(payload.error);
  if (!error) return undefined;
  const message = typeof error.message === "string" ? error.message : "OpenRouter request failed";
  return message.slice(0, 300);
}

export function openRouterConfigured(): boolean {
  return Boolean(openRouterKey());
}

export function openRouterIntegration(): OpenRouterIntegration {
  const configured = openRouterConfigured();
  const configuredOperator = Boolean(
    readOptionalSecret(arenaOperatorKey) || process.env.ARENA_OPERATOR_KEY?.trim(),
  );
  return {
    configured,
    state: configured ? "ready" : "missing_key",
    operator_configured: configuredOperator,
    development_operator_key: !configuredOperator && process.env.NODE_ENV !== "production",
    gateway: "OpenRouter",
    models: OPENROUTER_MODELS.map((model) => ({ ...model })),
  };
}

export async function requestOpenRouterDecision(input: OpenRouterDecisionInput): Promise<OpenRouterDecisionResult> {
  const key = openRouterKey();
  if (!key) throw new OpenRouterRequestError("OpenRouterAPIKey is not configured", 0);
  const symbols = input.market.map((quote) => quote.symbol);
  const startedAt = Date.now();
  const appUrl = process.env.OPENROUTER_APP_URL?.trim();
  const openingPositionRequired = input.portfolio.positions.length === 0
    && input.portfolio.cash_balance >= 1;

  const system = [
    "You are a competitor in Model Market, a week-long, long-only live trading arena using real money in a dedicated Robinhood Agentic account.",
    "Choose one action from buy, sell, or hold using only the supplied snapshot.",
    openingPositionRequired
      ? "Opening participation is required because this portfolio has no position: buy the strongest relative symbol and allocate 20 to 40 percent."
      : "With an open position, buy, sell, or hold according to your strategy and the supplied portfolio state.",
    "A buy must select a shared-market symbol without an existing position.",
    "A sell must select a symbol currently held by this portfolio.",
    "Set allocation_pct from 0 to 40 for buys and 0 for sells or holds.",
    "Do not invent news, prices, indicators, or history. The risk engine may reduce or reject the request before a real order is submitted.",
    "Keep the rationale specific and under 280 characters.",
  ].join(" ");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: openingPositionRequired ? ["buy"] : ["buy", "sell", "hold"],
      },
      symbol: { type: "string", enum: symbols },
      confidence: {
        type: "number",
        description: "A value from 0 through 1.",
      },
      allocation_pct: {
        type: "number",
        description: openingPositionRequired
          ? "A required opening allocation from 20 through 40 percent."
          : "A value from 0 through 40 for buys, or 0 for sells and holds.",
      },
      rationale: {
        type: "string",
        description: "A concise, specific explanation under 280 characters.",
      },
    },
    required: ["action", "symbol", "confidence", "allocation_pct", "rationale"],
  };

  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Model Market",
        ...(appUrl ? { "HTTP-Referer": appUrl } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "trade_decision",
            strict: true,
            schema,
          },
        },
        max_tokens: 1200,
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const latencyMs = Date.now() - startedAt;
    let payload: CompletionPayload;
    try {
      payload = await response.json() as CompletionPayload;
    } catch {
      throw new OpenRouterRequestError(`OpenRouter returned HTTP ${response.status} without JSON`, latencyMs);
    }
    if (!response.ok || payload.error) {
      throw new OpenRouterRequestError(
        errorMessage(payload) || `OpenRouter returned HTTP ${response.status}`,
        latencyMs,
      );
    }

    const choices = Array.isArray(payload.choices) ? payload.choices as CompletionChoice[] : [];
    const content = completionText(choices[0]?.message?.content);
    if (!content) throw new OpenRouterRequestError("OpenRouter returned no decision content", latencyMs);
    let decision: OpenRouterModelDecision;
    try {
      decision = parseDecision(content, new Set(symbols), openingPositionRequired);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "OpenRouter decision validation failed";
      throw new OpenRouterRequestError(message, latencyMs);
    }

    const usage = record(payload.usage);
    return {
      decision,
      request_id: typeof payload.id === "string" ? payload.id : undefined,
      model: typeof payload.model === "string" ? payload.model : input.model,
      prompt_tokens: optionalNumber(usage?.prompt_tokens),
      completion_tokens: optionalNumber(usage?.completion_tokens),
      generation_cost: optionalNumber(usage?.cost),
      latency_ms: latencyMs,
    };
  } catch (cause) {
    if (cause instanceof OpenRouterRequestError) throw cause;
    const message = cause instanceof Error && cause.name === "TimeoutError"
      ? "OpenRouter request timed out"
      : cause instanceof Error ? cause.message : "OpenRouter request failed";
    throw new OpenRouterRequestError(message.slice(0, 300), Date.now() - startedAt);
  }
}

export const getOpenRouterIntegration = api(
  { expose: true, method: "GET", path: "/integrations/openrouter" },
  async (): Promise<OpenRouterIntegration> => openRouterIntegration(),
);
