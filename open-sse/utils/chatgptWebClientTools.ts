import { randomUUID } from "node:crypto";
import { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { OpenAIToolCall } from "../translator/webTools.ts";

const definition = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});
const envelope = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  _nonce: z.string(),
});

export interface ChatGptWebClientTools {
  prompt: string;
  nonce: string;
  names: Set<string>;
  required: boolean;
  parallel: boolean;
  validators: Map<string, ValidateFunction>;
}

const MAX_CLIENT_TOOL_DEFINITIONS_CHARS = 16_000;
const MAX_TOOL_DESCRIPTION_CHARS = 160;

function compactToolSchemaValue(
  value: unknown,
  options: { dropDescriptions?: boolean; minimal?: boolean } = {},
  depth = 0
): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => compactToolSchemaValue(entry, options, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const noisyKeys = new Set([
    "$schema",
    "$id",
    "$comment",
    "examples",
    "example",
    "title",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
  ]);
  const minimalKeys = new Set([
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
    "additionalProperties",
    "$ref",
    "$defs",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ]);

  for (const [key, raw] of Object.entries(source)) {
    if (noisyKeys.has(key)) continue;
    if (options.minimal && !minimalKeys.has(key)) continue;
    if (key === "description") {
      if (options.dropDescriptions || options.minimal || typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed) out.description = trimmed.slice(0, MAX_TOOL_DESCRIPTION_CHARS);
      continue;
    }
    const compacted = compactToolSchemaValue(raw, options, depth + 1);
    if (compacted !== undefined) out[key] = compacted;
  }
  return out;
}

function compactDefinitionsJson(
  definitions: Array<z.infer<typeof definition>>
): string {
  const make = (options: { dropDescriptions?: boolean; minimal?: boolean }) =>
    definitions.map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        ...(options.dropDescriptions || options.minimal || !tool.function.description
          ? {}
          : {
              description: tool.function.description
                .trim()
                .slice(0, MAX_TOOL_DESCRIPTION_CHARS),
            }),
        parameters: compactToolSchemaValue(
          tool.function.parameters ?? { type: "object" },
          options
        ),
      },
    }));

  let json = JSON.stringify(make({}));
  if (json.length <= MAX_CLIENT_TOOL_DEFINITIONS_CHARS) return json;

  json = JSON.stringify(make({ dropDescriptions: true }));
  if (json.length <= MAX_CLIENT_TOOL_DEFINITIONS_CHARS) return json;

  // Last-resort structural form: preserve function names, parameter names/types,
  // required arrays and validation primitives while dropping all prose metadata.
  // Runtime validation still uses the original full schemas below.
  return JSON.stringify(make({ dropDescriptions: true, minimal: true }));
}

/** Client-executed tools over a text-only browser transport; never executes code here. */
export function prepareChatGptWebClientTools(
  body: Record<string, unknown>
): ChatGptWebClientTools | undefined {
  if (body.tools === undefined) return undefined;
  if (!Array.isArray(body.tools)) throw new Error("Invalid tools request.");
  const definitions = body.tools.flatMap((tool) => {
    const record = tool && typeof tool === "object" && !Array.isArray(tool) ? tool : null;
    if (record && "type" in record && record.type !== "function") return [];
    const parsed = definition.safeParse(tool);
    if (!parsed.success) throw new Error("Invalid tools request.");
    return [parsed.data];
  });
  const choice = body.tool_choice ?? "auto";
  if (choice === "none") return undefined;
  let selected: string | undefined;
  if (typeof choice === "object" && choice !== null) {
    const forced = z
      .object({ type: z.literal("function"), function: z.object({ name: z.string().min(1) }) })
      .safeParse(choice);
    if (!forced.success) throw new Error("Invalid tools request.");
    selected = forced.data.function.name;
  } else if (choice !== "auto" && choice !== "required") {
    throw new Error("Invalid tools request.");
  }
  const selectedDefinitions = selected
    ? definitions.filter((tool) => tool.function.name === selected)
    : definitions;
  if (!selectedDefinitions.length) {
    if (selected || choice === "required") throw new Error("Invalid tools request.");
    return undefined;
  }
  const nonce = randomUUID();
  const required = Boolean(selected || choice === "required");
  const parallel = body.parallel_tool_calls !== false;
  const validators = new Map<string, ValidateFunction>();
  try {
    for (const tool of selectedDefinitions) {
      const schema = tool.function.parameters ?? { type: "object" };
      const Validator = String(schema.$schema ?? "").includes("2020-12") ? Ajv2020 : Ajv;
      validators.set(
        tool.function.name,
        new Validator({ strict: false, validateFormats: false }).compile(schema)
      );
    }
  } catch {
    throw new Error("Invalid tools request.");
  }
  const promptDefinitions = compactDefinitionsJson(selectedDefinitions);
  return {
    nonce,
    names: new Set(selectedDefinitions.map((tool) => tool.function.name)),
    required,
    parallel,
    validators,
    prompt: [
      "Client tool protocol for the current turn:",
      "These functions are executed by the calling application. Request one with an exact listed name and arguments matching its schema.",
      `<tool>{"name":"FUNCTION_NAME","arguments":{},"_nonce":"${nonce}"}</tool>`,
      "Use the current _nonce verbatim. No code fences. Never claim a tool succeeded before the client returns its result.",
      required
        ? "MANDATORY TOOL CALL: return only the required <tool> envelope(s), no prose."
        : "Answer normally when no client tool is needed; use a client tool when execution is required.",
      parallel
        ? "Independent tools may be requested with separate envelopes."
        : "Request at most one tool in this turn.",
      promptDefinitions,
    ].join("\n"),
  };
}

/** Strict request-bound envelopes only. Never fuzzy-match or invent tool names. */
export function parseChatGptWebClientTools(
  text: string,
  tools?: ChatGptWebClientTools
): { content: string; toolCalls: OpenAIToolCall[] } {
  if (!tools) return { content: text, toolCalls: [] };
  const toolCalls: OpenAIToolCall[] = [];
  const content = text.replace(
    /<tool>([\s\S]*?)<\/tool>/g,
    (_block, raw: string, offset: number) => {
      // Code examples must never be promoted to executable client calls.
      if ((text.slice(0, offset).match(/```/g)?.length ?? 0) % 2 !== 0)
        throw new Error("Invalid tool response.");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("Invalid tool response.");
      }
      const parsed = envelope.safeParse(value);
      if (
        !parsed.success ||
        parsed.data._nonce !== tools.nonce ||
        !tools.names.has(parsed.data.name)
      ) {
        throw new Error("Invalid tool response.");
      }
      if (!tools.validators.get(parsed.data.name)?.(parsed.data.arguments))
        throw new Error("Invalid tool response.");
      toolCalls.push({
        id: `call_${randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: { name: parsed.data.name, arguments: JSON.stringify(parsed.data.arguments) },
      });
      return "";
    }
  );
  if (
    content.includes("<tool>") ||
    content.includes("</tool>") ||
    (tools.required && !toolCalls.length) ||
    (!tools.parallel && toolCalls.length > 1)
  ) {
    throw new Error("Invalid tool response.");
  }
  return { content: toolCalls.length ? content.trim() : content, toolCalls };
}
