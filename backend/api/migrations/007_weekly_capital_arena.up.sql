ALTER TABLE arena_state
  ADD COLUMN operator_capital_ceiling numeric(18, 4) NOT NULL DEFAULT 100,
  ADD COLUMN capital_initialized_at timestamptz,
  ADD COLUMN capital_source text NOT NULL DEFAULT 'operator',
  ADD COLUMN cycle_number integer NOT NULL DEFAULT 0,
  ADD COLUMN cycle_in_progress boolean NOT NULL DEFAULT false,
  ADD COLUMN cycle_started_at timestamptz,
  ADD COLUMN last_cycle_at timestamptz,
  ADD COLUMN next_cycle_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN competition_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN competition_ends_at timestamptz NOT NULL DEFAULT now() + interval '7 days';

ALTER TABLE arena_state
  ADD CONSTRAINT arena_state_operator_capital_ceiling_check
    CHECK (operator_capital_ceiling > 0),
  ADD CONSTRAINT arena_state_capital_source_check
    CHECK (capital_source IN ('operator', 'robinhood')),
  ADD CONSTRAINT arena_state_competition_window_check
    CHECK (competition_ends_at > competition_started_at);

ALTER TABLE arena_decisions
  ADD COLUMN cycle_number integer NOT NULL DEFAULT 0;

CREATE TABLE arena_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_number integer NOT NULL UNIQUE,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed')),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  starting_capital numeric(18, 4) NOT NULL CHECK (starting_capital >= 0),
  ending_capital numeric(18, 4),
  winner_agent_id text REFERENCES arena_agents(id) ON DELETE SET NULL,
  winner_return_pct numeric(12, 6),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > started_at)
);

CREATE UNIQUE INDEX arena_rounds_one_active_idx
  ON arena_rounds (status) WHERE status = 'active';

CREATE TABLE arena_round_results (
  round_id uuid NOT NULL REFERENCES arena_rounds(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  starting_equity numeric(18, 4) NOT NULL CHECK (starting_equity >= 0),
  ending_equity numeric(18, 4),
  return_pct numeric(12, 6),
  final_rank integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, agent_id)
);

ALTER TABLE arena_equity_snapshots
  ADD COLUMN round_id uuid REFERENCES arena_rounds(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM arena_orders)
    OR EXISTS (SELECT 1 FROM arena_trades)
    OR EXISTS (SELECT 1 FROM arena_positions)
    OR EXISTS (SELECT 1 FROM arena_decisions) THEN
    RAISE EXCEPTION 'weekly capital migration requires an empty live execution ledger';
  END IF;
END
$$;

DELETE FROM arena_equity_snapshots;

UPDATE arena_state SET
  season = 'Week 01',
  round_number = 1,
  status = 'running',
  capital_limit = least(100, greatest(coalesce(broker_equity, 100), 0)),
  allocation_per_model = least(100, greatest(coalesce(broker_equity, 100), 0)) / 4,
  operator_capital_ceiling = 100,
  capital_initialized_at = CASE
    WHEN broker_equity IS NOT NULL THEN now()
    ELSE NULL
  END,
  capital_source = CASE
    WHEN broker_equity IS NOT NULL THEN 'robinhood'
    ELSE 'operator'
  END,
  live_armed = false,
  automation_enabled = false,
  halted = false,
  halt_reason = NULL,
  round_in_progress = false,
  round_started_at = NULL,
  cycle_number = 0,
  cycle_in_progress = false,
  cycle_started_at = NULL,
  last_cycle_at = NULL,
  next_cycle_at = now(),
  competition_started_at = now(),
  competition_ends_at = now() + interval '7 days',
  last_round_at = now(),
  next_round_at = now() + interval '7 days',
  updated_at = now()
WHERE id = 1;

UPDATE arena_agents SET
  initial_balance = (SELECT allocation_per_model FROM arena_state WHERE id = 1),
  cash_balance = (SELECT allocation_per_model FROM arena_state WHERE id = 1),
  equity = (SELECT allocation_per_model FROM arena_state WHERE id = 1),
  realized_pnl = 0,
  unrealized_pnl = 0,
  win_rate = 0,
  max_drawdown_pct = 0,
  total_trades = 0,
  winning_trades = 0,
  losing_trades = 0,
  max_daily_loss = (SELECT allocation_per_model * 0.05 FROM arena_state WHERE id = 1),
  last_decision_at = NULL,
  status = 'active',
  updated_at = now();

WITH created AS (
  INSERT INTO arena_rounds (
    round_number, label, status, started_at, ends_at, starting_capital
  )
  SELECT
    round_number, season, 'active', competition_started_at,
    competition_ends_at, capital_limit
  FROM arena_state WHERE id = 1
  RETURNING id
)
INSERT INTO arena_round_results (round_id, agent_id, starting_equity)
SELECT created.id, agent.id, agent.equity
FROM created CROSS JOIN arena_agents agent;

INSERT INTO arena_equity_snapshots (agent_id, equity, source, round_id, captured_at)
SELECT
  agent.id,
  agent.equity,
  'allocation',
  round.id,
  now()
FROM arena_agents agent
CROSS JOIN arena_rounds round
WHERE round.status = 'active';

ALTER TABLE arena_equity_snapshots
  ALTER COLUMN round_id SET NOT NULL;

CREATE INDEX arena_round_results_agent_idx
  ON arena_round_results (agent_id, round_id);
CREATE INDEX arena_equity_snapshots_round_idx
  ON arena_equity_snapshots (round_id, captured_at, agent_id);
