const { createServer } = await import("node:http");

const prices = {
  AMZN: 210,
  META: 640,
  MSFT: 505,
  NVDA: 170,
  SPY: 690,
  TSLA: 430,
};
const modelSymbols = {
  "openai/gpt-5.6-sol": "AMZN",
  "deepseek/deepseek-v4-pro": "META",
  "anthropic/claude-fable-5": "MSFT",
  "x-ai/grok-4.5": "NVDA",
};
const orders = [];
const toolCalls = new Map();
const mcpAuthorizationHeaders = new Set();
const accountScopedTools = new Set([
  "cancel_equity_order",
  "get_equity_orders",
  "get_equity_positions",
  "get_equity_tradability",
  "get_portfolio",
  "place_equity_order",
  "review_equity_order",
]);
let openRouterInFlight = 0;
let maxOpenRouterInFlight = 0;
let openRouterRequests = 0;
let oauthRegistrations = 0;
let oauthCodeExchanges = 0;
let oauthRefreshes = 0;
const decisionInputs = [];

function cashBalance() {
  return orders.reduce((cash, order) => {
    const notional = order.filled_quantity * order.average_fill_price;
    return order.side === "buy" ? cash - notional : cash + notional;
  }, 100);
}

function openPositions() {
  const positions = new Map();
  for (const order of orders) {
    const current = positions.get(order.symbol) || 0;
    const direction = order.side === "buy" ? 1 : -1;
    positions.set(order.symbol, current + direction * order.filled_quantity);
  }
  return [...positions.entries()]
    .filter(([, quantity]) => quantity > 0.000001)
    .map(([symbol, quantity]) => ({
      symbol,
      quantity,
      average_price: prices[symbol],
      current_price: prices[symbol],
    }));
}

function json(response, body, headers = {}) {
  const value = JSON.stringify(body);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(value),
    ...headers,
  });
  response.end(value);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function mcpToolError(response, envelope, message) {
  json(response, {
    jsonrpc: "2.0",
    id: envelope.id,
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  }, { "mcp-session-id": "model-market-test" });
}

const mcp = createServer(async (request, response) => {
  mcpAuthorizationHeaders.add(request.headers.authorization || "");
  if (request.headers.authorization !== "Bearer refreshed-oauth-access") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid test authorization" }));
    return;
  }
  const envelope = await body(request);
  if (envelope.method === "initialize") {
    json(response, {
      jsonrpc: "2.0",
      id: envelope.id,
      result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-robinhood", version: "1" } },
    }, { "mcp-session-id": "model-market-test" });
    return;
  }
  if (envelope.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }
  const name = envelope.params?.name;
  const args = envelope.params?.arguments || {};
  toolCalls.set(name, (toolCalls.get(name) || 0) + 1);
  if (accountScopedTools.has(name) && args.account_number !== "AGENTIC-TEST") {
    mcpToolError(response, envelope, `${name} requires the Agentic account_number`);
    return;
  }
  if ((name === "review_equity_order" || name === "place_equity_order")
    && (args.type !== "market" || "order_type" in args)) {
    mcpToolError(response, envelope, `${name} requires type=market`);
    return;
  }
  if ((name === "review_equity_order" || name === "place_equity_order")
    && args.side === "buy"
    && (typeof args.dollar_amount !== "string" || "amount" in args)) {
    mcpToolError(response, envelope, `${name} requires dollar_amount as a string for buys`);
    return;
  }
  if ((name === "review_equity_order" || name === "place_equity_order")
    && args.side === "sell"
    && typeof args.quantity !== "string") {
    mcpToolError(response, envelope, `${name} requires quantity as a string for sells`);
    return;
  }
  let payload;
  if (name === "get_accounts") {
    payload = { accounts: [{ account_number: "AGENTIC-TEST", account_type: "Agentic", agentic_allowed: true }] };
  } else if (name === "get_portfolio") {
    payload = {
      data: {
        total_value: "100",
        cash: String(cashBalance()),
        buying_power: {
          buying_power: String(cashBalance()),
          unleveraged_buying_power: String(cashBalance()),
          display_currency: "USD",
        },
      },
      guide: "Test portfolio response",
    };
  } else if (name === "get_equity_quotes") {
    payload = {
      quotes: (args.symbols || []).map((symbol) => ({
        symbol,
        last_trade_price: prices[symbol],
        previous_close: prices[symbol] * 0.99,
        bid_price: prices[symbol] - 0.05,
        ask_price: prices[symbol] + 0.05,
        updated_at: new Date().toISOString(),
      })),
    };
  } else if (name === "get_equity_positions") {
    payload = {
      data: { positions: openPositions() },
      guide: "Test positions response",
    };
  } else if (name === "get_equity_orders") {
    payload = {
      data: { orders },
      guide: "Test orders response",
    };
  } else if (name === "get_equity_tradability") {
    payload = { instruments: (args.symbols || [args.symbol]).map((symbol) => ({ symbol, tradable: true, fractionable: true })) };
  } else if (name === "review_equity_order") {
    payload = { review: { status: "approved", symbol: args.symbol, side: args.side } };
  } else if (name === "place_equity_order") {
    const price = prices[args.symbol];
    const quantity = args.dollar_amount ? Number(args.dollar_amount) / price : Number(args.quantity);
    const order = {
      order_id: `broker-${orders.length + 1}`,
      symbol: args.symbol,
      side: args.side,
      status: "filled",
      dollar_amount: args.dollar_amount,
      quantity,
      filled_quantity: quantity,
      average_fill_price: price,
      updated_at: new Date().toISOString(),
    };
    orders.push(order);
    payload = order;
  } else if (name === "cancel_equity_order") {
    payload = { order_id: args.order_id, status: "cancelled" };
  } else {
    payload = { error: `unexpected tool ${name}` };
  }
  json(response, {
    jsonrpc: "2.0",
    id: envelope.id,
    result: { structuredContent: payload },
  }, { "mcp-session-id": "model-market-test" });
});

const oauth = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (request.url === "/register") {
    oauthRegistrations += 1;
    json(response, { client_id: "model-market-oauth-client" });
    return;
  }
  if (request.url === "/token") {
    const parameters = new URLSearchParams(raw);
    if (parameters.get("grant_type") === "authorization_code") {
      oauthCodeExchanges += 1;
      json(response, {
        access_token: "short-oauth-access",
        refresh_token: "oauth-refresh-token",
        expires_in: 1,
        token_type: "Bearer",
        scope: "internal",
      });
      return;
    }
    if (parameters.get("grant_type") === "refresh_token") {
      oauthRefreshes += 1;
      json(response, {
        access_token: "refreshed-oauth-access",
        refresh_token: "rotated-oauth-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "internal",
      });
      return;
    }
  }
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "unexpected OAuth test request" }));
});

const openrouter = createServer(async (request, response) => {
  openRouterInFlight += 1;
  maxOpenRouterInFlight = Math.max(maxOpenRouterInFlight, openRouterInFlight);
  const payload = await body(request);
  decisionInputs.push(JSON.parse(payload.messages[1].content));
  openRouterRequests += 1;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const symbol = modelSymbols[payload.model];
  const action = openRouterRequests <= 4 ? "buy" : "sell";
  openRouterInFlight -= 1;
  json(response, {
    id: `generation-${payload.model}`,
    model: payload.model,
    choices: [{
      message: {
        content: JSON.stringify({
          action,
          symbol,
          confidence: 0.91,
          allocation_pct: action === "buy" ? 20 : 0,
          rationale: `Verified test decision for ${symbol}.`,
        }),
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.001 },
  });
});

await new Promise((resolve) => mcp.listen(49091, "127.0.0.1", resolve));
await new Promise((resolve) => openrouter.listen(49090, "127.0.0.1", resolve));
await new Promise((resolve) => oauth.listen(49092, "127.0.0.1", resolve));

try {
  const headers = {
    Authorization: `Bearer ${env.ARENA_OPERATOR_KEY}`,
    "Content-Type": "application/json",
  };
  const unauthorized = await api("/admin/status");
  assert.equal(unauthorized.status, 401);
  const initial = await apiJson("/arena");
  assert.equal(initial.arena.starting_capital, 100);
  assert.equal(initial.arena.operator_capital_ceiling, 100);
  assert.equal(initial.arena.allocation_per_model, 25);
  assert.equal(initial.arena.round_number, 1, "initial weekly round number");
  assert.equal(initial.arena.cycle_number, 0);
  assert.equal(
    new Date(initial.arena.round_ends_at).getTime()
      - new Date(initial.arena.round_started_at).getTime(),
    7 * 24 * 60 * 60 * 1000,
  );
  assert.equal(initial.round_history.length, 1, "initial weekly round history");
  assert.equal(initial.round_history[0].status, "active");
  assert.deepEqual(initial.models.map((model) => model.initial_balance), [25, 25, 25, 25]);
  assert.equal(
    initial.market.length === 0
      || (
        initial.market.length === 6
        && initial.market.every((quote) => quote.source === "robinhood_mcp")
      ),
    true,
  );
  assert.equal(initial.decisions.length, 0);
  assert.equal(initial.orders.length, 0);
  assert.equal(initial.positions.length, 0);
  assert.equal(initial.trades.length, 0);
  assert.equal(initial.equity_series.every((series) => series.points.length === 1), true);
  const connected = await apiJson("/admin/robinhood/connect", {
    method: "POST",
    headers,
    body: JSON.stringify({ redirect_uri: `${frontendURL}/api/admin/robinhood/callback` }),
  });
  const authorization = new URL(connected.authorization_url);
  const callback = await api(`/admin/robinhood/callback?code=integration-code&state=${authorization.searchParams.get("state")}`, {
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location") || "", /\/admin\?robinhood=connected$/);
  const oauthStatus = await apiJson("/admin/status", { headers });
  assert.equal(oauthStatus.robinhood_oauth.connected, true);
  const sync = await apiJson("/admin/sync", { method: "POST", headers });
  assert.equal(sync.status.arena.market.length, 6);
  assert.deepEqual(sync.status.arena.models.map((model) => model.initial_balance), [25, 25, 25, 25]);
  assert.equal(sync.status.arena.arena.capital_limit, 100);
  assert.equal(sync.status.broker.equity, 100);
  assert.equal(sync.status.broker.deployable_capital, 100);
  assert.equal(sync.status.broker.allocation_per_model, 25);
  assert.equal(sync.status.broker.capital_source, "robinhood");
  assert.equal(sync.status.arena.arena.live_armed, false);
  assert.equal(oauthRegistrations, 1, "OAuth dynamic client registrations");
  assert.equal(oauthCodeExchanges, 1, "OAuth authorization code exchanges");
  assert.equal(oauthRefreshes, 1, "OAuth refreshes");
  assert.deepEqual([...mcpAuthorizationHeaders], ["Bearer refreshed-oauth-access"]);

  await apiJson("/admin/arm", {
    method: "POST",
    headers,
    body: JSON.stringify({
      confirmation: "I ACCEPT LIVE ROBINHOOD TRADING RISK",
      automation_enabled: false,
    }),
  });
  const round = await apiJson("/admin/round", {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmation: "EXECUTE LIVE ROBINHOOD ORDERS" }),
  });
  const arena = round.status.arena;
  assert.equal(arena.orders.length, 4);
  assert.equal(arena.positions.length, 4);
  assert.equal(arena.orders.every((order) => order.status === "filled" && order.broker_order_id), true);
  assert.equal(arena.orders.every((order) => order.reconciled_at), true);
  assert.equal(arena.positions.every((position) => position.average_entry_price === prices[position.symbol]), true);
  assert.equal(arena.market.every((quote) => quote.source === "robinhood_mcp"), true);
  assert.equal(arena.decisions.every((decision) => decision.source === "openrouter"), true);
  assert.equal(arena.decisions.every((decision) => decision.round_number === 1), true);
  assert.equal(arena.decisions.every((decision) => decision.cycle_number === 1), true);
  assert.equal(arena.models.every((model) => model.cash_balance === 20), true);
  assert.equal(arena.arena.round_number, 1, "weekly round after entry cycle");
  assert.equal(arena.arena.cycle_number, 1, "entry decision cycle number");
  assert.equal(arena.arena.total_equity, 100);
  assert.equal(arena.arena.pending_orders, 0);
  assert.equal(maxOpenRouterInFlight, 4);
  assert.equal(toolCalls.get("review_equity_order"), 4);
  assert.equal(toolCalls.get("place_equity_order"), 4);

  const exitRound = await apiJson("/admin/round", {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmation: "EXECUTE LIVE ROBINHOOD ORDERS" }),
  });
  const exited = exitRound.status.arena;
  assert.equal(exited.orders.length, 8);
  assert.equal(exited.positions.length, 0);
  assert.equal(exited.trades.filter((trade) => trade.status === "closed").length, 4);
  assert.equal(exited.models.every((model) => model.cash_balance === 25), true);
  assert.equal(exited.arena.round_number, 1, "weekly round after exit cycle");
  assert.equal(exited.arena.cycle_number, 2);
  assert.equal(exited.decisions.filter((decision) => decision.cycle_number === 2).length, 4);
  assert.equal(exited.arena.total_equity, 100);
  assert.equal(exited.arena.pending_orders, 0);
  assert.equal(toolCalls.get("review_equity_order"), 8);
  assert.equal(toolCalls.get("place_equity_order"), 8);

  const disarmed = await apiJson("/admin/disarm", { method: "POST", headers });
  assert.equal(disarmed.status.arena.arena.status, "running");
  assert.equal(disarmed.status.arena.arena.live_armed, false);
  assert.deepEqual(
    decisionInputs.map((input) => [input.round_number, input.cycle_number]),
    [[1, 1], [1, 1], [1, 1], [1, 1], [1, 2], [1, 2], [1, 2], [1, 2]],
  );
  return {
    allocations: arena.models.map((model) => model.initial_balance),
    verified_quotes: arena.market.length,
    reconciled_fills: arena.orders.length,
    positions_from_broker_fills: arena.positions.length,
    openrouter_max_concurrency: maxOpenRouterInFlight,
    total_equity: arena.arena.total_equity,
    pending_orders: arena.arena.pending_orders,
    review_calls: toolCalls.get("review_equity_order"),
    placement_calls: toolCalls.get("place_equity_order"),
    reconciled_exits: exited.orders.filter((order) => order.side === "sell").length,
    closed_trades: exited.trades.filter((trade) => trade.status === "closed").length,
    ending_positions: exited.positions.length,
    ending_cash_per_model: exited.models.map((model) => model.cash_balance),
    weekly_round_number: exited.arena.round_number,
    decision_cycles: exited.arena.cycle_number,
    round_duration_days: (
      new Date(exited.arena.round_ends_at).getTime()
      - new Date(exited.arena.round_started_at).getTime()
    ) / (24 * 60 * 60 * 1000),
    oauth_registrations: oauthRegistrations,
    oauth_code_exchanges: oauthCodeExchanges,
    oauth_refreshes: oauthRefreshes,
    mcp_authorization_rotated: [...mcpAuthorizationHeaders],
  };
} finally {
  await new Promise((resolve) => mcp.close(resolve));
  await new Promise((resolve) => openrouter.close(resolve));
  await new Promise((resolve) => oauth.close(resolve));
}
