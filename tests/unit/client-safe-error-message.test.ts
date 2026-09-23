import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Upstream provider errors must never leak the provider/model/reason to the end
// client. The client-visible error.message must be a generic per-status message
// (sem nome de provedor, sem nome de modelo, sem motivo upstream), while the full
// diagnostic text stays in result.error/rawMessage and the operator's logs.
const { getClientSafeErrorMessage } = await import("../../open-sse/config/errorConfig.ts");

test("getClientSafeErrorMessage returns a generic per-status message without provider/model/reason", () => {
  const table: Record<number, string> = {
    400: "Bad request",
    401: "Authentication failed",
    402: "Payment required",
    403: "Forbidden",
    404: "Not found",
    406: "Not acceptable",
    408: "Request timeout",
    410: "Gone",
    429: "Too many requests",
    499: "Client disconnected",
    500: "Internal server error",
    501: "Not implemented",
    502: "Bad gateway",
    503: "Service unavailable",
    504: "Gateway timeout",
  };

  for (const [status, expected] of Object.entries(table)) {
    const message = getClientSafeErrorMessage(Number(status));
    assert.equal(message, expected, `status ${status} must map to "${expected}"`);
    assert.doesNotMatch(
      message,
      /OpenCode|provider \(Console\)|free tier|model|\[?\d{3}\]/i,
      `status ${status} message must not leak provider/model/reason: ${message}`
    );
  }
});

test("getClientSafeErrorMessage falls back to a generic default for unknown statuses", () => {
  const message = getClientSafeErrorMessage(599);
  assert.equal(message, "An error occurred");
});

test("getClientSafeErrorMessage never contains provider or model identifiers", () => {
  assert.doesNotMatch(getClientSafeErrorMessage(403), /gle\.ai|openai|anthropic|gemini|claude/i);
  assert.doesNotMatch(getClientSafeErrorMessage(502), /upstream|provider/i);
});

// ── handleChatCore integration (shared temp DATA_DIR like chatcore-sanitization.test.ts) ──
const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-client-safe-error-message-")
);
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  globalThis.fetch = originalFetchForAfter;
  try {
    core.getDbInstance().close();
  } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const originalFetchForAfter = globalThis.fetch;

const OPENCODE_FREE_TIER_BODY = JSON.stringify({
  error: {
    type: "FreeTierError",
    message:
      "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
  },
});

async function invokeChatCoreWith403(stream: boolean) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(OPENCODE_FREE_TIER_BODY, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  try {
    return await handleChatCore({
      body: {
        model: "gpt-4o-mini",
        stream,
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: { stream, messages: [{ role: "user", content: "hi" }] },
        headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("client-safe body is used for JSON non-stream upstream failures", async () => {
  const result = await invokeChatCoreWith403(false);

  assert.equal(result.success, false);
  assert.equal(result.status, 403);
  const body = JSON.parse(await result.response.text());
  assert.equal(body?.error?.message, "Forbidden");
  assert.doesNotMatch(body?.error?.message, /OpenCode|free tier|Console|Error from provider/i);
  // Internal classification keeps the full diagnostic text.
  assert.match(result.rawMessage ?? result.error, /OpenCode/i);
});

test("client-safe body is used for streaming requests when the first upstream send fails", async () => {
  const result = await invokeChatCoreWith403(true);

  // A stream whose first send fails with a non-2xx is NOT an in-flight SSE stream:
  // the provider never started streaming, so the failure returns a JSON body with
  // the same client-safe masking as the non-stream path.
  assert.equal(result.success, false);
  assert.equal(result.status, 403);
  assert.ok(result.response.headers.get("content-type")?.includes("application/json"));
  const body = JSON.parse(await result.response.text());
  assert.equal(body?.error?.message, "Forbidden");
  assert.doesNotMatch(body?.error?.message, /OpenCode|free tier|Console|Error from provider/i);
  // Internal classification keeps the full diagnostic text.
  assert.match(result.rawMessage ?? result.error, /OpenCode/i);
});
