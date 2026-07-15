import { secret } from "encore.dev/config";

export const openRouterApiKey = secret("OpenRouterAPIKey");
export const arenaOperatorKey = secret("ArenaOperatorKey");

export function readOptionalSecret(getter: () => string): string | undefined {
  try {
    const value = getter().trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
