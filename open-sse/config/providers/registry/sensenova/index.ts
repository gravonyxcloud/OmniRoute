import type { RegistryEntry } from "../../shared.ts";

export const sensenovaProvider: RegistryEntry = {
  id: "sensenova",
  alias: "sensenova",
  format: "openai",
  executor: "default",
  baseUrl: "https://token.sensenova.ai/v1/chat/completions",
  modelsUrl: "https://token.sensenova.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  // SenseNova Token Plan international endpoint (validated from official 6.8 docs).
  // OpenAI-compatible Bearer-token API. SenseNova 6.8 Flash Lite supports
  // multimodal input, streaming, agent/tool workflows and returns reasoning
  // deltas in the OpenAI-compatible stream.
  models: [
    {
      id: "sensenova-6.8-flash-lite",
      name: "SenseNova 6.8 Flash Lite",
      contextLength: 262144,
      maxOutputTokens: 65536,
      supportsVision: true,
      toolCalling: true,
      supportsReasoning: true,
      interleavedField: "reasoning",
    },
  ],
};
