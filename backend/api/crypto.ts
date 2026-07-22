import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { credentialEncryptionKey } from "./secrets";
const FORMAT_VERSION = "v1";

function encryptionKey(): Buffer {
  return createHash("sha256").update(credentialEncryptionKey(), "utf8").digest();
}

export function sealSecret(value: string, scope: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function openSecret(value: string, scope: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(":");
  if (version !== FORMAT_VERSION || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("unsupported encrypted credential format");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAAD(Buffer.from(scope, "utf8"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
