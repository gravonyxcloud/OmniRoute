import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  injectResponseLanguageDirective,
  RESPONSE_LANGUAGE_DIRECTIVE,
} = await import("../../open-sse/handlers/chatCore/responseLanguage.ts");

test("OpenAI messages receive the language directive after existing system instructions", () => {
  const body = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Me explique isso em português." },
    ],
  };
  const result = injectResponseLanguageDirective(body);

  assert.notEqual(result, body);
  assert.match(String(result.messages[0].content), /You are helpful/);
  assert.ok(String(result.messages[0].content).endsWith(RESPONSE_LANGUAGE_DIRECTIVE));
  assert.deepEqual(body.messages[0], { role: "system", content: "You are helpful." });
});

test("OpenAI messages without a system carrier get one", () => {
  const result = injectResponseLanguageDirective({
    messages: [{ role: "user", content: "Hola, explícame esto." }],
  });

  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, RESPONSE_LANGUAGE_DIRECTIVE);
  assert.equal(result.messages[1].role, "user");
});

test("Anthropic system field receives the same provider-agnostic directive", () => {
  const result = injectResponseLanguageDirective({
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "Responda em português." }],
  });

  assert.ok(String(result.system).startsWith("You are Claude Code."));
  assert.ok(String(result.system).endsWith(RESPONSE_LANGUAGE_DIRECTIVE));
  assert.equal(result.messages.length, 1);
});

test("OpenAI Responses instructions receive the directive", () => {
  const result = injectResponseLanguageDirective({
    instructions: "Be concise.",
    input: [{ role: "user", content: "Explain this in English." }],
  });

  assert.equal(
    result.instructions,
    "Be concise.\n\n" + RESPONSE_LANGUAGE_DIRECTIVE
  );
});

test("Gemini systemInstruction receives the directive", () => {
  const result = injectResponseLanguageDirective({
    contents: [{ role: "user", parts: [{ text: "日本語で説明して" }] }],
    systemInstruction: { role: "system", parts: [{ text: "Be accurate." }] },
  });

  assert.equal(result.systemInstruction.parts[0].text, "Be accurate.");
  assert.equal(
    result.systemInstruction.parts[result.systemInstruction.parts.length - 1].text,
    RESPONSE_LANGUAGE_DIRECTIVE
  );
});

test("language injection is idempotent across combo retries/re-entry", () => {
  const first = injectResponseLanguageDirective({
    messages: [{ role: "user", content: "Oi" }],
  });
  const second = injectResponseLanguageDirective(first);

  assert.deepEqual(second, first);
  const serialized = JSON.stringify(second);
  assert.equal(serialized.split(RESPONSE_LANGUAGE_DIRECTIVE).length - 1, 1);
});

test("requests without a user turn are left unchanged", () => {
  const body = { messages: [{ role: "system", content: "internal classifier" }] };
  assert.equal(injectResponseLanguageDirective(body), body);
});

test("directive explicitly preserves an explicit user-requested language override", () => {
  assert.match(RESPONSE_LANGUAGE_DIRECTIVE, /unless the user explicitly asks for a different language/);
});

test("chatCore wires language continuity before provider dispatch", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/handlers/chatCore.ts"),
    "utf8"
  );
  assert.ok(source.includes("injectResponseLanguageDirective(body)"));
});
