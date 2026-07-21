import assert from "node:assert/strict";
import test from "node:test";
import { equalCapitalReconciliation } from "./capital-reconciliation.ts";

test("splits a capital deposit equally across every agent", () => {
  const result = equalCapitalReconciliation(150, [
    { initialBalance: 25, cashBalance: 20, equity: 27 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
    { initialBalance: 25, cashBalance: 18, equity: 23 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
  ]);

  assert.deepEqual(result, {
    adjustmentPerAgent: 5,
    currentCapital: 125,
    difference: 25,
  });
});

test("preserves four-decimal equality for cent-denominated capital", () => {
  const result = equalCapitalReconciliation(100.01, [
    { initialBalance: 20, cashBalance: 20, equity: 20 },
    { initialBalance: 20, cashBalance: 20, equity: 20 },
    { initialBalance: 20, cashBalance: 20, equity: 20 },
    { initialBalance: 20, cashBalance: 20, equity: 20 },
  ]);

  assert.equal(result.adjustmentPerAgent, 5.0025);
  assert.equal(result.difference, 20.01);
});

test("does not treat portfolio gains as contributed capital", () => {
  const result = equalCapitalReconciliation(104, [
    { initialBalance: 25, cashBalance: 20, equity: 27 },
    { initialBalance: 25, cashBalance: 25, equity: 26 },
    { initialBalance: 25, cashBalance: 18, equity: 24 },
    { initialBalance: 25, cashBalance: 25, equity: 27 },
  ]);

  assert.deepEqual(result, {
    adjustmentPerAgent: 0,
    currentCapital: 104,
    difference: 0,
  });
});

test("rejects a withdrawal that cannot be taken equally from agent cash", () => {
  assert.throws(
    () => equalCapitalReconciliation(60, [
      { initialBalance: 25, cashBalance: 2, equity: 25 },
      { initialBalance: 25, cashBalance: 25, equity: 25 },
      { initialBalance: 25, cashBalance: 25, equity: 25 },
      { initialBalance: 25, cashBalance: 25, equity: 25 },
    ]),
    /exceeds at least one agent's available cash/,
  );
});
