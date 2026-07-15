# Model Market

Model Market is an OpenRouter-powered paper trading arena for four language
models. Each competitor starts with an isolated $100K portfolio and receives
the same market replay on every round.

| Competitor | OpenRouter model |
| --- | --- |
| GPT-5.6 Sol | `openai/gpt-5.6-sol` |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` |
| Claude Fable 5 | `anthropic/claude-fable-5` |
| Grok 4.5 | `x-ai/grok-4.5` |

The dashboard includes a multi-model equity chart, leaderboard, shared market
tape, model decision stream, open positions, closed trades, and execution
ledger. Trading is paper-only. OpenRouter provides the model decisions and the
local replay tape provides identical prices to every competitor.

## OpenRouter setup

Store the OpenRouter API key and a private operator key as runtime secrets:

```sh
nstack env set OpenRouterAPIKey
nstack env set ArenaOperatorKey
```

Push the secrets when using a configured deployment target:

```sh
nstack env push
```

`ArenaOperatorKey` protects `POST /arena/round`, which can create four paid
model requests. Send it as `Authorization: Bearer <key>`. Local development has
the operator key `dev-model-market` when `ArenaOperatorKey` is unset. Production
requires an explicit operator key.

The backend sends all four requests concurrently through the OpenRouter chat
completions endpoint. Every request uses one strict JSON schema for action,
symbol, confidence, allocation, and rationale. A model or provider failure is
recorded as a skipped decision for that portfolio while the other results
continue. Decisions retain the routed model, OpenRouter request ID, latency,
token counts, generation cost, requested action, and executed paper notional.

## Trading rules

Each round follows the execution order used by the RobinSharks reference app:

1. Advance one shared market tape and mark every open position at that quote.
2. Apply hard stops and take-profit exits before requesting new model decisions.
3. Ask each model for one long-only action using the same market snapshot.
4. Enforce confidence, cash, daily-loss, risk-per-trade, position-size, and duplicate-position limits.
5. Fill approved paper orders at the shared replay quote.
6. Append decisions, orders, trades, positions, and equity records to PostgreSQL.

The replay uses a 5% hard stop and a 10% target. Every model has its own
confidence threshold, risk budget, and concentration cap.

## Local development

```sh
nstack setup
pnpm dev
pnpm check
```

For one-shot checks under an AI coding harness:

```sh
pnpm devexec 'return await apiJson("/arena")'
pnpm devexec 'return await screenshot("/", { width: 1440, height: 1000 })'
```

The Encore endpoints are:

```text
GET  /arena
POST /arena/round
GET  /integrations/openrouter
GET  /ready
GET  /status
```

## Project structure

`backend/api/openrouter.ts` owns the OpenRouter request, strict response schema,
and model mapping. `backend/api/arena.ts` owns the replay runner, portfolio risk
checks, paper fills, and dashboard response. Migrations under
`backend/api/migrations` create and seed the PostgreSQL ledger. The Nuxt
interface lives under `frontend/app` and calls Encore through the generated
client wrapped by `apiClient()`.

`pnpm check`, `pnpm build`, and `nstack deploy` regenerate
`frontend/app/generated/encore-client.ts` from local Encore metadata.

## Deployment

Configure a Dokploy target, then use the nstack workflow:

```sh
nstack configure --domain <domain> --dokploy-url https://dokploy.example.com --dokploy-api-key <key> --repository https://github.com/acme/robinshark.git
nstack deploy
nstack status
```

Deploy settings live in `.nstack/local.env`. Runtime secrets belong in
`.nstack/secrets.env` and should be managed with `nstack env set`,
`nstack env push`, and `nstack env pull`.
