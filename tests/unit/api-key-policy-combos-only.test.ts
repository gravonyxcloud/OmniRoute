/**
 * Combos-only API keys (catalog_scope 'combos', incl. plan-forced combos)
 * must dispatch exclusively to stored OmniRoute combos: direct provider
 * models and virtual auto/* ids are rejected by the policy gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combos-only-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "task-combos-only-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const modelComboMappingsDb = await import("../../src/lib/db/modelComboMappings.ts");
const costRules = await import("../../src/domain/costRules.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");

rateLimiter.setRateLimiterTestMode(true);

function getFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function resetStorage() {
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  coreDb.resetDbInstance();

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (error: unknown) {
      const code = getFsErrorCode(error);
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function loadPolicy(label: string) {
  const modulePath = path.join(process.cwd(), "src/shared/utils/apiKeyPolicy.ts");
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
}

function makePolicyRequest(apiKey: string) {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

async function readErrorMessage(response: Response) {
  const body = (await response.json()) as { error?: { message?: unknown } };
  return typeof body.error?.message === "string" ? body.error.message : "";
}

async function seedCombos() {
  await combosDb.createCombo({
    name: "fast-chat",
    strategy: "priority",
    models: ["openai/gpt-4o-mini"],
  });
  const mappedCombo = await combosDb.getComboByName("fast-chat");
  assert.ok(mappedCombo?.id);
  await modelComboMappingsDb.createModelComboMapping({
    pattern: "mapped-model-*",
    comboId: mappedCombo.id as string,
  });
}

test.beforeEach(async () => {
  delete process.env.DEFAULT_RATE_LIMIT_PER_DAY;
  await resetStorage();
  await seedCombos();
});

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("combos-only key rejects a direct provider model that is not a stored combo", async () => {
  const key = await apiKeysDb.createApiKey("combos-only", "machine-combos", [], {
    catalogScope: "combos",
  });
  const policy = await loadPolicy("combos-only-direct");

  const result = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "openai/gpt-4o-mini");
  assert.equal(result.rejection?.status, 403);
  assert.match(
    await readErrorMessage(result.rejection as Response),
    /not a stored OmniRoute combo/
  );
});

test("combos-only key dispatches to an explicit stored combo", async () => {
  const key = await apiKeysDb.createApiKey("combos-only", "machine-combos", [], {
    catalogScope: "combos",
  });
  const policy = await loadPolicy("combos-only-combo");

  const result = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "combo/fast-chat");
  assert.equal(result.rejection, null);
});

test("combos-only key dispatches a provider model that maps to a stored combo", async () => {
  const key = await apiKeysDb.createApiKey("combos-only", "machine-combos", [], {
    catalogScope: "combos",
  });
  const policy = await loadPolicy("combos-only-mapped");

  const result = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "mapped-model-1");
  assert.equal(result.rejection, null);
});

test("combos-only key rejects virtual auto combos", async () => {
  const key = await apiKeysDb.createApiKey("combos-only", "machine-combos", [], {
    catalogScope: "combos",
  });
  const policy = await loadPolicy("combos-only-auto");

  const result = await policy.enforceApiKeyPolicy(
    makePolicyRequest(key.key),
    "auto/openai/gpt-4o-mini"
  );
  assert.equal(result.rejection?.status, 403);
  assert.match(
    await readErrorMessage(result.rejection as Response),
    /not a stored OmniRoute combo/
  );
});

test("control: all-scope keys keep dispatching direct provider models and auto combos", async () => {
  const key = await apiKeysDb.createApiKey("all-scope", "machine-combos", [], {
    catalogScope: "all",
  });
  const policy = await loadPolicy("all-scope-control");

  const direct = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "openai/gpt-4o-mini");
  assert.equal(direct.rejection, null);

  const auto = await policy.enforceApiKeyPolicy(
    makePolicyRequest(key.key),
    "auto/openai/gpt-4o-mini"
  );
  assert.equal(auto.rejection, null);
});

test("plan keys are forced combos-only and reject direct provider models", async () => {
  const key = await apiKeysDb.createApiKey("plan-key", "machine-combos", [], { planId: "7d" });
  const policy = await loadPolicy("plan-key-combos-only");

  const combo = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "combo/fast-chat");
  assert.equal(combo.rejection, null);

  const direct = await policy.enforceApiKeyPolicy(makePolicyRequest(key.key), "openai/gpt-4o-mini");
  assert.equal(direct.rejection?.status, 403);
  assert.match(
    await readErrorMessage(direct.rejection as Response),
    /not a stored OmniRoute combo/
  );
});
