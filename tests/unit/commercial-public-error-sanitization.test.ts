import test from "node:test";
import assert from "node:assert/strict";

import {
  errorResponseWithComboDiagnostics,
  sanitizeComboDiagnostics,
} from "../../open-sse/utils/error.ts";

const rawDiagnostics = {
  poolSize: 2,
  attempted: 2,
  excluded: [{ provider: "nvidia", model: "secret-model-a", reason: "rate_limited" }],
  attemptOrder: [{ provider: "chatgpt-web", model: "secret-model-b" }],
  terminalReason: "provider_error",
  skippedTargets: [{ reason: "provider_unavailable", targets: ["nvidia/secret-model-c"] }],
  recovery: {
    action: "try-auto" as const,
    next_step: "Try auto/nvidia/secret-model-a",
  },
};

test("public combo diagnostics hide upstream provider/model identities", () => {
  const safe = sanitizeComboDiagnostics(rawDiagnostics);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /nvidia|chatgpt-web|secret-model/i);
  assert.equal(safe.excluded[0]?.provider, "upstream");
  assert.equal(safe.attemptOrder[0]?.model, "hidden");
  assert.equal(safe.skippedTargets?.[0]?.targets[0], "hidden");
  assert.equal(safe.recovery, undefined);
});

test("public combo error body and headers do not leak upstream identity", async () => {
  const response = errorResponseWithComboDiagnostics(
    503,
    "NVIDIA secret-model-a failed; ChatGPT Web fallback failed",
    rawDiagnostics,
    { code: "provider_unavailable", type: "service_unavailable" }
  );
  const body = await response.text();
  const headers = JSON.stringify(Object.fromEntries(response.headers.entries()));

  assert.doesNotMatch(body, /nvidia|chatgpt|secret-model|try-auto/i);
  assert.doesNotMatch(headers, /nvidia|chatgpt|secret-model|try-auto/i);
  assert.equal(response.status, 503);
});