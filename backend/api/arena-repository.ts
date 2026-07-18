import { APIError } from "encore.dev/api";
import {
  DECISION_CYCLE_MINUTES,
  arenaTradingSession,
  arenaTradingSessionOpen,
  competitionProgress,
} from "./arena-time";
import { db } from "./db";
import { openRouterIntegration } from "./openrouter";
import { robinhoodIntegration } from "./robinhood-mcp";
import type {
  ArenaDecision,
  ArenaDecisionSource,
  ArenaModel,
  ArenaOrder,
  ArenaPosition,
  ArenaResponse,
  ArenaRound,
  ArenaStatus,
  ArenaTrade,
  BrokerAccountSummary,
  EquitySeries,
  MarketQuote,
  SchedulerHealth,
  SchedulerSummary,
} from "./types";

export const ARENA_UNIVERSE = [
  "ACHR",
  "AMZN",
  "JOBY",
  "LCID",
  "META",
  "MSFT",
  "NVDA",
  "PAGS",
  "SOUN",
  "SPY",
  "TSLA",
] as const;

export const MARKET_NAMES: Record<(typeof ARENA_UNIVERSE)[number], string> = {
  ACHR: "Archer Aviation",
  AMZN: "Amazon",
  JOBY: "Joby Aviation",
  LCID: "Lucid",
  META: "Meta",
  MSFT: "Microsoft",
  NVDA: "NVIDIA",
  PAGS: "PagSeguro",
  SOUN: "SoundHound AI",
  SPY: "S&P 500 ETF",
  TSLA: "Tesla",
};

export interface AgentRow {
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
  round_starting_equity: string | number;
  cash_balance: string | number;
  equity: string | number;
  realized_pnl: string | number;
  unrealized_pnl: string | number;
  win_rate: string | number;
  max_drawdown_pct: string | number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  risk_per_trade_pct: string | number;
  max_position_pct: string | number;
  min_confidence: string | number;
  max_daily_loss: string | number;
  last_decision_at: Date | string | null;
  open_positions: string | number;
}

export interface ArenaStateRow {
  title: string;
  season: string;
  round_number: number;
  status: ArenaStatus;
  mode: "live";
  operator_capital_ceiling: string | number;
  capital_limit: string | number;
  allocation_per_model: string | number;
  capital_initialized_at: Date | string | null;
  capital_source: "operator" | "robinhood";
  live_armed: boolean;
  automation_enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  round_in_progress: boolean;
  round_started_at: Date | string | null;
  cycle_number: number;
  cycle_in_progress: boolean;
  cycle_started_at: Date | string | null;
  last_cycle_at: Date | string | null;
  next_cycle_at: Date | string;
  competition_started_at: Date | string;
  competition_ends_at: Date | string;
  broker_buying_power: string | number | null;
  broker_equity: string | number | null;
  broker_as_of: Date | string | null;
  broker_unmanaged_positions: string[];
  robinhood_oauth_connected: boolean;
  robinhood_oauth_expires_at: Date | string | null;
  last_robinhood_sync_at: Date | string | null;
  robinhood_error: string | null;
  scheduler_last_seen_at: Date | string | null;
  scheduler_last_success_at: Date | string | null;
  scheduler_last_error_at: Date | string | null;
  scheduler_last_error: string | null;
  scheduler_consecutive_failures: number;
  scheduler_retry_at: Date | string | null;
  scheduler_recovery_count: number;
  scheduler_last_recovery_at: Date | string | null;
  last_round_at: Date | string;
  next_round_at: Date | string;
}

interface MarketRow {
  symbol: string;
  name: string;
  price: string | number;
  previous_close: string | number;
  change_pct: string | number;
  bid: string | number | null;
  ask: string | number | null;
  source: "robinhood_mcp";
  as_of: Date | string;
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
  broker_order_id: string;
  opened_at: Date | string;
}

interface DecisionRow {
  id: string;
  round_number: number;
  cycle_number: number;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  action: ArenaDecision["action"];
  requested_action: ArenaDecision["requested_action"] | null;
  confidence: string | number;
  rationale: string;
  requested_allocation_pct: string | number | null;
  proposed_notional: string | number;
  executed_notional: string | number;
  approved: boolean;
  risk_note: string;
  source: ArenaDecisionSource;
  order_id: string | null;
  provider_model: string | null;
  provider_request_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  generation_cost: string | number | null;
  created_at: Date | string;
}

interface OrderRow {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  requested_amount: string | number;
  requested_quantity: string | number;
  filled_quantity: string | number;
  average_fill_price: string | number | null;
  broker_order_id: string | null;
  error_message: string | null;
  created_at: Date | string;
  reconciled_at: Date | string | null;
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
  broker_order_id: string;
  opened_at: Date | string;
  closed_at: Date | string | null;
  exit_reason: string | null;
}

interface RoundRow {
  id: string;
  round_number: number;
  label: string;
  status: "active" | "completed";
  started_at: Date | string;
  ends_at: Date | string;
  starting_capital: string | number;
  ending_capital: string | number | null;
  winner_agent_id: string | null;
  winner_agent_name: string | null;
  winner_return_pct: string | number | null;
}

export function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function rounded(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export async function getArenaState(): Promise<ArenaStateRow> {
  const row = await db.queryRow<ArenaStateRow>`SELECT * FROM arena_state WHERE id = 1`;
  if (!row) throw APIError.internal("arena state is missing");
  return row;
}

export async function listAgentRows(): Promise<AgentRow[]> {
  return db.queryAll<AgentRow>`
    SELECT a.*,
      coalesce(result.starting_equity, a.initial_balance) AS round_starting_equity,
      (SELECT count(*) FROM arena_positions p
        WHERE p.agent_id = a.id AND p.status = 'open') AS open_positions
    FROM arena_agents a
    LEFT JOIN arena_rounds round ON round.status = 'active'
    LEFT JOIN arena_round_results result
      ON result.round_id = round.id AND result.agent_id = a.id
    ORDER BY a.id
  `;
}

export async function listModels(): Promise<ArenaModel[]> {
  const rows = await listAgentRows();
  const models = rows.map((row) => {
    const initial = numeric(row.initial_balance);
    const roundStartingEquity = numeric(row.round_starting_equity);
    const equity = numeric(row.equity);
    return {
      id: row.id,
      rank: 0,
      name: row.name,
      provider: row.provider,
      code: row.code,
      strategy: row.strategy,
      thesis: row.thesis,
      accent: row.accent,
      status: row.status,
      openrouter_model: row.openrouter_model,
      initial_balance: initial,
      round_starting_equity: roundStartingEquity,
      cash_balance: numeric(row.cash_balance),
      equity,
      realized_pnl: numeric(row.realized_pnl),
      unrealized_pnl: numeric(row.unrealized_pnl),
      total_pnl: equity - roundStartingEquity,
      return_pct: roundStartingEquity === 0
        ? 0
        : ((equity - roundStartingEquity) / roundStartingEquity) * 100,
      win_rate: numeric(row.win_rate),
      max_drawdown_pct: numeric(row.max_drawdown_pct),
      total_trades: row.total_trades,
      open_positions: numeric(row.open_positions),
      risk_per_trade_pct: numeric(row.risk_per_trade_pct),
      max_position_pct: numeric(row.max_position_pct),
      min_confidence: numeric(row.min_confidence),
      max_daily_loss: numeric(row.max_daily_loss),
      last_decision_at: row.last_decision_at ? timestamp(row.last_decision_at) : undefined,
    } satisfies ArenaModel;
  });
  models.sort((left, right) => right.return_pct - left.return_pct || left.id.localeCompare(right.id));
  return models.map((model, index) => ({ ...model, rank: index + 1 }));
}

export async function listMarket(): Promise<MarketQuote[]> {
  const rows = await db.queryAll<MarketRow>`SELECT * FROM arena_market ORDER BY symbol`;
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    price: numeric(row.price),
    previous_close: numeric(row.previous_close),
    change_pct: numeric(row.change_pct),
    bid: row.bid === null ? undefined : numeric(row.bid),
    ask: row.ask === null ? undefined : numeric(row.ask),
    source: row.source,
    as_of: timestamp(row.as_of),
    updated_at: timestamp(row.updated_at),
  }));
}

export async function listEquitySeries(): Promise<EquitySeries[]> {
  const rows = await db.queryAll<EquityRow>`
    SELECT agent_id, agent_name, accent, initial_balance, equity, captured_at
    FROM (
      SELECT changed.*,
        row_number() OVER (
          PARTITION BY changed.agent_id ORDER BY changed.captured_at DESC
        ) AS sequence
      FROM (
        SELECT s.agent_id, a.name AS agent_name, a.accent,
          result.starting_equity AS initial_balance,
          s.equity, s.source, s.captured_at,
          lag(s.equity) OVER (
            PARTITION BY s.agent_id, s.round_id ORDER BY s.captured_at
          ) AS previous_equity,
          row_number() OVER (
            PARTITION BY s.agent_id, s.round_id ORDER BY s.captured_at
          ) AS opening_sequence
        FROM arena_equity_snapshots s
        JOIN arena_agents a ON a.id = s.agent_id
        JOIN arena_rounds round ON round.id = s.round_id AND round.status = 'active'
        JOIN arena_round_results result
          ON result.round_id = round.id AND result.agent_id = s.agent_id
      ) changed
      WHERE source = 'allocation'
        OR opening_sequence = 1
        OR equity IS DISTINCT FROM previous_equity
    ) recent
    WHERE sequence <= 2016
    ORDER BY captured_at, agent_id
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
      return_pct: initial === 0 ? 0 : ((equity - initial) / initial) * 100,
    });
    series.set(row.agent_id, current);
  }
  return [...series.values()];
}

export async function listPositions(): Promise<ArenaPosition[]> {
  const rows = await db.queryAll<PositionRow>`
    SELECT p.id, p.agent_id, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent, p.symbol, p.quantity, p.average_entry_price,
      p.current_price, p.market_value, p.unrealized_pnl, p.stop_loss,
      p.take_profit, source_order.broker_order_id, p.opened_at
    FROM arena_positions p
    JOIN arena_agents a ON a.id = p.agent_id
    JOIN arena_orders source_order ON source_order.id = p.source_order_id
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
      return_pct: entry === 0 ? 0 : ((current - entry) / entry) * 100,
      stop_loss: numeric(row.stop_loss),
      take_profit: numeric(row.take_profit),
      broker_order_id: row.broker_order_id,
      opened_at: timestamp(row.opened_at),
    };
  });
}

export async function listDecisions(): Promise<ArenaDecision[]> {
  const rows = await db.queryAll<DecisionRow>`
    SELECT d.*, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent
    FROM arena_decisions d
    JOIN arena_agents a ON a.id = d.agent_id
    ORDER BY d.created_at DESC
    LIMIT 32
  `;
  return rows.map((row) => ({
    id: row.id,
    round_number: row.round_number,
    cycle_number: row.cycle_number,
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
    order_id: row.order_id || undefined,
    provider_model: row.provider_model || undefined,
    provider_request_id: row.provider_request_id || undefined,
    prompt_tokens: row.prompt_tokens ?? undefined,
    completion_tokens: row.completion_tokens ?? undefined,
    latency_ms: row.latency_ms ?? undefined,
    generation_cost: row.generation_cost === null ? undefined : numeric(row.generation_cost),
    created_at: timestamp(row.created_at),
  }));
}

export async function listOrders(): Promise<ArenaOrder[]> {
  const rows = await db.queryAll<OrderRow>`
    SELECT o.*, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent
    FROM arena_orders o
    JOIN arena_agents a ON a.id = o.agent_id
    ORDER BY o.created_at DESC
    LIMIT 32
  `;
  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    agent_code: row.agent_code,
    agent_accent: row.agent_accent,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    requested_amount: numeric(row.requested_amount),
    requested_quantity: numeric(row.requested_quantity),
    filled_quantity: numeric(row.filled_quantity),
    average_fill_price: row.average_fill_price === null ? undefined : numeric(row.average_fill_price),
    broker_order_id: row.broker_order_id || undefined,
    error_message: row.error_message || undefined,
    created_at: timestamp(row.created_at),
    reconciled_at: row.reconciled_at ? timestamp(row.reconciled_at) : undefined,
  }));
}

export async function listTrades(): Promise<ArenaTrade[]> {
  const rows = await db.queryAll<TradeRow>`
    SELECT t.*, a.name AS agent_name, a.code AS agent_code,
      a.accent AS agent_accent, source_order.broker_order_id
    FROM arena_trades t
    JOIN arena_agents a ON a.id = t.agent_id
    JOIN arena_orders source_order ON source_order.id = t.source_order_id
    ORDER BY coalesce(t.closed_at, t.opened_at) DESC
    LIMIT 32
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
    broker_order_id: row.broker_order_id,
    opened_at: timestamp(row.opened_at),
    closed_at: row.closed_at ? timestamp(row.closed_at) : undefined,
    exit_reason: row.exit_reason || undefined,
  }));
}

export async function markToMarket(): Promise<void> {
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

export async function recordEquitySnapshots(): Promise<void> {
  await db.exec`
    INSERT INTO arena_equity_snapshots (agent_id, equity, source, round_id)
    SELECT agent.id, agent.equity, 'robinhood_mcp', round.id
    FROM arena_agents agent
    CROSS JOIN arena_rounds round
    WHERE round.status = 'active'
      AND agent.equity IS DISTINCT FROM (
        SELECT previous.equity
        FROM arena_equity_snapshots previous
        WHERE previous.agent_id = agent.id AND previous.round_id = round.id
        ORDER BY previous.captured_at DESC
        LIMIT 1
      )
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

export async function listRoundHistory(): Promise<ArenaRound[]> {
  const rows = await db.queryAll<RoundRow>`
    SELECT round.id, round.round_number, round.label, round.status,
      round.started_at, round.ends_at, round.starting_capital,
      round.ending_capital, round.winner_agent_id,
      agent.name AS winner_agent_name, round.winner_return_pct
    FROM arena_rounds round
    LEFT JOIN arena_agents agent ON agent.id = round.winner_agent_id
    ORDER BY round.round_number DESC
    LIMIT 8
  `;
  return rows.map((row) => ({
    id: row.id,
    round_number: row.round_number,
    label: row.label,
    status: row.status,
    started_at: timestamp(row.started_at),
    ends_at: timestamp(row.ends_at),
    starting_capital: numeric(row.starting_capital),
    ending_capital: row.ending_capital === null ? undefined : numeric(row.ending_capital),
    winner_agent_id: row.winner_agent_id || undefined,
    winner_agent_name: row.winner_agent_name || undefined,
    winner_return_pct: row.winner_return_pct === null
      ? undefined
      : numeric(row.winner_return_pct),
  }));
}

export async function storedBrokerSummary(state?: ArenaStateRow): Promise<BrokerAccountSummary | undefined> {
  const current = state || await getArenaState();
  if (current.broker_buying_power === null || current.broker_equity === null || !current.broker_as_of) {
    return undefined;
  }
  const exposure = await db.queryRow<{ value: string | number }>`
    SELECT coalesce(sum(market_value), 0) AS value
    FROM arena_positions WHERE status = 'open'
  `;
  return {
    buying_power: numeric(current.broker_buying_power),
    equity: numeric(current.broker_equity),
    as_of: timestamp(current.broker_as_of),
    operator_capital_ceiling: numeric(current.operator_capital_ceiling),
    deployable_capital: numeric(current.capital_limit),
    allocation_per_model: numeric(current.allocation_per_model),
    capital_source: current.capital_source,
    allocated_capital: numeric(current.capital_limit),
    managed_exposure: numeric(exposure?.value),
    unmanaged_positions: current.broker_unmanaged_positions || [],
  };
}

function schedulerHealth(state: ArenaStateRow): SchedulerHealth {
  if (
    !state.live_armed
    || !state.automation_enabled
    || state.halted
    || state.status !== "running"
  ) {
    return "inactive";
  }
  if (state.scheduler_consecutive_failures > 0) return "error";
  const staleBefore = Date.now() - 15 * 60 * 1000;
  const lastSeen = state.scheduler_last_seen_at
    ? new Date(state.scheduler_last_seen_at).getTime()
    : 0;
  const lastSuccess = state.scheduler_last_success_at
    ? new Date(state.scheduler_last_success_at).getTime()
    : 0;
  return lastSeen < staleBefore || lastSuccess < staleBefore ? "delayed" : "healthy";
}

export async function storedSchedulerSummary(
  state?: ArenaStateRow,
): Promise<SchedulerSummary> {
  const current = state || await getArenaState();
  return {
    status: schedulerHealth(current),
    last_seen_at: current.scheduler_last_seen_at
      ? timestamp(current.scheduler_last_seen_at)
      : undefined,
    last_success_at: current.scheduler_last_success_at
      ? timestamp(current.scheduler_last_success_at)
      : undefined,
    last_error_at: current.scheduler_last_error_at
      ? timestamp(current.scheduler_last_error_at)
      : undefined,
    last_error: current.scheduler_last_error || undefined,
    consecutive_failures: current.scheduler_consecutive_failures,
    retry_at: current.scheduler_retry_at
      ? timestamp(current.scheduler_retry_at)
      : undefined,
    recovery_count: current.scheduler_recovery_count,
    last_recovery_at: current.scheduler_last_recovery_at
      ? timestamp(current.scheduler_last_recovery_at)
      : undefined,
  };
}

export async function buildArena(): Promise<ArenaResponse> {
  const [
    state,
    models,
    roundHistory,
    market,
    equitySeries,
    positions,
    decisions,
    orders,
    trades,
  ] = await Promise.all([
    getArenaState(),
    listModels(),
    listRoundHistory(),
    listMarket(),
    listEquitySeries(),
    listPositions(),
    listDecisions(),
    listOrders(),
    listTrades(),
  ]);
  const startingCapital = models.reduce((sum, model) => sum + model.round_starting_equity, 0);
  const totalEquity = models.reduce((sum, model) => sum + model.equity, 0);
  const totalPnl = totalEquity - startingCapital;
  const pendingOrders = orders.filter((order) => !order.reconciled_at).length;
  const scheduler = await storedSchedulerSummary(state);
  return {
    arena: {
      title: state.title,
      season: state.season,
      round_number: state.round_number,
      cycle_number: state.cycle_number,
      round_status: "active",
      status: state.status,
      mode: state.mode,
      operator_capital_ceiling: numeric(state.operator_capital_ceiling),
      capital_limit: numeric(state.capital_limit),
      allocation_per_model: numeric(state.allocation_per_model),
      capital_source: state.capital_source,
      starting_capital: startingCapital,
      total_equity: totalEquity,
      total_pnl: totalPnl,
      return_pct: startingCapital === 0 ? 0 : (totalPnl / startingCapital) * 100,
      open_positions: positions.length,
      pending_orders: pendingOrders,
      executed_trades: trades.filter((trade) => trade.status === "closed").length,
      live_armed: state.live_armed,
      automation_enabled: state.automation_enabled,
      halted: state.halted,
      round_started_at: timestamp(state.competition_started_at),
      round_ends_at: timestamp(state.competition_ends_at),
      round_progress_pct: competitionProgress(
        state.competition_started_at,
        state.competition_ends_at,
      ),
      cycle_interval_minutes: DECISION_CYCLE_MINUTES,
      market_session_open: arenaTradingSessionOpen(),
      trading_session: arenaTradingSession(),
      scheduler_status: scheduler.status,
      scheduler_last_seen_at: scheduler.last_seen_at,
      scheduler_last_success_at: scheduler.last_success_at,
      last_cycle_at: state.last_cycle_at ? timestamp(state.last_cycle_at) : undefined,
      next_cycle_at: timestamp(state.next_cycle_at),
      last_round_at: timestamp(state.competition_started_at),
      next_round_at: timestamp(state.competition_ends_at),
      last_robinhood_sync_at: state.last_robinhood_sync_at
        ? timestamp(state.last_robinhood_sync_at)
        : undefined,
      broker_equity: state.broker_equity === null ? undefined : numeric(state.broker_equity),
      broker_buying_power: state.broker_buying_power === null
        ? undefined
        : numeric(state.broker_buying_power),
      leader_id: models[0]?.id || "",
    },
    models,
    round_history: roundHistory,
    market,
    equity_series: equitySeries,
    positions,
    decisions,
    orders,
    trades,
    openrouter: openRouterIntegration(),
    robinhood: robinhoodIntegration(
      state.robinhood_error || undefined,
      state.robinhood_oauth_connected,
    ),
    generated_at: new Date().toISOString(),
  };
}
