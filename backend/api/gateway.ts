import { createHash, timingSafeEqual } from "node:crypto";
import { APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { getAuthData } from "encore.dev/internal/codegen/auth";
import { arenaOperatorKey, readOptionalSecret } from "./secrets";
import { db } from "./db";
import { ensureUserAgentCoordinator } from "./user-agent-continuous";

ensureUserAgentCoordinator();

interface AuthParams {
  authorization?: Header<"Authorization">;
}

export interface AuthData {
  userID: string;
  role: "operator" | "user";
  sessionID?: string;
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export const auth = authHandler<AuthParams, AuthData>(async ({ authorization }) => {
  const supplied = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!supplied) throw APIError.unauthenticated("arena operator key required");

  const configured = readOptionalSecret(arenaOperatorKey) || process.env.ARENA_OPERATOR_KEY?.trim();
  const expected = configured || (process.env.NODE_ENV === "production" ? undefined : "dev-model-market");
  if (expected && sameSecret(supplied, expected)) {
    return { userID: "arena-operator", role: "operator" };
  }
  const sessionID = createHash("sha256").update(supplied).digest("hex");
  const session = await db.queryRow<{ owner_user_id: string }>`
    SELECT owner_user_id FROM wallet_sessions
    WHERE token_hash = ${sessionID} AND expires_at > NOW()
  `;
  if (!session) throw APIError.unauthenticated("invalid or expired session");
  return { userID: session.owner_user_id, role: "user", sessionID };
});

export function requireOperator(): void {
  const auth = getAuthData() as AuthData | null;
  if (auth?.role !== "operator") throw APIError.permissionDenied("arena operator access required");
}

export const gateway = new Gateway({ authHandler: auth });
