<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatCurrency, formatPercent } from "~/utils/format";

const props = defineProps<{
  series: api.EquitySeries[];
  models: api.ArenaModel[];
  positions: api.ArenaPosition[];
  range: "1D" | "5D" | "ALL";
}>();

const width = 1000;
const height = 360;
const padding = { top: 28, right: 24, bottom: 48, left: 68 };
const rangeDuration = {
  "1D": 24 * 60 * 60 * 1000,
  "5D": 5 * 24 * 60 * 60 * 1000,
  ALL: Number.POSITIVE_INFINITY,
} as const;
const dashPatterns = ["none", "10 5", "3 5", "13 4 3 4"];

const focusedAgentId = ref("all");
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

  return props.series.map((item, seriesIndex) => {
    const sorted = item.points.toSorted(
      (left, right) => Date.parse(left.captured_at) - Date.parse(right.captured_at),
    );
    const inRange = sorted.filter((point) => Date.parse(point.captured_at) >= cutoff);
    const preceding = sorted.findLast((point) => Date.parse(point.captured_at) < cutoff);
    const points = preceding
      ? [preceding, ...inRange]
      : inRange.length
        ? inRange
        : sorted.slice(-1);

    return {
      ...item,
      points,
      dash: dashPatterns[seriesIndex % dashPatterns.length],
    };
  }).filter((item) => item.points.length > 0);
});

watch(
  () => props.series.map((item) => item.agent_id).join(","),
  () => {
    if (
      focusedAgentId.value !== "all"
      && !props.series.some((item) => item.agent_id === focusedAgentId.value)
    ) {
      focusedAgentId.value = "all";
    }
  },
);

const activeSeries = computed(() => (
  focusedAgentId.value === "all"
    ? visibleSeries.value
    : visibleSeries.value.filter((item) => item.agent_id === focusedAgentId.value)
));

const chart = computed(() => {
  const values = activeSeries.value.flatMap(
    (item) => item.points.map((point) => point.return_pct),
  );
  const timestamps = activeSeries.value.flatMap(
    (item) => item.points.map((point) => Date.parse(point.captured_at)),
  );
  if (!values.length || !timestamps.length) return null;

  const rawLow = Math.min(0, ...values);
  const rawHigh = Math.max(0, ...values);
  const rawSpread = rawHigh - rawLow;
  const spread = Math.max(rawSpread, 0.02);
  const low = rawLow - spread * 0.14;
  const high = rawHigh + spread * 0.14;
  const timeLow = Math.min(...timestamps);
  const timeHigh = Math.max(...timestamps);
  const safeTimeHigh = timeHigh === timeLow ? timeLow + 1 : timeHigh;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (timestamp: number) => (
    padding.left + ((timestamp - timeLow) / (safeTimeHigh - timeLow)) * plotWidth
  );
  const y = (value: number) => (
    padding.top + ((high - value) / (high - low)) * plotHeight
  );
  const lines = activeSeries.value.map((item) => ({
    ...item,
    path: item.points.map((point, index) => {
      const pointX = x(Date.parse(point.captured_at));
      const pointY = y(point.return_pct);
      return `${index === 0 ? "M" : "L"}${pointX.toFixed(2)},${pointY.toFixed(2)}`;
    }).join(" "),
    last: item.points.at(-1),
  }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = high - (index / 4) * (high - low);
    return { value, y: y(value) };
  });
  const timeTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = timeLow + (index / 4) * (safeTimeHigh - timeLow);
    return { timestamp, x: x(timestamp) };
  });

  return {
    lines,
    grid,
    timeTicks,
    low,
    high,
    span: high - low,
    timeLow,
    timeHigh: safeTimeHigh,
    x,
    y,
    zeroY: y(0),
  };
});

const allSeriesDomain = computed(() => {
  const points = visibleSeries.value.flatMap((item) => item.points);
  if (!points.length) return null;
  const values = points.map((point) => point.return_pct);
  const timestamps = points.map((point) => Date.parse(point.captured_at));
  const rawLow = Math.min(0, ...values);
  const rawHigh = Math.max(0, ...values);
  const spread = Math.max(rawHigh - rawLow, 0.02);
  return {
    low: rawLow - spread * 0.14,
    high: rawHigh + spread * 0.14,
    timeLow: Math.min(...timestamps),
    timeHigh: Math.max(...timestamps),
  };
});

const portfolioCards = computed(() => props.models.map((model) => {
  const item = visibleSeries.value.find((series) => series.agent_id === model.id);
  const modelPositions = props.positions.filter((position) => position.agent_id === model.id);
  return {
    model,
    series: item,
    points: item?.points || [],
    positionValue: modelPositions.reduce((sum, position) => sum + position.market_value, 0),
    symbols: modelPositions.map((position) => position.symbol),
  };
}));

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

function nearestPoint(
  points: api.EquityPoint[],
  target: number,
): api.EquityPoint | undefined {
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

function setHover(event: PointerEvent) {
  if (!chart.value) return;
  const element = event.currentTarget as SVGElement;
  const bounds = element.getBoundingClientRect();
  const relativeX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
  const plotStart = (padding.left / width) * bounds.width;
  const plotWidth = ((width - padding.left - padding.right) / width) * bounds.width;
  const ratio = Math.min(Math.max((relativeX - plotStart) / plotWidth, 0), 1);
  hoverTimestamp.value = chart.value.timeLow
    + ratio * (chart.value.timeHigh - chart.value.timeLow);
}

function focusPortfolio(agentId: string) {
  focusedAgentId.value = agentId;
  hoverTimestamp.value = null;
}

function axisLabel(value: number): string {
  const span = chart.value?.span || 1;
  const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
  const threshold = 0.5 * 10 ** -decimals;
  const normalized = Math.abs(value) < threshold ? 0 : value;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(decimals)}%`;
}

function timeLabel(timestamp: number): string {
  const duration = (chart.value?.timeHigh || timestamp) - (chart.value?.timeLow || timestamp);
  return new Intl.DateTimeFormat("en-US", duration <= 36 * 60 * 60 * 1000
    ? {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      }
    : {
        month: "short",
        day: "numeric",
        timeZone: "America/New_York",
      }).format(timestamp);
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

function miniPath(agentId: string): string {
  const item = visibleSeries.value.find((series) => series.agent_id === agentId);
  const domain = allSeriesDomain.value;
  if (!item?.points.length || !domain) return "";
  const timeSpan = Math.max(domain.timeHigh - domain.timeLow, 1);
  const valueSpan = Math.max(domain.high - domain.low, 0.01);
  return item.points.map((point, index) => {
    const x = ((Date.parse(point.captured_at) - domain.timeLow) / timeSpan) * 160;
    const y = ((domain.high - point.return_pct) / valueSpan) * 44;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function miniZeroY(): number {
  const domain = allSeriesDomain.value;
  if (!domain) return 22;
  return ((domain.high - 0) / Math.max(domain.high - domain.low, 0.01)) * 44;
}
</script>

<template>
  <div v-if="chart" class="arena-chart">
    <div class="chart-toolbar">
      <div>
        <strong>Portfolio comparison</strong>
        <span>All returns share one scale and one Robinhood timeline</span>
      </div>
      <div class="chart-series-controls" role="group" aria-label="Portfolio shown on chart">
        <button
          type="button"
          :aria-pressed="focusedAgentId === 'all'"
          :class="{ 'is-active': focusedAgentId === 'all' }"
          @click="focusPortfolio('all')"
        >
          All portfolios
        </button>
        <button
          v-for="item in visibleSeries"
          :key="item.agent_id"
          type="button"
          :aria-pressed="focusedAgentId === item.agent_id"
          :class="{ 'is-active': focusedAgentId === item.agent_id }"
          :style="{ '--series-accent': item.accent }"
          @click="focusPortfolio(item.agent_id)"
        >
          <span class="series-control-swatch" />
          {{ item.agent_name }}
        </button>
      </div>
    </div>

    <div class="chart-canvas">
      <div class="chart-plot-scroll">
        <div class="chart-plot-stage">
          <svg
            :viewBox="`0 0 ${width} ${height}`"
            role="img"
            :aria-label="focusedAgentId === 'all'
              ? 'Return history for all four isolated model portfolios'
              : `Return history for ${chart.lines[0]?.agent_name}`"
            @pointermove="setHover"
            @pointerleave="hoverTimestamp = null"
          >
            <g v-for="line in chart.grid" :key="line.y">
              <line
                :x1="padding.left"
                :x2="width - padding.right"
                :y1="line.y"
                :y2="line.y"
                class="chart-grid-line"
              />
              <text
                :x="padding.left - 12"
                :y="line.y + 4"
                class="chart-axis-label"
                text-anchor="end"
              >
                {{ axisLabel(line.value) }}
              </text>
            </g>
            <g v-for="tick in chart.timeTicks" :key="tick.timestamp">
              <text
                :x="tick.x"
                :y="height - 15"
                class="chart-axis-label chart-time-label"
                :text-anchor="tick.x === padding.left
                  ? 'start'
                  : tick.x === width - padding.right
                    ? 'end'
                    : 'middle'"
              >
                {{ timeLabel(tick.timestamp) }}
              </text>
            </g>
            <line
              :x1="padding.left"
              :x2="width - padding.right"
              :y1="chart.zeroY"
              :y2="chart.zeroY"
              class="chart-zero-line"
            />
            <g
              v-for="line in chart.lines"
              :key="line.agent_id"
              :style="{
                '--series-accent': line.accent,
                '--series-dash': line.dash,
              }"
            >
              <path :d="line.path" class="model-chart-line" />
              <circle
                v-if="line.last"
                :cx="chart.x(Date.parse(line.last.captured_at))"
                :cy="chart.y(line.last.return_pct)"
                r="4.5"
                class="chart-last-point"
              />
            </g>
            <line
              v-if="hoverTimestamp !== null"
              :x1="chart.x(hoverTimestamp)"
              :x2="chart.x(hoverTimestamp)"
              :y1="padding.top"
              :y2="height - padding.bottom"
              class="chart-hover-line"
            />
            <template v-if="hover">
              <circle
                v-for="item in hover.entries"
                :key="`${item.agentId}-hover`"
                :cx="chart.x(Date.parse(item.point.captured_at))"
                :cy="chart.y(item.point.return_pct)"
                r="5"
                class="chart-hover-point"
                :style="{ '--series-accent': item.accent }"
              />
            </template>
          </svg>

          <div
            v-if="hover"
            class="chart-tooltip"
            :class="{ 'is-right': hover.left > 72 }"
            :style="{ left: `${hover.left}%` }"
          >
            <time :datetime="new Date(hover.timestamp).toISOString()">
              {{ tooltipTime(hover.timestamp) }}
            </time>
            <div v-for="item in hover.entries" :key="item.agentId">
              <span class="legend-swatch is-series" :style="{ '--series-accent': item.accent }" />
              <span>{{ item.name }}</span>
              <strong>
                {{ formatCurrency(item.point.equity) }}
                <small :class="item.point.return_pct >= 0 ? 'value-positive' : 'value-negative'">
                  {{ formatPercent(item.point.return_pct) }}
                </small>
              </strong>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="portfolio-lanes" aria-label="Separated model portfolios">
      <article
        v-for="card in portfolioCards"
        :key="card.model.id"
        class="portfolio-lane"
        :class="{ 'is-focused': focusedAgentId === card.model.id }"
        :style="{ '--series-accent': card.model.accent }"
      >
        <button
          type="button"
          :aria-pressed="focusedAgentId === card.model.id"
          :aria-label="`Show only ${card.model.name} on the comparison chart`"
          @click="focusPortfolio(card.model.id)"
        >
          <ModelGlyph :code="card.model.code" :accent="card.model.accent" size="small" />
          <span>
            <strong>{{ card.model.name }}</strong>
            <small>{{ card.model.strategy }}</small>
          </span>
          <span class="portfolio-lane-return" :class="card.model.return_pct >= 0 ? 'value-positive' : 'value-negative'">
            {{ formatPercent(card.model.return_pct) }}
          </span>
        </button>

        <svg viewBox="0 0 160 44" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" x2="160" :y1="miniZeroY()" :y2="miniZeroY()" />
          <path :d="miniPath(card.model.id)" />
        </svg>

        <dl>
          <div>
            <dt>Equity</dt>
            <dd>{{ formatCurrency(card.model.equity) }}</dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>{{ formatCurrency(card.model.cash_balance) }}</dd>
          </div>
          <div>
            <dt>Invested</dt>
            <dd>{{ formatCurrency(card.positionValue) }}</dd>
          </div>
        </dl>

        <footer>
          <span>{{ card.symbols.length ? card.symbols.join(", ") : "Cash only" }}</span>
          <span>{{ card.points.length }} snapshots</span>
        </footer>
      </article>
    </div>

    <div class="sr-only" aria-label="Latest isolated model portfolio values">
      <p v-for="card in portfolioCards" :key="`${card.model.id}-accessible`">
        {{ card.model.name }}:
        {{ formatCurrency(card.model.equity) }} equity,
        {{ formatCurrency(card.model.cash_balance) }} cash,
        {{ formatPercent(card.model.return_pct) }} return,
        positions {{ card.symbols.join(", ") || "none" }}.
      </p>
    </div>
  </div>

  <div v-else class="empty-state">
    <Icon name="ph:chart-line" aria-hidden="true" />
    <p>Equity history will appear after the first broker reconciliation.</p>
  </div>
</template>
