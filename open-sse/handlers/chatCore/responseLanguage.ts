const RESPONSE_LANGUAGE_DIRECTIVE =
  "Language policy: Reply in the same language as the user's latest message, unless the user explicitly asks for a different language.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentContainsDirective(content: unknown): boolean {
  if (typeof content === "string") return content.includes(RESPONSE_LANGUAGE_DIRECTIVE);
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      isRecord(part) &&
      typeof part.text === "string" &&
      part.text.includes(RESPONSE_LANGUAGE_DIRECTIVE)
  );
}

function appendDirectiveToContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return [...content, { type: "text", text: RESPONSE_LANGUAGE_DIRECTIVE }];
  }
  const existing = typeof content === "string" ? content : "";
  return existing
    ? existing + "\n\n" + RESPONSE_LANGUAGE_DIRECTIVE
    : RESPONSE_LANGUAGE_DIRECTIVE;
}

function hasUserTurn(body: Record<string, unknown>): boolean {
  if (
    Array.isArray(body.messages) &&
    body.messages.some((message) => isRecord(message) && message.role === "user")
  ) {
    return true;
  }

  if (typeof body.input === "string" && body.input.trim().length > 0) return true;
  if (Array.isArray(body.input) && body.input.length > 0) return true;

  if (Array.isArray(body.contents) && body.contents.length > 0) return true;

  return typeof body.prompt === "string" && body.prompt.trim().length > 0;
}

function alreadyInjected(body: Record<string, unknown>): boolean {
  if (contentContainsDirective(body.system)) return true;
  if (
    typeof body.instructions === "string" &&
    body.instructions.includes(RESPONSE_LANGUAGE_DIRECTIVE)
  ) {
    return true;
  }

  if (isRecord(body.systemInstruction) && Array.isArray(body.systemInstruction.parts)) {
    if (
      body.systemInstruction.parts.some(
        (part) =>
          isRecord(part) &&
          typeof part.text === "string" &&
          part.text.includes(RESPONSE_LANGUAGE_DIRECTIVE)
      )
    ) {
      return true;
    }
  }

  if (Array.isArray(body.messages)) {
    return body.messages.some(
      (message) =>
        isRecord(message) &&
        (message.role === "system" || message.role === "developer") &&
        contentContainsDirective(message.content)
    );
  }

  return false;
}

/**
 * Add a provider-agnostic response-language policy to the request.
 *
 * This deliberately does not guess a language. The model receives one stable
 * rule: follow the language of the latest user turn, unless the user explicitly
 * requests another language. The injection is idempotent and preserves the
 * native system carrier for OpenAI, Anthropic, Responses, and Gemini bodies.
 */
export function injectResponseLanguageDirective<T>(body: T): T {
  if (!isRecord(body)) return body;
  if (body._skipSystemPrompt === true) return body;
  if (!hasUserTurn(body) || alreadyInjected(body)) return body;

  const result: Record<string, unknown> = { ...body };

  // Anthropic / Claude source shape.
  if (result.system !== undefined) {
    result.system = appendDirectiveToContent(result.system);
    return Object.assign({}, body, result) as T;
  }

  // OpenAI Responses source shape.
  if (result.input !== undefined) {
    const base = typeof result.instructions === "string" ? result.instructions : "";
    result.instructions = base
      ? base + "\n\n" + RESPONSE_LANGUAGE_DIRECTIVE
      : RESPONSE_LANGUAGE_DIRECTIVE;
    return Object.assign({}, body, result) as T;
  }

  // Gemini source shape.
  if (result.contents !== undefined) {
    if (isRecord(result.systemInstruction)) {
      const parts = Array.isArray(result.systemInstruction.parts)
        ? [...result.systemInstruction.parts]
        : [];
      result.systemInstruction = {
        ...result.systemInstruction,
        role:
          typeof result.systemInstruction.role === "string"
            ? result.systemInstruction.role
            : "system",
        parts: [...parts, { text: RESPONSE_LANGUAGE_DIRECTIVE }],
      };
    } else {
      result.systemInstruction = {
        role: "system",
        parts: [{ text: RESPONSE_LANGUAGE_DIRECTIVE }],
      };
    }
    return Object.assign({}, body, result) as T;
  }

  // OpenAI-style messages[] source shape.
  if (Array.isArray(result.messages)) {
    const messages = [...result.messages];
    let systemIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (isRecord(message) && (message.role === "system" || message.role === "developer")) {
        systemIndex = i;
      }
    }

    if (systemIndex >= 0) {
      const current = messages[systemIndex];
      if (isRecord(current)) {
        messages[systemIndex] = {
          ...current,
          content: appendDirectiveToContent(current.content),
        };
      }
    } else {
      messages.unshift({ role: "system", content: RESPONSE_LANGUAGE_DIRECTIVE });
    }
    result.messages = messages;
    return Object.assign({}, body, result) as T;
  }

  return body;
}

export { RESPONSE_LANGUAGE_DIRECTIVE };
