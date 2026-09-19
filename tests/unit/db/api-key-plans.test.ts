/**
 * Unit coverage for API key plans (migration 182): plan fields on create,
 * plan-forced combos-only `catalog_scope`, and renewal semantics extending
 * expiry from max(now, current expires_at).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-api-key-plans-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { API_KEY_PLAN_IDS, getApiKeyPlanDays, planExpiryDate, API_KEY_PLAN_DAY_MS } =
  await import("../../../src/shared/constants/apiKeyPlans.ts");

const MACHINE_ID = "machine1234567890";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function readRawColumns(id: string) {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => {
      get: (id: string) =>
        | {
            catalog_scope: string | null;
            customer_email: string | null;
            plan_id: string | null;
            plan_days: number | null;
            plan_started_at: string | null;
            renewals_count: number | null;
            expires_at: string | null;
          }
        | undefined;
    };
  };
  return db
    .prepare(
      "SELECT catalog_scope, customer_email, plan_id, plan_days, plan_started_at, renewals_count, expires_at FROM api_keys WHERE id = ?"
    )
    .get(id);
}

test("constants expose the supported plan ids and day counts", () => {
  assert.deepEqual(API_KEY_PLAN_IDS, ["3d", "7d", "15d", "30d"]);
  assert.equal(getApiKeyPlanDays("7d"), 7);
  assert.equal(getApiKeyPlanDays("nope"), null);
  assert.equal(getApiKeyPlanDays(null), null);
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(planExpiryDate(start, 3), "2026-01-04T00:00:00.000Z");
});

test("createApiKey with a plan derives expiry, stores plan fields and forces combos-only scope", async () => {
  const created = await apiKeysDb.createApiKey("plan-health", MACHINE_ID, [], {
    planId: "7d",
    customerEmail: "customer@example.com",
  });

  assert.equal(created.catalogScope, "combos");
  assert.equal(created.planId, "7d");
  assert.equal(created.planDays, 7);
  assert.equal(created.renewalsCount, 0);
  assert.ok(created.planStartedAt);
  assert.ok(created.expiresAt);
  const expiryMs = Date.parse(created.expiresAt as string);
  const fromMs = Date.now() + (7 - 1) * API_KEY_PLAN_DAY_MS;
  const toMs = Date.now() + (7 + 1) * API_KEY_PLAN_DAY_MS;
  assert.ok(expiryMs >= fromMs && expiryMs <= toMs, `expiry ${created.expiresAt} out of range`);

  const raw = readRawColumns(created.id);
  assert.equal(raw?.catalog_scope, "combos");
  assert.equal(raw?.customer_email, "customer@example.com");
  assert.equal(raw?.plan_id, "7d");
  assert.equal(raw?.plan_days, 7);
  assert.equal(raw?.renewals_count, 0);
  assert.equal(raw?.expires_at, created.expiresAt);

  const byId = await apiKeysDb.getApiKeyById(created.id);
  assert.equal(byId?.catalogScope, "combos");
  assert.equal(byId?.planId, "7d");
  assert.equal(byId?.planDays, 7);
  assert.equal(byId?.customerEmail, "customer@example.com");
  assert.equal(byId?.renewalsCount, 0);

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.equal(meta?.catalogScope, "combos");
  assert.equal(meta?.planId, "7d");
  assert.equal(meta?.renewalsCount, 0);

  const listed = await apiKeysDb.getApiKeys();
  const listedRow = listed.find((k) => k.id === created.id);
  assert.equal(listedRow?.catalogScope, "combos");
  assert.equal(listedRow?.planDays, 7);
});

test("createApiKey without a plan keeps the historical all-scope default", async () => {
  const created = await apiKeysDb.createApiKey("plain", MACHINE_ID);
  assert.equal(created.catalogScope, "all");
  assert.equal(created.planId, null);
  assert.equal(created.planDays, null);
  assert.equal(created.planStartedAt, null);
  assert.equal(created.expiresAt, null);

  const raw = readRawColumns(created.id);
  assert.equal(raw?.catalog_scope, "all");
  assert.equal(raw?.plan_id, null);
  assert.equal(raw?.plan_days, null);
  assert.equal(raw?.customer_email, null);
  assert.equal(raw?.renewals_count, 0);
});

test("createApiKey respects an explicit catalogScope when no plan is set", async () => {
  const created = await apiKeysDb.createApiKey("explicit-combos", MACHINE_ID, [], {
    catalogScope: "combos",
  });
  const raw = readRawColumns(created.id);
  assert.equal(raw?.catalog_scope, "combos");
  assert.equal(raw?.plan_id, null);
});

test("renewApiKey extends expiry from max(now, current expires_at) and increments the counter", async () => {
  const created = await apiKeysDb.createApiKey("renewable", MACHINE_ID, [], { planId: "3d" });
  const firstExpiry = Date.parse(created.expiresAt as string);

  const renewed = await apiKeysDb.renewApiKey(created.id, "15d");
  assert.equal(renewed.status, "ok");
  if (renewed.status !== "ok") return;
  assert.equal(renewed.planId, "15d");
  assert.equal(renewed.planDays, 15);
  assert.equal(renewed.renewalsCount, 1);

  // Extended from the old expiry (still in the future), not from now.
  const newExpiryMs = Date.parse(renewed.expiresAt);
  const extendFromMs = Math.max(Date.now(), firstExpiry) + (15 - 1) * API_KEY_PLAN_DAY_MS;
  const extendToMs = Math.max(Date.now(), firstExpiry) + (15 + 1) * API_KEY_PLAN_DAY_MS;
  assert.ok(
    newExpiryMs >= extendFromMs && newExpiryMs <= extendToMs,
    `renewed expiry ${renewed.expiresAt} out of range`
  );

  const raw = readRawColumns(created.id);
  assert.equal(raw?.plan_id, "15d");
  assert.equal(raw?.plan_days, 15);
  assert.equal(raw?.renewals_count, 1);
  assert.equal(raw?.expires_at, renewed.expiresAt);
});

test("renewApiKey renews an expired key from now", async () => {
  const created = await apiKeysDb.createApiKey("expired-plan", MACHINE_ID, [], { planId: "3d" });
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (params: unknown[]) => void };
  };
  db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run([
    "2020-01-01T00:00:00.000Z",
    created.id,
  ]);

  const renewed = await apiKeysDb.renewApiKey(created.id, "7d");
  assert.equal(renewed.status, "ok");
  if (renewed.status !== "ok") return;

  const nowMs = Date.now();
  const newExpiryMs = Date.parse(renewed.expiresAt);
  assert.ok(
    newExpiryMs >= nowMs + (7 - 1) * API_KEY_PLAN_DAY_MS &&
      newExpiryMs <= nowMs + (7 + 1) * API_KEY_PLAN_DAY_MS,
    `renewed expiry ${renewed.expiresAt} out of range`
  );
});

test("renewApiKey preserves plan_started_at across renewals", async () => {
  const created = await apiKeysDb.createApiKey("started-plan", MACHINE_ID, [], {
    planId: "3d",
    planStartedAt: "2026-01-15T00:00:00.000Z",
  });
  const rawBefore = readRawColumns(created.id);
  assert.equal(rawBefore?.plan_started_at, "2026-01-15T00:00:00.000Z");

  await apiKeysDb.renewApiKey(created.id, "7d");
  const rawAfter = readRawColumns(created.id);
  assert.equal(rawAfter?.plan_started_at, "2026-01-15T00:00:00.000Z");
});

test("renewApiKey rejects revoked keys and unknown ids", async () => {
  const created = await apiKeysDb.createApiKey("revoked-plan", MACHINE_ID, [], { planId: "3d" });
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (params: unknown[]) => void };
  };
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run([
    new Date().toISOString(),
    created.id,
  ]);

  const revoked = await apiKeysDb.renewApiKey(created.id, "7d");
  assert.equal(revoked.status, "revoked");

  const missing = await apiKeysDb.renewApiKey("no-such-id", "7d");
  assert.equal(missing.status, "not_found");

  const invalidPlan = await apiKeysDb.renewApiKey(created.id, "bogus");
  assert.equal(invalidPlan.status, "not_found");
});
