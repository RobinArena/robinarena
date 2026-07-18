<script setup lang="ts">
import type { api } from "~/generated/encore-client";
import { formatCurrency, formatDateTime, formatPercent, formatQuantity, formatRelativeTime } from "~/utils/format";
import { loadOperatorKey, operatorClient, saveOperatorKey } from "~/utils/operator";

useSeoMeta({
  title: "Operator console",
  description: "Reconcile, arm, run, and halt the live RobinArena competition.",
  robots: "noindex, nofollow",
});

const operatorKey = ref("");
const status = ref<api.AdminStatusResponse | null>(null);
const authenticated = ref(false);
const pending = ref("");
const notice = ref("");
const errorMessage = ref("");
const automationEnabled = ref(false);
const consentPhrase = ref("");
const executionPhrase = ref("");
const flattenPhrase = ref("");
const route = useRoute();

const arena = computed(() => status.value?.arena);
const broker = computed(() => status.value?.broker);
const nextEligibleCycle = computed(() => {
  const current = arena.value?.arena;
  if (!current?.live_armed) return "After arming";
  if (!current.automation_enabled) return "Manual only";
  return current.market_session_open
    ? formatRelativeTime(current.next_cycle_at)
    : formatDateTime(current.next_cycle_at);
});
const readiness = computed(() => {
  if (!arena.value) return [];
  const scheduler = status.value?.scheduler;
  return [
    {
      label: "Model gateway",
      value: arena.value.openrouter.configured ? "Configured" : "Missing key",
      ready: arena.value.openrouter.configured,
      detail: `${arena.value.openrouter.models.length} model routes`,
    },
    {
      label: "Robinhood",
      value: status.value?.robinhood_oauth.connected ? "OAuth connected" : "Connect account",
      ready: Boolean(status.value?.robinhood_oauth.connected && arena.value.robinhood.state === "ready"),
      detail: arena.value.arena.last_robinhood_sync_at
        ? `Synced ${formatRelativeTime(arena.value.arena.last_robinhood_sync_at)}`
        : "Run a broker sync",
    },
    {
      label: "Capital",
      value: broker.value ? formatCurrency(broker.value.deployable_capital) : "Unknown",
      ready: Boolean(
        broker.value
        && broker.value.capital_source === "robinhood"
        && broker.value.buying_power + broker.value.managed_exposure + 0.01
          >= broker.value.allocated_capital
      ),
      detail: broker.value
        ? `${formatCurrency(broker.value.operator_capital_ceiling)} ceiling, ${formatCurrency(broker.value.allocation_per_model)} per model`
        : "Run a broker sync",
    },
    {
      label: "Ledger match",
      value: broker.value?.unmanaged_positions.length ? "Blocked" : broker.value ? "Matched" : "Not checked",
      ready: Boolean(broker.value && broker.value.unmanaged_positions.length === 0),
      detail: broker.value?.unmanaged_positions.length
        ? broker.value.unmanaged_positions.join(", ")
        : "No unmanaged symbols",
    },
    {
      label: "Scheduler",
      value: scheduler?.status === "healthy"
        ? "Online"
        : scheduler?.status === "delayed"
          ? "Delayed"
          : scheduler?.status === "error"
            ? "Needs attention"
            : "Not armed",
      ready: scheduler?.status === "healthy",
      detail: scheduler?.status === "error"
        ? `${scheduler.consecutive_failures} consecutive failures. ${scheduler.last_error || "The next retry is queued."}`
        : scheduler?.last_seen_at
          ? `Checked ${formatRelativeTime(scheduler.last_seen_at)}`
          : "Awaiting the first five-minute check",
    },
  ];
});

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The operator request failed.";
}

async function signIn() {
  const key = operatorKey.value.trim();
  if (!key) {
    errorMessage.value = "Enter the ArenaOperatorKey value configured on the server.";
    return;
  }
  pending.value = "login";
  errorMessage.value = "";
  notice.value = "";
  try {
    status.value = await operatorClient(key).api.getAdminStatus();
    authenticated.value = true;
    saveOperatorKey(key);
    automationEnabled.value = Boolean(status.value.arena.arena.automation_enabled);
  } catch (cause) {
    authenticated.value = false;
    errorMessage.value = message(cause);
  } finally {
    pending.value = "";
  }
}

function signOut() {
  saveOperatorKey("");
  operatorKey.value = "";
  status.value = null;
  authenticated.value = false;
  notice.value = "";
  errorMessage.value = "";
}

async function refreshStatus() {
  if (!authenticated.value || !operatorKey.value) return;
  try {
    status.value = await operatorClient(operatorKey.value).api.getAdminStatus();
    automationEnabled.value = Boolean(status.value.arena.arena.automation_enabled);
  } catch (cause) {
    errorMessage.value = message(cause);
  }
}

async function runControl(
  name: string,
  operation: () => Promise<api.AdminControlResponse>,
) {
  pending.value = name;
  errorMessage.value = "";
  notice.value = "";
  try {
    const response = await operation();
    status.value = response.status;
    notice.value = response.message;
    automationEnabled.value = Boolean(response.status.arena.arena.automation_enabled);
  } catch (cause) {
    errorMessage.value = message(cause);
  } finally {
    pending.value = "";
  }
}

function syncBroker() {
  return runControl("sync", () => operatorClient(operatorKey.value).api.syncAdminArena());
}

async function connectRobinhood() {
  if (!import.meta.client) return;
  pending.value = "connect";
  errorMessage.value = "";
  try {
    const response = await operatorClient(operatorKey.value).api.connectAdminRobinhood({
      redirect_uri: `${window.location.origin}/api/admin/robinhood/callback`,
    });
    window.location.assign(response.authorization_url);
  } catch (cause) {
    errorMessage.value = message(cause);
    pending.value = "";
  }
}

function armArena() {
  if (!status.value) return;
  return runControl("arm", () => operatorClient(operatorKey.value).api.armAdminArena({
    confirmation: consentPhrase.value,
    automation_enabled: automationEnabled.value,
  })).then(() => {
    consentPhrase.value = "";
  });
}

function disarmArena() {
  return runControl("disarm", () => operatorClient(operatorKey.value).api.disarmAdminArena());
}

function runRound() {
  if (!status.value) return;
  return runControl("round", () => operatorClient(operatorKey.value).api.runAdminRound({
    confirmation: executionPhrase.value,
  })).then(() => {
    executionPhrase.value = "";
  });
}

function haltArena() {
  return runControl("halt", () => operatorClient(operatorKey.value).api.haltAdminArena({
    reason: "operator halt from /admin",
    cancel_orders: true,
  }));
}

function cancelOrders() {
  return runControl("cancel", () => operatorClient(operatorKey.value).api.cancelAdminOrders());
}

function flattenArena() {
  if (!status.value) return;
  return runControl("flatten", () => operatorClient(operatorKey.value).api.flattenAdminArena({
    confirmation: flattenPhrase.value,
  })).then(() => {
    flattenPhrase.value = "";
  });
}

const { pause, resume } = useIntervalFn(refreshStatus, 30_000, { immediate: false });
onMounted(async () => {
  operatorKey.value = loadOperatorKey();
  if (operatorKey.value) await signIn();
  if (route.query.robinhood === "connected" && authenticated.value) {
    await syncBroker();
  } else if (route.query.robinhood === "error") {
    errorMessage.value = typeof route.query.message === "string"
      ? route.query.message
      : "Robinhood OAuth did not complete.";
  }
  resume();
});
onBeforeUnmount(pause);
</script>

<template>
  <div class="page-shell admin-page">
    <section v-if="!authenticated" class="admin-login" aria-labelledby="admin-login-heading">
      <div class="admin-login-copy">
        <Icon name="ph:shield-key" aria-hidden="true" />
        <h1 id="admin-login-heading">Operator access</h1>
        <p>
          Use the value stored as <code>ArenaOperatorKey</code>. It is separate from the model gateway and Robinhood credentials.
        </p>
      </div>
      <form class="admin-login-form" @submit.prevent="signIn">
        <label>
          <span>Operator key</span>
          <input v-model="operatorKey" type="password" autocomplete="current-password" placeholder="ArenaOperatorKey">
        </label>
        <button class="button button-primary" type="submit" :disabled="pending === 'login'">
          <Icon :name="pending === 'login' ? 'ph:circle-notch' : 'ph:sign-in'" :class="{ 'is-spinning': pending === 'login' }" aria-hidden="true" />
          {{ pending === "login" ? "Verifying" : "Enter console" }}
        </button>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <small>The key remains in session storage for this browser tab.</small>
      </form>
    </section>

    <template v-else-if="status && arena">
      <header class="admin-header">
        <div>
          <h1>Operate RobinArena.</h1>
          <p>Robinhood funds the four ledgers. Automatic decisions use fixed hourly slots during the regular U.S. market session.</p>
        </div>
        <div class="admin-session">
          <span :class="{ 'is-live': arena.arena.live_armed, 'is-halted': arena.arena.halted }">
            {{ arena.arena.halted ? "Halted" : arena.arena.live_armed ? "Live armed" : "Disarmed" }}
          </span>
          <button type="button" @click="signOut">Sign out</button>
        </div>
      </header>

      <div v-if="notice || errorMessage" class="admin-notice" :class="{ 'is-error': errorMessage }" :role="errorMessage ? 'alert' : 'status'">
        <Icon :name="errorMessage ? 'ph:warning-circle' : 'ph:check-circle'" aria-hidden="true" />
        <p>{{ errorMessage || notice }}</p>
      </div>

      <section class="admin-readiness" aria-label="Live readiness">
        <article v-for="item in readiness" :key="item.label" :class="{ 'is-ready': item.ready }">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.detail }}</small>
        </article>
      </section>

      <section class="admin-round-state" aria-label="Current competition round">
        <div class="admin-round-summary">
          <span>{{ arena.arena.season }}</span>
          <strong>Round {{ arena.arena.round_number }}</strong>
          <small>{{ formatDateTime(arena.arena.round_started_at) }} to {{ formatDateTime(arena.arena.round_ends_at) }}</small>
        </div>
        <div class="admin-round-progress">
          <div>
            <span>Weekly progress</span>
            <strong>{{ Math.round(arena.arena.round_progress_pct) }}%</strong>
          </div>
          <span aria-hidden="true"><i :style="{ width: `${arena.arena.round_progress_pct}%` }" /></span>
        </div>
        <dl>
          <div><dt>Current cycle</dt><dd>#{{ arena.arena.cycle_number }}</dd></div>
          <div><dt>Round closes</dt><dd>{{ formatRelativeTime(arena.arena.round_ends_at) }}</dd></div>
          <div><dt>Next eligible cycle</dt><dd>{{ nextEligibleCycle }}</dd></div>
          <div><dt>US market</dt><dd>{{ arena.arena.market_session_open ? "Open" : "Closed" }}</dd></div>
        </dl>
      </section>

      <section class="admin-console-grid">
        <div class="admin-column">
          <article class="admin-panel sync-panel">
            <div class="admin-panel-heading">
              <div>
                <h2>Broker reconciliation</h2>
                <p>Reads the Agentic account, imports verified quotes, and accounts for reported fills.</p>
              </div>
              <Icon name="ph:arrows-clockwise" aria-hidden="true" />
            </div>
            <dl v-if="broker" class="broker-facts">
              <div><dt>Account equity</dt><dd>{{ formatCurrency(broker.equity) }}</dd></div>
              <div><dt>Buying power</dt><dd>{{ formatCurrency(broker.buying_power) }}</dd></div>
              <div><dt>Deployable capital</dt><dd>{{ formatCurrency(broker.deployable_capital) }}</dd></div>
              <div><dt>Per model</dt><dd>{{ formatCurrency(broker.allocation_per_model) }}</dd></div>
              <div><dt>Arena exposure</dt><dd>{{ formatCurrency(broker.managed_exposure) }}</dd></div>
              <div><dt>Broker timestamp</dt><dd>{{ formatRelativeTime(broker.as_of) }}</dd></div>
            </dl>
            <div v-else class="admin-empty">No Robinhood account snapshot has been stored.</div>
            <div class="button-row">
              <button class="button button-quiet" type="button" :disabled="Boolean(pending)" @click="connectRobinhood">
                <Icon :name="pending === 'connect' ? 'ph:circle-notch' : 'ph:link'" :class="{ 'is-spinning': pending === 'connect' }" aria-hidden="true" />
                {{ status.robinhood_oauth.connected ? "Reconnect Robinhood" : "Connect Robinhood" }}
              </button>
              <button class="button button-quiet" type="button" :disabled="Boolean(pending)" @click="syncBroker">
                <Icon :name="pending === 'sync' ? 'ph:circle-notch' : 'ph:arrows-clockwise'" :class="{ 'is-spinning': pending === 'sync' }" aria-hidden="true" />
                {{ pending === "sync" ? "Reconciling" : "Sync now" }}
              </button>
            </div>
          </article>

          <article class="admin-panel allocation-panel">
            <div class="admin-panel-heading">
              <div>
                <h2>{{ formatCurrency(arena.arena.capital_limit) }} allocation</h2>
                <p>The four weekly ledger baselines total {{ formatCurrency(arena.arena.starting_capital) }}. Current holdings carry into the next scoreboard.</p>
              </div>
              <strong>{{ formatCurrency(arena.arena.total_equity) }}</strong>
            </div>
            <div class="allocation-list">
              <div v-for="model in arena.models" :key="model.id" :style="{ '--model-accent': model.accent }">
                <ModelGlyph :code="model.code" :accent="model.accent" size="small" />
                <span><strong>{{ model.name }}</strong><small>{{ model.openrouter_model }}</small></span>
                <span><strong>{{ formatCurrency(model.equity) }}</strong><small>{{ formatCurrency(model.cash_balance) }} cash</small></span>
                <span :class="model.return_pct >= 0 ? 'value-positive' : 'value-negative'">{{ formatPercent(model.return_pct) }}</span>
              </div>
            </div>
          </article>
        </div>

        <div class="admin-column">
          <article class="admin-panel execution-panel">
            <div class="admin-panel-heading">
              <div>
                <h2>Execution</h2>
                <p>Arming authorizes real orders. A manual decision cycle requires a second phrase every time.</p>
              </div>
              <Icon name="ph:play-circle" aria-hidden="true" />
            </div>

            <div v-if="!arena.arena.live_armed" class="confirmation-control">
              <label class="automation-option">
                <input v-model="automationEnabled" type="checkbox">
                <span><strong>Run hourly during market hours</strong><small>Fixed slots begin at 9:35 AM ET. Manual cycles leave the automatic schedule unchanged.</small></span>
              </label>
              <label>
                <span>Type to arm live trading</span>
                <code>{{ status.live_consent_confirmation }}</code>
                <input v-model="consentPhrase" type="text" autocomplete="off">
              </label>
              <button class="button button-primary" type="button" :disabled="Boolean(pending) || consentPhrase !== status.live_consent_confirmation" @click="armArena">
                <Icon :name="pending === 'arm' ? 'ph:circle-notch' : 'ph:shield-check'" :class="{ 'is-spinning': pending === 'arm' }" aria-hidden="true" />
                {{ pending === "arm" ? "Checking account" : "Arm live execution" }}
              </button>
            </div>

            <div v-else class="confirmation-control">
              <label>
                <span>Type to run one live decision cycle</span>
                <code>{{ status.execution_confirmation }}</code>
                <input v-model="executionPhrase" type="text" autocomplete="off">
              </label>
              <div class="button-row">
                <button class="button button-primary" type="button" :disabled="Boolean(pending) || executionPhrase !== status.execution_confirmation" @click="runRound">
                  <Icon :name="pending === 'round' ? 'ph:circle-notch' : 'ph:play-fill'" :class="{ 'is-spinning': pending === 'round' }" aria-hidden="true" />
                  {{ pending === "round" ? "Running four models" : "Run decision cycle" }}
                </button>
                <button class="button button-quiet" type="button" :disabled="Boolean(pending)" @click="disarmArena">Disarm</button>
              </div>
            </div>
          </article>

          <article class="admin-panel danger-panel">
            <div class="admin-panel-heading">
              <div>
                <h2>Emergency controls</h2>
                <p>Halt disables new decision cycles. Flatten sells only positions owned by arena ledgers.</p>
              </div>
              <Icon name="ph:warning-octagon" aria-hidden="true" />
            </div>
            <div class="button-row">
              <button class="button button-danger" type="button" :disabled="Boolean(pending)" @click="haltArena">
                <Icon name="ph:stop-fill" aria-hidden="true" /> Halt and cancel
              </button>
              <button class="button button-quiet" type="button" :disabled="Boolean(pending)" @click="cancelOrders">Cancel open orders</button>
            </div>
            <label class="flatten-control">
              <span>Type to halt, cancel, and sell arena positions</span>
              <code>{{ status.flatten_confirmation }}</code>
              <input v-model="flattenPhrase" type="text" autocomplete="off">
            </label>
            <button class="button button-danger-outline" type="button" :disabled="Boolean(pending) || flattenPhrase !== status.flatten_confirmation" @click="flattenArena">
              <Icon :name="pending === 'flatten' ? 'ph:circle-notch' : 'ph:arrow-line-down'" :class="{ 'is-spinning': pending === 'flatten' }" aria-hidden="true" />
              {{ pending === "flatten" ? "Submitting exits" : "Flatten arena positions" }}
            </button>
          </article>
        </div>
      </section>

      <section class="admin-panel admin-orders">
        <div class="admin-panel-heading">
          <div>
            <h2>Latest broker orders</h2>
            <p>Submitted orders remain pending until a Robinhood fill or terminal state is reconciled.</p>
          </div>
          <span>{{ arena.orders.length }} shown</span>
        </div>
        <div v-if="arena.orders.length" class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>Model</th><th>Order</th><th>Requested</th><th>Filled</th><th>Status</th><th>Age</th></tr></thead>
            <tbody>
              <tr v-for="order in arena.orders" :key="order.id">
                <td>{{ order.agent_name }}</td>
                <td><strong>{{ order.side.toUpperCase() }} {{ order.symbol }}</strong></td>
                <td>{{ order.requested_amount ? formatCurrency(order.requested_amount) : `${formatQuantity(order.requested_quantity)} shares` }}</td>
                <td>{{ order.filled_quantity ? `${formatQuantity(order.filled_quantity)} shares` : "Pending" }}</td>
                <td><span class="broker-status">{{ order.status.replaceAll("_", " ") }}</span></td>
                <td>{{ formatRelativeTime(order.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="admin-empty">No live Robinhood orders have been submitted.</div>
      </section>
    </template>
  </div>
</template>
