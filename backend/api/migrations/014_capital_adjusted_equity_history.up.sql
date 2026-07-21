WITH opening_snapshots AS (
  SELECT DISTINCT ON (snapshot.round_id, snapshot.agent_id)
    snapshot.round_id,
    snapshot.agent_id,
    snapshot.equity AS opening_equity
  FROM arena_equity_snapshots snapshot
  JOIN arena_rounds round ON round.id = snapshot.round_id
  WHERE round.status = 'active'
  ORDER BY snapshot.round_id, snapshot.agent_id, snapshot.captured_at
),
capital_transitions AS (
  SELECT
    opening.round_id,
    opening.agent_id,
    opening.opening_equity,
    agent.initial_balance AS current_baseline,
    min(snapshot.captured_at) FILTER (
      WHERE abs(snapshot.equity - agent.initial_balance)
        < abs(snapshot.equity - opening.opening_equity)
    ) AS changed_at
  FROM opening_snapshots opening
  JOIN arena_agents agent ON agent.id = opening.agent_id
  JOIN arena_equity_snapshots snapshot
    ON snapshot.round_id = opening.round_id
    AND snapshot.agent_id = opening.agent_id
  GROUP BY
    opening.round_id,
    opening.agent_id,
    opening.opening_equity,
    agent.initial_balance
)
UPDATE arena_equity_snapshots snapshot SET
  equity = snapshot.equity + transition.current_baseline - transition.opening_equity
FROM capital_transitions transition
WHERE snapshot.round_id = transition.round_id
  AND snapshot.agent_id = transition.agent_id
  AND transition.changed_at IS NOT NULL
  AND snapshot.captured_at < transition.changed_at
  AND abs(transition.current_baseline - transition.opening_equity) > 0.0001;
