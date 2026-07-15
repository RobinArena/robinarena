ALTER TABLE arena_state
  ADD COLUMN robinhood_oauth_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN robinhood_oauth_expires_at timestamptz;

CREATE TABLE arena_robinhood_oauth (
  id integer PRIMARY KEY CHECK (id = 1),
  client_id text,
  redirect_uri text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_expires_at timestamptz,
  token_scope text,
  oauth_state_hash text,
  code_verifier_ciphertext text,
  oauth_started_at timestamptz,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
