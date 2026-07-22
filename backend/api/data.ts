import { APIError } from "encore.dev/api";
import { getAuthData } from "encore.dev/internal/codegen/auth";
import type { AuthData } from "./gateway";
import { db } from "./db";
import { openSecret, sealSecret, usesLegacyEncryption } from "./crypto";

export type RobinhoodChainID = 4663;

export interface SubaccountRow {
  id: string;
  owner_user_id: string;
  owner_wallet_id: string | null;
  owner_wallet_address: string;
  agent_wallet_address: string;
  encrypted_agent_private_key: string;
  derivation_version: number;
  chain_id: RobinhoodChainID;
  status: "ready" | "error";
  created_at: Date;
  updated_at: Date;
}

export interface SettingsRow {
  subaccount_id: string;
  model_id: string;
  strategy: string;
  agent_status: "paused" | "active";
  execution_mode: "autonomous";
  minimum_native_reserve_wei: string;
  updated_at: Date;
}

export function currentUserID(): string {
  const auth = getAuthData() as AuthData | null;
  if (!auth?.userID || auth.role !== "user") throw APIError.unauthenticated("connect your wallet to continue");
  return auth.userID;
}

export async function currentSubaccount(): Promise<SubaccountRow> {
  const row = await db.queryRow<SubaccountRow>`
    SELECT id, owner_user_id, owner_wallet_id, owner_wallet_address, agent_wallet_address,
      encrypted_agent_private_key, derivation_version, chain_id, status, created_at, updated_at
    FROM trading_subaccounts WHERE owner_user_id = ${currentUserID()}
  `;
  if (!row) throw APIError.failedPrecondition("create your Robinhood Chain agent wallet before continuing");
  if (usesLegacyEncryption(row.encrypted_agent_private_key)) {
    const scope = `agent-key:${row.id}`;
    const rewrapped = sealSecret(openSecret(row.encrypted_agent_private_key, scope), scope);
    await db.exec`
      UPDATE trading_subaccounts SET encrypted_agent_private_key = ${rewrapped}, updated_at = NOW()
      WHERE id = ${row.id} AND encrypted_agent_private_key = ${row.encrypted_agent_private_key}
    `;
    row.encrypted_agent_private_key = rewrapped;
  }
  return row;
}

export async function settingsFor(subaccountID: string): Promise<SettingsRow> {
  const row = await db.queryRow<SettingsRow>`
    SELECT subaccount_id, model_id, strategy, agent_status, execution_mode,
      minimum_native_reserve_wei::text AS minimum_native_reserve_wei, updated_at
    FROM agent_settings WHERE subaccount_id = ${subaccountID}
  `;
  if (!row) throw APIError.internal("agent settings were not provisioned");
  return row;
}
