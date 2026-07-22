import assert from "node:assert/strict";
import test from "node:test";
import {
  equalCapitalReconciliation,
  externalCapitalFlow,
} from "./capital-reconciliation.ts";

test("ignores an absolute broker valuation gap when both snapshots move together", () => {
  assert.equal(externalCapitalFlow({
    previousBrokerEquity: 3784.5313,
    currentBrokerEquity: 3791.2313,
    previousLedgerEquity: 3805.9094,
    currentLedgerEquity: 3812.6094,
  }), 0);
});

test("detects deposits after removing local portfolio movement", () => {
  assert.equal(externalCapitalFlow({
    previousBrokerEquity: 100,
    currentBrokerEquity: 135,
    previousLedgerEquity: 102,
    currentLedgerEquity: 107,
  }), 30);
});

test("ignores sub-dollar quote timing drift", () => {
  assert.equal(externalCapitalFlow({
    previousBrokerEquity: 100,
    currentBrokerEquity: 101.4,
    previousLedgerEquity: 100,
    currentLedgerEquity: 100.5,
  }), 0);
});

test("does not invent a flow until a prior ledger snapshot exists", () => {
  assert.equal(externalCapitalFlow({
    previousBrokerEquity: 100,
    currentBrokerEquity: 150,
    currentLedgerEquity: 100,
  }), 0);
});

test("splits a capital deposit equally across every agent", () => {
  const result = equalCapitalReconciliation(180, [
    { initialBalance: 25, cashBalance: 20, equity: 27 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
    { initialBalance: 25, cashBalance: 18, equity: 23 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
    { initialBalance: 25, cashBalance: 25, equity: 25 },
  ]);

  assert.deepEqual(result, {
    adjustmentPerAgent: 5,
    currentCapital: 150,
    difference: 30,
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
