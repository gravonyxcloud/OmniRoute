import assert from "node:assert/strict";
import test from "node:test";

import { buildToolModeResponse } from "../../open-sse/executors/chatgptWebTools.ts";
import { shouldRepairMissingToolCall } from "../../open-sse/executors/chatgpt-web.ts";
import { parseToolCallsFromText } from "../../open-sse/translator/webTools.ts";

test("chatgpt-web tool-mode stream preserves reasoning and indexes tool calls", async () => {
  const requestedTools = [
    {
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    },
    {
      type: "function",
      function: { name: "list_dir", description: "List a directory", parameters: { type: "object" } },
    },
  ];

  const buffered = Response.json({
    id: "chatcmpl-source",
    object: "chat.completion",
    created: 1,
    model: "gpt-5-6-thinking",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            '<tool>{"name":"read_file","arguments":{"path":"a.txt"}}</tool>' +
            '<tool>{"name":"list_dir","arguments":{"path":"."}}</tool>',
          reasoning_content:
            "Reasoning enabled via ChatGPT Web. The upstream private reasoning trace is not exposed.",
        },
        finish_reason: "stop",
      },
    ],
  });

  const response = await buildToolModeResponse(buffered, requestedTools, true, {
    cid: "chatcmpl-test",
    created: 2,
    model: "gpt-5-6-thinking",
    idSeed: "cgpt",
  });

  const body = await response.text();
  const payloads = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));

  const reasoning = payloads.find(
    (payload) => payload?.choices?.[0]?.delta?.reasoning_content
  );
  assert.match(
    reasoning.choices[0].delta.reasoning_content,
    /Reasoning enabled via ChatGPT Web/
  );

  const toolChunk = payloads.find((payload) => payload?.choices?.[0]?.delta?.tool_calls);
  assert.equal(toolChunk.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(
    toolChunk.choices[0].delta.tool_calls.map((call: { index: number }) => call.index),
    [0, 1]
  );
});


test("chatgpt-web repair catches false delete completion claims", () => {
  assert.equal(
    shouldRepairMissingToolCall("Apagados:\n- design-plan.md\n- .claude/settings.local.json", [
      { role: "user", content: "apaga os dois" },
    ]),
    true
  );

  assert.equal(
    shouldRepairMissingToolCall("Para apagar os dois, você pode usar Remove-Item.", [
      { role: "user", content: "como apago os dois?" },
    ]),
    false
  );
});

test("chatgpt-web recognizes Desktop Commander start_process for bare shell commands", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "start_process",
        description: "Start a terminal process",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];

  const parsed = parseToolCallsFromText(
    'Remove-Item -LiteralPath "design-plan.md",".claude\\settings.local.json" -Force',
    "cgpt-test",
    tools
  );

  assert.equal(parsed.content, "");
  assert.equal(parsed.toolCalls?.[0]?.function.name, "start_process");
  assert.deepEqual(
    JSON.parse(parsed.toolCalls?.[0]?.function.arguments || "{}"),
    {
      command: 'Remove-Item -LiteralPath "design-plan.md",".claude\\settings.local.json" -Force',
    }
  );
});
