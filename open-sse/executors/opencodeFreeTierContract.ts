/**
 * opencodeFreeTierContract.ts — the request contract OpenCode Zen's free tier enforces.
 *
 * First measured against the live endpoint on 2026-09-17, on three models and both the
 * Chat Completions and Responses surfaces: the upstream answers 403 FreeTierError unless
 * the request carries all four of
 *
 *   1. `stream: true` in the body,
 *   2. a `tools` array declaring the official agentic client's file-search quartet
 *      `{bash, glob, grep, read}`. Re-measured 2026-09-19 against the live endpoint with a
 *      genuine `opencode/1.18.31` User-Agent and canonical session id held constant: a
 *      body with NO tools answers 403 FreeTierError, the same body with the quartet answers
 *      200, and the quartet plus an extra declared name answers 200 too — so a caller tool
 *      list is preserved verbatim and the missing quartet entries are merged in.
 *
 *      Which names the upstream takes also moves between days (measured 2026-09-18: one
 *      made-up name accepted on `big-pickle` and refused on two other free models the day
 *      before). The default quartet is what the official client itself declares right now;
 *      names observed on real accepted traffic or configured by the operator
 *      (OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS) replace the default, see
 *      opencodeToolObservation.ts. `_noop` — the historical default, and a name the client
 *      itself used to emit — is refused on the live tier since 2026-09-19.
 *
 *   3. a session header shaped `ses_` + 12 hex + 14 base62 (since 2026-09-19 the value is
 *      checked too: the 12 hex must decode to a recent wall clock, the encoding the real
 *      CLI computes — an arbitrary hex answers 403 FreeTierError "can only be used from
 *      within OpenCode"),
 *   4. a `User-Agent` carrying `opencode/<version>` with version >= 1.17 (an older
 *      version answers 426 UpgradeRequired rather than 403).
 *
 * Note an exception from 2026-09-19: the official client's own service requests — title
 * generation, compaction — pass with NO tools, because the upstream recognizes their
 * system prompt; a request from any other caller with no tools answers 403, which is why
 * the quartet is the default for requests that declare none.
 *
 * On 2026-09-17 removing any single one of the four turned a 200 into a 403; the tools
 * clause has since moved (see above). Paid models on the same host are not gated (a paid
 * model without tools answers 401 CreditsError), which is why `requiresFreeTierRequestContract`
 * narrows the contract to free-tier models.
 *
 * The module also owns the free-model catalog — the catalog is what decides whether the
 * contract applies, so the two belong together and the executor imports them from here —
 * and the way back: the forced stream is rebuilt into a JSON body for a caller that asked
 * for JSON, reusing the shared event-stream parsers.
 */
import { parseSSEToOpenAIResponse, parseSSEToResponsesOutput } from "../handlers/sseParser.ts";
import {
  getObservedToolNames,
  noteRefusedBorrowedToolNames,
  recordAcceptedToolNames,
  resolvePlaceholderNames,
} from "./opencodeToolObservation.ts";

/**
 * What one gated request declared, kept until its outcome is known.
 *
 * `borrowed` means the placeholder came from the observation store rather than from the
 * caller or the configuration, which is the only case where a refusal says anything about
 * that store.
 */
export interface FreeTierContractAttempt {
  readonly provider: string;
  readonly model: string;
  readonly session: string | undefined;
  readonly borrowed: boolean;
  readonly clientToolNames: readonly string[];
}

/**
 * Models that work WITHOUT any API key on the free/noauth opencode tier.
 *
 * The upstream free tier rotates frequently — when a `-free` suffix model is
 * delisted upstream, the upstream returns "Model X is not supported" (a separate
 * issue from this gate). The set is defined by two data sources:
 *
 *   1. **Known free models** — models explicitly listed in the noauth
 *      `opencode` provider registry (`open-sse/config/providers/registry/opencode/index.ts`).
 *      These are the canonical free models. `deepseek-v4-flash-free` appears in both
 *      the noauth AND the zen registry (it is free on both tiers).
 *   2. **`-free` suffix** — any model whose id ends in `-free`. This automatically
 *      covers upstream free-tier additions without a code deploy.
 *
 * For `opencode-go`, there is no free tier — ALL models require an API key.
 */
const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

/**
 * Determine whether a model requires an API key on the given opencode provider.
 *
 * - `opencode-go`: ALL models require a key (no free tier).
 * - `opencode` / `opencode-zen`: premium = any model NOT in the free set (known
 *   free models OR ending in `-free`).
 * - Unknown models are assumed premium (fail-safe).
 */
export function isPremiumOpencodeModel(model: string, provider: string): boolean {
  // opencode-go has no free tier — every model requires a key.
  if (provider === "opencode-go") return true;

  // Models ending in `-free` are always free on the noauth/zen tier.
  if (model.endsWith("-free")) return false;

  // Check the known free model catalog.
  return !OPENCODE_FREE_MODELS.has(model);
}

/**
 * The upstream surface a request is served on, as told apart by the registry `baseUrl`.
 *
 * The gate is a property of the surface, not of billing: `/zen/v1` refuses a request that
 * carries no tools, while `/zen/go/v1` refuses one that carries any (upstream
 * anomalyco/opencode#44300 and #44382, "Endpoint is unavailable" for any request
 * containing tools). Passing the surface in keeps this module free of registry imports and
 * covers every entry of the family — including the `oc` alias, which resolves to
 * `opencode` before an executor is ever picked.
 */
export type OpencodeSurface = "zen" | "go" | "other";

const ZEN_SURFACE_BASE_URL = "https://opencode.ai/zen/v1";
const GO_SURFACE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Tell the surfaces apart by registry `baseUrl`, so provider ids and aliases stay out. */
export function surfaceFromBaseUrl(baseUrl: string | null | undefined): OpencodeSurface {
  if (baseUrl === ZEN_SURFACE_BASE_URL) return "zen";
  if (baseUrl === GO_SURFACE_BASE_URL) return "go";
  return "other";
}

/**
 * Operator opt-out for the body half of the contract.
 *
 * The headers stay in place either way: they are what the upstream validates by shape, and
 * they cost nothing. The body half is the half built on an observation of someone else's
 * service, so it is the half worth being able to switch off without waiting for a release.
 * Read per call, so a change takes effect immediately.
 */
function isBodyContractEnabled(): boolean {
  return (process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT || "").trim().toLowerCase() !== "off";
}

/**
 * Whether the upstream gates this request at all.
 *
 * Scope only — it ignores the opt-out on purpose, because the headers are applied either
 * way: they are what the upstream validates by shape, they cost nothing, and switching
 * them off with the body half would turn an opt-out into a second failure mode.
 */
export function isGatedFreeTierRequest(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  if (surface !== "zen") return false;
  return !isPremiumOpencodeModel(model, provider);
}

/** Whether the body half of the contract applies: gated, and not switched off. */
export function requiresFreeTierRequestContract(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  return isGatedFreeTierRequest(surface, provider, model) && isBodyContractEnabled();
}

/**
 * The tool names the official agentic client always declares on its free-tier build
 * requests, and the baseline this relay falls back to when nothing has been observed or
 * configured: `{bash, glob, grep, read}`.
 *
 * Measured 2026-09-19 against the live endpoint with genuine CLI identity headers held
 * constant: this exact set answers 200 on a request that answered 403 with none ("can
 * only be used from within OpenCode"). Upstream proxy fixes converged on the same quartet
 * (decolua/9router#4105 + #4132). The set is exported so tests can pin it.
 */
export const DEFAULT_FINGERPRINT_TOOL_NAMES: readonly string[] = ["bash", "glob", "grep", "read"];

/**
 * The tool name the official client uses on some surfaces when it has nothing to declare.
 *
 * NOT the default here: `_noop` was refused on the live free tier on 2026-09-19 while the
 * current default quartet was accepted, so guessing it would break the very requests this
 * contract repairs. The name is exported for reference and for tests that pin a
 * placeholder deliberately.
 */
const PLACEHOLDER_TOOL_NAME = "_noop";
export const DEFAULT_PLACEHOLDER_TOOL_NAME = PLACEHOLDER_TOOL_NAME;

/**
 * Operator-supplied placeholder tool names, comma-separated.
 *
 * The upstream inspects which names a request declares, and what it accepts differs by
 * model and moves over time (measured 2026-09-18: one made-up name is accepted on
 * `big-pickle` and refused on two other free models that had accepted it the day before;
 * re-measured 2026-09-19: `_noop` itself is refused while the quartet `{bash, glob, grep,
 * read}` is accepted). That is an observation about someone else's service, not a fact
 * about this project, so it belongs in configuration rather than in a constant that needs
 * a release to change.
 *
 * Empty or unset means the request falls back to the default quartet above when the
 * observation store has nothing for this surface, model and session. Read per call, so a
 * change takes effect immediately.
 */
export function configuredPlaceholderToolNames(): string[] {
  const raw = process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS || "";
  const kept: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (kept.length >= 32) break;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) continue;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}
const PLACEHOLDER_TOOL_DESCRIPTION =
  "Do not call this tool. It exists only for API compatibility and must never be invoked.";
const PLACEHOLDER_TOOL_PARAMETERS = { type: "object", properties: {} } as const;

/**
 * Bring a free-tier request up to the upstream contract, without overriding anything the
 * caller already decided. The mandatory streaming flag is forced unconditionally. Tools
 * are handled like this:
 *
 * - a caller tool list is preserved VERBATIM, and only the declared names missing from
 *   the current accepted set are appended as no-op placeholders (measured 2026-09-19: the
 *   quartet plus extra declared names all answer 200, so extras are safe while no tools
 *   at all answers 403);
 * - a request that declares no tools gets the FULL current set — the default quartet
 *   `{bash, glob, grep, read}`, or the observed/configured set when known — as no-op
 *   placeholders.
 *
 * Idempotent: re-applying to a body that already declares the full set changes nothing
 * beyond the streaming flag already set. `tool_choice` is never added (the upstream
 * rejects any value but "auto"); a caller-supplied one travels unchanged. Any body format
 * other than the two known surfaces only gets the streaming flag: injecting a tool shape
 * blind would be a guess.
 *
 * Which names make the "current set" is resolved by `prepareFreeTierRequest` — the
 * observed/configured names when known, else `DEFAULT_FINGERPRINT_TOOL_NAMES`.
 */
export function applyFreeTierRequestContract<T>(
  body: T,
  requestFormat: string | null,
  placeholderNames: readonly string[] = []
): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record, stream: true };

  const effectiveNames =
    placeholderNames.length > 0 ? placeholderNames : DEFAULT_FINGERPRINT_TOOL_NAMES;
  const currentNames = new Set(clientToolNamesOf(next));
  const missingNames = effectiveNames.filter((name) => !currentNames.has(name));
  if (missingNames.length === 0) return next as T;

  const missingTools = placeholderTools(missingNames, requestFormat);
  if (missingTools.length === 0) return next as T;

  const callerTools = Array.isArray(next.tools) ? (next.tools as unknown[]) : [];
  next.tools = [...callerTools, ...missingTools];
  return next as T;
}

/**
 * Render the accepted tool names in the shape the surface takes.
 *
 * Chat Completions nests the declaration under `function`; the Responses surface takes it
 * flat. Either way it is a name in a list declaring an empty parameter object — never a
 * tool the model could usefully call. An unrecognized request format yields no tools at
 * all.
 */
function placeholderTools(names: readonly string[], requestFormat: string | null): unknown[] {
  if (requestFormat === "openai-responses") {
    return names.map((name) => ({
      type: "function",
      name,
      description: PLACEHOLDER_TOOL_DESCRIPTION,
      parameters: PLACEHOLDER_TOOL_PARAMETERS,
    }));
  }
  if (requestFormat === "openai" || requestFormat === null) {
    return names.map((name) => ({
      type: "function",
      function: {
        name,
        description: PLACEHOLDER_TOOL_DESCRIPTION,
        parameters: PLACEHOLDER_TOOL_PARAMETERS,
      },
    }));
  }
  return [];
}

function clientToolNamesOf(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const entry = tool as { name?: unknown; function?: { name?: unknown } };
    const name = typeof entry.name === "string" ? entry.name : entry.function?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

/**
 * Bring one request up to the contract and report what it ended up declaring.
 *
 * Single entry point for the executor: it decides whether the contract applies to this
 * surface and model, resolves the placeholder names (observed → configured → the default
 * quartet), applies the body changes, and hands back the attempt so the outcome can be
 * fed to `noteFreeTierOutcome`.
 */
export function prepareFreeTierRequest<T>(
  body: T,
  requestFormat: string | null,
  surface: OpencodeSurface,
  provider: string,
  model: string,
  session?: string
): { body: T; attempt: FreeTierContractAttempt | null } {
  const clientToolNames = clientToolNamesOf(body);
  if (!requiresFreeTierRequestContract(surface, provider, model)) return { body, attempt: null };
  const configured = configuredPlaceholderToolNames();
  const names = resolvePlaceholderNames(provider, model, session, configured);
  // `borrowed` means the names came from the observation store rather than from the caller,
  // the operator, or the default quartet — the only case where a refusal says anything
  // about that store. Names from the store replace the quartet; the quartet itself is rebuilt
  // from measured fact, so a refusal on it must not charge the store.
  const storeNames =
    (session ? getObservedToolNames(provider, model, session) : null) ??
    getObservedToolNames(provider, model) ??
    null;
  const borrowed = clientToolNames.length === 0 && (storeNames?.length ?? 0) > 0;
  return {
    body: applyFreeTierRequestContract(body, requestFormat, names),
    attempt: { provider, model, session, borrowed, clientToolNames },
  };
}

/**
 * Feed a gated request's outcome back, so the next one borrows a shape that still works.
 *
 * An accepted request teaches which names the upstream takes right now; a refused one only
 * teaches something when the names it carried came from the store.
 */
export function noteFreeTierOutcome(attempt: FreeTierContractAttempt | null, ok: boolean): void {
  if (!attempt) return;
  if (ok) {
    if (attempt.clientToolNames.length > 0) {
      recordAcceptedToolNames(
        attempt.provider,
        attempt.model,
        attempt.session,
        attempt.clientToolNames
      );
    }
    return;
  }
  if (attempt.borrowed) {
    noteRefusedBorrowedToolNames(attempt.provider, attempt.model, attempt.session);
  }
}

/**
 * Rebuild a JSON body from the event stream the contract forced.
 *
 * The contract makes the upstream request streamed even when the caller asked for JSON, so
 * the conversion back has to happen here rather than in one caller: `handleChatCore` knows
 * how to buffer an event stream, but the other executor consumers (the compression judge,
 * token counting) call `execute()` and then read `response.json()`. Handing them the raw
 * event stream would throw on a request they explicitly asked not to stream.
 *
 * The conversion is LAZY: the returned body drains and parses the upstream only when the
 * caller reads it, so the executor never blocks on a stream that has not arrived yet — the
 * caller's own read timeout governs, and a caller that cancels pays nothing. Only a
 * successful event-stream response is converted; a streaming caller, a refusal and an
 * already-JSON body pass through untouched.
 */
export function rebuildJsonFromForcedStream(
  response: Response,
  requestFormat: string | null,
  model: string
): Response {
  if (!response.ok || !response.body) return response;
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
    return response;
  }
  const upstream = response;
  let drained = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (drained) {
          controller.close();
          return;
        }
        drained = true;
        try {
          const rawSse = await upstream.text();
          const parsed =
            requestFormat === "openai-responses"
              ? parseSSEToResponsesOutput(rawSse, model)
              : parseSSEToOpenAIResponse(rawSse, model);
          const out = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : rawSse;
          controller.enqueue(new TextEncoder().encode(out));
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
      cancel(reason) {
        // Only when nothing started draining: once `text()` holds the reader, cancelling the
        // upstream body directly throws "ReadableStream is locked".
        if (!drained && !upstream.bodyUsed && upstream.body && !upstream.body.locked) {
          void upstream.body.cancel(reason);
        }
      },
    },
    // No pull before the caller reads: a caller that never reads (or cancels) must not make
    // the executor wait on an upstream stream that may never arrive.
    { highWaterMark: 0 }
  );
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
