import { requestLiFiQuote, type LiFiQuoteRequest, type ValidatedLiFiQuote } from "./lifi";

export type ValidatedSwapQuote = ValidatedLiFiQuote;

export interface SwapQuoteSummary {
  provider: ValidatedSwapQuote["provider"];
  routing: string;
  quoted_amount_out: string;
  minimum_amount_out: string;
  slippage_bps: number;
}

export interface SwapQuoteSelection {
  quote: ValidatedSwapQuote;
  candidates: SwapQuoteSummary[];
  provider_errors: Partial<Record<"lifi", string>>;
}

function safeProviderError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function summary(quote: ValidatedSwapQuote): SwapQuoteSummary {
  return {
    provider: quote.provider,
    routing: quote.routing,
    quoted_amount_out: quote.quotedAmountOut.toString(),
    minimum_amount_out: quote.minimumAmountOut.toString(),
    slippage_bps: quote.slippageBps,
  };
}

export async function requestBestSwapQuote(request: LiFiQuoteRequest): Promise<SwapQuoteSelection> {
  try {
    const quote = await requestLiFiQuote(request);
    return {
      quote,
      candidates: [summary(quote)],
      provider_errors: {},
    };
  } catch (error) {
    throw new Error(`swap quote provider failed: lifi: ${safeProviderError(error)}`);
  }
}
