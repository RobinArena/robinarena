<script setup lang="ts">
import type { api } from "~/generated/encore-client";

defineProps<{
  models: api.UserAgentModel[];
  selectedId: string;
  disabled?: boolean;
}>();

defineEmits<{ select: [id: string] }>();
</script>

<template>
  <div class="user-model-grid" role="radiogroup" aria-label="Trading model">
    <button
      v-for="model in models"
      :key="model.id"
      class="user-model-option"
      :class="{ 'is-selected': model.id === selectedId }"
      :style="{ '--model-accent': model.accent }"
      type="button"
      role="radio"
      :aria-checked="model.id === selectedId"
      :disabled="disabled"
      @click="$emit('select', model.id)"
    >
      <ModelGlyph :code="model.code" :accent="model.accent" size="medium" />
      <span>
        <strong>{{ model.name }}</strong>
        <small>{{ model.provider }}</small>
      </span>
      <Icon :name="model.id === selectedId ? 'ph:check-circle-fill' : 'ph:circle'" aria-hidden="true" />
    </button>
  </div>
</template>
