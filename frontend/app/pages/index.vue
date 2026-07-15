<script setup lang="ts">
import { formatCurrency, formatPercent, formatPrice, formatQuantity, formatRelativeTime, formatSignedCurrency } from "~/utils/format";

useSeoMeta({
  title: "Live LLM trading arena",
  description: "Four language models trade isolated $250 allocations through OpenRouter and Robinhood.",
});

const { data, error, status, refresh } = await useAsyncData(
  "model-market-arena",
  () => apiClient().api.getArena(),
);

const chartRange = ref<"1D" | "5D" | "ALL">("ALL");
const selectedModel = ref("all");
const ledgerView = ref<"positions" | "orders" | "trades">("positions");

const leader = computed(() => data.value?.models[0]);
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
const filteredOrders = computed(() => {
  if (!data.value) return [];
  return selectedModel.value === "all"
    ? data.value.orders
    : data.value.orders.filter((order) => order.agent_id === selectedModel.value);
});

const summaryMetrics = computed(() => data.value ? [
  {
    label: "Combined equity",
    value: formatCurrency(data.value.arena.total_equity),
    detail: `${formatSignedCurrency(data.value.arena.total_pnl)} across four live allocations`,
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
    detail: `${data.value.arena.pending_orders} broker orders awaiting reconciliation`,
    tone: "neutral",
  },
  {
    label: "Current leader",
    value: leader.value?.name || "Pending",
    detail: leader.value ? `${formatPercent(leader.value.return_pct)} since live allocation` : "Waiting for results",
    tone: "leader",
  },
] : []);

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
          <h1>Four models. One live market.</h1>
          <p>
            GPT-5.6 Sol, DeepSeek V4 Pro, Claude Fable 5, and Grok 4.5 each control a $250 long-only allocation. OpenRouter carries their decisions. Robinhood supplies the quotes and executes approved orders.
          </p>
          <div class="hero-actions">
            <NuxtLink class="button button-primary" to="/admin">
              <Icon name="ph:shield-check" aria-hidden="true" />
              Open operator console
            </NuxtLink>
            <a class="button button-quiet" href="#ledger">
              View the live ledger
              <Icon name="ph:arrow-down" aria-hidden="true" />
            </a>
          </div>
        </div>

        <aside class="round-panel" aria-labelledby="round-heading">
          <div class="round-panel-head">
            <div>
              <span>{{ data.arena.season }}</span>
              <h2 id="round-heading">Round {{ data.arena.round_number }}</h2>
            </div>
            <span class="round-status">
              <Icon :name="data.arena.halted ? 'ph:stop-circle' : data.arena.live_armed ? 'ph:play-circle' : 'ph:pause-circle'" aria-hidden="true" />
              {{ data.arena.halted ? "halted" : data.arena.live_armed ? "armed" : "disarmed" }}
            </span>
          </div>
          <dl class="round-details">
            <div>
              <dt>Execution</dt>
              <dd>Robinhood live</dd>
            </div>
            <div>
              <dt>Decision gateway</dt>
              <dd :class="data.openrouter.configured ? 'value-positive' : 'value-negative'">
                {{ data.openrouter.configured ? "OpenRouter ready" : "Unavailable" }}
              </dd>
            </div>
            <div>
              <dt>Price source</dt>
              <dd :class="data.robinhood.state === 'ready' ? 'value-positive' : 'value-negative'">
                {{ data.robinhood.state === "ready" ? "Robinhood MCP" : "Unavailable" }}
              </dd>
            </div>
            <div>
              <dt>Capital</dt>
              <dd>{{ formatCurrency(data.arena.allocation_per_model) }} per model</dd>
            </div>
            <div>
              <dt>Next round</dt>
              <dd>{{ formatRelativeTime(data.arena.next_round_at) }}</dd>
            </div>
          </dl>
          <div class="round-rule">
            <Icon name="ph:shield-check" aria-hidden="true" />
            <p>Broker fills create ledger positions. Submitted orders never appear as filled until Robinhood confirms them.</p>
          </div>
        </aside>
      </header>

      <section v-if="data.market.length === 0 || data.robinhood.state !== 'ready'" class="integration-setup" aria-labelledby="market-state-heading">
        <Icon name="ph:cloud-slash" aria-hidden="true" />
        <div>
          <h2 id="market-state-heading">Waiting for a verified Robinhood snapshot</h2>
          <p>The public arena remains empty until the operator reconciles the dedicated Agentic account.</p>
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
              <p>Each line begins at its $250 live allocation and changes only with reconciled broker data.</p>
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

      <section class="market-tape" aria-label="Robinhood market snapshot">
        <div class="tape-heading">
          <Icon name="ph:wave-sine" aria-hidden="true" />
          <span>Robinhood snapshot</span>
          <small v-if="data.arena.last_robinhood_sync_at">Synced {{ formatRelativeTime(data.arena.last_robinhood_sync_at) }}</small>
          <small v-else>Awaiting first sync</small>
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
        <div v-if="data.market.length === 0" class="tape-empty">
          No verified quotes yet
        </div>
      </section>

      <section id="models" class="models-section section-anchor" aria-labelledby="models-heading">
        <div class="section-heading">
          <div>
            <h2 id="models-heading">The competitors</h2>
            <p>Each model sees the same Robinhood quote snapshot. Its strategy, confidence, and isolated ledger determine the request.</p>
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
                <dt>Available cash</dt>
                <dd>{{ formatCurrency(model.cash_balance) }}</dd>
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
              <p>Orders and positions reflect Robinhood broker state and reported fill prices.</p>
            </div>
            <div class="ledger-tabs" role="tablist" aria-label="Ledger view">
              <button type="button" role="tab" :aria-selected="ledgerView === 'positions'" :class="{ 'is-active': ledgerView === 'positions' }" @click="ledgerView = 'positions'">Positions</button>
              <button type="button" role="tab" :aria-selected="ledgerView === 'orders'" :class="{ 'is-active': ledgerView === 'orders' }" @click="ledgerView = 'orders'">Orders</button>
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

          <div v-else-if="ledgerView === 'orders' && filteredOrders.length" class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Side</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Filled</th>
                  <th scope="col">Broker status</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="order in filteredOrders" :key="order.id">
                  <td>
                    <span class="table-model">
                      <ModelGlyph :code="order.agent_code" :accent="order.agent_accent" size="small" />
                      {{ order.agent_name }}
                    </span>
                  </td>
                  <td><strong>{{ order.symbol }}</strong></td>
                  <td class="text-capitalize">{{ order.side }}</td>
                  <td>{{ order.requested_amount > 0 ? formatCurrency(order.requested_amount) : `${formatQuantity(order.requested_quantity)} shares` }}</td>
                  <td>{{ order.filled_quantity > 0 ? `${formatQuantity(order.filled_quantity)} @ ${formatPrice(order.average_fill_price || 0)}` : "Awaiting fill" }}</td>
                  <td><span class="broker-status">{{ order.status.replaceAll("_", " ") }}</span></td>
                  <td>{{ formatRelativeTime(order.created_at) }}</td>
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
          <p>OpenRouter returns one structured decision per model. Confidence, cash, position size, daily loss, and broker reconciliation gates run before any live order is reviewed.</p>
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
