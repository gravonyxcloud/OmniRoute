import { injectIdentityMask } from "./identityMasking.ts";

export const RESPONSE_LANGUAGE_POLICY =
  "For natural-language replies, respond in the same language as the user's most recent natural-language message. " +
  "If the user explicitly asks for a different language, follow that request. " +
  "Do not translate code, identifiers, file paths, commands, JSON, quoted text, or exact strings unless the user asks you to.";

export function applyResponseLanguagePolicy(
  body: Record<string, unknown>,
  targetFormat?: string
): Record<string, unknown> {
  return injectIdentityMask(body, RESPONSE_LANGUAGE_POLICY, targetFormat);
}