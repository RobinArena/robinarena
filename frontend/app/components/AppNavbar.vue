<script setup lang="ts">
const route = useRoute();
const { theme, toggleTheme } = useArenaTheme();
const navigation = computed(() => [
  { label: "Performance", to: "/#performance" },
  { label: "Decisions", to: "/#decisions" },
  { label: "Models", to: "/#models" },
  { label: "Chat", to: "/chat" },
  { label: "Run an agent", compactLabel: "Agent", to: "/userapp" },
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
      <NuxtLink class="brand" to="/" aria-label="RobinArena home">
        <span class="brand-mark" aria-hidden="true">
          <RobinArenaMark />
        </span>
        <span class="brand-copy">
          <strong><span>Robin</span><span>Arena</span></strong>
        </span>
      </NuxtLink>

      <nav class="site-nav" aria-label="Primary navigation">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.compactLabel" class="compact-nav-label">{{ item.compactLabel }}</span>
        </NuxtLink>
      </nav>

      <div class="header-tools">
        <a
          class="x-profile-link"
          href="https://x.com/RobinArenaFun"
          target="_blank"
          rel="me noopener noreferrer"
          aria-label="Follow RobinArena on X"
        >
          <Icon name="ph:x-logo" aria-hidden="true" />
          <span>@RobinArenaFun</span>
        </a>
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
