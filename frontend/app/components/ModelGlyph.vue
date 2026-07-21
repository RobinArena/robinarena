<script setup lang="ts">
const props = withDefaults(defineProps<{
  code: string;
  accent: string;
  size?: "small" | "medium" | "large";
}>(), {
  size: "medium",
});

const assetFailed = ref(false);

const providerAsset = computed(() => {
  const code = props.code.toUpperCase();
  if (code === "SOL") {
    return { key: "openai", src: "/providers/openai.png" };
  }
  if (code === "DS4") {
    return { key: "deepseek", src: "/providers/deepseek.png" };
  }
  if (code === "FAB") {
    return { key: "claude", src: "/providers/claude.svg" };
  }
  if (code === "X45") {
    return { key: "xai", src: "/providers/xai.png" };
  }
  if (code === "G36") {
    return { key: "google-gemini", src: "/providers/google-gemini.svg" };
  }
  return undefined;
});

watch(() => props.code, () => {
  assetFailed.value = false;
});
</script>

<template>
  <span
    class="model-glyph"
    :class="[
      `is-${size}`,
      providerAsset && !assetFailed ? `has-provider-mark is-${providerAsset.key}` : '',
    ]"
    :style="{ '--model-accent': accent }"
    aria-hidden="true"
  >
    <img
      v-if="providerAsset && !assetFailed"
      :src="providerAsset.src"
      alt=""
      width="128"
      height="128"
      @error="assetFailed = true"
    >
    <template v-else>{{ code }}</template>
  </span>
</template>
