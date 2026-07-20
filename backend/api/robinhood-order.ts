export type RobinhoodMarketHours =
  | "regular_hours"
  | "extended_hours"
  | "all_day_hours";

export interface RobinhoodOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  amount?: number;
  quantity?: number;
  limitPrice?: number;
  marketHours?: RobinhoodMarketHours;
}

export function robinhoodOrderArguments(
  accountNumber: string,
  order: RobinhoodOrderRequest,
): Record<string, unknown> {
  if ((order.amount === undefined) === (order.quantity === undefined)) {
    throw new Error("Robinhood equity orders require either an amount or a quantity");
  }
  const marketHours = order.marketHours || "regular_hours";
  const wholeShareLimit = marketHours !== "regular_hours";
  if (wholeShareLimit) {
    if (
      order.amount !== undefined
      || !order.quantity
      || !Number.isInteger(order.quantity)
      || order.quantity < 1
    ) {
      throw new Error("Robinhood orders outside regular hours require a positive whole-share quantity");
    }
    if (!order.limitPrice || order.limitPrice <= 0) {
      throw new Error("Robinhood orders outside regular hours require a positive limit price");
    }
  }
  return {
    account_number: accountNumber,
    symbol: order.symbol,
    side: order.side,
    type: wholeShareLimit ? "limit" : "market",
    time_in_force: "gfd",
    market_hours: marketHours,
    ...(order.amount !== undefined ? { dollar_amount: String(order.amount) } : {}),
    ...(order.quantity !== undefined ? { quantity: String(order.quantity) } : {}),
    ...(wholeShareLimit ? { limit_price: String(order.limitPrice) } : {}),
  };
}
