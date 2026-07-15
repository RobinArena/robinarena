<script setup lang="ts">
withDefaults(defineProps<{
  code: string;
  accent: string;
  size?: "small" | "medium" | "large";
}>(), {
  size: "medium",
});
</script>

<template>
  <span
    class="model-glyph"
    :class="`is-${size}`"
    :style="{ '--model-accent': accent }"
    aria-hidden="true"
  >
    {{ code }}
  </span>
</template>
