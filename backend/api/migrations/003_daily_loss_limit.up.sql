ALTER TABLE arena_agents
  ADD COLUMN IF NOT EXISTS max_daily_loss numeric(18, 4) NOT NULL DEFAULT 2500;

UPDATE arena_agents SET max_daily_loss = CASE id
  WHEN 'gpt-5-6-sol' THEN 2500
  WHEN 'deepseek-v4-pro' THEN 2250
  WHEN 'claude-fable-5' THEN 1800
  WHEN 'grok-4-5' THEN 3000
  ELSE max_daily_loss
END;
