import type { ClientRoutingIdentity } from "./clientRoutingIdentity.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";

function comboLabel(identity: ClientRoutingIdentity): string {
  const value =
    typeof identity.model === "string" && identity.model.trim().length > 0
      ? identity.model.trim()
      : "combo";
  return value.replace(/[\r\n"\\]/g, " ").trim() || "combo";
}

export function projectClientRoutingErrorMessage(args: {
  identity: ClientRoutingIdentity;
  statusCode: number;
  message: string;
  errorCode?: string | null;
  errorType?: string | null;
}): string {
  const { identity, statusCode } = args;
  const safeOriginal = sanitizeErrorMessage(args.message) || "Upstream provider error";
  if (!identity.masked) return safeOriginal;

  const combo = comboLabel(identity);
  const code = (args.errorCode || "").toLowerCase();
  const type = (args.errorType || "").toLowerCase();
  const message = safeOriginal.toLowerCase();

  if (
    code.includes("context") ||
    type.includes("context") ||
    /context window|context length|too many tokens|prompt too long|input exceeds/.test(message)
  ) {
    return `Input exceeds context window for combo "${combo}". Reduce the prompt or start a new conversation.`;
  }

  if (
    statusCode === 429 ||
    code.includes("rate_limit") ||
    code.includes("quota") ||
    type.includes("rate_limit") ||
    type.includes("quota")
  ) {
    return `Combo "${combo}" is temporarily rate limited. Try again shortly.`;
  }

  if (statusCode === 401 || statusCode === 403) {
    return `Combo "${combo}" is temporarily unavailable.`;
  }

  if (statusCode === 404 || code.includes("model_not_found") || code.includes("not_supported")) {
    return `Combo "${combo}" is unavailable.`;
  }

  if (statusCode >= 500 || code.includes("timeout") || type.includes("timeout")) {
    return `Combo "${combo}" is temporarily unavailable.`;
  }

  return `Request failed while processing combo "${combo}".`;
}
