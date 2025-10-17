import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";
import { robustSelect } from "./robustSelect.js";

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error("Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID env vars.");
  process.exit(1);
}

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("OK"));

/** Smoke test */
app.post("/lexis_search", async (req, res) => {
  const { portalUrl = "https://example.com" } = req.body || {};
  let browser;
  try {
    console.log("[/lexis_search] creating session…");
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    console.log("[/lexis_search] goto", portalUrl);
    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    res.json({ ok: true, visited: portalUrl, title });
  } catch (e) {
    console.error("[/lexis_search] error:", e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

/** Step 1: Begin & pause before CAPTCHA */
app.post("/buycrash_begin", async (req, res) => {
  const { state, jurisdiction, reportNumber, lastName, dateOfIncident, locationStreet } = req.body || {};
  if (!state || !jurisdiction) return res.status(400).json({ ok: false, error: "State and jurisdiction required" });
  const hasOpt1 = !!reportNumber, hasOpt2 = !!(lastName && dateOfIncident), hasOpt3 = !!(lastName && locationStreet);
  if (!hasOpt1 && !hasOpt2 && !hasOpt3) {
    return res.status(400).json({ ok: false, error: "Provide reportNumber OR (lastName + dateOfIncident) OR (lastName + locationStreet)" });
  }

  let browser, session;
  try {
    console.log("[/buycrash_begin] create session…");
    session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    console.log("[/buycrash_begin] goto home…");
    await page.goto("https://buycrash.lexisnexisrisk.com/ui/home", { waitUntil: "domcontentloaded" });

    console.log("[/buycrash_begin] select state:", state);
    const stateOK = await robustSelect(page, /State/i, state);
    if (!stateOK) throw new Error(`Could not select state: ${state}`);
    await page.waitForTimeout(800);

    console.log("[/buycrash_begin] select jurisdiction:", jurisdiction);
    const jurisOK = await robustSelect(page, /Jurisdiction/i, jurisdiction);
    if (!jurisOK) throw new Error(`Could not select jurisdiction: ${jurisdiction}`);
    await page.waitForTimeout(600);

    console.log("[/buycrash_begin] click Start Search…");
    const startBtn = page.getByRole("button", { name: /Start Search/i });
    await startBtn.waitFor({ state: "visible", timeout: 8000 });
    await startBtn.click();

    console.log("[/buycrash_begin] wait for search page…");
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

    console.log("[/buycrash_begin] ready for CAPTCHA — returning sessionId:", session.id);
    res.json({
      ok: true,
      step: "ready_for_captcha",
      sessionId: session.id,
      pageUrl: page.url(),
      hint: "Solve reCAPTCHA in Browserbase viewer, then call /buycrash_resume with sessionId"
    });
  } catch (e) {
    console.error("[/buycrash_begin] error:", e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    // keep session alive so you can solve CAPTCHA
  }
});

/** Step 2: Resume after CAPTCHA → Search → Terms → Add to Cart → return cartUrl */
app.post("/buycrash_resume", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });

  let browser;
  try {
    console.log("[/buycrash_resume] reconnect", sessionId);
    const { connectUrl } = await bb.sessions.retrieve(sessionId);
    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    console.log("[/buycrash_resume] click Search…");
    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.waitFor({ state: "visible", timeout: 8000 });
    await searchBtn.click();

    try {
      console.log("[/buycrash_resume] handle Terms of Use (if present) …");
      const modal = page.getByRole("dialog", { name: /Terms of Use/i });
      await modal.waitFor({ state: "visible", timeout: 4000 });
      await modal.getByRole("button", { name: /^OK$/i }).click();
    } catch {}

    console.log("[/buycrash_resume] wait for results…");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    const hasResults = await page.locator("text=/records? found/i").first().isVisible().catch(() => false);
    if (!hasResults) {
      console.log("[/buycrash_resume] no results or validation page");
      return res.json({ ok: true, step: "no_results_or_validation", pageUrl: page.url() });
    }

    console.log("[/buycrash_resume] click Add to Cart…");
    const addBtn = page.getByRole("button", { name: /Add to Cart/i }).first();
    await addBtn.waitFor({ state: "visible", timeout: 8000 });
    await addBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});
    const cartUrl = page.url();
    console.log("[/buycrash_resume] done, cartUrl:", cartUrl);

    res.json({ ok: true, step: "added_to_cart", cartUrl });
  } catch (e) {
    console.error("[/buycrash_resume] error:", e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));
