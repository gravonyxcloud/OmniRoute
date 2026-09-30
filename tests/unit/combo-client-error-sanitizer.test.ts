import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeComboClientErrorResponse } from "../../open-sse/services/combo/clientErrorSanitizer.ts";

test("combo client errors hide provider/model/connection identity", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        message:
          "Input exceeds context window for opencode/mimo-v2.6-flash-free: estimated 201402 input tokens, limit 200000.",
        provider: "opencode",
        model: "mimo-v2.6-flash-free",
        connectionId: "secret-connection-id",
        details: { route: "nvidia/nemotron-free" },
      },
    }),
    {
      status: 400,
      headers: {
        "content-type": "application/json",
        "x-omniroute-provider": "opencode",
        "x-omniroute-model": "mimo-v2.6-flash-free",
        "x-omniroute-selected-connection-id": "secret-connection-id",
        "x-omniroute-decision": "provider=opencode model=mimo-v2.6-flash-free",
      },
    }
  );

  const sanitized = await sanitizeComboClientErrorResponse(response, {
    name: "agent-pro",
    models: ["opencode/mimo-v2.6-flash-free", "nvidia/nemotron-free"],
  });

  const text = await sanitized.text();
  const body = JSON.parse(text);
  assert.equal(sanitized.status, 400);
  assert.equal(sanitized.headers.get("x-omniroute-provider"), "omniroute");
  assert.equal(sanitized.headers.get("x-omniroute-model"), "combo/agent-pro");
  assert.equal(sanitized.headers.get("x-omniroute-strategy"), "combo");
  assert.equal(sanitized.headers.get("x-omniroute-selected-connection-id"), null);
  assert.equal(sanitized.headers.get("x-omniroute-decision"), null);
  assert.equal(body.error.provider, "omniroute");
  assert.equal(body.error.model, "combo/agent-pro");
  assert.equal(body.error.connectionId, undefined);
  assert.match(body.error.message, /combo\/agent-pro/);
  assert.doesNotMatch(text, /opencode|mimo-v2\.6-flash-free|nvidia|nemotron-free|secret-connection-id/i);
});

test("combo client sanitizer also covers plain-text dynamic provider/model routes", async () => {
  const response = new Response("[400]: Error from provider: randomvendor/random-model unavailable", {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
  const sanitized = await sanitizeComboClientErrorResponse(response, { name: "public-combo" });
  const text = await sanitized.text();
  assert.match(text, /combo\/public-combo/);
  assert.doesNotMatch(text, /randomvendor\/random-model/i);
});