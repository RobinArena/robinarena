const { chromium } = await import("playwright");
const { mkdir } = await import("node:fs/promises");
const { join } = await import("node:path");

const output = join(root, ".nstack", "screenshots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];

async function auditPage(route, file, viewport, authenticated = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (authenticated) {
    await context.addInitScript(() => {
      sessionStorage.setItem("model-market-operator-key", "ui-operator");
    });
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
  const logoLoaded = await page.locator(".brand-mark img").evaluate((image) => image.complete && image.naturalWidth > 0);
  await context.close();
  return { text, logoLoaded };
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
  await page.evaluate(() => {
    sessionStorage.setItem("model-market-operator-key", "ui-operator");
  });
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

try {
  const publicDesktop = await auditPage("/", "arena-public-desktop.png", { width: 1440, height: 1000 });
  const publicMobile = await auditPage("/", "arena-public-mobile.png", { width: 390, height: 844 });
  const adminDesktop = await auditPage("/admin", "arena-admin-desktop.png", { width: 1440, height: 1000 }, true);
  const adminMobile = await auditPage("/admin", "arena-admin-mobile.png", { width: 390, height: 844 }, true);
  const lightTheme = await auditThemeSwitch();

  assert.match(publicDesktop.text, /One trading week/);
  assert.match(publicDesktop.text, /\$25\.00/);
  assert.match(publicDesktop.text, /\$100\.00/);
  assert.match(publicDesktop.text, /7 days/);
  assert.match(publicDesktop.text, /every 60 minutes/);
  assert.match(publicDesktop.text, /Automation inactive/);
  assert.match(publicDesktop.text, /Robinhood/);
  assert.match(publicDesktop.text, /Inside the latest cycle/);
  assert.match(publicDesktop.text, /structured rationale/);
  assert.doesNotMatch(publicDesktop.text, /Open operator console|\bAdmin\b/);
  assert.doesNotMatch(publicDesktop.text, /\$1,000|\$250|\$100K|paper fills|replay tape/i);
  assert.equal(publicDesktop.logoLoaded && publicMobile.logoLoaded, true);
  assert.match(adminDesktop.text, /\$100\.00 allocation/);
  assert.match(adminDesktop.text, /\$25\.00/);
  assert.match(adminDesktop.text, /Run hourly during market hours/);
  assert.match(adminDesktop.text, /Weekly progress/);
  assert.match(adminDesktop.text, /Scheduler/);
  assert.match(adminDesktop.text, /Connect Robinhood/);
  assert.match(adminDesktop.text, /Arm live execution/);
  assert.equal(adminDesktop.logoLoaded && adminMobile.logoLoaded, true);
  assert.deepEqual(failures, []);
  return {
    public_desktop: join(output, "arena-public-desktop.png"),
    public_mobile: join(output, "arena-public-mobile.png"),
    admin_desktop: join(output, "arena-admin-desktop.png"),
    admin_mobile: join(output, "arena-admin-mobile.png"),
    light_public_desktop: lightTheme.publicDesktop,
    light_public_mobile: lightTheme.publicMobile,
    light_admin_desktop: lightTheme.adminDesktop,
    light_admin_mobile: lightTheme.adminMobile,
    browser_errors: failures.length,
    logo_loaded: true,
    theme_persistence: true,
  };
} finally {
  await browser.close();
}
