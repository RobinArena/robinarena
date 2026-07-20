import assert from "node:assert/strict";
import test from "node:test";
import { robinhoodOrderArguments } from "./robinhood-order.ts";

test("regular-hours order arguments match Robinhood's strict schema", () => {
  assert.deepEqual(
    robinhoodOrderArguments("agentic-account", {
      symbol: "NVDA",
      side: "buy",
      amount: 10.03,
      marketHours: "regular_hours",
    }),
    {
      account_number: "agentic-account",
      symbol: "NVDA",
      side: "buy",
      type: "market",
      time_in_force: "gfd",
      market_hours: "regular_hours",
      dollar_amount: "10.03",
    },
  );
});

test("all-day order arguments contain only whole-share limit fields", () => {
  assert.deepEqual(
    robinhoodOrderArguments("agentic-account", {
      symbol: "NVDA",
      side: "buy",
      quantity: 1,
      limitPrice: 185.5,
      marketHours: "all_day_hours",
    }),
    {
      account_number: "agentic-account",
      symbol: "NVDA",
      side: "buy",
      type: "limit",
      time_in_force: "gfd",
      market_hours: "all_day_hours",
      quantity: "1",
      limit_price: "185.5",
    },
  );
});
