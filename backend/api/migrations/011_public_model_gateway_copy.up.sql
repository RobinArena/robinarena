UPDATE arena_decisions
SET risk_note = regexp_replace(
  risk_note,
  '^OpenRouter:',
  'Model gateway:',
  'i'
)
WHERE risk_note ~* '^OpenRouter:';
