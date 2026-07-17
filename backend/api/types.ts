export type ArenaAction = "buy" | "sell" | "hold" | "skip";
export type ArenaStatus = "running" | "paused";
export type ArenaDecisionSource = "openrouter" | "risk_engine";

export interface ArenaModel {
  id: string;
  rank: number;
  name: string;
  provider: string;
  code: string;
  strategy: string;
  thesis: string;
  accent: string;
  status: "active" | "paused";
  openrouter_model: string;
  initial_balance: number;
  round_starting_equity: number;
  cash_balance: number;
  equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  return_pct: number;
  win_rate: number;
  max_drawdown_pct: number;
  total_trades: number;
  open_positions: number;
  risk_per_trade_pct: number;
  max_position_pct: number;
  min_confidence: number;
  max_daily_loss: number;
  last_decision_at?: string;
}

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  previous_close: number;
  change_pct: number;
  bid?: number;
  ask?: number;
  source: "robinhood_mcp";
  as_of: string;
  updated_at: string;
}

export interface EquityPoint {
  captured_at: string;
  equity: number;
  return_pct: number;
}

export interface EquitySeries {
  agent_id: string;
  agent_name: string;
  accent: string;
  points: EquityPoint[];
}

export interface ArenaPosition {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  quantity: number;
  average_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  return_pct: number;
  stop_loss: number;
  take_profit: number;
  opened_at: string;
}

export interface ArenaDecision {
  id: string;
  round_number: number;
  cycle_number: number;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  action: ArenaAction;
  requested_action: ArenaAction;
  confidence: number;
  rationale: string;
  requested_allocation_pct: number;
  proposed_notional: number;
  executed_notional: number;
  approved: boolean;
  risk_note: string;
  source: ArenaDecisionSource;
  order_id?: string;
  provider_model?: string;
  provider_request_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms?: number;
  generation_cost?: number;
  created_at: string;
}

export interface ArenaOrder {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  requested_amount: number;
  requested_quantity: number;
  filled_quantity: number;
  average_fill_price?: number;
  broker_order_id?: string;
  error_message?: string;
  created_at: string;
  reconciled_at?: string;
}

export interface ArenaTrade {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_code: string;
  agent_accent: string;
  symbol: string;
  quantity: number;
  entry_price: number;
  exit_price?: number;
  realized_pnl?: number;
  return_pct?: number;
  status: "open" | "closed";
  opened_at: string;
  closed_at?: string;
  exit_reason?: string;
}

export interface ArenaSummary {
  title: string;
  season: string;
  round_number: number;
  cycle_number: number;
  round_status: "active";
  status: ArenaStatus;
  mode: "live";
  operator_capital_ceiling: number;
  capital_limit: number;
  allocation_per_model: number;
  capital_source: "operator" | "robinhood";
  starting_capital: number;
  total_equity: number;
  total_pnl: number;
  return_pct: number;
  open_positions: number;
  pending_orders: number;
  executed_trades: number;
  live_armed: boolean;
  automation_enabled: boolean;
  halted: boolean;
  round_started_at: string;
  round_ends_at: string;
  round_progress_pct: number;
  cycle_interval_minutes: number;
  market_session_open: boolean;
  last_cycle_at?: string;
  next_cycle_at: string;
  last_round_at: string;
  next_round_at: string;
  last_robinhood_sync_at?: string;
  broker_equity?: number;
  broker_buying_power?: number;
  leader_id: string;
}

export interface ArenaRound {
  id: string;
  round_number: number;
  label: string;
  status: "active" | "completed";
  started_at: string;
  ends_at: string;
  starting_capital: number;
  ending_capital?: number;
  winner_agent_id?: string;
  winner_agent_name?: string;
  winner_return_pct?: number;
}

export interface OpenRouterModelStatus {
  agent_id: string;
  name: string;
  model: string;
  structured_outputs: boolean;
}

export interface OpenRouterIntegration {
  configured: boolean;
  state: "ready" | "missing_key";
  operator_configured: boolean;
  development_operator_key: boolean;
  gateway: "OpenRouter";
  models: OpenRouterModelStatus[];
}

export interface RobinhoodIntegration {
  configured: boolean;
  state: "ready" | "missing_token" | "error";
  gateway: "Robinhood Trading MCP";
  scope: string;
  documentation_url: string;
  authentication: "oauth" | "static_token" | "missing";
  oauth_connected: boolean;
  last_error?: string;
}

export interface ModelRoundResult {
  agent_id: string;
  model: string;
  status: "completed" | "failed" | "skipped";
  action?: ArenaAction;
  order_id?: string;
  message: string;
}

export interface ArenaResponse {
  arena: ArenaSummary;
  models: ArenaModel[];
  round_history: ArenaRound[];
  market: MarketQuote[];
  equity_series: EquitySeries[];
  positions: ArenaPosition[];
  decisions: ArenaDecision[];
  orders: ArenaOrder[];
  trades: ArenaTrade[];
  openrouter: OpenRouterIntegration;
  robinhood: RobinhoodIntegration;
  generated_at: string;
}

export interface RunRoundResponse extends ArenaResponse {
  round_message: string;
  round_results: ModelRoundResult[];
}

export interface BrokerAccountSummary {
  buying_power: number;
  equity: number;
  as_of: string;
  operator_capital_ceiling: number;
  deployable_capital: number;
  allocation_per_model: number;
  capital_source: "operator" | "robinhood";
  allocated_capital: number;
  managed_exposure: number;
  unmanaged_positions: string[];
}

export interface AdminStatusResponse {
  authenticated: true;
  arena: ArenaResponse;
  broker?: BrokerAccountSummary;
  robinhood_oauth: {
    connected: boolean;
    expires_at?: string;
    started_at?: string;
  };
  execution_confirmation: string;
  live_consent_confirmation: string;
  flatten_confirmation: string;
}

export interface RobinhoodConnectResponse {
  authorization_url: string;
}

export interface AdminControlResponse {
  ok: boolean;
  message: string;
  status: AdminStatusResponse;
}
