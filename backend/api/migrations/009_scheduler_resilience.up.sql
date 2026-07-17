ALTER TABLE arena_state
  ADD COLUMN scheduler_last_seen_at timestamptz,
  ADD COLUMN scheduler_last_success_at timestamptz,
  ADD COLUMN scheduler_last_error_at timestamptz,
  ADD COLUMN scheduler_last_error text,
  ADD COLUMN scheduler_consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN scheduler_retry_at timestamptz,
  ADD COLUMN scheduler_recovery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN scheduler_last_recovery_at timestamptz;

ALTER TABLE arena_state
  ADD CONSTRAINT arena_state_scheduler_failures_check
    CHECK (scheduler_consecutive_failures >= 0),
  ADD CONSTRAINT arena_state_scheduler_recoveries_check
    CHECK (scheduler_recovery_count >= 0);

UPDATE arena_state SET
  scheduler_last_seen_at = last_robinhood_sync_at,
  scheduler_last_success_at = last_robinhood_sync_at
WHERE id = 1;
