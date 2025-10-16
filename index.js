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

/** NEW: BuyCrash flow — select State -> Jurisdiction -> Start Search -> fill -> terms -> add to cart */
app.post("/buycrash_find", async (req, res) => {
  const {
    state,
    jurisdiction,
    url = "https://buycrash.lexisnexisrisk.com/ui/home",
    reportNumber,                // option 1
    lastName, dateOfIncident,    // option 2 (mm/dd/yyyy)
    locationStreet,              // option 3 (with lastName)
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
      error: "Provide one of: reportNumber OR (lastName + dateOfIncident) OR (lastName + locationStreet)"
    });
  }

  let browser;
  try {
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    // --- home: select state & jurisdiction ---
    await page.goto(url, { waitUntil: "domcontentloaded" });

    async function robustSelect(labelRegex, value) {
      try {
        const sel = page.getByLabel(labelRegex);
        await sel.waitFor({ state: "visible", timeout: 6000 });
        await sel.selectOption({ label: value }).catch(async () => {
          await sel.selectOption(value);
        });
        return true;
      } catch {
        try {
          const combo = page.getByRole("combobox", { name: labelRegex });
          await combo.waitFor({ state: "visible", timeout: 6000 });
          await combo.click();
          await page.keyboard.type(value, { delay: 25 });
          await page.keyboard.press("Enter");
          return true;
        } catch {
          return false;
        }
      }
    }

    const stateOK = await robustSelect(/State/i, state);
    if (!stateOK) throw new Error(`Could not select State: ${state}`);
    await page.waitForTimeout(800);
    const jurisOK = await robustSelect(/Jurisdiction/i, jurisdiction);
    if (!jurisOK) throw new Error(`Could not select Jurisdiction: ${jurisdiction}`);

    const startBtn = page.getByRole("button", { name: /Start Search/i });
    await startBtn.waitFor({ state: "visible", timeout: 6000 });
    await startBtn.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // --- on the Search page: fill one option ---
    if (hasOpt1) {
      await page.getByLabel(/Report Number/i).fill(reportNumber);
    } else if (hasOpt2) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      const dateInput =
        page.getByLabel(/Date of Incident/i).first().or(page.locator("input[placeholder*='mm/dd/yyyy']"));
      await dateInput.fill(dateOfIncident);
    } else if (hasOpt3) {
      await page.getByLabel(/^Last Name/i).first().fill(lastName);
      await page.getByLabel(/Location Street/i).fill(locationStreet);
    }

    // --- Try reCAPTCHA checkbox; if not possible, return requiresHumanCaptcha
    let captchaOk = false;
    try {
      const captchaFrame = page.frameLocator("iframe[title*='reCAPTCHA']");
      await captchaFrame.getByRole("checkbox", { name: /I.?m not a robot/i }).click({ timeout: 4000 });
      await page.waitForTimeout(1500);
      captchaOk = true;
    } catch {
      // cannot reliably solve; require human
    }

    if (!captchaOk) {
      return res.json({
        ok: true,
        state, jurisdiction,
        step: "captcha",
        requiresHumanCaptcha: true,
        pageUrl: page.url(),
        note: "Solve the CAPTCHA in a browser, then resume."
      });
    }

    // --- click Search ---
    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.waitFor({ state: "visible", timeout: 6000 });
    await searchBtn.click();

    // --- Terms of Use modal ---
    try {
      const modal = page.getByRole("dialog", { name: /Terms of Use/i });
      await modal.waitFor({ state: "visible", timeout: 4000 });
      await modal.getByRole("button", { name: /^OK$/i }).click();
    } catch { /* modal may not appear */ }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});

    // --- results?
    const resultsHeader = page.locator("text=/records? found/i");
    const hasResults = await resultsHeader.first().isVisible().catch(() => false);

    if (!hasResults) {
      return res.json({
        ok: true,
        state, jurisdiction,
        step: "no_results_or_validation",
        pageUrl: page.url()
      });
    }

    // --- click Add to Cart and return next page URL
    const addToCart = page.getByRole("button", { name: /Add to Cart/i }).first();
    await addToCart.waitFor({ state: "visible", timeout: 6000 });
    await addToCart.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle").catch(() => {});
    const cartUrl = page.url();

    return res.json({
      ok: true,
      state, jurisdiction,
      queryUsed: { reportNumber, lastName, dateOfIncident, locationStreet },
      step: "added_to_cart",
      cartUrl
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on :${port}`));
