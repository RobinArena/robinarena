import type Client from "~/generated/encore-client";

const storageKey = "model-market-operator-key";

export function operatorClient(operatorKey: string): Client {
  return apiClient({
    requestInit: {
      headers: { Authorization: `Bearer ${operatorKey}` },
    },
  });
}

export function loadOperatorKey(): string {
  if (import.meta.server) return "";
  return sessionStorage.getItem(storageKey) || "";
}

export function saveOperatorKey(value: string): void {
  if (import.meta.server) return;
  if (value) sessionStorage.setItem(storageKey, value);
  else sessionStorage.removeItem(storageKey);
}
