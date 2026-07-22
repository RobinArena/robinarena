<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatCurrency, formatPercent, formatSignedCurrency } from "~/utils/format";

const props = defineProps<{
  series: api.EquitySeries[];
  models: api.ArenaModel[];
  positions: api.ArenaPosition[];
  range: "1D" | "5D" | "ALL";
}>();

const width = 1080;
const height = 400;
const padding = { top: 32, right: 32, bottom: 52, left: 76 };
const rangeDuration = {
  "1D": 24 * 60 * 60 * 1000,
  "5D": 5 * 24 * 60 * 60 * 1000,
  ALL: Number.POSITIVE_INFINITY,
} as const;
const maxConnectedGap = 20 * 60 * 1000;

const initialLeader = props.models.toSorted((left, right) => right.return_pct - left.return_pct)[0];
const focusedAgentId = ref(initialLeader?.id || "all");
const hoverTimestamp = ref<number | null>(null);

const latestTimestamp = computed(() => Math.max(
  0,
  ...props.series.flatMap((item) => item.points.map((point) => Date.parse(point.captured_at))),
));

const visibleSeries = computed(() => {
  const duration = rangeDuration[props.range];
  const cutoff = Number.isFinite(duration)
    ? latestTimestamp.value - duration
    : Number.NEGATIVE_INFINITY;

  return props.series.map((item) => {
    const sorted = item.points.toSorted(
      (left, right) => Date.parse(left.captured_at) - Date.parse(right.captured_at),
    );
    const inRange = sorted.filter((point) => Date.parse(point.captured_at) >= cutoff);
    const preceding = sorted.findLast((point) => Date.parse(point.captured_at) < cutoff);
    const firstInRange = inRange.at(0);
    const continuousPreceding = preceding
      && firstInRange
      && Date.parse(firstInRange.captured_at) - Date.parse(preceding.captured_at) <= maxConnectedGap;

    return {
      ...item,
      points: continuousPreceding
        ? [preceding, ...inRange]
        : inRange.length
          ? inRange
          : sorted.slice(-1),
    };
  }).filter((item) => item.points.length > 0);
});

watch(
  () => props.models.map((model) => model.id).join(","),
  () => {
    if (focusedAgentId.value === "all") return;
    if (props.models.some((model) => model.id === focusedAgentId.value)) return;
    focusedAgentId.value = props.models.toSorted((left, right) => right.return_pct - left.return_pct)[0]?.id || "all";
  },
);

watch(() => props.range, () => { hoverTimestamp.value = null; });

const focusedModel = computed(() => props.models.find((model) => model.id === focusedAgentId.value));
const leader = computed(() => props.models.toSorted((left, right) => right.return_pct - left.return_pct)[0]);
const activeSeries = computed(() => focusedAgentId.value === "all"
  ? visibleSeries.value
  : visibleSeries.value.filter((item) => item.agent_id === focusedAgentId.value));

const focusMetrics = computed(() => {
  if (!focusedModel.value) {
    return [
      { label: "Leader", value: leader.value?.name || "Waiting" },
      { label: "Portfolios", value: String(props.models.length) },
      { label: "Open positions", value: String(props.positions.length) },
    ];
  }
  const model = focusedModel.value;
  return [
    { label: "Profit", value: formatSignedCurrency(model.equity - model.round_starting_equity) },
    { label: "Return", value: formatPercent(model.return_pct) },
    { label: "Open positions", value: String(props.positions.filter((position) => position.agent_id === model.id).length) },
  ];
});

const chart = computed(() => {
  const values = activeSeries.value.flatMap((item) => item.points.map((point) => point.profit));
  const timestamps = activeSeries.value.flatMap(
    (item) => item.points.map((point) => Date.parse(point.captured_at)),
  );
  if (!values.length || !timestamps.length) return null;

  const rawLow = Math.min(0, ...values);
  const rawHigh = Math.max(0, ...values);
  const spread = Math.max(rawHigh - rawLow, 0.02);
  const low = rawLow - spread * .16;
  const high = rawHigh + spread * .16;
  const timeLow = Math.min(...timestamps);
  const timeHigh = Math.max(...timestamps);
  const safeTimeLow = timeHigh === timeLow ? timeLow - 60 * 60 * 1000 : timeLow;
  const safeTimeHigh = timeHigh;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (timestamp: number) => padding.left
    + ((timestamp - safeTimeLow) / (safeTimeHigh - safeTimeLow)) * plotWidth;
  const y = (value: number) => padding.top + ((high - value) / (high - low)) * plotHeight;
  const lines = activeSeries.value.map((item) => ({
    ...item,
    path: connectedPath(item.points, x, y),
  }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = high - (index / 4) * (high - low);
    return { value, y: y(value) };
  });
  const timeTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = safeTimeLow + (index / 4) * (safeTimeHigh - safeTimeLow);
    return { timestamp, x: x(timestamp) };
  });

  return {
    lines,
    grid,
    timeTicks,
    span: high - low,
    timeLow: safeTimeLow,
    timeHigh: safeTimeHigh,
    x,
    y,
    zeroY: y(0),
  };
});

const hover = computed(() => {
  if (!chart.value || hoverTimestamp.value === null) return null;
  const entries = chart.value.lines.map((line) => {
    const point = nearestPoint(line.points, hoverTimestamp.value as number);
    return point ? {
      agentId: line.agent_id,
      name: line.agent_name,
      accent: line.accent,
      point,
    } : undefined;
  }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (!entries.length) return null;
  return {
    entries,
    timestamp: hoverTimestamp.value,
    left: (chart.value.x(hoverTimestamp.value) / width) * 100,
  };
});

function connectedPath(
  points: api.EquityPoint[],
  x: (timestamp: number) => number,
  y: (value: number) => number,
): string {
  if (points.length === 1) {
    const pointY = y(points[0]!.profit).toFixed(2);
    return `M${padding.left},${pointY} L${width - padding.right},${pointY}`;
  }
  return points.map((point, index) => {
    const timestamp = Date.parse(point.captured_at);
    return `${index === 0 ? "M" : "L"}${x(timestamp).toFixed(2)},${y(point.profit).toFixed(2)}`;
  }).join(" ");
}

function nearestPoint(points: api.EquityPoint[], target: number): api.EquityPoint | undefined {
  let nearest: api.EquityPoint | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(Date.parse(point.captured_at) - target);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function setHover(event: PointerEvent): void {
  if (!chart.value) return;
  const bounds = (event.currentTarget as SVGElement).getBoundingClientRect();
  const relativeX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
  const plotStart = (padding.left / width) * bounds.width;
  const plotWidth = ((width - padding.left - padding.right) / width) * bounds.width;
  const ratio = Math.min(Math.max((relativeX - plotStart) / plotWidth, 0), 1);
  hoverTimestamp.value = chart.value.timeLow + ratio * (chart.value.timeHigh - chart.value.timeLow);
}

function focusPortfolio(agentId: string): void {
  focusedAgentId.value = agentId;
  hoverTimestamp.value = null;
}

function axisLabel(value: number): string {
  const span = chart.value?.span || 1;
  const decimals = span >= 100 ? 0 : span >= 10 ? 1 : span >= .1 ? 2 : span >= .01 ? 3 : 4;
  const threshold = .5 * 10 ** -decimals;
  const normalized = Math.abs(value) < threshold ? 0 : value;
  return `${normalized > 0 ? "+" : normalized < 0 ? "-" : ""}$${Math.abs(normalized).toFixed(decimals)}`;
}

function timeLabel(timestamp: number): string {
  const duration = (chart.value?.timeHigh || timestamp) - (chart.value?.timeLow || timestamp);
  return new Intl.DateTimeFormat("en-US", duration <= 36 * 60 * 60 * 1000
    ? { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }
    : { month: "short", day: "numeric", timeZone: "America/New_York" }).format(timestamp);
}

function tooltipTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(timestamp);
}
</script>

<template>
  <div v-if="chart" class="arena-chart">
    <header class="chart-toolbar">
      <div class="chart-focus-copy">
        <span>{{ focusedModel ? "Focused portfolio" : "Comparison view" }}</span>
        <strong>{{ focusedModel?.name || "All model portfolios" }}</strong>
        <p>{{ focusedModel?.strategy || "Every model shares the same dollar profit scale." }}</p>
      </div>
      <dl class="chart-focus-metrics">
        <div v-for="metric in focusMetrics" :key="metric.label">
          <dt>{{ metric.label }}</dt>
          <dd>{{ metric.value }}</dd>
        </div>
      </dl>
    </header>

    <div class="chart-canvas">
      <div class="chart-plot-stage">
        <svg
          :viewBox="`0 0 ${width} ${height}`"
          role="img"
          :aria-label="focusedModel ? `Profit history for ${focusedModel.name}` : 'Profit history for all isolated model portfolios'"
          @pointermove="setHover"
          @pointerleave="hoverTimestamp = null"
        >
          <g v-for="line in chart.grid" :key="`value-${line.y}`">
            <line :x1="padding.left" :x2="width - padding.right" :y1="line.y" :y2="line.y" class="chart-grid-line" />
            <text :x="padding.left - 14" :y="line.y + 4" class="chart-axis-label" text-anchor="end">{{ axisLabel(line.value) }}</text>
          </g>
          <g v-for="tick in chart.timeTicks" :key="`time-${tick.timestamp}`">
            <line :x1="tick.x" :x2="tick.x" :y1="padding.top" :y2="height - padding.bottom" class="chart-time-grid" />
            <text
              :x="tick.x"
              :y="height - 16"
              class="chart-axis-label chart-time-label"
              :text-anchor="tick.x === padding.left ? 'start' : tick.x === width - padding.right ? 'end' : 'middle'"
            >{{ timeLabel(tick.timestamp) }}</text>
          </g>
          <line :x1="padding.left" :x2="width - padding.right" :y1="chart.zeroY" :y2="chart.zeroY" class="chart-zero-line" />
          <path
            v-for="line in chart.lines"
            :key="line.agent_id"
            :d="line.path"
            class="model-chart-line"
            :class="{ 'is-comparison': focusedAgentId === 'all' }"
            :style="{ '--series-accent': line.accent }"
          />
          <line
            v-if="hoverTimestamp !== null"
            :x1="chart.x(hoverTimestamp)"
            :x2="chart.x(hoverTimestamp)"
            :y1="padding.top"
            :y2="height - padding.bottom"
            class="chart-hover-line"
          />
          <circle
            v-for="item in hover?.entries || []"
            :key="`${item.agentId}-hover`"
            :cx="chart.x(Date.parse(item.point.captured_at))"
            :cy="chart.y(item.point.profit)"
            r="5"
            class="chart-hover-point"
            :style="{ '--series-accent': item.accent }"
          />
        </svg>

        <div
          v-if="hover"
          class="chart-tooltip"
          :class="{ 'is-right': hover.left > 70 }"
          :style="{ left: `${hover.left}%` }"
        >
          <time :datetime="new Date(hover.timestamp).toISOString()">{{ tooltipTime(hover.timestamp) }}</time>
          <div v-for="item in hover.entries" :key="item.agentId">
            <span class="tooltip-swatch" :style="{ '--series-accent': item.accent }" />
            <span>{{ item.name }}</span>
            <strong>{{ formatSignedCurrency(item.point.profit) }} <small>{{ formatPercent(item.point.return_pct) }}</small></strong>
          </div>
        </div>
      </div>
    </div>

    <nav class="chart-series-index" aria-label="Choose a portfolio for the chart">
      <button type="button" :aria-pressed="focusedAgentId === 'all'" :class="{ 'is-active': focusedAgentId === 'all' }" @click="focusPortfolio('all')">
        <Icon name="ph:stack" aria-hidden="true" />
        <span><strong>Compare all</strong><small>{{ models.length }} portfolios</small></span>
      </button>
      <button
        v-for="model in models"
        :key="model.id"
        type="button"
        :aria-pressed="focusedAgentId === model.id"
        :class="{ 'is-active': focusedAgentId === model.id }"
        :style="{ '--series-accent': model.accent }"
        @click="focusPortfolio(model.id)"
      >
        <span class="series-swatch" />
        <span><strong>{{ model.name }}</strong><small>{{ formatSignedCurrency(model.equity - model.round_starting_equity) }}</small></span>
      </button>
    </nav>

    <div class="sr-only" aria-label="Latest isolated model portfolio values">
      <p v-for="model in models" :key="`${model.id}-accessible`">
        {{ model.name }}: {{ formatCurrency(model.equity) }} equity,
        {{ formatSignedCurrency(model.equity - model.round_starting_equity) }} profit,
        {{ formatPercent(model.return_pct) }} return.
      </p>
    </div>
  </div>

  <div v-else class="empty-state">
    <Icon name="ph:chart-line" aria-hidden="true" />
    <p>Profit history will appear after the first broker reconciliation.</p>
  </div>
</template>

<style scoped>
.arena-chart { min-width: 0; }
.chart-toolbar { display: grid; grid-template-columns: minmax(13rem, .75fr) minmax(24rem, 1fr); align-items: end; gap: 2rem; min-height: 6rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--color-line); }
.chart-focus-copy { display: grid; gap: .15rem; }
.chart-focus-copy > span { color: var(--color-quiet); font-size: .68rem; }
.chart-focus-copy strong { overflow: hidden; font-size: 1.05rem; letter-spacing: -.025em; text-overflow: ellipsis; white-space: nowrap; }
.chart-focus-copy p { overflow: hidden; margin: 0; color: var(--color-body-medium); font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.chart-focus-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; border-left: 1px solid var(--color-line); }
.chart-focus-metrics > div { display: grid; min-width: 0; gap: .2rem; padding: .15rem 1rem; border-right: 1px solid var(--color-line); }
.chart-focus-metrics dt { color: var(--color-quiet); font-size: .66rem; }
.chart-focus-metrics dd { overflow: hidden; margin: 0; font-family: var(--font-mono); font-size: .76rem; font-variant-numeric: tabular-nums; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chart-canvas { min-width: 0; padding: .8rem 1.1rem .15rem; }
.chart-plot-stage { position: relative; width: 100%; aspect-ratio: 1080 / 400; min-height: 19rem; }
.chart-plot-stage > svg { display: block; width: 100%; height: 100%; overflow: visible; touch-action: pan-y; }
.chart-grid-line { stroke: var(--color-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-time-grid { stroke: color-mix(in srgb, var(--color-line) 52%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-zero-line { stroke: var(--color-body-medium); stroke-dasharray: none; stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.chart-axis-label { fill: var(--color-quiet); font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart-time-label { font-size: 11px; }
.model-chart-line { fill: none; stroke: var(--series-accent); stroke-dasharray: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 3.25; vector-effect: non-scaling-stroke; }
.model-chart-line.is-comparison { stroke-width: 2.2; opacity: .82; }
.chart-hover-line { stroke: var(--color-muted); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-hover-point { fill: var(--color-background); stroke: var(--series-accent); stroke-width: 3; vector-effect: non-scaling-stroke; }
.chart-tooltip { position: absolute; top: 1rem; z-index: 2; width: 17rem; padding: .8rem; border: 1px solid var(--color-line-strong); background: var(--color-tooltip); pointer-events: none; transform: translateX(.7rem); }
.chart-tooltip.is-right { transform: translateX(calc(-100% - .7rem)); }
.chart-tooltip time { display: block; margin-bottom: .5rem; color: var(--color-muted); font-family: var(--font-mono); font-size: .68rem; }
.chart-tooltip > div { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .45rem; margin-top: .45rem; font-size: .74rem; }
.chart-tooltip strong { display: flex; gap: .35rem; font-family: var(--font-mono); font-size: .72rem; font-variant-numeric: tabular-nums; font-weight: 550; }
.chart-tooltip strong small { color: var(--color-muted); font-size: .66rem; }
.tooltip-swatch,
.series-swatch { display: block; width: .85rem; height: 2px; background: var(--series-accent); }
.chart-series-index { display: flex; width: 100%; overflow-x: auto; border-top: 1px solid var(--color-line); scrollbar-width: thin; }
.chart-series-index button { display: grid; min-width: 8.7rem; flex: 1 0 8.7rem; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .55rem; padding: .8rem .85rem; border-right: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-muted); cursor: pointer; text-align: left; transition: background-color 160ms ease, color 160ms ease; }
.chart-series-index button:last-child { border-right: 0; }
.chart-series-index button:hover { background: var(--color-surface-raised); color: var(--color-text); }
.chart-series-index button.is-active { background: var(--color-background); color: var(--color-text); box-shadow: inset 0 2px 0 var(--series-accent, var(--color-accent)); }
.chart-series-index button > svg { color: var(--color-accent); font-size: 1rem; }
.chart-series-index button > span:last-child { display: grid; min-width: 0; gap: .08rem; }
.chart-series-index strong,
.chart-series-index small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart-series-index strong { font-size: .7rem; font-weight: 650; }
.chart-series-index small { color: var(--color-quiet); font-family: var(--font-mono); font-size: .64rem; }

@media (max-width: 52rem) {
  .chart-toolbar { grid-template-columns: 1fr; align-items: start; gap: .8rem; }
  .chart-focus-metrics { border-left: 0; }
  .chart-focus-metrics > div:first-child { padding-left: 0; }
  .chart-plot-stage { width: 50rem; }
  .chart-canvas { overflow-x: auto; }
}

@media (max-width: 36rem) {
  .chart-toolbar { padding-inline: 1rem; }
  .chart-focus-metrics { grid-template-columns: 1fr; border-top: 1px solid var(--color-line); }
  .chart-focus-metrics > div { grid-template-columns: 1fr auto; padding: .5rem 0; border-right: 0; border-bottom: 1px solid var(--color-line); }
  .chart-focus-metrics > div:last-child { border-bottom: 0; }
  .chart-canvas { padding-inline: .5rem; }
}
</style>
