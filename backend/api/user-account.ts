import { randomUUID } from "node:crypto";
import { APIError, api } from "encore.dev/api";
import { MaxLen } from "encore.dev/validate";
import { getAddress } from "viem";
import { sealSecret } from "./crypto";
import { currentSubaccount, currentUserID, settingsFor, type SettingsRow, type SubaccountRow } from "./data";
import { db } from "./db";
import { openRouterConfigured, OPENROUTER_MODELS } from "./openrouter";
import { agentAddress, DERIVATION_VERSION, deriveAgentPrivateKey, verifySubaccountSignature } from "./subaccount";
import { SWAP_SLIPPAGE_BPS } from "./tradingPolicy";
import { stopLocalUserAgent } from "./user-agent-continuous";

export interface UserAgentModel {
  id: string;
  name: string;
  provider: string;
  code: string;
  strategy: string;
  thesis: string;
  accent: string;
  openrouter_model: string;
}

export interface AgentSettings {
  model_id: string;
  strategy: string;
  agent_status: "paused" | "active";
  execution_mode: "autonomous";
  minimum_native_reserve_wei: string;
  swap_slippage_bps: number;
}

export interface SubaccountResponse {
  id: string;
  status: "ready" | "error";
  owner_wallet_address: string;
  agent_wallet_address: string;
  derivation_version: number;
  chain_id: 4663;
  explorer_url: string;
  created_at: Date;
  settings: AgentSettings;
}

interface ProvisionRequest { owner_wallet_address: string; signature: string & MaxLen<4096> }
interface UpdateSettingsRequest {
  model_id?: string & MaxLen<80>;
  strategy?: string & MaxLen<6000>;
  minimum_native_reserve_wei?: string & MaxLen<79>;
}
interface SetAgentStatusRequest { status: "paused" | "active" }

function publicSettings(row: SettingsRow): AgentSettings {
  return {
    model_id: row.model_id,
    strategy: row.strategy,
    agent_status: row.agent_status,
    execution_mode: row.execution_mode,
    minimum_native_reserve_wei: row.minimum_native_reserve_wei,
    swap_slippage_bps: SWAP_SLIPPAGE_BPS,
  };
}

function responseFor(row: SubaccountRow, settings: SettingsRow): SubaccountResponse {
  return {
    id: row.id,
    status: row.status,
    owner_wallet_address: row.owner_wallet_address,
    agent_wallet_address: row.agent_wallet_address,
    derivation_version: row.derivation_version,
    chain_id: row.chain_id,
    explorer_url: `https://robinhoodchain.blockscout.com/address/${row.agent_wallet_address}`,
    created_at: row.created_at,
    settings: publicSettings(settings),
  };
}

export const listUserAgentModels = api(
  { expose: true, method: "GET", path: "/userapp/models" },
  async (): Promise<{ models: UserAgentModel[] }> => ({
    models: await db.queryAll<UserAgentModel>`
      SELECT id, name, provider, code, strategy, thesis, accent, openrouter_model
      FROM arena_agents WHERE status = 'active' ORDER BY created_at ASC
    `,
  }),
);

export const provisionUserAgent = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/userapp/account" },
  async (request: ProvisionRequest): Promise<SubaccountResponse> => {
    const userID = currentUserID();
    const existing = await db.queryRow<SubaccountRow>`SELECT * FROM trading_subaccounts WHERE owner_user_id = ${userID}`;
    if (existing) return responseFor(existing, await settingsFor(existing.id));
    let owner: string;
    try { owner = await verifySubaccountSignature(request.owner_wallet_address, request.signature); }
    catch { throw APIError.unauthenticated("could not verify the wallet signature"); }
    if (getAddress(owner) !== getAddress(userID)) throw APIError.permissionDenied("the signing wallet does not match the session");
    const privateKey = deriveAgentPrivateKey(request.signature);
    const id = randomUUID();
    const row = await db.queryRow<SubaccountRow>`
      INSERT INTO trading_subaccounts (
        id, owner_user_id, owner_wallet_id, owner_wallet_address, agent_wallet_address,
        encrypted_agent_private_key, derivation_version, chain_id
      ) VALUES (
        ${id}, ${userID}, ${null}, ${owner}, ${agentAddress(privateKey)},
        ${sealSecret(privateKey, `agent-key:${id}`)}, ${DERIVATION_VERSION}, 4663
      ) RETURNING *
    `;
    if (!row) throw APIError.internal("the agent wallet could not be created");
    await db.exec`INSERT INTO agent_settings (subaccount_id) VALUES (${id})`;
    return responseFor(row, await settingsFor(id));
  },
);

export const getUserAgentAccount = api(
  { expose: true, auth: true, method: "GET", path: "/userapp/account" },
  async (): Promise<SubaccountResponse> => {
    const row = await currentSubaccount();
    return responseFor(row, await settingsFor(row.id));
  },
);

export const updateUserAgentSettings = api(
  { expose: true, auth: true, method: "PATCH", path: "/userapp/settings" },
  async (request: UpdateSettingsRequest): Promise<AgentSettings> => {
    const subaccount = await currentSubaccount();
    const current = await settingsFor(subaccount.id);
    const modelID = request.model_id ?? current.model_id;
    if (!OPENROUTER_MODELS.some((model) => model.agent_id === modelID)) {
      throw APIError.invalidArgument("select a model available in the arena");
    }
    const reserve = request.minimum_native_reserve_wei ?? current.minimum_native_reserve_wei;
    if (!/^(0|[1-9][0-9]{0,77})$/.test(reserve)) throw APIError.invalidArgument("the fee reserve must be an unsigned base-unit integer");
    await db.exec`
      UPDATE agent_settings SET model_id = ${modelID}, strategy = ${request.strategy?.trim() ?? current.strategy},
        minimum_native_reserve_wei = ${reserve}, updated_at = NOW()
      WHERE subaccount_id = ${subaccount.id}
    `;
    return publicSettings(await settingsFor(subaccount.id));
  },
);

export const setUserAgentStatus = api(
  { expose: true, auth: true, method: "POST", path: "/userapp/status" },
  async ({ status }: SetAgentStatusRequest): Promise<AgentSettings> => {
    const subaccount = await currentSubaccount();
    const settings = await settingsFor(subaccount.id);
    if (status === "active" && settings.strategy.trim().length < 20) {
      throw APIError.failedPrecondition("write a specific trading strategy before starting the agent");
    }
    if (status === "active" && !openRouterConfigured()) {
      throw APIError.failedPrecondition("OpenRouter is unavailable. Try again later.");
    }
    await db.exec`
      UPDATE agent_settings SET agent_status = ${status},
        runner_lease_owner = CASE WHEN ${status} = 'paused' THEN NULL ELSE runner_lease_owner END,
        runner_lease_until = CASE WHEN ${status} = 'paused' THEN NULL ELSE runner_lease_until END,
        updated_at = NOW() WHERE subaccount_id = ${subaccount.id}
    `;
    if (status === "paused") stopLocalUserAgent(subaccount.id);
    return publicSettings(await settingsFor(subaccount.id));
  },
);
