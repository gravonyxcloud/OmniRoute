import test from "node:test";
import assert from "node:assert/strict";

const { projectClientRoutingErrorMessage } =
  await import("../../open-sse/handlers/chatCore/clientRoutingError.ts");

const masked = {
  provider: "omniroute",
  model: "customer-combo",
  strategy: "combo",
  masked: true,
};

test("masked context errors expose only the public combo name", () => {
  const message = projectClientRoutingErrorMessage({
    identity: masked,
    statusCode: 400,
    message:
      "Input exceeds context window for opencode/mimo-v2.6-flash-free: estimated 201402 input tokens, limit 200000",
    errorCode: "context_length_exceeded",
  });

  assert.match(message, /customer-combo/);
  assert.match(message, /context window/i);
  assert.doesNotMatch(message, /opencode|mimo/i);
});

test("masked provider failures never expose backend provider or model", () => {
  const message = projectClientRoutingErrorMessage({
    identity: masked,
    statusCode: 502,
    message:
      "cloudflare-playground/moonshotai/kimi-k2.7-code closed the stream: Prompt too long",
  });

  assert.match(message, /context window/i);
  assert.match(message, /customer-combo/);
  assert.doesNotMatch(message, /cloudflare|moonshot|kimi/i);
});

test("ordinary keys preserve the sanitized provider error", () => {
  const message = projectClientRoutingErrorMessage({
    identity: {
      provider: "openai",
      model: "gpt-test",
      strategy: "single",
      masked: false,
    },
    statusCode: 400,
    message: "ordinary upstream error",
  });

  assert.equal(message, "ordinary upstream error");
});
