import assert from "node:assert/strict";
import test from "node:test";
import {
  arenaTradingSession,
  arenaTradingSessionOpen,
  nextDecisionCycleAt,
  regularMarketSessionOpen,
  SCHEDULED_CYCLE_GRACE_MINUTES,
  scheduledCycleIsRetry,
} from "./arena-time.ts";

test("regular market sessions exclude closed periods and exchange holidays", () => {
  assert.equal(regularMarketSessionOpen(new Date("2026-07-17T14:00:00Z")), true);
  assert.equal(regularMarketSessionOpen(new Date("2026-07-17T20:00:00Z")), false);
  assert.equal(regularMarketSessionOpen(new Date("2026-07-18T14:00:00Z")), false);
  assert.equal(regularMarketSessionOpen(new Date("2026-07-03T14:00:00Z")), false);
  assert.equal(regularMarketSessionOpen(new Date("2026-04-03T14:00:00Z")), false);
});

test("broker order sessions are classified without blocking the arena clock", () => {
  assert.equal(
    arenaTradingSession(new Date("2026-07-17T11:30:00Z")),
    "extended_hours",
  );
  assert.equal(
    arenaTradingSession(new Date("2026-07-17T14:00:00Z")),
    "regular_hours",
  );
  assert.equal(
    arenaTradingSession(new Date("2026-07-17T20:30:00Z")),
    "extended_hours",
  );
  assert.equal(arenaTradingSessionOpen(new Date("2026-07-17T23:59:00Z")), true);
  assert.equal(
    arenaTradingSession(new Date("2026-07-18T00:00:00Z")),
    "all_day_hours",
  );
  assert.equal(arenaTradingSessionOpen(new Date("2026-07-18T00:00:00Z")), true);
});

test("early-close days retain Robinhood's shortened extended session", () => {
  assert.equal(regularMarketSessionOpen(new Date("2026-11-27T17:30:00Z")), true);
  assert.equal(regularMarketSessionOpen(new Date("2026-11-27T18:00:00Z")), false);
  assert.equal(
    arenaTradingSession(new Date("2026-11-27T18:00:00Z")),
    "extended_hours",
  );
  assert.equal(arenaTradingSessionOpen(new Date("2026-11-27T21:59:00Z")), true);
  assert.equal(
    arenaTradingSession(new Date("2026-11-27T22:00:00Z")),
    "all_day_hours",
  );
});

test("automatic cycles use fixed hourly slots around the clock", () => {
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-18T00:46:00Z")).toISOString(),
    "2026-07-18T01:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-20T13:36:00Z")).toISOString(),
    "2026-07-20T14:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-17T20:00:00Z")).toISOString(),
    "2026-07-17T20:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-17T23:36:00Z")).toISOString(),
    "2026-07-18T00:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-11-27T17:36:00Z")).toISOString(),
    "2026-11-27T18:35:00.000Z",
  );
  assert.equal(SCHEDULED_CYCLE_GRACE_MINUTES, 15);
});

test("failed-cycle retries remain distinct from manual-cycle deduplication", () => {
  const retryAt = new Date("2026-07-20T14:40:00Z");
  assert.equal(scheduledCycleIsRetry(retryAt, retryAt), true);
  assert.equal(
    scheduledCycleIsRetry(retryAt, new Date("2026-07-20T14:35:00Z")),
    false,
  );
  assert.equal(scheduledCycleIsRetry(retryAt, null), false);
});
