export const API_KEY_PLAN_IDS = ["3d", "7d", "15d", "30d"] as const;

export type ApiKeyPlanId = (typeof API_KEY_PLAN_IDS)[number];

export const API_KEY_PLAN_DAYS: Record<ApiKeyPlanId, number> = {
  "3d": 3,
  "7d": 7,
  "15d": 15,
  "30d": 30,
};

export const API_KEY_PLAN_DAY_MS = 24 * 60 * 60 * 1000;

export function getApiKeyPlanDays(planId: string | null | undefined): number | null {
  if (!planId) return null;
  return API_KEY_PLAN_DAYS[planId as ApiKeyPlanId] ?? null;
}

export function planExpiryDate(baseMs: number, planDays: number): string {
  return new Date(baseMs + planDays * API_KEY_PLAN_DAY_MS).toISOString();
}
