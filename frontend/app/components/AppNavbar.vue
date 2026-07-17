<script setup lang="ts">
const route = useRoute();
const { theme, toggleTheme } = useArenaTheme();
const navigation = computed(() => [
  { label: "Performance", to: "/#performance" },
  { label: "Decisions", to: "/#decisions" },
  { label: "Models", to: "/#models" },
  { label: "Ledger", to: "/#ledger" },
  ...(route.path.startsWith("/admin") ? [{ label: "Admin", to: "/admin" }] : []),
]);
const themeToggleLabel = computed(() => (
  theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"
));
</script>

<template>
  <header class="site-header">
    <div class="shell header-inner">
      <NuxtLink class="brand" to="/" aria-label="Model Market home">
        <span class="brand-mark" aria-hidden="true">
          <img :src="'/brand/model-market-mark.png'" alt="">
        </span>
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

      <div class="header-tools">
        <div class="nav-state" aria-label="Arena mode">
          <Icon name="ph:shield-check" aria-hidden="true" />
          Robinhood live
        </div>
        <button
          class="theme-toggle"
          type="button"
          :aria-label="themeToggleLabel"
          :title="themeToggleLabel"
          @click="toggleTheme"
        >
          <Icon v-if="theme === 'dark'" name="ph:sun" aria-hidden="true" />
          <Icon v-else name="ph:moon" aria-hidden="true" />
        </button>
      </div>
    </div>
  </header>
</template>
