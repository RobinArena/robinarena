<script setup lang="ts">
import { formatUnits } from "viem";
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
const authHeader = async () => ({ authorization: `Bearer ${await getAccessToken()}` });

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function readableAmount(value: string, decimals: number, maximum = 6): string {
  const [whole, fraction = ""] = formatUnits(BigInt(value), decimals).split(".");
  const trimmed = fraction.slice(0, maximum).replace(/0+$/, "");
  return trimmed ? `${whole ?? "0"}.${trimmed}` : (whole ?? "0");
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
    <header class="userapp-hero">
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

    <ol class="onboarding-progress" aria-label="Agent setup progress">
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
      <section class="userapp-toolbar" aria-label="Agent account">
        <div class="agent-identity">
          <span class="agent-state" :class="{ 'is-active': isActive }">{{ isActive ? "Trading" : "Paused" }}</span>
          <div><strong>{{ selectedModelData?.name || "Choose a model" }}</strong><small>{{ shortAddress(account.agent_wallet_address) }}</small></div>
        </div>
        <div class="toolbar-actions">
          <button type="button" class="button button-quiet" :disabled="loading" @click="refresh"><Icon name="ph:arrows-clockwise" aria-hidden="true" />Refresh</button>
          <button type="button" class="button button-quiet" @click="logout">Disconnect {{ wallet ? shortAddress(wallet.address) : "" }}</button>
        </div>
      </section>

      <div class="userapp-workspace">
        <main class="userapp-main">
          <section class="userapp-section">
            <div class="userapp-section-head"><div><h2>Choose the model</h2><p>The model controls research and decisions. Your strategy sets its objective and boundaries.</p></div></div>
            <UserModelPicker :models="modelData?.models || []" :selected-id="selectedModel" :disabled="isActive" @select="selectModel" />
            <label class="strategy-field">
              <span>Trading strategy</span>
              <textarea v-model="strategy" :disabled="isActive" rows="6" placeholder="Example: Trade liquid Robinhood Chain tokens with at least $100k liquidity. Prefer 1-hour momentum confirmed by rising volume. Keep at least 35% in ETH and exit when momentum reverses." />
              <small>Describe assets, signals, position sizing, exits, and risk limits. Contract addresses are useful for token-specific strategies.</small>
            </label>
            <button class="button button-primary" type="button" :disabled="saving || isActive || !selectedModel || strategy.trim().length < 20" @click="saveSettings(hasFunds)">{{ saving ? "Saving" : hasFunds ? "Save and start trading" : "Save model and strategy" }}</button>
          </section>

          <section class="userapp-section">
            <div class="userapp-section-head"><div><h2>Agent activity</h2><p>Research, tool results, decisions, and execution appear in chronological order.</p></div><span v-if="latestRun">Last run {{ latestRun.status }}</span></div>
            <form class="instruction-form" @submit.prevent="sendInstruction">
              <input v-model="instruction" :disabled="!isActive || sending" placeholder="Give the agent a one-time instruction" aria-label="One-time agent instruction">
              <button class="button button-primary" type="submit" :disabled="!isActive || sending || !instruction.trim()">Send</button>
            </form>
            <div v-if="activity?.messages.length" class="activity-stream">
              <article v-for="message in activity.messages" :key="message.id" :class="`is-${message.role}`">
                <div><strong>{{ message.role === "assistant" ? selectedModelData?.name : message.role === "tool" ? message.tool_name?.replaceAll('_', ' ') : "You" }}</strong><time>{{ new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time></div>
                <p>{{ message.content }}</p>
              </article>
            </div>
            <div v-else class="userapp-empty">Start the agent to run its first research and trading cycle.</div>
          </section>
        </main>

        <aside class="userapp-sidebar">
          <section class="wallet-panel">
            <div class="wallet-panel-head"><div><h2>Trading wallet</h2><p>Robinhood Chain mainnet</p></div><a :href="account.explorer_url" target="_blank" rel="noopener noreferrer" aria-label="Open wallet in explorer"><Icon name="ph:arrow-up-right" /></a></div>
            <strong class="eth-balance">{{ portfolio ? readableAmount(portfolio.native_balance, 18, 5) : "…" }} <small>ETH</small></strong>
            <button class="wallet-address" type="button" @click="copyAddress"><code>{{ account.agent_wallet_address }}</code><Icon name="ph:copy" aria-hidden="true" /></button>
            <form class="deposit-form" @submit.prevent="deposit">
              <label><span>Deposit ETH</span><div><input v-model="depositAmount" inputmode="decimal" aria-label="ETH deposit amount"><span>ETH</span></div></label>
              <button class="button button-primary" type="submit" :disabled="depositing">{{ depositing ? "Confirm in wallet" : "Deposit from wallet" }}</button>
            </form>
            <p class="wallet-note">Send ETH only on Robinhood Chain. The agent keeps 0.005 ETH available for network fees.</p>
          </section>

          <section class="control-panel">
            <h2>Autonomy</h2>
            <p v-if="isActive">The model runs another cycle 12 seconds after each cycle completes. Failed runs retry within 20 seconds.</p>
            <p v-else>{{ startGuidance }}</p>
            <button v-if="!isActive" class="button button-primary control-button" type="button" :disabled="loading || !canStart" @click="setStatus('active')"><Icon name="ph:play-fill" />Start trading</button>
            <button v-else class="button button-danger control-button" type="button" :disabled="loading" @click="setStatus('paused')"><Icon name="ph:pause" />Pause agent</button>
          </section>

          <section v-if="portfolio?.tokens.length" class="token-panel">
            <h2>Token balances</h2>
            <div v-for="token in portfolio.tokens" :key="token.address" class="token-row">
              <div><strong>{{ token.symbol }}</strong><small>{{ readableAmount(token.balance, token.decimals) }}</small></div>
              <button type="button" :disabled="isActive || withdrawing" @click="withdrawAll(token.address)">Withdraw</button>
            </div>
          </section>

          <button v-if="portfolio && BigInt(portfolio.native_balance) > 0n" class="withdraw-eth" type="button" :disabled="isActive || withdrawing" @click="withdrawAll('0x0000000000000000000000000000000000000000')">Withdraw available ETH to owner wallet</button>
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
