/**
 * Pure-function + orchestration tests for the ChatGPT Web (Clean Room)
 * account sign-in service. The real Chrome/Playwright launch is covered by the
 * vendored codex-chatgpt-web login flow; here we inject a fake engine so the
 * wrapper logic (clamp, storage-state harvest, sanitized errors) is tested
 * without spawning a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  clampChatGptWebLoginTimeout,
  startChatGptWebLogin,
  CHATGPT_WEB_LOGIN_TIMEOUT_DEFAULT_MS,
  CHATGPT_WEB_LOGIN_TIMEOUT_MIN_MS,
  CHATGPT_WEB_LOGIN_TIMEOUT_MAX_MS,
  type ChatGptWebLoginEngine,
  type ChatGptWebLoginEngineContext,
} from "../../open-sse/services/chatgptWebLogin.ts";

const SAMPLE_STORAGE_STATE = {
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
};

test("clampChatGptWebLoginTimeout defaults and clamps like the shared login contract", () => {
  assert.equal(clampChatGptWebLoginTimeout(undefined), CHATGPT_WEB_LOGIN_TIMEOUT_DEFAULT_MS);
  assert.equal(clampChatGptWebLoginTimeout("nope"), CHATGPT_WEB_LOGIN_TIMEOUT_DEFAULT_MS);
  assert.equal(clampChatGptWebLoginTimeout(1000), CHATGPT_WEB_LOGIN_TIMEOUT_MIN_MS);
  assert.equal(clampChatGptWebLoginTimeout(999_999), CHATGPT_WEB_LOGIN_TIMEOUT_MAX_MS);
  assert.equal(clampChatGptWebLoginTimeout(120_000), 120_000);
});

function engineWritingState(
  storageState: unknown,
  result: {
    accountSurfaceUrl?: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
    error?: string;
  } = {}
): ChatGptWebLoginEngine {
  return async (context: ChatGptWebLoginEngineContext) => {
    if (result.error) throw new Error(result.error);
    writeFileSync(context.storageStatePath, `${JSON.stringify(storageState)}\n`, "utf8");
    return {
      storageStatePath: context.storageStatePath,
      accountSurfaceUrl: result.accountSurfaceUrl ?? "https://chatgpt.com/?temporary-chat=1",
      solAvailable: result.solAvailable ?? true,
      proAvailable: result.proAvailable ?? false,
    };
  };
}

test("startChatGptWebLogin harvests a normalized storage-state from a signed-in session", async () => {
  const result = await startChatGptWebLogin(undefined, {
    engine: engineWritingState(SAMPLE_STORAGE_STATE),
    resolveChrome: () => "C:\\fake\\chrome.exe",
    exists: () => true,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.storageState?.cookies?.[0]?.name, "session");
  assert.equal(result.storageState?.cookieCount, undefined);
  assert.equal(result.accountSurfaceUrl, "https://chatgpt.com/?temporary-chat=1");
  assert.equal(result.solAvailable, true);
  assert.equal(result.proAvailable, false);
});

test("startChatGptWebLogin clamps the engine timeout to the shared bounds", async () => {
  const contexts: ChatGptWebLoginEngineContext[] = [];
  const result = await startChatGptWebLogin(999_999, {
    engine: async (context) => {
      contexts.push(context);
      writeFileSync(context.storageStatePath, `${JSON.stringify(SAMPLE_STORAGE_STATE)}\n`);
      return {
        storageStatePath: context.storageStatePath,
        accountSurfaceUrl: "https://chatgpt.com/?temporary-chat=1",
        solAvailable: true,
        proAvailable: false,
      };
    },
    resolveChrome: () => "C:\\fake\\chrome.exe",
    exists: () => true,
  });
  assert.equal(result.success, true);
  assert.equal(contexts[0]?.timeoutMs, CHATGPT_WEB_LOGIN_TIMEOUT_MAX_MS);
  assert.ok(contexts[0]?.storageStatePath.endsWith("storage-state.json"));
  assert.ok(contexts[0]?.storageStatePath.includes(tmpdir().split("\\").at(-1)!));
});

test("startChatGptWebLogin surfaces a friendly error when no Chrome is resolvable", async () => {
  const result = await startChatGptWebLogin(undefined, {
    engine: engineWritingState(SAMPLE_STORAGE_STATE),
    resolveChrome: () => undefined,
    exists: () => false,
  });
  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.equal(result.error.includes("Playwright"), false);
  assert.ok(/Chrome|Chromium/.test(result.error || ""));
});

test("startChatGptWebLogin sanitizes engine failures without leaking stack tails", async () => {
  const result = await startChatGptWebLogin(undefined, {
    engine: engineWritingState(SAMPLE_STORAGE_STATE, {
      error: "boom at /src/deep/x.ts:44:9",
    }),
    resolveChrome: () => "C:\\fake\\chrome.exe",
    exists: () => true,
  });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("boom"));
  assert.equal(result.error?.includes("at /src/deep"), false);
});

test("startChatGptWebLogin rejects malformed storage-state payloads as invalid", async () => {
  const result = await startChatGptWebLogin(undefined, {
    engine: engineWritingState("not-json"),
    resolveChrome: () => "C:\\fake\\chrome.exe",
    exists: () => true,
  });
  assert.equal(result.success, false);
  assert.ok(result.error);
});
