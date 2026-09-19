/**
 * tests/unit/api-key-plans-ui.test.ts
 *
 * Source-level assertions for the api-key-plans feature UI surface:
 * create form (planId + customerEmail), per-key renew action + success modal,
 * the sidebar entry, the endpoint reference page, and en/pt-BR i18n parity.
 * Pattern mirrors api-manager-quota-keys-section.test.ts (source-scan only).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PAGE = join(ROOT, "src/app/(dashboard)/dashboard/api-manager/ApiManagerPageClient.tsx");
const SECTIONS = join(ROOT, "src/shared/constants/sidebarVisibility/sections.ts");
const TYPES = join(ROOT, "src/shared/constants/sidebarVisibility/types.ts");
const DOCS = join(ROOT, "src/app/(dashboard)/dashboard/api-manager/plans/page.tsx");

const src = readFileSync(PAGE, "utf8");
const sections = readFileSync(SECTIONS, "utf8");
const types = readFileSync(TYPES, "utf8");
const docs = readFileSync(DOCS, "utf8");

const en = JSON.parse(readFileSync(join(ROOT, "src/i18n/messages/en.json"), "utf8")) as {
  apiManager: Record<string, string>;
  sidebar: Record<string, string>;
};
const pt = JSON.parse(readFileSync(join(ROOT, "src/i18n/messages/pt-BR.json"), "utf8")) as {
  apiManager: Record<string, string>;
  sidebar: Record<string, string>;
};

const NEW_API_MANAGER_KEYS = [
  "renewKey",
  "renewConfirm",
  "failedRenewKey",
  "renewedSuccess",
  "planLabel",
  "planLabelDesc",
  "planNone",
  "customerEmail",
  "customerEmailPlaceholder",
  "renewalsBadge",
];
const NEW_SIDEBAR_KEYS = ["apiKeyPlanEndpoints", "apiKeyPlanEndpointsSubtitle"];

test("create form wires planId + customerEmail into POST /api/keys", () => {
  assert.ok(
    src.includes("newKeyPlanId") && src.includes("newKeyCustomerEmail"),
    "plan states exist"
  );
  assert.ok(src.includes("planId: newKeyPlanId || undefined"), "planId sent to create body");
  assert.ok(
    src.includes("customerEmail: newKeyCustomerEmail.trim() || undefined"),
    "customerEmail sent to create body"
  );
  assert.ok(
    src.includes("API_KEY_PLAN_IDS") && src.includes("API_KEY_PLAN_DAYS"),
    "plan options rendered from the shared constants"
  );
});

test("plan keys expose a renew action + success modal", () => {
  assert.ok(src.includes("handleRenewKey"), "renew handler exists");
  assert.ok(
    src.includes("`/api/keys/${encodeURIComponent(key.id)}/renew`"),
    "renew calls POST /api/keys/:id/renew"
  );
  assert.ok(src.includes("JSON.stringify({ planId: key.planId })"), "renew sends planId");
  assert.ok(src.includes("{key.planId && ("), "renew button gated on planId");
  assert.ok(src.includes("event_repeat"), "renew icon present");
  assert.ok(src.includes("renewedKeyInfo"), "renewed-key modal state exists");
  assert.ok(src.includes('t("renewedSuccess"'), "success message uses i18n key");
  assert.ok(
    src.includes('t("renewalsBadge", { count: key.renewalsCount })'),
    "row shows renewals badge"
  );
});

test("sidebar gains the api-key-plans endpoint entry", () => {
  assert.ok(sections.includes('id: "api-key-plans"'), "sidebar item id registered in sections");
  assert.ok(
    sections.includes('href: "/dashboard/api-manager/plans"'),
    "item links to the endpoint reference page"
  );
  assert.ok(sections.includes('i18nKey: "apiKeyPlanEndpoints"'), "item i18n key set");
  assert.ok(types.includes('"api-key-plans"'), "item id registered in HIDEABLE_SIDEBAR_ITEM_IDS");
});

test("endpoint reference page documents both endpoints", () => {
  assert.ok(docs.includes("POST /api/keys"), "create endpoint documented");
  assert.ok(docs.includes("/renew"), "renew endpoint documented");
  assert.ok(docs.includes("planId"), "planId documented");
  assert.ok(docs.includes("expiresAt"), "expiry behavior documented");
});

test("new i18n keys exist in both en and pt-BR", () => {
  for (const k of NEW_API_MANAGER_KEYS) {
    assert.ok(en.apiManager[k], `en apiManager.${k}`);
    assert.ok(pt.apiManager[k], `pt-BR apiManager.${k}`);
  }
  for (const k of NEW_SIDEBAR_KEYS) {
    assert.ok(en.sidebar[k], `en sidebar.${k}`);
    assert.ok(pt.sidebar[k], `pt-BR sidebar.${k}`);
  }
});
