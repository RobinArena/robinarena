import { computed } from "vue";
import { getAddress, parseEther, stringToHex, toHex, type Address } from "viem";
import {
  ErrCode,
  isAPIError,
  type api as GeneratedApi,
} from "../generated/encore-client";
import { apiClient } from "../utils/api";

const SESSION_KEY = "robinarena-user-wallet-session";

type FlowStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "connecting"
  | "signing"
  | "checking-account"
  | "provisioning";

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

interface AnnouncedProvider {
  info: {
    name: string;
    rdns: string;
    uuid: string;
  };
  provider: EthereumProvider;
}

interface WalletSession {
  address: Address;
  token: string;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }

  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<AnnouncedProvider>;
  }
}

let announcedProviders: AnnouncedProvider[] = [];
let selectedProvider: EthereumProvider | undefined;

function subaccountMessage(owner: Address): string {
  return [
    "Authorize a separate RobinArena trading wallet.",
    "",
    `Owner wallet: ${owner}`,
    "Chain ID: 4663",
    "Derivation version: 3",
    "Application: https://robinarena.fun/userapp",
    "",
    "This RobinArena-only signature creates a separate wallet that can trade autonomously on Robinhood Chain.",
  ].join("\n");
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message).trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function provider(): EthereumProvider {
  const rabby = announcedProviders.find(({ info, provider: candidate }) =>
    info.rdns.toLowerCase() === "io.rabby" ||
    info.name.toLowerCase().includes("rabby") ||
    (candidate as EthereumProvider & { isRabby?: boolean }).isRabby,
  );
  const candidate = rabby?.provider || selectedProvider || window.ethereum;
  if (!candidate) {
    throw new Error("Install a browser wallet such as MetaMask or Rabby to continue");
  }
  selectedProvider = candidate;
  return candidate;
}

function parseSession(value: string | null): WalletSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WalletSession>;
    if (
      typeof parsed.address !== "string" ||
      typeof parsed.token !== "string" ||
      !parsed.token
    ) return null;
    return {
      address: getAddress(parsed.address),
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

export function useUserWallet() {
  const session = useState<WalletSession | null>("wallet-session", () => null);
  const account = useState<GeneratedApi.SubaccountResponse | null>(
    "trading-subaccount",
    () => null,
  );
  const status = useState<FlowStatus>("wallet-flow-status", () => "idle");
  const error = useState<string>("wallet-flow-error", () => "");
  const initialized = useState<boolean>("wallet-initialized", () => false);

  const wallet = computed(() => session.value ? { address: session.value.address } : null);
  const authenticated = computed(() => Boolean(session.value));
  const ready = computed(() => initialized.value);
  const busy = computed(() => status.value !== "idle" && status.value !== "ready");

  async function initialize(): Promise<void> {
    if (!import.meta.client || initialized.value) return;
    status.value = "initializing";
    announcedProviders = [];
    window.addEventListener("eip6963:announceProvider", (event) => {
      if (!announcedProviders.some(({ info }) => info.uuid === event.detail.info.uuid)) {
        announcedProviders.push(event.detail);
      }
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    selectedProvider = undefined;
    session.value = parseSession(localStorage.getItem(SESSION_KEY));
    const activeProvider = announcedProviders.length || window.ethereum
      ? provider()
      : undefined;
    if (activeProvider?.on) {
      activeProvider.on("accountsChanged", (...args: unknown[]) => {
        const accounts = args[0];
        if (!Array.isArray(accounts) || !session.value) return;
        const active = typeof accounts[0] === "string" ? accounts[0].toLowerCase() : "";
        if (active !== session.value.address.toLowerCase()) void logout();
      });
    }
    initialized.value = true;
    status.value = "ready";
  }

  async function connectWallet(): Promise<void> {
    await initialize();
    error.value = "";
    try {
      status.value = "connecting";
      const ethereum = provider();
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        throw new Error("The wallet did not return an Ethereum account");
      }
      const address = getAddress(accounts[0]);
      const challenge = await apiClient().api.walletChallenge({ address });
      status.value = "signing";
      const signature = await ethereum.request({
        method: "personal_sign",
        params: [stringToHex(challenge.message), address],
      });
      if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        throw new Error("The wallet returned an invalid signature");
      }
      const authenticated = await apiClient().api.walletLogin({
        address,
        challenge_id: challenge.challenge_id,
        signature,
      });
      session.value = {
        address,
        token: authenticated.token,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session.value));
    } catch (cause) {
      const fallback = status.value === "signing"
        ? "Your wallet could not sign the RobinArena login request. Unlock it, select the account, and approve the message."
        : "Rabby did not grant account access. Unlock Rabby and approve the connection request.";
      error.value = messageFrom(cause, fallback);
      throw cause;
    } finally {
      status.value = "ready";
    }
  }

  async function ensureWallet() {
    await initialize();
    if (!session.value) throw new Error("Connect your wallet to continue");
    return { address: session.value.address };
  }

  async function depositEth(recipient: string, amount: string): Promise<string> {
    const owner = await ensureWallet();
    const ethereum = provider();
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(4663) }] });
    } catch {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: toHex(4663),
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
        }],
      });
    }
    const hash = await ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: owner.address, to: getAddress(recipient), value: toHex(parseEther(amount)) }],
    });
    if (typeof hash !== "string") throw new Error("The wallet did not return a transaction hash");
    return hash;
  }

  async function getAccessToken(): Promise<string> {
    await initialize();
    if (!session.value) throw new Error("Connect your wallet to continue");
    return session.value.token;
  }

  async function getExistingAccount(): Promise<GeneratedApi.SubaccountResponse | null> {
    status.value = "checking-account";
    error.value = "";
    try {
      const token = await getAccessToken();
      const existing = await apiClient({
        auth: { authorization: `Bearer ${token}` },
      }).api.getUserAgentAccount();
      account.value = existing;
      return existing;
    } catch (cause) {
      if (isAPIError(cause) && cause.code === ErrCode.FailedPrecondition) {
        account.value = null;
        return null;
      }
      error.value = messageFrom(cause, "The account could not be loaded");
      throw cause;
    } finally {
      status.value = "ready";
    }
  }

  async function provisionAgentWallet(): Promise<GeneratedApi.SubaccountResponse> {
    await initialize();
    if (!session.value) throw new Error("Connect your wallet to continue");
    error.value = "";
    try {
      const ethereum = provider();
      const accounts = await ethereum.request({ method: "eth_accounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        throw new Error("Rabby is locked or disconnected");
      }
      const activeAddress = getAddress(accounts[0]);
      if (activeAddress !== session.value.address) {
        throw new Error("Select the connected owner account in Rabby and try again");
      }
      status.value = "signing";
      const signature = await ethereum.request({
        method: "personal_sign",
        params: [stringToHex(subaccountMessage(activeAddress)), activeAddress],
      });
      if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        throw new Error("The wallet returned an invalid signature");
      }
      status.value = "provisioning";
      const token = await getAccessToken();
      const provisioned = await apiClient({
        auth: { authorization: `Bearer ${token}` },
      }).api.provisionUserAgent({
        owner_wallet_address: session.value.address,
        signature,
      });
      account.value = provisioned;
      return provisioned;
    } catch (cause) {
      error.value = messageFrom(cause, "The agent wallet could not be created");
      throw cause;
    } finally {
      status.value = "ready";
    }
  }

  async function logout(): Promise<void> {
    if (session.value) {
      try {
        await apiClient({
          auth: { authorization: `Bearer ${session.value.token}` },
        }).api.walletLogout();
      } catch {
        // Local logout still succeeds if the server session already expired.
      }
    }
    session.value = null;
    account.value = null;
    error.value = "";
    if (import.meta.client) localStorage.removeItem(SESSION_KEY);
    status.value = "ready";
  }

  function clearError(): void {
    error.value = "";
  }

  return {
    account,
    authenticated,
    busy,
    error,
    initialized,
    ready,
    status,
    wallet,
    clearError,
    connectWallet,
    depositEth,
    ensureWallet,
    getExistingAccount,
    getAccessToken,
    initialize,
    logout,
    provisionAgentWallet,
    provisionSubaccount: provisionAgentWallet,
  };
}
