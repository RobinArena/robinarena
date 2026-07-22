CREATE TABLE wallet_login_challenges (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wallet_login_challenges_expiry_idx ON wallet_login_challenges (expires_at);

CREATE TABLE wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wallet_sessions_owner_idx ON wallet_sessions (owner_user_id);
CREATE INDEX wallet_sessions_expiry_idx ON wallet_sessions (expires_at);

CREATE TABLE trading_subaccounts (
  id UUID PRIMARY KEY,
  owner_user_id TEXT UNIQUE NOT NULL,
  owner_wallet_id TEXT,
  owner_wallet_address TEXT NOT NULL,
  agent_wallet_address TEXT UNIQUE NOT NULL,
  encrypted_agent_private_key TEXT NOT NULL,
  derivation_version INTEGER NOT NULL DEFAULT 2,
  chain_id INTEGER NOT NULL DEFAULT 4663 CHECK (chain_id = 4663),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_settings (
  subaccount_id UUID PRIMARY KEY REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL DEFAULT 'gpt-5-6-sol' REFERENCES arena_agents(id),
  strategy TEXT NOT NULL DEFAULT '',
  agent_status TEXT NOT NULL DEFAULT 'paused' CHECK (agent_status IN ('paused', 'active')),
  execution_mode TEXT NOT NULL DEFAULT 'autonomous' CHECK (execution_mode = 'autonomous'),
  minimum_native_reserve_wei NUMERIC(78, 0) NOT NULL DEFAULT 5000000000000000,
  runner_lease_owner TEXT,
  runner_lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_messages (
  id UUID PRIMARY KEY,
  subaccount_id UUID NOT NULL REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_instructions (
  id UUID PRIMARY KEY,
  subaccount_id UUID NOT NULL REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY,
  subaccount_id UUID NOT NULL REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('user', 'continuous')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  model_provider TEXT NOT NULL DEFAULT 'openrouter',
  model_id TEXT NOT NULL,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE swap_executions (
  id UUID PRIMARY KEY,
  subaccount_id UUID NOT NULL REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  tool_call_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 4663 CHECK (chain_id = 4663),
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in NUMERIC(78, 0) NOT NULL,
  minimum_amount_out NUMERIC(78, 0),
  quoted_amount_out NUMERIC(78, 0),
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'submitted', 'confirmed', 'failed', 'submission_unknown')),
  transaction_hash TEXT,
  approval_transaction_hash TEXT,
  routing TEXT,
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subaccount_id, tool_call_id)
);

CREATE TABLE withdrawal_executions (
  id UUID PRIMARY KEY,
  subaccount_id UUID NOT NULL REFERENCES trading_subaccounts(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 4663 CHECK (chain_id = 4663),
  asset_address TEXT NOT NULL,
  asset_symbol TEXT NOT NULL DEFAULT 'TOKEN',
  asset_decimals INTEGER NOT NULL DEFAULT 18 CHECK (asset_decimals BETWEEN 0 AND 255),
  requested_amount TEXT NOT NULL,
  amount NUMERIC(78, 0),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'submitted', 'confirmed', 'failed', 'submission_unknown')),
  transaction_hash TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subaccount_id, request_id)
);

CREATE INDEX agent_messages_subaccount_created_idx ON agent_messages (subaccount_id, created_at DESC);
CREATE INDEX agent_instructions_subaccount_status_created_idx ON agent_instructions (subaccount_id, status, created_at);
CREATE INDEX agent_runs_subaccount_started_idx ON agent_runs (subaccount_id, started_at DESC);
CREATE INDEX swap_executions_subaccount_created_idx ON swap_executions (subaccount_id, created_at DESC);
CREATE INDEX withdrawal_executions_subaccount_created_idx ON withdrawal_executions (subaccount_id, created_at DESC);
