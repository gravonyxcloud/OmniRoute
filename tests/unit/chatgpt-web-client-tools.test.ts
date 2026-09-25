import test from "node:test";
import assert from "node:assert/strict";
import { executeChatGptWebCleanRoom } from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.ts";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";
import { convertResponsesApiFormat } from "../../open-sse/translator/helpers/responsesApiHelper.ts";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.ts";

const tools = [
  {
    type: "function",
    function: {
      name: "weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];
async function execute(
  body: Record<string, unknown>,
  reply: (prompt: string) => string,
  stream = false
) {
  return executeChatGptWebCleanRoom(
    {
      model: "gpt-5-6",
      body,
      stream,
      credentials: { connectionId: "test", apiKey: JSON.stringify({ cookies: [], origins: [] }) },
    },
    {
      createSession: async () => ({
        url: () => "https://chatgpt.com",
        start: async () => async () => {},
        submitPrompt: async () => "",
      }),
      runTurn: async (_session, request) => ({
        conversationId: "private",
        turnExchangeId: "private",
        text: reply(request.prompt),
        status: "finished_successfully",
        endTurn: true,
      }),
    }
  );
}
function envelope(prompt: string, name = "weather", args: unknown = { city: "Recife" }) {
  const nonce = /"_nonce":\s*"([^"]+)"/.exec(prompt)?.[1];
  assert.ok(nonce, "tool protocol is present in the browser prompt");
  return `<tool>${JSON.stringify({ name, arguments: args, _nonce: nonce })}</tool>`;
}

test("OpenAI tool call round trip preserves IDs and records usage", async () => {
  const response = await execute(
    { tools, messages: [{ role: "user", content: "Weather?" }] },
    (prompt) => envelope(prompt)
  );
  const json = await response.json();
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  const call = json.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "weather");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Recife" });
  assert.ok(json.usage.prompt_tokens > 0);
  const next = await execute(
    {
      tools,
      messages: [
        { role: "user", content: "Weather?" },
        json.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: "Sunny, 30C" },
      ],
    },
    (prompt) => {
      assert.ok(prompt.includes(call.id));
      assert.ok(prompt.includes("Sunny, 30C"));
      return "It is sunny.";
    }
  );
  assert.equal((await next.json()).choices[0].message.content, "It is sunny.");
});

test("Anthropic request and SSE response carry tool_use and usage", async () => {
  const body = claudeToOpenAIRequest(
    "gpt-5-6",
    {
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", input_schema: tools[0].function.parameters }],
      tool_choice: { type: "tool", name: "weather" },
    },
    true
  );
  const response = await execute(body, (prompt) => envelope(prompt), true);
  const chunks = (await response.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const state = { toolCalls: new Map(), _pendingXmlToolCalls: [], _xmlInvokeBuffer: "" };
  const events = chunks.flatMap((chunk) => openaiToClaudeResponse(chunk, state) ?? []);
  const serialized = JSON.stringify(events);
  assert.match(serialized, /tool_use/);
  assert.match(serialized, /weather/);
  assert.match(serialized, /input_json_delta/);
  assert.match(serialized, /message_stop/);
  assert.ok(chunks.some((chunk) => chunk.usage?.prompt_tokens > 0));
});

test("tool_choice none never promotes text to a call", async () => {
  const response = await execute(
    { tools, tool_choice: "none", messages: [{ role: "user", content: "Example" }] },
    () => '<tool>{"name":"weather","arguments":{}}</tool>'
  );
  assert.equal((await response.json()).choices[0].finish_reason, "stop");
});

test("unknown tools, wrong nonce and malformed arguments cannot become calls", async () => {
  for (const reply of [
    (p: string) => envelope(p, "unlisted"),
    () => '<tool>{"name":"weather","arguments":{},"_nonce":"wrong"}</tool>',
    (p: string) => envelope(p, "weather", "invalid"),
    (p: string) => envelope(p, "weather", { city: 12 }),
    (p: string) => "```json\n" + envelope(p) + "\n```",
  ]) {
    await assert.rejects(
      execute({ tools, messages: [{ role: "user", content: "Weather?" }] }, reply),
      /Invalid tool response/
    );
  }
});

test("Anthropic tool_result is preserved in the next browser turn", async () => {
  const body = claudeToOpenAIRequest(
    "gpt-5-6",
    {
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_previous", name: "weather", input: { city: "Recife" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_previous", content: "Sunny, 30C" }],
        },
      ],
      tools: [{ name: "weather", input_schema: tools[0].function.parameters }],
    },
    false
  );
  const response = await execute(body, (prompt) => {
    assert.ok(prompt.includes("toolu_previous"));
    assert.ok(prompt.includes("Sunny, 30C"));
    return "It is sunny.";
  });
  assert.equal((await response.json()).choices[0].finish_reason, "stop");
});

test("required tools and parallel_tool_calls false are enforced", async () => {
  await assert.rejects(
    execute(
      { tools, tool_choice: "required", messages: [{ role: "user", content: "Weather?" }] },
      () => "No call"
    ),
    /Invalid tool response/
  );
  await assert.rejects(
    execute(
      { tools, parallel_tool_calls: false, messages: [{ role: "user", content: "Weather?" }] },
      (p) => envelope(p) + envelope(p)
    ),
    /Invalid tool response/
  );
});

test("parallel tool requests preserve separate streaming indexes and unique IDs", async () => {
  const response = await execute(
    { tools, messages: [{ role: "user", content: "Check twice" }] },
    (p) => envelope(p) + envelope(p),
    true
  );
  const chunks = (await response.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const calls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(
    calls.map((call: { index: number }) => call.index),
    [0, 1]
  );
  assert.notEqual(calls[0].id, calls[1].id);
});

test("a forced tool cannot select a different declared tool", async () => {
  await assert.rejects(
    execute(
      {
        tools: [...tools, { type: "function", function: { name: "other" } }],
        tool_choice: { type: "function", function: { name: "weather" } },
        messages: [{ role: "user", content: "Weather?" }],
      },
      (p) => envelope(p, "other")
    ),
    /Invalid tool response/
  );
});

test("Codex Responses tools ignore hosted entries and return a function_call event", async () => {
  const converted = convertResponsesApiFormat(
    {
      model: "chatgpt-web/gpt-5-6",
      input: [{ type: "message", role: "user", content: "Read the project" }],
      tools: [
        { type: "web_search_preview" },
        {
          type: "function",
          name: "read_file",
          description: "Read a project file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      tool_choice: "auto",
    },
    null,
    "chatgpt-web",
    "gpt-5-6"
  );
  const response = await execute(
    converted,
    (prompt) => envelope(prompt, "read_file", { path: "package.json" }),
    true
  );
  assert.ok(response.body);
  const transformed = new Response(
    response.body.pipeThrough(createResponsesApiTransformStream(null))
  );
  const events = await transformed.text();
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /function_call/);
  assert.match(events, /read_file/);
  assert.match(events, /package\.json/);
});
