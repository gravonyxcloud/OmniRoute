import assert from "node:assert/strict";
import test from "node:test";

import { buildToolModeResponse } from "../../open-sse/executors/chatgptWebTools.ts";

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
