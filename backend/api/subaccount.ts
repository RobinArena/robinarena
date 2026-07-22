import { hkdfSync } from "node:crypto";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const DERIVATION_VERSION = 3;
export const DERIVATION_CHAIN_ID = 4663;
export const ACCESS_WARNING = "This RobinArena-only signature creates a separate wallet that can trade autonomously on Robinhood Chain.";

const DERIVATION_SALT = "robinarena.fun user agent wallet HKDF-SHA256 v3";
const DERIVATION_INFO = "RobinArena isolated Robinhood Chain agent key, chain 4663";
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const robinhoodChain = defineChain({
  id: DERIVATION_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
const robinhoodClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(),
});

export function subaccountMessage(owner: Address): string {
  return [
    "Authorize a separate RobinArena trading wallet.",
    "",
    `Owner wallet: ${owner}`,
    `Chain ID: ${DERIVATION_CHAIN_ID}`,
    `Derivation version: ${DERIVATION_VERSION}`,
    "Application: https://robinarena.fun/userapp",
    "",
    ACCESS_WARNING,
  ].join("\n");
}

function validSignature(signature: string): signature is Hex {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(signature);
}

export async function verifyWalletMessage(
  ownerValue: string,
  message: string,
  signature: string,
): Promise<Address> {
  if (!isAddress(ownerValue)) throw new Error("invalid owner wallet address");
  if (!validSignature(signature)) throw new Error("invalid wallet signature encoding");
  const owner = getAddress(ownerValue);
  if (signature.length === 132) {
    try {
      const recovered = await recoverMessageAddress({ message, signature });
      if (getAddress(recovered) === owner) return owner;
    } catch {
      // Contract accounts require the on-chain verification path below.
    }
  }
  const valid = await robinhoodClient.verifyMessage({
    address: owner,
    message,
    signature,
  });
  if (!valid) throw new Error("wallet signature does not match the owner wallet");
  return owner;
}

export async function verifySubaccountSignature(ownerValue: string, signature: string): Promise<Address> {
  if (!isAddress(ownerValue)) throw new Error("invalid owner wallet address");
  const owner = getAddress(ownerValue);
  return verifyWalletMessage(owner, subaccountMessage(owner), signature);
}

export function deriveAgentPrivateKey(signature: string): Hex {
  const inputKeyMaterial = Buffer.from(signature.slice(2), "hex");
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = Buffer.from(hkdfSync(
      "sha256",
      inputKeyMaterial,
      Buffer.from(DERIVATION_SALT, "utf8"),
      Buffer.from(`${DERIVATION_INFO}:${counter}`, "utf8"),
      32,
    ));
    const value = BigInt(`0x${candidate.toString("hex")}`);
    if (value > 0n && value < SECP256K1_ORDER) return `0x${candidate.toString("hex")}`;
  }
  throw new Error("could not derive a valid secp256k1 key");
}

export function agentAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
