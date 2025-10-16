import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error("Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID env vars.");
  process.exit(1);
}

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
const app = express();
  const hasOpt2 = !!(lastName && dateOfIncident);
  const hasOpt3 = !!(lastName && locationStreet);
  if (!hasOpt1 && !hasOpt2 && !hasOpt3)
    return res.status(400).json({ ok: false, error: "Provide reportNumber OR (lastName + dateOfIncident) OR (lastName + locationStreet)" });

  let browser;
  try {
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://buycrash.lexisnexisrisk.com/ui/home", { waitUntil: "domcontentloaded" });

    // Select State and Jurisdiction
    const stateOK = await robustSelect(page, /State/i, state);
    if (!stateOK) throw new Error(`Could not select state: ${state}`);
    await page.waitForTimeout(1000);

    const jurisOK = await robustSelect(page, /Jurisdiction/i, jurisdiction);
    if (!jurisOK) throw new Error(`Could not select jurisdiction: ${jurisdiction}`);
    await page.waitForTimeout(1000);

    // Click "Start Search"
    const startBtn = page.getByRole("button", { name: /Start Search/i });
    await startBtn.waitFor({ state: "visible", timeout: 8000 });
    await startBtn.click();

    // Wait for form page to load
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Fill out form options
    if (hasOpt1) {
      await page.getByLabel(/Report Number/i).fill(reportNumber);
    } else if (hasOpt2) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      const dateInput = page.getByLabel(/Date of Incident/i).first().or(page.locator("input[placeholder*='mm/dd/yyyy']"));
      await dateInput.fill(dateOfIncident);
    } else if (hasOpt3) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      await page.getByLabel(/Location Street/i).fill(locationStreet);
    }

    // Try to click captcha (if possible)
    let captchaOk = false;
    try {
      const frame = page.frameLocator("iframe[title*='reCAPTCHA']");
      const checkbox = frame.getByRole("checkbox", { name: /I'm not a robot/i });
      await checkbox.click({ timeout: 4000 });
      captchaOk = true;
    } catch {
      // Can't solve captcha automatically
    }

    if (!captchaOk) {
      return res.json({
        ok: true,
        step: "captcha",
        requiresHumanCaptcha: true,
        pageUrl: page.url(),
        note: "Solve CAPTCHA manually, then rerun /buycrash_resume (next step)."
      });
    }

    // Click Search
    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.waitFor({ state: "visible", timeout: 8000 });
    await searchBtn.click();

    // Handle Terms of Use
    try {
      const modal = page.getByRole("dialog", { name: /Terms of Use/i });
      await modal.waitFor({ state: "visible", timeout: 4000 });
      await modal.getByRole("button", { name: /^OK$/i }).click();
    } catch {}

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Detect records found
    const hasResults = await page.locator("text=/records? found/i").first().isVisible().catch(() => false);
    if (!hasResults) {
      return res.json({ ok: true, step: "no_results", pageUrl: page.url() });
    }

    // Add to cart
    const addBtn = page.getByRole("button", { name: /Add to Cart/i }).first();
    await addBtn.waitFor({ state: "visible", timeout: 8000 });
    await addBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    const cartUrl = page.url();
    res.json({ ok: true, step: "added_to_cart", cartUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- HELPER reused (same as earlier) ---
    await field.click();
    await field.fill("");
    await field.type(value, { delay: 50 });
    const option = page.locator(`text="${value}"`).first();
    await option.waitFor({ state: "visible", timeout: 5000 });
    await option.click();
    return true;
  } catch (err) {
    console.warn(`Dropdown select failed for ${value}:`, err.message);
    return false;
  }
}

/** Step 1: Begin and pause before captcha */
app.post("/buycrash_begin", async (req, res) => {
  const { state, jurisdiction, reportNumber, lastName, dateOfIncident, locationStreet } = req.body || {};
  if (!state || !jurisdiction) return res.status(400).json({ ok: false, error: "State and jurisdiction required" });
  const hasOpt1 = !!reportNumber, hasOpt2 = !!(lastName && dateOfIncident), hasOpt3 = !!(lastName && locationStreet);
  if (!hasOpt1 && !hasOpt2 && !hasOpt3) return res.status(400).json({ ok: false, error: "Provide reportNumber OR (lastName+dateOfIncident) OR (lastName+locationStreet)" });

  let browser, session;
  try {
    session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://buycrash.lexisnexisrisk.com/ui/home", { waitUntil: "domcontentloaded" });
    if (!await robustSelect(page, /State/i, state)) throw new Error(`Could not select state: ${state}`);
    await page.waitForTimeout(800);
    if (!await robustSelect(page, /Jurisdiction/i, jurisdiction)) throw new Error(`Could not select jurisdiction: ${jurisdiction}`);

    const startBtn = page.getByRole("button", { name: /Start Search/i });
    await startBtn.waitFor({ state: "visible", timeout: 8000 });
    await startBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    if (hasOpt1) {
      await page.getByLabel(/Report Number/i).fill(reportNumber);
    } else if (hasOpt2) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      const dateInput = page.getByLabel(/Date of Incident/i).first().or(page.locator("input[placeholder*='mm/dd/yyyy']"));
      await dateInput.fill(dateOfIncident);
    } else if (hasOpt3) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      await page.getByLabel(/Location Street/i).fill(locationStreet);
    }

    // Return early (before captcha/search) to avoid timeouts
    return res.json({
      ok: true,
      step: "ready_for_captcha",
      sessionId: session.id,
      pageUrl: page.url(),
      hint: "Solve reCAPTCHA in Browserbase viewer, then call /buycrash_resume with sessionId"
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    // Keep session alive so you can solve captcha; DO NOT close browser here.
  }
});

/** Step 2: Resume after captcha; click Search -> Terms -> Add to Cart */
app.post("/buycrash_resume", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });

  let browser;
  try {
    const { connectUrl } = await bb.sessions.retrieve(sessionId);
    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.waitFor({ state: "visible", timeout: 8000 });
    await searchBtn.click();

    try {
      const modal = page.getByRole("dialog", { name: /Terms of Use/i });
      await modal.waitFor({ state: "visible", timeout: 4000 });
      await modal.getByRole("button", { name: /^OK$/i }).click();
    } catch {}

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Check results
    const hasResults = await page.locator("text=/records? found/i").first().isVisible().catch(() => false);
    if (!hasResults) {
      return res.json({ ok: true, step: "no_results_or_validation", pageUrl: page.url() });
    }

    const addBtn = page.getByRole("button", { name: /Add to Cart/i }).first();
    await addBtn.waitFor({ state: "visible", timeout: 8000 });
    await addBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});
    return res.json({ ok: true, step: "added_to_cart", cartUrl: page.url() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

// ✅ Single clean version of robustSelect (kept only once)
async function robustSelect(page, labelRegex, value) {
  try {
    const field = page.getByLabel(labelRegex);
    await field.waitFor({ state: "visible", timeout: 8000 });
    await field.click();
    await field.fill("");
    await field.type(value, { delay: 50 });
    const option = page.locator(`text="${value}"`).first();
    await option.waitFor({ state: "visible", timeout: 5000 });
    await option.click();
    return true;
  } catch (err) {
    console.warn(`Dropdown select failed for ${value}:`, err.message);
    return false;
  }
}
