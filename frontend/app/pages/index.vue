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
  title: "Home",
  description: "robinshark development starter.",
});

const structure = [
  {
    icon: "ph:files",
    title: "Pages become routes",
    description: "Add route components under frontend/app/pages and navigate with NuxtLink.",
    path: "frontend/app/pages",
  },
  {
    icon: "ph:squares-four",
    title: "Shared UI has a home",
    description: "Keep page chrome in layouts and reusable interface pieces in components.",
    path: "frontend/app/layouts",
  },
  {
    icon: "ph:plugs-connected",
    title: "Encore stays type-safe",
    description: "Call backend endpoints through apiClient() inside useAsyncData or event handlers.",
    path: "frontend/app/utils/api.ts",
  },
] as const;
</script>

<template>
  <div class="page-shell">
    <section class="hero-grid" aria-labelledby="home-title">
      <div class="hero-copy">
        <h1 id="home-title">robinshark is ready.</h1>
        <p>
          Build Nuxt pages in <code>frontend/app</code> and Encore APIs in
          <code>backend/api</code>.
        </p>
        <div class="hero-actions">
          <NuxtLink class="button button-primary" to="/status">
            <Icon name="ph:pulse" aria-hidden="true" />
            Check backend
          </NuxtLink>
          <a
            class="button button-quiet"
            href="https://nuxt.com/docs/4.x"
            target="_blank"
            rel="noreferrer"
          >
            Nuxt documentation
            <Icon name="ph:arrow-up-right" aria-hidden="true" />
          </a>
        </div>
      </div>

      <aside class="setup-panel" aria-labelledby="run-title">
        <h2 id="run-title">Run the app</h2>
        <CopyCommand command="pnpm dev" />
        <p>Use <code>pnpm check</code> before you commit.</p>
      </aside>
    </section>

    <section class="structure-section" aria-labelledby="structure-title">
      <div class="section-heading">
        <h2 id="structure-title">Frontend structure</h2>
        <p>
          The default layout provides navigation while each page owns its data
          and route metadata.
        </p>
      </div>

      <div class="structure-list">
        <article v-for="item in structure" :key="item.title" class="structure-row">
          <Icon :name="item.icon" aria-hidden="true" />
          <div>
            <h3>{{ item.title }}</h3>
            <p>{{ item.description }}</p>
          </div>
          <code>{{ item.path }}</code>
        </article>
      </div>
    </section>
  </div>
</template>
