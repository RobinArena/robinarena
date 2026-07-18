<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatClock, formatCurrency } from "~/utils/format";

const props = defineProps<{
  decisions: api.ArenaDecision[];
}>();

const emit = defineEmits<{
  inspect: [id: string];
}>();

const decisionPageSize = 8;
const visibleCount = ref(decisionPageSize);
const visibleDecisions = computed(() => props.decisions.slice(0, visibleCount.value));
const remainingDecisions = computed(() => Math.max(
  0,
  props.decisions.length - visibleDecisions.value.length,
));

watch(
  () => props.decisions.map((decision) => decision.id).join(","),
  () => {
    visibleCount.value = decisionPageSize;
  },
);

function loadMoreDecisions() {
  visibleCount.value = Math.min(
    visibleCount.value + decisionPageSize,
    props.decisions.length,
  );
}
</script>

<template>
  <div v-if="decisions.length" class="decision-feed">
    <article v-for="decision in visibleDecisions" :key="decision.id" class="decision-item">
      <ModelGlyph :code="decision.agent_code" :accent="decision.agent_accent" size="small" />
      <div class="decision-body">
        <div class="decision-meta">
          <div>
            <strong>{{ decision.agent_name }}</strong>
            <span class="decision-action" :class="`is-${decision.action}`">{{ decision.action }}</span>
            <span>{{ decision.symbol }}</span>
          </div>
          <time :datetime="decision.created_at">{{ formatClock(decision.created_at) }} ET</time>
        </div>
        <p>{{ decision.rationale }}</p>
        <p class="decision-risk">
          <Icon :name="decision.approved ? 'ph:shield-check' : 'ph:shield-warning'" aria-hidden="true" />
          {{ decision.risk_note }}
        </p>
        <div class="decision-facts">
          <span>Requested {{ decision.requested_action }} {{ decision.requested_allocation_pct.toFixed(0) }}%</span>
          <span>Proposed {{ formatCurrency(decision.proposed_notional) }}</span>
          <span>Executed {{ decision.executed_notional > 0 ? formatCurrency(decision.executed_notional) : "none" }}</span>
        </div>
        <button class="decision-open" type="button" @click="emit('inspect', decision.agent_id)">
          Inspect decision history
          <Icon name="ph:arrow-up-right" aria-hidden="true" />
        </button>
      </div>
      <span class="decision-confidence" :aria-label="`${Math.round(decision.confidence * 100)} percent confidence`">
        {{ Math.round(decision.confidence * 100) }}%
      </span>
    </article>
    <button
      v-if="remainingDecisions > 0"
      class="decision-feed-more"
      type="button"
      @click="loadMoreDecisions"
    >
      <span>Load more decisions</span>
      <small>{{ remainingDecisions }} remaining</small>
      <Icon name="ph:arrow-line-down" aria-hidden="true" />
    </button>
  </div>
  <div v-else class="empty-state is-compact">
    <Icon name="ph:waveform" aria-hidden="true" />
    <p>No decisions match this model filter.</p>
  </div>
</template>
