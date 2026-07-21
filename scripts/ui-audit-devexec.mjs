const { chromium } = await import("playwright");
const { mkdir } = await import("node:fs/promises");
const { join } = await import("node:path");

const output = join(root, ".nstack", "screenshots");
const operatorKey = "dev-model-market";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];

async function auditPage(route, file, viewport, authenticated = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (authenticated) {
    await context.addInitScript((key) => {
      sessionStorage.setItem("model-market-operator-key", key);
    }, operatorKey);
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${route}: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`${route}: ${entry.text()}`);
  });
  page.on("requestfailed", (request) => failures.push(`${route}: ${request.url()} ${request.failure()?.errorText || "failed"}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${route}: HTTP ${response.status()} ${response.url()}`);
  });
  await page.goto(`${frontendURL}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (authenticated) await page.waitForSelector(".admin-readiness", { timeout: 10_000 });
  else await page.waitForSelector(".arena-hero", { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, file), fullPage: true });
  const text = await page.locator("body").innerText();
  const logoLoaded = await page.locator(".brand-mark svg").evaluate((svg) => (
    svg.querySelectorAll("path").length === 2
    && svg.getBoundingClientRect().width > 0
    && svg.getBoundingClientRect().height > 0
  ));
  const xProfileHref = await page.locator('a[href="https://x.com/RobinArenaFun"]').first().getAttribute("href");
  const xProfileLinkCount = await page.locator('a[href="https://x.com/RobinArenaFun"]').count();
  const leaderboardBalances = await page.locator(".leaderboard-equity > strong").allTextContents();
  const fontFamily = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
  const horizontalOverflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ));
  const responsiveLayout = await page.evaluate(() => {
    const brand = document.querySelector(".brand");
    const tools = document.querySelector(".header-tools");
    const navigation = document.querySelector(".site-nav");
    const navigationLinks = [...document.querySelectorAll(".site-nav a")];
    const themeToggle = document.querySelector(".theme-toggle");
    const labelledTableCell = document.querySelector(".data-table td[data-label]");
    const heroActions = document.querySelector(".hero-actions");
    const brandRect = brand?.getBoundingClientRect();
    const toolsRect = tools?.getBoundingClientRect();
    return {
      navigationVisible: navigation ? getComputedStyle(navigation).display !== "none" : false,
      headerCenterDelta: brandRect && toolsRect
        ? Math.abs(
          (brandRect.top + brandRect.height / 2)
          - (toolsRect.top + toolsRect.height / 2),
        )
        : null,
      shortestNavigationTarget: navigationLinks.length
        ? Math.min(...navigationLinks.map((link) => link.getBoundingClientRect().height))
        : null,
      themeTargetHeight: themeToggle?.getBoundingClientRect().height || null,
      labelledTableCellDisplay: labelledTableCell
        ? getComputedStyle(labelledTableCell).display
        : null,
      labelledTableCellLabel: labelledTableCell?.getAttribute("data-label") || null,
      heroActionColumns: heroActions && getComputedStyle(heroActions).display === "grid"
        ? getComputedStyle(heroActions).gridTemplateColumns.split(" ").length
        : null,
    };
  });
  await context.close();
  return {
    text,
    logoLoaded,
    xProfileHref,
    xProfileLinkCount,
    leaderboardBalances,
    fontFamily,
    horizontalOverflow,
    responsiveLayout,
  };
}

async function auditThemeSwitch() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`theme: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`theme: ${entry.text()}`);
  });
  await page.goto(frontendURL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector(".arena-hero", { timeout: 10_000 });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.locator('html[data-theme="light"]').waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("model-market-theme")),
    "light",
  );
  assert.equal(
    await page.locator('meta[name="theme-color"]').getAttribute("content"),
    "#f3f4ed",
  );
  await page.screenshot({
    path: join(output, "arena-public-light-desktop.png"),
    fullPage: true,
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".arena-hero", { timeout: 10_000 });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "arena-public-light-mobile.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate((key) => {
    sessionStorage.setItem("model-market-operator-key", key);
  }, operatorKey);
  await page.goto(`${frontendURL}/admin`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector(".admin-readiness", { timeout: 10_000 });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.screenshot({
    path: join(output, "arena-admin-light-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "arena-admin-light-mobile.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.locator('html[data-theme="dark"]').waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("model-market-theme")),
    "dark",
  );
  await context.close();
  return {
    publicDesktop: join(output, "arena-public-light-desktop.png"),
    publicMobile: join(output, "arena-public-light-mobile.png"),
    adminDesktop: join(output, "arena-admin-light-desktop.png"),
    adminMobile: join(output, "arena-admin-light-mobile.png"),
  };
}

async function auditAgentWorkspace() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`workspace: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`workspace: ${entry.text()}`);
  });
  await page.goto(frontendURL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector(".agent-workspace", { timeout: 10_000 });
  await page.waitForTimeout(500);

  const providerSources = await page.locator(".model-glyph img").evaluateAll((images) => (
    [...new Set(images.map((image) => new URL(image.getAttribute("src"), location.href).pathname))]
  ));
  assert.deepEqual(providerSources.sort(), [
    "/providers/claude.svg",
    "/providers/deepseek.png",
    "/providers/google-gemini.svg",
    "/providers/openai.png",
    "/providers/thinking-machines.svg",
    "/providers/xai.png",
  ]);
  assert.equal(
    await page.locator(".model-glyph img").evaluateAll((images) => (
      images.every((image) => image.complete && image.naturalWidth > 0)
    )),
    true,
  );

  const portfolioLanes = page.locator(".portfolio-lane");
  const portfolioLaneCount = await portfolioLanes.count();
  assert.equal(portfolioLaneCount, 6);
  const seriesControls = page.locator(".chart-series-controls button");
  assert.equal(await seriesControls.count(), 7);
  await seriesControls.nth(2).click();
  assert.equal(await page.locator(".model-chart-line").count(), 1);
  assert.match(
    await page.locator(".chart-plot-stage > svg").getAttribute("aria-label"),
    /Profit history for/,
  );
  await seriesControls.first().click();
  assert.equal(await page.locator(".model-chart-line").count(), 6);
  const axisLabels = await page.locator(".chart-axis-label:not(.chart-time-label)").allTextContents();
  assert.equal(axisLabels.length, 5);
  assert.equal(axisLabels.every((label) => /\$/.test(label)), true, "profit axis uses dollar values");
  const rangeControls = page.locator(".range-control button");
  for (const [index, range] of ["1D", "5D", "ALL"].entries()) {
    await rangeControls.nth(index).click();
    assert.equal(await rangeControls.nth(index).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".model-chart-line").count(), 6);
    assert.ok(new Set(await page.locator(".chart-time-label").allTextContents()).size > 0);
    assert.equal((await rangeControls.allTextContents())[index]?.trim(), range);
  }

  const roster = page.locator(".agent-roster-item");
  assert.equal(await roster.count(), 6);
  const target = roster.nth(1);
  const expectedName = (await target.locator("strong").first().innerText()).trim();
  await target.click();
  await page.locator(".agent-session-identity h3").filter({ hasText: expectedName }).waitFor();
  assert.equal(await target.getAttribute("aria-pressed"), "true");

  const pageFont = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
  assert.match(pageFont, /Onest/);
  for (const selector of [
    ".summary-metric strong",
    ".leaderboard-equity strong",
    ".model-stats dd",
    ".data-table td",
  ]) {
    const element = page.locator(selector).first();
    if (await element.count()) {
      assert.match(
        await element.evaluate((node) => getComputedStyle(node).fontFamily),
        /Onest/,
      );
    }
  }
  assert.equal(await page.locator(".leaderboard-rank, .model-rank").count(), 0);
  assert.equal(await page.locator(".live-feed-state, .round-panel").count(), 0);
  assert.equal(await page.locator(".round-scoreboard").count(), 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Desktop overflowed by ${overflow}px`);

  const transcript = page.locator(".agent-transcript");
  if (await transcript.count()) {
    await expectText(transcript, /Reasoning/);
    await expectText(transcript, /submit_trade_decision/);
    await expectText(transcript, /Risk engine/);
    await expectText(transcript, /Broker result/);
    await page.locator(".agent-run-details summary").click();
    await page.getByText("Provider model", { exact: true }).waitFor();
  } else {
    await expectText(page.locator(".agent-session-empty"), /reasoning/i);
  }

  await context.close();
  return {
    selectedAgent: expectedName,
    pageFont,
    providerAssets: providerSources,
    portfolioLanes: portfolioLaneCount,
  };
}

async function expectText(locator, pattern) {
  assert.match(await locator.innerText(), pattern);
}

try {
  const publicDesktop = await auditPage("/", "arena-public-desktop.png", { width: 1440, height: 1000 });
  const publicMobile = await auditPage("/", "arena-public-mobile.png", { width: 390, height: 844 });
  const publicCompact = await auditPage("/", "arena-public-compact.png", { width: 320, height: 700 });
  const publicTablet = await auditPage("/", "arena-public-tablet.png", { width: 820, height: 1000 });
  const adminDesktop = await auditPage("/admin", "arena-admin-desktop.png", { width: 1440, height: 1000 }, true);
  const adminMobile = await auditPage("/admin", "arena-admin-mobile.png", { width: 390, height: 844 }, true);
  const lightTheme = await auditThemeSwitch();
  const workspace = await auditAgentWorkspace();

  assert.match(publicDesktop.text, /Frontier AI models compete in live trading on Robinhood/);
  assert.match(publicDesktop.text, /RobinArena/);
  assert.match(publicDesktop.text, /@RobinArenaFun/);
  assert.match(publicDesktop.text, /\$16\.67/);
  assert.equal(publicDesktop.leaderboardBalances.length, 6);
  assert.equal(
    publicDesktop.leaderboardBalances.every((balance) => /^\$[\d,]+\.\d{2}$/.test(balance.trim())),
    true,
    "leaderboard balances display reconciled cents without whole-dollar rounding",
  );
  assert.match(publicDesktop.text, /\$100\.00/);
  assert.match(publicDesktop.text, /\d+d \d+h left/);
  assert.match(publicDesktop.text, /Hourly, around the clock/);
  assert.match(publicDesktop.text, /deposits do not change the lines/i);
  assert.match(publicDesktop.text, /\$ARENA trading fees go toward the agents’ balances/);
  assert.match(publicDesktop.text, /Contract address/);
  assert.match(publicDesktop.text, /0x14dad3f05f7e25ee79b780119db96baa6b30e7c0/);
  assert.match(publicDesktop.text, /Disarmed/);
  assert.match(publicDesktop.text, /Robinhood/);
  assert.match(publicDesktop.text, /Read the latest model decisions/);
  assert.match(publicDesktop.text, /Select a model to see its reasoning/);
  assert.doesNotMatch(
    publicDesktop.text,
    /Live feed connected|Public data refreshes every 20 seconds|Robinhood reconciled|Robinhood live|OpenRouter/,
  );
  assert.doesNotMatch(publicDesktop.text, /Open operator console|\bAdmin\b/);
  assert.equal(publicDesktop.xProfileHref, "https://x.com/RobinArenaFun");
  assert.equal(publicDesktop.xProfileLinkCount, 2);
  assert.equal(publicMobile.xProfileLinkCount, 2);
  assert.doesNotMatch(publicDesktop.text, /\$1,000|\$250|\$100K|paper fills|replay tape/i);
  assert.equal(publicDesktop.logoLoaded && publicMobile.logoLoaded, true);
  assert.match(publicDesktop.fontFamily, /Onest/);
  assert.ok(publicDesktop.horizontalOverflow <= 1);
  assert.ok(publicMobile.horizontalOverflow <= 1);
  assert.ok(publicCompact.horizontalOverflow <= 1);
  assert.ok(publicTablet.horizontalOverflow <= 1);
  assert.equal(publicMobile.responsiveLayout.navigationVisible, true);
  assert.ok(publicMobile.responsiveLayout.headerCenterDelta <= 2);
  assert.ok(publicMobile.responsiveLayout.shortestNavigationTarget >= 44);
  assert.ok(publicMobile.responsiveLayout.themeTargetHeight >= 44);
  assert.equal(publicMobile.responsiveLayout.labelledTableCellDisplay, "grid");
  assert.equal(publicMobile.responsiveLayout.labelledTableCellLabel, "Model");
  assert.equal(publicMobile.responsiveLayout.heroActionColumns, 2);
  assert.equal(publicCompact.responsiveLayout.heroActionColumns, 1);
  assert.ok(publicTablet.responsiveLayout.headerCenterDelta <= 2);
  assert.match(adminDesktop.text, /\$100\.00 allocation/);
  assert.match(adminDesktop.text, /\$16\.67/);
  assert.match(adminDesktop.text, /Run hourly around the clock/);
  assert.match(adminDesktop.text, /Weekly progress/);
  assert.match(adminDesktop.text, /Scheduler/);
  assert.match(adminDesktop.text, /(?:Re)?connect Robinhood/);
  assert.match(adminDesktop.text, /Arm live execution/);
  assert.equal(adminDesktop.logoLoaded && adminMobile.logoLoaded, true);
  assert.match(adminDesktop.fontFamily, /Onest/);
  assert.ok(adminDesktop.horizontalOverflow <= 1);
  assert.ok(adminMobile.horizontalOverflow <= 1);
  assert.deepEqual(failures, []);
  return {
    public_desktop: join(output, "arena-public-desktop.png"),
    public_mobile: join(output, "arena-public-mobile.png"),
    public_compact: join(output, "arena-public-compact.png"),
    public_tablet: join(output, "arena-public-tablet.png"),
    admin_desktop: join(output, "arena-admin-desktop.png"),
    admin_mobile: join(output, "arena-admin-mobile.png"),
    light_public_desktop: lightTheme.publicDesktop,
    light_public_mobile: lightTheme.publicMobile,
    light_admin_desktop: lightTheme.adminDesktop,
    light_admin_mobile: lightTheme.adminMobile,
    browser_errors: failures.length,
    logo_loaded: true,
    theme_persistence: true,
    agent_workspace: workspace,
  };
} finally {
  await browser.close();
}
