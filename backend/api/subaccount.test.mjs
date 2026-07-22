import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_WARNING,
  DERIVATION_CHAIN_ID,
  DERIVATION_VERSION,
  deriveAgentPrivateKey,
  subaccountMessage,
} from "./subaccount.ts";

test("agent wallet authorization and derivation are scoped to RobinArena", () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const signature = `0x${"22".repeat(65)}`;
  const message = subaccountMessage(owner);

  assert.equal(DERIVATION_VERSION, 3);
  assert.equal(DERIVATION_CHAIN_ID, 4663);
  assert.match(message, /RobinArena/);
  assert.match(message, /https:\/\/robinarena\.fun\/userapp/);
  assert.match(message, /separate wallet/);
  assert.equal(message.includes(ACCESS_WARNING), true);
  assert.equal(deriveAgentPrivateKey(signature), deriveAgentPrivateKey(signature));
});
