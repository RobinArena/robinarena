CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE arena_state (
  id integer PRIMARY KEY CHECK (id = 1),
  title text NOT NULL,
  season text NOT NULL,
  round_number integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused')),
  mode text NOT NULL DEFAULT 'replay' CHECK (mode = 'replay'),
  last_round_at timestamptz NOT NULL DEFAULT now(),
  next_round_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  provider text NOT NULL,
  code text NOT NULL UNIQUE,
  strategy text NOT NULL,
  thesis text NOT NULL,
  accent text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  initial_balance numeric(18, 4) NOT NULL CHECK (initial_balance > 0),
  cash_balance numeric(18, 4) NOT NULL CHECK (cash_balance >= 0),
  equity numeric(18, 4) NOT NULL CHECK (equity >= 0),
  realized_pnl numeric(18, 4) NOT NULL DEFAULT 0,
  unrealized_pnl numeric(18, 4) NOT NULL DEFAULT 0,
  win_rate numeric(10, 4) NOT NULL DEFAULT 0,
  max_drawdown_pct numeric(10, 4) NOT NULL DEFAULT 0,
  total_trades integer NOT NULL DEFAULT 0,
  winning_trades integer NOT NULL DEFAULT 0,
  losing_trades integer NOT NULL DEFAULT 0,
  risk_per_trade_pct numeric(8, 4) NOT NULL DEFAULT 1,
  max_position_pct numeric(8, 4) NOT NULL DEFAULT 12,
  min_confidence numeric(8, 4) NOT NULL DEFAULT 0.65,
  last_decision_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_market (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  price numeric(22, 8) NOT NULL CHECK (price > 0),
  previous_close numeric(22, 8) NOT NULL CHECK (previous_close > 0),
  change_pct numeric(12, 6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES arena_market(symbol),
  quantity numeric(24, 8) NOT NULL CHECK (quantity > 0),
  average_entry_price numeric(22, 8) NOT NULL CHECK (average_entry_price > 0),
  current_price numeric(22, 8) NOT NULL CHECK (current_price > 0),
  market_value numeric(22, 4) NOT NULL,
  unrealized_pnl numeric(22, 4) NOT NULL DEFAULT 0,
  stop_loss numeric(22, 8) NOT NULL,
  take_profit numeric(22, 8) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX arena_positions_one_open_symbol_idx
  ON arena_positions (agent_id, symbol) WHERE status = 'open';
CREATE INDEX arena_positions_agent_status_idx
  ON arena_positions (agent_id, status);

CREATE TABLE arena_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES arena_market(symbol),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity numeric(24, 8) NOT NULL CHECK (quantity > 0),
  fill_price numeric(22, 8) NOT NULL CHECK (fill_price > 0),
  notional numeric(22, 4) NOT NULL CHECK (notional > 0),
  status text NOT NULL DEFAULT 'filled' CHECK (status IN ('filled', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  position_id uuid REFERENCES arena_positions(id) ON DELETE SET NULL,
  symbol text NOT NULL REFERENCES arena_market(symbol),
  quantity numeric(24, 8) NOT NULL CHECK (quantity > 0),
  entry_price numeric(22, 8) NOT NULL CHECK (entry_price > 0),
  exit_price numeric(22, 8),
  realized_pnl numeric(22, 4),
  return_pct numeric(12, 6),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  exit_reason text
);

CREATE INDEX arena_trades_agent_time_idx
  ON arena_trades (agent_id, opened_at DESC);

CREATE TABLE arena_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_number integer NOT NULL,
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES arena_market(symbol),
  action text NOT NULL CHECK (action IN ('buy', 'sell', 'hold', 'skip')),
  confidence numeric(8, 6) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  rationale text NOT NULL,
  proposed_notional numeric(22, 4) NOT NULL DEFAULT 0,
  approved boolean NOT NULL DEFAULT false,
  risk_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX arena_decisions_round_time_idx
  ON arena_decisions (round_number DESC, created_at DESC);

CREATE TABLE arena_equity_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  equity numeric(22, 4) NOT NULL CHECK (equity >= 0),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX arena_equity_agent_time_idx
  ON arena_equity_snapshots (agent_id, captured_at ASC);

INSERT INTO arena_state (
  id, title, season, round_number, status, mode, last_round_at, next_round_at
) VALUES (
  1, 'Model Market', 'Season 01', 186, 'running', 'replay',
  now() - interval '2 minutes', now() + interval '3 minutes'
);

INSERT INTO arena_agents (
  id, name, provider, code, strategy, thesis, accent, initial_balance,
  cash_balance, equity, realized_pnl, unrealized_pnl, win_rate,
  max_drawdown_pct, total_trades, winning_trades, losing_trades,
  risk_per_trade_pct, max_position_pct, min_confidence, last_decision_at
) VALUES
  (
    'gpt-5-6-sol', 'GPT-5.6 Sol', 'OpenAI', 'SOL', 'Regime adaptive',
    'Shifts between momentum and defense as breadth, volatility, and trend quality change.',
    '#d9ff63', 100000, 74828.0600, 108241.5200, 6100.4600, 2141.0600,
    68.4, 2.14, 38, 26, 12, 0.85, 14, 0.68, now() - interval '2 minutes'
  ),
  (
    'deepseek-v4-pro', 'DeepSeek V4 Pro', 'DeepSeek', 'DS4', 'Mean reversion',
    'Finds liquid dislocations, then waits for price and volume to confirm the reversal.',
    '#65b8ff', 100000, 66150.6200, 105860.2400, 4443.0200, 1417.2200,
    63.6, 2.86, 33, 21, 12, 0.75, 12, 0.66, now() - interval '3 minutes'
  ),
  (
    'claude-fable-5', 'Claude Fable 5', 'Anthropic', 'FAB', 'Risk first',
    'Prefers clean setups with measured downside and keeps more capital uncommitted.',
    '#ff9b73', 100000, 68569.7800, 103426.9500, 2630.7300, 796.2200,
    71.4, 1.48, 28, 20, 8, 0.60, 10, 0.72, now() - interval '4 minutes'
  ),
  (
    'grok-4-5', 'Grok 4.5', 'xAI', 'X45', 'Fast momentum',
    'Takes concentrated continuation trades and accepts wider short-term variance.',
    '#be8cff', 100000, 71680.6000, 98193.8800, -991.2000, -814.9200,
    52.9, 6.72, 34, 18, 16, 1.10, 16, 0.64, now() - interval '5 minutes'
  );

INSERT INTO arena_market (symbol, name, price, previous_close, change_pct, updated_at) VALUES
  ('NVDA', 'NVIDIA', 138.71000000, 136.62000000, 1.529791, now()),
  ('TSLA', 'Tesla', 342.18000000, 347.44000000, -1.513931, now()),
  ('MSFT', 'Microsoft', 441.27000000, 439.09000000, 0.496480, now()),
  ('AMZN', 'Amazon', 228.64000000, 226.89000000, 0.771299, now()),
  ('META', 'Meta', 612.42000000, 607.33000000, 0.838096, now()),
  ('SPY', 'S&P 500 ETF', 605.08000000, 603.94000000, 0.188760, now());
