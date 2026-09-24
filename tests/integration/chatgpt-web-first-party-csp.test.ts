import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { executeChatGptWebFirstPartyTurn } from "../../open-sse/utils/chatgptWebFirstParty.ts";

const assetUrl = "https://chatgpt.com/cdn/assets/bridge-csp-fixture.js";
const source = [
  "const cc={getEnforcementToken:async()=> 'proof'};",
  "const dd={getEnforcementToken:async()=> 'turnstile'};",
  "async function gg(){return {token:'requirements'}}",
  "async function aa(e,t){let[r,i]=await Promise.all([cc.getEnforcementToken(t,{forceSync:!0}),dd.getEnforcementToken(t)]);return[r,i]}",
  "function ff(e=!1,t=`none`){return gg(`finalized`,e,t)}",
  "const ee={safePost:async()=>new Response('data: [DONE]\\n\\n')};",
  "async function hh(){return ee.safePost(`/sentinel/chat-requirements/prepare`,{})}",
  "function ii(e,t,n,r,i,a){let o={};return e?.token?o[`OpenAI-Sentinel-Chat-Requirements-Token`]=e.token:o}",
  "export{ff as A,cc as B,dd as C,ee as D,ii as E};",
].join("\n");

test("loads the first-party bridge with a CSP that forbids blob scripts", async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), assetUrl);
    return new Response(source);
  }) as typeof fetch;
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", async (route) => {
      if (route.request().url() === assetUrl) {
        await route.fulfill({ contentType: "text/javascript", body: source });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": "default-src 'none'; script-src 'self'" },
        body: '<html><head><link rel="modulepreload" href="/cdn/assets/bridge-csp-fixture.js"></head><body></body></html>',
      });
    });
    await page.goto("https://chatgpt.com/");
    const result = await executeChatGptWebFirstPartyTurn(page, {
      prompt: "CSP regression probe",
      attachments: [],
      selection: { kind: "free", thinkEnabled: false },
    });
    assert.equal(result, "data: [DONE]\n\n");

    // A stale page from an earlier bundle can retain a partial bridge. The
    // next request must repair it instead of merely seeing an object and then
    // failing later with "request client is unavailable".
    await page.evaluate(() => {
      (globalThis as Record<string, unknown>).__omnirouteChatGptFirstPartyV1 = {};
    });
    const repaired = await executeChatGptWebFirstPartyTurn(page, {
      prompt: "Bridge repair regression probe",
      attachments: [],
      selection: { kind: "free", thinkEnabled: false },
    });
    assert.equal(repaired, "data: [DONE]\n\n");
    assert.equal(await page.locator('script[src^="blob:"]').count(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    await browser.close();
  }
});
