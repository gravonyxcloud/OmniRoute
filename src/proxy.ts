import { NextResponse, type NextRequest } from "next/server";
import { runAuthzPipeline } from "./server/authz/pipeline";

// #10627: the proxy runs in its own Next.js runtime and never executes
// instrumentation-node.ts's startup warm-ups, so its FIRST request used to
// trigger a cold `import("@/lib/db/settings")` → native SQLite driver load ON
// the request path. If that addon hangs (see driverFactory's #10627 probe),
// every proxied request stalled indefinitely with 0 bytes and no logs.
// Warm the settings cache here at boot instead: a driver failure now surfaces
// as a logged startup error, and real requests start with a hot cache.
// Fire-and-forget — never blocks proxy initialization, never rejects the
// module (mirrors the `void warmModelCatalogCache()` pattern in
// instrumentation-node.ts).
void import("./lib/db/readCache")
  .then(({ getCachedSettings }) => getCachedSettings())
  .catch((err: unknown) => {
    console.error(
      "[proxy] DB settings warm failed; requests will use default limits:",
      err instanceof Error ? err.message : err
    );
  });

function normalizedRequestHost(request: NextRequest): string {
  const raw = request.headers.get("host") || request.nextUrl.host || "";
  const first = raw.split(",")[0]?.trim().toLowerCase() || "";
  if (!first) return "";
  // URL() handles IPv6 brackets and strips the port safely.
  try {
    return new URL(`http://${first}`).hostname.replace(/\.$/, "");
  } catch {
    return first.replace(/^\[/, "").replace(/\](:\d+)?$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  }
}

export function configuredApiOnlyHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    String(env.OMNIROUTE_API_ONLY_HOSTS || "")
      .split(/[\s,]+/)
      .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean)
  );
}

export function isApiOnlyAllowedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower === "/v1" || lower.startsWith("/v1/");
}

function shouldRunLegacyAuthz(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    pathname === "/" ||
    lower === "/dashboard" ||
    lower.startsWith("/dashboard/") ||
    lower === "/home" ||
    lower.startsWith("/home/") ||
    lower === "/api" ||
    lower.startsWith("/api/") ||
    lower === "/v1" ||
    lower.startsWith("/v1/") ||
    lower === "/v1beta" ||
    lower.startsWith("/v1beta/") ||
    lower === "/chat" ||
    lower.startsWith("/chat/") ||
    lower === "/responses" ||
    lower.startsWith("/responses/") ||
    lower === "/codex" ||
    lower.startsWith("/codex/") ||
    lower === "/models"
  );
}

function apiOnlyNotFound(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export async function proxy(request: NextRequest) {
  const apiOnlyHosts = configuredApiOnlyHosts();
  const host = normalizedRequestHost(request);

  if (host && apiOnlyHosts.has(host)) {
    // Dedicated public API hostname: expose exactly /v1 and /v1/*.
    // Dashboard, login, management APIs, docs, root redirects and client aliases
    // intentionally look nonexistent. The EasyPanel/internal hostname remains
    // unaffected and can still serve the full dashboard.
    if (!isApiOnlyAllowedPath(request.nextUrl.pathname)) return apiOnlyNotFound();
    return runAuthzPipeline(request, { enforce: true });
  }

  // The catch-all matcher below exists only so API-only hosts can hide every
  // non-/v1 route. Preserve the historical authz surface for all other hosts.
  if (!shouldRunLegacyAuthz(request.nextUrl.pathname)) return NextResponse.next();
  return runAuthzPipeline(request, { enforce: true });
}

// Next compiles the middleware/proxy matcher from `regexp.source` only, dropping
// path-to-regexp's default case-insensitive flag — so a lowercase literal like
// `/v1/:path*` never matches `/V1/...`, while the rewrite matcher (flag kept)
// still routes it to the handler. That skipped the authz pipeline entirely
// (GHSA-jvqc-mp9f-q936). Expressing the case-insensitivity inside a custom
// path-to-regexp group (`([vV]1)`) survives the flag-drop because it needs no
// flag. Keep these in sync with the client-API aliases in
// next.config.mjs rewrites and src/server/authz/classify.ts.
export const config = {
  matcher: [
    // Catch-all is required for OMNIROUTE_API_ONLY_HOSTS: otherwise paths such
    // as /login or /docs would bypass this proxy and remain visible.
    "/:path*",
    "/",
    "/dashboard/:path*",
    "/home",
    "/home/:path*",
    "/api/:path*",
    "/:v1seg([vV]1)/:path*",
    "/:v1seg([vV]1)",
    "/:v1betaseg([vV]1[bB][eE][tT][aA])/:path*",
    "/:v1betaseg([vV]1[bB][eE][tT][aA])",
    "/:chatseg([cC][hH][aA][tT])/:path*",
    "/:respseg([rR][eE][sS][pP][oO][nN][sS][eE][sS])/:path*",
    "/:respseg([rR][eE][sS][pP][oO][nN][sS][eE][sS])",
    "/:codexseg([cC][oO][dD][eE][xX])/:path*",
    "/:codexseg([cC][oO][dD][eE][xX])",
    "/:modelsseg([mM][oO][dD][eE][lL][sS])",
  ],
};
