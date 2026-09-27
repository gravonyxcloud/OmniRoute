import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompatMap,
  isModelHiddenFn,
} from "../../src/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers.ts";

test("provider model visibility reads chat-scoped hiddenModalities", () => {
  const custom = buildCompatMap([]);
  const overrides = buildCompatMap([
    {
      id: "gpt-5-6",
      hiddenModalities: { chat: true },
    },
  ]);

  assert.equal(isModelHiddenFn("gpt-5-6", custom, overrides), true);
  assert.equal(isModelHiddenFn("gpt-5-5-instant", custom, overrides), false);
});

test("chat-scoped visibility takes precedence over legacy global isHidden", () => {
  const custom = buildCompatMap([
    {
      id: "gpt-5-6",
      isHidden: true,
      hiddenModalities: { chat: false },
    },
  ]);
  const overrides = buildCompatMap([]);

  assert.equal(isModelHiddenFn("gpt-5-6", custom, overrides), false);
});
