import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

// 🔐 TEMP: hardcode your test creds (we'll move to Secret Manager later)
const BROWSERBASE_API_KEY = "bb_live_OAuESQbVlwTtvkC-PcYF8EsZWxk";
const BROWSERBASE_PROJECT_ID = "b8db4f5f-488c-4ee9-b33a-c082324001bd";

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => res.send("OK"));

// Example endpoint using Browserbase + Playwright over CDP
app.post("/lexis_search", async (req, res) => {
  const { portalUrl = "https://example.com" } = req.body || {};
  let browser;

  try {
    // ✅ Now explicitly passing projectId
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

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on :${port}`));
