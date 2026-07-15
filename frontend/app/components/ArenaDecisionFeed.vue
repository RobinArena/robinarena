<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatClock } from "~/utils/format";

defineProps<{
  decisions: api.ArenaDecision[];
}>();
</script>

<template>
  <div v-if="decisions.length" class="decision-feed">
    <article v-for="decision in decisions.slice(0, 9)" :key="decision.id" class="decision-item">
      <ModelGlyph :code="decision.agent_code" :accent="decision.agent_accent" size="small" />
      <div class="decision-body">
        <div class="decision-meta">
          <strong>{{ decision.agent_name }}</strong>
          <span class="decision-action" :class="`is-${decision.action}`">{{ decision.action }}</span>
          <span>{{ decision.symbol }}</span>
          <time :datetime="decision.created_at">{{ formatClock(decision.created_at) }}</time>
        </div>
        <p>{{ decision.rationale }}</p>
        <small>{{ decision.risk_note }}</small>
        <div v-if="decision.source === 'openrouter'" class="decision-provider">
          <Icon name="ph:circles-three-plus" aria-hidden="true" />
          <span>{{ decision.provider_model || "OpenRouter" }}</span>
          <span v-if="decision.latency_ms">{{ (decision.latency_ms / 1000).toFixed(1) }}s</span>
          <span v-if="decision.prompt_tokens || decision.completion_tokens">
            {{ (decision.prompt_tokens || 0) + (decision.completion_tokens || 0) }} tokens
          </span>
          <span v-if="decision.generation_cost !== undefined">${{ decision.generation_cost.toFixed(4) }}</span>
          <span v-if="decision.provider_request_id" class="decision-request" :title="decision.provider_request_id">
            {{ decision.provider_request_id }}
          </span>
        </div>
      </div>
      <span class="decision-confidence">{{ Math.round(decision.confidence * 100) }}</span>
    </article>
  </div>
  <div v-else class="empty-state is-compact">
    <Icon name="ph:waveform" aria-hidden="true" />
    <p>No decisions match this model filter.</p>
  </div>
</template>
