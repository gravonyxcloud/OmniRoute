import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { resolveClientRoutingIdentity } =
  await import("../../open-sse/handlers/chatCore/clientRoutingIdentity.ts");

test("normal keys keep the resolved backend routing identity", () => {
  const identity = resolveClientRoutingIdentity({
    provider: "openai",
    model: "gpt-5.6-sol",
    comboStrategy: "priority",
    catalogScope: "all",
    requestedModel: "gpt-public",
    comboName: null,
  });

  assert.deepEqual(identity, {
    provider: "openai",
    model: "gpt-5.6-sol",
    strategy: "priority",
    masked: false,
  });
});

test("combos-only keys expose only the public OmniRoute identity", () => {
  const identity = resolveClientRoutingIdentity({
    provider: "anthropic",
    model: "claude-backend-private",
    comboStrategy: "weighted",
    catalogScope: "combos",
    requestedModel: "combo/fast-chat",
    comboName: "fast-chat",
  });

  assert.deepEqual(identity, {
    provider: "omniroute",
    model: "fast-chat",
    strategy: "combo",
    masked: true,
  });
  assert.notEqual(identity.provider, "anthropic");
  assert.notEqual(identity.model, "claude-backend-private");
});

test("combos-only identity always prefers the stored combo over a client hardcoded model", () => {
  const identity = resolveClientRoutingIdentity({
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
    catalogScope: "combos",
    requestedModel: "claude-opus-5-5",
    comboName: "customer-combo",
  });

  assert.equal(identity.provider, "omniroute");
  assert.equal(identity.model, "customer-combo");
  assert.equal(identity.masked, true);
});

test("combos-only identity falls back to combo name without leaking backend model", () => {
  const identity = resolveClientRoutingIdentity({
    provider: "nvidia",
    model: "private/backend-model",
    catalogScope: "combos",
    requestedModel: null,
    comboName: "customer-combo",
  });

  assert.equal(identity.provider, "omniroute");
  assert.equal(identity.model, "customer-combo");
  assert.equal(identity.strategy, "combo");
});

test("chatCore uses the public identity for response.model and all success header paths", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/handlers/chatCore.ts"),
    "utf8"
  );

  assert.ok(source.includes("if (clientRoutingIdentity.masked && clientRoutingIdentity.model)"));
  assert.ok(source.includes("echoModel = clientRoutingIdentity.model"));
  assert.ok(source.includes("catalogScope: apiKeyInfo?.catalogScope"));
  assert.ok(source.includes("clientRoutingIdentity,"));
});
