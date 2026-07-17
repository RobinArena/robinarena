<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import {
  formatClock,
  formatCurrency,
  formatPercent,
  formatQuantity,
  formatSignedCurrency,
} from "~/utils/format";

const props = defineProps<{
  models: api.ArenaModel[];
  decisions: api.ArenaDecision[];
  orders: api.ArenaOrder[];
  positions: api.ArenaPosition[];
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const selectedDecisionId = ref("");

const latestDecisions = computed(() => {
  const latest = new Map<string, api.ArenaDecision>();
  for (const decision of props.decisions) {
    const current = latest.get(decision.agent_id);
    if (
      !current
      || new Date(decision.created_at).getTime() > new Date(current.created_at).getTime()
    ) {
      latest.set(decision.agent_id, decision);
    }
  }
  return latest;
});

const selectedModel = computed(() => (
  props.models.find((model) => model.id === props.selectedId)
  || props.models[0]
));

const modelDecisions = computed(() => {
  if (!selectedModel.value) return [];
  return props.decisions
    .filter((decision) => decision.agent_id === selectedModel.value?.id)
    .toSorted((left, right) => (
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
    ));
});

const selectedDecision = computed(() => (
  modelDecisions.value.find((decision) => decision.id === selectedDecisionId.value)
  || modelDecisions.value[0]
));

const selectedOrder = computed(() => {
  const decision = selectedDecision.value;
  if (!decision?.order_id) return undefined;
  return props.orders.find((order) => order.id === decision.order_id);
});

const selectedPosition = computed(() => {
  const model = selectedModel.value;
  const decision = selectedDecision.value;
  if (!model || !decision) return undefined;
  return props.positions.find((position) => (
    position.agent_id === model.id && position.symbol === decision.symbol
  ));
});

const toolPayload = computed(() => {
  const decision = selectedDecision.value;
  if (!decision) return "";
  return JSON.stringify({
    action: decision.requested_action,
    symbol: decision.symbol,
    allocation_pct: decision.requested_allocation_pct,
    confidence: Number(decision.confidence.toFixed(2)),
    proposed_notional: Number(decision.proposed_notional.toFixed(2)),
  }, null, 2);
});

const brokerOutcome = computed(() => {
  const decision = selectedDecision.value;
  const order = selectedOrder.value;
  if (!decision) return "";
  if (order?.filled_quantity) {
    const price = order.average_fill_price
      ? ` at ${formatCurrency(order.average_fill_price)}`
      : "";
    return `${formatQuantity(order.filled_quantity)} ${decision.symbol} shares filled${price}.`;
  }
  if (decision.executed_notional > 0) {
    return `${formatCurrency(decision.executed_notional)} reached Robinhood for execution.`;
  }
  return "No Robinhood order was sent for this run.";
});

watch(
  () => `${props.selectedId}:${modelDecisions.value.map((decision) => decision.id).join(",")}`,
  () => {
    if (!modelDecisions.value.some((decision) => decision.id === selectedDecisionId.value)) {
      selectedDecisionId.value = modelDecisions.value[0]?.id || "";
    }
  },
  { immediate: true },
);

function latestDecision(modelId: string): api.ArenaDecision | undefined {
  return latestDecisions.value.get(modelId);
}

function decisionOutcome(decision?: api.ArenaDecision): string {
  if (!decision) return "Waiting";
  if (decision.executed_notional > 0) return "Executed";
  if (decision.approved) return "Approved";
  return decision.action === "hold" ? "Observed" : "No order";
}

function formatCost(value?: number): string {
  if (value === undefined) return "Unavailable";
  return `$${value.toFixed(4)}`;
}
</script>

<template>
  <div
    v-if="selectedModel"
    class="agent-workspace"
    :style="{ '--model-accent': selectedModel.accent }"
  >
    <aside class="agent-session-sidebar" aria-label="Agent sessions">
      <div class="agent-sidebar-heading">
        <strong>Agents</strong>
        <span>{{ models.length }} connected</span>
      </div>

      <div class="agent-roster" aria-label="Choose an agent">
        <button
          v-for="model in models"
          :key="model.id"
          type="button"
          class="agent-roster-item"
          :class="{ 'is-selected': model.id === selectedModel.id }"
          :style="{ '--model-accent': model.accent }"
          :aria-pressed="model.id === selectedModel.id"
          @click="emit('select', model.id)"
        >
          <ModelGlyph :code="model.code" :accent="model.accent" size="small" />
          <span class="agent-roster-copy">
            <strong>{{ model.name }}</strong>
            <small>
              <template v-if="latestDecision(model.id)">
                Cycle {{ latestDecision(model.id)?.cycle_number }}
                · {{ latestDecision(model.id)?.requested_action }}
                {{ latestDecision(model.id)?.symbol }}
              </template>
              <template v-else>No completed run</template>
            </small>
          </span>
          <span
            class="agent-roster-state"
            :class="{ 'is-complete': latestDecision(model.id)?.executed_notional }"
          >
            {{ decisionOutcome(latestDecision(model.id)) }}
          </span>
        </button>
      </div>

      <section v-if="modelDecisions.length" class="agent-run-history" aria-labelledby="run-history-heading">
        <div class="agent-sidebar-heading">
          <strong id="run-history-heading">Run history</strong>
          <span>{{ modelDecisions.length }} cycles</span>
        </div>
        <div class="agent-run-list">
          <button
            v-for="decision in modelDecisions"
            :key="decision.id"
            type="button"
            :class="{ 'is-selected': decision.id === selectedDecision?.id }"
            :aria-pressed="decision.id === selectedDecision?.id"
            @click="selectedDecisionId = decision.id"
          >
            <span>Cycle {{ decision.cycle_number }}</span>
            <strong>{{ decision.requested_action }} {{ decision.symbol }}</strong>
            <time :datetime="decision.created_at">{{ formatClock(decision.created_at) }} ET</time>
          </button>
        </div>
      </section>
    </aside>

    <section
      id="agent-session-panel"
      class="agent-session"
      role="region"
      :aria-label="`${selectedModel.name} agent session`"
      aria-live="polite"
    >
      <header class="agent-session-header">
        <div class="agent-session-identity">
          <ModelGlyph :code="selectedModel.code" :accent="selectedModel.accent" size="medium" />
          <div>
            <h3>{{ selectedModel.name }}</h3>
            <p>{{ selectedModel.openrouter_model }}</p>
          </div>
        </div>
        <div class="agent-session-status">
          <span>{{ selectedModel.strategy }}</span>
          <strong v-if="selectedDecision">
            Cycle {{ selectedDecision.cycle_number }} complete
          </strong>
          <strong v-else>Waiting for first run</strong>
        </div>
      </header>

      <div v-if="selectedDecision" :key="selectedDecision.id" class="agent-transcript">
        <article class="transcript-entry is-system">
          <div class="transcript-avatar" aria-hidden="true">
            <Icon name="ph:terminal-window" />
          </div>
          <div class="transcript-message">
            <header>
              <div>
                <span class="transcript-role">System</span>
                <strong>Session brief</strong>
              </div>
              <span>Live ledger context</span>
            </header>
            <p>{{ selectedModel.thesis }}</p>
            <dl class="session-ledger">
              <div>
                <dt>Equity</dt>
                <dd>{{ formatCurrency(selectedModel.equity) }}</dd>
              </div>
              <div>
                <dt>Available cash</dt>
                <dd>{{ formatCurrency(selectedModel.cash_balance) }}</dd>
              </div>
              <div>
                <dt>Return</dt>
                <dd :class="selectedModel.return_pct >= 0 ? 'value-positive' : 'value-negative'">
                  {{ formatPercent(selectedModel.return_pct) }}
                </dd>
              </div>
              <div>
                <dt>Open positions</dt>
                <dd>{{ selectedModel.open_positions }}</dd>
              </div>
            </dl>
          </div>
        </article>

        <article class="transcript-entry is-assistant">
          <div class="transcript-avatar" aria-hidden="true">
            <ModelGlyph :code="selectedModel.code" :accent="selectedModel.accent" size="small" />
          </div>
          <div class="transcript-message">
            <header>
              <div>
                <span class="transcript-role">Model thought</span>
                <strong>Published reasoning</strong>
              </div>
              <time :datetime="selectedDecision.created_at">
                {{ formatClock(selectedDecision.created_at) }} ET
              </time>
            </header>
            <p class="transcript-reasoning">{{ selectedDecision.rationale }}</p>
          </div>
        </article>

        <article class="transcript-entry is-tool">
          <div class="transcript-avatar" aria-hidden="true">
            <Icon name="ph:brackets-curly" />
          </div>
          <div class="transcript-message tool-call">
            <header>
              <div>
                <span class="transcript-role">Action</span>
                <strong>submit_trade_decision</strong>
              </div>
              <span class="tool-state">Completed</span>
            </header>
            <pre><code>{{ toolPayload }}</code></pre>
          </div>
        </article>

        <article class="transcript-entry is-risk">
          <div class="transcript-avatar" aria-hidden="true">
            <Icon :name="selectedDecision.approved ? 'ph:shield-check' : 'ph:shield-warning'" />
          </div>
          <div class="transcript-message">
            <header>
              <div>
                <span class="transcript-role">Risk engine</span>
                <strong>{{ selectedDecision.approved ? "Request approved" : "No order approved" }}</strong>
              </div>
              <span :class="selectedDecision.approved ? 'value-positive' : 'value-negative'">
                {{ selectedDecision.approved ? "Passed" : "Blocked" }}
              </span>
            </header>
            <p>{{ selectedDecision.risk_note }}</p>
            <dl class="risk-comparison">
              <div>
                <dt>Proposed</dt>
                <dd>{{ formatCurrency(selectedDecision.proposed_notional) }}</dd>
              </div>
              <div>
                <dt>Executed</dt>
                <dd>{{ formatCurrency(selectedDecision.executed_notional) }}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{{ Math.round(selectedDecision.confidence * 100) }}%</dd>
              </div>
            </dl>
          </div>
        </article>

        <article class="transcript-entry is-broker">
          <div class="transcript-avatar" aria-hidden="true">
            <Icon name="ph:bank" />
          </div>
          <div class="transcript-message">
            <header>
              <div>
                <span class="transcript-role">Robinhood</span>
                <strong>Broker result</strong>
              </div>
              <span v-if="selectedOrder" class="broker-status">
                {{ selectedOrder.status.replaceAll("_", " ") }}
              </span>
            </header>
            <p>{{ brokerOutcome }}</p>
            <p v-if="selectedPosition" class="position-context">
              Current {{ selectedPosition.symbol }} position:
              {{ formatQuantity(selectedPosition.quantity) }} shares,
              {{ formatCurrency(selectedPosition.market_value) }} market value,
              <span :class="selectedPosition.unrealized_pnl >= 0 ? 'value-positive' : 'value-negative'">
                {{ formatSignedCurrency(selectedPosition.unrealized_pnl) }} open P&amp;L
              </span>.
            </p>
          </div>
        </article>
      </div>

      <div v-else class="agent-session-empty">
        <Icon name="ph:waveform" aria-hidden="true" />
        <h3>Waiting for {{ selectedModel.name }}</h3>
        <p>The published reasoning, requested action, risk verdict, and broker result will appear here after its first live cycle.</p>
      </div>

      <details v-if="selectedDecision" class="agent-run-details">
        <summary>
          <span>Run details</span>
          <Icon name="ph:caret-down" aria-hidden="true" />
        </summary>
        <dl>
          <div>
            <dt>Provider model</dt>
            <dd>{{ selectedDecision.provider_model || selectedModel.openrouter_model }}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>{{ selectedDecision.latency_ms ? `${(selectedDecision.latency_ms / 1000).toFixed(2)}s` : "Unavailable" }}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{{ (selectedDecision.prompt_tokens || 0) + (selectedDecision.completion_tokens || 0) }}</dd>
          </div>
          <div>
            <dt>Generation cost</dt>
            <dd>{{ formatCost(selectedDecision.generation_cost) }}</dd>
          </div>
          <div v-if="selectedDecision.provider_request_id" class="is-wide">
            <dt>Provider request</dt>
            <dd><code>{{ selectedDecision.provider_request_id }}</code></dd>
          </div>
          <div v-if="selectedDecision.order_id" class="is-wide">
            <dt>Arena order</dt>
            <dd><code>{{ selectedDecision.order_id }}</code></dd>
          </div>
        </dl>
      </details>
    </section>
  </div>
</template>
