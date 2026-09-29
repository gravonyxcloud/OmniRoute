/**
 * chatCore non-streaming success response headers.
 *
 * Builds the client-facing success metadata. For combos-only/commercial API
 * keys, backend provider/model identity is masked before any X-OmniRoute-* meta
 * header is attached.
 */
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { attachOmniRouteMetaHeaders as defaultAttachMeta } from "@/domain/omnirouteResponseMeta";
import { resolveClientRoutingIdentity } from "./clientRoutingIdentity.ts";

export function buildNonStreamingResponseHeaders(
  args: {
    provider: string | null | undefined;
    model: string | null | undefined;
    startTime: number;
    responseUsage: Record<string, unknown> | null | undefined;
    estimatedCost: number;
    requestId: string | null | undefined;
    compressionResponseMeta?: string | null | undefined;
    comboStrategy?: string | null | undefined;
    fallbackAttempts?: number;
    catalogScope?: "all" | "combos" | "models" | null | undefined;
    requestedModel?: string | null | undefined;
    comboName?: string | null | undefined;
  },
  deps: { attachOmniRouteMetaHeaders: typeof defaultAttachMeta; now: () => number } = {
    attachOmniRouteMetaHeaders: defaultAttachMeta,
    now: Date.now,
  }
): Record<string, string> {
  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    [OMNIROUTE_RESPONSE_HEADERS.cache]: "MISS",
  };

  const identity = resolveClientRoutingIdentity({
    provider: args.provider,
    model: args.model,
    comboStrategy: args.comboStrategy,
    catalogScope: args.catalogScope,
    requestedModel: args.requestedModel,
    comboName: args.comboName,
  });

  deps.attachOmniRouteMetaHeaders(responseHeaders, {
    provider: identity.provider,
    model: identity.model,
    cacheHit: false,
    latencyMs: deps.now() - args.startTime,
    usage: args.responseUsage,
    costUsd: args.estimatedCost,
    requestId: args.requestId,
    strategy: identity.strategy,
    ...(args.fallbackAttempts !== undefined ? { fallbackAttempts: args.fallbackAttempts } : {}),
  });

  if (args.compressionResponseMeta) {
    responseHeaders[OMNIROUTE_RESPONSE_HEADERS.compression] = args.compressionResponseMeta;
  }
  return responseHeaders;
}
