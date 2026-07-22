import assert from "node:assert/strict";
import test from "node:test";
import {
  nextUserAgentBreak,
  USER_AGENT_MAX_BREAK_MS,
  USER_AGENT_SUCCESS_BREAK_MS,
} from "./user-agent-cadence.ts";

test("user agent breaks stay short and cap at twenty seconds", () => {
  assert.equal(USER_AGENT_SUCCESS_BREAK_MS, 12_000);
  assert.equal(nextUserAgentBreak(USER_AGENT_SUCCESS_BREAK_MS), 16_000);
  assert.equal(nextUserAgentBreak(16_000), USER_AGENT_MAX_BREAK_MS);
  assert.equal(nextUserAgentBreak(USER_AGENT_MAX_BREAK_MS), USER_AGENT_MAX_BREAK_MS);
});
