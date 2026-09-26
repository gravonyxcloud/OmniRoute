import { Buffer } from "node:buffer";

import type { ChatGptWebResolvedAttachment } from "./chatgptWebAttachments.ts";
import {
  executeChatGptWebFirstPartyTurn,
  type ChatGptWebFirstPartyRequest,
  type ChatGptWebUiSelection,
} from "./chatgptWebFirstParty.ts";
import { ChatGptWebDeltaV1Decoder, parseChatGptWebEncodedItem } from "./chatgptWebDeltaV1.ts";
import {
  ChatGptWebTopicStream,
  parseChatGptWebConversationHandoff,
} from "./chatgptWebTransport.ts";

type JsonRecord = Record<string, unknown>;
type Page = import("playwright").Page;

const CHATGPT_WEB_ORIGIN = "https://chatgpt.com";
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const MAX_BUFFERED_FRAMES = 2_048;
const MAX_BUFFERED_FRAME_BYTES = 16 * 1024 * 1024;

export interface ChatGptWebBrowserSessionHandlers {
  onBootstrap(sseText: string): void;
  onWebSocketFrame(frameText: string): void;
  onError(error: Error): void;
}

/**
 * Boundary owned by a logged-in first-party browser page.
 *
 * The implementation must let ChatGPT's own page execute Sentinel, Turnstile, proof-of-work,
 * cookies, and conduit preparation. Callers receive only the sanitized stream result.
 */
export interface ChatGptWebBrowserSession {
  url(): string;
  start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>>;
  submitPrompt(request: ChatGptWebBrowserSubmission): Promise<string | void>;
  readRenderedAssistantText?(timeoutMs?: number): Promise<string | null>;
}

export interface ChatGptWebBrowserSubmission {
  prompt: string;
  attachments: ChatGptWebResolvedAttachment[];
  signal?: AbortSignal | null;
}

export interface ChatGptWebBrowserTurnRequest {
  prompt: string;
  attachments?: ChatGptWebResolvedAttachment[];
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

export interface ChatGptWebBrowserTurnResult {
  conversationId: string;
  turnExchangeId: string;
  text: string;
  status: string;
  endTurn: true;
}

export type { ChatGptWebUiSelection } from "./chatgptWebFirstParty.ts";

export interface PlaywrightChatGptWebBrowserSessionOptions {
  pageUrl?: string;
  selection?: ChatGptWebUiSelection;
  closePageOnCleanup?: boolean;
  executePageRequest?: (
    page: Page,
    input: ChatGptWebFirstPartyRequest,
    options?: { signal?: AbortSignal | null }
  ) => Promise<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePrompt(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ChatGPT Web browser turn requires a non-empty prompt");
  }
  return value;
}

function requireFirstPartyUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT Web browser session requires a valid URL");
  }
  if (url.origin !== CHATGPT_WEB_ORIGIN) {
    throw new Error("ChatGPT Web browser session requires the first-party chatgpt.com origin");
  }
}

function maybeTerminalResult(
  snapshot: unknown,
  conversationId: string,
  turnExchangeId: string
): ChatGptWebBrowserTurnResult | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) return null;
  const message = snapshot.message;
  const author = isRecord(message.author) ? message.author : null;
  const content = isRecord(message.content) ? message.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  if (
    author?.role !== "assistant" ||
    content?.content_type !== "text" ||
    !parts.every((part) => typeof part === "string") ||
    message.status !== "finished_successfully" ||
    message.end_turn !== true
  ) {
    return null;
  }
  return {
    conversationId,
    turnExchangeId,
    text: parts.join(""),
    status: message.status,
    endTurn: true,
  };
}

function snapshotMessageRole(snapshot: unknown): string | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) return null;
  const author = isRecord(snapshot.message.author) ? snapshot.message.author : null;
  return typeof author?.role === "string" ? author.role : null;
}

function terminalResult(
  snapshot: unknown,
  conversationId: string,
  turnExchangeId: string
): ChatGptWebBrowserTurnResult {
  const result = maybeTerminalResult(snapshot, conversationId, turnExchangeId);
  if (result) return result;
  if (!isRecord(snapshot) || !isRecord(snapshot.message)) {
    const rootKeys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : "non-object";
    throw new Error(`ChatGPT Web assistant document is incomplete (root=${rootKeys})`);
  }
  const message = snapshot.message;
  const author = isRecord(message.author) ? message.author : null;
  const content = isRecord(message.content) ? message.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const summary = JSON.stringify({
    messageKeys: Object.keys(message).sort(),
    role: author?.role ?? null,
    contentType: content?.content_type ?? null,
    partCount: parts.length,
    partTypes: parts.map((part) => typeof part),
    status: message.status ?? null,
    endTurn: message.end_turn ?? null,
  });
  throw new Error(`ChatGPT Web assistant document is incomplete (${summary})`);
}

function encodeParsedEvent(event: ReturnType<typeof parseChatGptWebEncodedItem>[number]): string {
  const eventLine = event.event === "message" ? "" : `event: ${event.event}\n`;
  return `${eventLine}data: ${event.data}\n\n`;
}

/** Decode the direct first-party `/f/conversation` SSE body. */
export function parseChatGptWebDirectConversation(sseText: string): ChatGptWebBrowserTurnResult {
  if (typeof sseText !== "string" || !sseText.trim()) {
    throw new Error("ChatGPT Web direct conversation returned an empty stream");
  }
  let decoder = new ChatGptWebDeltaV1Decoder();
  let conversationId = "";
  let turnExchangeId = "";
  let latestTerminal: ChatGptWebBrowserTurnResult | null = null;
  for (const event of parseChatGptWebEncodedItem(sseText)) {
    if (isRecord(event.json)) {
      if (typeof event.json.conversation_id === "string") {
        conversationId = event.json.conversation_id;
      }
      if (typeof event.json.turn_exchange_id === "string") {
        turnExchangeId = event.json.turn_exchange_id;
      }
    }
    if (event.event === "delta_encoding") {
      latestTerminal =
        maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
      decoder = new ChatGptWebDeltaV1Decoder();
    }
    decoder.ingest(encodeParsedEvent(event));
    latestTerminal =
      maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
  }
  const result =
    maybeTerminalResult(decoder.snapshot(), conversationId, turnExchangeId) ?? latestTerminal;
  if (!result) return terminalResult(decoder.snapshot(), conversationId, turnExchangeId);
  return { ...result, conversationId, turnExchangeId };
}

function turnError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

class ChatGptWebBrowserTurnRunner {
  private decoder = new ChatGptWebDeltaV1Decoder();
  private readonly bufferedFrames: string[] = [];
  private bufferedFrameBytes = 0;
  private topicStream: ChatGptWebTopicStream | null = null;
  private conversationId = "";
  private turnExchangeId = "";
  private latestTerminalAssistant: ChatGptWebBrowserTurnResult | null = null;
  private renderedReadPending = false;
  private settled = false;
  private readonly turnController = new AbortController();
  private readonly resultPromise: Promise<ChatGptWebBrowserTurnResult>;
  private resolveResult: (result: ChatGptWebBrowserTurnResult) => void = () => {};
  private rejectResult: (error: Error) => void = () => {};

  constructor(
    private readonly session: ChatGptWebBrowserSession,
    private readonly prompt: string,
    private readonly attachments: ChatGptWebResolvedAttachment[]
  ) {
    this.resultPromise = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Browser events can finish while Playwright is still resolving submission.
    void this.resultPromise.catch(() => {});
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.turnController.abort();
    this.rejectResult(error);
  }

  private complete(): void {
    if (this.settled) return;
    try {
      const result =
        this.latestTerminalAssistant ??
        terminalResult(this.decoder.snapshot(), this.conversationId, this.turnExchangeId);
      this.settled = true;
      this.resolveResult(result);
    } catch (error) {
      this.fail(turnError(error, "ChatGPT Web browser turn failed"));
    }
  }

  private completeFromRenderedAssistant(timeoutMs = 120_000): void {
    if (this.renderedReadPending || !this.session.readRenderedAssistantText) return;
    this.renderedReadPending = true;
    void this.session
      .readRenderedAssistantText(timeoutMs)
      .then((text) => this.acceptRenderedAssistant(text))
      .catch(() => {
        this.renderedReadPending = false;
      });
  }

  private acceptRenderedAssistant(text: string | null): void {
    this.renderedReadPending = false;
    if (this.settled || typeof text !== "string" || !text.trim()) return;
    this.settled = true;
    this.resolveResult({
      conversationId: this.conversationId,
      turnExchangeId: this.turnExchangeId,
      text: text.trim(),
      status: "finished_successfully",
      endTurn: true,
    });
  }

  private finishFrame(): void {
    if (this.latestTerminalAssistant) {
      this.complete();
      return;
    }
    if (snapshotMessageRole(this.decoder.snapshot()) !== "tool") {
      this.complete();
      return;
    }
    this.topicStream = null;
    this.decoder = new ChatGptWebDeltaV1Decoder();
    this.completeFromRenderedAssistant();
  }

  private ingestFrame(frameText: string): void {
    if (!this.topicStream || this.settled) return;
    try {
      const frame = this.topicStream.ingestFrame(frameText);
      for (const encodedItem of frame.encodedItems) {
        if (!this.decoder.ingest(encodedItem).changed) continue;
        this.latestTerminalAssistant =
          maybeTerminalResult(this.decoder.snapshot(), this.conversationId, this.turnExchangeId) ??
          this.latestTerminalAssistant;
      }
      if (frame.done) this.finishFrame();
    } catch (error) {
      this.fail(turnError(error, "ChatGPT Web stream decoding failed"));
    }
  }

  private handleBootstrap(sseText: string): void {
    if (this.settled) return;
    if (this.topicStream) {
      this.fail(new Error("ChatGPT Web browser turn received more than one handoff"));
      return;
    }
    try {
      const handoff = parseChatGptWebConversationHandoff(sseText);
      if (this.conversationId && handoff.conversationId !== this.conversationId) {
        this.fail(new Error("ChatGPT Web browser turn changed conversation during handoff"));
        return;
      }
      this.conversationId = handoff.conversationId;
      this.turnExchangeId = handoff.turnExchangeId;
      this.decoder = new ChatGptWebDeltaV1Decoder();
      this.latestTerminalAssistant = null;
      this.topicStream = new ChatGptWebTopicStream(handoff.topicId);
      for (const frame of this.bufferedFrames.splice(0)) this.ingestFrame(frame);
      this.bufferedFrameBytes = 0;
    } catch (error) {
      this.fail(turnError(error, "ChatGPT Web handoff parsing failed"));
    }
  }

  private handleWebSocketFrame(frameText: string): void {
    if (this.settled) return;
    if (this.topicStream) {
      this.ingestFrame(frameText);
      return;
    }
    this.bufferedFrameBytes += Buffer.byteLength(frameText);
    if (
      this.bufferedFrames.length >= MAX_BUFFERED_FRAMES ||
      this.bufferedFrameBytes > MAX_BUFFERED_FRAME_BYTES
    ) {
      this.fail(new Error("ChatGPT Web browser turn exceeded the pre-handoff frame buffer"));
      return;
    }
    this.bufferedFrames.push(frameText);
  }

  private handlers(): ChatGptWebBrowserSessionHandlers {
    return {
      onBootstrap: (sseText) => this.handleBootstrap(sseText),
      onWebSocketFrame: (frameText) => this.handleWebSocketFrame(frameText),
      onError: () => this.fail(new Error("ChatGPT Web first-party browser session failed")),
    };
  }

  private submitPrompt(): void {
    void this.session
      .submitPrompt({
        prompt: this.prompt,
        attachments: this.attachments,
        signal: this.turnController.signal,
      })
      .then((directResponse) => {
        if (this.settled) return;
        if (typeof directResponse === "string") {
          this.settled = true;
          this.resolveResult(parseChatGptWebDirectConversation(directResponse));
          return;
        }
        this.completeFromRenderedAssistant();
      })
      .catch((error: unknown) => {
        this.fail(turnError(error, "ChatGPT Web prompt submission failed"));
      });
  }

  async run(timeoutMs: number, signal?: AbortSignal | null): Promise<ChatGptWebBrowserTurnResult> {
    let cleanup: (() => Promise<void>) | null = null;
    const timeout = setTimeout(
      () => this.fail(new Error("ChatGPT Web browser turn timed out")),
      timeoutMs
    );
    const abort = (): void => this.fail(new Error("ChatGPT Web browser turn aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      cleanup = await this.session.start(this.handlers());
      if (!this.settled) this.submitPrompt();
      return await this.resultPromise;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await cleanup?.();
    }
  }
}

function shouldUseComposerFallback(error: unknown): boolean {
  const message = turnError(error, "ChatGPT Web first-party request failed").message;
  return /first-party request module|first-party module contract|first-party asset|challenge bridge|request client is unavailable/i.test(
    message
  );
}

function composerSelectionFields(
  selection: ChatGptWebUiSelection
): Record<"thinkingModel" | "thinkingEffort" | "thinkingHint", string> {
  if (selection.kind === "free") {
    return {
      thinkingModel: "",
      thinkingEffort: "",
      thinkingHint: selection.thinkEnabled ? "reason" : "",
    };
  }

  const base = selection.modelLabel === "GPT-5.6 Sol" ? "gpt-5-6" : "gpt-5-5";
  if (selection.effortIndex === 4) {
    return {
      thinkingModel: `${base}-pro`,
      thinkingEffort: "",
      thinkingHint: "",
    };
  }

  const efforts = ["zero", "standard", "extended", "xhigh"] as const;
  return {
    thinkingModel: base,
    thinkingEffort: efforts[selection.effortIndex] ?? "",
    thinkingHint: "",
  };
}

/** Run one turn while the first-party browser remains the sole challenge and auth owner. */
export async function runChatGptWebBrowserTurn(
  session: ChatGptWebBrowserSession,
  request: ChatGptWebBrowserTurnRequest
): Promise<ChatGptWebBrowserTurnResult> {
  if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
  const prompt = requirePrompt(request.prompt);
  requireFirstPartyUrl(session.url());
  const timeoutMs = request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ChatGPT Web browser turn requires a positive timeout");
  }
  const runner = new ChatGptWebBrowserTurnRunner(session, prompt, request.attachments ?? []);
  return runner.run(timeoutMs, request.signal);
}

/**
 * Playwright binding for a logged-in ChatGPT page.
 *
 * ChatGPT's own loaded module performs auth and Sentinel inside the page. The hot path never
 * touches the composer, model picker, attachment input, cookies, or bearer tokens.
 */
export class PlaywrightChatGptWebBrowserSession implements ChatGptWebBrowserSession {
  private readonly pageUrl: string;
  private readonly selection: ChatGptWebUiSelection | undefined;
  private readonly closePageOnCleanup: boolean;
  private readonly executePageRequest: NonNullable<
    PlaywrightChatGptWebBrowserSessionOptions["executePageRequest"]
  >;
  private lastRenderedAssistantText: string | null = null;

  constructor(
    private readonly page: Page,
    options: string | PlaywrightChatGptWebBrowserSessionOptions = {}
  ) {
    if (typeof options === "string") {
      this.pageUrl = options;
      this.selection = undefined;
      this.closePageOnCleanup = false;
      this.executePageRequest = executeChatGptWebFirstPartyTurn;
    } else {
      this.pageUrl = options.pageUrl ?? "https://chatgpt.com/?temporary-chat=true";
      this.selection = options.selection;
      this.closePageOnCleanup = options.closePageOnCleanup === true;
      this.executePageRequest = options.executePageRequest ?? executeChatGptWebFirstPartyTurn;
    }
  }

  url(): string {
    return this.pageUrl;
  }

  async start(handlers: ChatGptWebBrowserSessionHandlers): Promise<() => Promise<void>> {
    void handlers;
    requireFirstPartyUrl(this.pageUrl);
    const cleanup = async (): Promise<void> => {
      if (this.closePageOnCleanup) await this.page.close().catch(() => {});
    };
    try {
      let currentIsFirstParty = false;
      try {
        currentIsFirstParty = new URL(this.page.url()).origin === CHATGPT_WEB_ORIGIN;
      } catch {
        currentIsFirstParty = false;
      }
      if (!currentIsFirstParty) {
        await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      requireFirstPartyUrl(this.page.url());
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async renderedAssistantSnapshot(
    minimumCount: number
  ): Promise<{ count: number; text: string; active: boolean }> {
    return this.page.evaluate(({ minimumCount: previousCount }) => {
      const messages = Array.from(
        document.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')
      );
      if (messages.length <= previousCount) {
        return { count: messages.length, text: "", active: true };
      }
      const last = messages.at(-1);
      if (!last) return { count: messages.length, text: "", active: true };
      const markdown = last.querySelector<HTMLElement>("[data-assistant-markdown]");
      const blocks = Array.from(
        last.querySelectorAll<HTMLElement>("[data-assistant-stream-block]")
      );
      const text = (
        markdown?.innerText ||
        markdown?.textContent ||
        blocks
          .map((block) => block.innerText || block.textContent || "")
          .join("\n")
      ).trim();
      const active =
        !last.hasAttribute("data-message-complete") ||
        document.documentElement.hasAttribute("data-conversation-stream-active") ||
        Boolean(last.querySelector("[data-message-streaming]"));
      return { count: messages.length, text, active };
    }, { minimumCount });
  }

  private async waitForRenderedAssistant(
    minimumCount: number,
    timeoutMs: number
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.renderedAssistantSnapshot(minimumCount);
      if (snapshot.text && !snapshot.active) return snapshot.text;
      await this.page.waitForTimeout(200);
    }
    const snapshot = await this.renderedAssistantSnapshot(minimumCount);
    return snapshot.text || null;
  }

  private async submitThroughComposer(request: ChatGptWebBrowserSubmission): Promise<void> {
    if (!this.selection) throw new Error("ChatGPT Web composer fallback requires model selection");
    if (request.attachments.length > 0) {
      throw new Error("ChatGPT Web composer fallback does not support attachments");
    }

    this.lastRenderedAssistantText = null;
    await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    requireFirstPartyUrl(this.page.url());

    const composer = this.page
      .locator('#mobile-composer-prompt, textarea[name="prompt"], [data-mobile-composer-prompt]')
      .first();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    const initialAssistantCount = await this.page
      .locator('[data-message-role="assistant"]')
      .count();
    const fields = composerSelectionFields(this.selection);

    await this.page.evaluate((values) => {
      const form = document.querySelector<HTMLFormElement>("[data-mobile-composer]");
      if (!form) throw new Error("ChatGPT Web composer form is unavailable");
      for (const name of ["thinkingHint", "thinkingModel", "thinkingEffort"]) {
        form.querySelectorAll(`input[name="${name}"]`).forEach((input) => input.remove());
      }
      for (const [name, value] of Object.entries(values)) {
        if (!value) continue;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }
    }, fields);

    await composer.fill(requirePrompt(request.prompt));
    if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
    await composer.press("Enter");

    const text = await this.waitForRenderedAssistant(initialAssistantCount, 90_000);
    if (!text) throw new Error("ChatGPT Web composer returned no rendered assistant response");
    this.lastRenderedAssistantText = text;
  }

  async readRenderedAssistantText(timeoutMs = 10_000): Promise<string | null> {
    if (this.lastRenderedAssistantText) return this.lastRenderedAssistantText;
    return this.waitForRenderedAssistant(-1, timeoutMs);
  }

  async submitPrompt(request: ChatGptWebBrowserSubmission): Promise<string | void> {
    if (!this.selection) throw new Error("ChatGPT Web direct request requires a model selection");
    requireFirstPartyUrl(this.page.url());
    try {
      return await this.executePageRequest(
        this.page,
        {
          prompt: requirePrompt(request.prompt),
          attachments: request.attachments,
          selection: this.selection,
        },
        { signal: request.signal }
      );
    } catch (error) {
      if (!shouldUseComposerFallback(error)) throw error;
      await this.submitThroughComposer(request);
    }
  }
}
