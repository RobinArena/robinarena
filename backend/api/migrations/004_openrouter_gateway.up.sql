ALTER TABLE arena_state DROP CONSTRAINT IF EXISTS arena_state_mode_check;
ALTER TABLE arena_state
  ADD CONSTRAINT arena_state_mode_check CHECK (mode IN ('replay', 'openrouter'));
UPDATE arena_state SET mode = 'openrouter', updated_at = now() WHERE id = 1;
ALTER TABLE arena_state
  ADD COLUMN round_in_progress boolean NOT NULL DEFAULT false,
  ADD COLUMN round_started_at timestamptz;

ALTER TABLE arena_agents ADD COLUMN openrouter_model text;
UPDATE arena_agents SET openrouter_model = CASE id
  WHEN 'gpt-5-6-sol' THEN 'openai/gpt-5.6-sol'
  WHEN 'deepseek-v4-pro' THEN 'deepseek/deepseek-v4-pro'
  WHEN 'claude-fable-5' THEN 'anthropic/claude-fable-5'
  WHEN 'grok-4-5' THEN 'x-ai/grok-4.5'
END;
ALTER TABLE arena_agents ALTER COLUMN openrouter_model SET NOT NULL;
CREATE UNIQUE INDEX arena_agents_openrouter_model_idx ON arena_agents (openrouter_model);

ALTER TABLE arena_decisions
  ADD COLUMN requested_action text CHECK (requested_action IN ('buy', 'sell', 'hold', 'skip')),
  ADD COLUMN requested_allocation_pct numeric(8, 4),
  ADD COLUMN executed_notional numeric(22, 4) NOT NULL DEFAULT 0,
  ADD COLUMN source text NOT NULL DEFAULT 'seed',
  ADD COLUMN provider_model text,
  ADD COLUMN provider_request_id text,
  ADD COLUMN prompt_tokens integer,
  ADD COLUMN completion_tokens integer,
  ADD COLUMN latency_ms integer,
  ADD COLUMN generation_cost numeric(18, 8);

ALTER TABLE arena_decisions
  ADD CONSTRAINT arena_decisions_source_check
  CHECK (source IN ('seed', 'openrouter', 'risk_engine'));

UPDATE arena_decisions SET
  requested_action = action,
  requested_allocation_pct = CASE WHEN action = 'buy' THEN 8 ELSE 0 END,
  executed_notional = CASE WHEN approved THEN proposed_notional ELSE 0 END,
  source = 'seed';
