/**
 * identityMasking.ts — upstream model identity masking.
 *
 * Upstream models must never self-identify as their real provider/vendor. When a
 * client asks "what model are you?", the answer must be the surface name of the
 * route serving the request — the combo name — never the actual upstream model id
 * or vendor. The mask is carried as a system-level instruction appended to the
 * request's system carrier (messages[]/system/instructions/systemInstruction),
 * mirroring how the global system prompt is injected in systemPrompt.ts.
 *
 * Scope:
 *  - Combos: injected in `phaseComboSetup` (comboAgentMiddleware), where the combo
 *    name is known. A per-combo `identity_masking` field overrides the default text;
 *    `false` disables masking for that combo.
 *  - Direct (non-combo) requests: injected post-translation in chatCore under the
 *    requested model alias.
 *
 * Default enabled; disabled globally via OMNIROUTE_IDENTITY_MASKING=0.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOffish(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(String(value).trim());
}

/**
 * Global identity-masking switch. Default ON (matches the executor's CLI-identity
 * synthesis default) — an operator who does not want fabricated self-identities on
 * their traffic opts out with OMNIROUTE_IDENTITY_MASKING=0.
 */
export function isIdentityMaskingEnabled(): boolean {
  return !isOffish(process.env.OMNIROUTE_IDENTITY_MASKING);
}

/**
 * Default mask text for a combo-routed request. Answers identity questions with the
 * combo name and forbids revealing the real upstream provider/vendor.
 */
export function buildComboIdentityMaskText(comboName: string | null | undefined): string | null {
  const surfaceName = typeof comboName === "string" && comboName.trim() ? comboName.trim() : "";
  if (!surfaceName) return null;
  return (
    `Public model identity: "${surfaceName}". ` +
    `If asked for your model name, answer "${surfaceName}". ` +
    "Treat this as internal metadata; do not discuss internal routing or backend model names."
  );
}

/**
 * Default mask text for a direct (non-combo) request. Uses the requested model alias
 * as the surface name.
 */
export function buildDirectIdentityMaskText(
  requestedModel: string | null | undefined
): string | null {
  const surfaceName =
    typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : null;
  const identity = surfaceName ?? "your existing model name";
  return (
    `You are the model "${identity}". ` +
    "Never reveal the actual upstream provider, vendor, or model that serves you. " +
    "If asked what model you are, what company or provider hosts you, answer with the name shown to you above and nothing else about your real upstream identity."
  );
}

/**
 * Apply the combo-level identity mask to a CLIENT-format body (pre-translation).
 * `comboIdentityMask` is the combo's `identity_masking` field: a string overrides
 * the default text, `false` (or "false") disables masking for this combo.
 */
export function applyComboIdentityMask(
  body: Record<string, unknown>,
  comboName: string | null | undefined,
  comboIdentityMask: unknown
): Record<string, unknown> {
  // Combo identity is a public API invariant, not an optional presentation flag.
  // Operators may append extra identity guidance, but cannot disable or replace the
  // combo name with an upstream/vendor identity.
  const requiredMask = buildComboIdentityMaskText(comboName);
  if (!requiredMask) return body;

  const customMask =
    typeof comboIdentityMask === "string" &&
    comboIdentityMask.trim() &&
    comboIdentityMask.trim().toLowerCase() !== "false"
      ? comboIdentityMask.trim()
      : null;
  const text = customMask ? `${customMask}\n\n${requiredMask}` : requiredMask;
  return injectIdentityMask(body, text);
}

/**
 * Inject an identity-mask instruction into the request's system carrier.
 *
 * Carrier selection mirrors injectSystemPromptPostTranslation:
 *  - claude bodies: top-level `system` (string or block array), created if absent
 *  - gemini bodies: `systemInstruction` parts
 *  - responses API: `instructions` string
 *  - openai/codex (default): first messages[] system/developer message, else a new
 *    system message at the front
 *
 * When `targetFormat` is unknown (client-format body at combo phase), carriers are
 * detected by shape: instructions → claude system → messages.
 */
export function injectIdentityMask(
  body: Record<string, unknown>,
  text: string,
  targetFormat?: string
): Record<string, unknown> {
  if (!isRecord(body)) return body;
  const mask = text.trim();
  if (!mask) return body;

  const result: Record<string, unknown> = { ...body };

  // Claude-format system carrier (string or block array).
  if (targetFormat === "claude" || result.system !== undefined) {
    if (typeof result.system === "string") {
      result.system = result.system + "\n\n" + mask;
    } else if (Array.isArray(result.system)) {
      result.system = [...result.system, { type: "text", text: mask }];
    } else {
      result.system = mask;
    }
    return result;
  }

  // Gemini-format systemInstruction.
  if (targetFormat === "gemini") {
    if (isRecord(result.systemInstruction)) {
      const parts = Array.isArray(result.systemInstruction.parts)
        ? [...result.systemInstruction.parts]
        : [];
      parts.push({ text: mask });
      result.systemInstruction = {
        ...result.systemInstruction,
        role: (result.systemInstruction.role as string) || "system",
        parts,
      };
    } else {
      result.systemInstruction = { role: "system", parts: [{ text: mask }] };
    }
    return result;
  }

  // Responses-API instructions (string).
  if (targetFormat === "openai-responses" || result.instructions !== undefined) {
    const base = typeof result.instructions === "string" ? result.instructions : "";
    result.instructions = base ? base + "\n\n" + mask : mask;
    return result;
  }

  if (result.messages && Array.isArray(result.messages)) {
    const messages = [...result.messages];
    const sysIdx = messages.findIndex(
      (m) => isRecord(m) && (m.role === "system" || m.role === "developer")
    );
    if (sysIdx >= 0 && isRecord(messages[sysIdx])) {
      const msg = { ...messages[sysIdx] };
      if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: mask }];
      } else {
        msg.content = `${(msg.content as string) || ""}\n\n${mask}`;
      }
      messages[sysIdx] = msg;
    } else {
      messages.unshift({ role: "system", content: mask });
    }
    result.messages = messages;
    return result;
  }

  return result;
}
