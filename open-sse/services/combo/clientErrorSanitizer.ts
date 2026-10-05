type JsonRecord = Record<string, unknown>;

function publicComboName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("combo/") ? trimmed : `combo/${trimmed}`;
}

function collectInternalIdentifiers(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      out.add(trimmed);
      const slash = trimmed.indexOf("/");
      if (slash > 0 && slash < trimmed.length - 1) {
        out.add(trimmed.slice(0, slash));
        out.add(trimmed.slice(slash + 1));
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInternalIdentifiers(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (
        key === "provider" ||
        key === "providerId" ||
        key === "model" ||
        key === "modelStr" ||
        key === "executionKey"
      ) {
        collectInternalIdentifiers(item, out);
      } else if (key === "models" || key === "targets" || key === "steps") {
        collectInternalIdentifiers(item, out);
      }
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeString(value: string, comboName: string, identifiers: Set<string>): string {
  let output = value;
  const publicName = publicComboName(comboName);

  output = output.replace(/\bOmniRoute\b/gi, publicName);

  for (const identifier of [...identifiers].sort((a, b) => b.length - a.length)) {
    if (!identifier || identifier === comboName || identifier === publicName) continue;
    output = output.replace(new RegExp(escapeRegExp(identifier), "gi"), publicName);
  }

  output = output.replace(
    /\b(?!combo\/|auto\/)[a-z0-9][a-z0-9._-]{1,63}\/[a-z0-9][a-z0-9._:+-]{1,127}\b/gi,
    publicName
  );

  return output;
}

function sanitizeValue(value: unknown, comboName: string, identifiers: Set<string>, key = ""): unknown {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "provider" || normalizedKey === "provider_id" || normalizedKey === "providerid") {
    return undefined;
  }
  if (normalizedKey === "model" || normalizedKey === "model_id" || normalizedKey === "modelid" || normalizedKey === "modelstr") {
    return publicComboName(comboName);
  }
  if (normalizedKey === "connectionid" || normalizedKey === "connection_id" || normalizedKey === "serviceaccountid" || normalizedKey === "serviceapikeyid") {
    return undefined;
  }
  if (typeof value === "string") return sanitizeString(value, comboName, identifiers);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, comboName, identifiers)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const output: JsonRecord = {};
    for (const [childKey, childValue] of Object.entries(value as JsonRecord)) {
      const sanitized = sanitizeValue(childValue, comboName, identifiers, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return value;
}

export async function sanitizeComboClientErrorResponse(
  response: Response,
  combo: { name: string; models?: unknown; config?: unknown }
): Promise<Response> {
  if (response.status < 400) return response;

  const headers = new Headers(response.headers);
  headers.delete("x-omniroute-selected-connection-id");
  headers.delete("x-omniroute-decision");
  headers.delete("x-omniroute-provider");
  headers.set("x-omniroute-model", publicComboName(combo.name));
  headers.set("x-omniroute-strategy", "combo");

  const identifiers = collectInternalIdentifiers(combo.models);
  const contentType = headers.get("content-type") || "";
  const text = await response.clone().text().catch(() => "");
  if (!text) return new Response(null, { status: response.status, statusText: response.statusText, headers });

  let bodyText = text;
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(text);
      bodyText = JSON.stringify(sanitizeValue(parsed, combo.name, identifiers));
    } catch {
      bodyText = sanitizeString(text, combo.name, identifiers);
    }
  } else {
    bodyText = sanitizeString(text, combo.name, identifiers);
  }

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}