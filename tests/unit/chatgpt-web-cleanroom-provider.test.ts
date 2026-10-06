import assert from "node:assert/strict";
import test from "node:test";

import { chatgpt_webProvider } from "../../open-sse/config/providers/registry/chatgpt-web/index.ts";
import {
  ChatGptWebExecutor,
  chatGptWebAccountPluginsEnabled,
} from "../../open-sse/executors/chatgpt-web.ts";
import { REGISTRY, getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { validateChatGptWebProvider } from "../../src/lib/providers/validation/chatgptWeb.ts";
import { validateWebCookieProvider } from "../../src/lib/providers/validation/webCookie.ts";
import { AI_PROVIDERS, WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers.ts";
import {
  assertCommonChatGptWebProviderAvailable,
  isCommonChatGptWebRetiredProviderId,
} from "../../src/shared/constants/chatgptWebRetirement.ts";

const MODEL_IDS = [
  "gpt-6-pro",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5-6",
  "gpt-5-6-thinking",
  "gpt-5-6-pro",
  "gpt-5.6-luna-free",
  "gpt-5.6-luna-free-thinking",
  "gpt-5-5-instant",
  "gpt-5-5-thinking",
  "gpt-5-5-pro",
];

test("uses connected ChatGPT account plugins by default with an explicit opt-out", () => {
  assert.equal(chatGptWebAccountPluginsEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(
    chatGptWebAccountPluginsEnabled({ CHATGPT_WEB_ACCOUNT_PLUGINS: "1" } as NodeJS.ProcessEnv),
    true
  );
  assert.equal(
    chatGptWebAccountPluginsEnabled({ CHATGPT_WEB_ACCOUNT_PLUGINS: "off" } as NodeJS.ProcessEnv),
    false
  );
});

test("registers only the clean-room ChatGPT Web routes observed in the first-party UI", () => {
  assert.equal(chatgpt_webProvider.id, "chatgpt-web");
  assert.deepEqual(
    chatgpt_webProvider.models.map((model) => model.id),
    MODEL_IDS
  );
  assert.equal(REGISTRY["chatgpt-web"], chatgpt_webProvider);
  assert.equal(getRegistryEntry("chatgpt-web"), chatgpt_webProvider);
  assert.equal(WEB_COOKIE_PROVIDERS["chatgpt-web"].toolCalling, "emulated");
  assert.equal(AI_PROVIDERS["chatgpt-web"].id, "chatgpt-web");
  assert.equal(hasSpecializedExecutor("chatgpt-web"), true);
});

test("restores the canonical id without reviving the provenance-tainted legacy alias", () => {
  assert.equal(isCommonChatGptWebRetiredProviderId("chatgpt-web"), false);
  assert.doesNotThrow(() => assertCommonChatGptWebProviderAvailable("chatgpt-web"));
  assert.equal(isCommonChatGptWebRetiredProviderId("cgpt-web"), true);
  assert.throws(() => assertCommonChatGptWebProviderAvailable("cgpt-web"), {
    code: "PROVIDER_RETIRED",
  });
});

test("validates encrypted-at-rest storage-state input without echoing secrets", async () => {
  const storageState = JSON.stringify({
    cookies: [
      {
        name: "session",
        value: "do-not-echo",
        domain: ".chatgpt.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });
  assert.deepEqual(await validateChatGptWebProvider({ apiKey: storageState }), {
    valid: true,
    error: null,
    unsupported: false,
  });
  assert.deepEqual(
    await validateWebCookieProvider({ provider: "chatgpt-web", apiKey: storageState }),
    { valid: true, error: null, unsupported: false }
  );
  const invalid = await validateChatGptWebProvider({
    apiKey: JSON.stringify({
      cookies: [
        {
          name: "session",
          value: "do-not-echo",
          domain: ".example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  });
  assert.equal(invalid.valid, false);
  assert.equal(JSON.stringify(invalid).includes("do-not-echo"), false);
});

test("specialized executor delegates to the clean-room browser adapter", async () => {
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async () => ({
      conversationId: "private-conversation",
      turnExchangeId: "private-turn",
      text: "CLEANROOM_PROVIDER_OK",
      status: "finished_successfully",
      endTurn: true,
    }),
    id: () => "chatcmpl-provider",
    now: () => 123_000,
  });
  const response = await executor.execute({
    model: "gpt-5-6",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: {
      connectionId: "connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });
  assert.ok(response instanceof Response);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "CLEANROOM_PROVIDER_OK");
  assert.equal(JSON.stringify(body).includes("private-conversation"), false);
});

test("surfaces an exhausted Free image quota as 429 for sibling-account fallback", async () => {
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async () => {
      throw new Error("You've reached your image upload limit");
    },
  });

  const response = await executor.execute({
    model: "gpt-5.6-luna-free",
    body: { messages: [{ role: "user", content: "image" }] },
    stream: false,
    credentials: {
      connectionId: "free-connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });

  assert.equal(response.response.status, 429);
  assert.match(await response.response.text(), /image upload limit/);
});

test("accepts tool-bearing requests through the text-context fallback", async () => {
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async (_session, request) => ({
      conversationId: "private-conversation",
      turnExchangeId: "private-turn",
      text: request.prompt.includes("example") ? "TOOLS_CONTEXT_OK" : "MISSING_TOOL_CONTEXT",
      status: "finished_successfully",
      endTurn: true,
    }),
  });

  const response = await executor.execute({
    model: "gpt-5-6",
    body: {
      tools: [
        {
          type: "function",
          function: { name: "example", description: "Example client-side tool" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    },
    stream: false,
    credentials: {
      connectionId: "connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });

  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "TOOLS_CONTEXT_OK");
  assert.equal(JSON.stringify(body).includes("chatgpt-web"), false);
});

test("routes local actions through connected ChatGPT account plugins when enabled", async () => {
  const previous = process.env.CHATGPT_WEB_ACCOUNT_PLUGINS;
  process.env.CHATGPT_WEB_ACCOUNT_PLUGINS = "1";
  let sessionInput: any = null;
  let seenPrompt = "";

  try {
    const executor = new ChatGptWebExecutor({
      createSession: async (input) => {
        sessionInput = input;
        return {
          url: () => input.pageUrl || "https://chatgpt.com/",
          start: async () => async () => {},
          submitPrompt: async () => {},
        };
      },
      runTurn: async (_session, request) => {
        seenPrompt = request.prompt;
        return {
          conversationId: "private-conversation",
          turnExchangeId: "private-turn",
          text: "ACCOUNT_PLUGIN_OK",
          status: "finished_successfully" as const,
          endTurn: true,
        };
      },
    });

    const response = await executor.execute({
      model: "gpt-5-6-thinking",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "Bash",
              description: "Run a shell command in the current project",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
        messages: [{ role: "user", content: "crie um arquivo html no meu pc" }],
      },
      stream: false,
      credentials: {
        connectionId: "connection",
        apiKey: JSON.stringify({ cookies: [], origins: [] }),
      },
    });

    assert.equal(sessionInput?.forceComposer, true);
    assert.equal(sessionInput?.pageUrl, "https://chatgpt.com/");
    assert.match(seenPrompt, /Remote Desktop Commander/);
    assert.doesNotMatch(seenPrompt, /Client tools available in the calling application/);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "ACCOUNT_PLUGIN_OK");
    assert.equal(body.choices[0].finish_reason, "stop");
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_WEB_ACCOUNT_PLUGINS;
    else process.env.CHATGPT_WEB_ACCOUNT_PLUGINS = previous;
  }
});

test("returns emulated OpenAI tool_calls for agent clients", async () => {
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async () => ({
      conversationId: "private-conversation",
      turnExchangeId: "private-turn",
      text: '<tool>{"name":"write_file","arguments":{"path":"notes.txt","content":"hello"}}</tool>',
      status: "finished_successfully",
      endTurn: true,
    }),
  });

  const response = await executor.execute({
    model: "gpt-5-6-thinking",
    body: {
      tools: [
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Write a local file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
      ],
      messages: [{ role: "user", content: "create notes.txt" }],
    },
    stream: false,
    credentials: {
      connectionId: "connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });

  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "write_file");
  assert.deepEqual(
    JSON.parse(body.choices[0].message.tool_calls[0].function.arguments),
    { path: "notes.txt", content: "hello" }
  );
});


test("keeps repairing claimed local completion until a real client tool call is emitted", async () => {
  let turns = 0;
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async () => {
      turns += 1;
      return {
        conversationId: "private-conversation",
        turnExchangeId: "private-turn",
        text:
          turns < 3
            ? "Apagados: design-plan.md e .claude/settings.local.json"
            : '<tool>{"name":"Bash","arguments":{"command":"rm -f design-plan.md .claude/settings.local.json"}}</tool>',
        status: "finished_successfully" as const,
        endTurn: true,
      };
    },
  });

  const response = await executor.execute({
    model: "gpt-5-6-thinking",
    body: {
      tools: [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Run a shell command in the current project",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      messages: [{ role: "user", content: "apaga os dois arquivos" }],
    },
    stream: false,
    credentials: {
      connectionId: "connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });

  assert.equal(turns, 3);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "Bash");
});

test("repairs a deferred local action into a real client tool call", async () => {
  let turns = 0;
  const executor = new ChatGptWebExecutor({
    createSession: async () => ({
      url: () => "https://chatgpt.com/?temporary-chat=true",
      start: async () => async () => {},
      submitPrompt: async () => {},
    }),
    runTurn: async () => {
      turns += 1;
      return {
        conversationId: "private-conversation",
        turnExchangeId: "private-turn",
        text:
          turns === 1
            ? "Vou pegar a configuração do seu PC e te passo CPU, RAM, GPU e Windows."
            : '<tool>{"name":"get_pc_config","arguments":{}}</tool>',
        status: "finished_successfully" as const,
        endTurn: true,
      };
    },
  });

  const response = await executor.execute({
    model: "gpt-5-6-thinking",
    body: {
      tools: [
        {
          type: "function",
          function: {
            name: "get_pc_config",
            description: "Read the current PC hardware and Windows configuration",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      messages: [{ role: "user", content: "qual config do meu pc" }],
    },
    stream: false,
    credentials: {
      connectionId: "connection",
      apiKey: JSON.stringify({ cookies: [], origins: [] }),
    },
  });

  assert.equal(turns, 2);
  assert.ok(response instanceof Response);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "get_pc_config");
});
