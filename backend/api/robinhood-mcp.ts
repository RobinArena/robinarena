import { asArray, asRecord, collectRecords, numberField, payloadRecord, stringField } from "./json-utils";
import {
  robinhoodOrderArguments,
  type RobinhoodOrderRequest,
} from "./robinhood-order";
import { robinhoodAccessToken } from "./robinhood-oauth";
import { readOptionalSecret, robinhoodMcpAccessToken } from "./secrets";
import type { RobinhoodIntegration } from "./types";

const DEFAULT_MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const MCP_PROTOCOL = "2025-03-26";

interface McpEnvelope {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpSession {
  sessionId?: string;
  nextId: number;
}

interface ContextualRecord {
  record: Record<string, unknown>;
  accountId?: string;
  accountType?: string;
  agentic?: boolean;
}

interface AgenticAccount {
  accountNumber: string;
  ids: Set<string>;
}

export interface RobinhoodQuote {
  symbol: string;
  price: number;
  previous_close: number;
  bid?: number;
  ask?: number;
  as_of: string;
}

export interface RobinhoodAccountSnapshot {
  buying_power: number;
  equity: number;
  as_of: string;
}

export interface RobinhoodPositionSnapshot {
  symbol: string;
  quantity: number;
  average_price?: number;
  current_price?: number;
}

export interface RobinhoodOrderSnapshot {
  broker_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  requested_quantity?: number;
  requested_amount?: number;
  filled_quantity: number;
  average_fill_price?: number;
  as_of?: string;
}

export interface RobinhoodOrderResult {
  broker_order_id?: string;
  status: string;
  review: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function endpoint(): string {
  return process.env.ROBINHOOD_MCP_URL?.trim() || DEFAULT_MCP_ENDPOINT;
}

export function robinhoodMcpConfigured(): boolean {
  return Boolean(
    readOptionalSecret(robinhoodMcpAccessToken)
    || process.env.ROBINHOOD_MCP_ACCESS_TOKEN?.trim(),
  );
}

export function robinhoodIntegration(lastError?: string, oauthConnected = false): RobinhoodIntegration {
  const configured = oauthConnected || robinhoodMcpConfigured();
  return {
    configured,
    state: !configured ? "missing_token" : lastError ? "error" : "ready",
    gateway: "Robinhood Trading MCP",
    scope: "Long equities in the dedicated Robinhood Agentic account",
    documentation_url: "https://robinhood.com/us/en/support/articles/agentic-trading-overview/",
    authentication: oauthConnected ? "oauth" : configured ? "static_token" : "missing",
    oauth_connected: oauthConnected,
    last_error: lastError,
  };
}

function contextualRecords(
  value: unknown,
  context: Omit<ContextualRecord, "record"> = {},
  output: ContextualRecord[] = [],
): ContextualRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) contextualRecords(item, context, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  const accountId = stringField(record, ["account_number", "account_id"]) || context.accountId;
  const accountType = stringField(record, ["account_type", "account_name"]) || context.accountType;
  const agentic = typeof record.agentic_allowed === "boolean" ? record.agentic_allowed : context.agentic;
  const next = { accountId, accountType, agentic };
  output.push({ record, ...next });
  for (const nested of Object.values(record)) contextualRecords(nested, next, output);
  return output;
}

function parseEventStream(text: string): McpEnvelope {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) throw new Error("Robinhood MCP returned an empty event stream");
  return JSON.parse(dataLines.at(-1) || "{}") as McpEnvelope;
}

async function parseResponse(response: Response): Promise<McpEnvelope> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Robinhood MCP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return {};
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? parseEventStream(text)
    : JSON.parse(text) as McpEnvelope;
}

function toolPayload(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record.isError === true) {
    const content = asArray(record.content)
      .map((item) => stringField(asRecord(item), ["text"]))
      .filter(Boolean)
      .join(" ");
    throw new Error(content || "Robinhood MCP tool call failed");
  }
  if (record.structuredContent !== undefined) return payloadRecord(record.structuredContent);

  const parsed: unknown[] = [];
  for (const item of asArray(record.content)) {
    const text = stringField(asRecord(item), ["text"]);
    if (!text) continue;
    try {
      parsed.push(JSON.parse(text));
    } catch {
      parsed.push(text);
    }
  }
  if (parsed.length === 1) return payloadRecord(parsed[0]);
  return { content: parsed };
}

export class RobinhoodMcpClient {
  private agenticAccountPromise?: Promise<AgenticAccount>;

  private headers(accessToken: string, sessionId?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
  }

  private async post(
    envelope: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ body: McpEnvelope; sessionId?: string }> {
    const accessToken = await robinhoodAccessToken();
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: this.headers(accessToken, sessionId),
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await parseResponse(response);
    if (body.error) throw new Error(body.error.message || "Robinhood MCP request failed");
    return { body, sessionId: response.headers.get("mcp-session-id") || sessionId };
  }

  private async initialize(): Promise<McpSession> {
    const initialized = await this.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "robinarena", version: "0.5.0" },
      },
    });
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      initialized.sessionId,
    );
    return { sessionId: initialized.sessionId, nextId: 2 };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.initialize();
    const response = await this.post({
      jsonrpc: "2.0",
      id: session.nextId,
      method: "tools/call",
      params: { name, arguments: args },
    }, session.sessionId);
    return toolPayload(response.body.result);
  }

  async listTools(): Promise<Record<string, unknown>> {
    const session = await this.initialize();
    const response = await this.post({
      jsonrpc: "2.0",
      id: session.nextId,
      method: "tools/list",
      params: {},
    }, session.sessionId);
    return payloadRecord(response.body.result);
  }

  private agenticAccount(): Promise<AgenticAccount> {
    if (!this.agenticAccountPromise) {
      this.agenticAccountPromise = this.callTool("get_accounts", {}).then((payload) => {
        const ids = new Set<string>();
        for (const record of collectRecords(payload)) {
          const type = stringField(record, ["account_type", "account_name", "type", "name"]);
          if (record.agentic_allowed !== true && !/agentic/i.test(type || "")) continue;
          const id = stringField(record, ["account_number", "account_id", "id"]);
          if (id) ids.add(id);
        }
        if (ids.size === 0) {
          throw new Error("Robinhood MCP did not identify a dedicated Agentic account");
        }
        if (ids.size > 1) {
          throw new Error("Robinhood MCP returned multiple dedicated Agentic accounts");
        }
        return { accountNumber: [...ids][0], ids };
      });
    }
    return this.agenticAccountPromise;
  }

  private accountAllowed(item: ContextualRecord, agenticIds: Set<string>): boolean {
    if (agenticIds.size > 0) return Boolean(item.accountId && agenticIds.has(item.accountId));
    if (item.agentic === false) return false;
    if (item.accountType && /individual|retirement|ira|joint/i.test(item.accountType) && !/agent/i.test(item.accountType)) {
      return false;
    }
    return true;
  }

  async getQuotes(symbols: string[]): Promise<RobinhoodQuote[]> {
    const requested = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    const payload = await this.callTool("get_equity_quotes", { symbols: requested });
    const now = new Date().toISOString();
    const quotes = new Map<string, RobinhoodQuote>();
    for (const record of collectRecords(payload)) {
      const symbol = stringField(record, ["symbol", "ticker", "instrument_symbol"])?.toUpperCase();
      if (!symbol || !requested.includes(symbol)) continue;
      const bid = numberField(record, ["bid_price", "bid", "best_bid"]);
      const ask = numberField(record, ["ask_price", "ask", "best_ask"]);
      const regularLast = numberField(record, ["last_trade_price", "last_price", "price", "mark_price"]);
      const nonRegularLast = numberField(record, ["last_non_reg_trade_price"]);
      const regularAsOf = stringField(record, ["venue_last_trade_time", "updated_at", "as_of", "timestamp"]);
      const nonRegularAsOf = stringField(record, ["venue_last_non_reg_trade_time"]);
      const regularTime = regularAsOf ? new Date(regularAsOf).getTime() : 0;
      const nonRegularTime = nonRegularAsOf ? new Date(nonRegularAsOf).getTime() : 0;
      const latestLast = nonRegularLast && nonRegularTime >= regularTime
        ? nonRegularLast
        : regularLast;
      const price = latestLast || (bid && ask ? (bid + ask) / 2 : bid || ask);
      if (!price || price <= 0) continue;
      const previous = numberField(record, [
        "adjusted_previous_close",
        "previous_close",
        "previous_close_price",
        "prior_close",
      ]);
      if (!quotes.has(symbol)) {
        quotes.set(symbol, {
          symbol,
          price,
          previous_close: previous && previous > 0 ? previous : price,
          bid,
          ask,
          as_of: nonRegularLast && nonRegularTime >= regularTime
            ? nonRegularAsOf || now
            : regularAsOf || now,
        });
      }
    }
    if (quotes.size !== requested.length) {
      const missing = requested.filter((symbol) => !quotes.has(symbol));
      throw new Error(`Robinhood returned no usable quote for: ${missing.join(", ")}`);
    }
    return [...quotes.values()];
  }

  async getAccountSnapshot(): Promise<RobinhoodAccountSnapshot> {
    const agenticAccount = await this.agenticAccount();
    const payload = await this.callTool("get_portfolio", {
      account_number: agenticAccount.accountNumber,
    });
    const items = contextualRecords(payload, {
      accountId: agenticAccount.accountNumber,
      accountType: "Agentic",
      agentic: true,
    })
      .filter((item) => this.accountAllowed(item, agenticAccount.ids));
    const accountIds = new Set(items.map((item) => item.accountId || "agentic").filter(Boolean));
    for (const accountId of accountIds) {
      const records = items
        .filter((item) => (item.accountId || "agentic") === accountId)
        .map((item) => item.record);
      const equity = records.map((record) => numberField(record, [
        "total_value", "portfolio_value", "total_portfolio_value", "total_account_value",
        "total_equity", "equity", "account_value",
      ])).find((value) => value !== undefined);
      const buyingPower = records.map((record) => numberField(record, [
        "buying_power", "cash_available", "available_cash", "cash",
      ])).find((value) => value !== undefined);
      if (equity === undefined || buyingPower === undefined || equity < 0 || buyingPower < 0) continue;
      const timestamp = records
        .map((record) => stringField(record, ["updated_at", "as_of", "timestamp"]))
        .find(Boolean);
      return { equity, buying_power: buyingPower, as_of: timestamp || new Date().toISOString() };
    }
    throw new Error("Robinhood MCP portfolio response did not contain Agentic account value and buying power");
  }

  async getPositions(): Promise<RobinhoodPositionSnapshot[]> {
    const agenticAccount = await this.agenticAccount();
    const payload = await this.callTool("get_equity_positions", {
      account_number: agenticAccount.accountNumber,
    });
    const positions = new Map<string, RobinhoodPositionSnapshot>();
    for (const item of contextualRecords(payload, {
      accountId: agenticAccount.accountNumber,
      accountType: "Agentic",
      agentic: true,
    })) {
      if (!this.accountAllowed(item, agenticAccount.ids)) continue;
      const symbol = stringField(item.record, ["symbol", "ticker", "instrument_symbol"])?.toUpperCase();
      const quantity = numberField(item.record, ["quantity", "shares", "total_quantity"]);
      if (!symbol || !quantity || quantity <= 0) continue;
      const average = numberField(item.record, ["average_price", "average_buy_price", "cost_basis_price"]);
      const current = numberField(item.record, ["current_price", "last_price", "price"]);
      positions.set(symbol, {
        symbol,
        quantity,
        average_price: average && average > 0 ? average : undefined,
        current_price: current && current > 0 ? current : undefined,
      });
    }
    return [...positions.values()];
  }

  async getOrders(): Promise<RobinhoodOrderSnapshot[]> {
    const agenticAccount = await this.agenticAccount();
    const payload = await this.callTool("get_equity_orders", {
      account_number: agenticAccount.accountNumber,
    });
    const orders = new Map<string, RobinhoodOrderSnapshot>();
    for (const item of contextualRecords(payload, {
      accountId: agenticAccount.accountNumber,
      accountType: "Agentic",
      agentic: true,
    })) {
      if (!this.accountAllowed(item, agenticAccount.ids)) continue;
      const record = item.record;
      const id = stringField(record, ["order_id", "id"]);
      const symbol = stringField(record, ["symbol", "ticker", "instrument_symbol"])?.toUpperCase();
      const rawSide = stringField(record, ["side", "direction"])?.toLowerCase();
      const status = stringField(record, ["status", "state"])?.toLowerCase();
      if (!id || !symbol || (rawSide !== "buy" && rawSide !== "sell") || !status) continue;
      const filled = numberField(record, ["filled_quantity", "cumulative_quantity", "executed_quantity"]) || 0;
      orders.set(id, {
        broker_order_id: id,
        symbol,
        side: rawSide,
        status,
        requested_quantity: numberField(record, ["quantity", "requested_quantity", "shares"]),
        requested_amount: numberField(record, ["amount", "dollar_amount", "notional"]),
        filled_quantity: filled,
        average_fill_price: numberField(record, ["average_price", "average_fill_price", "executed_price", "price"]),
        as_of: stringField(record, ["updated_at", "last_transaction_at", "timestamp"]),
      });
    }
    return [...orders.values()];
  }

  async placeOrder(order: RobinhoodOrderRequest): Promise<RobinhoodOrderResult> {
    const agenticAccount = await this.agenticAccount();
    const args = robinhoodOrderArguments(agenticAccount.accountNumber, order);
    const review = await this.callTool("review_equity_order", args);
    const payload = await this.callTool("place_equity_order", args);
    const brokerOrderId = collectRecords(payload)
      .map((record) => stringField(record, ["order_id", "id"]))
      .find(Boolean);
    const status = collectRecords(payload)
      .map((record) => stringField(record, ["status", "state"]))
      .find(Boolean) || "submitted";
    return { broker_order_id: brokerOrderId, status: status.toLowerCase(), review, payload };
  }

  async cancelOpenOrders(): Promise<number> {
    const [orders, agenticAccount] = await Promise.all([
      this.getOrders(),
      this.agenticAccount(),
    ]);
    const openStates = new Set(["open", "queued", "pending", "confirmed", "partially_filled", "working", "submitted"]);
    const ids = orders
      .filter((order) => openStates.has(order.status))
      .map((order) => order.broker_order_id);
    for (const id of [...new Set(ids)]) {
      await this.callTool("cancel_equity_order", {
        account_number: agenticAccount.accountNumber,
        order_id: id,
      });
    }
    return new Set(ids).size;
  }
}

export { DEFAULT_MCP_ENDPOINT as MCP_ENDPOINT };
