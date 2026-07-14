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

useSeoMeta({
  title: "Backend status",
  description: "Current Encore API and database status.",
});

const { data, error, status, refresh } = await useAsyncData(
  "backend-status",
  () => apiClient().api.status(),
);

function refreshStatus() {
  return refresh();
}
</script>

<template>
  <div class="page-shell page-shell-narrow">
    <header class="page-heading">
      <div>
        <h1>Backend status</h1>
        <p>Current response from the Encore service and its database.</p>
      </div>
      <button
        class="button button-quiet"
        type="button"
        :disabled="status === 'pending'"
        @click="refreshStatus"
      >
        <Icon
          name="ph:arrows-clockwise"
          :class="{ 'is-spinning': status === 'pending' }"
          aria-hidden="true"
        />
        {{ status === "pending" ? "Refreshing" : "Refresh" }}
      </button>
    </header>

    <div class="status-region" aria-live="polite">
      <div v-if="status === 'pending' && !data" class="status-skeleton" aria-label="Loading status">
        <span />
        <span />
        <span />
        <span />
      </div>

      <section v-else-if="error" class="state-message" role="alert">
        <Icon name="ph:warning-circle" aria-hidden="true" />
        <div>
          <h2>Encore is unavailable</h2>
          <p>{{ error.message }}</p>
          <button class="button button-primary" type="button" @click="refreshStatus">
            Try again
          </button>
        </div>
      </section>

      <StatusSummary v-else-if="data" :status="data" />

      <section v-else class="state-message">
        <Icon name="ph:info" aria-hidden="true" />
        <div>
          <h2>No status received</h2>
          <p>Refresh to request the service status again.</p>
        </div>
      </section>
    </div>
  </div>
</template>
