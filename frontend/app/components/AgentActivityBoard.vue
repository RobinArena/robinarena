<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatClock, formatCurrency } from "~/utils/format";

const props = defineProps<{
  models: api.ArenaModel[];
  decisions: api.ArenaDecision[];
}>();

const activity = computed(() => props.models.map((model) => ({
  model,
  decision: props.decisions.find((decision) => decision.agent_id === model.id),
})));

function requestedAction(decision: api.ArenaDecision): string {
  if (decision.requested_action === "buy") {
    return `BUY ${decision.requested_allocation_pct.toFixed(0)}% · ${formatCurrency(decision.proposed_notional)}`;
  }
  return decision.requested_action.toUpperCase();
}
</script>

<template>
  <div class="agent-activity-grid">
    <article
      v-for="{ model, decision } in activity"
      :key="model.id"
      class="agent-activity-card"
      :style="{ '--model-accent': model.accent }"
    >
      <header class="agent-activity-head">
        <div>
          <ModelGlyph :code="model.code" :accent="model.accent" size="small" />
          <div>
            <h3>{{ model.name }}</h3>
            <span>{{ model.openrouter_model }}</span>
          </div>
        </div>
        <time v-if="decision" :datetime="decision.created_at">
          {{ formatClock(decision.created_at) }} ET
        </time>
        <span v-else>Awaiting cycle</span>
      </header>

      <template v-if="decision">
        <div class="agent-action-line">
          <span class="decision-action" :class="`is-${decision.requested_action}`">{{ decision.requested_action }}</span>
          <strong>{{ decision.symbol }}</strong>
          <span>{{ Math.round(decision.confidence * 100) }}% confidence</span>
          <span>Cycle {{ decision.cycle_number }}</span>
        </div>

        <div class="agent-rationale">
          <span>Submitted rationale</span>
          <p>{{ decision.rationale }}</p>
        </div>

        <dl class="agent-decision-facts">
          <div>
            <dt>Requested</dt>
            <dd>{{ requestedAction(decision) }}</dd>
          </div>
          <div>
            <dt>Risk gate</dt>
            <dd :class="decision.approved ? 'value-positive' : ''">
              {{ decision.approved ? "Approved" : "No order" }}
            </dd>
          </div>
          <div>
            <dt>Executed</dt>
            <dd>{{ decision.executed_notional > 0 ? formatCurrency(decision.executed_notional) : "None" }}</dd>
          </div>
        </dl>

        <div class="agent-risk-note">
          <span>Risk engine</span>
          <p>{{ decision.risk_note }}</p>
        </div>

        <footer class="agent-provider-facts">
          <span>{{ decision.provider_model || model.openrouter_model }}</span>
          <span v-if="decision.latency_ms">{{ (decision.latency_ms / 1000).toFixed(1) }}s</span>
          <span v-if="decision.prompt_tokens || decision.completion_tokens">
            {{ (decision.prompt_tokens || 0) + (decision.completion_tokens || 0) }} tokens
          </span>
          <span v-if="decision.generation_cost !== undefined">
            {{ formatCurrency(decision.generation_cost) }}
          </span>
        </footer>
      </template>

      <div v-else class="agent-activity-empty">
        <Icon name="ph:waveform" aria-hidden="true" />
        <p>The first structured rationale and action will appear when this model completes a live cycle.</p>
        <span>{{ model.strategy }} · {{ formatCurrency(model.cash_balance) }} available</span>
      </div>
    </article>
  </div>
</template>
