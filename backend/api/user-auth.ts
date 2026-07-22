import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APIError, api } from "encore.dev/api";
import { MaxLen } from "encore.dev/validate";
import { getAuthData } from "encore.dev/internal/codegen/auth";
import { getAddress, isAddress } from "viem";
import { db } from "./db";
import type { AuthData } from "./gateway";
import { verifyWalletMessage } from "./subaccount";

interface WalletChallengeRequest { address: string & MaxLen<64> }
interface WalletChallengeResponse { challenge_id: string; message: string; expires_at: Date }
interface WalletLoginRequest {
  challenge_id: string & MaxLen<64>;
  address: string & MaxLen<64>;
  signature: string & MaxLen<4096>;
}
interface WalletLoginResponse { token: string; expires_at: Date }

export function walletTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loginMessage(address: string, nonce: string, issuedAt: Date, expiresAt: Date): string {
  return [
    "robinarena.fun wants you to sign in with your Ethereum account:",
    address,
    "",
    "Sign in to RobinArena User Agents.",
    "",
    "URI: https://robinarena.fun/userapp",
    "Version: 1",
    "Chain ID: 4663",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join("\n");
}

export const walletChallenge = api(
  { expose: true, method: "POST", path: "/auth/wallet/challenge", sensitive: true },
  async ({ address: addressValue }: WalletChallengeRequest): Promise<WalletChallengeResponse> => {
    if (!isAddress(addressValue)) throw APIError.invalidArgument("a valid wallet address is required");
    const address = getAddress(addressValue);
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
    const message = loginMessage(address, randomBytes(16).toString("base64url"), issuedAt, expiresAt);
    await db.exec`
      INSERT INTO wallet_login_challenges (id, owner_user_id, message, expires_at)
      VALUES (${id}, ${address}, ${message}, ${expiresAt})
    `;
    return { challenge_id: id, message, expires_at: expiresAt };
  },
);

export const walletLogin = api(
  { expose: true, method: "POST", path: "/auth/wallet", sensitive: true },
  async (request: WalletLoginRequest): Promise<WalletLoginResponse> => {
    if (!isAddress(request.address)) throw APIError.unauthenticated("the wallet login request is invalid");
    const address = getAddress(request.address);
    const challenge = await db.queryRow<{ id: string; message: string }>`
      SELECT id, message FROM wallet_login_challenges
      WHERE id = ${request.challenge_id} AND owner_user_id = ${address}
        AND used_at IS NULL AND expires_at > NOW()
    `;
    if (!challenge) throw APIError.unauthenticated("the wallet login request expired; try again");
    try {
      await verifyWalletMessage(address, challenge.message, request.signature);
    } catch {
      throw APIError.unauthenticated("the wallet login signature is invalid");
    }
    const consumed = await db.queryRow<{ id: string }>`
      UPDATE wallet_login_challenges SET used_at = NOW()
      WHERE id = ${challenge.id} AND used_at IS NULL RETURNING id
    `;
    if (!consumed) throw APIError.unauthenticated("the wallet login request was already used");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await db.exec`
      INSERT INTO wallet_sessions (token_hash, owner_user_id, expires_at)
      VALUES (${walletTokenHash(token)}, ${address}, ${expiresAt})
    `;
    return { token, expires_at: expiresAt };
  },
);

export const walletLogout = api(
  { expose: true, auth: true, method: "POST", path: "/auth/logout", sensitive: true },
  async (): Promise<void> => {
    const auth = getAuthData() as AuthData | null;
    if (auth?.role === "user" && auth.sessionID) {
      await db.exec`DELETE FROM wallet_sessions WHERE token_hash = ${auth.sessionID}`;
    }
  },
);
