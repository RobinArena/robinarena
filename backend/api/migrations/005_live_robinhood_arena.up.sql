ALTER TABLE arena_state DROP CONSTRAINT IF EXISTS arena_state_mode_check;
ALTER TABLE arena_state
  ADD COLUMN capital_limit numeric(18, 4) NOT NULL DEFAULT 1000,
  ADD COLUMN allocation_per_model numeric(18, 4) NOT NULL DEFAULT 250,
  ADD COLUMN live_armed boolean NOT NULL DEFAULT false,
  ADD COLUMN automation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN halted boolean NOT NULL DEFAULT false,
  ADD COLUMN halt_reason text,
  ADD COLUMN broker_buying_power numeric(18, 4),
  ADD COLUMN broker_equity numeric(18, 4),
  ADD COLUMN broker_as_of timestamptz,
  ADD COLUMN broker_unmanaged_positions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN last_robinhood_sync_at timestamptz,
  ADD COLUMN robinhood_error text,
  ADD COLUMN robinhood_sync_in_progress boolean NOT NULL DEFAULT false,
  ADD COLUMN robinhood_sync_started_at timestamptz;

ALTER TABLE arena_market
  ADD COLUMN bid numeric(22, 8),
  ADD COLUMN ask numeric(22, 8),
  ADD COLUMN source text,
  ADD COLUMN as_of timestamptz;

ALTER TABLE arena_orders DROP CONSTRAINT IF EXISTS arena_orders_status_check;
ALTER TABLE arena_orders ALTER COLUMN status SET DEFAULT 'submitted';
ALTER TABLE arena_orders
  ADD COLUMN client_order_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN broker_order_id text,
  ADD COLUMN requested_amount numeric(22, 4) NOT NULL DEFAULT 0,
  ADD COLUMN requested_quantity numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN filled_quantity numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN average_fill_price numeric(22, 8),
  ADD COLUMN accounted_quantity numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN accounted_notional numeric(22, 8) NOT NULL DEFAULT 0,
  ADD COLUMN review_payload jsonb,
  ADD COLUMN broker_payload jsonb,
  ADD COLUMN error_message text,
  ADD COLUMN position_id uuid REFERENCES arena_positions(id) ON DELETE SET NULL,
  ADD COLUMN reconciled_at timestamptz;

ALTER TABLE arena_orders
  DROP COLUMN quantity,
  DROP COLUMN fill_price,
  DROP COLUMN notional;

CREATE UNIQUE INDEX arena_orders_client_order_id_idx ON arena_orders (client_order_id);
CREATE UNIQUE INDEX arena_orders_broker_order_id_idx
  ON arena_orders (broker_order_id) WHERE broker_order_id IS NOT NULL;
CREATE INDEX arena_orders_pending_idx
  ON arena_orders (created_at DESC) WHERE reconciled_at IS NULL;

ALTER TABLE arena_decisions
  ADD COLUMN order_id uuid REFERENCES arena_orders(id) ON DELETE SET NULL;

ALTER TABLE arena_equity_snapshots
  ADD COLUMN source text NOT NULL DEFAULT 'allocation';

DELETE FROM arena_decisions;
DELETE FROM arena_trades;
DELETE FROM arena_orders;
DELETE FROM arena_positions;
DELETE FROM arena_equity_snapshots;
DELETE FROM arena_market;

UPDATE arena_state SET
  title = 'Model Market',
  season = 'Live 01',
  round_number = 0,
  status = 'running',
  mode = 'live',
  capital_limit = 1000,
  allocation_per_model = 250,
  live_armed = false,
  automation_enabled = false,
  halted = false,
  halt_reason = NULL,
  broker_buying_power = NULL,
  broker_equity = NULL,
  broker_as_of = NULL,
  broker_unmanaged_positions = '{}',
  last_robinhood_sync_at = NULL,
  robinhood_error = NULL,
  robinhood_sync_in_progress = false,
  robinhood_sync_started_at = NULL,
  round_in_progress = false,
  round_started_at = NULL,
  last_round_at = now(),
  next_round_at = now() + interval '5 minutes',
  updated_at = now()
WHERE id = 1;

ALTER TABLE arena_state
  ADD CONSTRAINT arena_state_mode_check CHECK (mode IN ('live'));

UPDATE arena_agents SET
  initial_balance = 250,
  cash_balance = 250,
  equity = 250,
  realized_pnl = 0,
  unrealized_pnl = 0,
  win_rate = 0,
  max_drawdown_pct = 0,
  total_trades = 0,
  winning_trades = 0,
  losing_trades = 0,
  risk_per_trade_pct = 1,
  max_position_pct = 40,
  max_daily_loss = 20,
  last_decision_at = NULL,
  status = 'active',
  updated_at = now();

INSERT INTO arena_equity_snapshots (agent_id, equity, source, captured_at)
SELECT id, 250, 'allocation', now() FROM arena_agents;

ALTER TABLE arena_market ALTER COLUMN source SET NOT NULL;
ALTER TABLE arena_market ALTER COLUMN as_of SET NOT NULL;
ALTER TABLE arena_market
  ADD CONSTRAINT arena_market_verified_source_check CHECK (source = 'robinhood_mcp');
ALTER TABLE arena_equity_snapshots
  ADD CONSTRAINT arena_equity_verified_source_check CHECK (source IN ('allocation', 'robinhood_mcp'));
ALTER TABLE arena_decisions DROP CONSTRAINT IF EXISTS arena_decisions_source_check;
ALTER TABLE arena_decisions
  ADD CONSTRAINT arena_decisions_source_check CHECK (source IN ('openrouter', 'risk_engine'));
