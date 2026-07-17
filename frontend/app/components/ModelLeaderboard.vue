<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatCurrency, formatPercent } from "~/utils/format";

defineProps<{
  models: api.ArenaModel[];
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();
</script>

<template>
  <div class="leaderboard-list">
    <button
      v-for="model in models"
      :key="model.id"
      class="leaderboard-row"
      :class="{ 'is-selected': selectedId === model.id }"
      type="button"
      :aria-pressed="selectedId === model.id"
      @click="emit('select', model.id)"
    >
      <ModelGlyph :code="model.code" :accent="model.accent" size="small" />
      <span class="leaderboard-model">
        <strong>{{ model.name }}</strong>
        <small>{{ model.strategy }}</small>
      </span>
      <span class="leaderboard-equity">
        <strong>{{ formatCurrency(model.equity, true) }}</strong>
        <small>{{ model.open_positions }} open</small>
      </span>
      <span :class="model.return_pct >= 0 ? 'value-positive' : 'value-negative'">
        {{ formatPercent(model.return_pct) }}
      </span>
    </button>
  </div>
</template>
