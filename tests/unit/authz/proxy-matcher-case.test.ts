import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  config,
  configuredApiOnlyHosts,
  isApiOnlyAllowedPath,
} from "../../../src/proxy.ts";
import { classifyRoute } from "../../../src/server/authz/classify.ts";

// Regression guard — GHSA-jvqc-mp9f-q936 (case-sensitive authz-matcher bypass).
//
// Next.js compiles the middleware/proxy matcher from `regexp.source` only,
// dropping path-to-regexp's default case-insensitive flag, so a lowercase
// literal like `/v1/:path*` does NOT match `/V1/...`. The rewrite matcher keeps
// the flag, so `/V1/chat/completions` was still rewritten to the handler while
// skipping the authz pipeline entirely — an unauthenticated inference bypass.
//
// The fix expresses the case-insensitivity inside a path-to-regexp custom group
// (`/:seg([vV]1)/:path*`), which survives the flag-drop because it needs no
// flag. This test compiles the matcher exactly the way Next does and asserts the
// uppercase / mixed-case client aliases are covered.

const require = createRequire(import.meta.url);
const { tryToParsePath } = require("next/dist/lib/try-to-parse-path.js");

function compiledMatcherRegexes(): RegExp[] {
  return (config.matcher as string[]).map((entry) => {
    const parsed = tryToParsePath(entry);
    // Mirror Next's middleware-route-matcher: source only, no flags.
    return new RegExp(parsed.regexStr as string);
  });
}

function isMatchedByProxy(path: string): boolean {
  return compiledMatcherRegexes().some((re) => re.test(path));
}

test("proxy matcher still covers the canonical lowercase client aliases", () => {
  for (const p of [
    "/v1/chat/completions",
    "/v1/models",
    "/v1beta/models",
    "/responses",
    "/codex/x",
    "/models",
  ]) {
    assert.equal(isMatchedByProxy(p), true, `expected proxy matcher to cover ${p}`);
  }
});

test("proxy matcher covers uppercase / mixed-case client aliases (GHSA-jvqc-mp9f-q936)", () => {
  for (const p of [
    "/V1/chat/completions",
    "/V1/models",
    "/V1BETA/models",
    "/CHAT/completions",
    "/RESPONSES",
    "/CODEX/x",
    "/MODELS",
    "/Responses/x",
    "/v1BeTa/models",
  ]) {
    assert.equal(
      isMatchedByProxy(p),
      true,
      `uppercase alias ${p} must reach the authz pipeline, not skip it`
    );
  }
});

test("proxy catch-all also covers dashboard/login/docs for API-only host hiding", () => {
  for (const p of ["/login", "/dashboard", "/dashboard/providers", "/docs", "/api/keys", "/_next/static/x.js"]) {
    assert.equal(isMatchedByProxy(p), true, `expected catch-all proxy matcher to cover ${p}`);
  }
});

test("API-only host parser and path gate expose exactly /v1", () => {
  const hosts = configuredApiOnlyHosts({
    OMNIROUTE_API_ONLY_HOSTS: "api.gravonyx.com, api2.example.com ",
  } as NodeJS.ProcessEnv);
  assert.equal(hosts.has("api.gravonyx.com"), true);
  assert.equal(hosts.has("api2.example.com"), true);

  for (const p of ["/v1", "/v1/", "/v1/models", "/V1/chat/completions"]) {
    assert.equal(isApiOnlyAllowedPath(p), true, `${p} should be public on API-only hosts`);
  }
  for (const p of ["/", "/login", "/dashboard", "/api/keys", "/models", "/responses", "/v1beta/models", "/docs"]) {
    assert.equal(isApiOnlyAllowedPath(p), false, `${p} must be hidden on API-only hosts`);
  }
});

test("classifyRoute treats uppercase client aliases as CLIENT_API, not management fallback", () => {
  assert.equal(classifyRoute("/V1/chat/completions", "POST").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/V1BETA/models", "GET").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/MODELS", "GET").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/CODEX", "POST").routeClass, "CLIENT_API");
  // Lowercase behavior is unchanged.
  assert.equal(classifyRoute("/v1/chat/completions", "POST").routeClass, "CLIENT_API");
});
