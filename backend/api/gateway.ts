import { timingSafeEqual } from "node:crypto";
import { APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { arenaOperatorKey, readOptionalSecret } from "./secrets";

interface AuthParams {
  authorization?: Header<"Authorization">;
}

export interface AuthData {
  userID: string;
  role: "operator";
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
  if (!expected || !sameSecret(supplied, expected)) {
    throw APIError.unauthenticated("invalid arena operator key");
  }

  return { userID: "arena-operator", role: "operator" };
});

export const gateway = new Gateway({ authHandler: auth });
