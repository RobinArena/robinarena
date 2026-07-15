export type ArenaAction = "buy" | "sell" | "hold" | "skip";
export type ArenaStatus = "running" | "paused";
export type ArenaDecisionSource = "seed" | "openrouter" | "risk_engine";

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
  provider_model?: string;
  provider_request_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms?: number;
  generation_cost?: number;
  created_at: string;
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
  status: ArenaStatus;
  mode: "openrouter";
  starting_capital: number;
  total_equity: number;
  total_pnl: number;
  return_pct: number;
  open_positions: number;
  executed_trades: number;
  last_round_at: string;
  next_round_at: string;
  leader_id: string;
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

export interface ModelRoundResult {
  agent_id: string;
  model: string;
  status: "completed" | "failed" | "skipped";
  action?: ArenaAction;
  message: string;
}

export interface ArenaResponse {
  arena: ArenaSummary;
  models: ArenaModel[];
  market: MarketQuote[];
  equity_series: EquitySeries[];
  positions: ArenaPosition[];
  decisions: ArenaDecision[];
  trades: ArenaTrade[];
  openrouter: OpenRouterIntegration;
  generated_at: string;
}

export interface RunRoundResponse extends ArenaResponse {
  round_message: string;
  round_results: ModelRoundResult[];
}
