UPDATE arena_state
SET next_cycle_at = now(),
    scheduler_retry_at = NULL,
    updated_at = now()
WHERE id = 1
  AND live_armed = true
  AND automation_enabled = true;
