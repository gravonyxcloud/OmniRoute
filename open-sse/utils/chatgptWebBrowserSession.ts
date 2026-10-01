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
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  parseChatGptEffortSliderState,
} from "../vendor/codex-chatgpt-web/chatgpt-session.ts";

type JsonRecord = Record<string, unknown>;
type Page = import("playwright").Page;
type Locator = import("playwright").Locator;

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
  submitPrompt(
    request: ChatGptWebBrowserSubmission
  ): Promise<string | ChatGptWebBrowserTurnResult | void>;
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

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(" | ");
}

export function isChatGptFirstPartyModuleFailure(error: unknown): boolean {
  const message = errorMessages(error).toLowerCase();
  return (
    message.includes("first-party request module was not loaded") ||
    message.includes("first-party module contract was not found") ||
    message.includes("first-party module contract exports were not found") ||
    message.includes("first-party bridge module failed to load")
  );
}

async function visibleComposer(page: Page) {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  await composers.last().waitFor({ state: "visible", timeout: 30_000 });
  const count = await composers.count();
  if (count < 1) throw new Error("ChatGPT Web DOM fallback could not find the composer");
  return composers.last();
}

async function setLunaThinkMode(
  composerForm: Locator,
  enabled: boolean
): Promise<void> {
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0) {
    if (enabled) throw new Error("ChatGPT Think control is not available");
    return;
  }
  const control = controls.first();
  const pressed = await control.getAttribute("aria-pressed");
  if (pressed !== "true" && pressed !== "false") return;
  if ((pressed === "true") !== enabled) await control.click();
}

async function selectPickerMode(page: Page, selection: Extract<ChatGptWebUiSelection, { kind: "picker" }>) {
  const composer = await visibleComposer(page);
  const form = composer.locator("xpath=ancestor::form[1]");
  const control = form.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true }).last();
  await control.waitFor({ state: "visible", timeout: 30_000 });

  const openMenu = async () => {
    const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
    if (!(await menu.isVisible().catch(() => false))) await control.click({ force: true });
    await menu.waitFor({ state: "visible", timeout: 15_000 });
    return menu;
  };

  let menu = await openMenu();
  const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
  const targetLabel = selection.uiLabel ?? selection.modelLabel;
  const currentLabel = (await control.innerText().catch(() => "")).trim();
  if (!currentLabel.includes(targetLabel)) {
    const exact = menu
      .locator('[role="menuitemradio"], [role="menuitem"], button')
      .filter({ hasText: targetLabel })
      .filter({ visible: true });
    if ((await exact.count()) === 0) {
      const canUseSlider =
        selection.allowEffortControlFallback === true &&
        (await slider.isVisible().catch(() => false));
      if (!canUseSlider) {
        await page.keyboard.press("Escape").catch(() => {});
        throw new Error(
          `ChatGPT Web mode is not available in the current account: ${targetLabel}`
        );
      }
    } else {
      await exact.first().click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (selection.fixedModel) {
        await page.keyboard.press("Escape").catch(() => {});
        return;
      }
      menu = await openMenu();
    }
  } else if (selection.fixedModel) {
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  if (await slider.isVisible().catch(() => false)) {
    let state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow")
    );
    if (!state) throw new Error("ChatGPT effort slider exposed an invalid state");
    const target = state.min + selection.effortIndex;
    if (target > state.max) {
      throw new Error(`ChatGPT effort index ${selection.effortIndex} is unavailable`);
    }
    const owner = slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
    while (state.value !== target) {
      const key = target > state.value ? "ArrowRight" : "ArrowLeft";
      const previous = state.value;
      await owner.press(key);
      const deadline = Date.now() + 5_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = parseChatGptEffortSliderState(
          await slider.getAttribute("aria-valuemin"),
          await slider.getAttribute("aria-valuemax"),
          await slider.getAttribute("aria-valuenow")
        );
        if (!state) throw new Error("ChatGPT effort slider lost its semantic state");
      } while (state.value === previous && Date.now() < deadline);
      if (state.value === previous) throw new Error("ChatGPT effort slider did not move");
    }
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  const items = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR).filter({ visible: true });
  if ((await items.count()) > selection.effortIndex) {
    const item = items.nth(selection.effortIndex);
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
  }
  await page.keyboard.press("Escape").catch(() => {});
}

async function selectDomMode(page: Page, selection: ChatGptWebUiSelection): Promise<void> {
  const composer = await visibleComposer(page);
  const form = composer.locator("xpath=ancestor::form[1]");
  if (selection.kind === "free") {
    await setLunaThinkMode(form, selection.thinkEnabled);
    return;
  }
  await selectPickerMode(page, selection);
}

const CHATGPT_DOM_ASSISTANT_SELECTOR = [
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  '[data-message-author-role="assistant"]',
  '[data-conversation-role="assistant"]',
  '[data-turn="assistant"]',
].join(", ");

async function readDomAssistantText(assistant: Locator): Promise<string> {
  return assistant.evaluate((element) => {
    const root = element as HTMLElement;
    const markdown = [...root.querySelectorAll<HTMLElement>(".markdown")]
      .filter((node) => !node.parentElement?.closest(".markdown"))
      .filter((node) => node.closest("[data-streaming-response-status]") === null)
      .filter((node) => node.closest('[data-testid^="cot-v5"]') === null)
      .map((node) => node.innerText.trim())
      .filter(Boolean);
    return (markdown.join("\n\n") || root.innerText || "").trim();
  });
}

async function executeChatGptWebDomFallback(
  page: Page,
  request: ChatGptWebBrowserSubmission,
  selection: ChatGptWebUiSelection
): Promise<ChatGptWebBrowserTurnResult> {
  if (request.attachments.length > 0) {
    throw new Error("ChatGPT Web DOM fallback does not support attachments");
  }
  if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
  await selectDomMode(page, selection);

  const assistants = page.locator(CHATGPT_DOM_ASSISTANT_SELECTOR).filter({ visible: true });
  const baselineCount = await assistants.count();
  const baselineText =
    baselineCount > 0
      ? await readDomAssistantText(assistants.last()).catch(() => "")
      : "";
  const composer = await visibleComposer(page);
  const form = composer.locator("xpath=ancestor::form[1]");
  await composer.fill(request.prompt);

  const send = form.locator(CHATGPT_SEND_BUTTON_SELECTOR).filter({ visible: true }).last();
  const sendDeadline = Date.now() + 10_000;
  while (!(await send.isEnabled().catch(() => false))) {
    if (Date.now() >= sendDeadline) throw new Error("ChatGPT send button remained disabled");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await send.click();

  const responseDeadline = Date.now() + DEFAULT_TURN_TIMEOUT_MS;
  let assistant: Locator | null = null;
  while (!assistant) {
    if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
    if (Date.now() >= responseDeadline) throw new Error("ChatGPT Web DOM fallback timed out");
    const count = await assistants.count();
    if (count > 0) {
      const candidate = assistants.last();
      const candidateText = await readDomAssistantText(candidate).catch(() => "");
      if (
        count > baselineCount ||
        (candidateText.length > 0 && candidateText !== baselineText)
      ) {
        assistant = candidate;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completion = assistant.locator(CHATGPT_COMPLETION_ACTION_SELECTOR).last();
  const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).last();
  let lastText = await readDomAssistantText(assistant).catch(() => "");
  let stableSince = Date.now();

  while (Date.now() < responseDeadline) {
    if (request.signal?.aborted) throw new Error("ChatGPT Web browser turn aborted");
    const text = await readDomAssistantText(assistant).catch(() => "");
    if (text !== lastText) {
      lastText = text;
      stableSince = Date.now();
    }
    const done =
      (await completion.isVisible().catch(() => false)) ||
      (!(await stop.isVisible().catch(() => false)) &&
        lastText.length > 0 &&
        Date.now() - stableSince >= 1_500);
    if (done && lastText) {
      const identity =
        (await assistant.getAttribute("data-testid").catch(() => null)) ??
        `dom-turn-${Date.now()}`;
      const conversationId = page.url().match(/\/c\/([^/?#]+)/)?.[1] ?? "temporary";
      return {
        conversationId,
        turnExchangeId: identity,
        text: lastText,
        status: "finished_successfully",
        endTurn: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("ChatGPT Web DOM fallback timed out waiting for the assistant response");
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

  private completeFromRenderedAssistant(): void {
    if (this.renderedReadPending || !this.session.readRenderedAssistantText) return;
    this.renderedReadPending = true;
    void this.session
      .readRenderedAssistantText(10_000)
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
        if (this.settled || !directResponse) return;
        this.settled = true;
        this.resolveResult(
          typeof directResponse === "string"
            ? parseChatGptWebDirectConversation(directResponse)
            : directResponse
        );
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

  async submitPrompt(
    request: ChatGptWebBrowserSubmission
  ): Promise<string | ChatGptWebBrowserTurnResult> {
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
      if (!isChatGptFirstPartyModuleFailure(error)) throw error;
      console.warn(
        "[chatgpt-web] first-party module discovery failed; falling back to authenticated DOM transport"
      );
      return executeChatGptWebDomFallback(this.page, request, this.selection);
    }
  }
}
