import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey } from "@/sse/services/auth.ts";
import { extractGoogApiKeyHeader } from "@/sse/services/googApiKeyAuth.ts";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

const HANDSHAKE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isWsHandshake(ctx: PolicyContext): boolean {
  if (ctx.classification.normalizedPath !== "/api/v1/ws") return false;
  if (!HANDSHAKE_METHODS.has(ctx.request.method.toUpperCase())) return false;

  try {
    return new URL(ctx.request.url, "http://localhost").searchParams.get("handshake") === "1";
  } catch {
    return false;
  }
}

function extractBearer(request: Request): string | null {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  const xGoogApiKey = extractGoogApiKeyHeader(request.headers);
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token) return token;
    }
    // A non-"Bearer <token>" Authorization header (an empty "Bearer ", or a
    // client's own non-OmniRoute token — VS Code Copilot sends one even when the
    // OmniRoute key lives in the URL path of a /vscode tokenized endpoint) must
    // NOT short-circuit auth. Fall through to x-api-key and the path-scoped URL
    // token below instead of rejecting the request with "Authentication required".
  }

  if (xApiKey) {
    return xApiKey.trim() || null;
  }

  // Issue #7034: gemini-cli (and any @google/genai-based client) sends its
  // key via x-goog-api-key exclusively — accept it unconditionally, same
  // shape as the x-api-key fallback above.
  if (xGoogApiKey) {
    return xGoogApiKey;
  }

  return extractApiKey(request);
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const bearer = extractBearer(ctx.request as Request);
    if (!bearer) {
      // The WS descriptor handshake is a metadata read; the route handler
      // performs the actual wsAuth/dashboard/API-key decision and returns the
      // protocol details the browser needs before opening the socket.
      if (isWsHandshake(ctx)) {
        return allow({ kind: "anonymous", id: "ws-handshake" });
      }

      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (!isRequireApiKeyEnabled()) {
        return allow({ kind: "anonymous", id: "local" });
      }

      return reject(401, "AUTH_002", "Authentication required");
    }

    const { validateApiKey, getApiKeyMetadata } = await import("../../../lib/db/apiKeys");
    const ok = await validateApiKey(bearer);
    if (!ok) {
      // A persisted key that fails validation is known-but-unusable
      // (expired, revoked, banned or inactive). Never downgrade such a key to
      // anonymous traffic, even when REQUIRE_API_KEY=false: doing so would
      // silently bypass the key's lifecycle controls.
      const persistedKey = await getApiKeyMetadata(bearer).catch(() => null);
      if (persistedKey) {
        return reject(401, "AUTH_002", "Invalid or expired API key");
      }

      // Issue #2257: preserve local-mode compatibility only for a completely
      // unknown/stale token. Unknown bearer + REQUIRE_API_KEY=false may degrade
      // to anonymous, but a real DB key can never bypass its expiry/revocation.
      if (!isRequireApiKeyEnabled()) {
        console.warn(
          `[clientApiPolicy] unknown bearer presented to ${ctx.classification.normalizedPath} ` +
            `but REQUIRE_API_KEY=false — falling through to anonymous (key_id=${maskKeyId(bearer)})`
        );
        return allow({ kind: "anonymous", id: "local" });
      }
      return reject(401, "AUTH_002", "Invalid API key");
    }

    return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
  },
};
