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

export function shouldRepairMissingToolCall(
  assistantText: string,
  messages: Array<{ role: string; content: unknown }>
): boolean {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const userText = contentText(lastUser?.content).toLowerCase();
  const reply = assistantText.toLowerCase();

  const actionableRequest =
    /\b(?:arquivo|file|pasta|folder|terminal|shell|comando|command|git|repo|mcp|pc|computer|config|configura(?:ç|c)[aã]o|crie|create|edite|edit|execute|run|verifique|check|leia|read|liste|list|abra|open|busque|search|procure|inspect|veja|look|apaga(?:r|do|dos)?|apague|exclua|excluir|remove|remova|remover|delete|deleted?)\b/i.test(
      userText
    );
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

        const firstText = await assistantTextFromBufferedResponse(buffered);
        const firstParsed = buildToolAwareResult(firstText, toolPrep.requestedTools, "cgpt");
        if (
          buffered.ok &&
          !firstParsed.toolCalls &&
          shouldRepairMissingToolCall(firstText, messages)
        ) {
          input.log?.warn?.(
            "CHATGPT-WEB",
            "Agent described a client-side action without invoking a tool; retrying once with a strict tool-call repair"
          );
          const repairMessages = [
            ...toolPrep.effectiveMessages,
            { role: "assistant", content: firstText },
            {
              role: "user",
              content:
                "[Client tool repair: your previous reply described an action but did not invoke the available client tool. " +
                "Do not repeat the prose. Return exactly one <tool>{...}</tool> block for the next required action, " +
                "using a tool listed in the client-tool contract and the exact _nonce shown there. No prose before or after the tool block.]",
            },
          ];
          buffered = await executeChatGptWebCleanRoom(
            {
              ...input,
              stream: false,
              body: {
                ...bodyWithoutNativeTools,
                messages: repairMessages,
              },
            },
            this.deps
          );
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
