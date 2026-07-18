export const COMPETITION_ROUND_DAYS = 7;
export const DECISION_CYCLE_MINUTES = 60;
export const SCHEDULED_CYCLE_GRACE_MINUTES = 15;

const marketClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface MarketClockParts {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_MARKET_CLOSE_MINUTES = 16 * 60;
const EARLY_MARKET_CLOSE_MINUTES = 13 * 60;
const FIRST_DECISION_OFFSET_MINUTES = 5;
const SCHEDULER_TICK_MINUTES = 5;
const MAX_SCHEDULE_LOOKAHEAD_DAYS = 8;

function marketClockParts(at: Date): MarketClockParts | undefined {
  const parts = Object.fromEntries(
    marketClock.formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (
    !parts.weekday
    || ![year, month, day, hour, minute].every(Number.isInteger)
  ) {
    return undefined;
  }
  return { weekday: parts.weekday, year, month, day, hour, minute };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function keyForDate(date: Date): string {
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const holiday = utcDate(year, month, day);
  const weekday = holiday.getUTCDay();
  if (weekday === 6) holiday.setUTCDate(holiday.getUTCDate() - 1);
  if (weekday === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
  return keyForDate(holiday);
}

function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): string {
  const first = utcDate(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  first.setUTCDate(1 + offset + (occurrence - 1) * 7);
  return keyForDate(first);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = utcDate(year, month + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  last.setUTCDate(last.getUTCDate() - offset);
  return keyForDate(last);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

function marketHolidays(year: number): Set<string> {
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1),
    observedFixedHoliday(year + 1, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    keyForDate(goodFriday),
    lastWeekday(year, 5, 1),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25),
  ]);
  if (year >= 2022) holidays.add(observedFixedHoliday(year, 6, 19));
  return holidays;
}

function earlyCloseDays(year: number): Set<string> {
  const thanksgiving = utcDate(year, 11, 1);
  const thanksgivingOffset = (4 - thanksgiving.getUTCDay() + 7) % 7;
  thanksgiving.setUTCDate(1 + thanksgivingOffset + 3 * 7);
  const dayAfterThanksgiving = new Date(thanksgiving);
  dayAfterThanksgiving.setUTCDate(dayAfterThanksgiving.getUTCDate() + 1);

  const earlyCloses = new Set([keyForDate(dayAfterThanksgiving)]);
  const julyThird = utcDate(year, 7, 3);
  if (julyThird.getUTCDay() >= 1 && julyThird.getUTCDay() <= 5) {
    earlyCloses.add(keyForDate(julyThird));
  }
  const christmasEve = utcDate(year, 12, 24);
  if (christmasEve.getUTCDay() >= 1 && christmasEve.getUTCDay() <= 5) {
    earlyCloses.add(keyForDate(christmasEve));
  }
  return earlyCloses;
}

function marketCloseMinutes(parts: MarketClockParts): number | undefined {
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday)) return undefined;
  const key = dateKey(parts.year, parts.month, parts.day);
  if (marketHolidays(parts.year).has(key)) return undefined;
  return earlyCloseDays(parts.year).has(key)
    ? EARLY_MARKET_CLOSE_MINUTES
    : REGULAR_MARKET_CLOSE_MINUTES;
}

export function regularMarketSessionOpen(at = new Date()): boolean {
  const parts = marketClockParts(at);
  if (!parts) return false;
  const close = marketCloseMinutes(parts);
  if (!close) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= MARKET_OPEN_MINUTES && minutes < close;
}

export function nextDecisionCycleAt(after = new Date()): Date {
  const tickMs = SCHEDULER_TICK_MINUTES * 60 * 1000;
  const firstCandidate = Math.floor(after.getTime() / tickMs) * tickMs + tickMs;
  const maximumCandidates = (
    MAX_SCHEDULE_LOOKAHEAD_DAYS * 24 * 60
  ) / SCHEDULER_TICK_MINUTES;

  for (let index = 0; index <= maximumCandidates; index += 1) {
    const candidate = new Date(firstCandidate + index * tickMs);
    const parts = marketClockParts(candidate);
    if (!parts) continue;
    const close = marketCloseMinutes(parts);
    if (!close) continue;
    const localMinutes = parts.hour * 60 + parts.minute;
    const minutesFromFirstCycle = localMinutes
      - (MARKET_OPEN_MINUTES + FIRST_DECISION_OFFSET_MINUTES);
    if (
      localMinutes < close
      && minutesFromFirstCycle >= 0
      && minutesFromFirstCycle % DECISION_CYCLE_MINUTES === 0
    ) {
      return candidate;
    }
  }
  throw new Error("could not find the next regular U.S. market decision cycle");
}

export function scheduledCycleIsRetry(
  nextCycleAt: Date | string,
  retryAt: Date | string | null,
): boolean {
  if (!retryAt) return false;
  const next = new Date(nextCycleAt).getTime();
  const retry = new Date(retryAt).getTime();
  return Number.isFinite(next)
    && Number.isFinite(retry)
    && Math.abs(next - retry) < 60_000;
}

export function competitionProgress(
  startedAt: Date | string,
  endsAt: Date | string,
  now = Date.now(),
): number {
  const started = new Date(startedAt).getTime();
  const ends = new Date(endsAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ends) || ends <= started) return 0;
  return Math.max(0, Math.min(100, ((now - started) / (ends - started)) * 100));
}
