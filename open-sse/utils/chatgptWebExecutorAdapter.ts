import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isRunningInContainer } from "../../src/shared/utils/containerEnv.ts";
import { acquireBrowserContext, openPage } from "../services/browserPool.ts";
import type { ExecuteInput, ProviderCredentials } from "../executors/base.ts";
import {
  extractChatGptWebAttachmentSources,
  isChatGptWebAttachmentContentPart,
  resolveChatGptWebAttachments,
  type ChatGptWebAttachmentSource,
} from "./chatgptWebAttachments.ts";
import {
  PlaywrightChatGptWebBrowserSession,
  runChatGptWebBrowserTurn,
  stripChatGptWebUiChrome,
  type ChatGptWebBrowserSession,
  type ChatGptWebBrowserTurnRequest,
  type ChatGptWebBrowserTurnResult,
  type ChatGptWebUiSelection,
} from "./chatgptWebBrowserSession.ts";

type JsonRecord = Record<string, unknown>;

const CHATGPT_WEB_PAGE_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_WEB_ACCOUNT_PLUGINS_PAGE_URL = "https://chatgpt.com/";
const CHATGPT_WEB_ACCOUNT_PLUGINS_HINT =
  "[Account plugin mode: use installed ChatGPT plugins/apps for real external actions. " +
  "For filesystem or terminal work, prefer the connected Remote Desktop Commander app. " +
  "Do not merely describe commands and do not claim success unless the plugin result confirms it.]";
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const CHATGPT_WEB_SAFE_PROMPT_BYTES = 320 * 1024;
const CHATGPT_WEB_PROMPT_HEAD_BYTES = 48 * 1024;
const CHATGPT_WEB_COMPACTION_MARKER =
  "\n\n[Earlier conversation context was compacted by OmniRoute to fit the ChatGPT Web context window.]\n\n";
const FIRST_PARTY_COOKIE_HOSTS = ["chatgpt.com", "openai.com"] as const;

export interface ChatGptWebStorageCookie extends JsonRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface ChatGptWebStorageOrigin extends JsonRecord {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface ChatGptWebStorageState {
  cookies: ChatGptWebStorageCookie[];
  origins: ChatGptWebStorageOrigin[];
}

export interface PreparedChatGptWebBrowserRequest {
  prompt: string;
  selection: ChatGptWebUiSelection;
  attachments: ChatGptWebAttachmentSource[];
}

export interface ChatGptWebSessionFactoryInput {
  connectionId: string;
  storageState: ChatGptWebStorageState;
  selection: ChatGptWebUiSelection;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  chromeExecutablePath?: string;
  pageUrl?: string;
  forceComposer?: boolean;
}

export interface ChatGptWebExecutorAdapterDeps {
  createSession?: (input: ChatGptWebSessionFactoryInput) => Promise<ChatGptWebBrowserSession>;
  runTurn?: (
    session: ChatGptWebBrowserSession,
    request: ChatGptWebBrowserTurnRequest
  ) => Promise<ChatGptWebBrowserTurnResult>;
  id?: () => string;
  now?: () => number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFirstPartyHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\./, "");
  return FIRST_PARTY_COOKIE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

const SAME_SITE_NORMALIZATIONS: Record<string, ChatGptWebStorageCookie["sameSite"]> = {
  lax: "Lax",
  strict: "Strict",
  none: "None",
  no_restriction: "None",
  "no-restriction": "None",
  unspecified: "Lax",
  undefined: "Lax",
};

function normalizeSameSite(value: unknown): ChatGptWebStorageCookie["sameSite"] {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAME_SITE_NORMALIZATIONS[key] ?? "Lax";
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function normalizeCookie(value: unknown): ChatGptWebStorageCookie {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) {
    throw new Error("ChatGPT Web browser storage state contains an invalid cookie");
  }

  // A Chrome-extension / CDP cookie export is the common source for these states.
  // Its `expires` field may be absent (session cookie) or spelled `expirationDate`,
  // sameSite may be lowercase or CDP-flavored ("no_restriction"/"unspecified"), and
  // host-only session cookies sometimes ship without `path` or `domain`. Any single
  // variation previously rejected the WHOLE export — intermittent "invalid cookie"
  // failures. Normalize tolerantly but keep the first-party domain boundary hard.
  const domain =
    typeof value.domain === "string" && value.domain.trim() ? value.domain.trim() : ".chatgpt.com";
  if (!isFirstPartyHost(domain)) {
    throw new Error("ChatGPT Web browser storage state contains a foreign cookie domain");
  }

  const cookieValue = typeof value.value === "string" ? value.value : String(value.value ?? "");
  const path = typeof value.path === "string" && value.path.startsWith("/") ? value.path : "/";

  const rawExpires =
    typeof value.expires === "number"
      ? value.expires
      : typeof value.expirationDate === "number"
        ? value.expirationDate
        : typeof value.expires === "string" && value.expires.trim() !== ""
          ? Number(value.expires)
          : -1;
  const expires = Number.isFinite(rawExpires) ? rawExpires : -1;

  return {
    name: value.name,
    value: cookieValue,
    domain,
    path,
    expires,
    httpOnly: toBoolean(value.httpOnly),
    secure: toBoolean(value.secure),
    sameSite: normalizeSameSite(value.sameSite),
  };
}

function normalizeOrigin(value: unknown): ChatGptWebStorageOrigin {
  const originText =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.origin === "string"
        ? value.origin
        : "";

  let url: URL | null = null;
  try {
    url = originText ? new URL(originText) : null;
  } catch {
    url = null;
  }

  // A parseable first-party origin is kept as-is; something missing or unparseable
  // collapses to the canonical chatgpt.com origin so a partial export does not kill
  // the whole state. A *parseable* foreign origin is rejected — the first-party
  // boundary is the same security rule cookies already enforce.
  let origin: string;
  if (url !== null) {
    if (url.protocol !== "https:" || !isFirstPartyHost(url.hostname)) {
      throw new Error("ChatGPT Web browser storage state contains a foreign origin");
    }
    origin = url.origin;
  } else {
    origin = "https://chatgpt.com";
  }

  const rawStorage = isRecord(value) && Array.isArray(value.localStorage) ? value.localStorage : [];
  const localStorage = rawStorage.map((entry) => {
    const name = isRecord(entry) && typeof entry.name === "string" ? entry.name : "";
    const entryValue = isRecord(entry)
      ? typeof entry.value === "string"
        ? entry.value
        : String(entry.value ?? "")
      : "";
    return { name, value: entryValue };
  });

  return { origin, localStorage };
}

export function normalizeChatGptWebStorageState(value: unknown): ChatGptWebStorageState {
  if (!isRecord(value) || !Array.isArray(value.cookies)) {
    throw new Error("ChatGPT Web browser storage state is invalid");
  }
  const cookies = value.cookies.map(normalizeCookie);

  // Playwright exports always include `origins`; Chrome-extension cookie exports do
  // not. Tolerate the missing key when there ARE cookies (default to chatgpt.com),
  // but keep rejecting an empty cookie-less state as malformed.
  const origins = Array.isArray(value.origins)
    ? value.origins.map(normalizeOrigin)
    : cookies.length > 0
      ? [{ origin: "https://chatgpt.com", localStorage: [] }]
      : (() => {
          throw new Error("ChatGPT Web browser storage state is invalid");
        })();

  return { cookies, origins };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

function utf8Suffix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(value.length - mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(value.length - low);
}

export function compactChatGptWebPrompt(prompt: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(prompt).byteLength <= CHATGPT_WEB_SAFE_PROMPT_BYTES) return prompt;

  const head = utf8Prefix(prompt, CHATGPT_WEB_PROMPT_HEAD_BYTES);
  const markerBytes = encoder.encode(CHATGPT_WEB_COMPACTION_MARKER).byteLength;
  const tailBudget = Math.max(
    0,
    CHATGPT_WEB_SAFE_PROMPT_BYTES - encoder.encode(head).byteLength - markerBytes
  );
  const tail = utf8Suffix(prompt, tailBudget);
  return head + CHATGPT_WEB_COMPACTION_MARKER + tail;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new Error("ChatGPT Web clean-room adapter supports text content only");
  }
  const parts: string[] = [];
  for (const part of value) {
    if (
      isRecord(part) &&
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
      continue;
    }
    if (isRecord(part) && (part.type === "thinking" || part.type === "redacted_thinking")) {
      // Never replay prior private reasoning into the browser prompt. Claude-compatible
      // clients legitimately send thinking blocks back on subsequent agent turns.
      continue;
    }
    if (isRecord(part) && part.type === "tool_use") {
      const name = typeof part.name === "string" && part.name.trim() ? part.name.trim() : "tool";
      const input =
        typeof part.input === "string"
          ? part.input
          : part.input === undefined
            ? "{}"
            : JSON.stringify(part.input);
      parts.push(`Requested tool ${name}: ${input}`);
      continue;
    }
    if (isRecord(part) && part.type === "tool_result") {
      const toolUseId =
        typeof part.tool_use_id === "string" && part.tool_use_id.trim()
          ? ` ${part.tool_use_id.trim()}`
          : "";
      const resultText =
        typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? contentText(part.content)
            : part.content === undefined
              ? ""
              : JSON.stringify(part.content);
      parts.push(`Tool result${toolUseId}: ${resultText}`);
      continue;
    }
    if (isChatGptWebAttachmentContentPart(part)) continue;
    throw new Error("ChatGPT Web clean-room adapter received unsupported content");
  }
  return parts.join("\n");
}

function toolDefinitionsText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const lines: string[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const description =
      typeof fn.description === "string" ? fn.description.replace(/\s+/g, " ").trim() : "";
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`);
  }
  if (lines.length === 0) return "";
  return [
    "Client tools available in the calling application (reference-only for this web transport):",
    ...lines,
    "Do not claim a tool was executed unless its result is present in the conversation.",
  ].join("\n");
}

function assistantToolCallsText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const calls: string[] = [];
  for (const call of value) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : call;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const args =
      typeof fn.arguments === "string"
        ? fn.arguments
        : fn.arguments === undefined
          ? ""
          : JSON.stringify(fn.arguments);
    calls.push(args ? `${name}(${args})` : name);
  }
  return calls.length ? `\nRequested tools: ${calls.join(", ")}` : "";
}

function buildPrompt(body: JsonRecord): string {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("ChatGPT Web clean-room adapter requires messages");
  }
  const messages = body.messages.map((value) => {
    if (!isRecord(value) || typeof value.role !== "string") {
      throw new Error("ChatGPT Web clean-room adapter received an invalid message");
    }
    if (!["system", "developer", "user", "assistant", "tool"].includes(value.role)) {
      throw new Error("ChatGPT Web clean-room adapter received an unsupported message role");
    }
    const assistantHasToolCalls =
      value.role === "assistant" && Array.isArray(value.tool_calls) && value.tool_calls.length > 0;
    let text =
      value.content == null && assistantHasToolCalls ? "" : contentText(value.content);
    if (value.role === "assistant") text += assistantToolCallsText(value.tool_calls);
    if (value.role === "tool") {
      const toolName = typeof value.name === "string" && value.name.trim() ? ` ${value.name.trim()}` : "";
      text = `Tool result${toolName}: ${text}`;
    }
    return { role: value.role, text };
  });

  const basePrompt =
    messages.length === 1 && messages[0].role === "user"
      ? messages[0].text
      : messages
          .map(({ role, text }) => `${role[0].toUpperCase()}${role.slice(1)}:\n${text}`)
          .join("\n\n");
  const toolContext = toolDefinitionsText(body.tools);
  const responseLanguagePolicy =
    "LANGUAGE POLICY: Reply to the user in the same natural language as the latest user message unless the user explicitly requests another language. Do not switch languages based on tool names, system text, code, file names, or prior messages. Keep commands, code, paths, identifiers, and tool names unchanged.";
  const promptBaseWithLanguagePolicy = toolContext
    ? `${basePrompt}\n\n${toolContext}`
    : basePrompt;
  const prompt = `${promptBaseWithLanguagePolicy}\n\n${responseLanguagePolicy}`;
  if (!prompt.trim()) throw new Error("ChatGPT Web clean-room adapter requires non-empty text");
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) {
    // Do not reject large agent sessions outright. The browser transport has a
    // smaller practical context ceiling than OmniRoute combos, so compact the
    // serialized conversation while preserving the system head and recent tail.
  }
  return compactChatGptWebPrompt(prompt);
}

function reasoningEffort(body: JsonRecord): string | null {
  if (typeof body.reasoning_effort === "string") return body.reasoning_effort.toLowerCase();
  if (isRecord(body.reasoning) && typeof body.reasoning.effort === "string") {
    return body.reasoning.effort.toLowerCase();
  }
  return null;
}

function effortIndex(effort: string | null): 0 | 1 | 2 | 3 {
  if (effort === null || effort === "medium") return 1;
  if (["none", "off", "minimal", "low"].includes(effort)) return 0;
  if (effort === "high") return 2;
  if (effort === "xhigh" || effort === "max") return 3;
  throw new Error(`ChatGPT Web clean-room adapter does not support reasoning effort ${effort}`);
}

function normalizedModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^chatgpt-web\//, "")
    .replace(/^cgpt-web\//, "")
    .replace(/\./g, "-");
}

function currentSolUiLabel(index: 0 | 1 | 2 | 3 | 4) {
  return (["Instant", "Medium", "High", "Extra High", "Pro"] as const)[index];
}

function solSelection(index: 0 | 1 | 2 | 3 | 4): ChatGptWebUiSelection {
  return {
    kind: "picker",
    modelLabel: "GPT-5.6 Sol",
    effortIndex: index,
    fixedModel: true,
    uiLabel: currentSolUiLabel(index),
    allowEffortControlFallback: true,
  };
}

function resolveSelection(model: string, body: JsonRecord): ChatGptWebUiSelection {
  const normalized = normalizedModel(model);
  if (normalized === "gpt-6-pro" || normalized === "gpt-6-astra") {
    return {
      kind: "picker",
      modelLabel: "GPT-6 Pro",
      effortIndex: 0,
      fixedModel: true,
      uiLabel: "GPT-6 Pro",
    };
  }
  if (normalized === "gpt-6-1-sol") {
    return {
      kind: "picker",
      modelLabel: "GPT-6.1 Sol",
      effortIndex: effortIndex(reasoningEffort(body)),
      fixedModel: true,
    };
  }
  if (normalized === "gpt-6-sol") {
    return {
      kind: "picker",
      modelLabel: "GPT-6 Sol",
      effortIndex: effortIndex(reasoningEffort(body)),
      fixedModel: true,
    };
  }
  if (normalized === "gpt-6-luna") {
    return {
      kind: "picker",
      modelLabel: "GPT-6 Luna",
      effortIndex: effortIndex(reasoningEffort(body)),
      fixedModel: true,
    };
  }
  if (normalized === "gpt-5-6-luna-free") {
    return { kind: "free", thinkEnabled: false };
  }
  if (normalized === "gpt-5-6-luna-free-thinking") {
    return { kind: "free", thinkEnabled: true };
  }
  if (normalized === "gpt-5-6-pro") {
    return solSelection(4);
  }
  if (normalized === "gpt-5-6-instant" || normalized === "gpt-5-6") {
    return solSelection(0);
  }
  if (["gpt-5-6-thinking", "gpt-5-6-sol"].includes(normalized)) {
    return solSelection(effortIndex(reasoningEffort(body)));
  }
  if (normalized === "gpt-5-5-pro") {
    return { kind: "picker", modelLabel: "GPT-5.5", effortIndex: 4 };
  }
  if (normalized === "gpt-5-5-instant") {
    return { kind: "picker", modelLabel: "GPT-5.5", effortIndex: 0 };
  }
  if (["gpt-5-5", "gpt-5-5-thinking"].includes(normalized)) {
    return {
      kind: "picker",
      modelLabel: "GPT-5.5",
      effortIndex: effortIndex(reasoningEffort(body)),
    };
  }
  throw new Error(`ChatGPT Web clean-room adapter received an unsupported model: ${model}`);
}

export function prepareChatGptWebBrowserRequest(
  model: string,
  body: unknown
): PreparedChatGptWebBrowserRequest {
  if (!isRecord(body)) throw new Error("ChatGPT Web clean-room adapter requires an object body");
  const prompt = buildPrompt(body);
  const attachments = extractChatGptWebAttachmentSources(
    body.messages as Array<{ role?: string; content?: unknown }>
  );
  return { prompt, selection: resolveSelection(model, body), attachments };
}

function readStorageState(credentials: ProviderCredentials): ChatGptWebStorageState {
  const providerData = credentials.providerSpecificData;
  const raw = providerData?.storageState ?? credentials.apiKey;
  if (typeof raw === "string") {
    try {
      return normalizeChatGptWebStorageState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("ChatGPT Web browser storage state JSON is invalid");
      }
      throw error;
    }
  }
  return normalizeChatGptWebStorageState(raw);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveChatGptWebChromeExecutable(
  explicit?: string,
  deps: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  } = {}
): string | undefined {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const candidates = [
    explicit,
    env.CHATGPT_WEB_CHROME_PATH,
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...(env.PROGRAMFILES
      ? [join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")]
      : []),
    ...(env["PROGRAMFILES(X86)"]
      ? [join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")]
      : []),
    ...(env.LOCALAPPDATA
      ? [join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")]
      : []),
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate?.trim() && exists(candidate.trim()))
  );
}

/**
 * ChatGPT Web is more reliable when Chromium runs headed. The runner-web image
 * provides a virtual X display via Xvfb, so containers with DISPLAY available
 * should use headed Chromium too. Fall back to headless only when no display is
 * available (for example, custom/minimal container images).
 */
export function shouldUseHeadlessChatGptWebBrowser(
  runningInContainer = isRunningInContainer(),
  display = process.env.DISPLAY
): boolean {
  if (!runningInContainer) return false;
  return !display?.trim();
}

async function createDefaultSession(
  input: ChatGptWebSessionFactoryInput
): Promise<ChatGptWebBrowserSession> {
  const digest = createHash("sha256")
    .update(input.connectionId)
    .update("\0")
    .update(JSON.stringify(input.storageState))
    .digest("hex");
  const pooled = await acquireBrowserContext(`chatgpt-web-cleanroom:${digest}`, {
    cookieDomain: "chatgpt.com",
    storageState: input.storageState,
    userAgent: input.userAgent,
    locale: input.locale,
    timezone: input.timezone,
    proxyProviderKey: "chatgpt-web",
    // ChatGPT Web/Cloudflare ties browser challenges to egress reputation.
    // A configured SOCKS/HTTP proxy can strand the browser on "Just a moment..."
    // and make every model time out. Keep this browser-backed provider on direct
    // egress; other providers continue to honor their normal proxy settings.
    disableProxy: true,
    warmupUrl: input.pageUrl ?? CHATGPT_WEB_PAGE_URL,
    headless: shouldUseHeadlessChatGptWebBrowser(),
    executablePath: input.chromeExecutablePath,
  });
  const page =
    pooled.warmupPage && !pooled.warmupPage.isClosed() ? pooled.warmupPage : await openPage(pooled);
  if (pooled.warmupPage !== page) pooled.warmupPage = page;
  return new PlaywrightChatGptWebBrowserSession(page, {
    pageUrl: input.pageUrl ?? CHATGPT_WEB_PAGE_URL,
    selection: input.selection,
    closePageOnCleanup: false,
    forceComposer: input.forceComposer === true,
  });
}

function chatGptWebReasoningNotice(model: string): string {
  const normalized = normalizedModel(model);
  const reasoningMode =
    normalized.includes("thinking") ||
    normalized.includes("pro") ||
    normalized.includes("astra") ||
    normalized.includes("sol") ||
    normalized.includes("gpt-6");
  return reasoningMode
    ? "Reasoning enabled via ChatGPT Web. The upstream private reasoning trace is not exposed."
    : "";
}

export function buildChatGptWebOpenAiResponse(
  model: string,
  result: ChatGptWebBrowserTurnResult,
  stream: boolean,
  metadata: { id?: string; created?: number; prompt?: string } = {}
): Response {
  const id = metadata.id ?? `chatcmpl-${randomUUID()}`;
  const created = metadata.created ?? Math.floor(Date.now() / 1000);
  const outputText = stripChatGptWebUiChrome(result.text);
  // The first-party browser flow does not expose token receipts. Emit a clear
  // OpenAI-compatible estimate so proxy accounting and clients such as n8n do
  // not record a successful request as zero usage.
  const promptTokens = metadata.prompt ? Math.max(1, Math.ceil(metadata.prompt.length / 4)) : 0;
  const completionTokens = outputText ? Math.max(1, Math.ceil(outputText.length / 4)) : 0;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true,
  };
  const reasoningContent = chatGptWebReasoningNotice(model);
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: outputText,
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  }

  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    ...(reasoningContent
      ? [
          {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              { index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null },
            ],
          },
        ]
      : []),
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: outputText }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage,
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
  );
}

export async function executeChatGptWebCleanRoom(
  input: Pick<ExecuteInput, "model" | "body" | "stream" | "credentials" | "signal">,
  deps: ChatGptWebExecutorAdapterDeps = {}
): Promise<Response> {
  const prepared = prepareChatGptWebBrowserRequest(input.model, input.body);
  const bodyRecord = isRecord(input.body) ? input.body : {};
  const accountPluginMode = bodyRecord.__omniroute_chatgpt_web_account_plugins === true;
  const prompt = accountPluginMode
    ? `${prepared.prompt}\n\n${CHATGPT_WEB_ACCOUNT_PLUGINS_HINT}`
    : prepared.prompt;
  const attachments = await resolveChatGptWebAttachments(prepared.attachments);
  const storageState = readStorageState(input.credentials);
  const connectionId = optionalString(input.credentials.connectionId);
  if (!connectionId) throw new Error("ChatGPT Web clean-room adapter requires a connection ID");
  const providerData = input.credentials.providerSpecificData;
  const session = await (deps.createSession ?? createDefaultSession)({
    connectionId,
    storageState,
    selection: prepared.selection,
    userAgent: optionalString(providerData?.customUserAgent),
    locale: optionalString(providerData?.locale),
    timezone: optionalString(providerData?.timezone),
    chromeExecutablePath: resolveChatGptWebChromeExecutable(
      optionalString(providerData?.chromeExecutablePath)
    ),
    pageUrl: accountPluginMode ? CHATGPT_WEB_ACCOUNT_PLUGINS_PAGE_URL : CHATGPT_WEB_PAGE_URL,
    forceComposer: accountPluginMode,
  });
  const result = await (deps.runTurn ?? runChatGptWebBrowserTurn)(session, {
    prompt,
    attachments,
    signal: input.signal,
  });
  return buildChatGptWebOpenAiResponse(input.model, result, input.stream, {
    id: deps.id?.(),
    created: deps.now ? Math.floor(deps.now() / 1000) : undefined,
    prompt,
  });
}
