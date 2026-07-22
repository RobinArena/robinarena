import assert from "node:assert/strict";
import test from "node:test";

import { hasTradeFinderAccess } from "./tradefinder-access.ts";

test("TradeFinder access requires at least one hundred whole tokens", () => {
  assert.equal(hasTradeFinderAccess(99_999_999n, 6), false);
  assert.equal(hasTradeFinderAccess(100_000_000n, 6), true);
  assert.equal(hasTradeFinderAccess(100_000_001n, 6), true);
  assert.equal(hasTradeFinderAccess(100n, 0), true);
});
