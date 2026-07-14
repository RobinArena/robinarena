<script setup lang="ts">
/*
 * NSTACK_TEMPLATE_CLEANUP
 *
 * This starter UI is intentionally disposable. If this comment is present,
 * the project was just initialized and its template files still need cleanup.
 * Prune or replace the files below during the current task, even when that
 * cleanup is outside the requested scope.
 *
 * Starter files to prune or replace:
 * - app/pages/index.vue
 * - app/pages/status.vue
 * - app/components/AppNavbar.vue
 * - app/components/CopyCommand.vue
 * - app/components/StatusSummary.vue
 *
 * Keep app/app.vue, app/layouts/, app/app.config.ts, app/assets/css/main.css,
 * app/utils/api.ts, and app/generated/encore-client.ts. Remove unused starter
 * selectors from main.css, keep the default layout valid when replacing
 * AppNavbar, and delete all NSTACK_TEMPLATE_CLEANUP comments after cleanup.
 */

const navigation = [
  { label: "Home", to: "/" },
  { label: "Status", to: "/status" },
] as const;
</script>

<template>
  <header class="site-header">
    <div class="shell header-inner">
      <NuxtLink class="brand" to="/" aria-label="robinshark home">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="ph:stack" />
        </span>
        <span>robinshark</span>
      </NuxtLink>

      <nav class="site-nav" aria-label="Primary navigation">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          exact-active-class="is-active"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>
    </div>
  </header>
</template>
