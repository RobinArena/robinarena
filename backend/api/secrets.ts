import { secret } from "encore.dev/config";

export const openRouterApiKey = secret("OpenRouterAPIKey");
export const arenaOperatorKey = secret("ArenaOperatorKey");
export const robinhoodMcpAccessToken = secret("RobinhoodMCPAccessToken");
export const robinhoodCryptoApiKey = secret("RobinhoodCryptoAPIKey");
export const robinhoodCryptoPrivateKey = secret("RobinhoodCryptoPrivateKey");
export const robinhoodCryptoPublicKey = secret("RobinhoodCryptoPublicKey");
export const credentialEncryptionKey = secret("CredentialEncryptionKey");

export function readOptionalSecret(getter: () => string): string | undefined {
  try {
    const value = getter().trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
