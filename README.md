# RobinArena

RobinArena is a live trading arena for five language models. OpenRouter routes
their decisions, Robinhood Trading MCP supplies account and market data, and a
dedicated Robinhood Agentic account executes approved orders.

The production arena is available at [robinarena.fun](https://robinarena.fun).
Round updates are published at [@RobinArenaFun on X](https://x.com/RobinArenaFun).

Robinhood account capital is divided equally across the five isolated model
ledgers. Deposits adjust each ledger baseline without counting as trading profit.

| Competitor | OpenRouter model |
| --- | --- |
| GPT-5.6 Sol | `openai/gpt-5.6-sol` |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` |
| Claude Fable 5 | `anthropic/claude-fable-5` |
| Grok 4.5 | `x-ai/grok-4.5` |
| Gemini 3.6 Flash | `google/gemini-3.6-flash` |

Competition rounds last seven days and roll automatically. When live execution
and automation are armed, one decision cycle becomes eligible every 60 minutes
throughout the week. A five-minute scheduler reconciles the broker, checks the
weekly boundary, and starts eligible cycles. The models decide whether current
market conditions support an order.

Every scheduler invocation stores a heartbeat. Failed broker or model runs retry
after 5, 10, 20, 40, and at most 60 minutes. A decision cycle left locked for
more than 10 minutes is recovered automatically and made eligible again. Stored
Robinhood OAuth credentials are retried even when an earlier refresh temporarily
marked the account disconnected. Scheduler health is public, while detailed
failure and recovery information stays in `/admin`.

The public dashboard shows the weekly equity chart, leaderboard, Robinhood
quotes, model decisions, positions, orders, closed trades, and broker-backed
capital. A position enters the ledger only after Robinhood reports its fill.

## Execution rules

Each decision cycle follows the RobinArena execution model:

1. Reconcile Robinhood orders and reported fills.
2. Import one shared quote snapshot and mark every open position.
3. Submit hard-stop or take-profit exits before model inference.
4. Ask all five models concurrently for one structured long-only decision. An empty model ledger must request a 20-40% opening position.
5. Enforce confidence, cash, daily loss, risk per trade, position size, broker buying power, and duplicate-position limits.
6. Submit approved orders to Robinhood and reconcile the resulting broker state.
7. Append decisions, orders, trades, positions, and equity snapshots to PostgreSQL.

The arena uses a 5% hard stop and 10% take-profit level. Each model has its own
confidence threshold, risk budget, and concentration cap. Live execution,
automation, halt, cancellation, and flatten controls remain behind the operator
console.

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

Primary endpoints:

```text
GET  /arena
GET  /admin/status
POST /admin/robinhood/connect
POST /admin/sync
POST /admin/arm
POST /admin/disarm
POST /admin/round
POST /admin/halt
POST /admin/cancel
POST /admin/flatten
GET  /ready
GET  /status
```

Authenticated endpoints expect `Authorization: Bearer <ArenaOperatorKey>`.
Manual decision cycles and destructive controls also require their confirmation
phrases.

## Project structure

`backend/api/live-engine.ts` owns Robinhood reconciliation, risk checks, weekly
rounds, model cycles, and live order accounting. `backend/api/openrouter.ts`
owns the model mapping and structured decision contract.
`backend/api/arena-repository.ts` builds the public ledger response. Migrations
under `backend/api/migrations` create the PostgreSQL state.

The Nuxt interface lives under `frontend/app` and calls Encore through the
generated client wrapped by `apiClient()`. `pnpm check`, `pnpm build`, and
`nstack deploy` regenerate that client from local Encore metadata.

## Deployment

Configure a Dokploy target, then use the nstack workflow:

```sh
nstack configure --domain robinarena.fun --dokploy-url https://dokploy.example.com --dokploy-api-key <key> --repository https://github.com/acme/robinshark.git
nstack deploy
nstack status
```

Deploy settings live under `.nstack/`. Runtime secrets stay outside source
control and are managed with `nstack env set`, `nstack env push`, and
`nstack env pull`.

## Security

GitHub Actions scans the complete repository history for committed credentials
and audits production dependencies on every pull request and every push to
`main`. Dependabot checks npm and workflow dependencies weekly.

Keep credentials in `.nstack/secrets.env` or the deployment environment. If a
credential is committed, revoke and replace it immediately before rewriting
Git history. Follow [SECURITY.md](./SECURITY.md) for private vulnerability
reports.

## Credentials

Store runtime credentials with nstack:

```sh
nstack env set OpenRouterAPIKey
nstack env set ArenaOperatorKey
nstack env push
```

`ArenaOperatorKey` is the private password for `/admin`. It is chosen by the
deployer and is separate from the OpenRouter API key and Robinhood OAuth
connection. Local development falls back to `dev-model-market` when the
operator key is unset. Production requires an explicit value.

Connect the dedicated Robinhood Agentic account from `/admin`. OAuth tokens are
encrypted with the operator key before storage. The broker sync reads the
account equity, buying power, positions, orders, and shared quote universe. The
effective arena capital is the lower of verified Robinhood equity and the $100
operator ceiling.
