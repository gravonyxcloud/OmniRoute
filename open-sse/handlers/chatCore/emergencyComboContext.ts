export const EMERGENCY_COMBO_CONTEXT_TARGET_RATIO = 0.9;

export function shouldApplyEmergencyComboCompaction(options: {
  isCombo: boolean;
  reactiveContextCompactionEnabled: boolean;
  nativeCodexPassthrough: boolean;
  estimatedInputTokens: number;
  contextLimit: number;
}): boolean {
  if (options.reactiveContextCompactionEnabled) return false;
  if (!options.isCombo || options.nativeCodexPassthrough) return false;
  if (!Number.isFinite(options.contextLimit) || options.contextLimit <= 0) return false;
  return options.estimatedInputTokens >= options.contextLimit;
}

export function resolveEmergencyComboCompactionTarget(options: {
  contextLimit: number;
  toolsReserve: number;
}): number {
  const contextLimit = Math.max(1, Math.floor(options.contextLimit));
  const toolsReserve = Math.max(0, Math.floor(options.toolsReserve));
  const hardCeiling = Math.max(1, contextLimit - toolsReserve - 1);
  const bufferedCeiling = Math.max(
    1,
    Math.floor(contextLimit * EMERGENCY_COMBO_CONTEXT_TARGET_RATIO) - toolsReserve
  );
  return Math.min(hardCeiling, bufferedCeiling);
}
