import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { APIError } from "encore.dev/api";
import { db } from "./db";
import { arenaOperatorKey, readOptionalSecret, robinhoodMcpAccessToken } from "./secrets";

const MCP_RESOURCE = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_REGISTRATION_ENDPOINT = "https://agent.robinhood.com/oauth/trading/register";
const DEFAULT_AUTHORIZATION_ENDPOINT = "https://robinhood.com/oauth";
const DEFAULT_TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";
const OAUTH_SCOPE = "internal";

interface OAuthRow {
  client_id: string | null;
  redirect_uri: string | null;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
  access_expires_at: Date | string | null;
  token_scope: string | null;
  oauth_state_hash: string | null;
  code_verifier_ciphertext: string | null;
  oauth_started_at: Date | string | null;
  connected_at: Date | string | null;
}

interface RegistrationResponse {
  client_id?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface RobinhoodOAuthStatus {
  connected: boolean;
  expires_at?: string;
  started_at?: string;
}

let accessTokenPromise: Promise<string> | undefined;

function registrationEndpoint(): string {
  return process.env.ROBINHOOD_OAUTH_REGISTRATION_URL?.trim() || DEFAULT_REGISTRATION_ENDPOINT;
}

function authorizationEndpoint(): string {
  return process.env.ROBINHOOD_OAUTH_AUTHORIZATION_URL?.trim() || DEFAULT_AUTHORIZATION_ENDPOINT;
}

function tokenEndpoint(): string {
  return process.env.ROBINHOOD_OAUTH_TOKEN_URL?.trim() || DEFAULT_TOKEN_ENDPOINT;
}

function operatorEncryptionSecret(): string {
  const value = readOptionalSecret(arenaOperatorKey)
    || process.env.ARENA_OPERATOR_KEY?.trim()
    || (process.env.NODE_ENV !== "production" ? "dev-model-market" : undefined);
  if (!value) throw APIError.failedPrecondition("ArenaOperatorKey is required for encrypted Robinhood OAuth storage");
  return value;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(operatorEncryptionSecret()).digest();
}

function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function unseal(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("stored Robinhood OAuth data is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sameHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validRedirectUri(value: string): URL {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw APIError.invalidArgument("redirect_uri must be an absolute URL");
  }
  const localHttp = redirect.protocol === "http:"
    && (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1");
  if (redirect.protocol !== "https:" && !localHttp) {
    throw APIError.invalidArgument("redirect_uri must use HTTPS, except on localhost");
  }
  if (redirect.pathname !== "/api/admin/robinhood/callback") {
    throw APIError.invalidArgument("redirect_uri must target /api/admin/robinhood/callback");
  }
  redirect.search = "";
  redirect.hash = "";
  return redirect;
}

async function oauthRow(): Promise<OAuthRow | null> {
  return db.queryRow<OAuthRow>`SELECT * FROM arena_robinhood_oauth WHERE id = 1`;
}

async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned HTTP ${response.status} without JSON`);
  }
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const detail = String(record.error_description || record.error || text || `HTTP ${response.status}`);
    throw new Error(`${label}: ${detail.slice(0, 300)}`);
  }
  return value as T;
}

async function registerClient(redirectUri: string): Promise<string> {
  const response = await fetch(registrationEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Model Market",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await jsonResponse<RegistrationResponse>(response, "Robinhood OAuth registration");
  if (typeof payload.client_id !== "string" || !payload.client_id) {
    throw new Error("Robinhood OAuth registration returned no client ID");
  }
  return payload.client_id;
}

async function tokenRequest(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(20_000),
  });
  return jsonResponse<TokenResponse>(response, "Robinhood OAuth token exchange");
}

function tokenFields(payload: TokenResponse): {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope?: string;
} {
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Robinhood OAuth returned no access token");
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Robinhood OAuth returned an invalid access-token lifetime");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : undefined,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export async function startRobinhoodOAuth(redirectUriValue: string): Promise<string> {
  const redirectUri = validRedirectUri(redirectUriValue).toString();
  const existing = await oauthRow();
  const clientId = existing?.client_id && existing.redirect_uri === redirectUri
    ? existing.client_id
    : await registerClient(redirectUri);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = hash(verifier);
  await db.exec`
    INSERT INTO arena_robinhood_oauth (
      id, client_id, redirect_uri, oauth_state_hash, code_verifier_ciphertext,
      oauth_started_at, updated_at
    ) VALUES (
      1, ${clientId}, ${redirectUri}, ${hash(state)}, ${seal(verifier)}, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      client_id = excluded.client_id,
      redirect_uri = excluded.redirect_uri,
      oauth_state_hash = excluded.oauth_state_hash,
      code_verifier_ciphertext = excluded.code_verifier_ciphertext,
      oauth_started_at = now(),
      updated_at = now()
  `;
  const authorization = new URL(authorizationEndpoint());
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", OAUTH_SCOPE);
  authorization.searchParams.set("resource", MCP_RESOURCE);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  return authorization.toString();
}

export async function completeRobinhoodOAuth(code: string, state: string): Promise<string> {
  const row = await oauthRow();
  if (!row?.client_id || !row.redirect_uri || !row.oauth_state_hash || !row.code_verifier_ciphertext) {
    throw new Error("Robinhood OAuth was not started from the operator console");
  }
  if (!row.oauth_started_at || Date.now() - new Date(row.oauth_started_at).getTime() > 15 * 60_000) {
    throw new Error("Robinhood OAuth authorization expired; start it again from /admin");
  }
  if (!sameHash(hash(state), row.oauth_state_hash)) throw new Error("Robinhood OAuth state did not match");
  const payload = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    code_verifier: unseal(row.code_verifier_ciphertext),
    resource: MCP_RESOURCE,
  });
  const token = tokenFields(payload);
  if (!token.refreshToken) throw new Error("Robinhood OAuth returned no refresh token");
  await db.exec`
    UPDATE arena_robinhood_oauth SET
      access_token_ciphertext = ${seal(token.accessToken)},
      refresh_token_ciphertext = ${seal(token.refreshToken)},
      access_expires_at = ${token.expiresAt}, token_scope = ${token.scope || OAUTH_SCOPE},
      oauth_state_hash = NULL, code_verifier_ciphertext = NULL,
      oauth_started_at = NULL, connected_at = now(), updated_at = now()
    WHERE id = 1
  `;
  await db.exec`
    UPDATE arena_state SET robinhood_oauth_connected = true,
      robinhood_oauth_expires_at = ${token.expiresAt}, robinhood_error = NULL,
      scheduler_consecutive_failures = 0, scheduler_retry_at = NULL,
      updated_at = now()
    WHERE id = 1
  `;
  accessTokenPromise = undefined;
  const redirect = new URL(row.redirect_uri);
  return `${redirect.origin}/admin?robinhood=connected`;
}

async function refreshStoredAccessToken(row: OAuthRow): Promise<string> {
  if (!row.client_id || !row.refresh_token_ciphertext) {
    throw APIError.failedPrecondition("Reconnect Robinhood from /admin");
  }
  const payload = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: unseal(row.refresh_token_ciphertext),
    client_id: row.client_id,
    resource: MCP_RESOURCE,
  });
  const token = tokenFields(payload);
  await db.exec`
    UPDATE arena_robinhood_oauth SET
      access_token_ciphertext = ${seal(token.accessToken)},
      refresh_token_ciphertext = coalesce(${token.refreshToken ? seal(token.refreshToken) : null}, refresh_token_ciphertext),
      access_expires_at = ${token.expiresAt}, token_scope = ${token.scope || row.token_scope || OAUTH_SCOPE},
      updated_at = now()
    WHERE id = 1
  `;
  await db.exec`
    UPDATE arena_state SET robinhood_oauth_connected = true,
      robinhood_oauth_expires_at = ${token.expiresAt}, robinhood_error = NULL, updated_at = now()
    WHERE id = 1
  `;
  return token.accessToken;
}

async function resolveAccessToken(): Promise<string> {
  const row = await oauthRow();
  if (row?.access_token_ciphertext && row.access_expires_at) {
    if (new Date(row.access_expires_at).getTime() > Date.now() + 60_000) {
      return unseal(row.access_token_ciphertext);
    }
    try {
      return await refreshStoredAccessToken(row);
    } catch (cause) {
      await db.exec`
        UPDATE arena_state SET robinhood_oauth_connected = false,
          robinhood_error = ${cause instanceof Error ? cause.message.slice(0, 500) : "Robinhood OAuth refresh failed"},
          updated_at = now() WHERE id = 1
      `;
      throw cause;
    }
  }
  const staticToken = readOptionalSecret(robinhoodMcpAccessToken)
    || process.env.ROBINHOOD_MCP_ACCESS_TOKEN?.trim();
  if (staticToken) return staticToken;
  throw APIError.failedPrecondition("Connect Robinhood from /admin");
}

export function robinhoodAccessToken(): Promise<string> {
  if (!accessTokenPromise) {
    accessTokenPromise = resolveAccessToken().finally(() => {
      accessTokenPromise = undefined;
    });
  }
  return accessTokenPromise;
}

export async function robinhoodOAuthStatus(): Promise<RobinhoodOAuthStatus> {
  const row = await oauthRow();
  return {
    connected: Boolean(row?.access_token_ciphertext && row.refresh_token_ciphertext),
    expires_at: row?.access_expires_at ? new Date(row.access_expires_at).toISOString() : undefined,
    started_at: row?.oauth_started_at ? new Date(row.oauth_started_at).toISOString() : undefined,
  };
}

export { MCP_RESOURCE };
