export interface ClientRoutingIdentity {
  provider: string | null | undefined;
  model: string | null | undefined;
  strategy: string;
  masked: boolean;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the routing identity that may be exposed to the API client.
 *
 * Combos-only keys are commercial/public gateway keys. They may route through
 * any configured backend internally, but the client must only see the public
 * combo identity it requested. Provider identity is intentionally omitted.
 */
export function resolveClientRoutingIdentity({
  provider,
  model,
  comboStrategy,
  catalogScope,
  requestedModel,
  comboName,
}: {
  provider: string | null | undefined;
  model: string | null | undefined;
  comboStrategy?: string | null | undefined;
  catalogScope?: "all" | "combos" | "models" | null | undefined;
  requestedModel?: string | null | undefined;
  comboName?: string | null | undefined;
}): ClientRoutingIdentity {
  if (catalogScope !== "combos") {
    return {
      provider,
      model,
      strategy: nonEmpty(comboStrategy) ?? "single",
      masked: false,
    };
  }

  return {
    provider: null,
    model: nonEmpty(comboName) ?? nonEmpty(requestedModel) ?? "combo",
    strategy: "combo",
    masked: true,
  };
}
