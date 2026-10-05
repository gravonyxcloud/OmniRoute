import { randomUUID } from "node:crypto";

import { chatgpt_webProvider } from "../config/providers/registry/chatgpt-web/index.ts";
import { buildToolAwareResult, prepareToolMessages } from "../translator/webTools.ts";
import {
  executeChatGptWebCleanRoom,
  type ChatGptWebExecutorAdapterDeps,
} from "../utils/chatgptWebExecutorAdapter.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { makeExecutorErrorResult, sanitizeErrorMessage } from "../utils/error.ts";
import { BaseExecutor, type ExecuteInput } from "./base.ts";

const CHATGPT_WEB_URL = "https://chatgpt.com";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

export function chatGptWebAccountPluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.CHATGPT_WEB_ACCOUNT_PLUGINS?.trim() ?? "");
}

export function userRequestRequiresClientTool(
  messages: Array<{ role: string; content: unknown }>
): boolean {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const userText = contentText(lastUser?.content).toLowerCase();
  if (!userText.trim()) return false;

  // Avoid turning plain how-to/explanatory questions into unintended local actions.
  if (/\b(?:como\s+(?:fa[çc]o|fazer)|how\s+to|o\s+que\s+[ée]|what\s+is)\b/i.test(userText)) {
    return false;
  }

  return /\b(?:arquivo|arquivos|file|files|pasta|pastas|folder|folders|terminal|shell|comando|command|git|repo|mcp|pc|computer|config|configura(?:ç|c)[aã]o|crie|criar|create|edite|editar|edit|execute|executar|rode|run|verifique|check|leia|ler|read|liste|listar|list|abra|open|busque|buscar|search|procure|procurar|inspect|inspecione|veja|look|apaga(?:r|do|dos)?|apague|exclua|excluir|remove|remova|remover|delete|deleted?)\b/i.test(
    userText
  );
}

export function shouldRepairMissingToolCall(
  assistantText: string,
  messages: Array<{ role: string; content: unknown }>
): boolean {
  const reply = assistantText.toLowerCase();

  const actionableRequest = userRequestRequiresClientTool(messages);
  if (!actionableRequest) return false;

  const deferredOrUnavailable =
    /\b(?:vou|irei|deixa eu|deixe-me|vamos)\s+(?:pegar|ver|verificar|checar|olhar|inspecionar|ler|listar|executar|rodar|criar|editar|alterar|abrir|buscar|procurar|consultar|usar|acessar|apagar|excluir|remover)\b|\b(?:i(?:'|’)ll|i will|let me|i(?:'|’)m going to|i am going to)\s+(?:check|inspect|read|list|run|execute|create|edit|open|search|look|fetch|use|access|delete|remove)\b|\b(?:n[aã]o tenho acesso|n[aã]o consigo acessar|can(?:not|'t) access|do not have access|don't have access)\b/i.test(
      reply
    );

  const claimedCompletion =
    /\b(?:apag(?:ado|ados|ada|adas)|exclu[ií]d(?:o|os|a|as)|removid(?:o|os|a|as)|deletei|apaguei|removi|feito|conclu[ií]do|pronto|done|deleted|removed|completed)\b/i.test(
      reply
    );

  return deferredOrUnavailable || claimedCompletion;
}

async function assistantTextFromBufferedResponse(response: Response): Promise<string> {
  if (!response.ok) return "";
  try {
    const json = (await response.clone().json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return typeof json.choices?.[0]?.message?.content === "string"
      ? json.choices[0].message.content
      : "";
  } catch {
    return "";
  }
}

function statusForAdapterError(message: string): number {
  if (/storage state|credentials|connection ID/i.test(message)) return 401;
  // Preserve upstream quota semantics so the shared account-fallback loop can exclude a
  // depleted Free session and immediately try the next configured ChatGPT Web account.
  if (
    /(?:\bHTTP[_\s-]*429\b|\bstatus\s+429\b|\brate[-_\s]?limit(?:ed)?\b|\bquota\s+(?:exhausted|reached|exceeded)\b|\b(?:image(?:\s+upload)?|upload|usage)\s+limit\s+(?:reached|exceeded)\b|\breached\s+(?:your\s+)?(?:image(?:\s+upload)?|upload|usage)\s+limit\b)/i.test(
      message
    )
  ) {
    return 429;
  }
  if (/request|messages|prompt|model|tools|text content|reasoning effort/i.test(message))
    return 400;
  return 502;
}

/** Common ChatGPT Web executor rebuilt solely from first-party UI/network observations. */
export class ChatGptWebExecutor extends BaseExecutor {
  constructor(private readonly deps: ChatGptWebExecutorAdapterDeps = {}) {
    super("chatgpt-web", {
      id: chatgpt_webProvider.id,
      baseUrl: chatgpt_webProvider.baseUrl,
    });
  }

  async execute(input: ExecuteInput) {
    try {
      const body =
        input.body && typeof input.body === "object" && !Array.isArray(input.body)
          ? (input.body as Record<string, unknown>)
          : null;
      const messages =
        body && Array.isArray(body.messages)
          ? (body.messages as Array<{ role: string; content: unknown }>)
          : [];
      const accountPluginMode =
        Boolean(body) &&
        chatGptWebAccountPluginsEnabled() &&
        userRequestRequiresClientTool(messages);

      if (body && accountPluginMode) {
        const {
          tools: _tools,
          tool_choice: _toolChoice,
          parallel_tool_calls: _parallelToolCalls,
          ...bodyWithoutClientTools
        } = body;
        return await executeChatGptWebCleanRoom(
          {
            ...input,
            body: {
              ...bodyWithoutClientTools,
              __omniroute_chatgpt_web_account_plugins: true,
            },
          },
          this.deps
        );
      }

      const toolPrep = body ? prepareToolMessages(body, messages) : null;

      if (toolPrep?.hasTools) {
        const {
          tools: _tools,
          tool_choice: _toolChoice,
          parallel_tool_calls: _parallelToolCalls,
          ...bodyWithoutNativeTools
        } = body!;
        let buffered = await executeChatGptWebCleanRoom(
          {
            ...input,
            stream: false,
            body: {
              ...bodyWithoutNativeTools,
              messages: toolPrep.effectiveMessages,
            },
          },
          this.deps
        );

        // Web models sometimes acknowledge a local action in prose without emitting
        // the client-tool envelope. One retry was not enough in real Claude Code
        // sessions: the model could repeat the false "done" claim a second time.
        // For actionable local/external requests, allow up to three strict repairs,
        // but never execute anything unless a real requested tool call is parsed.
        if (buffered.ok && userRequestRequiresClientTool(messages)) {
          let repairHistory = [...toolPrep.effectiveMessages];
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const text = await assistantTextFromBufferedResponse(buffered);
            const parsed = buildToolAwareResult(text, toolPrep.requestedTools, "cgpt");
            if (parsed.toolCalls) break;
            if (!shouldRepairMissingToolCall(text, messages) && attempt === 1) {
              // The user asked for an action, so a plain prose response is still not
              // sufficient even when it avoids explicit "done" wording.
            }

            input.log?.warn?.(
              "CHATGPT-WEB",
              `Actionable client request returned no tool call; strict repair ${attempt}/3`
            );
            repairHistory = [
              ...repairHistory,
              { role: "assistant", content: text },
              {
                role: "user",
                content:
                  "[Client tool repair: this request requires a real client-side tool call. " +
                  "Do not claim success, do not explain, and do not return prose. Return exactly one " +
                  "<tool>{...}</tool> block for the NEXT required action using a tool listed in the " +
                  "client-tool contract and the exact _nonce shown there. For filesystem changes, " +
                  "listing, reading, creating, deleting, editing, or terminal work, use the matching " +
                  "filesystem/shell tool. No prose before or after the tool block.]",
              },
            ];
            buffered = await executeChatGptWebCleanRoom(
              {
                ...input,
                stream: false,
                body: {
                  ...bodyWithoutNativeTools,
                  messages: repairHistory,
                },
              },
              this.deps
            );
            if (!buffered.ok) break;
          }
        }

        return await buildToolModeResponse(buffered, toolPrep.requestedTools, input.stream, {
          cid: `chatcmpl-${randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model: input.model,
          idSeed: "cgpt",
        });
      }

      return await executeChatGptWebCleanRoom(input, this.deps);
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      const toolsUnsupported = /tools? (?:are|is) not supported/i.test(message);
      return makeExecutorErrorResult(
        statusForAdapterError(message),
        toolsUnsupported
          ? "Tools are not supported by the selected model."
          : message || "ChatGPT Web browser execution failed",
        input.body,
        CHATGPT_WEB_URL,
        undefined,
        toolsUnsupported
          ? { type: "invalid_request_error", code: "tools_not_supported" }
          : undefined
      );
    }
  }
}

export default ChatGptWebExecutor;
