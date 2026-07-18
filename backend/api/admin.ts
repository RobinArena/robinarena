import { api, APIError } from "encore.dev/api";
import { CronJob } from "encore.dev/cron";
import {
  buildArena,
  storedBrokerSummary,
  storedSchedulerSummary,
} from "./arena-repository";
import {
  FLATTEN_CONFIRMATION,
  LIVE_CONSENT_CONFIRMATION,
  LIVE_EXECUTION_CONFIRMATION,
  armLiveArena,
  cancelLiveOrders,
  disarmLiveArena,
  flattenManagedPositions,
  haltLiveArena,
  runLiveRound,
  scheduledLiveRound,
  syncRobinhood,
} from "./live-engine";
import {
  completeRobinhoodOAuth,
  robinhoodOAuthStatus,
  startRobinhoodOAuth,
} from "./robinhood-oauth";
import type {
  AdminControlResponse,
  AdminStatusResponse,
  ModelRoundResult,
  RobinhoodConnectResponse,
} from "./types";

interface ArmRequest {
  confirmation: string;
  automation_enabled?: boolean;
}

interface RoundRequest {
  confirmation: string;
}

interface HaltRequest {
  reason?: string;
  cancel_orders?: boolean;
}

interface FlattenRequest {
  confirmation: string;
}

interface RobinhoodConnectRequest {
  redirect_uri: string;
}

interface RoundControlResponse extends AdminControlResponse {
  round_results: ModelRoundResult[];
}

async function adminStatus(): Promise<AdminStatusResponse> {
  return {
    authenticated: true,
    arena: await buildArena(),
    broker: await storedBrokerSummary(),
    scheduler: await storedSchedulerSummary(),
    robinhood_oauth: await robinhoodOAuthStatus(),
    execution_confirmation: LIVE_EXECUTION_CONFIRMATION,
    live_consent_confirmation: LIVE_CONSENT_CONFIRMATION,
    flatten_confirmation: FLATTEN_CONFIRMATION,
  };
}

async function control(message: string): Promise<AdminControlResponse> {
  return { ok: true, message, status: await adminStatus() };
}

export const getAdminStatus = api(
  { expose: true, auth: true, sensitive: true, method: "GET", path: "/admin/status" },
  async (): Promise<AdminStatusResponse> => adminStatus(),
);

export const connectAdminRobinhood = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/robinhood/connect" },
  async (request: RobinhoodConnectRequest): Promise<RobinhoodConnectResponse> => ({
    authorization_url: await startRobinhoodOAuth(request.redirect_uri),
  }),
);

export const robinhoodOAuthCallback = api.raw(
  { expose: true, sensitive: true, method: "GET", path: "/admin/robinhood/callback" },
  async (request, response) => {
    const query = new URL(request.url || "", "http://localhost").searchParams;
    const code = query.get("code");
    const state = query.get("state");
    const oauthError = query.get("error_description") || query.get("error");
    try {
      if (oauthError) throw new Error(oauthError);
      if (!code || !state) throw new Error("Robinhood OAuth returned no authorization code");
      const redirect = await completeRobinhoodOAuth(code, state);
      response.writeHead(302, { Location: redirect, "Cache-Control": "no-store" });
      response.end();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.slice(0, 180) : "Robinhood connection failed";
      response.writeHead(302, {
        Location: `/admin?robinhood=error&message=${encodeURIComponent(message)}`,
        "Cache-Control": "no-store",
      });
      response.end();
    }
  },
);

export const syncAdminArena = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/sync" },
  async (): Promise<AdminControlResponse> => {
    const broker = await syncRobinhood();
    return control(
      `Robinhood reconciled at $${broker.deployable_capital.toFixed(2)} deployable capital, with $${broker.allocation_per_model.toFixed(2)} per model. ${broker.unmanaged_positions.length} unmanaged position symbols found.`,
    );
  },
);

export const armAdminArena = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/arm" },
  async (request: ArmRequest): Promise<AdminControlResponse> => {
    if (request.confirmation !== LIVE_CONSENT_CONFIRMATION) {
      throw APIError.invalidArgument(`confirmation must be exactly: ${LIVE_CONSENT_CONFIRMATION}`);
    }
    await armLiveArena(Boolean(request.automation_enabled));
    return control(request.automation_enabled
      ? "Live Robinhood execution is armed for hourly decisions around the clock."
      : "Live Robinhood execution is armed for manual decision cycles.");
  },
);

export const disarmAdminArena = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/disarm" },
  async (): Promise<AdminControlResponse> => {
    await disarmLiveArena();
    return control("Live execution and automation are disarmed. Open broker orders were left unchanged.");
  },
);

export const runAdminRound = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/round" },
  async (request: RoundRequest): Promise<RoundControlResponse> => {
    if (request.confirmation !== LIVE_EXECUTION_CONFIRMATION) {
      throw APIError.invalidArgument(`confirmation must be exactly: ${LIVE_EXECUTION_CONFIRMATION}`);
    }
    const result = await runLiveRound();
    return {
      ok: result.round_results.every((item) => item.status !== "failed"),
      message: result.round_message,
      status: await adminStatus(),
      round_results: result.round_results,
    };
  },
);

export const haltAdminArena = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/halt" },
  async (request: HaltRequest): Promise<AdminControlResponse> => {
    const cancelled = await haltLiveArena(
      request.reason?.trim() || "operator halt",
      request.cancel_orders !== false,
    );
    return control(`Trading halted. ${cancelled} open Robinhood orders were sent for cancellation.`);
  },
);

export const cancelAdminOrders = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/cancel" },
  async (): Promise<AdminControlResponse> => {
    const cancelled = await cancelLiveOrders();
    return control(`${cancelled} open Robinhood orders were sent for cancellation.`);
  },
);

export const flattenAdminArena = api(
  { expose: true, auth: true, sensitive: true, method: "POST", path: "/admin/flatten" },
  async (request: FlattenRequest): Promise<AdminControlResponse> => {
    if (request.confirmation !== FLATTEN_CONFIRMATION) {
      throw APIError.invalidArgument(`confirmation must be exactly: ${FLATTEN_CONFIRMATION}`);
    }
    const submitted = await flattenManagedPositions();
    return control(`${submitted} arena-managed positions were submitted to Robinhood for sale.`);
  },
);

export const scheduledArenaRound = api(
  { expose: false },
  async (): Promise<void> => scheduledLiveRound(),
);

const _arenaSchedule = new CronJob("model-market-live-round", {
  title: "Monitor and run the weekly RobinArena competition",
  every: "5m",
  endpoint: scheduledArenaRound,
});
