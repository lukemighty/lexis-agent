import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";
import { z } from "zod";
import { createServer } from "@modelcontextprotocol/sdk/server/index.js";

// 🔐 TEMP creds (move to env/secrets later)
const BROWSERBASE_API_KEY = "bb_live_OAuESQbVlwTtvkC-PcYF8EsZWxk";
const BROWSERBASE_PROJECT_ID = "b8db4f5f-488c-4ee9-b33a-c082324001bd";

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });

const InputSchema = z.object({
  portalUrl: z.string().url().default("https://example.com")
});

const lexisSearch = {
  name: "lexis_search",
  description: "Open a URL in a remote browser and return basic info (extend to forms/dropdowns later).",
  inputSchema: InputSchema,
  handler: async (input) => {
    let browser;
    try {
      const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
      browser = await chromium.connectOverCDP(session.connectUrl);

      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();

      await page.goto(input.portalUrl, { waitUntil: "domcontentloaded" });
      const title = await page.title();

      return { ok: true, visited: input.portalUrl, title };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    } finally {
      if (browser) await browser.close();
    }
  }
};

const server = createServer({
  name: "lexis-mcp",
  version: "1.0.0",
  tools: [lexisSearch],
});

server.listen();
