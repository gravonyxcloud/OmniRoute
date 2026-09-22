/**
 * Regression: fast-failover when an upstream model is offline. Two levers were added:
 *
 * 1. `COMBO_TARGET_TIMEOUT_MS` — operator override for the default per-target combo
 *    timeout. Without it the fallback was a fixed 120s (`DEFAULT_COMBO_TARGET_TIMEOUT_MS`),
 *    so a hung/offline upstream re-hit the SAME slow model across `maxRetries` before ever
 *    failing over. Invalid/non-positive values fall back to the constant; the value is
 *    clamped to `MAX_TIMER_TIMEOUT_MS` like every other positive timeout.
 *
 * 2. `isConnectivityClassFailure` — classifies OS/socket-level connectivity errors
 *    (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, socket hang up, fetch failed, proxy
 *    unreachable, …) and `structuredError.code === "proxy_unreachable"` so the retry
 *    gates in `executeTargetAttempt.ts` and `roundRobinCombo.ts` skip the same-model
 *    retry and advance to the next target immediately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  resolveDefaultComboTargetTimeoutMs,
  resolveComboTargetTimeoutMsForCombo,
  DEFAULT_COMBO_TARGET_TIMEOUT_MS,
  COMBO_TARGET_TIMEOUT_WAIT_BUFFER_MS,
} = await import("../../open-sse/services/comboConfig.ts");
const { isConnectivityClassFailure } =
  await import("../../open-sse/services/combo/comboPredicates.ts");
const { MAX_TIMER_TIMEOUT_MS } = await import("../../src/shared/utils/runtimeTimeouts.ts");

test("resolveDefaultComboTargetTimeoutMs: default constant when env unset", () => {
  assert.equal(resolveDefaultComboTargetTimeoutMs({}), DEFAULT_COMBO_TARGET_TIMEOUT_MS);
});

test("resolveDefaultComboTargetTimeoutMs: valid positive override replaces the constant", () => {
  assert.equal(resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "30000" }), 30_000);
});

test("resolveDefaultComboTargetTimeoutMs: non-numeric value falls back to the constant", () => {
  assert.equal(
    resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "fast" }),
    DEFAULT_COMBO_TARGET_TIMEOUT_MS
  );
});

test("resolveDefaultComboTargetTimeoutMs: non-positive value falls back to the constant", () => {
  assert.equal(
    resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "0" }),
    DEFAULT_COMBO_TARGET_TIMEOUT_MS
  );
  assert.equal(
    resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "-5000" }),
    DEFAULT_COMBO_TARGET_TIMEOUT_MS
  );
});

test("resolveDefaultComboTargetTimeoutMs: decimal override is floored", () => {
  assert.equal(resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "30000.9" }), 30_000);
});

test("resolveDefaultComboTargetTimeoutMs: clamped to MAX_TIMER_TIMEOUT_MS", () => {
  assert.equal(
    resolveDefaultComboTargetTimeoutMs({ COMBO_TARGET_TIMEOUT_MS: "99999999999" }),
    MAX_TIMER_TIMEOUT_MS
  );
});

test("resolveComboTargetTimeoutMsForCombo: env override propagates to the fallback floor", () => {
  const result = resolveComboTargetTimeoutMsForCombo({}, 120_000, "priority", {
    enabled: false,
    budgetMs: 0,
  });
  assert.equal(result, 120_000);

  const withOverride = resolveComboTargetTimeoutMsForCombo(
    {},
    120_000,
    "priority",
    { enabled: false, budgetMs: 0 },
    { COMBO_TARGET_TIMEOUT_MS: "45000" }
  );
  assert.equal(withOverride, 45_000);
});

test("resolveComboTargetTimeoutMsForCombo: cooldown-wait floor never dips below the wait budget", () => {
  const budgetMs = 30_000;
  const floor = resolveComboTargetTimeoutMsForCombo(
    {},
    120_000,
    "priority",
    { enabled: true, budgetMs },
    { COMBO_TARGET_TIMEOUT_MS: "5000" }
  );
  assert.equal(floor, budgetMs + COMBO_TARGET_TIMEOUT_WAIT_BUFFER_MS);
});

test("isConnectivityClassFailure: returns false for empty input", () => {
  assert.equal(isConnectivityClassFailure({}), false);
  assert.equal(isConnectivityClassFailure({ errorText: "" }), false);
});

test("isConnectivityClassFailure: OS socket error codes match", () => {
  for (const text of [
    "connect ECONNREFUSED 127.0.0.1:80",
    "read ECONNRESET",
    "getaddrinfo ENOTFOUND api.openai.com",
    "request timed out: ETIMEDOUT",
    "connect ENETUNREACH 10.0.0.1:443",
    "connect EHOSTUNREACH gateway",
    "fetch failed",
    "socket hang up",
    "proxy unreachable: 127.0.0.1:7890",
    "network unreachable",
    "getaddrinfo ENOTFOUND model.example.com",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    assert.equal(isConnectivityClassFailure({ errorText: text }), true, text);
  }
});

test("isConnectivityClassFailure: matching is case-insensitive", () => {
  assert.equal(isConnectivityClassFailure({ errorText: "connect econnrefused" }), true);
});

test("isConnectivityClassFailure: HTTP statuses / non-connectivity text do not match", () => {
  for (const text of [
    "429 too many requests",
    "401 invalid api key",
    "403 forbidden",
    "503 service unavailable",
    "upstream returned 500",
    "model not found: gpt-4",
    "insufficient_quota",
  ]) {
    assert.equal(isConnectivityClassFailure({ errorText: text }), false, text);
  }
});

test("isConnectivityClassFailure: structuredError.code proxy_unreachable matches", () => {
  assert.equal(
    isConnectivityClassFailure({
      errorText: "",
      structuredError: { code: "proxy_unreachable", type: "connect" },
    }),
    true
  );
});

test("isConnectivityClassFailure: unrelated structuredError codes do not match", () => {
  assert.equal(
    isConnectivityClassFailure({
      errorText: "",
      structuredError: { code: "invalid_api_key", type: "auth" },
    }),
    false
  );
});
