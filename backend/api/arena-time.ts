export const COMPETITION_ROUND_DAYS = 7;
export const DECISION_CYCLE_MINUTES = 60;

const marketClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function regularMarketSessionOpen(at = new Date()): boolean {
  const parts = Object.fromEntries(
    marketClock.formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday || "")) return false;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
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
