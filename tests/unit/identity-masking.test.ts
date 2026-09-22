import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isIdentityMaskingEnabled,
  buildComboIdentityMaskText,
  buildDirectIdentityMaskText,
  applyComboIdentityMask,
  injectIdentityMask,
} from "../../open-sse/services/identityMasking.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) original[key] = process.env[key];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("isIdentityMaskingEnabled defaults to ON", () => {
  withEnv({ OMNIROUTE_IDENTITY_MASKING: undefined }, () => {
    assert.equal(isIdentityMaskingEnabled(), true);
  });
});

test("isIdentityMaskingEnabled honors offish values", () => {
  for (const v of ["0", "false", "no", "off", " FALSE ", "Off"]) {
    withEnv({ OMNIROUTE_IDENTITY_MASKING: v }, () => {
      assert.equal(isIdentityMaskingEnabled(), false, `OMNIROUTE_IDENTITY_MASKING=${v}`);
    });
  }
});

test("isIdentityMaskingEnabled keeps masking on truthy values", () => {
  for (const v of ["1", "true", "yes", "on"]) {
    withEnv({ OMNIROUTE_IDENTITY_MASKING: v }, () => {
      assert.equal(isIdentityMaskingEnabled(), true, `OMNIROUTE_IDENTITY_MASKING=${v}`);
    });
  }
});

test("buildComboIdentityMaskText embeds the combo name", () => {
  const text = buildComboIdentityMaskText("  my-combo  ");
  assert.ok(text);
  assert.match(text!, /route "my-combo"/);
  assert.match(text!, /my-combo/);
});

test("buildComboIdentityMaskText returns null for missing/blank combo name", () => {
  assert.equal(buildComboIdentityMaskText(undefined), null);
  assert.equal(buildComboIdentityMaskText("   "), null);
});

test("buildDirectIdentityMaskText embeds the requested model", () => {
  const text = buildDirectIdentityMaskText("gpt-fake");
  assert.ok(text);
  assert.match(text!, /model "gpt-fake"/);
  assert.match(text!, /gpt-fake/);
});

test("buildDirectIdentityMaskText falls back to generic phrasing", () => {
  const text = buildDirectIdentityMaskText(undefined);
  assert.ok(text);
  assert.match(text!, /your existing model name/);
});

test("applyComboIdentityMask injects into an openai body and returns a new object", () => {
  const body = { model: "x", messages: [{ role: "user", content: "hi" }] };
  const out = applyComboIdentityMask(body, "route-a", undefined);
  assert.notEqual(out, body);
  const sys = out.messages!.find((m: Record<string, unknown>) => m.role === "system");
  assert.ok(sys, "a system message with the mask should exist");
  assert.match(sys.content, /route "route-a"/);
});

test("applyComboIdentityMask string override wins", () => {
  const body = { messages: [] };
  const out = applyComboIdentityMask(body, "route-a", "Call yourself BANANA.");
  const sys = out.messages!.find((m: Record<string, unknown>) => m.role === "system");
  assert.match(sys.content, /BANANA/);
  assert.doesNotMatch(out.messages![0].content, /route "route-a"/);
});

test("applyComboIdentityMask false disables masking for that combo", () => {
  const body = { messages: [{ role: "system", content: "keep me" }] };
  const out = applyComboIdentityMask(body, "route-a", false);
  assert.equal(out, body);
});

test("applyComboIdentityMask 'false' string disables masking", () => {
  const body = { messages: [] };
  const out = applyComboIdentityMask(body, "route-a", "false");
  assert.equal(out, body);
});

test("applyComboIdentityMask global env off disables masking", () => {
  withEnv({ OMNIROUTE_IDENTITY_MASKING: "0" }, () => {
    const body = { messages: [] };
    const out = applyComboIdentityMask(body, "route-a", undefined);
    assert.equal(out, body);
  });
});

test("injectIdentityMask appends to existing openai system message", () => {
  const body = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
  };
  const out = injectIdentityMask(body, "MASK");
  assert.match(out.messages![0].content, /^You are helpful\.\n\nMASK$/);
});

test("injectIdentityMask prepends a system message when none present", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = injectIdentityMask(body, "MASK");
  assert.equal(out.messages![0].role, "system");
  assert.equal(out.messages![0].content, "MASK");
  assert.equal(out.messages!.length, 2);
});

test("injectIdentityMask appends block to array-content system message", () => {
  const body = { messages: [{ role: "system", content: [{ type: "text", text: "base" }] }] };
  const out = injectIdentityMask(body, "MASK");
  assert.deepEqual(out.messages![0].content[1], { type: "text", text: "MASK" });
});

test("injectIdentityMask claude string system appends", () => {
  const body = { system: "base", messages: [] };
  const out = injectIdentityMask(body, "MASK", "claude");
  assert.match(out.system, /base\n\nMASK$/);
});

test("injectIdentityMask claude block array appends text block", () => {
  const body = { system: [{ type: "text", text: "base" }], messages: [] };
  const out = injectIdentityMask(body, "MASK", "claude");
  assert.deepEqual(out.system![1], { type: "text", text: "MASK" });
});

test("injectIdentityMask creates claude system field when absent", () => {
  const body = { messages: [] };
  const out = injectIdentityMask(body, "MASK", "claude");
  assert.equal(out.system, "MASK");
});

test("injectIdentityMask gemini systemInstruction appends part", () => {
  const body = { systemInstruction: { parts: [{ text: "base" }] } };
  const out = injectIdentityMask(body, "MASK", "gemini");
  const si = out.systemInstruction as { parts: { text: string }[]; role?: string };
  assert.equal(si.parts.length, 2);
  assert.deepEqual(si.parts[1], { text: "MASK" });
});

test("injectIdentityMask gemini creates systemInstruction when absent", () => {
  const body = { contents: [] };
  const out = injectIdentityMask(body, "MASK", "gemini");
  const si = out.systemInstruction as { parts: { text: string }[]; role?: string };
  assert.deepEqual(si.parts, [{ text: "MASK" }]);
});

test("injectIdentityMask responses instructions string", () => {
  const body = { instructions: "base" };
  const out = injectIdentityMask(body, "MASK", "openai-responses");
  assert.match(out.instructions, /base\n\nMASK$/);
});

test("injectIdentityMask responses creates instructions when absent", () => {
  const body = { input: [] };
  const out = injectIdentityMask(body, "MASK", "openai-responses");
  assert.equal(out.instructions, "MASK");
});

test("injectIdentityMask shape-detection picks claude system without targetFormat", () => {
  const body = { system: "base", messages: [] };
  const out = injectIdentityMask(body, "MASK");
  assert.match(out.system, /base\n\nMASK$/);
});

test("injectIdentityMask shape-detection picks instructions without targetFormat", () => {
  const body = { instructions: "base" };
  const out = injectIdentityMask(body, "MASK");
  assert.match(out.instructions, /base\n\nMASK$/);
});

test("injectIdentityMask returns non-record body untouched", () => {
  const out = injectIdentityMask(null as unknown as Record<string, unknown>, "MASK");
  assert.equal(out, null);
});
