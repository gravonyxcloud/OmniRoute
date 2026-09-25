import { chatgpt_webProvider } from "../config/providers/registry/chatgpt-web/index.ts";
import {
  executeChatGptWebCleanRoom,
  type ChatGptWebExecutorAdapterDeps,
} from "../utils/chatgptWebExecutorAdapter.ts";
import { makeExecutorErrorResult, sanitizeErrorMessage } from "../utils/error.ts";
import { BaseExecutor, type ExecuteInput } from "./base.ts";

const CHATGPT_WEB_URL = "https://chatgpt.com";

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
  if (
    /first-party|browser execution|request client|request module|challenge bridge/i.test(message)
  ) {
    return 502;
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
      return await executeChatGptWebCleanRoom(input, this.deps);
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      const toolsUnsupported = /tools? (?:are|is) not supported/i.test(message);
      const bridgeUnavailable =
        /first-party|browser execution|request client|request module|challenge bridge/i.test(
          message
        );
      return makeExecutorErrorResult(
        statusForAdapterError(message),
        toolsUnsupported
          ? "Tools are not supported by the selected model."
          : bridgeUnavailable
            ? "Provider connection is temporarily unavailable."
            : message || "ChatGPT Web browser execution failed",
        input.body,
        CHATGPT_WEB_URL,
        undefined,
        toolsUnsupported
          ? { type: "invalid_request_error", code: "tools_not_supported" }
          : bridgeUnavailable
            ? { type: "provider_error", code: "provider_connection_unavailable" }
            : undefined
      );
    }
  }
}

export default ChatGptWebExecutor;
