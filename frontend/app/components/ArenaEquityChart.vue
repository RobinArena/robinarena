<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatPercent } from "~/utils/format";

const props = defineProps<{
  series: api.EquitySeries[];
  range: "1D" | "5D" | "ALL";
}>();

const width = 1000;
const height = 330;
const padding = { top: 20, right: 22, bottom: 30, left: 48 };
const hoverIndex = ref<number | null>(null);

interface HoverEntry {
  name: string;
  accent: string;
  point: api.EquityPoint;
}

const visibleSeries = computed(() => {
  const count = props.range === "1D" ? 3 : props.range === "5D" ? 11 : Number.POSITIVE_INFINITY;
  return props.series.map((item) => ({
    ...item,
    points: item.points.slice(-count),
  }));
});

const chart = computed(() => {
  const values = visibleSeries.value.flatMap((item) => item.points.map((point) => point.return_pct));
  const pointCount = Math.max(0, ...visibleSeries.value.map((item) => item.points.length));
  if (values.length === 0 || pointCount === 0) return null;
  const rawLow = Math.min(0, ...values);
  const rawHigh = Math.max(0, ...values);
  const spread = Math.max(rawHigh - rawLow, 1);
  const low = rawLow - spread * 0.12;
  const high = rawHigh + spread * 0.12;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => padding.left + (index / Math.max(pointCount - 1, 1)) * plotWidth;
  const y = (value: number) => padding.top + ((high - value) / (high - low)) * plotHeight;
  const lines = visibleSeries.value.map((item) => ({
    ...item,
    path: item.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(point.return_pct).toFixed(2)}`).join(" "),
    last: item.points.at(-1),
  }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = high - (index / 4) * (high - low);
    return { value, y: y(value) };
  });
  return { lines, grid, low, high, pointCount, x, y, zeroY: y(0) };
});

const hover = computed(() => {
  if (!chart.value || hoverIndex.value === null) return null;
  const entries = chart.value.lines.map((item) => ({
    name: item.agent_name,
    accent: item.accent,
    point: item.points[hoverIndex.value as number],
  })).filter((item): item is HoverEntry => Boolean(item.point));
  const first = entries[0];
  if (!first) return null;
  return {
    entries,
    timestamp: first.point.captured_at,
    left: (chart.value.x(hoverIndex.value) / width) * 100,
  };
});

function setHover(event: PointerEvent) {
  if (!chart.value) return;
  const element = event.currentTarget as SVGElement;
  const bounds = element.getBoundingClientRect();
  const relativeX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
  const plotStart = (padding.left / width) * bounds.width;
  const plotWidth = ((width - padding.left - padding.right) / width) * bounds.width;
  const ratio = Math.min(Math.max((relativeX - plotStart) / plotWidth, 0), 1);
  hoverIndex.value = Math.round(ratio * Math.max(chart.value.pointCount - 1, 0));
}
</script>

<template>
  <div v-if="chart" class="arena-chart">
    <div class="chart-canvas">
      <svg
        :viewBox="`0 0 ${width} ${height}`"
        role="img"
        aria-label="Model returns since the start of the arena"
        preserveAspectRatio="none"
        @pointermove="setHover"
        @pointerleave="hoverIndex = null"
      >
        <g v-for="line in chart.grid" :key="line.y">
          <line
            :x1="padding.left"
            :x2="width - padding.right"
            :y1="line.y"
            :y2="line.y"
            class="chart-grid-line"
          />
          <text :x="padding.left - 10" :y="line.y + 4" class="chart-axis-label" text-anchor="end">
            {{ `${line.value.toFixed(0)}%` }}
          </text>
        </g>
        <line
          :x1="padding.left"
          :x2="width - padding.right"
          :y1="chart.zeroY"
          :y2="chart.zeroY"
          class="chart-zero-line"
        />
        <path
          v-for="line in chart.lines"
          :key="line.agent_id"
          :d="line.path"
          class="model-chart-line"
          :style="{ stroke: line.accent }"
        />
        <line
          v-if="hoverIndex !== null"
          :x1="chart.x(hoverIndex)"
          :x2="chart.x(hoverIndex)"
          :y1="padding.top"
          :y2="height - padding.bottom"
          class="chart-hover-line"
        />
        <template v-if="hoverIndex !== null">
          <circle
            v-for="line in chart.lines"
            :key="`${line.agent_id}-point`"
            :cx="chart.x(hoverIndex)"
            :cy="chart.y(line.points[hoverIndex]?.return_pct ?? 0)"
            r="4"
            class="chart-hover-point"
            :style="{ fill: line.accent }"
          />
        </template>
      </svg>

      <div
        v-if="hover"
        class="chart-tooltip"
        :class="{ 'is-right': hover.left > 72 }"
        :style="{ left: `${hover.left}%` }"
      >
        <time :datetime="hover.timestamp">
          {{ new Date(hover.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) }}
        </time>
        <div v-for="item in hover.entries" :key="item.name">
          <span class="legend-swatch" :style="{ background: item.accent }" />
          <span>{{ item.name }}</span>
          <strong>{{ formatPercent(item.point.return_pct) }}</strong>
        </div>
      </div>
    </div>

    <div class="chart-legend" aria-label="Latest model returns">
      <div v-for="line in chart.lines" :key="line.agent_id">
        <span class="legend-swatch" :style="{ background: line.accent }" />
        <span>{{ line.agent_name }}</span>
        <strong :class="(line.last?.return_pct || 0) >= 0 ? 'value-positive' : 'value-negative'">
          {{ formatPercent(line.last?.return_pct || 0) }}
        </strong>
      </div>
    </div>
  </div>

  <div v-else class="empty-state">
    <Icon name="ph:chart-line" aria-hidden="true" />
    <p>Equity history will appear after the first broker reconciliation.</p>
  </div>
</template>
