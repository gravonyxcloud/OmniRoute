import test from "node:test";
import assert from "node:assert/strict";

const { projectCommercialComboSuccessResponse } =
  await import("../../open-sse/handlers/chatCore/clientRoutingResponse.ts");

const comboArgs = { catalogScope: "combos", comboName: "cliente-premium" };

test("commercial JSON responses expose only the public combo identity", async () => {
  const input = new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "mimo-v2.6-flash-free",
      provider: "opencode",
      choices: [
        {
          message: {
            role: "assistant",
            content: "ok",
            tool_calls: [{ function: { arguments: "{\"model\":\"keep-this-tool-value\"}" } }],
          },
        },
      ],
    }),
    { headers: { "content-type": "application/json", "x-omniroute-provider": "opencode" } }
  );
  const response = await projectCommercialComboSuccessResponse(input, comboArgs);
  const body = await response.json();

  assert.equal(body.model, "cliente-premium");
  assert.equal(body.provider, "omniroute");
  assert.equal(response.headers.get("x-omniroute-provider"), "omniroute");
  assert.equal(response.headers.get("x-omniroute-model"), "cliente-premium");
  assert.equal(
    body.choices[0].message.tool_calls[0].function.arguments,
    "{\"model\":\"keep-this-tool-value\"}"
  );
});

test("Anthropic SSE message_start never exposes the backend model", async () => {
  const stream =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"mimo-v2.6-flash-free","content":[]}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"oi"}}\n\n';
  const response = await projectCommercialComboSuccessResponse(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    comboArgs
  );
  const text = await response.text();

  assert.match(text, /"model":"cliente-premium"/);
  assert.doesNotMatch(text, /mimo-v2\.6-flash-free|opencode/i);
  assert.match(text, /"text":"oi"/);
});

test("SSE error frames with HTTP 200 are projected onto the combo identity", async () => {
  const stream =
    'event: error\n' +
    'data: {"type":"error","error":{"type":"api_error","message":"opencode/mimo-v2.6-flash-free timed out"}}\n\n';
  const response = await projectCommercialComboSuccessResponse(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    comboArgs
  );
  const text = await response.text();
  assert.match(text, /cliente-premium/);
  assert.doesNotMatch(text, /opencode|mimo/i);
  assert.match(text, /combo_error|api_error/i);
});

test("Responses API event identity is rewritten without touching output content", async () => {
  const stream =
    'event: response.created\n' +
    'data: {"type":"response.created","response":{"id":"resp_1","model":"private-model","provider":"private-provider","output":[]}}\n\n';
  const response = await projectCommercialComboSuccessResponse(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    comboArgs
  );
  const text = await response.text();

  assert.match(text, /"model":"cliente-premium"/);
  assert.match(text, /"provider":"omniroute"/);
  assert.doesNotMatch(text, /private-model|private-provider/);
});

test("ordinary keys are untouched", async () => {
  const input = new Response('{"model":"real-model"}', {
    headers: { "content-type": "application/json" },
  });
  const response = await projectCommercialComboSuccessResponse(input, {
    catalogScope: "all",
    comboName: "ignored",
  });
  assert.equal(response, input);
});
