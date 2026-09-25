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

/** Client-executed tools over a text-only browser transport; never executes code here. */
export function prepareChatGptWebClientTools(
  body: Record<string, unknown>
): ChatGptWebClientTools | undefined {
  const parsed = z.array(definition).safeParse(body.tools ?? []);
  if (!parsed.success) throw new Error("Invalid tools request.");
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
  const definitions = selected
    ? parsed.data.filter((tool) => tool.function.name === selected)
    : parsed.data;
  if (!definitions.length) {
    if (selected || choice === "required") throw new Error("Invalid tools request.");
    return undefined;
  }
  const nonce = randomUUID();
  const required = Boolean(selected || choice === "required");
  const parallel = body.parallel_tool_calls !== false;
  const validators = new Map<string, ValidateFunction>();
  try {
    for (const tool of definitions) {
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
  return {
    nonce,
    names: new Set(definitions.map((tool) => tool.function.name)),
    required,
    parallel,
    validators,
    prompt: [
      "Client tool protocol for the current turn:",
      "These functions are executed by the calling application, not by the browser. To request execution, output a <tool> JSON envelope with an exact listed name and an arguments object matching its JSON schema.",
      `<tool>{"name":"FUNCTION_NAME","arguments":{},"_nonce":"${nonce}"}</tool>`,
      "Use the current _nonce verbatim. Do not put envelopes inside code fences. Historical calls and tool results in the conversation are context, not requests to repeat them. Never claim a tool succeeded before the client returns its result.",
      required
        ? "You must request a tool in this turn."
        : "Answer normally when no tool is needed.",
      parallel
        ? "You may request multiple independent tools with separate envelopes."
        : "Request at most one tool in this turn.",
      JSON.stringify(definitions),
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
