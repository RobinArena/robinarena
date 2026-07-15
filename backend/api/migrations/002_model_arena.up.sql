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

INSERT INTO arena_positions (
  agent_id, symbol, quantity, average_entry_price, current_price, market_value,
  unrealized_pnl, stop_loss, take_profit, opened_at
) VALUES
  ('gpt-5-6-sol', 'NVDA', 120, 126.40, 138.71, 16645.20, 1477.20, 120.08, 148.90, now() - interval '8 days'),
  ('gpt-5-6-sol', 'MSFT', 38, 423.80, 441.27, 16768.26, 663.86, 417.20, 465.90, now() - interval '5 days'),
  ('deepseek-v4-pro', 'AMZN', 96, 219.20, 228.64, 21949.44, 906.24, 212.80, 242.10, now() - interval '6 days'),
  ('deepseek-v4-pro', 'META', 29, 594.80, 612.42, 17760.18, 510.98, 579.50, 642.00, now() - interval '4 days'),
  ('claude-fable-5', 'SPY', 35, 591.25, 605.08, 21177.80, 484.05, 583.20, 628.00, now() - interval '9 days'),
  ('claude-fable-5', 'MSFT', 31, 431.20, 441.27, 13679.37, 312.17, 424.10, 459.80, now() - interval '3 days'),
  ('grok-4-5', 'TSLA', 41, 356.70, 342.18, 14029.38, -595.32, 334.90, 392.40, now() - interval '2 days'),
  ('grok-4-5', 'NVDA', 90, 141.15, 138.71, 12483.90, -219.60, 132.40, 157.80, now() - interval '1 day');

INSERT INTO arena_trades (
  agent_id, position_id, symbol, quantity, entry_price, status, opened_at
)
SELECT agent_id, id, symbol, quantity, average_entry_price, 'open', opened_at
FROM arena_positions;

INSERT INTO arena_trades (
  agent_id, symbol, quantity, entry_price, exit_price, realized_pnl,
  return_pct, status, opened_at, closed_at, exit_reason
) VALUES
  ('gpt-5-6-sol', 'META', 22, 568.20, 603.40, 774.40, 6.194999, 'closed', now() - interval '12 days', now() - interval '7 days', 'take profit'),
  ('gpt-5-6-sol', 'AMZN', 70, 215.40, 223.90, 595.00, 3.946147, 'closed', now() - interval '10 days', now() - interval '6 days', 'strategy exit'),
  ('deepseek-v4-pro', 'TSLA', 28, 368.10, 352.40, -439.60, -4.265145, 'closed', now() - interval '9 days', now() - interval '5 days', 'stop loss'),
  ('deepseek-v4-pro', 'NVDA', 88, 127.60, 136.80, 809.60, 7.210031, 'closed', now() - interval '8 days', now() - interval '3 days', 'take profit'),
  ('claude-fable-5', 'META', 19, 578.30, 602.10, 452.20, 4.115511, 'closed', now() - interval '11 days', now() - interval '6 days', 'strategy exit'),
  ('claude-fable-5', 'AMZN', 54, 220.70, 225.20, 243.00, 2.038061, 'closed', now() - interval '7 days', now() - interval '4 days', 'strategy exit'),
  ('grok-4-5', 'TSLA', 35, 332.40, 361.50, 1018.50, 8.754513, 'closed', now() - interval '10 days', now() - interval '8 days', 'take profit'),
  ('grok-4-5', 'META', 21, 617.80, 591.60, -550.20, -4.240855, 'closed', now() - interval '6 days', now() - interval '3 days', 'stop loss');

INSERT INTO arena_orders (agent_id, symbol, side, quantity, fill_price, notional, status, created_at)
SELECT agent_id, symbol, 'buy', quantity, average_entry_price,
  quantity * average_entry_price, 'filled', opened_at
FROM arena_positions;

WITH curves(agent_id, values) AS (
  VALUES
    ('gpt-5-6-sol', ARRAY[
      100000,100640,100210,101180,101940,102360,101880,102740,103510,103220,
      104180,104960,104510,105760,106180,105840,106920,107460,107980,108241.52
    ]::numeric[]),
    ('deepseek-v4-pro', ARRAY[
      100000,99820,100310,100920,100660,101240,101780,101520,102140,102680,
      102350,103040,103620,104180,103940,104520,104980,105340,105720,105860.24
    ]::numeric[]),
    ('claude-fable-5', ARRAY[
      100000,100120,100440,100310,100740,100980,101240,101080,101520,101860,
      102140,102020,102360,102690,102480,102820,103020,103280,103190,103426.95
    ]::numeric[]),
    ('grok-4-5', ARRAY[
      100000,101240,100480,102060,101180,103100,102420,101540,102880,101760,
      100940,102230,101120,100460,99820,100740,99460,98780,98520,98193.88
    ]::numeric[])
)
INSERT INTO arena_equity_snapshots (agent_id, equity, captured_at)
SELECT agent_id, equity,
  now() - (20 - point_number) * interval '12 hours'
FROM curves
CROSS JOIN LATERAL unnest(values) WITH ORDINALITY AS point(equity, point_number);

INSERT INTO arena_decisions (
  round_number, agent_id, symbol, action, confidence, rationale,
  proposed_notional, approved, risk_note, created_at
) VALUES
  (186, 'gpt-5-6-sol', 'NVDA', 'hold', 0.81, 'Trend remains constructive while breadth supports the existing position.', 0, false, 'Existing exposure remains inside the 14% position cap.', now() - interval '2 minutes'),
  (186, 'deepseek-v4-pro', 'AMZN', 'hold', 0.76, 'The reversal is working, but the next entry needs a wider discount.', 0, false, 'Cash reserved until confidence clears the entry threshold.', now() - interval '3 minutes'),
  (186, 'claude-fable-5', 'SPY', 'hold', 0.88, 'The index position still offers the cleanest risk-adjusted exposure.', 0, false, 'Stop remains above the maximum one-trade loss.', now() - interval '4 minutes'),
  (186, 'grok-4-5', 'TSLA', 'hold', 0.69, 'Momentum weakened, though price has not confirmed a full exit.', 0, false, 'Hard stop remains active at 334.90.', now() - interval '5 minutes'),
  (185, 'gpt-5-6-sol', 'MSFT', 'buy', 0.84, 'Stable breadth and improving relative strength supported a second position.', 16104.40, true, 'Filled below the 14% target allocation after sizing.', now() - interval '7 minutes'),
  (185, 'deepseek-v4-pro', 'META', 'buy', 0.73, 'Price reclaimed the short-term mean with volume confirmation.', 17249.20, true, 'Filled with a 5% hard stop and 10% target.', now() - interval '8 minutes'),
  (185, 'claude-fable-5', 'MSFT', 'buy', 0.79, 'The setup met the downside budget with room to the first target.', 13367.20, true, 'Position limited to 10% of starting capital.', now() - interval '9 minutes'),
  (185, 'grok-4-5', 'NVDA', 'buy', 0.74, 'The breakout retest held and momentum turned back up.', 12703.50, true, 'Position sized inside the 16% concentration cap.', now() - interval '10 minutes');
