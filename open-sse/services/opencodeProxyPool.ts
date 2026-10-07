/**
 * Shared OpenCode no-auth proxy pool.
 *
 * OpenCode no-auth requests do not carry customer credentials upstream, so proxy
 * egress can be shared across clients instead of treating each fingerprint as a
 * permanently pinned proxy. The pool is process-wide (globalThis) so the same
 * healthy proxy can serve many executor requests and both OpenCode Zen/Go aliases.
 *
 * Fair-use rule: provider/model rate limits are respected. A 429 that looks like a
 * real rate-limit is cooled only for that proxy + provider + model scope, while a
 * transport failure cools the proxy globally. This prevents one model's quota event
 * from unnecessarily ejecting a healthy proxy for every other customer/model.
 */

import { proxyEgressKey } from "../utils/proxyRefusalMemory.ts";
import { classifyUpstream429, parseRetryAfterSeconds } from "../executors/opencodeRateLimited.ts";

export interface SharedOpenCodeProxy {
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  relayAuth?: string;
}

export interface SharedOpenCodeProxyLease {
  key: string;
  proxy: SharedOpenCodeProxy;
}

type ScopeState = {
  until: number;
  failures: number;
};

type Member = {
  key: string;
  proxy: SharedOpenCodeProxy;
  latencyMs: number;
  samples: number;
  inflight: number;
  transportUntil: number;
  transportFailures: number;
  lastUsedAt: number;
  scopes: Map<string, ScopeState>;
};

type Pool = {
  members: Map<string, Member>;
};

const POOL_KEY = "__omniroute_opencode_shared_proxy_pool_v1__";
const DEFAULT_LATENCY_MS = 650;
const MIN_SCOPE_COOLDOWN_MS = 1000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const MAX_SCOPE_COOLDOWN_MS = 15 * 60_000;
const TRANSPORT_BASE_COOLDOWN_MS = 5_000;
const TRANSPORT_MAX_COOLDOWN_MS = 5 * 60_000;
const MAX_MEMBERS = 4096;

function getPool(): Pool {
  const globalState = globalThis as typeof globalThis & { [POOL_KEY]?: Pool };
  if (!globalState[POOL_KEY]) globalState[POOL_KEY] = { members: new Map() };
  return globalState[POOL_KEY]!;
}

function cloneProxy(proxy: SharedOpenCodeProxy): SharedOpenCodeProxy {
  return { ...proxy };
}

function scopeKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function isEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.OMNIROUTE_OPENCODE_SHARED_PROXY_POOL;
  return !raw || !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

function normalizeProxy(proxy: unknown): SharedOpenCodeProxy | null {
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return null;
  const value = proxy as Record<string, unknown>;
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const port = Number(value.port);
  if (!host || !type || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    type,
    host,
    port,
    ...(typeof value.username === "string" && value.username ? { username: value.username } : {}),
    ...(typeof value.password === "string" && value.password ? { password: value.password } : {}),
    ...(typeof value.relayAuth === "string" && value.relayAuth ? { relayAuth: value.relayAuth } : {}),
  };
}

export function isOpenCodeSharedProxyPoolEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isEnabled(env);
}

export function registerOpenCodeSharedProxies(proxies: unknown[]): number {
  const pool = getPool();
  let registered = 0;
  for (const raw of proxies) {
    const proxy = normalizeProxy(raw);
    if (!proxy) continue;
    const key = proxyEgressKey(proxy);
    if (!key) continue;

    const existing = pool.members.get(key);
    if (existing) {
      existing.proxy = cloneProxy(proxy);
      continue;
    }

    if (pool.members.size >= MAX_MEMBERS) {
      const oldest = [...pool.members.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) pool.members.delete(oldest.key);
    }

    pool.members.set(key, {
      key,
      proxy: cloneProxy(proxy),
      latencyMs: DEFAULT_LATENCY_MS,
      samples: 0,
      inflight: 0,
      transportUntil: 0,
      transportFailures: 0,
      lastUsedAt: 0,
      scopes: new Map(),
    });
    registered++;
  }
  return registered;
}

function scopeReady(member: Member, scope: string, now: number): boolean {
  if (member.transportUntil > now) return false;
  const state = member.scopes.get(scope);
  return !state || state.until <= now;
}

function score(member: Member): number {
  const base = member.samples > 0 ? member.latencyMs : DEFAULT_LATENCY_MS;
  const loadPenalty = member.inflight * Math.max(75, Math.min(750, base * 0.35));
  const failurePenalty = Math.min(5000, member.transportFailures * 500);
  const explorationBonus = member.samples === 0 ? -150 : 0;
  return base + loadPenalty + failurePenalty + explorationBonus;
}

export function getOpenCodeSharedProxyPoolSize(): number {
  return getPool().members.size;
}

export interface OpenCodeSharedProxyCandidate {
  key: string;
  proxy: SharedOpenCodeProxy;
  cooldownUntil: number;
  latencyMs: number;
  inflight: number;
}

export function getOpenCodeSharedProxyCandidates(
  provider: string,
  model: string,
  now: number = Date.now()
): OpenCodeSharedProxyCandidate[] {
  const pool = getPool();
  const scope = scopeKey(provider, model);
  const candidates = [...pool.members.values()]
    .map((member) => {
      const scoped = member.scopes.get(scope);
      const cooldownUntil = Math.max(member.transportUntil, scoped?.until ?? 0);
      return {
        member,
        cooldownUntil,
      };
    })
    .filter(({ cooldownUntil }) => cooldownUntil <= now)
    .sort((a, b) => {
      const delta = score(a.member) - score(b.member);
      if (delta !== 0) return delta;
      return a.member.lastUsedAt - b.member.lastUsedAt;
    });

  return candidates.map(({ member, cooldownUntil }) => ({
    key: member.key,
    proxy: cloneProxy(member.proxy),
    cooldownUntil,
    latencyMs: member.latencyMs,
    inflight: member.inflight,
  }));
}

export function acquireOpenCodeSharedProxy(
  provider: string,
  model: string,
  now: number = Date.now()
): SharedOpenCodeProxyLease | null {
  const pool = getPool();
  const scope = scopeKey(provider, model);
  const candidates = [...pool.members.values()]
    .filter((member) => scopeReady(member, scope, now))
    .sort((a, b) => {
      const delta = score(a) - score(b);
      if (delta !== 0) return delta;
      return a.lastUsedAt - b.lastUsedAt;
    });

  const member = candidates[0];
  if (!member) return null;

  member.inflight++;
  member.lastUsedAt = now;
  return { key: member.key, proxy: cloneProxy(member.proxy) };
}

function updateLatency(member: Member, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const sample = Math.max(1, Math.min(latencyMs, 120_000));
  member.latencyMs =
    member.samples === 0 ? sample : member.latencyMs * 0.75 + sample * 0.25;
  member.samples++;
}

function scopeFailure(
  member: Member,
  scope: string,
  cooldownMs: number,
  now: number
): void {
  const current = member.scopes.get(scope);
  const failures = (current?.failures ?? 0) + 1;
  const capped = Math.min(Math.max(cooldownMs, MIN_SCOPE_COOLDOWN_MS), MAX_SCOPE_COOLDOWN_MS);
  member.scopes.set(scope, { until: now + capped, failures });
}

function transportFailure(member: Member, now: number): void {
  member.transportFailures++;
  const cooldown = Math.min(
    TRANSPORT_BASE_COOLDOWN_MS * 2 ** (member.transportFailures - 1),
    TRANSPORT_MAX_COOLDOWN_MS
  );
  member.transportUntil = now + cooldown;
}

function clearScope(member: Member, scope: string): void {
  member.scopes.delete(scope);
}

export async function releaseOpenCodeSharedProxy(
  lease: SharedOpenCodeProxyLease,
  input: {
    provider: string;
    model: string;
    status?: number | null;
    latencyMs?: number;
    transportError?: boolean;
    response?: Response | null;
  }
): Promise<void> {
  const pool = getPool();
  const member = pool.members.get(lease.key);
  if (!member) return;

  member.inflight = Math.max(0, member.inflight - 1);
  const now = Date.now();
  updateLatency(member, input.latencyMs ?? 0);

  if (input.transportError) {
    transportFailure(member, now);
    return;
  }

  const status = input.status ?? 0;
  const scope = scopeKey(input.provider, input.model);

  if (status >= 200 && status < 300) {
    member.transportFailures = 0;
    member.transportUntil = 0;
    clearScope(member, scope);
    return;
  }

  if (status === 429 && input.response) {
    let verdict: "rate_limited" | "burst" = "burst";
    try {
      verdict = await classifyUpstream429(input.response);
    } catch {
      verdict = "burst";
    }

    if (verdict === "rate_limited") {
      const retryAfter = parseRetryAfterSeconds(input.response.headers.get("retry-after"));
      const cooldown = retryAfter
        ? Math.min(retryAfter * 1000, MAX_SCOPE_COOLDOWN_MS)
        : RATE_LIMIT_FALLBACK_MS;
      scopeFailure(member, scope, cooldown, now);
    } else {
      scopeFailure(member, scope, MIN_SCOPE_COOLDOWN_MS, now);
    }
    return;
  }

  // 5xx is treated as provider/model transient state, not automatic proxy death.
  // Keep the proxy available to other models/clients while reducing this scope's score.
  if (status >= 500 && status < 600) {
    scopeFailure(member, scope, 2500, now);
    return;
  }

  // Other non-success statuses do not poison the shared proxy.
  clearScope(member, scope);
}

export function __getOpenCodeSharedProxyStatsForTest(): Array<{
  key: string;
  latencyMs: number;
  samples: number;
  inflight: number;
  transportUntil: number;
  transportFailures: number;
  scopes: Record<string, ScopeState>;
}> {
  return [...getPool().members.values()].map((member) => ({
    key: member.key,
    latencyMs: member.latencyMs,
    samples: member.samples,
    inflight: member.inflight,
    transportUntil: member.transportUntil,
    transportFailures: member.transportFailures,
    scopes: Object.fromEntries(member.scopes),
  }));
}

export function __resetOpenCodeSharedProxyPoolForTest(): void {
  const globalState = globalThis as typeof globalThis & { [POOL_KEY]?: Pool };
  delete globalState[POOL_KEY];
}
