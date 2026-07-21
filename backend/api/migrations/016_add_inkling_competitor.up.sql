DO $$
DECLARE
  active_round_id uuid;
  equal_allocation numeric(18, 4);
  adjusted_capital numeric(18, 4);
BEGIN
  SELECT round.id INTO active_round_id
  FROM arena_rounds round
  WHERE round.status = 'active'
  FOR UPDATE;

  IF active_round_id IS NULL THEN
    RAISE EXCEPTION 'Inkling competitor migration requires an active round';
  END IF;

  SELECT round(capital_limit / 6, 4) INTO equal_allocation
  FROM arena_state
  WHERE id = 1
  FOR UPDATE;

  adjusted_capital := equal_allocation * 6;

  IF EXISTS (
    SELECT 1
    FROM arena_agents
    WHERE id <> 'inkling'
      AND cash_balance + equal_allocation - initial_balance < 0
  ) THEN
    RAISE EXCEPTION 'Inkling competitor migration cannot preserve an existing agent cash balance';
  END IF;

  UPDATE arena_equity_snapshots snapshot SET
    equity = snapshot.equity + equal_allocation - agent.initial_balance
  FROM arena_agents agent
  WHERE snapshot.round_id = active_round_id
    AND snapshot.agent_id = agent.id
    AND agent.id <> 'inkling';

  UPDATE arena_round_results result SET
    starting_equity = equal_allocation,
    updated_at = now()
  WHERE result.round_id = active_round_id
    AND result.agent_id <> 'inkling';

  UPDATE arena_agents SET
    cash_balance = cash_balance + equal_allocation - initial_balance,
    equity = equity + equal_allocation - initial_balance,
    initial_balance = equal_allocation,
    max_daily_loss = equal_allocation * 0.05,
    updated_at = now()
  WHERE id <> 'inkling';

  INSERT INTO arena_agents (
    id, name, provider, code, strategy, thesis, accent, openrouter_model,
    initial_balance, cash_balance, equity, risk_per_trade_pct,
    max_position_pct, min_confidence, max_daily_loss
  ) VALUES (
    'inkling',
    'Inkling',
    'Thinking Machines',
    'INK',
    'Calibrated generalist',
    'Balances broad market evidence with calibrated confidence before committing capital.',
    '#7897ff',
    'thinkingmachines/inkling',
    equal_allocation,
    equal_allocation,
    equal_allocation,
    0.90,
    40,
    0.68,
    equal_allocation * 0.05
  );

  INSERT INTO arena_round_results (round_id, agent_id, starting_equity)
  VALUES (active_round_id, 'inkling', equal_allocation);

  INSERT INTO arena_equity_snapshots (agent_id, equity, source, round_id)
  VALUES ('inkling', equal_allocation, 'allocation', active_round_id);

  UPDATE arena_state SET
    operator_capital_ceiling = adjusted_capital,
    capital_limit = adjusted_capital,
    allocation_per_model = equal_allocation,
    updated_at = now()
  WHERE id = 1;

  UPDATE arena_rounds SET
    starting_capital = adjusted_capital,
    updated_at = now()
  WHERE id = active_round_id;
END
$$;
