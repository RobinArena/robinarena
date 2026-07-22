import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { db } from "./db";
import { settingsFor, type SubaccountRow } from "./data";
import { runUserAgentInstruction } from "./user-agent";
import {
  nextUserAgentBreak,
  USER_AGENT_MAX_BREAK_MS,
  USER_AGENT_SUCCESS_BREAK_MS,
} from "./user-agent-cadence";

const INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID()}`;
const runners = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
let started = false;
let scanning = false;

async function claim(id: string): Promise<boolean> {
  return Boolean(await db.queryRow`
    UPDATE agent_settings SET runner_lease_owner = ${INSTANCE_ID}, runner_lease_until = NOW() + INTERVAL '30 seconds'
    WHERE subaccount_id = ${id} AND agent_status = 'active'
      AND (runner_lease_owner = ${INSTANCE_ID} OR runner_lease_until IS NULL OR runner_lease_until < NOW())
    RETURNING subaccount_id
  `);
}

async function heartbeat(id: string): Promise<boolean> {
  return Boolean(await db.queryRow`
    UPDATE agent_settings SET runner_lease_until = NOW() + INTERVAL '30 seconds'
    WHERE subaccount_id = ${id} AND runner_lease_owner = ${INSTANCE_ID} AND agent_status = 'active'
    RETURNING subaccount_id
  `);
}

function wait(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, Math.min(milliseconds, USER_AGENT_MAX_BREAK_MS));
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function run(id: string): Promise<void> {
  const controller = new AbortController();
  controllers.set(id, controller);
  const pulse = setInterval(() => { void heartbeat(id).then((ok) => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 8_000);
  pulse.unref();
  try {
    await db.exec`UPDATE agent_instructions SET status = 'pending', started_at = NULL WHERE subaccount_id = ${id} AND status = 'processing'`;
    let retryBreak = USER_AGENT_SUCCESS_BREAK_MS;
    while (!controller.signal.aborted && await heartbeat(id)) {
      const subaccount = await db.queryRow<SubaccountRow>`SELECT * FROM trading_subaccounts WHERE id = ${id} AND status = 'ready'`;
      if (!subaccount) break;
      const settings = await settingsFor(id);
      if (settings.agent_status !== "active") break;
      const instruction = await db.queryRow<{ id: string; content: string }>`
        UPDATE agent_instructions SET status = 'processing', started_at = NOW()
        WHERE id = (SELECT id FROM agent_instructions WHERE subaccount_id = ${id} AND status = 'pending'
          ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, content
      `;
      try {
        const result = await runUserAgentInstruction(
          subaccount, settings,
          instruction?.content ?? "Run the next strategy cycle. Read live balances, research current Robinhood Chain opportunities, and execute any qualifying trade now.",
          instruction ? "user" : "continuous", controller.signal, !instruction,
        );
        if (instruction) await db.exec`UPDATE agent_instructions SET status = 'completed', run_id = ${result.run_id}, completed_at = NOW() WHERE id = ${instruction.id}`;
        retryBreak = USER_AGENT_SUCCESS_BREAK_MS;
      } catch {
        if (instruction) await db.exec`UPDATE agent_instructions SET status = 'pending', started_at = NULL WHERE id = ${instruction.id}`.catch(() => undefined);
        retryBreak = nextUserAgentBreak(retryBreak);
      }
      await wait(controller.signal, retryBreak);
    }
  } finally {
    clearInterval(pulse);
    controllers.delete(id);
    await db.exec`UPDATE agent_settings SET runner_lease_owner = NULL, runner_lease_until = NULL WHERE subaccount_id = ${id} AND runner_lease_owner = ${INSTANCE_ID}`.catch(() => undefined);
  }
}

async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const rows = await db.queryAll<{ subaccount_id: string }>`
      SELECT subaccount_id FROM agent_settings WHERE agent_status = 'active'
        AND (runner_lease_owner = ${INSTANCE_ID} OR runner_lease_until IS NULL OR runner_lease_until < NOW())
      ORDER BY updated_at ASC LIMIT 32
    `;
    for (const row of rows) {
      if (runners.has(row.subaccount_id) || !await claim(row.subaccount_id)) continue;
      runners.set(row.subaccount_id, run(row.subaccount_id).finally(() => runners.delete(row.subaccount_id)));
    }
  } finally { scanning = false; }
}

export function ensureUserAgentCoordinator(): void {
  if (started) return;
  started = true;
  const initial = setTimeout(() => void scan(), 1_000); initial.unref();
  const timer = setInterval(() => void scan(), 5_000); timer.unref();
}

export function stopLocalUserAgent(id: string): void { controllers.get(id)?.abort(); }
