/**
 * ChatGPT Web Clean Room account sign-in.
 *
 * The Paste-Credential flow only stores a static Playwright storage-state blob the
 * user exports themselves. This service performs the sign-in inside OmniRoute: it
 * opens a real headed Chrome window via the vendored codex-chatgpt-web login flow
 * (`loginToChatGpt`), waits for `https://chatgpt.com/?temporary-chat=true` to render
 * a visible composer (the clean-room surface has no codex window limit), then
 * captures the resulting storage-state and verifies the account capabilities.
 *
 * Defaults mirror the shared login-timeout contract (src/lib/api/loginTimeout.ts)
 * and the conol/adobe services: 300s / 15s / 600s, sanitized errors only.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loginToChatGpt } from "../vendor/codex-chatgpt-web/browser-login.ts";
import { defaultConfig, stripUtf8Bom } from "../vendor/codex-chatgpt-web/config.ts";
import {
  normalizeChatGptWebStorageState,
  resolveChatGptWebChromeExecutable,
  type ChatGptWebStorageState,
} from "../utils/chatgptWebExecutorAdapter.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

export const CHATGPT_WEB_LOGIN_TIMEOUT_DEFAULT_MS = 300_000;
export const CHATGPT_WEB_LOGIN_TIMEOUT_MIN_MS = 15_000;
export const CHATGPT_WEB_LOGIN_TIMEOUT_MAX_MS = 600_000;

/** Browser used by the vendored login flow is a dedicated Chrome window. */
const CHATGPT_WEB_LOGIN_APP_NAME = "OmniRoute ChatGPT Web Clean Room";

export interface ChatGptWebLoginResult {
  success: boolean;
  storageState?: ChatGptWebStorageState;
  accountSurfaceUrl?: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
  error?: string;
}

export interface ChatGptWebLoginEngineContext {
  chromeExecutablePath: string;
  storageStatePath: string;
  appName: string;
  timeoutMs: number;
}

export interface ChatGptWebLoginEngineResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export type ChatGptWebLoginEngine = (
  context: ChatGptWebLoginEngineContext
) => Promise<ChatGptWebLoginEngineResult>;

/** Bound an untrusted `timeout` from a login request body (conol/adobe clamp). */
export function clampChatGptWebLoginTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CHATGPT_WEB_LOGIN_TIMEOUT_DEFAULT_MS;
  }
  return Math.max(
    CHATGPT_WEB_LOGIN_TIMEOUT_MIN_MS,
    Math.min(CHATGPT_WEB_LOGIN_TIMEOUT_MAX_MS, Math.trunc(value))
  );
}

/**
 * Default login engine: the vendored codex-chatgpt-web headed login, pinned to a
 * dedicated temporary storage-state path so the clean-room login never touches the
 * codex connector's browser profile or credentials.
 */
export const defaultChatGptWebLoginEngine: ChatGptWebLoginEngine = async (context) => {
  const config = defaultConfig("browser-only");
  config.appName = context.appName;
  config.chromeExecutablePath = context.chromeExecutablePath;
  config.storageStatePath = context.storageStatePath;
  config.headed = true;
  const result = await loginToChatGpt(config, { timeoutMs: context.timeoutMs });
  return {
    storageStatePath: result.storageStatePath,
    accountSurfaceUrl: result.accountSurfaceUrl,
    solAvailable: result.solAvailable,
    proAvailable: result.proAvailable,
  };
};

export interface ChatGptWebLoginDeps {
  /** Override the browser sign-in engine (tests inject a fake; default is the vendored flow). */
  engine?: ChatGptWebLoginEngine;
  /** Override Chrome discovery (tests inject a stub; default reads env + standard paths). */
  resolveChrome?: () => string | undefined;
  /** Override filesystem existence checks (tests inject a stub). */
  exists?: (path: string) => boolean;
}

/**
 * Run an interactive ChatGPT Web account sign-in and return the verified
 * storage-state. Never throws: failures surface as `{ success:false, error }` with
 * sanitized messages (Hard Rule #12).
 */
export async function startChatGptWebLogin(
  requestedTimeout?: unknown,
  deps: ChatGptWebLoginDeps = {}
): Promise<ChatGptWebLoginResult> {
  const timeoutMs = clampChatGptWebLoginTimeout(requestedTimeout);
  const exists = deps.exists;
  const chromeExecutablePath = deps.resolveChrome
    ? deps.resolveChrome()
    : resolveChatGptWebChromeExecutable(process.env.OMNIROUTE_LOGIN_BROWSER_PATH, {
        ...(exists ? { exists } : {}),
      });
  if (!chromeExecutablePath) {
    return {
      success: false,
      error:
        "No Chrome or Chromium browser was found for ChatGPT Web sign-in. Install a desktop " +
        "Chrome/Chromium (or set OMNIROUTE_LOGIN_BROWSER_PATH / CHATGPT_WEB_CHROME_PATH), or " +
        "paste the ChatGPT Web Storage-State instead of signing in with a browser.",
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "omniroute-chatgpt-web-login-"));
  const storageStatePath = join(tempDir, "storage-state.json");
  const engine = deps.engine ?? defaultChatGptWebLoginEngine;

  try {
    const result = await engine({
      chromeExecutablePath,
      storageStatePath,
      appName: CHATGPT_WEB_LOGIN_APP_NAME,
      timeoutMs,
    });
    const raw = stripUtf8Bom(readFileSync(result.storageStatePath, "utf8"));
    const storageState = normalizeChatGptWebStorageState(JSON.parse(raw));
    return {
      success: true,
      storageState,
      accountSurfaceUrl: result.accountSurfaceUrl,
      solAvailable: result.solAvailable,
      proAvailable: result.proAvailable,
    };
  } catch (error) {
    return {
      success: false,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    };
  } finally {
    rmSync(dirname(storageStatePath), { recursive: true, force: true });
  }
}
