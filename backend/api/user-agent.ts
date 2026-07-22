import { randomUUID } from "node:crypto";
import { APIError, api } from "encore.dev/api";
import { MaxLen, MinLen } from "encore.dev/validate";
import { currentSubaccount, settingsFor, type SettingsRow, type SubaccountRow } from "./data";
import { db } from "./db";
import { runUserAgentModel, type UserAgentToolEvent } from "./user-agent-openrouter";

interface SendMessageRequest { message: string & MinLen<1> & MaxLen<6000> }
export interface AgentMessageRecord {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
  created_at: Date;
}
interface ActivityExecution {
  id: string; token_in: string; token_out: string; amount_in: string;
  quoted_amount_out: string | null; status: string; transaction_hash: string | null;
  failure_reason: string | null; created_at: Date;
}
interface ActivityRun {
  id: string; trigger: "user" | "continuous"; status: "running" | "completed" | "failed";
  model_id: string; error: string | null; started_at: Date; completed_at: Date | null;
}
export interface UserAgentActivity {
  messages: AgentMessageRecord[];
  executions: ActivityExecution[];
  runs: ActivityRun[];
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}

async function recentConversation(subaccountID: string): Promise<string> {
  const rows = await db.queryAll<AgentMessageRecord>`
    SELECT id, role, content, tool_name, created_at FROM agent_messages
    WHERE subaccount_id = ${subaccountID} AND role IN ('user', 'assistant')
    ORDER BY created_at DESC LIMIT 10
  `;
  return rows.reverse().map((row) => `${row.role}: ${row.content}`).join("\n").slice(-14_000);
}

async function recordTool(subaccountID: string, event: UserAgentToolEvent): Promise<void> {
  const content = event.error
    ? `${event.name.replaceAll("_", " ")} failed: ${event.error}`
    : `${event.name.replaceAll("_", " ")} completed.`;
  await db.exec`
    INSERT INTO agent_messages (id, subaccount_id, role, content, tool_name, metadata)
    VALUES (${randomUUID()}, ${subaccountID}, 'tool', ${content}, ${event.name},
      ${JSON.stringify({ tool_call_id: event.tool_call_id, args: event.args, result: event.result, error: event.error })}::jsonb)
  `;
}

export async function runUserAgentInstruction(
  subaccount: SubaccountRow,
  settings: SettingsRow,
  prompt: string,
  trigger: "user" | "continuous",
  signal?: AbortSignal,
  recordUserMessage = true,
): Promise<{ run_id: string; reply: string }> {
  if (settings.agent_status !== "active") throw APIError.failedPrecondition("start the agent before running it");
  const runID = randomUUID();
  await db.exec`
    INSERT INTO agent_runs (id, subaccount_id, trigger, status, model_provider, model_id)
    VALUES (${runID}, ${subaccount.id}, ${trigger}, 'running', 'openrouter', ${settings.model_id})
  `;
  if (recordUserMessage) {
    await db.exec`INSERT INTO agent_messages (id, subaccount_id, role, content) VALUES (${randomUUID()}, ${subaccount.id}, 'user', ${prompt})`;
  }
  try {
    const reply = await runUserAgentModel({
      runID, subaccount, settings, prompt,
      recentContext: await recentConversation(subaccount.id),
      onTool: (event) => recordTool(subaccount.id, event), signal,
    });
    await db.exec`INSERT INTO agent_messages (id, subaccount_id, role, content) VALUES (${randomUUID()}, ${subaccount.id}, 'assistant', ${reply})`;
    await db.exec`UPDATE agent_runs SET status = 'completed', completed_at = NOW() WHERE id = ${runID}`;
    return { run_id: runID, reply };
  } catch (error) {
    const diagnostic = safeMessage(error);
    console.error(`User agent run ${runID} failed: ${diagnostic}`);
    await db.exec`UPDATE agent_runs SET status = 'failed', error = ${diagnostic}, completed_at = NOW() WHERE id = ${runID}`;
    throw error;
  }
}

export const sendUserAgentMessage = api(
  { expose: true, auth: true, method: "POST", path: "/userapp/messages" },
  async ({ message }: SendMessageRequest): Promise<{ run_id: string; status: "queued" }> => {
    const subaccount = await currentSubaccount();
    const settings = await settingsFor(subaccount.id);
    if (settings.agent_status !== "active") throw APIError.failedPrecondition("start the agent before sending an instruction");
    const id = randomUUID();
    await db.exec`INSERT INTO agent_instructions (id, subaccount_id, content) VALUES (${id}, ${subaccount.id}, ${message.trim()})`;
    await db.exec`
      INSERT INTO agent_messages (id, subaccount_id, role, content, metadata)
      VALUES (${randomUUID()}, ${subaccount.id}, 'user', ${message.trim()}, ${JSON.stringify({ instruction_id: id, status: "queued" })}::jsonb)
    `;
    return { run_id: id, status: "queued" };
  },
);

export const getUserAgentActivity = api(
  { expose: true, auth: true, method: "GET", path: "/userapp/activity" },
  async (): Promise<UserAgentActivity> => {
    const subaccount = await currentSubaccount();
    const messages = await db.queryAll<AgentMessageRecord>`
      SELECT id, role, content, tool_name, created_at FROM agent_messages
      WHERE subaccount_id = ${subaccount.id} ORDER BY created_at DESC LIMIT 80
    `;
    const executions = await db.queryAll<ActivityExecution>`
      SELECT id, token_in, token_out, amount_in::text AS amount_in, quoted_amount_out::text AS quoted_amount_out,
        status, transaction_hash, failure_reason, created_at FROM swap_executions
      WHERE subaccount_id = ${subaccount.id} ORDER BY created_at DESC LIMIT 50
    `;
    const runs = await db.queryAll<ActivityRun>`
      SELECT id, trigger, status, model_id, error, started_at, completed_at FROM agent_runs
      WHERE subaccount_id = ${subaccount.id} ORDER BY started_at DESC LIMIT 50
    `;
    return { messages: messages.reverse(), executions, runs };
  },
);
