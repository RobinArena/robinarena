import { api, APIError } from "encore.dev/api";
import { db } from "./db";
import {
  openRouterConfigured,
  openRouterIntegration,
  OpenRouterRequestError,
  requestOpenRouterDecision,
  type OpenRouterDecisionInput,
  type OpenRouterDecisionResult,
  type OpenRouterModelDecision,
} from "./openrouter";
import type {
  ArenaAction,
  ArenaDecisionSource,
  ArenaDecision,
  ArenaModel,
  ArenaPosition,
  ArenaResponse,
  ArenaStatus,
  ArenaTrade,
  EquitySeries,
  MarketQuote,
  ModelRoundResult,
  RunRoundResponse,
} from "./types";

interface AgentRow {
  id: string;
  name: string;
  provider: string;
  code: string;
  strategy: string;
  thesis: string;
  accent: string;
  status: "active" | "paused";
  openrouter_model: string;
  initial_balance: string | number;
  cash_balance: string | number;
  equity: string | number;
  realized_pnl: string | number;
  unrealized_pnl: string | number;
  win_rate: string | number;
  max_drawdown_pct: string | number;
  total_trades: number;
  risk_per_trade_pct: string | number;
  max_position_pct: string | number;
  min_confidence: string | number;
  max_daily_loss: string | number;
  last_decision_at: Date | string | null;
  open_positions: string | number;
}

interface StateRow {
  title: string;
  season: string;
  round_number: number;
  status: ArenaStatus;
  mode: "openrouter";
  last_round_at: Date | string;
  next_round_at: Date | string;
}

interface MarketRow {
  symbol: string;
  name: string;
  price: string | number;
  previous_close: string | number;
  change_pct: string | number;
  updated_at: Date | string;
}

interface EquityRow {
  agent_id: string;
  agent_name: string;
  accent: string;
  initial_balance: string | number;
  equity: string | number;
  captured_at: Date | string;
}

interface PositionRow {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  quantity: string | number;
  average_entry_price: string | number;
  current_price: string | number;
  market_value: string | number;
  unrealized_pnl: string | number;
  stop_loss: string | number;
  take_profit: string | number;
  opened_at: Date | string;
}

interface DecisionRow {
  id: string;
  round_number: number;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  action: ArenaAction;
  requested_action: ArenaAction | null;
  confidence: string | number;
  rationale: string;
  requested_allocation_pct: string | number | null;
  proposed_notional: string | number;
  executed_notional: string | number;
  approved: boolean;
  risk_note: string;
  source: ArenaDecisionSource;
  provider_model: string | null;
  provider_request_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  generation_cost: string | number | null;
  created_at: Date | string;
}

interface TradeRow {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  quantity: string | number;
  entry_price: string | number;
  exit_price: string | number | null;
  realized_pnl: string | number | null;
  return_pct: string | number | null;
  status: "open" | "closed";
  opened_at: Date | string;
  closed_at: Date | string | null;
  exit_reason: string | null;
}

interface ExecutionPositionRow {
  id: string;
  agent_id: string;
  symbol: string;
  quantity: string | number;
  average_entry_price: string | number;
  current_price: string | number;
  stop_loss: string | number;
  take_profit: string | number;
}

const marketMoves: Record<string, number[]> = {
  NVDA: [0.42, -0.18, 0.73, -0.31],
  TSLA: [-0.62, 0.94, -0.28, 0.44],
  MSFT: [0.19, 0.11, -0.16, 0.36],
  AMZN: [0.28, -0.14, 0.46, 0.07],
  META: [0.33, 0.22, -0.12, 0.41],
  SPY: [0.14, 0.08, -0.09, 0.20],
};

interface DecisionAudit {
  source: ArenaDecisionSource;
  requestedAction: ArenaAction;
  requestedAllocationPct: number;
  providerModel?: string;
  providerRequestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  generationCost?: number;
}

interface ProviderSuccess {
  ok: true;
  agent: AgentRow;
  result: OpenRouterDecisionResult;
}

interface ProviderFailure {
  ok: false;
  agent: AgentRow;
  error: OpenRouterRequestError;
}

type ProviderOutcome = ProviderSuccess | ProviderFailure;

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function round(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

async function listModels(): Promise<ArenaModel[]> {
  const rows = await db.queryAll<AgentRow>`
    SELECT a.*,
      (SELECT count(*) FROM arena_positions p
        WHERE p.agent_id = a.id AND p.status = 'open') AS open_positions
    FROM arena_agents a
    ORDER BY a.equity / NULLIF(a.initial_balance, 0) DESC, a.id
  `;

  return rows.map((row, index) => {
    const initial = numeric(row.initial_balance);
    const equity = numeric(row.equity);
    return {
      id: row.id,
      rank: index + 1,
      name: row.name,
      provider: row.provider,
      code: row.code,
      strategy: row.strategy,
      thesis: row.thesis,
      accent: row.accent,
      status: row.status,
      openrouter_model: row.openrouter_model,
      initial_balance: initial,
      cash_balance: numeric(row.cash_balance),
      equity,
      realized_pnl: numeric(row.realized_pnl),
      unrealized_pnl: numeric(row.unrealized_pnl),
      total_pnl: equity - initial,
      return_pct: initial === 0 ? 0 : ((equity - initial) / initial) * 100,
      win_rate: numeric(row.win_rate),
      max_drawdown_pct: numeric(row.max_drawdown_pct),
      total_trades: row.total_trades,
      open_positions: numeric(row.open_positions),
      risk_per_trade_pct: numeric(row.risk_per_trade_pct),
      max_position_pct: numeric(row.max_position_pct),
      min_confidence: numeric(row.min_confidence),
      max_daily_loss: numeric(row.max_daily_loss),
      last_decision_at: row.last_decision_at ? timestamp(row.last_decision_at) : undefined,
    };
  });
}

async function listMarket(): Promise<MarketQuote[]> {
  const rows = await db.queryAll<MarketRow>`
    SELECT * FROM arena_market ORDER BY symbol
  `;
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    price: numeric(row.price),
    previous_close: numeric(row.previous_close),
    change_pct: numeric(row.change_pct),
    updated_at: timestamp(row.updated_at),
  }));
}

async function listEquitySeries(): Promise<EquitySeries[]> {
  const rows = await db.queryAll<EquityRow>`
    SELECT s.agent_id, a.name AS agent_name, a.accent, a.initial_balance,
      s.equity, s.captured_at
    FROM arena_equity_snapshots s
    JOIN arena_agents a ON a.id = s.agent_id
    ORDER BY s.captured_at, s.agent_id
  `;
  const series = new Map<string, EquitySeries>();
  for (const row of rows) {
    const initial = numeric(row.initial_balance);
    const current = series.get(row.agent_id) || {
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      accent: row.accent,
      points: [],
    };
    const equity = numeric(row.equity);
    current.points.push({
      captured_at: timestamp(row.captured_at),
      equity,
      return_pct: ((equity - initial) / initial) * 100,
    });
    series.set(row.agent_id, current);
  }
  return [...series.values()];
}

async function listPositions(): Promise<ArenaPosition[]> {
  const rows = await db.queryAll<PositionRow>`
    SELECT p.id, p.agent_id, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent, p.symbol, p.quantity, p.average_entry_price,
      p.current_price, p.market_value, p.unrealized_pnl, p.stop_loss,
      p.take_profit, p.opened_at
    FROM arena_positions p
    JOIN arena_agents a ON a.id = p.agent_id
    WHERE p.status = 'open'
    ORDER BY abs(p.unrealized_pnl) DESC, p.opened_at DESC
  `;
  return rows.map((row) => {
    const entry = numeric(row.average_entry_price);
    const current = numeric(row.current_price);
    return {
      id: row.id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      agent_code: row.agent_code,
      agent_accent: row.agent_accent,
      symbol: row.symbol,
      quantity: numeric(row.quantity),
      average_entry_price: entry,
      current_price: current,
      market_value: numeric(row.market_value),
      unrealized_pnl: numeric(row.unrealized_pnl),
      return_pct: ((current - entry) / entry) * 100,
      stop_loss: numeric(row.stop_loss),
      take_profit: numeric(row.take_profit),
      opened_at: timestamp(row.opened_at),
    };
  });
}

async function listDecisions(): Promise<ArenaDecision[]> {
  const rows = await db.queryAll<DecisionRow>`
    SELECT d.*, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent
    FROM arena_decisions d
    JOIN arena_agents a ON a.id = d.agent_id
    ORDER BY d.created_at DESC
    LIMIT 20
  `;
  return rows.map((row) => ({
    id: row.id,
    round_number: row.round_number,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    agent_code: row.agent_code,
    agent_accent: row.agent_accent,
    symbol: row.symbol,
    action: row.action,
    requested_action: row.requested_action || row.action,
    confidence: numeric(row.confidence),
    rationale: row.rationale,
    requested_allocation_pct: numeric(row.requested_allocation_pct),
    proposed_notional: numeric(row.proposed_notional),
    executed_notional: numeric(row.executed_notional),
    approved: row.approved,
    risk_note: row.risk_note,
    source: row.source,
    provider_model: row.provider_model || undefined,
    provider_request_id: row.provider_request_id || undefined,
    prompt_tokens: row.prompt_tokens ?? undefined,
    completion_tokens: row.completion_tokens ?? undefined,
    latency_ms: row.latency_ms ?? undefined,
    generation_cost: row.generation_cost === null ? undefined : numeric(row.generation_cost),
    created_at: timestamp(row.created_at),
  }));
}

async function listTrades(): Promise<ArenaTrade[]> {
  const rows = await db.queryAll<TradeRow>`
    SELECT t.*, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent
    FROM arena_trades t
    JOIN arena_agents a ON a.id = t.agent_id
    ORDER BY coalesce(t.closed_at, t.opened_at) DESC
    LIMIT 24
  `;
  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    agent_code: row.agent_code,
    agent_accent: row.agent_accent,
    symbol: row.symbol,
    quantity: numeric(row.quantity),
    entry_price: numeric(row.entry_price),
    exit_price: row.exit_price === null ? undefined : numeric(row.exit_price),
    realized_pnl: row.realized_pnl === null ? undefined : numeric(row.realized_pnl),
    return_pct: row.return_pct === null ? undefined : numeric(row.return_pct),
    status: row.status,
    opened_at: timestamp(row.opened_at),
    closed_at: row.closed_at ? timestamp(row.closed_at) : undefined,
    exit_reason: row.exit_reason || undefined,
  }));
}

async function buildArena(): Promise<ArenaResponse> {
  const [state, models, market, equitySeries, positions, decisions, trades] = await Promise.all([
    db.queryRow<StateRow>`SELECT * FROM arena_state WHERE id = 1`,
    listModels(),
    listMarket(),
    listEquitySeries(),
    listPositions(),
    listDecisions(),
    listTrades(),
  ]);
  if (!state) throw APIError.internal("arena state is missing");

  const startingCapital = models.reduce((sum, model) => sum + model.initial_balance, 0);
  const totalEquity = models.reduce((sum, model) => sum + model.equity, 0);
  const totalPnl = totalEquity - startingCapital;
  return {
    arena: {
      title: state.title,
      season: state.season,
      round_number: state.round_number,
      status: state.status,
      mode: state.mode,
      starting_capital: startingCapital,
      total_equity: totalEquity,
      total_pnl: totalPnl,
      return_pct: startingCapital === 0 ? 0 : (totalPnl / startingCapital) * 100,
      open_positions: positions.length,
      executed_trades: models.reduce((sum, model) => sum + model.total_trades, 0),
      last_round_at: timestamp(state.last_round_at),
      next_round_at: timestamp(state.next_round_at),
      leader_id: models[0]?.id || "",
    },
    models,
    market,
    equity_series: equitySeries,
    positions,
    decisions,
    trades,
    openrouter: openRouterIntegration(),
    generated_at: new Date().toISOString(),
  };
}

async function markToMarket(): Promise<void> {
  await db.exec`
    UPDATE arena_positions p SET
      current_price = m.price,
      market_value = p.quantity * m.price,
      unrealized_pnl = p.quantity * (m.price - p.average_entry_price),
      updated_at = now()
    FROM arena_market m
    WHERE p.symbol = m.symbol AND p.status = 'open'
  `;
  await db.exec`
    UPDATE arena_agents a SET
      unrealized_pnl = coalesce((
        SELECT sum(p.unrealized_pnl) FROM arena_positions p
        WHERE p.agent_id = a.id AND p.status = 'open'
      ), 0),
      equity = a.cash_balance + coalesce((
        SELECT sum(p.market_value) FROM arena_positions p
        WHERE p.agent_id = a.id AND p.status = 'open'
      ), 0),
      updated_at = now()
  `;
}

async function insertDecision(input: {
  roundNumber: number;
  agentId: string;
  symbol: string;
  action: ArenaAction;
  confidence: number;
  rationale: string;
  proposedNotional?: number;
  executedNotional?: number;
  approved?: boolean;
  riskNote: string;
  audit: DecisionAudit;
}): Promise<void> {
  await db.exec`
    INSERT INTO arena_decisions (
      round_number, agent_id, symbol, action, confidence, rationale,
      requested_action, requested_allocation_pct, proposed_notional,
      executed_notional, approved, risk_note, source, provider_model,
      provider_request_id, prompt_tokens, completion_tokens, latency_ms,
      generation_cost
    ) VALUES (
      ${input.roundNumber}, ${input.agentId}, ${input.symbol}, ${input.action},
      ${input.confidence}, ${input.rationale}, ${input.audit.requestedAction},
      ${input.audit.requestedAllocationPct}, ${input.proposedNotional || 0},
      ${input.executedNotional || 0}, ${Boolean(input.approved)}, ${input.riskNote},
      ${input.audit.source}, ${input.audit.providerModel || null},
      ${input.audit.providerRequestId || null}, ${input.audit.promptTokens ?? null},
      ${input.audit.completionTokens ?? null}, ${input.audit.latencyMs ?? null},
      ${input.audit.generationCost ?? null}
    )
  `;
  await db.exec`
    UPDATE arena_agents SET last_decision_at = now(), updated_at = now()
    WHERE id = ${input.agentId}
  `;
}

async function closePosition(
  position: ExecutionPositionRow,
  roundNumber: number,
  reason: string,
  rationale: string,
  confidence: number,
  audit: DecisionAudit,
): Promise<void> {
  const quantity = numeric(position.quantity);
  const entry = numeric(position.average_entry_price);
  const price = numeric(position.current_price);
  const proceeds = quantity * price;
  const pnl = (price - entry) * quantity;
  const returnPct = ((price - entry) / entry) * 100;
  const win = pnl >= 0 ? 1 : 0;
  const loss = pnl < 0 ? 1 : 0;

  await db.exec`
    UPDATE arena_positions SET status = 'closed', closed_at = now(), updated_at = now()
    WHERE id = ${position.id} AND status = 'open'
  `;
  await db.exec`
    UPDATE arena_trades SET status = 'closed', exit_price = ${price},
      realized_pnl = ${pnl}, return_pct = ${returnPct}, closed_at = now(),
      exit_reason = ${reason}
    WHERE position_id = ${position.id} AND status = 'open'
  `;
  await db.exec`
    INSERT INTO arena_orders (agent_id, symbol, side, quantity, fill_price, notional)
    VALUES (${position.agent_id}, ${position.symbol}, 'sell', ${quantity}, ${price}, ${proceeds})
  `;
  await db.exec`
    UPDATE arena_agents SET
      cash_balance = cash_balance + ${proceeds},
      realized_pnl = realized_pnl + ${pnl},
      total_trades = total_trades + 1,
      winning_trades = winning_trades + ${win},
      losing_trades = losing_trades + ${loss},
      win_rate = 100.0 * (winning_trades + ${win}) / greatest(total_trades + 1, 1),
      updated_at = now()
    WHERE id = ${position.agent_id}
  `;
  await insertDecision({
    roundNumber,
    agentId: position.agent_id,
    symbol: position.symbol,
    action: "sell",
    confidence,
    rationale,
    proposedNotional: proceeds,
    executedNotional: proceeds,
    approved: true,
    riskNote: `${reason} executed at the shared market quote.`,
    audit,
  });
}

async function enforceHardExits(roundNumber: number): Promise<Set<string>> {
  const exits = await db.queryAll<ExecutionPositionRow>`
    SELECT id, agent_id, symbol, quantity, average_entry_price, current_price,
      stop_loss, take_profit
    FROM arena_positions
    WHERE status = 'open'
      AND (current_price <= stop_loss OR current_price >= take_profit)
  `;
  const exitedAgents = new Set<string>();
  for (const position of exits) {
    const stopHit = numeric(position.current_price) <= numeric(position.stop_loss);
    const reason = stopHit ? "hard stop" : "take profit";
    await closePosition(
      position,
      roundNumber,
      reason,
      `${position.symbol} reached its ${reason}; the risk engine closed the position before new model output.`,
      0.99,
      {
        source: "risk_engine",
        requestedAction: "sell",
        requestedAllocationPct: 0,
      },
    );
    exitedAgents.add(position.agent_id);
  }
  return exitedAgents;
}

function providerAudit(result: OpenRouterDecisionResult): DecisionAudit {
  return {
    source: "openrouter",
    requestedAction: result.decision.action,
    requestedAllocationPct: result.decision.allocation_pct,
    providerModel: result.model,
    providerRequestId: result.request_id,
    promptTokens: result.prompt_tokens,
    completionTokens: result.completion_tokens,
    latencyMs: result.latency_ms,
    generationCost: result.generation_cost,
  };
}

async function listRoundAgents(): Promise<AgentRow[]> {
  return db.queryAll<AgentRow>`
    SELECT a.*,
      (SELECT count(*) FROM arena_positions p
        WHERE p.agent_id = a.id AND p.status = 'open') AS open_positions
    FROM arena_agents a
    ORDER BY a.id
  `;
}

function decisionInput(
  roundNumber: number,
  agent: AgentRow,
  market: MarketQuote[],
  positions: ArenaPosition[],
): OpenRouterDecisionInput {
  return {
    round_number: roundNumber,
    model: agent.openrouter_model,
    agent: {
      name: agent.name,
      strategy: agent.strategy,
      thesis: agent.thesis,
    },
    portfolio: {
      initial_balance: numeric(agent.initial_balance),
      cash_balance: numeric(agent.cash_balance),
      equity: numeric(agent.equity),
      realized_pnl: numeric(agent.realized_pnl),
      unrealized_pnl: numeric(agent.unrealized_pnl),
      positions: positions.filter((position) => position.agent_id === agent.id).map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        average_entry_price: position.average_entry_price,
        current_price: position.current_price,
        unrealized_pnl: position.unrealized_pnl,
        stop_loss: position.stop_loss,
        take_profit: position.take_profit,
      })),
    },
    risk: {
      long_only: true,
      risk_per_trade_pct: numeric(agent.risk_per_trade_pct),
      max_position_pct: numeric(agent.max_position_pct),
      min_confidence: numeric(agent.min_confidence),
      max_daily_loss: numeric(agent.max_daily_loss),
      hard_stop_pct: 5,
      take_profit_pct: 10,
    },
    market: market.map((quote) => ({
      symbol: quote.symbol,
      price: quote.price,
      previous_close: quote.previous_close,
      change_pct: quote.change_pct,
    })),
  };
}

async function requestModelDecisions(
  roundNumber: number,
  agents: AgentRow[],
  market: MarketQuote[],
  positions: ArenaPosition[],
): Promise<ProviderOutcome[]> {
  return Promise.all(agents.map(async (agent): Promise<ProviderOutcome> => {
    try {
      const result = await requestOpenRouterDecision(decisionInput(roundNumber, agent, market, positions));
      return { ok: true, agent, result };
    } catch (cause) {
      const error = cause instanceof OpenRouterRequestError
        ? cause
        : new OpenRouterRequestError(cause instanceof Error ? cause.message : "OpenRouter request failed", 0);
      return { ok: false, agent, error };
    }
  }));
}

async function executeBuy(
  agent: AgentRow,
  decision: OpenRouterModelDecision,
  result: OpenRouterDecisionResult,
  roundNumber: number,
): Promise<ModelRoundResult> {
  const [quote, existing, dailyResult] = await Promise.all([
    db.queryRow<MarketRow>`SELECT * FROM arena_market WHERE symbol = ${decision.symbol}`,
    db.queryRow<{ id: string }>`
      SELECT id FROM arena_positions
      WHERE agent_id = ${agent.id} AND symbol = ${decision.symbol} AND status = 'open'
    `,
    db.queryRow<{ pnl: string | number }>`
      SELECT coalesce(sum(realized_pnl), 0) AS pnl
      FROM arena_trades
      WHERE agent_id = ${agent.id} AND status = 'closed'
        AND closed_at >= date_trunc('day', now())
    `,
  ]);
  if (!quote) throw APIError.internal("OpenRouter selected a missing market quote");
  const audit = providerAudit(result);
  if (existing) {
    const riskNote = "One open position per model and symbol is enforced.";
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      riskNote,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "skipped", action: "skip", message: riskNote };
  }

  const equity = numeric(agent.equity);
  const cash = numeric(agent.cash_balance);
  const price = numeric(quote.price);
  const requestedNotional = equity * (decision.allocation_pct / 100);
  const maxRisk = equity * (numeric(agent.risk_per_trade_pct) / 100);
  const maxNotionalFromRisk = maxRisk / 0.05;
  const positionCap = equity * (numeric(agent.max_position_pct) / 100);
  const approvedNotional = Math.min(requestedNotional, maxNotionalFromRisk, positionCap, cash * 0.98);
  const confidencePasses = decision.confidence >= numeric(agent.min_confidence);
  const dailyLossPasses = numeric(dailyResult?.pnl) > -numeric(agent.max_daily_loss);
  if (!confidencePasses || !dailyLossPasses || approvedNotional < 100) {
    const riskNote = !confidencePasses
      ? "Confidence is below the model threshold."
      : !dailyLossPasses
        ? "The portfolio reached its daily loss limit."
        : "The approved risk budget is below the minimum order size.";
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      proposedNotional: requestedNotional,
      riskNote,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "skipped", action: "skip", message: riskNote };
  }

  const quantity = Math.floor((approvedNotional / price) * 10_000) / 10_000;
  const notional = quantity * price;
  const stopLoss = round(price * 0.95, 8);
  const takeProfit = round(price * 1.10, 8);
  const position = await db.queryRow<{ id: string }>`
    INSERT INTO arena_positions (
      agent_id, symbol, quantity, average_entry_price, current_price,
      market_value, unrealized_pnl, stop_loss, take_profit
    ) VALUES (
      ${agent.id}, ${decision.symbol}, ${quantity}, ${price}, ${price},
      ${notional}, 0, ${stopLoss}, ${takeProfit}
    ) RETURNING id
  `;
  if (!position) throw APIError.internal("paper position could not be opened");
  await db.exec`
    INSERT INTO arena_trades (
      agent_id, position_id, symbol, quantity, entry_price, status
    ) VALUES (${agent.id}, ${position.id}, ${decision.symbol}, ${quantity}, ${price}, 'open')
  `;
  await db.exec`
    INSERT INTO arena_orders (agent_id, symbol, side, quantity, fill_price, notional)
    VALUES (${agent.id}, ${decision.symbol}, 'buy', ${quantity}, ${price}, ${notional})
  `;
  await db.exec`
    UPDATE arena_agents SET cash_balance = cash_balance - ${notional}, updated_at = now()
    WHERE id = ${agent.id}
  `;
  const capped = notional + 0.01 < requestedNotional;
  const riskNote = capped
    ? `Filled ${round(notional, 2)} after the risk engine reduced the model request.`
    : "Filled at the shared quote with a 5% hard stop and 10% target.";
  await insertDecision({
    roundNumber,
    agentId: agent.id,
    symbol: decision.symbol,
    action: "buy",
    confidence: decision.confidence,
    rationale: decision.rationale,
    proposedNotional: requestedNotional,
    executedNotional: notional,
    approved: true,
    riskNote,
    audit,
  });
  return { agent_id: agent.id, model: result.model, status: "completed", action: "buy", message: riskNote };
}

async function executeSell(
  agent: AgentRow,
  decision: OpenRouterModelDecision,
  result: OpenRouterDecisionResult,
  roundNumber: number,
): Promise<ModelRoundResult> {
  const position = await db.queryRow<ExecutionPositionRow>`
    SELECT id, agent_id, symbol, quantity, average_entry_price, current_price,
      stop_loss, take_profit
    FROM arena_positions
    WHERE agent_id = ${agent.id} AND symbol = ${decision.symbol} AND status = 'open'
  `;
  if (!position) {
    const riskNote = "A sell cannot create a short position in this long-only arena.";
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      riskNote,
      audit: providerAudit(result),
    });
    return { agent_id: agent.id, model: result.model, status: "skipped", action: "skip", message: riskNote };
  }
  await closePosition(
    position,
    roundNumber,
    "model exit",
    decision.rationale,
    decision.confidence,
    providerAudit(result),
  );
  return {
    agent_id: agent.id,
    model: result.model,
    status: "completed",
    action: "sell",
    message: `${decision.symbol} was sold at the shared market quote.`,
  };
}

async function executeModelDecision(
  outcome: ProviderSuccess,
  roundNumber: number,
): Promise<ModelRoundResult> {
  const { agent, result } = outcome;
  if (result.decision.action === "buy") {
    return executeBuy(agent, result.decision, result, roundNumber);
  }
  if (result.decision.action === "sell") {
    return executeSell(agent, result.decision, result, roundNumber);
  }
  await insertDecision({
    roundNumber,
    agentId: agent.id,
    symbol: result.decision.symbol,
    action: "hold",
    confidence: result.decision.confidence,
    rationale: result.decision.rationale,
    riskNote: "No order was sent; existing stops and position limits remain active.",
    audit: providerAudit(result),
  });
  return {
    agent_id: agent.id,
    model: result.model,
    status: "completed",
    action: "hold",
    message: "The model held its portfolio unchanged.",
  };
}

async function recordProviderFailure(
  outcome: ProviderFailure,
  roundNumber: number,
  fallbackSymbol: string,
): Promise<ModelRoundResult> {
  const riskNote = `OpenRouter: ${outcome.error.message}`;
  await insertDecision({
    roundNumber,
    agentId: outcome.agent.id,
    symbol: fallbackSymbol,
    action: "skip",
    confidence: 0,
    rationale: `${outcome.agent.name} did not produce a usable decision for this round.`,
    riskNote,
    audit: {
      source: "openrouter",
      requestedAction: "skip",
      requestedAllocationPct: 0,
      providerModel: outcome.agent.openrouter_model,
      latencyMs: outcome.error.latencyMs,
    },
  });
  return {
    agent_id: outcome.agent.id,
    model: outcome.agent.openrouter_model,
    status: "failed",
    action: "skip",
    message: outcome.error.message,
  };
}

async function recordSnapshots(): Promise<void> {
  await db.exec`
    INSERT INTO arena_equity_snapshots (agent_id, equity)
    SELECT id, equity FROM arena_agents
  `;
  await db.exec`
    WITH peaks AS (
      SELECT agent_id, max(equity) AS peak
      FROM arena_equity_snapshots
      GROUP BY agent_id
    )
    UPDATE arena_agents a SET max_drawdown_pct = greatest(
      a.max_drawdown_pct,
      CASE WHEN peaks.peak > 0 THEN ((peaks.peak - a.equity) / peaks.peak) * 100 ELSE 0 END
    )
    FROM peaks WHERE peaks.agent_id = a.id
  `;
}

export const getArena = api(
  { expose: true, method: "GET", path: "/arena" },
  async (): Promise<ArenaResponse> => buildArena(),
);

export const runRound = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/arena/round" },
  async (): Promise<RunRoundResponse> => {
    if (!openRouterConfigured()) {
      throw APIError.failedPrecondition("OpenRouterAPIKey is not configured");
    }
    const state = await db.queryRow<{ round_number: number }>`
      UPDATE arena_state SET
        round_number = round_number + 1,
        round_in_progress = true,
        round_started_at = now(),
        last_round_at = now(),
        next_round_at = now() + interval '5 minutes',
        updated_at = now()
      WHERE id = 1 AND status = 'running'
        AND (round_in_progress = false OR round_started_at < now() - interval '3 minutes')
      RETURNING round_number
    `;
    if (!state) throw APIError.failedPrecondition("the arena is paused or another round is clearing");

    try {
      const marketRows = await db.queryAll<MarketRow>`SELECT * FROM arena_market ORDER BY symbol`;
      for (const quote of marketRows) {
        const moves = marketMoves[quote.symbol] || [0];
        const move = moves[state.round_number % moves.length] || 0;
        const price = round(numeric(quote.price) * (1 + move / 100), 8);
        const previousClose = numeric(quote.previous_close);
        const changePct = ((price - previousClose) / previousClose) * 100;
        await db.exec`
          UPDATE arena_market SET price = ${price}, change_pct = ${changePct}, updated_at = now()
          WHERE symbol = ${quote.symbol}
        `;
      }

      await markToMarket();
      const exitedAgents = await enforceHardExits(state.round_number);
      const [agents, market, positions] = await Promise.all([
        listRoundAgents(),
        listMarket(),
        listPositions(),
      ]);
      const fallbackSymbol = market[0]?.symbol;
      if (!fallbackSymbol) throw APIError.internal("the shared market is empty");

      const roundResults: ModelRoundResult[] = [];
      for (const agent of agents) {
        if (exitedAgents.has(agent.id)) {
          roundResults.push({
            agent_id: agent.id,
            model: agent.openrouter_model,
            status: "skipped",
            action: "sell",
            message: "The risk engine closed a hard exit before model inference.",
          });
        } else if (agent.status !== "active") {
          roundResults.push({
            agent_id: agent.id,
            model: agent.openrouter_model,
            status: "skipped",
            message: `The model is ${agent.status}.`,
          });
        }
      }

      const eligible = agents.filter((agent) => agent.status === "active" && !exitedAgents.has(agent.id));
      const outcomes = await requestModelDecisions(state.round_number, eligible, market, positions);
      for (const outcome of outcomes) {
        roundResults.push(outcome.ok
          ? await executeModelDecision(outcome, state.round_number)
          : await recordProviderFailure(outcome, state.round_number, fallbackSymbol));
      }

      await markToMarket();
      await recordSnapshots();
      const arena = await buildArena();
      const failures = roundResults.filter((result) => result.status === "failed").length;
      const completed = roundResults.filter((result) => result.status === "completed").length;
      const roundMessage = failures > 0
        ? `Round ${state.round_number}: ${completed} OpenRouter decisions completed and ${failures} failed safely.`
        : `Round ${state.round_number}: all ${completed} OpenRouter decisions completed.`;
      return { ...arena, round_message: roundMessage, round_results: roundResults };
    } finally {
      await db.exec`
        UPDATE arena_state SET round_in_progress = false, updated_at = now()
        WHERE id = 1 AND round_number = ${state.round_number}
      `;
    }
  },
);
