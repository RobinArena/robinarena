UPDATE arena_decisions
SET risk_note = 'Robinhood requires the account’s investor goals questionnaire before another live order can be placed. Complete it in Robinhood and the next arena cycle can retry.'
WHERE risk_note ILIKE '%investing goals%'
   OR risk_note ILIKE '%investor profile%';
