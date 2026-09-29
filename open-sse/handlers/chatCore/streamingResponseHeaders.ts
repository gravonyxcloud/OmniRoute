/**
 * chatCore streaming success response headers.
 *
 * Builds the client-facing streaming metadata. For combos-only/commercial API
 * keys, backend provider/model identity is masked before any X-OmniRoute-* meta
 * header is attached.
 */
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { buildStreamingResponseHeaders as defaultBuildStreaming } from "./responseHeaders.ts";
import { resolveClientRoutingIdentity } from "./clientRoutingIdentity.ts";

export function assembleStreamingResponseHeaders(
  args: {
    providerHeaders: Headers;
    provider: string | null | undefined;
    model: string | null | undefined;
    pendingRequestId: string;
    compressionResponseMeta?: string | null | undefined;
    comboStrategy?: string | null | undefined;
    fallbackAttempts?: number;
    catalogScope?: "all" | "combos" | "models" | null | undefined;
    requestedModel?: string | null | undefined;
    comboName?: string | null | undefined;
  },
  buildStreamingResponseHeaders: typeof defaultBuildStreaming = defaultBuildStreaming
): Record<string, string> {
  const identity = resolveClientRoutingIdentity({
    provider: args.provider,
    model: args.model,
    comboStrategy: args.comboStrategy,
    catalogScope: args.catalogScope,
    requestedModel: args.requestedModel,
    comboName: args.comboName,
  });

  const responseHeaders: Record<string, string> = {
    ...buildStreamingResponseHeaders(args.providerHeaders, {
      provider: identity.provider,
      model: identity.model,
      cacheHit: false,
      latencyMs: 0,
      usage: null,
      costUsd: 0,
      strategy: identity.strategy,
      ...(args.fallbackAttempts !== undefined ? { fallbackAttempts: args.fallbackAttempts } : {}),
    }),
    "x-omniroute-request-id": args.pendingRequestId,
  };

  if (args.compressionResponseMeta) {
    responseHeaders[OMNIROUTE_RESPONSE_HEADERS.compression] = args.compressionResponseMeta;
  }
  return responseHeaders;
}
