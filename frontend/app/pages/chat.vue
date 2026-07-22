<script setup lang="ts">
import type { api } from "~/generated/encore-client";

useSeoMeta({
  title: "Chat with TradeFinder 1",
  description: "Connect a wallet holding 100 access tokens on Robinhood Chain and chat with RobinArena's TradeFinder 1 model.",
  ogTitle: "Chat with TradeFinder 1 | RobinArena",
  ogDescription: "Token-gated access to RobinArena's trading decision model.",
  ogType: "website",
  ogUrl: "https://robinarena.fun/chat",
  ogSiteName: "RobinArena",
  robots: "index, follow",
});
useHead({ link: [{ rel: "canonical", href: "https://robinarena.fun/chat" }] });

type ChatMessage = api.TradeFinderMessage;

const {
  authenticated,
  busy: walletBusy,
  error: walletError,
  wallet,
  connectWallet,
  getAccessToken,
  initialize,
  logout,
} = useUserWallet();

const access = ref<api.TradeFinderAccessResponse | null>(null);
const accessLoading = ref(false);
const sending = ref(false);
const pageError = ref("");
const draft = ref("");
const transcript = ref<ChatMessage[]>([]);
const transcriptElement = ref<HTMLElement | null>(null);

const eligible = computed(() => Boolean(access.value?.eligible));
const connectedAddress = computed(() => wallet.value?.address || access.value?.wallet_address || "");
const tokenLabel = computed(() => access.value?.token_symbol || "access tokens");
const balanceLabel = computed(() => {
  if (!access.value) return "Checking balance";
  const value = Number(access.value.formatted_balance);
  if (!Number.isFinite(value)) return access.value.formatted_balance;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
});
const gateState = computed(() => {
  if (!authenticated.value) return "Connect wallet";
  if (accessLoading.value) return "Checking balance";
  if (!access.value?.configured) return "Token pending";
  if (!eligible.value) return "Access locked";
  return "Access verified";
});

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message).trim();
    if (message) return message;
  }
  return fallback;
}

async function authClient() {
  const token = await getAccessToken();
  return apiClient({
    auth: { authorization: `Bearer ${token}` },
    requestInit: { cache: "no-store" },
  });
}

async function refreshAccess(): Promise<void> {
  if (!authenticated.value) {
    access.value = null;
    return;
  }
  accessLoading.value = true;
  pageError.value = "";
  try {
    access.value = await (await authClient()).api.getTradeFinderAccess();
  } catch (error) {
    access.value = null;
    pageError.value = errorMessage(error, "The token balance could not be verified");
  } finally {
    accessLoading.value = false;
  }
}

async function connect(): Promise<void> {
  pageError.value = "";
  try {
    await connectWallet();
    await refreshAccess();
  } catch (error) {
    pageError.value = errorMessage(error, "The wallet could not connect");
  }
}

async function disconnect(): Promise<void> {
  await logout();
  access.value = null;
  transcript.value = [];
  draft.value = "";
}

async function scrollToLatest(): Promise<void> {
  await nextTick();
  transcriptElement.value?.scrollTo({
    top: transcriptElement.value.scrollHeight,
    behavior: "smooth",
  });
}

async function sendMessage(): Promise<void> {
  const content = draft.value.trim();
  if (!content || sending.value || !eligible.value) return;
  pageError.value = "";
  draft.value = "";
  transcript.value.push({ role: "user", content });
  await scrollToLatest();
  sending.value = true;
  try {
    const response = await (await authClient()).api.chatWithTradeFinder({
      messages: transcript.value.slice(-24),
    });
    transcript.value.push(response.message);
  } catch (error) {
    transcript.value.pop();
    draft.value = content;
    const message = errorMessage(error, "TradeFinder 1 could not answer");
    await refreshAccess();
    pageError.value = message;
  } finally {
    sending.value = false;
    await scrollToLatest();
  }
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void sendMessage();
}

onMounted(async () => {
  await initialize();
  if (authenticated.value) await refreshAccess();
});
</script>

<template>
  <div class="page-shell tradefinder-page">
    <header class="tradefinder-heading">
      <div>
        <h1>Ask TradeFinder 1.</h1>
        <p>Review a setup, challenge a thesis, or examine why a trading decision went wrong.</p>
      </div>
    </header>

    <div v-if="pageError || walletError" class="tradefinder-alert" role="alert">
      <Icon name="ph:warning-circle" aria-hidden="true" />
      <span>{{ pageError || walletError }}</span>
    </div>

    <section class="tradefinder-workspace" aria-label="TradeFinder chat">
      <aside class="access-panel">
        <div class="access-model">
          <div class="access-model-mark" aria-hidden="true"><RobinArenaMark /></div>
          <div>
            <strong>TradeFinder 1</strong>
            <span>by RobinArena</span>
          </div>
        </div>

        <div class="access-rule">
          <Icon name="ph:coin" aria-hidden="true" />
          <p>Hold at least <strong>100 {{ access?.token_symbol || "tokens" }}</strong> in the connected wallet.</p>
        </div>

        <dl class="access-facts">
          <div>
            <dt>Status</dt>
            <dd :class="{ 'is-verified': eligible }">{{ gateState }}</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd>{{ authenticated ? `${balanceLabel} ${tokenLabel}` : "Connect to check" }}</dd>
          </div>
          <div>
            <dt>Wallet</dt>
            <dd>{{ connectedAddress ? shortAddress(connectedAddress) : "Not connected" }}</dd>
          </div>
        </dl>

        <button
          v-if="!authenticated"
          class="button button-primary access-action"
          type="button"
          :disabled="walletBusy"
          @click="connect"
        >
          <Icon name="ph:wallet" aria-hidden="true" />
          {{ walletBusy ? "Waiting for wallet" : "Connect wallet" }}
        </button>
        <button
          v-else-if="!eligible"
          class="button button-primary access-action"
          type="button"
          :disabled="accessLoading"
          @click="refreshAccess"
        >
          <Icon name="ph:arrows-clockwise" :class="{ 'is-spinning': accessLoading }" aria-hidden="true" />
          {{ accessLoading ? "Checking balance" : "Refresh balance" }}
        </button>
        <button
          v-if="authenticated"
          class="access-disconnect"
          :class="{ 'has-primary': !eligible }"
          type="button"
          @click="disconnect"
        >
          <Icon name="ph:sign-out" aria-hidden="true" />
          Disconnect wallet
        </button>

        <a
          v-if="access?.token_address"
          class="access-contract"
          :href="`https://robinhoodchain.blockscout.com/token/${access.token_address}`"
          target="_blank"
          rel="noopener noreferrer"
        >
          Verify token contract
          <Icon name="ph:arrow-up-right" aria-hidden="true" />
        </a>
      </aside>

      <div class="chat-panel">
        <div ref="transcriptElement" class="chat-transcript" aria-live="polite">
          <div v-if="!authenticated" class="chat-gate">
            <Icon name="ph:wallet" aria-hidden="true" />
            <h2>Connect your wallet</h2>
            <p>Sign one message to prove wallet ownership. RobinArena never receives your private key.</p>
            <button class="button button-primary" type="button" :disabled="walletBusy" @click="connect">
              {{ walletBusy ? "Waiting for wallet" : "Connect and sign in" }}
            </button>
          </div>

          <div v-else-if="accessLoading && !access" class="chat-gate">
            <Icon class="is-spinning" name="ph:circle-notch" aria-hidden="true" />
            <h2>Checking token balance</h2>
            <p>Reading the connected wallet on Robinhood Chain.</p>
          </div>

          <div v-else-if="!access?.configured" class="chat-gate">
            <Icon name="ph:lock-key" aria-hidden="true" />
            <h2>Access token pending</h2>
            <p>The RobinArena token contract has not been configured yet.</p>
          </div>

          <div v-else-if="!eligible" class="chat-gate">
            <Icon name="ph:lock-key" aria-hidden="true" />
            <h2>100 {{ access.token_symbol }} required</h2>
            <p>This wallet currently holds {{ balanceLabel }} {{ access.token_symbol }} on Robinhood Chain.</p>
            <button class="button button-primary" type="button" :disabled="accessLoading" @click="refreshAccess">
              {{ accessLoading ? "Checking balance" : "Check again" }}
            </button>
          </div>

          <template v-else>
            <article class="chat-message is-assistant">
              <div class="chat-avatar" aria-hidden="true"><RobinArenaMark /></div>
              <div>
                <header><strong>TradeFinder 1</strong><span>AI model by RobinArena</span></header>
                <p>What decision are we reviewing? Share the asset, time horizon, current position, and the evidence behind your thesis.</p>
              </div>
            </article>
            <article
              v-for="(message, index) in transcript"
              :key="`${index}-${message.role}`"
              class="chat-message"
              :class="`is-${message.role}`"
            >
              <div class="chat-avatar" aria-hidden="true">
                <RobinArenaMark v-if="message.role === 'assistant'" />
                <span v-else>YOU</span>
              </div>
              <div>
                <header>
                  <strong>{{ message.role === "assistant" ? "TradeFinder 1" : "You" }}</strong>
                </header>
                <p>{{ message.content }}</p>
              </div>
            </article>
            <article v-if="sending" class="chat-message is-assistant is-thinking">
              <div class="chat-avatar" aria-hidden="true"><RobinArenaMark /></div>
              <div>
                <header><strong>TradeFinder 1</strong><span>Reviewing the decision</span></header>
                <p><span></span><span></span><span></span></p>
              </div>
            </article>
          </template>
        </div>

        <form class="chat-composer" @submit.prevent="sendMessage">
          <label for="tradefinder-prompt">Message TradeFinder 1</label>
          <div>
            <textarea
              id="tradefinder-prompt"
              v-model="draft"
              rows="2"
              maxlength="4000"
              :disabled="!eligible || sending"
              :placeholder="eligible ? 'Ask about a position, setup, or risk…' : 'Verify token access to start chatting'"
              @keydown="handleComposerKeydown"
            />
            <button type="submit" :disabled="!eligible || sending || !draft.trim()" aria-label="Send message">
              <Icon v-if="sending" class="is-spinning" name="ph:circle-notch" aria-hidden="true" />
              <Icon v-else name="ph:paper-plane-tilt" aria-hidden="true" />
            </button>
          </div>
          <p>TradeFinder 1 can be wrong. Verify market data and use your own risk limits.</p>
        </form>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tradefinder-page { padding: clamp(2.5rem, 5vw, 5rem) 0 4rem; }
.tradefinder-heading { padding-bottom: 2rem; }
.tradefinder-heading h1 { margin: 0; font-size: clamp(2.8rem, 6vw, 5.6rem); font-weight: 650; letter-spacing: -.065em; line-height: .94; }
.tradefinder-heading p { max-width: 42rem; margin: 1.25rem 0 0; color: var(--color-body-medium); font-size: 1rem; }
.tradefinder-alert { display: flex; align-items: flex-start; gap: .65rem; margin-bottom: 1rem; padding: .85rem 1rem; border: 1px solid color-mix(in srgb, var(--color-negative) 55%, var(--color-line)); color: var(--color-negative); font-size: .82rem; }
.tradefinder-alert svg { margin-top: .1rem; flex: 0 0 auto; }
.tradefinder-workspace { display: grid; min-height: min(46rem, calc(100dvh - 13rem)); grid-template-columns: minmax(16rem, 20rem) minmax(0, 1fr); border-block: 1px solid var(--color-line); }
.access-panel { display: flex; min-width: 0; flex-direction: column; padding: 1.35rem 1.25rem; border-right: 1px solid var(--color-line); background: var(--color-surface); }
.access-model { display: flex; align-items: center; gap: .8rem; }
.access-model-mark { display: grid; width: 2.7rem; height: 2.7rem; flex: 0 0 auto; place-items: center; color: var(--color-accent); }
.access-model-mark svg { width: 100%; height: 100%; }
.access-model > div:last-child { display: grid; }
.access-model strong { font-size: .9rem; }
.access-model span { color: var(--color-muted); font-size: .72rem; }
.access-rule { display: grid; grid-template-columns: auto 1fr; gap: .65rem; margin-top: 1.5rem; padding: 1rem 0; border-block: 1px solid var(--color-line); }
.access-rule svg { margin-top: .15rem; color: var(--color-accent); font-size: 1.05rem; }
.access-rule p { margin: 0; color: var(--color-body-medium); font-size: .78rem; line-height: 1.55; }
.access-rule strong { color: var(--color-text); }
.access-facts { margin: 1rem 0 1.4rem; }
.access-facts div { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .75rem; padding: .55rem 0; }
.access-facts dt { color: var(--color-quiet); font-size: .7rem; }
.access-facts dd { overflow: hidden; margin: 0; color: var(--color-body-medium); font-family: var(--font-mono); font-size: .68rem; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.access-facts dd.is-verified { color: var(--color-positive); }
.access-action { width: 100%; margin-top: auto; }
.access-disconnect { display: flex; align-items: center; justify-content: center; gap: .45rem; margin-top: auto; padding: .7rem; background: transparent; color: var(--color-muted); cursor: pointer; font-size: .74rem; }
.access-disconnect.has-primary { margin-top: .35rem; }
.access-disconnect:hover { color: var(--color-text); }
.access-contract { display: flex; align-items: center; justify-content: center; gap: .35rem; margin-top: .65rem; color: var(--color-quiet); font-size: .68rem; text-decoration: none; }
.access-contract:hover { color: var(--color-accent); }
.chat-panel { display: grid; min-width: 0; grid-template-rows: minmax(0, 1fr) auto; background: var(--color-background); }
.chat-transcript { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--color-line-strong) transparent; }
.chat-gate { display: grid; min-height: 100%; place-content: center; justify-items: center; padding: 3rem; text-align: center; }
.chat-gate > svg { margin-bottom: 1.2rem; color: var(--color-accent); font-size: 2rem; }
.chat-gate h2 { margin: 0; font-size: clamp(1.5rem, 3vw, 2.2rem); letter-spacing: -.04em; }
.chat-gate p { max-width: 31rem; margin: .65rem 0 1.4rem; color: var(--color-body-medium); font-size: .85rem; }
.chat-message { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .9rem; padding: 1.35rem clamp(1.2rem, 4vw, 3rem); border-bottom: 1px solid var(--color-line); }
.chat-message.is-user { background: var(--color-surface); }
.chat-avatar { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid var(--color-line-strong); color: var(--color-muted); font-family: var(--font-mono); font-size: .58rem; }
.chat-message.is-assistant .chat-avatar { border-color: var(--color-accent); color: var(--color-accent); }
.chat-avatar svg { width: 1.35rem; height: 1.35rem; }
.chat-message header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .55rem; }
.chat-message header strong { font-size: .8rem; }
.chat-message header span { color: var(--color-quiet); font-size: .68rem; }
.chat-message p { max-width: 58rem; margin: .5rem 0 0; color: var(--color-body-strong); font-size: .88rem; line-height: 1.65; white-space: pre-wrap; }
.is-thinking p { display: flex; gap: .3rem; padding-top: .25rem; }
.is-thinking p span { width: .35rem; height: .35rem; border-radius: 50%; background: var(--color-muted); animation: thinking 1s ease-in-out infinite alternate; }
.is-thinking p span:nth-child(2) { animation-delay: 180ms; }
.is-thinking p span:nth-child(3) { animation-delay: 360ms; }
.chat-composer { padding: 1rem clamp(1.2rem, 4vw, 3rem) 1.1rem; border-top: 1px solid var(--color-line); background: var(--color-surface); }
.chat-composer > label { display: block; margin-bottom: .45rem; color: var(--color-muted); font-size: .7rem; font-weight: 600; }
.chat-composer > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; border: 1px solid var(--color-line-strong); background: var(--color-background); }
.chat-composer > div:focus-within { border-color: var(--color-accent); }
.chat-composer textarea { width: 100%; min-height: 4.2rem; max-height: 12rem; padding: .85rem 1rem; border: 0; outline: 0; resize: vertical; background: transparent; line-height: 1.5; }
.chat-composer textarea::placeholder { color: var(--color-quiet); }
.chat-composer button { display: grid; width: 2.8rem; height: 2.8rem; margin: .55rem; place-items: center; background: var(--color-accent); color: var(--color-accent-ink); cursor: pointer; }
.chat-composer button:disabled { cursor: not-allowed; opacity: .35; }
.chat-composer > p { margin: .55rem 0 0; color: var(--color-quiet); font-size: .66rem; }
@keyframes thinking { to { opacity: .25; transform: translateY(-.18rem); } }
@media (max-width: 54rem) {
  .tradefinder-workspace { grid-template-columns: 1fr; }
  .access-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 1.5rem; border-right: 0; border-bottom: 1px solid var(--color-line); }
  .access-rule { margin-top: 0; }
  .access-facts { grid-column: 1 / -1; }
  .access-action, .access-disconnect { grid-column: 1 / -1; margin-top: 0; }
  .access-contract { grid-column: 1 / -1; }
  .chat-panel { min-height: 38rem; }
}
@media (max-width: 36rem) {
  .tradefinder-page { width: 100%; padding-top: 2rem; }
  .tradefinder-heading { width: calc(100% - 2rem); margin-inline: auto; }
  .tradefinder-heading h1 { font-size: 2.8rem; }
  .tradefinder-alert { margin-inline: 1rem; }
  .tradefinder-workspace { min-height: calc(100dvh - 12rem); }
  .access-panel { grid-template-columns: 1fr; }
  .access-rule { margin-top: 1rem; }
  .chat-gate { padding: 2rem 1.2rem; }
  .chat-message { padding-inline: 1rem; }
  .chat-composer { padding-inline: 1rem; }
}
@media (prefers-reduced-motion: reduce) {
  .is-thinking p span { animation: none; }
  .chat-transcript { scroll-behavior: auto; }
}
</style>
