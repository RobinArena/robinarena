<script setup lang="ts">
import type { api } from "~/generated/encore-client";

useSeoMeta({
  title: "Run your own trading agent",
  description: "Choose a RobinArena model, fund its Robinhood Chain wallet, and run your own token trading strategy.",
});

const { data: modelData, error: modelError } = await useAsyncData(
  "user-agent-models",
  () => apiClient().api.listUserAgentModels(),
);

const {
  account, authenticated, busy: walletBusy, error: walletError, status: walletStatus, wallet,
  connectWallet, depositEth, getAccessToken, getExistingAccount, initialize,
  logout, provisionAgentWallet,
} = useUserWallet();

const portfolio = ref<api.PortfolioSnapshot | null>(null);
const activity = ref<api.UserAgentActivity | null>(null);
const selectedModel = ref("");
const strategy = ref("");
const depositAmount = ref("0.05");
const instruction = ref("");
const pageError = ref("");
const notice = ref("");
const loading = ref(false);
const saving = ref(false);
const depositing = ref(false);
const sending = ref(false);
const withdrawing = ref(false);
const suggestedStrategy = ref("");
const lastSyncedAt = ref<Date | null>(null);

const selectedModelData = computed(() => modelData.value?.models.find((model) => model.id === selectedModel.value));
const isActive = computed(() => account.value?.settings.agent_status === "active");
const hasFunds = computed(() => BigInt(portfolio.value?.native_balance || "0") > 0n || Boolean(portfolio.value?.tokens.length));
const latestRun = computed(() => activity.value?.runs[0]);
const strategySaved = computed(() => Boolean(
  account.value
  && account.value.settings.model_id === selectedModel.value
  && account.value.settings.strategy === strategy.value.trim(),
));
const canStart = computed(() => hasFunds.value && strategySaved.value && strategy.value.trim().length >= 20);
const walletActionLabel = computed(() => {
  if (walletStatus.value === "connecting") return "Connecting wallet";
  if (walletStatus.value === "signing") return authenticated.value ? "Approve agent wallet" : "Approve sign in";
  if (walletStatus.value === "provisioning") return "Creating agent wallet";
  return authenticated.value ? "Create agent wallet" : "Connect and create agent";
});
const onboardingStep = computed(() => {
  if (!authenticated.value) return 1;
  if (!account.value) return 2;
  if (!hasFunds.value || !strategySaved.value) return 3;
  return 4;
});
const startGuidance = computed(() => {
  if (!strategySaved.value) return "Save the selected model and strategy before starting.";
  if (!hasFunds.value) return "Deposit ETH into the trading wallet before starting.";
  return "The wallet is funded and the strategy is ready for live execution.";
});
const lastSyncedLabel = computed(() => lastSyncedAt.value
  ? `Updated ${lastSyncedAt.value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
  : "Syncing live data");
const authHeader = async () => ({ authorization: `Bearer ${await getAccessToken()}` });

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return fallback;
}

function recommendedStrategy(model: api.UserAgentModel | undefined): string {
  if (!model) return "";
  return `${model.strategy}. ${model.thesis} Check live liquidity and volume before each swap, preserve the network-fee reserve, and exit when the setup no longer matches this strategy.`;
}

function applyAccountSettings(): void {
  if (!account.value) return;
  selectedModel.value = account.value.settings.model_id;
  const saved = account.value.settings.strategy;
  suggestedStrategy.value = recommendedStrategy(selectedModelData.value);
  strategy.value = saved || suggestedStrategy.value;
}

function selectModel(id: string): void {
  const replaceDraft = !strategy.value.trim() || strategy.value === suggestedStrategy.value;
  selectedModel.value = id;
  suggestedStrategy.value = recommendedStrategy(selectedModelData.value);
  if (replaceDraft) strategy.value = suggestedStrategy.value;
}

async function loadPrivateData(): Promise<void> {
  if (!account.value) return;
  const client = apiClient({ auth: await authHeader(), requestInit: { cache: "no-store" } });
  const [portfolioResult, activityResult] = await Promise.allSettled([
    client.api.getPortfolio(),
    client.api.getUserAgentActivity(),
  ]);
  if (portfolioResult.status === "fulfilled") portfolio.value = portfolioResult.value;
  if (activityResult.status === "fulfilled") activity.value = activityResult.value;
  if (portfolioResult.status === "fulfilled" || activityResult.status === "fulfilled") lastSyncedAt.value = new Date();
}

async function connect(): Promise<void> {
  pageError.value = "";
  try {
    await connectWallet();
    const existing = await getExistingAccount();
    if (!existing) {
      notice.value = "Approve the second signature to create a separate RobinArena trading wallet.";
      await provisionAgentWallet();
    }
    applyAccountSettings();
    await loadPrivateData();
    notice.value = existing ? "Wallet connected." : "Agent wallet created. Choose a strategy and deposit ETH next.";
  } catch (error) {
    pageError.value = errorMessage(error, "The wallet could not connect");
  }
}

async function createAgentWallet(): Promise<void> {
  pageError.value = "";
  try {
    await provisionAgentWallet();
    applyAccountSettings();
    await loadPrivateData();
  } catch (error) {
    pageError.value = errorMessage(error, "The agent wallet could not be created");
  }
}

async function copyAddress(): Promise<void> {
  if (!account.value) return;
  await navigator.clipboard.writeText(account.value.agent_wallet_address);
  notice.value = "Agent wallet address copied.";
}

async function saveSettings(startAfterSave = false): Promise<void> {
  if (!account.value) return;
  saving.value = true;
  pageError.value = "";
  notice.value = "";
  try {
    const client = apiClient({ auth: await authHeader() });
    account.value.settings = await client.api.updateUserAgentSettings({
      model_id: selectedModel.value,
      strategy: strategy.value,
    });
    notice.value = "Model and strategy saved.";
    if (startAfterSave && hasFunds.value) await setStatus("active");
  } catch (error) {
    pageError.value = errorMessage(error, "The strategy could not be saved");
  } finally { saving.value = false; }
}

async function deposit(): Promise<void> {
  if (!account.value) return;
  depositing.value = true;
  pageError.value = "";
  notice.value = "";
  try {
    const hash = await depositEth(account.value.agent_wallet_address, depositAmount.value);
    notice.value = `Deposit submitted: ${shortAddress(hash)}`;
    window.setTimeout(() => void refresh(), 5_000);
  } catch (error) {
    pageError.value = errorMessage(error, "The deposit was not submitted");
  } finally { depositing.value = false; }
}

async function setStatus(status: "paused" | "active"): Promise<void> {
  if (!account.value) return;
  loading.value = true;
  pageError.value = "";
  notice.value = "";
  try {
    const client = apiClient({ auth: await authHeader() });
    account.value.settings = await client.api.setUserAgentStatus({ status });
    notice.value = status === "active" ? "Agent started. The first cycle is being claimed." : "Agent paused.";
    await loadPrivateData();
  } catch (error) {
    pageError.value = errorMessage(error, `The agent could not be ${status === "active" ? "started" : "paused"}`);
  } finally { loading.value = false; }
}

async function sendInstruction(): Promise<void> {
  const message = instruction.value.trim();
  if (!message) return;
  sending.value = true;
  pageError.value = "";
  try {
    const client = apiClient({ auth: await authHeader() });
    await client.api.sendUserAgentMessage({ message });
    instruction.value = "";
    notice.value = "Instruction queued for the next cycle.";
    await loadPrivateData();
  } catch (error) {
    pageError.value = errorMessage(error, "The instruction could not be queued");
  } finally { sending.value = false; }
}

async function withdrawAll(assetAddress: string): Promise<void> {
  if (!account.value || isActive.value) return;
  withdrawing.value = true;
  pageError.value = "";
  try {
    const client = apiClient({ auth: await authHeader() });
    const result = await client.api.withdrawFunds({
      request_id: crypto.randomUUID(), asset_address: assetAddress, amount: "all",
    });
    if (result.status === "failed") throw new Error(result.error || "Withdrawal failed");
    notice.value = `${result.asset_symbol} withdrawal submitted to your connected wallet.`;
    await loadPrivateData();
  } catch (error) {
    pageError.value = errorMessage(error, "The withdrawal could not be submitted");
  } finally { withdrawing.value = false; }
}

async function refresh(): Promise<void> {
  loading.value = true;
  try { await loadPrivateData(); }
  finally { loading.value = false; }
}

const { pause, resume } = useIntervalFn(() => {
  if (authenticated.value && account.value && document.visibilityState === "visible") void loadPrivateData();
}, 8_000, { immediate: false });

onMounted(async () => {
  await initialize();
  if (authenticated.value) {
    try {
      const existing = await getExistingAccount();
      if (existing) {
        applyAccountSettings();
        await loadPrivateData();
      } else {
        await createAgentWallet();
      }
    } catch { /* the page exposes the session error */ }
  }
  selectedModel.value ||= modelData.value?.models[0]?.id || "";
  resume();
});
onBeforeUnmount(pause);
</script>

<template>
  <div class="page-shell userapp-page">
    <header v-if="!account" class="userapp-hero">
      <div>
        <h1>Put your strategy behind a frontier model.</h1>
        <p>Choose one of the models trading in RobinArena, fund its private Robinhood Chain wallet with ETH, and let it research and trade tokens continuously.</p>
      </div>
      <dl class="userapp-facts">
        <div><dt>Network</dt><dd>Robinhood Chain</dd></div>
        <div><dt>Cycle break</dt><dd>12 seconds</dd></div>
        <div><dt>Execution</dt><dd>Live swaps</dd></div>
      </dl>
    </header>

    <div v-if="modelError" class="userapp-alert is-error" role="alert">{{ modelError.message }}</div>
    <div v-if="pageError || walletError" class="userapp-alert is-error" role="alert">{{ pageError || walletError }}</div>
    <div v-if="notice" class="userapp-alert" role="status">{{ notice }}</div>

    <ol v-if="!account" class="onboarding-progress" aria-label="Agent setup progress">
      <li
        v-for="step in [{ number: 1, label: 'Connect owner' }, { number: 2, label: 'Create agent' }, { number: 3, label: 'Fund and configure' }, { number: 4, label: 'Trade' }]"
        :key="step.number"
        :class="{ 'is-complete': onboardingStep > step.number, 'is-current': onboardingStep === step.number }"
        :aria-current="onboardingStep === step.number ? 'step' : undefined"
      >
        <span>
          <Icon v-if="onboardingStep > step.number" name="ph:check-circle-fill" aria-hidden="true" />
          <template v-else>{{ step.number }}</template>
        </span>
        {{ step.label }}
      </li>
    </ol>

    <section v-if="!authenticated" class="userapp-entry">
      <div>
        <h2>Connect the wallet that will own the agent</h2>
        <p>Two wallet prompts follow: one signs you in and one creates a separate RobinArena trading wallet.</p>
      </div>
      <button class="button button-primary" type="button" :disabled="walletBusy" @click="connect">
        <Icon name="ph:wallet" aria-hidden="true" />
        {{ walletActionLabel }}
      </button>
    </section>

    <section v-else-if="!account" class="userapp-entry">
      <div>
        <h2>Approve the agent wallet</h2>
        <p>The login succeeded. Approve the RobinArena-specific signature to finish creating the trading wallet.</p>
      </div>
      <button class="button button-primary" type="button" :disabled="walletBusy" @click="createAgentWallet">
        {{ walletActionLabel }}
      </button>
    </section>

    <template v-else>
      <header class="agent-console-header">
        <div class="console-identity">
          <ModelGlyph v-if="selectedModelData" :code="selectedModelData.code" :accent="selectedModelData.accent" size="medium" />
          <div>
            <span class="agent-state" :class="{ 'is-active': isActive }">{{ isActive ? "Trading live" : "Paused" }}</span>
            <h1>{{ selectedModelData?.name || "Configure your agent" }}</h1>
            <p>{{ selectedModelData?.strategy || "Choose a model and define its strategy." }}</p>
          </div>
        </div>

        <div class="console-runtime">
          <div>
            <span>Cycle</span>
            <strong>12s break</strong>
          </div>
          <div>
            <span>Data</span>
            <strong>{{ lastSyncedLabel }}</strong>
          </div>
          <div>
            <span>Wallet</span>
            <strong>{{ shortAddress(account.agent_wallet_address) }}</strong>
          </div>
        </div>

        <div class="console-actions">
          <button v-if="!isActive" class="button button-primary" type="button" :disabled="loading || !canStart" @click="setStatus('active')"><Icon name="ph:play-fill" />Start trading</button>
          <button v-else class="button button-danger" type="button" :disabled="loading" @click="setStatus('paused')"><Icon name="ph:pause" />Pause agent</button>
          <button type="button" class="button button-quiet" :disabled="loading" @click="refresh"><Icon name="ph:arrows-clockwise" aria-hidden="true" />Refresh</button>
          <button type="button" class="console-disconnect" @click="logout">Disconnect {{ wallet ? shortAddress(wallet.address) : "" }}</button>
        </div>
      </header>

      <p v-if="!isActive" class="console-guidance">{{ startGuidance }}</p>

      <UserFundsPanel
        v-model:deposit-amount="depositAmount"
        :account="account"
        :portfolio="portfolio"
        :agent-active="isActive"
        :depositing="depositing"
        :withdrawing="withdrawing"
        @copy="copyAddress"
        @deposit="deposit"
        @withdraw="withdrawAll"
      />

      <div class="agent-workbench">
        <section class="activity-console" aria-labelledby="activity-title">
          <header class="workbench-heading">
            <div><h2 id="activity-title">Live activity</h2><p>Research, tool results, decisions, and swaps stream here as the model works.</p></div>
            <span v-if="latestRun">Run {{ latestRun.status }}</span>
          </header>
          <form class="instruction-form" @submit.prevent="sendInstruction">
            <Icon name="ph:terminal-window" aria-hidden="true" />
            <input v-model="instruction" :disabled="!isActive || sending" placeholder="Give the next cycle a one-time instruction" aria-label="One-time agent instruction">
            <button type="submit" :disabled="!isActive || sending || !instruction.trim()">{{ sending ? "Sending" : "Send" }}</button>
          </form>
          <div v-if="activity?.messages.length" class="activity-stream">
            <article v-for="message in activity.messages" :key="message.id" :class="`is-${message.role}`">
              <header><strong>{{ message.role === "assistant" ? selectedModelData?.name : message.role === "tool" ? message.tool_name?.replaceAll('_', ' ') : "You" }}</strong><time>{{ new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time></header>
              <p>{{ message.content }}</p>
            </article>
          </div>
          <div v-else class="activity-empty">
            <Icon name="ph:waveform" aria-hidden="true" />
            <strong>No cycles recorded yet</strong>
            <p>Save the strategy, fund the wallet, and start trading to begin the live stream.</p>
          </div>
        </section>

        <aside class="strategy-console" aria-labelledby="strategy-title">
          <header class="workbench-heading">
            <div><h2 id="strategy-title">Model and strategy</h2><p>These settings apply to every autonomous cycle.</p></div>
            <span>{{ strategySaved ? "Saved" : "Draft" }}</span>
          </header>
          <UserModelPicker :models="modelData?.models || []" :selected-id="selectedModel" :disabled="isActive" @select="selectModel" />
          <label class="strategy-field">
            <span>Trading strategy</span>
            <textarea v-model="strategy" :disabled="isActive" rows="8" placeholder="Describe qualifying assets, entry signals, sizing, exits, and risk limits." />
            <small>Be specific about liquidity, signals, exposure, and when the agent should stay in ETH.</small>
          </label>
          <button class="button button-primary strategy-save" type="button" :disabled="saving || isActive || !selectedModel || strategy.trim().length < 20" @click="saveSettings(hasFunds)">{{ saving ? "Saving" : hasFunds ? "Save and start trading" : "Save model and strategy" }}</button>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.userapp-page{padding:clamp(3rem,6vw,6rem) 0 7rem}.userapp-hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(20rem,.7fr);gap:clamp(3rem,8vw,9rem);align-items:end;padding-bottom:3rem;border-bottom:1px solid var(--color-line)}.userapp-hero h1{max-width:14ch;margin:0;font-size:clamp(3rem,7vw,6.8rem);line-height:.94;letter-spacing:-.065em;font-weight:650}.userapp-hero p{max-width:46rem;margin:1.75rem 0 0;color:var(--color-body-medium);font-size:clamp(1rem,1.4vw,1.2rem)}.userapp-facts{margin:0}.userapp-facts div{display:flex;justify-content:space-between;gap:1rem;padding:1rem 0;border-top:1px solid var(--color-line)}.userapp-facts dt{color:var(--color-muted)}.userapp-facts dd{margin:0;font-family:var(--font-mono);font-size:.88rem}.userapp-alert{margin-top:1.25rem;padding:1rem 1.1rem;border:1px solid var(--color-line-strong);border-radius:var(--radius-medium);background:var(--color-surface);color:var(--color-body-strong)}.userapp-alert.is-error{border-color:color-mix(in srgb,var(--color-negative) 55%,var(--color-line));color:var(--color-negative)}.userapp-entry{display:flex;align-items:center;justify-content:space-between;gap:3rem;margin-top:3rem;padding:2rem;border:1px solid var(--color-line);border-radius:var(--radius-large);background:var(--color-surface)}.userapp-entry h2{margin:0 0 .4rem;font-size:1.5rem}.userapp-entry p{max-width:44rem;margin:0;color:var(--color-muted)}.userapp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:2rem;margin-top:2rem;padding:1rem 0;border-bottom:1px solid var(--color-line)}.agent-identity,.toolbar-actions{display:flex;align-items:center;gap:.8rem}.agent-identity>div{display:grid}.agent-identity small{color:var(--color-muted);font-family:var(--font-mono)}.agent-state{padding:.3rem .5rem;border:1px solid var(--color-line-strong);border-radius:var(--radius-small);color:var(--color-muted);font-size:.75rem;font-weight:700}.agent-state.is-active{border-color:var(--color-positive);color:var(--color-positive)}.userapp-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(19rem,25rem);gap:1.5rem;margin-top:1.5rem}.userapp-main{display:grid;gap:1.5rem}.userapp-section,.wallet-panel,.control-panel,.token-panel{padding:clamp(1.25rem,2.5vw,2rem);border:1px solid var(--color-line);border-radius:var(--radius-large);background:var(--color-surface)}.userapp-section-head,.wallet-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}.userapp-section h2,.wallet-panel h2,.control-panel h2,.token-panel h2{margin:0;font-size:1.25rem}.userapp-section-head p,.wallet-panel-head p,.control-panel p{margin:.3rem 0 0;color:var(--color-muted)}.userapp-section-head>span{color:var(--color-quiet);font-family:var(--font-mono);font-size:.75rem}.strategy-field{display:grid;gap:.65rem;margin:1.5rem 0}.strategy-field>span,.deposit-form label>span{font-weight:650}.strategy-field textarea,.instruction-form input,.deposit-form input{width:100%;border:1px solid var(--color-line-strong);border-radius:var(--radius-small);outline:0;background:var(--color-background);color:var(--color-text)}.strategy-field textarea{min-height:10rem;padding:1rem;resize:vertical;line-height:1.55}.strategy-field textarea:focus,.instruction-form input:focus,.deposit-form input:focus{border-color:var(--color-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-accent) 20%,transparent)}.strategy-field small,.wallet-note{color:var(--color-quiet)}.userapp-sidebar{display:grid;align-content:start;gap:1rem}.wallet-panel-head a{display:grid;width:2.5rem;height:2.5rem;place-items:center;border:1px solid var(--color-line-strong);border-radius:var(--radius-small)}.eth-balance{display:block;margin:1.5rem 0;font-family:var(--font-mono);font-size:clamp(2rem,4vw,3.3rem);letter-spacing:-.06em}.eth-balance small{font-size:.9rem;letter-spacing:0;color:var(--color-muted)}.wallet-address{display:flex;width:100%;align-items:center;justify-content:space-between;gap:.75rem;padding:.8rem;border:1px solid var(--color-line);border-radius:var(--radius-small);background:var(--color-background);cursor:pointer}.wallet-address code{overflow:hidden;color:var(--color-muted);font-family:var(--font-mono);font-size:.7rem;text-overflow:ellipsis}.deposit-form{display:grid;gap:1rem;margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--color-line)}.deposit-form label{display:grid;gap:.5rem}.deposit-form label div{display:flex;align-items:center;border:1px solid var(--color-line-strong);border-radius:var(--radius-small);background:var(--color-background)}.deposit-form input{border:0;padding:.75rem}.deposit-form label div>span{padding-right:.8rem;color:var(--color-muted);font-family:var(--font-mono);font-size:.78rem}.wallet-note{margin:.9rem 0 0;font-size:.78rem}.control-button{width:100%;margin-top:1rem}.button-danger{background:var(--color-negative);color:var(--color-danger-ink)}.instruction-form{display:grid;grid-template-columns:1fr auto;gap:.6rem;margin-bottom:1.2rem}.instruction-form input{min-height:2.8rem;padding:0 .85rem}.activity-stream{display:grid;max-height:38rem;overflow:auto;border-top:1px solid var(--color-line)}.activity-stream article{padding:1rem 0;border-bottom:1px solid var(--color-line)}.activity-stream article>div{display:flex;justify-content:space-between;gap:1rem}.activity-stream strong{text-transform:capitalize}.activity-stream time{color:var(--color-quiet);font-family:var(--font-mono);font-size:.72rem}.activity-stream p{margin:.45rem 0 0;color:var(--color-body-medium);white-space:pre-wrap}.activity-stream .is-tool p{font-family:var(--font-mono);font-size:.78rem;color:var(--color-muted)}.userapp-empty{padding:3rem 1rem;border:1px dashed var(--color-line-strong);color:var(--color-muted);text-align:center}.token-panel{display:grid;gap:.8rem}.token-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:.8rem;border-top:1px solid var(--color-line)}.token-row>div{display:grid}.token-row small{color:var(--color-muted);font-family:var(--font-mono)}.token-row button,.withdraw-eth{color:var(--color-accent);background:transparent;cursor:pointer;font-weight:650}.token-row button:disabled,.withdraw-eth:disabled{color:var(--color-quiet);cursor:not-allowed}.withdraw-eth{padding:1rem;border:1px solid var(--color-line-strong);border-radius:var(--radius-medium);background:var(--color-surface)}
:deep(.user-model-grid){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}:deep(.user-model-option){display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:.8rem;padding:.9rem;border:1px solid var(--color-line);border-radius:var(--radius-medium);background:var(--color-background);color:var(--color-text);text-align:left;cursor:pointer}:deep(.user-model-option:hover){border-color:var(--color-line-strong)}:deep(.user-model-option.is-selected){border-color:var(--model-accent);background:color-mix(in srgb,var(--model-accent) 7%,var(--color-background))}:deep(.user-model-option>span:not(.model-glyph)){display:grid}:deep(.user-model-option small){color:var(--color-muted)}:deep(.user-model-option>svg){color:var(--model-accent);font-size:1.2rem}
@media(max-width:900px){.userapp-hero,.userapp-workspace{grid-template-columns:1fr}.userapp-hero{gap:2.5rem}.userapp-sidebar{grid-row:1}.userapp-toolbar{align-items:flex-start}.toolbar-actions{flex-wrap:wrap;justify-content:flex-end}}@media(max-width:620px){.userapp-page{padding-top:2rem}.userapp-hero h1{font-size:clamp(2.8rem,15vw,4.5rem)}.userapp-entry,.userapp-toolbar{align-items:stretch;flex-direction:column}.toolbar-actions{justify-content:flex-start}:deep(.user-model-grid){grid-template-columns:1fr}.instruction-form{grid-template-columns:1fr}.userapp-section,.wallet-panel,.control-panel,.token-panel{padding:1.1rem}}
</style>

<style scoped>
.agent-console-header {
  display: grid;
  grid-template-columns: minmax(18rem, 1.15fr) minmax(25rem, 1fr) auto;
  align-items: center;
  gap: clamp(1.5rem, 4vw, 4.5rem);
  margin-top: 1.5rem;
  padding: 1.5rem 0;
  border-block: 1px solid var(--color-line);
}

.console-identity { display: flex; min-width: 0; align-items: center; gap: 1rem; }
.console-identity > div { min-width: 0; }
.console-identity h1 { overflow: hidden; margin: .3rem 0 0; font-size: clamp(1.7rem, 3vw, 2.7rem); letter-spacing: -.055em; line-height: 1; text-overflow: ellipsis; white-space: nowrap; }
.console-identity p { overflow: hidden; margin: .45rem 0 0; color: var(--color-body-medium); font-size: .8rem; text-overflow: ellipsis; white-space: nowrap; }
.agent-state { display: inline-flex; align-items: center; gap: .35rem; padding: 0; border: 0; color: var(--color-muted); font-size: .72rem; font-weight: 700; }
.agent-state::before { width: .45rem; height: .45rem; border-radius: 50%; background: var(--color-muted); content: ""; }
.agent-state.is-active { color: var(--color-positive); }
.agent-state.is-active::before { background: currentColor; }

.console-runtime { display: grid; grid-template-columns: .65fr 1.2fr 1fr; border-inline: 1px solid var(--color-line); }
.console-runtime > div { display: grid; min-width: 0; gap: .3rem; padding: .35rem 1rem; border-right: 1px solid var(--color-line); }
.console-runtime > div:last-child { border-right: 0; }
.console-runtime span { color: var(--color-quiet); font-size: .68rem; }
.console-runtime strong { overflow: hidden; font-family: var(--font-mono); font-size: .72rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }

.console-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
.console-disconnect { width: 100%; padding: .25rem 0 0; background: transparent; color: var(--color-quiet); cursor: pointer; font-size: .68rem; text-align: right; }
.console-disconnect:hover { color: var(--color-text); }
.console-guidance { margin: 0; padding: .65rem 1rem; border-bottom: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-body-medium); font-size: .78rem; text-align: center; }

.agent-workbench { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(23rem, .75fr); align-items: start; gap: 1px; margin-top: 1.5rem; background: var(--color-line); border-block: 1px solid var(--color-line); }
.activity-console,
.strategy-console { min-width: 0; background: var(--color-background); }
.workbench-heading { display: flex; min-height: 5.2rem; align-items: flex-start; justify-content: space-between; gap: 1.5rem; padding: 1.25rem 1.35rem; border-bottom: 1px solid var(--color-line); }
.workbench-heading h2 { margin: 0; font-size: 1.2rem; letter-spacing: -.035em; }
.workbench-heading p { max-width: 36rem; margin: .25rem 0 0; color: var(--color-body-medium); font-size: .8rem; }
.workbench-heading > span { flex: 0 0 auto; color: var(--color-quiet); font-family: var(--font-mono); font-size: .68rem; text-transform: capitalize; }

.instruction-form { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .65rem; margin: 0; padding: .85rem 1.35rem; border-bottom: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-muted); }
.instruction-form input { min-height: 2.5rem; padding: 0; border: 0; background: transparent; }
.instruction-form input:focus { box-shadow: none; }
.instruction-form button { min-height: 2.25rem; padding: .45rem .8rem; background: var(--color-accent); color: var(--color-accent-ink); cursor: pointer; font-size: .74rem; font-weight: 700; }
.instruction-form button:disabled { cursor: not-allowed; opacity: .4; }

.activity-stream { display: grid; max-height: 46rem; overflow: auto; border: 0; }
.activity-stream article { position: relative; padding: 1.1rem 1.35rem 1.2rem 3rem; border-bottom: 1px solid var(--color-line); }
.activity-stream article::before { position: absolute; top: 1.35rem; left: 1.35rem; width: .5rem; height: .5rem; border: 1px solid var(--color-line-strong); background: var(--color-background); content: ""; transform: rotate(45deg); }
.activity-stream article.is-assistant::before { border-color: var(--color-accent); background: var(--color-accent); }
.activity-stream article.is-tool { background: color-mix(in srgb, var(--color-surface) 68%, transparent); }
.activity-stream article > header { display: flex; justify-content: space-between; gap: 1rem; }
.activity-stream article > header strong { font-size: .76rem; text-transform: capitalize; }
.activity-stream article p { max-width: 68rem; margin: .5rem 0 0; color: var(--color-body-medium); font-size: .84rem; line-height: 1.55; white-space: pre-wrap; }
.activity-stream .is-tool p { font-family: var(--font-mono); font-size: .74rem; color: var(--color-muted); }
.activity-stream time { color: var(--color-quiet); font-family: var(--font-mono); font-size: .68rem; }
.activity-empty { display: grid; min-height: 20rem; place-content: center; justify-items: center; padding: 3rem; color: var(--color-muted); text-align: center; }
.activity-empty > svg { margin-bottom: 1rem; color: var(--color-accent); font-size: 2rem; }
.activity-empty strong { color: var(--color-text); }
.activity-empty p { max-width: 30rem; margin: .4rem 0 0; font-size: .82rem; }

.strategy-console :deep(.user-model-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; padding: 1.1rem 1.35rem 0; }
.strategy-console :deep(.user-model-option) { border-width: 1px 0 0; border-radius: 0; padding: .85rem .25rem; }
.strategy-console :deep(.user-model-option:nth-child(odd)) { padding-right: .8rem; border-right: 1px solid var(--color-line); }
.strategy-console :deep(.user-model-option:nth-child(even)) { padding-left: .8rem; }
.strategy-console :deep(.user-model-option.is-selected) { box-shadow: inset 0 2px 0 var(--model-accent); }
.strategy-field { margin: 1.25rem 1.35rem; }
.strategy-field textarea { min-height: 14rem; border-radius: 0; background: var(--color-surface); }
.strategy-field small { line-height: 1.5; }
.strategy-save { width: calc(100% - 2.7rem); margin: 0 1.35rem 1.35rem; }

@media (max-width: 72rem) {
  .agent-console-header { grid-template-columns: minmax(0, 1fr) auto; }
  .console-runtime { grid-column: 1 / -1; grid-row: 2; }
  .agent-workbench { grid-template-columns: minmax(0, 1.25fr) minmax(21rem, .85fr); }
}

@media (max-width: 56rem) {
  .agent-console-header { grid-template-columns: 1fr; gap: 1.25rem; }
  .console-runtime { grid-column: auto; grid-row: auto; }
  .console-actions { justify-content: flex-start; }
  .console-disconnect { width: auto; padding: .6rem; text-align: left; }
  .agent-workbench { grid-template-columns: 1fr; }
  .strategy-console { grid-row: 1; }
  .activity-console { grid-row: 2; }
}

@media (max-width: 38rem) {
  .console-identity h1 { font-size: 1.9rem; }
  .console-runtime { grid-template-columns: 1fr; border: 1px solid var(--color-line); }
  .console-runtime > div { padding: .7rem .8rem; border-right: 0; border-bottom: 1px solid var(--color-line); }
  .console-runtime > div:last-child { border-bottom: 0; }
  .console-actions .button { flex: 1 1 auto; }
  .strategy-console :deep(.user-model-grid) { grid-template-columns: 1fr; }
  .strategy-console :deep(.user-model-option:nth-child(odd)) { padding-right: .25rem; border-right: 0; }
  .strategy-console :deep(.user-model-option:nth-child(even)) { padding-left: .25rem; }
  .activity-stream article { padding-left: 2.6rem; }
  .activity-stream article::before { left: 1.1rem; }
}
</style>

<style scoped>
.userapp-entry { margin-top: 1.5rem; }
.onboarding-progress { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 1.5rem 0 0; padding: 0; border-block: 1px solid var(--color-line); list-style: none; }
.onboarding-progress li { display: flex; min-width: 0; align-items: center; gap: .65rem; padding: .9rem 1rem; border-right: 1px solid var(--color-line); color: var(--color-quiet); font-size: .8rem; font-weight: 600; }
.onboarding-progress li:last-child { border-right: 0; }
.onboarding-progress li > span { display: grid; width: 1.4rem; height: 1.4rem; flex: 0 0 auto; place-items: center; font-family: var(--font-mono); font-size: .7rem; }
.onboarding-progress li.is-complete { color: var(--color-body-medium); }
.onboarding-progress li.is-complete > span { color: var(--color-positive); font-size: 1.05rem; }
.onboarding-progress li.is-current { background: var(--color-surface); color: var(--color-text); box-shadow: inset 0 2px 0 var(--color-accent); }

@media (max-width: 620px) {
  .onboarding-progress { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .onboarding-progress li:nth-child(2) { border-right: 0; }
  .onboarding-progress li:nth-child(n + 3) { border-top: 1px solid var(--color-line); }
}
</style>
