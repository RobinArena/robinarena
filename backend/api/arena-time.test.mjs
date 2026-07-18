import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("early-close sessions stop live cycles at 1 PM Eastern", () => {
  assert.equal(regularMarketSessionOpen(new Date("2026-11-27T17:30:00Z")), true);
  assert.equal(regularMarketSessionOpen(new Date("2026-11-27T18:00:00Z")), false);
});

test("automatic cycles use fixed hourly market slots", () => {
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-18T00:46:00Z")).toISOString(),
    "2026-07-20T13:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-07-20T13:36:00Z")).toISOString(),
    "2026-07-20T14:35:00.000Z",
  );
  assert.equal(
    nextDecisionCycleAt(new Date("2026-11-27T17:36:00Z")).toISOString(),
    "2026-11-30T14:35:00.000Z",
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
