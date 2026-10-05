import { projectClientRoutingErrorMessage } from "./clientRoutingError.ts";

type ProjectionArgs = {
  catalogScope?: string | null;
  comboName?: string | null;
};

function publicCombo(args: ProjectionArgs): string {
  return args.comboName?.trim() || "combo";
}

function projectErrorObject(value: unknown, combo: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const rawMessage = typeof source.message === "string" ? source.message : "Upstream provider error";
  return {
    type: "api_error",
    code: "combo_error",
    message: projectClientRoutingErrorMessage({
      identity: { provider: null, model: combo, strategy: "combo", masked: true },
      statusCode: 502,
      message: rawMessage,
    }),
  };
}
function projectPayload(payload: unknown, combo: string, eventName?: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out = { ...(payload as Record<string, unknown>) };

  if ("model" in out) out.model = combo;
  if ("provider" in out) delete out.provider;

  if (out.message && typeof out.message === "object" && !Array.isArray(out.message)) {
    const message = { ...(out.message as Record<string, unknown>) };
    if ("model" in message) message.model = combo;
    if ("provider" in message) delete message.provider;
    out.message = message;
  }

  if (out.response && typeof out.response === "object" && !Array.isArray(out.response)) {
    const response = { ...(out.response as Record<string, unknown>) };
    if ("model" in response) response.model = combo;
    if ("provider" in response) delete response.provider;
    if ("error" in response) response.error = projectErrorObject(response.error, combo);
    out.response = response;
  }
  const isErrorEvent =
    eventName === "error" || out.type === "error" || ("error" in out && out.error != null);
  if (isErrorEvent) {
    if ("error" in out) out.error = projectErrorObject(out.error, combo);
    if (typeof out.message === "string") {
      out.message = projectClientRoutingErrorMessage({
        identity: { provider: null, model: combo, strategy: "combo", masked: true },
        statusCode: 502,
        message: out.message,
      });
    }
  }

  return out;
}

function projectedHeaders(response: Response, combo: string): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("x-omniroute-connection");
  headers.delete("x-omniroute-connection-id");
  headers.delete("x-omniroute-provider");
  headers.set("X-OmniRoute-Model", combo);
  headers.set("X-OmniRoute-Strategy", "combo");
  return headers;
}
function projectSseBody(body: ReadableStream<Uint8Array>, combo: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let eventName = "";

  const rewriteLine = (rawLine: string): string => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim().toLowerCase();
      return line;
    }
    if (!line.startsWith("data:")) return line;

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      return `data: ${JSON.stringify(projectPayload(JSON.parse(payload), combo, eventName))}`;
    } catch {
      if (eventName !== "error") return line;
      return `data: ${JSON.stringify({
        type: "error",
        error: projectErrorObject({ message: payload }, combo),
      })}`;
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          controller.enqueue(encoder.encode(rewriteLine(line) + "\n"));
          newline = pending.indexOf("\n");
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(rewriteLine(pending)));
      },
    })
  );
}

export async function projectCommercialComboSuccessResponse(
  response: Response,
  args: ProjectionArgs
): Promise<Response> {
  if (!response.ok || args.catalogScope !== "combos") return response;
  const combo = publicCombo(args);
  const headers = projectedHeaders(response, combo);
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("text/event-stream") && response.body) {
    return new Response(projectSseBody(response.body, combo), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (contentType.includes("json")) {
    const raw = await response.text();
    if (!raw) {
      return new Response(raw, { status: response.status, statusText: response.statusText, headers });
    }
    try {
      const projected = projectPayload(JSON.parse(raw), combo);
      return new Response(JSON.stringify(projected), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
