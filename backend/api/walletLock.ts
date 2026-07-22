import { APIError } from "encore.dev/api";
import { db } from "./db";

export async function acquireWalletLock(subaccountID: string): Promise<() => Promise<void>> {
  const connection = await db.acquire();
  let closed = false;
  try {
    const row = await connection.queryRow<{ locked: boolean }>`
      SELECT pg_try_advisory_lock(hashtextextended(${subaccountID}, 0)) AS locked
    `;
    if (!row?.locked) {
      await connection.close();
      closed = true;
      throw APIError.failedPrecondition("The agent wallet is busy. Try again in a moment.");
    }
  } catch (error) {
    if (!closed) await connection.close().catch(() => undefined);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await connection.exec`SELECT pg_advisory_unlock(hashtextextended(${subaccountID}, 0))`;
    } finally {
      await connection.close();
    }
  };
}

