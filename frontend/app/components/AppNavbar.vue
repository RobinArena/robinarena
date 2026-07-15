<script setup lang="ts">
const navigation = [
  { label: "Performance", to: "/#performance" },
  { label: "Models", to: "/#models" },
  { label: "Ledger", to: "/#ledger" },
] as const;
</script>

<template>
  <header class="site-header">
    <div class="shell header-inner">
      <NuxtLink class="brand" to="/" aria-label="Model Market home">
        <span class="brand-mark" aria-hidden="true">MM</span>
        <span class="brand-copy">
          <strong>Model Market</strong>
          <small>LLM trading arena</small>
        </span>
      </NuxtLink>

      <nav class="site-nav" aria-label="Primary navigation">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div class="nav-state" aria-label="Arena mode">
        <Icon name="ph:circles-three-plus" aria-hidden="true" />
        OpenRouter paper
      </div>
    </div>
  </header>
</template>
