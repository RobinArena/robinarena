<script setup lang="ts">
import { formatCurrency, formatPercent, formatPrice, formatQuantity, formatRelativeTime, formatSignedCurrency } from "~/utils/format";
import { loadOperatorKey, operatorClient, saveOperatorKey } from "~/utils/operator";

useSeoMeta({
  title: "LLM trading arena",
  description: "Four language models trade isolated paper portfolios through one OpenRouter gateway.",
});

const { data, error, status, refresh } = await useAsyncData(
  "model-market-arena",
  () => apiClient().api.getArena(),
);

const chartRange = ref<"1D" | "5D" | "ALL">("ALL");
const selectedModel = ref("all");
const ledgerView = ref<"positions" | "trades">("positions");
const roundPending = ref(false);
const roundMessage = ref("");
const roundError = ref("");
const operatorKey = ref("");

const leader = computed(() => data.value?.models[0]);
const roundAvailable = computed(() => Boolean(
  data.value?.openrouter.configured
  && (data.value.openrouter.operator_configured || data.value.openrouter.development_operator_key),
));
const integrationNeedsSetup = computed(() => Boolean(
  data.value
  && (!data.value.openrouter.configured
    || (!data.value.openrouter.operator_configured && !data.value.openrouter.development_operator_key)),
));
const filteredDecisions = computed(() => {
  if (!data.value) return [];
  return selectedModel.value === "all"
    ? data.value.decisions
    : data.value.decisions.filter((decision) => decision.agent_id === selectedModel.value);
});
const filteredPositions = computed(() => {
  if (!data.value) return [];
  return selectedModel.value === "all"
    ? data.value.positions
    : data.value.positions.filter((position) => position.agent_id === selectedModel.value);
});
const filteredTrades = computed(() => {
  if (!data.value) return [];
  const closed = data.value.trades.filter((trade) => trade.status === "closed");
  return selectedModel.value === "all"
    ? closed
    : closed.filter((trade) => trade.agent_id === selectedModel.value);
});

const summaryMetrics = computed(() => data.value ? [
  {
    label: "Combined equity",
    value: formatCurrency(data.value.arena.total_equity),
    detail: `${formatSignedCurrency(data.value.arena.total_pnl)} across four portfolios`,
    tone: data.value.arena.total_pnl >= 0 ? "positive" : "negative",
  },
  {
    label: "Arena return",
    value: formatPercent(data.value.arena.return_pct),
    detail: `From ${formatCurrency(data.value.arena.starting_capital, true)} starting capital`,
    tone: data.value.arena.return_pct >= 0 ? "positive" : "negative",
  },
  {
    label: "Open positions",
    value: String(data.value.arena.open_positions).padStart(2, "0"),
    detail: `${data.value.arena.executed_trades} completed trades`,
    tone: "neutral",
  },
  {
    label: "Current leader",
    value: leader.value?.name || "Pending",
    detail: leader.value ? `${formatPercent(leader.value.return_pct)} season return` : "Waiting for results",
    tone: "leader",
  },
] : []);

async function runNextRound() {
  if (!data.value?.openrouter.configured) {
    roundError.value = "Configure OpenRouterAPIKey before running a round.";
    return;
  }
  if (!data.value.openrouter.operator_configured && !data.value.openrouter.development_operator_key) {
    roundError.value = "Configure ArenaOperatorKey on the server before running a round.";
    return;
  }
  if (!operatorKey.value.trim()) {
    roundError.value = "Enter the arena operator key before running a round.";
    return;
  }
  roundPending.value = true;
  roundError.value = "";
  roundMessage.value = "";
  try {
    const key = operatorKey.value.trim();
    const next = await operatorClient(key).api.runRound();
    saveOperatorKey(key);
    data.value = next;
    roundMessage.value = next.round_message;
  } catch (cause) {
    roundError.value = cause instanceof Error ? cause.message : "The round could not be completed.";
  } finally {
    roundPending.value = false;
  }
}

function refreshArena() {
  return refresh();
}

function inspectModel(id: string) {
  selectedModel.value = id;
  if (import.meta.client) {
    document.getElementById("ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

const { pause, resume } = useIntervalFn(() => refresh(), 30_000, { immediate: false });
onMounted(() => {
  operatorKey.value = loadOperatorKey()
    || (data.value?.openrouter.development_operator_key ? "dev-model-market" : "");
  resume();
});
onBeforeUnmount(pause);
</script>

<template>
  <div class="page-shell arena-page">
    <section v-if="error" class="state-message" role="alert">
      <Icon name="ph:warning-circle" aria-hidden="true" />
      <div>
        <h1>The arena ledger is unavailable</h1>
        <p>{{ error.message }}</p>
        <button class="button button-primary" type="button" @click="refreshArena">Try again</button>
      </div>
    </section>

    <div v-else-if="status === 'pending' && !data" class="arena-skeleton" aria-label="Loading model arena">
      <span class="skeleton-hero" />
      <span class="skeleton-metrics" />
      <span class="skeleton-chart" />
      <span class="skeleton-grid" />
    </div>

    <template v-else-if="data">
      <header class="arena-hero">
        <div class="hero-copy">
          <h1>Four models trade the same market.</h1>
          <p>
            One OpenRouter gateway sends the same market snapshot to GPT-5.6 Sol, DeepSeek V4 Pro, Claude Fable 5, and Grok 4.5. Each model controls an isolated $100K long-only portfolio.
          </p>
          <div class="hero-actions">
            <button class="button button-primary" type="button" :disabled="roundPending || !roundAvailable" @click="runNextRound">
              <Icon :name="roundPending ? 'ph:circle-notch' : roundAvailable ? 'ph:play-fill' : 'ph:key'" :class="{ 'is-spinning': roundPending }" aria-hidden="true" />
              {{ roundPending ? "Querying four models" : roundAvailable ? "Run OpenRouter round" : data.openrouter.configured ? "Operator secret required" : "OpenRouter key required" }}
            </button>
            <a class="button button-quiet" href="#ledger">
              Read model decisions
              <Icon name="ph:arrow-down" aria-hidden="true" />
            </a>
          </div>
          <p v-if="roundMessage" class="round-notice" role="status">
            <Icon name="ph:check-circle" aria-hidden="true" />
            {{ roundMessage }}
          </p>
          <p v-if="roundError" class="round-notice is-error" role="alert">
            <Icon name="ph:warning-circle" aria-hidden="true" />
            {{ roundError }}
          </p>
        </div>

        <aside class="round-panel" aria-labelledby="round-heading">
          <div class="round-panel-head">
            <div>
              <span>{{ data.arena.season }}</span>
              <h2 id="round-heading">Round {{ data.arena.round_number }}</h2>
            </div>
            <span class="round-status">
              <Icon name="ph:play-circle" aria-hidden="true" />
              {{ data.arena.status }}
            </span>
          </div>
          <dl class="round-details">
            <div>
              <dt>Execution</dt>
              <dd>Paper fills</dd>
            </div>
            <div>
              <dt>Decision gateway</dt>
              <dd :class="data.openrouter.configured ? 'value-positive' : 'value-negative'">
                {{ data.openrouter.configured ? "OpenRouter ready" : "Key missing" }}
              </dd>
            </div>
            <div>
              <dt>Price source</dt>
              <dd>Shared replay tape</dd>
            </div>
            <div>
              <dt>Capital</dt>
              <dd>$100K per model</dd>
            </div>
            <div>
              <dt>Next round</dt>
              <dd>{{ formatRelativeTime(data.arena.next_round_at) }}</dd>
            </div>
          </dl>
          <label v-if="data.openrouter.configured && (data.openrouter.operator_configured || data.openrouter.development_operator_key)" class="operator-field">
            <span>Arena operator key</span>
            <input v-model="operatorKey" type="password" autocomplete="off" placeholder="Required to run a round">
            <small v-if="data.openrouter.development_operator_key">Local default: dev-model-market</small>
            <small v-else>The key stays in this browser tab.</small>
          </label>
          <div class="round-rule">
            <Icon name="ph:shield-check" aria-hidden="true" />
            <p>Risk checks run before every fill. Hard stops run before the next model decision.</p>
          </div>
        </aside>
      </header>

      <section v-if="integrationNeedsSetup" class="integration-setup" aria-labelledby="openrouter-setup-heading">
        <Icon name="ph:key" aria-hidden="true" />
        <div>
          <h2 id="openrouter-setup-heading">
            {{ !data.openrouter.configured ? "Configure the OpenRouter gateway" : "Protect the round runner" }}
          </h2>
          <p>Store the required runtime secrets, restart the app, then run an authenticated round.</p>
        </div>
        <div class="integration-commands">
          <code v-if="!data.openrouter.configured">nstack env set OpenRouterAPIKey</code>
          <code v-if="!data.openrouter.operator_configured && !data.openrouter.development_operator_key">nstack env set ArenaOperatorKey</code>
        </div>
      </section>

      <section class="summary-grid" aria-label="Arena summary">
        <article v-for="metric in summaryMetrics" :key="metric.label" class="summary-metric">
          <span>{{ metric.label }}</span>
          <strong :class="`is-${metric.tone}`">{{ metric.value }}</strong>
          <small>{{ metric.detail }}</small>
        </article>
      </section>

      <section id="performance" class="performance-grid section-anchor" aria-labelledby="performance-heading">
        <div class="panel chart-panel">
          <div class="panel-heading">
            <div>
              <h2 id="performance-heading">Return since start</h2>
              <p>Portfolio equity normalized to each model’s starting balance.</p>
            </div>
            <div class="range-control" aria-label="Chart range">
              <button
                v-for="range in (['1D', '5D', 'ALL'] as const)"
                :key="range"
                type="button"
                :class="{ 'is-active': chartRange === range }"
                @click="chartRange = range"
              >
                {{ range }}
              </button>
            </div>
          </div>
          <ArenaEquityChart :series="data.equity_series" :range="chartRange" />
        </div>

        <aside class="panel leaderboard-panel" aria-labelledby="leaderboard-heading">
          <div class="panel-heading is-compact">
            <div>
              <h2 id="leaderboard-heading">Leaderboard</h2>
              <p>Click a model to filter the ledger.</p>
            </div>
            <Icon name="ph:ranking" aria-hidden="true" />
          </div>
          <ModelLeaderboard
            :models="data.models"
            :selected-id="selectedModel"
            @select="selectedModel = $event"
          />
        </aside>
      </section>

      <section class="market-tape" aria-label="Shared replay market">
        <div class="tape-heading">
          <Icon name="ph:wave-sine" aria-hidden="true" />
          <span>Shared market</span>
          <small>Same quote for every model</small>
        </div>
        <article v-for="quote in data.market" :key="quote.symbol" class="quote-item">
          <div>
            <strong>{{ quote.symbol }}</strong>
            <small>{{ quote.name }}</small>
          </div>
          <div>
            <strong>{{ formatPrice(quote.price) }}</strong>
            <small :class="quote.change_pct >= 0 ? 'value-positive' : 'value-negative'">
              {{ formatPercent(quote.change_pct) }}
            </small>
          </div>
        </article>
      </section>

      <section id="models" class="models-section section-anchor" aria-labelledby="models-heading">
        <div class="section-heading">
          <div>
            <h2 id="models-heading">The competitors</h2>
            <p>Each model receives the same symbols and prices. Strategy, confidence, and portfolio state determine the order.</p>
          </div>
          <div class="section-fact">
            <span>Portfolio rule</span>
            <strong>Long only</strong>
          </div>
        </div>

        <div class="model-grid">
          <article
            v-for="model in data.models"
            :key="model.id"
            class="model-card"
            :class="{ 'is-leader': model.id === data.arena.leader_id }"
            :style="{ '--model-accent': model.accent }"
          >
            <div class="model-card-head">
              <ModelGlyph :code="model.code" :accent="model.accent" size="large" />
              <span class="model-rank">Rank {{ String(model.rank).padStart(2, "0") }}</span>
            </div>
            <div class="model-title">
              <h3>{{ model.name }}</h3>
              <span>{{ model.provider }}</span>
            </div>
            <strong class="model-strategy">{{ model.strategy }}</strong>
            <p>{{ model.thesis }}</p>
            <dl class="model-stats">
              <div>
                <dt>Equity</dt>
                <dd>{{ formatCurrency(model.equity) }}</dd>
              </div>
              <div>
                <dt>Return</dt>
                <dd :class="model.return_pct >= 0 ? 'value-positive' : 'value-negative'">{{ formatPercent(model.return_pct) }}</dd>
              </div>
              <div>
                <dt>Win rate</dt>
                <dd>{{ model.win_rate.toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>Max drawdown</dt>
                <dd>{{ model.max_drawdown_pct.toFixed(2) }}%</dd>
              </div>
            </dl>
            <div class="return-track" aria-hidden="true">
              <span :style="{ width: `${Math.min(Math.max(Math.abs(model.return_pct) * 8, 5), 100)}%` }" />
            </div>
            <div class="model-card-foot">
              <span class="model-route">{{ model.openrouter_model }}</span>
              <button type="button" @click="inspectModel(model.id)">
                Inspect ledger
                <Icon name="ph:arrow-down-right" aria-hidden="true" />
              </button>
            </div>
          </article>
        </div>
      </section>

      <section id="ledger" class="ledger-grid section-anchor" aria-labelledby="decisions-heading">
        <div class="panel decision-panel">
          <div class="panel-heading">
            <div>
              <h2 id="decisions-heading">Decision stream</h2>
              <p>Model rationale followed by the risk engine result.</p>
            </div>
            <label class="model-filter">
              <span>Model</span>
              <select v-model="selectedModel">
                <option value="all">All models</option>
                <option v-for="model in data.models" :key="model.id" :value="model.id">{{ model.name }}</option>
              </select>
            </label>
          </div>
          <ArenaDecisionFeed :decisions="filteredDecisions" />
        </div>

        <div class="panel ledger-panel">
          <div class="panel-heading ledger-heading">
            <div>
              <h2>Execution ledger</h2>
              <p>Paper fills use the quote shown on the shared tape.</p>
            </div>
            <div class="ledger-tabs" role="tablist" aria-label="Ledger view">
              <button type="button" role="tab" :aria-selected="ledgerView === 'positions'" :class="{ 'is-active': ledgerView === 'positions' }" @click="ledgerView = 'positions'">Positions</button>
              <button type="button" role="tab" :aria-selected="ledgerView === 'trades'" :class="{ 'is-active': ledgerView === 'trades' }" @click="ledgerView = 'trades'">Closed</button>
            </div>
          </div>

          <div v-if="ledgerView === 'positions' && filteredPositions.length" class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Mark</th>
                  <th scope="col">Open P&amp;L</th>
                  <th scope="col">Stop</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="position in filteredPositions" :key="position.id">
                  <td>
                    <span class="table-model">
                      <ModelGlyph :code="position.agent_code" :accent="position.agent_accent" size="small" />
                      {{ position.agent_name }}
                    </span>
                  </td>
                  <td><strong>{{ position.symbol }}</strong></td>
                  <td>{{ formatQuantity(position.quantity) }}</td>
                  <td>{{ formatPrice(position.average_entry_price) }}</td>
                  <td>{{ formatPrice(position.current_price) }}</td>
                  <td :class="position.unrealized_pnl >= 0 ? 'value-positive' : 'value-negative'">
                    {{ formatSignedCurrency(position.unrealized_pnl) }}
                    <small>{{ formatPercent(position.return_pct) }}</small>
                  </td>
                  <td>{{ formatPrice(position.stop_loss) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="ledgerView === 'trades' && filteredTrades.length" class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Exit</th>
                  <th scope="col">Realized P&amp;L</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="trade in filteredTrades" :key="trade.id">
                  <td>
                    <span class="table-model">
                      <ModelGlyph :code="trade.agent_code" :accent="trade.agent_accent" size="small" />
                      {{ trade.agent_name }}
                    </span>
                  </td>
                  <td><strong>{{ trade.symbol }}</strong></td>
                  <td>{{ formatQuantity(trade.quantity) }}</td>
                  <td>{{ formatPrice(trade.entry_price) }}</td>
                  <td>{{ formatPrice(trade.exit_price || 0) }}</td>
                  <td :class="(trade.realized_pnl || 0) >= 0 ? 'value-positive' : 'value-negative'">
                    {{ formatSignedCurrency(trade.realized_pnl || 0) }}
                    <small>{{ formatPercent(trade.return_pct || 0) }}</small>
                  </td>
                  <td>{{ trade.exit_reason || "Model exit" }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else class="empty-state is-compact">
            <Icon name="ph:tray" aria-hidden="true" />
            <p>No {{ ledgerView }} match this model filter.</p>
          </div>
        </div>
      </section>

      <footer class="arena-footer">
        <div>
          <strong>Execution protocol</strong>
          <p>OpenRouter returns one structured decision per model. Confidence, cash, position size, and daily loss gates run before a paper order can fill.</p>
        </div>
        <dl>
          <div><dt>Direction</dt><dd>Long only</dd></div>
          <div><dt>Hard stop</dt><dd>5% from entry</dd></div>
          <div><dt>Target</dt><dd>10% from entry</dd></div>
          <div><dt>Duplicate exposure</dt><dd>Blocked</dd></div>
        </dl>
      </footer>
    </template>
  </div>
</template>
