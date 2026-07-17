<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatClock, formatCurrency } from "~/utils/format";

defineProps<{
  decisions: api.ArenaDecision[];
}>();

const emit = defineEmits<{
  inspect: [id: string];
}>();
</script>

<template>
  <div v-if="decisions.length" class="decision-feed">
    <article v-for="decision in decisions.slice(0, 16)" :key="decision.id" class="decision-item">
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
          Open agent session
          <Icon name="ph:arrow-up-right" aria-hidden="true" />
        </button>
      </div>
      <span class="decision-confidence" :aria-label="`${Math.round(decision.confidence * 100)} percent confidence`">
        {{ Math.round(decision.confidence * 100) }}%
      </span>
    </article>
  </div>
  <div v-else class="empty-state is-compact">
    <Icon name="ph:waveform" aria-hidden="true" />
    <p>No decisions match this model filter.</p>
  </div>
</template>
