<script setup lang="ts">
import type { api } from "~/generated/encore-client";

const props = defineProps<{
  status: api.StatusResponse;
}>();

const details = computed(() => [
  {
    label: "Database",
    value: props.status.database_ok ? "Ready" : "Unavailable",
    healthy: props.status.database_ok,
  },
  {
    label: "Commit",
    value: props.status.commit ? props.status.commit.slice(0, 8) : "local",
  },
  {
    label: "Release",
    value: props.status.image_tag || "development",
  },
  {
    label: "Uptime",
    value: formatDuration(props.status.uptime_seconds),
  },
]);

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
</script>

<template>
  <section class="status-panel" aria-labelledby="service-name">
    <div class="status-overview">
      <div>
        <h2 id="service-name">{{ status.app }}</h2>
        <p>Response received from the Encore API.</p>
      </div>
      <span
        class="service-state"
        :class="{ 'is-unhealthy': !status.database_ok }"
      >
        <Icon
          :name="status.database_ok ? 'ph:check-circle' : 'ph:warning-circle'"
          aria-hidden="true"
        />
        {{ status.database_ok ? "Operational" : "Needs attention" }}
      </span>
    </div>

    <dl class="status-list">
      <div v-for="item in details" :key="item.label" class="status-row">
        <dt>{{ item.label }}</dt>
        <dd :class="{ 'is-unhealthy': item.healthy === false }">
          {{ item.value }}
        </dd>
      </div>
    </dl>
  </section>
</template>
