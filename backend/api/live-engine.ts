import { APIError } from "encore.dev/api";
import {
  COMPETITION_ROUND_DAYS,
  DECISION_CYCLE_MINUTES,
  regularMarketSessionOpen,
} from "./arena-time";
import { db } from "./db";
import {
  ARENA_UNIVERSE,
  MARKET_NAMES,
  buildArena,
  getArenaState,
  listAgentRows,
  listMarket,
  listPositions,
  markToMarket,
  numeric,
  recordEquitySnapshots,
  rounded,
  storedBrokerSummary,
  type AgentRow,
} from "./arena-repository";
import {
  openRouterConfigured,
  OpenRouterRequestError,
  requestOpenRouterDecision,
  type OpenRouterDecisionResult,
  type OpenRouterModelDecision,
} from "./openrouter";
import {
  RobinhoodMcpClient,
  type RobinhoodOrderSnapshot,
  type RobinhoodPositionSnapshot,
  type RobinhoodQuote,
} from "./robinhood-mcp";
import type {
  ArenaAction,
  ArenaDecisionSource,
  ArenaPosition,
  BrokerAccountSummary,
  MarketQuote,
  ModelRoundResult,
  RunRoundResponse,
} from "./types";

export const LIVE_CONSENT_CONFIRMATION = "I ACCEPT LIVE ROBINHOOD TRADING RISK";
export const LIVE_EXECUTION_CONFIRMATION = "EXECUTE LIVE ROBINHOOD ORDERS";
export const FLATTEN_CONFIRMATION = "HALT AND FLATTEN";

const HARD_STOP_PCT = 5;
const TAKE_PROFIT_PCT = 10;
const MIN_ORDER_AMOUNT = 1;
const QUANTITY_EPSILON = 0.000001;
const TERMINAL_ORDER_STATES = new Set([
  "cancelled",
  "canceled",
  "failed",
  "rejected",
  "error",
  "expired",
  "voided",
  "filled",
  "completed",
]);

interface LocalOrderRow {
  id: string;
  agent_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  requested_amount: string | number;
  requested_quantity: string | number;
  filled_quantity: string | number;
  average_fill_price: string | number | null;
  accounted_quantity: string | number;
  accounted_notional: string | number;
  broker_order_id: string | null;
  position_id: string | null;
  created_at: Date | string;
  reconciled_at: Date | string | null;
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

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}

function isTerminalOrder(status: string): boolean {
  return TERMINAL_ORDER_STATES.has(status.toLowerCase());
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

async function insertDecision(input: {
  roundNumber: number;
  cycleNumber?: number;
  agentId: string;
  symbol: string;
  action: ArenaAction;
  confidence: number;
  rationale: string;
  proposedNotional?: number;
  executedNotional?: number;
  approved?: boolean;
  riskNote: string;
  orderId?: string;
  audit: DecisionAudit;
}): Promise<void> {
  const cycleNumber = input.cycleNumber ?? (await getArenaState()).cycle_number;
  await db.exec`
    INSERT INTO arena_decisions (
      round_number, cycle_number, agent_id, symbol, action, confidence, rationale,
      requested_action, requested_allocation_pct, proposed_notional,
      executed_notional, approved, risk_note, source, order_id,
      provider_model, provider_request_id, prompt_tokens, completion_tokens,
      latency_ms, generation_cost
    ) VALUES (
      ${input.roundNumber}, ${cycleNumber}, ${input.agentId}, ${input.symbol}, ${input.action},
      ${input.confidence}, ${input.rationale}, ${input.audit.requestedAction},
      ${input.audit.requestedAllocationPct}, ${input.proposedNotional || 0},
      ${input.executedNotional || 0}, ${Boolean(input.approved)}, ${input.riskNote},
      ${input.audit.source}, ${input.orderId || null}, ${input.audit.providerModel || null},
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

async function recordQuotes(quotes: RobinhoodQuote[]): Promise<void> {
  for (const quote of quotes) {
    if (!ARENA_UNIVERSE.includes(quote.symbol as (typeof ARENA_UNIVERSE)[number])) continue;
    const name = MARKET_NAMES[quote.symbol as (typeof ARENA_UNIVERSE)[number]];
    const changePct = quote.previous_close > 0
      ? ((quote.price - quote.previous_close) / quote.previous_close) * 100
      : 0;
    await db.exec`
      INSERT INTO arena_market (
        symbol, name, price, previous_close, change_pct, bid, ask, source, as_of, updated_at
      ) VALUES (
        ${quote.symbol}, ${name}, ${quote.price}, ${quote.previous_close}, ${changePct},
        ${quote.bid ?? null}, ${quote.ask ?? null}, 'robinhood_mcp', ${quote.as_of}, now()
      )
      ON CONFLICT (symbol) DO UPDATE SET
        name = excluded.name,
        price = excluded.price,
        previous_close = excluded.previous_close,
        change_pct = excluded.change_pct,
        bid = excluded.bid,
        ask = excluded.ask,
        source = excluded.source,
        as_of = excluded.as_of,
        updated_at = now()
    `;
  }
}

async function claimSync(): Promise<void> {
  const claimed = await db.queryRow<{ id: number }>`
    UPDATE arena_state SET
      robinhood_sync_in_progress = true,
      robinhood_sync_started_at = now(),
      updated_at = now()
    WHERE id = 1 AND (
      robinhood_sync_in_progress = false
      OR robinhood_sync_started_at < now() - interval '2 minutes'
    )
    RETURNING id
  `;
  if (!claimed) throw APIError.failedPrecondition("a Robinhood reconciliation is already running");
}

async function releaseSync(): Promise<void> {
  await db.exec`
    UPDATE arena_state SET robinhood_sync_in_progress = false,
      robinhood_sync_started_at = NULL, updated_at = now()
    WHERE id = 1
  `;
}

async function linkUnidentifiedOrders(
  remoteOrders: RobinhoodOrderSnapshot[],
): Promise<void> {
  const localOrders = await db.queryAll<LocalOrderRow>`
    SELECT * FROM arena_orders
    WHERE broker_order_id IS NULL AND reconciled_at IS NULL
      AND status NOT IN ('failed', 'rejected', 'error')
    ORDER BY created_at
  `;
  if (localOrders.length === 0) return;
  const claimed = new Set((await db.queryAll<{ broker_order_id: string }>`
    SELECT broker_order_id FROM arena_orders WHERE broker_order_id IS NOT NULL
  `).map((order) => order.broker_order_id));

  for (const local of localOrders) {
    const created = new Date(local.created_at).getTime();
    const candidates = remoteOrders.filter((remote) => {
      if (claimed.has(remote.broker_order_id)) return false;
      if (remote.symbol !== local.symbol || remote.side !== local.side) return false;
      if (remote.as_of) {
        const remoteTime = new Date(remote.as_of).getTime();
        if (Number.isFinite(remoteTime) && remoteTime < created - 120_000) return false;
      }
      const localQuantity = numeric(local.requested_quantity);
      if (remote.requested_quantity !== undefined && localQuantity > 0) {
        const tolerance = Math.max(0.0001, localQuantity * 0.001);
        if (Math.abs(remote.requested_quantity - localQuantity) > tolerance) return false;
      }
      const localAmount = numeric(local.requested_amount);
      if (remote.requested_amount !== undefined && localAmount > 0) {
        if (Math.abs(remote.requested_amount - localAmount) > 0.02) return false;
      }
      return true;
    });
    if (candidates.length !== 1) continue;
    const brokerOrderId = candidates[0].broker_order_id;
    await db.exec`
      UPDATE arena_orders SET broker_order_id = ${brokerOrderId}, updated_at = now()
      WHERE id = ${local.id} AND broker_order_id IS NULL
    `;
    claimed.add(brokerOrderId);
  }
}

async function applyBuyFill(
  order: LocalOrderRow,
  deltaQuantity: number,
  deltaNotional: number,
  deltaPrice: number,
  cumulativeQuantity: number,
  cumulativeNotional: number,
  remote: RobinhoodOrderSnapshot,
): Promise<void> {
  const tx = await db.begin();
  try {
    const locked = await tx.queryRow<LocalOrderRow>`
      SELECT * FROM arena_orders WHERE id = ${order.id} FOR UPDATE
    `;
    if (!locked) throw new Error("local Robinhood order disappeared during reconciliation");
    if (numeric(locked.accounted_quantity) + QUANTITY_EPSILON >= cumulativeQuantity) {
      await tx.rollback();
      return;
    }
    const quote = await tx.queryRow<{ price: string | number }>`
      SELECT price FROM arena_market WHERE symbol = ${order.symbol}
    `;
    const mark = numeric(quote?.price) || deltaPrice;
    const existing = await tx.queryRow<ExecutionPositionRow>`
      SELECT id, agent_id, symbol, quantity, average_entry_price, current_price,
        stop_loss, take_profit
      FROM arena_positions
      WHERE agent_id = ${order.agent_id} AND symbol = ${order.symbol} AND status = 'open'
      FOR UPDATE
    `;
    let positionId: string;
    if (existing) {
      const oldQuantity = numeric(existing.quantity);
      const oldCost = oldQuantity * numeric(existing.average_entry_price);
      const newQuantity = oldQuantity + deltaQuantity;
      const average = (oldCost + deltaNotional) / newQuantity;
      await tx.exec`
        UPDATE arena_positions SET quantity = ${newQuantity}, average_entry_price = ${average},
          current_price = ${mark}, market_value = ${newQuantity * mark},
          unrealized_pnl = ${newQuantity * (mark - average)},
          stop_loss = ${average * (1 - HARD_STOP_PCT / 100)},
          take_profit = ${average * (1 + TAKE_PROFIT_PCT / 100)}, updated_at = now()
        WHERE id = ${existing.id}
      `;
      const trade = await tx.queryRow<{ id: string; quantity: string | number; entry_price: string | number }>`
        SELECT id, quantity, entry_price FROM arena_trades
        WHERE position_id = ${existing.id} AND status = 'open' FOR UPDATE
      `;
      if (trade) {
        const tradeQuantity = numeric(trade.quantity);
        const tradeAverage = (tradeQuantity * numeric(trade.entry_price) + deltaNotional)
          / (tradeQuantity + deltaQuantity);
        await tx.exec`
          UPDATE arena_trades SET quantity = ${tradeQuantity + deltaQuantity},
            entry_price = ${tradeAverage} WHERE id = ${trade.id}
        `;
      } else {
        await tx.exec`
          INSERT INTO arena_trades (agent_id, position_id, symbol, quantity, entry_price, status)
          VALUES (${order.agent_id}, ${existing.id}, ${order.symbol}, ${deltaQuantity}, ${deltaPrice}, 'open')
        `;
      }
      positionId = existing.id;
    } else {
      const created = await tx.queryRow<{ id: string }>`
        INSERT INTO arena_positions (
          agent_id, symbol, quantity, average_entry_price, current_price,
          market_value, unrealized_pnl, stop_loss, take_profit
        ) VALUES (
          ${order.agent_id}, ${order.symbol}, ${deltaQuantity}, ${deltaPrice}, ${mark},
          ${deltaQuantity * mark}, ${deltaQuantity * (mark - deltaPrice)},
          ${deltaPrice * (1 - HARD_STOP_PCT / 100)},
          ${deltaPrice * (1 + TAKE_PROFIT_PCT / 100)}
        ) RETURNING id
      `;
      if (!created) throw new Error("broker fill could not create a local position");
      positionId = created.id;
      await tx.exec`
        INSERT INTO arena_trades (agent_id, position_id, symbol, quantity, entry_price, status)
        VALUES (${order.agent_id}, ${positionId}, ${order.symbol}, ${deltaQuantity}, ${deltaPrice}, 'open')
      `;
    }
    const debited = await tx.queryRow<{ id: string }>`
      UPDATE arena_agents SET cash_balance = cash_balance - ${deltaNotional}, updated_at = now()
      WHERE id = ${order.agent_id} AND cash_balance + 0.02 >= ${deltaNotional}
      RETURNING id
    `;
    if (!debited) throw new Error(`broker fill for ${order.symbol} exceeded its model ledger cash`);
    const terminal = isTerminalOrder(remote.status);
    await tx.exec`
      UPDATE arena_orders SET status = ${remote.status}, filled_quantity = ${remote.filled_quantity},
        average_fill_price = ${remote.average_fill_price ?? null},
        accounted_quantity = ${cumulativeQuantity}, accounted_notional = ${cumulativeNotional},
        position_id = ${positionId}, error_message = NULL,
        reconciled_at = CASE WHEN ${terminal} THEN now() ELSE reconciled_at END
      WHERE id = ${order.id}
    `;
    await tx.exec`
      UPDATE arena_decisions SET executed_notional = ${cumulativeNotional}, approved = true,
        risk_note = ${`Robinhood reported ${rounded(cumulativeQuantity, 6)} shares filled at an average of $${rounded(remote.average_fill_price || deltaPrice, 4)}.`}
      WHERE order_id = ${order.id}
    `;
    await tx.commit();
  } catch (cause) {
    await tx.rollback();
    throw cause;
  }
}

async function applySellFill(
  order: LocalOrderRow,
  deltaQuantity: number,
  deltaNotional: number,
  deltaPrice: number,
  cumulativeQuantity: number,
  cumulativeNotional: number,
  remote: RobinhoodOrderSnapshot,
): Promise<void> {
  const tx = await db.begin();
  try {
    const locked = await tx.queryRow<LocalOrderRow>`
      SELECT * FROM arena_orders WHERE id = ${order.id} FOR UPDATE
    `;
    if (!locked) throw new Error("local Robinhood order disappeared during reconciliation");
    if (numeric(locked.accounted_quantity) + QUANTITY_EPSILON >= cumulativeQuantity) {
      await tx.rollback();
      return;
    }
    const position = await tx.queryRow<ExecutionPositionRow>`
      SELECT id, agent_id, symbol, quantity, average_entry_price, current_price,
        stop_loss, take_profit
      FROM arena_positions
      WHERE id = coalesce(${order.position_id}, id)
        AND agent_id = ${order.agent_id} AND symbol = ${order.symbol} AND status = 'open'
      ORDER BY opened_at LIMIT 1 FOR UPDATE
    `;
    if (!position) throw new Error(`Robinhood sell fill for ${order.symbol} has no model-owned position`);
    const held = numeric(position.quantity);
    if (deltaQuantity > held + QUANTITY_EPSILON) {
      throw new Error(`Robinhood sell fill for ${order.symbol} exceeded the model-owned quantity`);
    }
    const soldQuantity = Math.min(deltaQuantity, held);
    const entry = numeric(position.average_entry_price);
    const realized = (deltaPrice - entry) * soldQuantity;
    const returnPct = entry > 0 ? ((deltaPrice - entry) / entry) * 100 : 0;
    const remaining = Math.max(0, held - soldQuantity);
    const openTrade = await tx.queryRow<{ id: string; quantity: string | number }>`
      SELECT id, quantity FROM arena_trades
      WHERE position_id = ${position.id} AND status = 'open' FOR UPDATE
    `;
    if (remaining <= QUANTITY_EPSILON) {
      await tx.exec`
        UPDATE arena_positions SET status = 'closed', quantity = ${held},
          current_price = ${deltaPrice}, market_value = 0,
          unrealized_pnl = 0, closed_at = now(), updated_at = now()
        WHERE id = ${position.id}
      `;
      if (openTrade) {
        await tx.exec`
          UPDATE arena_trades SET quantity = ${soldQuantity}, status = 'closed',
            exit_price = ${deltaPrice}, realized_pnl = ${realized}, return_pct = ${returnPct},
            closed_at = now(), exit_reason = 'Robinhood broker fill'
          WHERE id = ${openTrade.id}
        `;
      } else {
        await tx.exec`
          INSERT INTO arena_trades (
            agent_id, position_id, symbol, quantity, entry_price, exit_price,
            realized_pnl, return_pct, status, closed_at, exit_reason
          ) VALUES (
            ${order.agent_id}, ${position.id}, ${order.symbol}, ${soldQuantity}, ${entry},
            ${deltaPrice}, ${realized}, ${returnPct}, 'closed', now(), 'Robinhood broker fill'
          )
        `;
      }
    } else {
      await tx.exec`
        UPDATE arena_positions SET quantity = ${remaining},
          market_value = ${remaining * numeric(position.current_price)},
          unrealized_pnl = ${remaining * (numeric(position.current_price) - entry)},
          updated_at = now() WHERE id = ${position.id}
      `;
      if (openTrade) {
        await tx.exec`UPDATE arena_trades SET quantity = ${remaining} WHERE id = ${openTrade.id}`;
      }
      await tx.exec`
        INSERT INTO arena_trades (
          agent_id, position_id, symbol, quantity, entry_price, exit_price,
          realized_pnl, return_pct, status, closed_at, exit_reason
        ) VALUES (
          ${order.agent_id}, ${position.id}, ${order.symbol}, ${soldQuantity}, ${entry},
          ${deltaPrice}, ${realized}, ${returnPct}, 'closed', now(), 'Robinhood partial fill'
        )
      `;
    }
    const win = realized >= 0 ? 1 : 0;
    const loss = realized < 0 ? 1 : 0;
    await tx.exec`
      UPDATE arena_agents SET cash_balance = cash_balance + ${deltaNotional},
        realized_pnl = realized_pnl + ${realized}, total_trades = total_trades + 1,
        winning_trades = winning_trades + ${win}, losing_trades = losing_trades + ${loss},
        win_rate = 100.0 * (winning_trades + ${win}) / greatest(total_trades + 1, 1),
        updated_at = now()
      WHERE id = ${order.agent_id}
    `;
    const terminal = isTerminalOrder(remote.status);
    await tx.exec`
      UPDATE arena_orders SET status = ${remote.status}, filled_quantity = ${remote.filled_quantity},
        average_fill_price = ${remote.average_fill_price ?? null},
        accounted_quantity = ${cumulativeQuantity}, accounted_notional = ${cumulativeNotional},
        position_id = ${position.id}, error_message = NULL,
        reconciled_at = CASE WHEN ${terminal} THEN now() ELSE reconciled_at END
      WHERE id = ${order.id}
    `;
    await tx.exec`
      UPDATE arena_decisions SET executed_notional = ${cumulativeNotional}, approved = true,
        risk_note = ${`Robinhood reported ${rounded(cumulativeQuantity, 6)} shares sold at an average of $${rounded(remote.average_fill_price || deltaPrice, 4)}.`}
      WHERE order_id = ${order.id}
    `;
    await tx.commit();
  } catch (cause) {
    await tx.rollback();
    throw cause;
  }
}

async function reconcileOrder(local: LocalOrderRow, remote: RobinhoodOrderSnapshot): Promise<void> {
  const filled = Math.max(0, remote.filled_quantity);
  const accountedQuantity = numeric(local.accounted_quantity);
  const accountedNotional = numeric(local.accounted_notional);
  await db.exec`
    UPDATE arena_orders SET status = ${remote.status}, filled_quantity = ${filled},
      average_fill_price = ${remote.average_fill_price ?? null}, broker_payload = ${JSON.stringify(remote)}::jsonb,
      error_message = NULL
    WHERE id = ${local.id}
  `;
  const deltaQuantity = filled - accountedQuantity;
  if (deltaQuantity > QUANTITY_EPSILON) {
    const average = remote.average_fill_price;
    if (!average || average <= 0) {
      await db.exec`
        UPDATE arena_orders SET error_message = 'Robinhood reported a fill without an average fill price'
        WHERE id = ${local.id}
      `;
      return;
    }
    const cumulativeNotional = filled * average;
    const deltaNotional = cumulativeNotional - accountedNotional;
    const deltaPrice = deltaNotional / deltaQuantity;
    if (!Number.isFinite(deltaPrice) || deltaPrice <= 0 || deltaNotional <= 0) {
      throw new Error(`Robinhood returned inconsistent fill accounting for ${local.symbol}`);
    }
    if (local.side === "buy") {
      await applyBuyFill(
        local,
        deltaQuantity,
        deltaNotional,
        deltaPrice,
        filled,
        cumulativeNotional,
        remote,
      );
    } else {
      await applySellFill(
        local,
        deltaQuantity,
        deltaNotional,
        deltaPrice,
        filled,
        cumulativeNotional,
        remote,
      );
    }
    return;
  }
  if (isTerminalOrder(remote.status)) {
    await db.exec`
      UPDATE arena_orders SET reconciled_at = now(), error_message = NULL
      WHERE id = ${local.id} AND accounted_quantity + ${QUANTITY_EPSILON} >= filled_quantity
    `;
  }
}

async function reconcileOrders(remoteOrders: RobinhoodOrderSnapshot[]): Promise<void> {
  await linkUnidentifiedOrders(remoteOrders);
  const localOrders = await db.queryAll<LocalOrderRow>`
    SELECT * FROM arena_orders
    WHERE broker_order_id IS NOT NULL AND reconciled_at IS NULL
    ORDER BY created_at
  `;
  const remoteById = new Map(remoteOrders.map((order) => [order.broker_order_id, order]));
  for (const local of localOrders) {
    const remote = remoteById.get(local.broker_order_id || "");
    if (remote) await reconcileOrder(local, remote);
  }
}

async function unmanagedBrokerSymbols(
  brokerPositions: RobinhoodPositionSnapshot[],
): Promise<string[]> {
  const local = await db.queryAll<{ symbol: string; quantity: string | number }>`
    SELECT symbol, sum(quantity) AS quantity
    FROM arena_positions WHERE status = 'open'
    GROUP BY symbol
  `;
  const brokerBySymbol = new Map(brokerPositions.map((position) => [position.symbol, position.quantity]));
  const localBySymbol = new Map(local.map((position) => [position.symbol, numeric(position.quantity)]));
  const symbols = new Set([...brokerBySymbol.keys(), ...localBySymbol.keys()]);
  return [...symbols].filter((symbol) => {
    const brokerQuantity = brokerBySymbol.get(symbol) || 0;
    const localQuantity = localBySymbol.get(symbol) || 0;
    const tolerance = Math.max(0.0001, Math.max(brokerQuantity, localQuantity) * 0.001);
    return Math.abs(brokerQuantity - localQuantity) > tolerance;
  }).sort();
}

interface RoundLifecycleAgent {
  id: string;
  equity: string | number;
  starting_equity: string | number;
}

export async function ensureWeeklyCompetition(): Promise<void> {
  const tx = await db.begin();
  try {
    const state = await tx.queryRow<{
      round_number: number;
      competition_ends_at: Date | string;
      cycle_in_progress: boolean;
      cycle_started_at: Date | string | null;
    }>`
      SELECT round_number, competition_ends_at, cycle_in_progress, cycle_started_at
      FROM arena_state WHERE id = 1 FOR UPDATE
    `;
    if (!state) throw new Error("arena state is missing");
    if (new Date(state.competition_ends_at).getTime() > Date.now()) {
      await tx.commit();
      return;
    }
    if (
      state.cycle_in_progress
      && state.cycle_started_at
      && new Date(state.cycle_started_at).getTime() > Date.now() - 10 * 60 * 1000
    ) {
      await tx.commit();
      return;
    }

    const activeRound = await tx.queryRow<{ id: string }>`
      SELECT id FROM arena_rounds WHERE status = 'active' FOR UPDATE
    `;
    const agents = await tx.queryAll<RoundLifecycleAgent>`
      SELECT agent.id, agent.equity,
        coalesce(result.starting_equity, agent.initial_balance) AS starting_equity
      FROM arena_agents agent
      LEFT JOIN arena_round_results result
        ON result.agent_id = agent.id AND result.round_id = ${activeRound?.id || null}
      ORDER BY agent.id
    `;
    const ranked = agents.map((agent) => {
      const starting = numeric(agent.starting_equity);
      const equity = numeric(agent.equity);
      return {
        ...agent,
        equity,
        returnPct: starting > 0 ? ((equity - starting) / starting) * 100 : 0,
      };
    }).sort((left, right) => right.returnPct - left.returnPct || left.id.localeCompare(right.id));
    const endingCapital = ranked.reduce((total, agent) => total + agent.equity, 0);

    if (activeRound) {
      for (const [index, agent] of ranked.entries()) {
        await tx.exec`
          UPDATE arena_round_results SET
            ending_equity = ${agent.equity},
            return_pct = ${agent.returnPct},
            final_rank = ${index + 1},
            updated_at = now()
          WHERE round_id = ${activeRound.id} AND agent_id = ${agent.id}
        `;
      }
      await tx.exec`
        UPDATE arena_rounds SET
          status = 'completed',
          ending_capital = ${endingCapital},
          winner_agent_id = ${ranked[0]?.id || null},
          winner_return_pct = ${ranked[0]?.returnPct ?? null},
          completed_at = now(),
          updated_at = now()
        WHERE id = ${activeRound.id}
      `;
    }

    const nextRoundNumber = state.round_number + 1;
    const label = `Week ${String(nextRoundNumber).padStart(2, "0")}`;
    const startedAt = new Date();
    const endsAt = new Date(
      startedAt.getTime() + COMPETITION_ROUND_DAYS * 24 * 60 * 60 * 1000,
    );
    const nextRound = await tx.queryRow<{ id: string }>`
      INSERT INTO arena_rounds (
        round_number, label, status, started_at, ends_at, starting_capital
      ) VALUES (
        ${nextRoundNumber}, ${label}, 'active', ${startedAt}, ${endsAt}, ${endingCapital}
      )
      RETURNING id
    `;
    if (!nextRound) throw new Error("the next weekly round could not be created");
    for (const agent of ranked) {
      await tx.exec`
        INSERT INTO arena_round_results (round_id, agent_id, starting_equity)
        VALUES (${nextRound.id}, ${agent.id}, ${agent.equity})
      `;
    }
    await tx.exec`
      INSERT INTO arena_equity_snapshots (agent_id, equity, source, round_id)
      SELECT id, equity, 'robinhood_mcp', ${nextRound.id}
      FROM arena_agents
    `;
    await tx.exec`
      UPDATE arena_state SET
        season = ${label},
        round_number = ${nextRoundNumber},
        cycle_number = 0,
        cycle_in_progress = false,
        cycle_started_at = NULL,
        last_cycle_at = NULL,
        next_cycle_at = now(),
        competition_started_at = ${startedAt},
        competition_ends_at = ${endsAt},
        last_round_at = ${startedAt},
        next_round_at = ${endsAt},
        updated_at = now()
      WHERE id = 1
    `;
    await tx.commit();
  } catch (cause) {
    await tx.rollback();
    throw cause;
  }
}

async function reconcileArenaCapital(account: {
  buying_power: number;
  equity: number;
}): Promise<void> {
  const tx = await db.begin();
  try {
    const state = await tx.queryRow<{
      operator_capital_ceiling: string | number;
      capital_initialized_at: Date | string | null;
    }>`
      SELECT operator_capital_ceiling, capital_initialized_at
      FROM arena_state WHERE id = 1 FOR UPDATE
    `;
    if (!state) throw new Error("arena state is missing");
    const ceiling = numeric(state.operator_capital_ceiling);
    const deployable = rounded(Math.max(0, Math.min(ceiling, account.equity)), 2);
    const allocation = rounded(deployable / 4, 4);
    if (deployable < 4 || allocation < 1) {
      await tx.exec`
        UPDATE arena_state SET
          capital_limit = ${deployable},
          allocation_per_model = ${allocation},
          capital_source = 'robinhood',
          updated_at = now()
        WHERE id = 1
      `;
      await tx.commit();
      throw APIError.failedPrecondition(
        "the Agentic account needs at least $4.00 to maintain four model ledgers",
      );
    }

    await tx.exec`
      UPDATE arena_state SET
        capital_limit = ${deployable},
        allocation_per_model = ${allocation},
        capital_source = 'robinhood',
        capital_initialized_at = coalesce(capital_initialized_at, now()),
        updated_at = now()
      WHERE id = 1
    `;

    if (!state.capital_initialized_at) {
      const activity = await tx.queryRow<{ count: string | number }>`
        SELECT
          (SELECT count(*) FROM arena_orders)
          + (SELECT count(*) FROM arena_trades)
          + (SELECT count(*) FROM arena_positions)
          + (SELECT count(*) FROM arena_decisions) AS count
      `;
      if (numeric(activity?.count) > 0) {
        throw APIError.failedPrecondition(
          "capital cannot be initialized while the arena execution ledger contains activity",
        );
      }
      await tx.exec`
        UPDATE arena_agents SET
          initial_balance = ${allocation},
          cash_balance = ${allocation},
          equity = ${allocation},
          realized_pnl = 0,
          unrealized_pnl = 0,
          max_daily_loss = ${rounded(allocation * 0.05, 4)},
          updated_at = now()
      `;
      const activeRound = await tx.queryRow<{ id: string }>`
        SELECT id FROM arena_rounds WHERE status = 'active' FOR UPDATE
      `;
      if (!activeRound) throw new Error("the active weekly round is missing");
      await tx.exec`
        UPDATE arena_rounds SET starting_capital = ${deployable}, updated_at = now()
        WHERE id = ${activeRound.id}
      `;
      await tx.exec`
        UPDATE arena_round_results result SET
          starting_equity = ${allocation},
          updated_at = now()
        WHERE result.round_id = ${activeRound.id}
      `;
      await tx.exec`
        DELETE FROM arena_equity_snapshots WHERE round_id = ${activeRound.id}
      `;
      await tx.exec`
        INSERT INTO arena_equity_snapshots (agent_id, equity, source, round_id)
        SELECT id, equity, 'robinhood_mcp', ${activeRound.id}
        FROM arena_agents
      `;
    }
    await tx.commit();
  } catch (cause) {
    await tx.rollback();
    throw cause;
  }
}

export async function syncRobinhood(): Promise<BrokerAccountSummary> {
  await claimSync();
  try {
    const client = new RobinhoodMcpClient();
    const [account, brokerPositions, remoteOrders, quotes] = await Promise.all([
      client.getAccountSnapshot(),
      client.getPositions(),
      client.getOrders(),
      client.getQuotes([...ARENA_UNIVERSE]),
    ]);
    await recordQuotes(quotes);
    await reconcileOrders(remoteOrders);
    await markToMarket();
    await reconcileArenaCapital(account);
    const unmanaged = await unmanagedBrokerSymbols(brokerPositions);
    await db.exec`
      UPDATE arena_state SET broker_buying_power = ${account.buying_power},
        broker_equity = ${account.equity}, broker_as_of = ${account.as_of},
        broker_unmanaged_positions = ${unmanaged}, last_robinhood_sync_at = now(),
        robinhood_error = NULL, updated_at = now()
      WHERE id = 1
    `;
    await recordEquitySnapshots();
    const summary = await storedBrokerSummary();
    if (!summary) throw new Error("Robinhood account summary was not persisted");
    return summary;
  } catch (cause) {
    const message = errorText(cause);
    await db.exec`
      UPDATE arena_state SET robinhood_error = ${message}, updated_at = now() WHERE id = 1
    `;
    throw cause;
  } finally {
    await releaseSync();
  }
}

function decisionInput(
  roundNumber: number,
  cycleNumber: number,
  agent: AgentRow,
  market: MarketQuote[],
  positions: ArenaPosition[],
) {
  return {
    round_number: roundNumber,
    cycle_number: cycleNumber,
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
      long_only: true as const,
      risk_per_trade_pct: numeric(agent.risk_per_trade_pct),
      max_position_pct: numeric(agent.max_position_pct),
      min_confidence: numeric(agent.min_confidence),
      max_daily_loss: numeric(agent.max_daily_loss),
      hard_stop_pct: HARD_STOP_PCT,
      take_profit_pct: TAKE_PROFIT_PCT,
    },
    market: market.map((quote) => ({
      symbol: quote.symbol,
      price: quote.price,
      previous_close: quote.previous_close,
      change_pct: quote.change_pct,
      bid: quote.bid,
      ask: quote.ask,
      as_of: quote.as_of,
      source: quote.source,
    })),
  };
}

async function requestModelDecisions(
  roundNumber: number,
  cycleNumber: number,
  agents: AgentRow[],
  market: MarketQuote[],
  positions: ArenaPosition[],
): Promise<ProviderOutcome[]> {
  return Promise.all(agents.map(async (agent): Promise<ProviderOutcome> => {
    try {
      const result = await requestOpenRouterDecision(
        decisionInput(roundNumber, cycleNumber, agent, market, positions),
      );
      return { ok: true, agent, result };
    } catch (cause) {
      const error = cause instanceof OpenRouterRequestError
        ? cause
        : new OpenRouterRequestError(errorText(cause), 0);
      return { ok: false, agent, error };
    }
  }));
}

async function ensureExecutionArmed(): Promise<void> {
  const state = await getArenaState();
  if (!state.live_armed || state.halted || state.status !== "running") {
    throw APIError.failedPrecondition("live Robinhood execution is disarmed");
  }
}

async function createBrokerOrder(input: {
  agentId: string;
  symbol: string;
  side: "buy" | "sell";
  requestedAmount: number;
  requestedQuantity: number;
  positionId?: string;
  emergency?: boolean;
}): Promise<{ id: string; brokerOrderId?: string; status: string }> {
  if (!input.emergency) await ensureExecutionArmed();
  const local = await db.queryRow<{ id: string }>`
    INSERT INTO arena_orders (
      agent_id, symbol, side, status, requested_amount, requested_quantity, position_id
    ) VALUES (
      ${input.agentId}, ${input.symbol}, ${input.side}, 'submitting',
      ${input.requestedAmount}, ${input.requestedQuantity}, ${input.positionId || null}
    ) RETURNING id
  `;
  if (!local) throw APIError.internal("the live order audit record could not be created");
  try {
    const client = new RobinhoodMcpClient();
    const result = await client.placeOrder({
      symbol: input.symbol,
      side: input.side,
      ...(input.side === "buy"
        ? { amount: input.requestedAmount }
        : { quantity: input.requestedQuantity }),
    });
    let brokerOrderId = result.broker_order_id;
    if (!brokerOrderId) {
      const orders = await client.getOrders();
      const candidate = orders.filter((order) => (
        order.symbol === input.symbol
        && order.side === input.side
        && !isTerminalOrder(order.status)
      )).at(-1);
      brokerOrderId = candidate?.broker_order_id;
    }
    await db.exec`
      UPDATE arena_orders SET status = ${result.status}, broker_order_id = ${brokerOrderId || null},
        review_payload = ${JSON.stringify(result.review)}::jsonb,
        broker_payload = ${JSON.stringify(result.payload)}::jsonb,
        error_message = ${brokerOrderId ? null : "Robinhood accepted the order without returning a broker order ID"},
        reconciled_at = CASE WHEN ${isTerminalOrder(result.status) && result.status !== "filled"} THEN now() ELSE NULL END
      WHERE id = ${local.id}
    `;
    return { id: local.id, brokerOrderId, status: result.status };
  } catch (cause) {
    const message = errorText(cause);
    await db.exec`
      UPDATE arena_orders SET status = 'failed', error_message = ${message}, reconciled_at = now()
      WHERE id = ${local.id}
    `;
    throw new Error(message);
  }
}

async function executeBuy(
  agent: AgentRow,
  decision: OpenRouterModelDecision,
  result: OpenRouterDecisionResult,
  roundNumber: number,
): Promise<ModelRoundResult> {
  const [quote, existing, pending, daily, totalExposure, state] = await Promise.all([
    db.queryRow<{ price: string | number }>`SELECT price FROM arena_market WHERE symbol = ${decision.symbol}`,
    db.queryRow<{ id: string }>`
      SELECT id FROM arena_positions
      WHERE agent_id = ${agent.id} AND symbol = ${decision.symbol} AND status = 'open'
    `,
    db.queryRow<{ amount: string | number }>`
      SELECT coalesce(sum(CASE WHEN side = 'buy' THEN requested_amount ELSE 0 END), 0) AS amount
      FROM arena_orders WHERE agent_id = ${agent.id} AND reconciled_at IS NULL
    `,
    db.queryRow<{ pnl: string | number }>`
      SELECT coalesce(sum(realized_pnl), 0) AS pnl FROM arena_trades
      WHERE agent_id = ${agent.id} AND status = 'closed'
        AND closed_at >= date_trunc('day', now())
    `,
    db.queryRow<{ exposure: string | number; pending: string | number }>`
      SELECT
        coalesce((SELECT sum(market_value) FROM arena_positions WHERE status = 'open'), 0) AS exposure,
        coalesce((SELECT sum(requested_amount) FROM arena_orders
          WHERE side = 'buy' AND reconciled_at IS NULL), 0) AS pending
    `,
    getArenaState(),
  ]);
  const audit = providerAudit(result);
  const rejection = async (riskNote: string, proposed = 0): Promise<ModelRoundResult> => {
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      proposedNotional: proposed,
      riskNote,
      audit,
    });
    return {
      agent_id: agent.id,
      model: result.model,
      status: "skipped",
      action: "skip",
      message: riskNote,
    };
  };
  if (!quote) return rejection("Robinhood did not provide a current quote for this symbol.");
  if (existing) return rejection("One open position per model and symbol is enforced.");
  const duplicateOrder = await db.queryRow<{ id: string }>`
    SELECT id FROM arena_orders
    WHERE agent_id = ${agent.id} AND symbol = ${decision.symbol} AND reconciled_at IS NULL
    LIMIT 1
  `;
  if (duplicateOrder) return rejection("A Robinhood order is already pending for this model and symbol.");
  if (state.broker_unmanaged_positions.length > 0) {
    return rejection("Broker holdings differ from the arena ledger. Reconcile them before placing another order.");
  }

  const initial = numeric(agent.initial_balance);
  const equity = numeric(agent.equity);
  const pendingAmount = numeric(pending?.amount);
  const cashAvailable = Math.max(0, numeric(agent.cash_balance) - pendingAmount);
  const requestedNotional = equity * (decision.allocation_pct / 100);
  const maxRisk = initial * (numeric(agent.risk_per_trade_pct) / 100);
  const maxNotionalFromRisk = maxRisk / (HARD_STOP_PCT / 100);
  const positionCap = initial * (numeric(agent.max_position_pct) / 100);
  const globalRemaining = Math.max(
    0,
    numeric(state.capital_limit) - numeric(totalExposure?.exposure) - numeric(totalExposure?.pending),
  );
  const brokerRemaining = Math.max(
    0,
    numeric(state.broker_buying_power) - numeric(totalExposure?.pending),
  );
  const approved = rounded(Math.min(
    requestedNotional,
    maxNotionalFromRisk,
    positionCap,
    cashAvailable,
    globalRemaining,
    brokerRemaining,
  ), 2);
  if (decision.confidence < numeric(agent.min_confidence)) {
    return rejection("Confidence is below the model threshold.", requestedNotional);
  }
  if (numeric(daily?.pnl) <= -numeric(agent.max_daily_loss)) {
    return rejection("The model ledger reached its daily loss limit.", requestedNotional);
  }
  if (approved < MIN_ORDER_AMOUNT) {
    return rejection("The available live risk budget is below Robinhood’s minimum arena order.", requestedNotional);
  }
  const expectedQuantity = approved / numeric(quote.price);
  try {
    const order = await createBrokerOrder({
      agentId: agent.id,
      symbol: decision.symbol,
      side: "buy",
      requestedAmount: approved,
      requestedQuantity: expectedQuantity,
    });
    const capped = approved + 0.01 < requestedNotional;
    const riskNote = capped
      ? `A $${approved.toFixed(2)} live Robinhood order was submitted after the risk cap reduced the request.`
      : `A $${approved.toFixed(2)} live Robinhood order was submitted for broker execution.`;
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "buy",
      confidence: decision.confidence,
      rationale: decision.rationale,
      proposedNotional: requestedNotional,
      approved: true,
      riskNote,
      orderId: order.id,
      audit,
    });
    return {
      agent_id: agent.id,
      model: result.model,
      status: "completed",
      action: "buy",
      order_id: order.id,
      message: riskNote,
    };
  } catch (cause) {
    const message = `Robinhood rejected the live buy: ${errorText(cause)}`;
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      proposedNotional: requestedNotional,
      riskNote: message,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "failed", action: "skip", message };
  }
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
  const audit = providerAudit(result);
  if (!position) {
    const message = "A sell cannot create a short position in this long-only arena.";
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      riskNote: message,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "skipped", action: "skip", message };
  }
  const pending = await db.queryRow<{ id: string }>`
    SELECT id FROM arena_orders
    WHERE agent_id = ${agent.id} AND symbol = ${decision.symbol} AND reconciled_at IS NULL
    LIMIT 1
  `;
  if (pending) {
    const message = "A Robinhood order is already pending for this model and symbol.";
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      riskNote: message,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "skipped", action: "skip", message };
  }
  try {
    const quantity = numeric(position.quantity);
    const order = await createBrokerOrder({
      agentId: agent.id,
      symbol: decision.symbol,
      side: "sell",
      requestedAmount: 0,
      requestedQuantity: quantity,
      positionId: position.id,
    });
    const expected = quantity * numeric(position.current_price);
    const message = `${rounded(quantity, 6)} ${decision.symbol} shares were submitted to Robinhood for sale.`;
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "sell",
      confidence: decision.confidence,
      rationale: decision.rationale,
      proposedNotional: expected,
      approved: true,
      riskNote: message,
      orderId: order.id,
      audit,
    });
    return {
      agent_id: agent.id,
      model: result.model,
      status: "completed",
      action: "sell",
      order_id: order.id,
      message,
    };
  } catch (cause) {
    const message = `Robinhood rejected the live sale: ${errorText(cause)}`;
    await insertDecision({
      roundNumber,
      agentId: agent.id,
      symbol: decision.symbol,
      action: "skip",
      confidence: decision.confidence,
      rationale: decision.rationale,
      riskNote: message,
      audit,
    });
    return { agent_id: agent.id, model: result.model, status: "failed", action: "skip", message };
  }
}

async function executeModelDecision(
  outcome: ProviderSuccess,
  roundNumber: number,
): Promise<ModelRoundResult> {
  const { agent, result } = outcome;
  if (result.decision.action === "buy") return executeBuy(agent, result.decision, result, roundNumber);
  if (result.decision.action === "sell") return executeSell(agent, result.decision, result, roundNumber);
  await insertDecision({
    roundNumber,
    agentId: agent.id,
    symbol: result.decision.symbol,
    action: "hold",
    confidence: result.decision.confidence,
    rationale: result.decision.rationale,
    riskNote: "No Robinhood order was sent. Existing broker stops remain enforced by the arena scheduler.",
    audit: providerAudit(result),
  });
  return {
    agent_id: agent.id,
    model: result.model,
    status: "completed",
    action: "hold",
    message: "The model held its live allocation unchanged.",
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
    rationale: `${outcome.agent.name} did not produce a usable live decision for this round.`,
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

async function enforceHardExits(roundNumber: number): Promise<Set<string>> {
  const exits = await db.queryAll<ExecutionPositionRow>`
    SELECT p.id, p.agent_id, p.symbol, p.quantity, p.average_entry_price,
      p.current_price, p.stop_loss, p.take_profit
    FROM arena_positions p
    WHERE p.status = 'open'
      AND (p.current_price <= p.stop_loss OR p.current_price >= p.take_profit)
      AND NOT EXISTS (
        SELECT 1 FROM arena_orders o
        WHERE o.position_id = p.id AND o.reconciled_at IS NULL
      )
  `;
  const exited = new Set<string>();
  for (const position of exits) {
    const stopHit = numeric(position.current_price) <= numeric(position.stop_loss);
    const reason = stopHit ? "hard stop" : "take profit";
    try {
      const order = await createBrokerOrder({
        agentId: position.agent_id,
        symbol: position.symbol,
        side: "sell",
        requestedAmount: 0,
        requestedQuantity: numeric(position.quantity),
        positionId: position.id,
      });
      await insertDecision({
        roundNumber,
        agentId: position.agent_id,
        symbol: position.symbol,
        action: "sell",
        confidence: 1,
        rationale: `${position.symbol} reached its ${reason}; the risk engine submitted an exit before model inference.`,
        proposedNotional: numeric(position.quantity) * numeric(position.current_price),
        approved: true,
        riskNote: `The live ${reason} exit was submitted to Robinhood.`,
        orderId: order.id,
        audit: { source: "risk_engine", requestedAction: "sell", requestedAllocationPct: 0 },
      });
      exited.add(position.agent_id);
    } catch (cause) {
      await db.exec`
        UPDATE arena_state SET live_armed = false, automation_enabled = false,
          halted = true, status = 'paused', halt_reason = ${`Risk exit failed: ${errorText(cause)}`},
          updated_at = now() WHERE id = 1
      `;
      throw cause;
    }
  }
  return exited;
}

export async function runLiveRound(options?: {
  brokerAlreadySynced?: boolean;
}): Promise<RunRoundResponse> {
  if (!openRouterConfigured()) throw APIError.failedPrecondition("OpenRouterAPIKey is not configured");
  await ensureWeeklyCompetition();
  const claimed = await db.queryRow<{ round_number: number; cycle_number: number }>`
    UPDATE arena_state SET
      cycle_number = cycle_number + 1,
      cycle_in_progress = true,
      cycle_started_at = now(),
      last_cycle_at = now(),
      next_cycle_at = now() + (${DECISION_CYCLE_MINUTES} * interval '1 minute'),
      updated_at = now()
    WHERE id = 1 AND status = 'running' AND live_armed = true AND halted = false
      AND (
        cycle_in_progress = false
        OR cycle_started_at < now() - interval '10 minutes'
      )
    RETURNING round_number, cycle_number
  `;
  if (!claimed) {
    throw APIError.failedPrecondition(
      "the live arena is disarmed, halted, or already running a decision cycle",
    );
  }

  try {
    const broker = options?.brokerAlreadySynced
      ? await storedBrokerSummary()
      : await syncRobinhood();
    if (!broker) {
      throw APIError.failedPrecondition("Robinhood has not supplied a verified account snapshot");
    }
    if (broker.unmanaged_positions.length > 0) {
      throw APIError.failedPrecondition("Robinhood holdings differ from the arena ledger; reconcile before trading");
    }
    const [agents, market, positions] = await Promise.all([
      listAgentRows(),
      listMarket(),
      listPositions(),
    ]);
    const fallbackSymbol = market[0]?.symbol;
    if (!fallbackSymbol || market.length !== ARENA_UNIVERSE.length) {
      throw APIError.failedPrecondition("Robinhood did not return the full verified market universe");
    }
    const exitedAgents = await enforceHardExits(claimed.round_number);
    const roundResults: ModelRoundResult[] = [];
    for (const agent of agents) {
      if (exitedAgents.has(agent.id)) {
        roundResults.push({
          agent_id: agent.id,
          model: agent.openrouter_model,
          status: "skipped",
          action: "sell",
          message: "The risk engine submitted a live exit before model inference.",
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
    const outcomes = await requestModelDecisions(
      claimed.round_number,
      claimed.cycle_number,
      eligible,
      market,
      positions,
    );
    for (const outcome of outcomes) {
      roundResults.push(outcome.ok
        ? await executeModelDecision(outcome, claimed.round_number)
        : await recordProviderFailure(outcome, claimed.round_number, fallbackSymbol));
    }
    try {
      await syncRobinhood();
    } catch {
      // The submitted orders remain in the audit ledger and the next sync retries reconciliation.
    }
    const arena = await buildArena();
    const failed = roundResults.filter((result) => result.status === "failed").length;
    const completed = roundResults.filter((result) => result.status === "completed").length;
    const submitted = roundResults.filter((result) => Boolean(result.order_id)).length;
    const roundMessage = failed > 0
      ? `Cycle ${claimed.cycle_number} of Week ${String(claimed.round_number).padStart(2, "0")} finished with ${completed} decisions, ${submitted} live orders, and ${failed} provider or broker failures.`
      : `Cycle ${claimed.cycle_number} of Week ${String(claimed.round_number).padStart(2, "0")} finished with ${completed} decisions and ${submitted} live Robinhood orders.`;
    return { ...arena, round_message: roundMessage, round_results: roundResults };
  } finally {
    await db.exec`
      UPDATE arena_state SET
        cycle_in_progress = false,
        cycle_started_at = NULL,
        updated_at = now()
      WHERE id = 1
        AND round_number = ${claimed.round_number}
        AND cycle_number = ${claimed.cycle_number}
    `;
  }
}

export async function armLiveArena(automationEnabled: boolean): Promise<BrokerAccountSummary> {
  const broker = await syncRobinhood();
  if (broker.unmanaged_positions.length > 0) {
    throw APIError.failedPrecondition(
      `unmanaged Robinhood positions must be resolved first: ${broker.unmanaged_positions.join(", ")}`,
    );
  }
  const availableCapital = broker.buying_power + broker.managed_exposure;
  if (availableCapital + 0.01 < broker.allocated_capital) {
    throw APIError.failedPrecondition(
      `the Agentic account needs at least $${broker.allocated_capital.toFixed(2)} of buying power plus arena holdings`,
    );
  }
  await db.exec`
    UPDATE arena_state SET live_armed = true, automation_enabled = ${automationEnabled},
      halted = false, halt_reason = NULL, status = 'running', updated_at = now()
    WHERE id = 1
  `;
  await db.exec`UPDATE arena_agents SET status = 'active', updated_at = now()`;
  return broker;
}

export async function disarmLiveArena(): Promise<void> {
  await db.exec`
    UPDATE arena_state SET live_armed = false, automation_enabled = false,
      updated_at = now() WHERE id = 1
  `;
}

export async function cancelLiveOrders(): Promise<number> {
  const client = new RobinhoodMcpClient();
  const count = await client.cancelOpenOrders();
  try {
    await syncRobinhood();
  } catch {
    // Remote cancellation succeeded. A later reconciliation will update local order states.
  }
  return count;
}

export async function haltLiveArena(reason: string, cancelOrders: boolean): Promise<number> {
  await db.exec`
    UPDATE arena_state SET live_armed = false, automation_enabled = false,
      halted = true, status = 'paused', halt_reason = ${reason}, updated_at = now()
    WHERE id = 1
  `;
  await db.exec`UPDATE arena_agents SET status = 'paused', updated_at = now()`;
  return cancelOrders ? cancelLiveOrders() : 0;
}

export async function flattenManagedPositions(): Promise<number> {
  await haltLiveArena("operator emergency flatten", true);
  await syncRobinhood();
  const positions = await db.queryAll<ExecutionPositionRow>`
    SELECT id, agent_id, symbol, quantity, average_entry_price, current_price,
      stop_loss, take_profit
    FROM arena_positions WHERE status = 'open'
    ORDER BY opened_at
  `;
  let submitted = 0;
  for (const position of positions) {
    const pending = await db.queryRow<{ id: string }>`
      SELECT id FROM arena_orders WHERE position_id = ${position.id} AND reconciled_at IS NULL LIMIT 1
    `;
    if (pending) continue;
    const order = await createBrokerOrder({
      agentId: position.agent_id,
      symbol: position.symbol,
      side: "sell",
      requestedAmount: 0,
      requestedQuantity: numeric(position.quantity),
      positionId: position.id,
      emergency: true,
    });
    const state = await getArenaState();
    await insertDecision({
      roundNumber: state.round_number,
      agentId: position.agent_id,
      symbol: position.symbol,
      action: "sell",
      confidence: 1,
      rationale: "The operator requested an emergency flatten of arena-managed Robinhood positions.",
      proposedNotional: numeric(position.quantity) * numeric(position.current_price),
      approved: true,
      riskNote: "The emergency live exit was submitted to Robinhood.",
      orderId: order.id,
      audit: { source: "risk_engine", requestedAction: "sell", requestedAllocationPct: 0 },
    });
    submitted += 1;
  }
  try {
    await syncRobinhood();
  } catch {
    // Pending exits remain visible and are reconciled by the next operator sync.
  }
  return submitted;
}

export async function scheduledLiveRound(): Promise<void> {
  let state = await getArenaState();
  let brokerSynced = false;
  if (state.robinhood_oauth_connected) {
    try {
      await syncRobinhood();
      brokerSynced = true;
    } catch {
      // The state records the sync error. Automated execution waits for a verified snapshot.
    }
  }
  await ensureWeeklyCompetition();
  state = await getArenaState();
  if (!state.live_armed || !state.automation_enabled || state.halted || state.status !== "running") {
    return;
  }
  if (!brokerSynced || !regularMarketSessionOpen()) return;
  if (new Date(state.next_cycle_at).getTime() > Date.now()) return;
  await runLiveRound({ brokerAlreadySynced: true });
}
