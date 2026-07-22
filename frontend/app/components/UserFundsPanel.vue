<script setup lang="ts">
import { formatUnits } from "viem";
import type { api } from "~/generated/encore-client";

const props = defineProps<{
  account: api.SubaccountResponse;
  portfolio: api.PortfolioSnapshot | null;
  agentActive: boolean;
  depositing: boolean;
  withdrawing: boolean;
}>();

const emit = defineEmits<{
  copy: [];
  deposit: [];
  withdraw: [assetAddress: string];
}>();

const depositAmount = defineModel<string>("depositAmount", { required: true });
const nativeAsset = "0x0000000000000000000000000000000000000000";

const hasEth = computed(() => {
  try {
    return BigInt(props.portfolio?.native_balance || "0") > 0n;
  } catch {
    return false;
  }
});

function readableAmount(value: string, decimals: number, maximum = 6): string {
  const [whole = "0", fraction = ""] = formatUnits(BigInt(value), decimals).split(".");
  const trimmed = fraction.slice(0, maximum).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
</script>

<template>
  <section class="funds-desk" aria-labelledby="funds-title">
    <header class="funds-desk-header">
      <div>
        <h2 id="funds-title">Funds</h2>
        <p>Capital available to this agent on Robinhood Chain.</p>
      </div>
      <a :href="account.explorer_url" target="_blank" rel="noopener noreferrer">
        View on explorer
        <Icon name="ph:arrow-up-right" aria-hidden="true" />
      </a>
    </header>

    <div class="funds-layout">
      <section class="wallet-overview" aria-label="Trading wallet balance">
        <div class="wallet-balance-line">
          <span>Available balance</span>
          <strong>{{ portfolio ? readableAmount(portfolio.native_balance, 18, 5) : "…" }} <small>ETH</small></strong>
        </div>
        <button class="funds-address" type="button" @click="emit('copy')">
          <span>
            <small>Agent wallet</small>
            <code>{{ shortAddress(account.agent_wallet_address) }}</code>
          </span>
          <Icon name="ph:copy" aria-hidden="true" />
        </button>
        <div v-if="portfolio?.tokens.length" class="wallet-assets" aria-label="Token balances">
          <span v-for="token in portfolio.tokens" :key="token.address">
            <strong>{{ token.symbol }}</strong>
            {{ readableAmount(token.balance, token.decimals) }}
          </span>
        </div>
        <p v-else class="wallet-assets-empty">Token balances will appear here after the first swap.</p>
      </section>

      <form class="fund-action-box deposit-box" @submit.prevent="emit('deposit')">
        <header>
          <span class="fund-action-icon"><Icon name="ph:arrow-down-left" aria-hidden="true" /></span>
          <div><h3>Deposit</h3><p>Move ETH from your connected owner wallet.</p></div>
        </header>
        <label>
          <span>Amount</span>
          <div class="amount-input">
            <input v-model="depositAmount" inputmode="decimal" autocomplete="off" aria-label="ETH deposit amount">
            <span>ETH</span>
          </div>
        </label>
        <button class="button button-primary" type="submit" :disabled="depositing">
          {{ depositing ? "Confirm in wallet" : "Deposit ETH" }}
        </button>
        <small>Use Robinhood Chain. The owner wallet confirms the transfer.</small>
      </form>

      <section class="fund-action-box withdraw-box" aria-labelledby="withdraw-title">
        <header>
          <span class="fund-action-icon"><Icon name="ph:arrow-up-right" aria-hidden="true" /></span>
          <div><h3 id="withdraw-title">Withdraw</h3><p>Return assets to the connected owner wallet.</p></div>
        </header>
        <div class="withdraw-assets">
          <button
            v-if="hasEth"
            type="button"
            :disabled="agentActive || withdrawing"
            @click="emit('withdraw', nativeAsset)"
          >
            <span><strong>ETH</strong><small>{{ portfolio ? readableAmount(portfolio.native_balance, 18, 5) : "0" }}</small></span>
            <span>Withdraw all</span>
          </button>
          <button
            v-for="token in portfolio?.tokens || []"
            :key="token.address"
            type="button"
            :disabled="agentActive || withdrawing"
            @click="emit('withdraw', token.address)"
          >
            <span><strong>{{ token.symbol }}</strong><small>{{ readableAmount(token.balance, token.decimals) }}</small></span>
            <span>Withdraw all</span>
          </button>
          <p v-if="!hasEth && !portfolio?.tokens.length" class="withdraw-empty">Deposit funds before making a withdrawal.</p>
        </div>
        <small>{{ agentActive ? "Pause trading to withdraw assets." : "Withdrawals send the full selected balance." }}</small>
      </section>
    </div>
  </section>
</template>

<style scoped>
.funds-desk {
  border-block: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}

.funds-desk-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 2rem;
  padding: 1.15rem 1.35rem;
  border-bottom: 1px solid var(--color-line);
}

.funds-desk-header h2,
.fund-action-box h3 {
  margin: 0;
  letter-spacing: -.03em;
}

.funds-desk-header h2 { font-size: 1.2rem; }
.funds-desk-header p,
.fund-action-box p { margin: .2rem 0 0; color: var(--color-body-medium); font-size: .8rem; }
.funds-desk-header a { display: inline-flex; align-items: center; gap: .35rem; color: var(--color-muted); font-size: .78rem; font-weight: 650; text-decoration: none; }
.funds-desk-header a:hover { color: var(--color-accent); }

.funds-layout {
  display: grid;
  grid-template-columns: minmax(16rem, .85fr) repeat(2, minmax(18rem, 1fr));
}

.wallet-overview,
.fund-action-box { min-width: 0; padding: 1.35rem; }
.wallet-overview { border-right: 1px solid var(--color-line); }
.fund-action-box + .fund-action-box { border-left: 1px solid var(--color-line); }

.wallet-balance-line { display: grid; gap: .35rem; }
.wallet-balance-line > span { color: var(--color-muted); font-size: .76rem; }
.wallet-balance-line strong { font-family: var(--font-mono); font-size: clamp(2rem, 3.2vw, 3.5rem); font-variant-numeric: tabular-nums; font-weight: 500; letter-spacing: -.07em; line-height: 1; }
.wallet-balance-line strong small { color: var(--color-muted); font-size: .75rem; letter-spacing: 0; }

.funds-address {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1.3rem;
  padding: .75rem 0;
  border-block: 1px solid var(--color-line);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
}
.funds-address > span { display: grid; min-width: 0; gap: .1rem; }
.funds-address small { color: var(--color-quiet); font-size: .7rem; }
.funds-address code { overflow: hidden; color: var(--color-body-medium); font-family: var(--font-mono); font-size: .75rem; text-overflow: ellipsis; }
.funds-address:hover { color: var(--color-accent); }

.wallet-assets { display: flex; flex-wrap: wrap; gap: .45rem 1rem; margin-top: .85rem; color: var(--color-muted); font-family: var(--font-mono); font-size: .72rem; }
.wallet-assets span { display: inline-flex; gap: .35rem; }
.wallet-assets strong { color: var(--color-text); }
.wallet-assets-empty { margin: .85rem 0 0; color: var(--color-quiet); font-size: .75rem; }

.fund-action-box { display: grid; align-content: start; gap: 1rem; background: var(--color-background); }
.fund-action-box > header { display: flex; align-items: flex-start; gap: .75rem; }
.fund-action-box h3 { font-size: 1rem; }
.fund-action-icon { display: grid; width: 2.2rem; height: 2.2rem; flex: 0 0 auto; place-items: center; border: 1px solid var(--color-line-strong); color: var(--color-accent); }
.fund-action-box label { display: grid; gap: .45rem; }
.fund-action-box label > span { font-size: .76rem; font-weight: 650; }
.amount-input { display: flex; align-items: center; border: 1px solid var(--color-line-strong); background: var(--color-surface); }
.amount-input:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent); }
.amount-input input { width: 100%; min-width: 0; padding: .75rem; border: 0; outline: 0; background: transparent; color: var(--color-text); font-family: var(--font-mono); }
.amount-input > span { padding-right: .75rem; color: var(--color-muted); font-family: var(--font-mono); font-size: .72rem; }
.fund-action-box > small { color: var(--color-quiet); font-size: .7rem; line-height: 1.45; }

.withdraw-assets { display: grid; border-top: 1px solid var(--color-line); }
.withdraw-assets button { display: flex; min-height: 3rem; align-items: center; justify-content: space-between; gap: 1rem; padding: .55rem 0; border-bottom: 1px solid var(--color-line); background: transparent; color: var(--color-accent); cursor: pointer; font-size: .72rem; font-weight: 650; text-align: right; }
.withdraw-assets button > span:first-child { display: grid; justify-items: start; color: var(--color-text); text-align: left; }
.withdraw-assets button small { color: var(--color-muted); font-family: var(--font-mono); font-weight: 400; }
.withdraw-assets button:hover:not(:disabled) { color: var(--color-text); }
.withdraw-assets button:disabled { color: var(--color-quiet); cursor: not-allowed; }
.withdraw-empty { margin: .9rem 0 0; color: var(--color-quiet); font-size: .76rem; }

@media (max-width: 72rem) {
  .funds-layout { grid-template-columns: minmax(16rem, .8fr) minmax(0, 1.2fr); }
  .wallet-overview { grid-row: span 2; }
  .fund-action-box + .fund-action-box { border-top: 1px solid var(--color-line); border-left: 0; }
}

@media (max-width: 46rem) {
  .funds-desk-header { align-items: flex-start; flex-direction: column; gap: .75rem; }
  .funds-layout { grid-template-columns: 1fr; }
  .wallet-overview { grid-row: auto; border-right: 0; border-bottom: 1px solid var(--color-line); }
  .fund-action-box + .fund-action-box { border-left: 0; }
}
</style>
