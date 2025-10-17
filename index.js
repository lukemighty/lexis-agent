import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  CAPSOLVER_API_KEY,
  PORT = 8080
} = process.env;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error("Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID");
  process.exit(1);
}

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("OK"));

/** ---------- Helpers ---------- */

async function robustSelect(page, labelRegex, value) {
  // A) by accessible label
  try {
    const field = page.getByLabel(labelRegex).first();
    if (await field.count()) {
      await field.click({ force: true });
      await field.fill("");
      await field.type(value, { delay: 30 });
      const optRole = page.getByRole("option", { name: new RegExp(`^${value}$`, "i") }).first();
      if (await optRole.count()) { await optRole.click(); return true; }
      const optText = page.locator(`text="${value}"`).first();
      await optText.waitFor({ state: "visible", timeout: 5000 });
      await optText.click();
      return true;
    }
  } catch {}

  // B) input next to a label text
  try {
    const near = page.locator(
      "label:has-text('State') + * input, label:has-text('Jurisdiction') + * input"
    ).first();
    if (await near.count()) {
      await near.click({ force: true });
      await near.fill("");
      await near.type(value, { delay: 30 });
      const optRole = page.getByRole("option", { name: new RegExp(`^${value}$`, "i") }).first();
      if (await optRole.count()) { await optRole.click(); return true; }
      const optText = page.locator(`text="${value}"`).first();
      await optText.waitFor({ state: "visible", timeout: 5000 });
      await optText.click();
      return true;
    }
  } catch {}

  // C) generic combobox
  try {
    const combo = page.getByRole("combobox").first();
    if (await combo.count()) {
      await combo.click({ force: true });
      await combo.type(value, { delay: 30 });
      const optText = page.locator(`text="${value}"`).first();
      await optText.waitFor({ state: "visible", timeout: 5000 });
      await optText.click();
      return true;
    }
  } catch {}

  return false;
}

async function fillIfPresent(locator, value) {
  if (!value) return false;
  try { await locator.fill(value); return true; } catch { return false; }
}

// Try simple checkbox inside reCAPTCHA iframe
async function clickSimpleCaptchaCheckbox(page) {
  try {
    const frame = page.frameLocator('iframe[title*="reCAPTCHA"], iframe[src*="recaptcha"]');
    const cb = frame.locator('#recaptcha-anchor, div.recaptcha-checkbox-border, span[role="checkbox"]').first();
    await cb.waitFor({ state: "visible", timeout: 6000 });
    await cb.click({ force: true });
    await page.waitForTimeout(2000);

    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    const searchEnabled = await searchBtn.isEnabled().catch(() => false);
    const tokenPresent = await page.locator('#g-recaptcha-response[value]').count().catch(() => 0);
    return searchEnabled || tokenPresent > 0;
  } catch {
    return false;
  }
}

// Fallback: tab navigation to checkbox
async function handleCaptchaKeyboard(page) {
  try {
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(120);
    }
    await page.keyboard.press("Space");
    await page.waitForTimeout(1500);
    const searchEnabled = await page.getByRole("button", { name: /^Search$/i }).isEnabled().catch(() => false);
    return searchEnabled;
  } catch {
    return false;
  }
}

/** CapSolver helpers (only used if key present) */
async function capsolverCreateTask({ apiKey, websiteURL, websiteKey }) {
  const r = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "ReCaptchaV2TaskProxyLess", websiteURL, websiteKey }
    }),
  });
  const data = await r.json();
  if (data.errorId) throw new Error(`CapSolver createTask error: ${data.errorCode}`);
  return data.taskId;
}

async function capsolverGetResult({ apiKey, taskId, maxWaitMs = 120000 }) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const data = await r.json();
    if (data.errorId) throw new Error(`CapSolver getTaskResult error: ${data.errorCode}`);
    if (data.status === "ready" && data.solution?.gRecaptchaResponse) {
      return data.solution.gRecaptchaResponse;
    }
  }
  throw new Error("CapSolver timeout");
}

async function solveCaptchaWithCapSolver(page, apiKey) {
  const { siteKey, pageURL } = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    const src = iframe?.getAttribute("src") || "";
    const m = src.match(/[?&]k=([^&]+)/);
    return { siteKey: m ? decodeURIComponent(m[1]) : null, pageURL: location.href };
  });
  if (!siteKey) return false;

  const taskId = await capsolverCreateTask({ apiKey, websiteURL: pageURL, websiteKey: siteKey });
  const token = await capsolverGetResult({ apiKey, taskId });

  await page.evaluate((captchaToken) => {
    let ta = document.getElementById("g-recaptcha-response");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.id = "g-recaptcha-response";
      ta.style.display = "none";
      document.body.appendChild(ta);
    }
    ta.value = captchaToken;

    try {
      // eslint-disable-next-line no-undef
      const cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        Object.values(cfg.clients).forEach((c) => {
          try {
            const cb = c?.callback || c?.V?.callback || c?.W?.callback;
            if (typeof cb === "function") cb(captchaToken);
          } catch {}
        });
      }
    } catch {}
  }, token);

  await page.waitForTimeout(1200);
  return true;
}

/** ---------- Smoke test ---------- */
app.post("/lexis_search", async (req, res) => {
  const { portalUrl = "https://example.com" } = req.body || {};
  let browser;
  try {
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    res.json({ ok: true, visited: portalUrl, title });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

/** ---------- Full flow: state/jurisdiction → search → add to cart ---------- */
app.post("/buycrash_full", async (req, res) => {
  const {
    state,
    jurisdiction,
    reportNumber,
    lastName,
    dateOfIncident,
    locationStreet,
    tryCapSolver = true,
    pageLoadTimeout = 30000
  } = req.body || {};

  if (!state || !jurisdiction) {
    return res.status(400).json({ ok: false, error: "state and jurisdiction are required" });
  }
  const hasOpt1 = !!reportNumber;
  const hasOpt2 = !!(lastName && dateOfIncident);
  const hasOpt3 = !!(lastName && locationStreet);
  if (!hasOpt1 && !hasOpt2 && !hasOpt3) {
    return res.status(400).json({
      ok: false,
      error: "Provide reportNumber OR (lastName + dateOfIncident) OR (lastName + locationStreet)"
    });
  }

  let browser;
  try {
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    // Home
    await page.goto("https://buycrash.lexisnexisrisk.com/ui/home", {
      waitUntil: "domcontentloaded",
      timeout: pageLoadTimeout
    });

    // State + jurisdiction
    if (!await robustSelect(page, /State/i, state)) throw new Error(`Could not select state: ${state}`);
    await page.waitForTimeout(800);
    if (!await robustSelect(page, /Jurisdiction/i, jurisdiction)) throw new Error(`Could not select jurisdiction: ${jurisdiction}`);
    await page.waitForTimeout(600);

    // Start Search
    const startBtn = page.getByRole("button", { name: /Start Search/i });
    await startBtn.waitFor({ state: "visible", timeout: 8000 });
    await startBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Fill fields
    if (hasOpt1) {
      await fillIfPresent(page.getByLabel(/Report Number/i), reportNumber);
    } else if (hasOpt2) {
      await fillIfPresent(page.getByLabel(/^Last Name/i).first(), lastName)
        || await fillIfPresent(page.locator('input[placeholder*="Last Name"]').first(), lastName);
      await fillIfPresent(page.getByLabel(/Date of Incident/i).first(), dateOfIncident)
        || await fillIfPresent(page.locator('input[placeholder*="mm/dd/yyyy"]').first(), dateOfIncident);
    } else if (hasOpt3) {
      await fillIfPresent(page.getByLabel(/^Last Name/i).first(), lastName)
        || await fillIfPresent(page.locator('input[placeholder*="Last Name"]').first(), lastName);
      await fillIfPresent(page.getByLabel(/Location Street/i), locationStreet)
        || await fillIfPresent(page.locator('input[placeholder*="Street"]').first(), locationStreet);
    }

    // CAPTCHA: checkbox → keyboard → CapSolver (optional)
    let captchaOK = await clickSimpleCaptchaCheckbox(page);
    if (!captchaOK) captchaOK = await handleCaptchaKeyboard(page);
    if (!captchaOK && tryCapSolver && CAPSOLVER_API_KEY) {
      try { captchaOK = await solveCaptchaWithCapSolver(page, CAPSOLVER_API_KEY); } catch {}
    }

    // Search
    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.waitFor({ state: "visible", timeout: 8000 });
    await searchBtn.click();

    // Terms dialog if present
    try {
      const modal = page.getByRole("dialog", { name: /Terms of Use/i });
      await modal.waitFor({ state: "visible", timeout: 5000 });
      await modal.getByRole("button", { name: /^OK$/i }).click();
    } catch {}

    // Wait for results (or validation page)
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});
    const hasResults = await page.locator("text=/records? found/i").first().isVisible().catch(() => false);

    if (!hasResults) {
      // Sometimes Terms shows late
      try {
        const modal = page.getByRole("dialog", { name: /Terms of Use/i });
        await modal.waitFor({ state: "visible", timeout: 3000 });
        await modal.getByRole("button", { name: /^OK$/i }).click();
      } catch {}
    }

    const resultsNow = await page.locator("text=/records? found/i").first().isVisible().catch(() => false);
    if (!resultsNow) {
      return res.json({ ok: true, step: "no_results_or_validation", pageUrl: page.url() });
    }

    // Add to Cart
    const addBtn = page.getByRole("button", { name: /Add to Cart/i }).first();
    await addBtn.waitFor({ state: "visible", timeout: 8000 });
    await addBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});
    const cartUrl = page.url();

    return res.json({ ok: true, state, jurisdiction, step: "added_to_cart", cartUrl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
