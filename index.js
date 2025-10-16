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
app.use(express.json());

app.get("/", (_req, res) => res.send("OK"));

/** Simple visit tool (kept) */
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

/** NEW: BuyCrash flow — select State -> Jurisdiction -> Start Search */
app.post("/buycrash_search", async (req, res) => {
  const {
    state,
    jurisdiction,
    url = "https://buycrash.lexisnexisrisk.com/ui/home",
    screenshot = false
  } = req.body || {};

  if (!state || !jurisdiction) {
    return res.status(400).json({ ok: false, error: "state and jurisdiction are required" });
  }

  let browser;
  try {
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    // 1) Go to the BuyCrash home
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Helper: robust select for native <select> OR custom combobox
    async function robustSelect(labelRegex, value) {
      // Try native <select> first via accessible label
      try {
        const sel = page.getByLabel(labelRegex);
        await sel.waitFor({ state: "visible", timeout: 5000 });
        await sel.selectOption({ label: value }).catch(async () => {
          // fallback: by value text
          await sel.selectOption(value);
        });
        return true;
      } catch (_) {
        // Try ARIA combobox
        try {
          const combo = page.getByRole("combobox", { name: labelRegex });
          await combo.waitFor({ state: "visible", timeout: 5000 });
          await combo.click();
          // Some custom UIs require typing then Enter
          await page.keyboard.type(value, { delay: 30 });
          // Wait for an option to appear, then Enter
          await page.keyboard.press("Enter");
          return true;
        } catch (e2) {
          return false;
        }
      }
    }

    // 2) Select State
    const stateOK = await robustSelect(/State/i, state);
    if (!stateOK) throw new Error(`Could not select State: ${state}`);

    // 3) Wait for Jurisdiction to enable/appear, then select
    //    (the field appears after state; give it time)
    await page.waitForTimeout(800); // small debounce for dynamic UI
    const jurisOK = await robustSelect(/Jurisdiction/i, jurisdiction);
    if (!jurisOK) throw new Error(`Could not select Jurisdiction: ${jurisdiction}`);

    // 4) Click Start Search
    const startBtn =
      page.getByRole("button", { name: /Start Search/i }) ||
      page.locator("button:has-text('Start Search')");
    await startBtn.waitFor({ state: "visible", timeout: 5000 });
    await startBtn.click();

    // 5) Give page time to navigate/load results
    await page.waitForLoadState("domcontentloaded");
    // Some flows do async fetch; be a bit patient:
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    let shot;
    if (screenshot) {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true });
      shot = `data:image/jpeg;base64,${buf.toString("base64")}`;
    }

    res.json({
      ok: true,
      visited: url,
      state,
      jurisdiction,
      resultUrl: page.url(),
      screenshot: screenshot ? shot : undefined
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on :${port}`));
