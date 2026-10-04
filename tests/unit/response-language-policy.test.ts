import test from "node:test";
import assert from "node:assert/strict";

import {
  applyResponseLanguagePolicy,
  RESPONSE_LANGUAGE_POLICY,
} from "../../open-sse/services/responseLanguage.ts";

test("injects language policy into OpenAI messages and is idempotent", () => {
  const body = { messages: [{ role: "user", content: "Olá, tudo bem?" }] };
  const once = applyResponseLanguagePolicy(body, "openai");
  const twice = applyResponseLanguagePolicy(once, "openai");
  const serialized = JSON.stringify(twice);

  assert.match(serialized, /same language as the user's most recent/);
  assert.equal(serialized.split(RESPONSE_LANGUAGE_POLICY).length - 1, 1);
});

test("injects language policy into Claude system carrier", () => {
  const out = applyResponseLanguagePolicy(
    { system: "Existing system", messages: [{ role: "user", content: "Oi" }] },
    "claude"
  );
  assert.match(String(out.system), /Existing system/);
  assert.match(String(out.system), /same language as the user's most recent/);
});

test("injects language policy into Responses instructions", () => {
  const out = applyResponseLanguagePolicy(
    { instructions: "Existing", input: "Olá" },
    "openai-responses"
  );
  assert.match(String(out.instructions), /Existing/);
  assert.match(String(out.instructions), /same language as the user's most recent/);
});

test("injects language policy into Gemini systemInstruction", () => {
  const out = applyResponseLanguagePolicy(
    { contents: [{ role: "user", parts: [{ text: "Olá" }] }] },
    "gemini"
  );
  assert.match(JSON.stringify(out.systemInstruction), /same language as the user's most recent/);
});

test("policy preserves code and exact strings unless translation is requested", () => {
  assert.match(RESPONSE_LANGUAGE_POLICY, /Do not translate code/);
  assert.match(RESPONSE_LANGUAGE_POLICY, /explicitly asks for a different language/);
});