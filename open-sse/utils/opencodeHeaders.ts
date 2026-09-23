import { randomBytes, randomUUID } from "crypto";
import { setUserAgentHeader } from "../executors/base.ts";
import { generateSessionId } from "../services/sessionManager.ts";

/**
 * Default synthesized User-Agent. The upstream only parses the version, so this literal
 * exists to be recent enough, not to impersonate a build: any `opencode/<>=1.17>` passes.
 * Overridable through the existing OPENCODE_USER_AGENT (or <PROVIDER>_USER_AGENT) knob.
 */
export const DEFAULT_OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Canonical OpenCode session id shape: `ses_` + 12 hex + 14 base62. */
export const OPENCODE_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/** Same shape for the request id. Since 2026-09-19 the upstream also validates its value. */
export const OPENCODE_REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const MINIMUM_USER_AGENT_MINOR = 17;
const USER_AGENT_VERSION_RE = /opencode\/(?:[a-z]+\/)?v?(\d+)\.(\d+)/i;

/** Whether a User-Agent already satisfies the upstream contract, so it must be kept. */
export function satisfiesOpencodeUserAgentContract(userAgent: string | null | undefined): boolean {
  const match = String(userAgent || "").match(USER_AGENT_VERSION_RE);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 1 || (major === 1 && minor >= MINIMUM_USER_AGENT_MINOR);
}

/**
 * The session id the caller supplied, if any.
 *
 * Only a client-supplied value joins two requests of one conversation: a synthesized one
 * is derived from the body, and the body of a build request and of the title request that
 * follows it differ — including in their tool list, which is the very thing being joined.
 */
export function clientSuppliedOpencodeSession(
  clientHeaders: Record<string, string> | null | undefined
): string | undefined {
  if (!clientHeaders) return undefined;
  const value =
    findHeader(clientHeaders, "x-opencode-session") ?? findHeader(clientHeaders, "x-session-id");
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The CLI identity defaults the upstream expects, or `undefined` when synthesis is off.
 *
 * Lives here rather than in the executor because this module already owns the default
 * user-agent and the contract that validates one. `gated` says the free tier will inspect
 * this request: outside the gate a configured user-agent is honoured as-is (the #5997
 * contract, which `opencode-go` and paid models rely on), while on a gated request one
 * that does not satisfy the version rule is replaced — an operator still carrying the
 * previous unversioned default would otherwise be refused.
 */
export function resolveOpencodeCliDefaults(
  providerId: string,
  gated: boolean
): { userAgent: string; client: string; project: string } | undefined {
  if (/^(0|false|no|off)$/i.test(process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS?.trim() ?? "")) {
    return undefined;
  }
  const envUAKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_USER_AGENT`;
  const configuredUA = process.env[envUAKey]?.trim() || process.env.OPENCODE_USER_AGENT?.trim();
  return {
    userAgent:
      configuredUA && (!gated || satisfiesOpencodeUserAgentContract(configuredUA))
        ? configuredUA
        : DEFAULT_OPENCODE_USER_AGENT,
    client: process.env.OPENCODE_CLIENT?.trim() || "desktop",
    project: process.env.OPENCODE_PROJECT?.trim() || "global",
  };
}

/**
 * Provider ids served by opencode.ai — the free tier plus the two API-key gateways.
 * All three hit the same Cloudflare-fronted /v1/models endpoint and need the same
 * synthesized CLI identity headers on datacenter egress (#5997).
 */
export const OPENCODE_FAMILY_PROVIDERS: ReadonlySet<string> = new Set([
  "opencode",
  "opencode-zen",
  "opencode-go",
]);

/**
 * Whether a provider id belongs to the opencode.ai family (free + zen + go).
 */
export function isOpencodeFamilyProvider(providerId: string | null | undefined): boolean {
  return typeof providerId === "string" && OPENCODE_FAMILY_PROVIDERS.has(providerId);
}

/**
 * OpenCode CLI identity header set for non-chat egress (provider model-discovery and
 * key-validation probes). Same synthesis the executor applies to chat requests (#5997):
 * Cloudflare in front of opencode.ai 403s datacenter fetches to /v1/models that carry
 * no CLI identity. The free tier enforces the User-Agent contract (`gated`), matching
 * how `resolveOpencodeCliDefaults` is invoked for free-tier chat requests; the API-key
 * gateways keep honoring a configured UA as-is. Returns an empty object when identity
 * synthesis is disabled via OPENCODE_SYNTHESIZE_CLI_HEADERS=0.
 */
export function buildOpencodeServerIdentityHeaders(
  providerId: string,
  options: { gated?: boolean } = {}
): Record<string, string> {
  const defaults = resolveOpencodeCliDefaults(
    providerId,
    options.gated ?? providerId === "opencode"
  );
  if (!defaults) return {};
  return {
    "User-Agent": defaults.userAgent,
    "x-opencode-client": defaults.client,
    "x-opencode-project": defaults.project,
    "x-opencode-session": canonicalId("ses_"),
    "x-opencode-request": canonicalId("msg_"),
  };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62From(bytes: Buffer, length: number): string {
  return Array.from(bytes.subarray(0, length), (byte) => BASE62[byte % 62]).join("");
}

// The upstream decodes the id's value, not just its shape. The opencode CLI derives the
// 12-hex time field from the wall clock: the low 48 bits of `(Date.now() * 0x1000 +
// counter)`, the bits inverted for the session id and used verbatim for the request id
// (measured on the live free tier 2026-09-19 — an arbitrary hex answers 403 FreeTierError,
// "can only be used from within OpenCode"; the algorithm matches a real CLI install via
// linux.do/138213). The counter only disambiguates two ids minted in the same millisecond.
const OPENCODE_TIME_BITS = 0xffffffffffffn;
let opencodeLastMs = 0;
let opencodeCounter = 0;

/** The 12-hex time field of a real opencode id minted against the current wall clock. */
function opencodeTimeHex(inverted: boolean): string {
  const ts = Date.now();
  if (ts !== opencodeLastMs) {
    opencodeLastMs = ts;
    opencodeCounter = 1;
  } else {
    opencodeCounter += 1;
  }
  const v = BigInt(ts) * 0x1000n + BigInt(opencodeCounter);
  return ((inverted ? ~v : v) & OPENCODE_TIME_BITS).toString(16).padStart(12, "0");
}

// One id per conversation keeps one upstream session — and therefore prompt caching —
// stable across requests, exactly as the CLI keeps a single `ses_` per session. Bounded
// like the in-memory session store; nothing here should outlive a conversation.
const OPENCODE_ID_CACHE = new Map<string, string>();
const OPENCODE_ID_CACHE_MAX = 200;

/**
 * Render an id in the canonical OpenCode shape (`<prefix>` + 12 hex + 14 base62).
 *
 * The 12-hex time field reproduces the client's own id algorithm (timestamp plus counter),
 * which the upstream has been decoding since 2026-09-19; the 14 base62 tail is random, as
 * in the real CLI. A seeded id is minted once and recalled, keeping a conversation on one
 * upstream session across requests; an unseeded one is fresh each call, as a request id
 * should be when no client value anchors it.
 */
function canonicalId(prefix: "ses_" | "msg_", seed?: string): string {
  if (seed !== undefined) {
    const key = `${prefix}\u0000${seed}`;
    const cached = OPENCODE_ID_CACHE.get(key);
    if (cached !== undefined) return cached;
    const id = `${prefix}${opencodeTimeHex(prefix === "ses_")}${base62From(randomBytes(14), 14)}`;
    if (OPENCODE_ID_CACHE.size >= OPENCODE_ID_CACHE_MAX) {
      OPENCODE_ID_CACHE.delete(OPENCODE_ID_CACHE.keys().next().value as string);
    }
    OPENCODE_ID_CACHE.set(key, id);
    return id;
  }
  return `${prefix}${opencodeTimeHex(prefix === "ses_")}${base62From(randomBytes(14), 14)}`;
}

/**
 * Header keys that are forwarded from the client to the upstream provider.
 * Used by both OpencodeExecutor and DefaultExecutor.
 */
const OPENCODE_HEADER_KEYS = [
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-project",
  "x-opencode-client",
] as const;

/**
 * Common agent-metadata headers used by non-OpenCode clients (custom agents/
 * providers) for upstream request tracking and attribution. Forwarded the same
 * way as the x-opencode-* set: case-insensitive lookup, client value wins.
 * Added for 9router#2413 — these were previously dropped for every client
 * outside the OpenCode allowlist.
 */
const AGENT_METADATA_HEADER_KEYS = ["x-session-id", "x-title"] as const;

/**
 * Case-insensitive lookup for a header in a headers record.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 *
 * Shared logic used by OpencodeExecutor and DefaultExecutor:
 * 1. Forwards User-Agent from clientHeaders via `setUserAgentHeader()`
 * 2. Forwards x-opencode-session, x-opencode-request, x-opencode-project,
 *    x-opencode-client headers (case-insensitive match)
 * 3. Forwards x-session-id, x-title agent-metadata headers (case-insensitive
 *    match) — common conventions used by non-OpenCode agent clients (9router#2413)
 *
 * @param headers - The outbound headers record to mutate
 * @param clientHeaders - The client-provided headers to forward from
 * @param options.synthesizeRequestId - When true (OpencodeExecutor only), maps
 *   x-session-affinity / x-session-id to x-opencode-session when the latter is
 *   missing, and synthesizes a UUID for x-opencode-request if also missing.
 * @param options.cliDefaults - When provided (OpencodeExecutor only), synthesize
 *   the OpenCode CLI identity headers that Cloudflare requires on VPS egress
 *   (User-Agent, x-opencode-client, x-opencode-project) plus fresh request/session
 *   UUIDs, but ONLY for keys the client did not already supply. Client values always
 *   win; these defaults only fill gaps. User-Agent is the one exception: a client UA
 *   that is not already the OpenCode CLI (e.g. curl/8.5.0) is REPLACED with the
 *   synthesized CLI UA, because opencode.ai's free tier rejects generic client UAs
 *   from datacenter IPs with FreeUsageLimitError 429. (#5997, follow-up #10229)
 * @param options.sessionBody - Request body fields used to generate a
 *   conversation-stable session fingerprint (model, system, messages or input, tools).
 *   When provided, x-opencode-session is a single id minted against the wall clock and
 *   remembered for the conversation, instead of a fresh id per request, so upstream prompt
 *   caching hits across requests of the same conversation.
 */
export function forwardOpencodeClientHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  options?: {
    synthesizeRequestId?: boolean;
    cliDefaults?: { userAgent: string; client: string; project: string };
    sessionBody?: {
      model?: string;
      system?: unknown;
      messages?: Array<{ role?: string; content?: unknown }>;
      input?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; function?: { name?: string } }>;
    };
  }
): void {
  // 1. Forward User-Agent
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  // 2. Forward x-opencode-* metadata headers
  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 2b. Forward agent-metadata headers (x-session-id, x-title) — 9router#2413
  for (const headerName of AGENT_METADATA_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity =
      findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity) {
      // Kept as-is here. When identity synthesis is on, applyCliDefaults renders it in the
      // canonical shape below; with the synthesis opted out this path stays byte-identical
      // to before, since opting out means no fabricated identity at all.
      headers["x-opencode-session"] = sessionAffinity;

      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomUUID();
      }
    }
  }

  // 4. OpencodeExecutor-only: synthesize the OpenCode CLI identity Cloudflare expects
  //    on VPS egress, for any key the client did not supply (#5997).
  if (options?.cliDefaults) {
    applyCliDefaults(headers, options.cliDefaults, options.sessionBody);
  }
}

/**
 * Fill the OpenCode CLI identity headers Cloudflare requires on VPS egress. For
 * x-opencode-* headers, client values always win (defaults only fill gaps). The
 * User-Agent is the exception: a non-CLI client UA (curl, python, SDKs) is replaced
 * with the synthesized CLI UA, because opencode.ai's free tier flags generic client
 * UAs from datacenter IPs (FreeUsageLimitError 429). A client UA that already looks
 * like the OpenCode CLI (opencode-cli/...) is preserved so the real CLI's versioned
 * identity stays intact. (#5997, follow-up)
 */
function applyCliDefaults(
  headers: Record<string, string>,
  cliDefaults: { userAgent: string; client: string; project: string },
  sessionBody?: {
    model?: string;
    system?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
    input?: Array<{ role?: string; content?: unknown }>;
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  }
): void {
  // A client User-Agent is kept only when it already satisfies the upstream contract.
  // The previous rule kept anything starting with `opencode-cli/`, which carries no
  // parsable version and is refused by the free tier.
  const existingUa = headers["User-Agent"] || headers["user-agent"];
  if (!satisfiesOpencodeUserAgentContract(existingUa)) {
    setUserAgentHeader(headers, cliDefaults.userAgent);
  }
  headers["x-opencode-client"] ||= cliDefaults.client;
  headers["x-opencode-project"] ||= cliDefaults.project;
  // Both ids go out in the canonical shape. A client value already in that shape is kept;
  // anything else (a UUID from a generic client, an opaque conversation key) is translated
  // into a single remembered id keyed on it, so one client conversation still maps to one
  // upstream session.
  const clientRequestId = headers["x-opencode-request"]?.trim();
  headers["x-opencode-request"] =
    clientRequestId && OPENCODE_REQUEST_PATTERN.test(clientRequestId)
      ? clientRequestId
      : canonicalId("msg_", clientRequestId || undefined);
  const clientSessionId = headers["x-opencode-session"]?.trim();
  headers["x-opencode-session"] = clientSessionId
    ? OPENCODE_SESSION_PATTERN.test(clientSessionId)
      ? clientSessionId
      : canonicalId("ses_", clientSessionId)
    : canonicalId("ses_", generateSessionId(sessionBody ?? null) ?? undefined);
  // The free tier reads the session under either spelling (#13121), so mirror the canonical
  // id to the alias — the fix that unblocked the tier. A client-supplied x-session-id is
  // already set here and is left untouched (client values win).
  headers["x-session-id"] ||= headers["x-opencode-session"];
}
