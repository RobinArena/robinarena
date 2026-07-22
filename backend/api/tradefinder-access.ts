const REQUIRED_WHOLE_TOKENS = 100n;

export function hasTradeFinderAccess(balance: bigint, decimals: number): boolean {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return false;
  return balance >= REQUIRED_WHOLE_TOKENS * 10n ** BigInt(decimals);
}
