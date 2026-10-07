import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetOpenCodeSharedProxyPoolForTest,
  acquireOpenCodeSharedProxy,
  getOpenCodeSharedProxyCandidates,
  registerOpenCodeSharedProxies,
  releaseOpenCodeSharedProxy,
} from "../../open-sse/services/opencodeProxyPool.ts";
import { proxyEgressKey } from "../../open-sse/utils/proxyRefusalMemory.ts";

const A = { type: "http", host: "10.0.0.1", port: 8080 };
const B = { type: "http", host: "10.0.0.2", port: 8080 };

beforeEach(() => {
  __resetOpenCodeSharedProxyPoolForTest();
});

test("shares the fastest healthy proxy across multiple concurrent noauth requests", async () => {
  registerOpenCodeSharedProxies([A, B]);

  const first = acquireOpenCodeSharedProxy("opencode-zen", "space-bunny-free");
  assert.ok(first);
  const second = acquireOpenCodeSharedProxy("opencode-zen", "space-bunny-free");
  assert.ok(second);
  assert.notEqual(first!.key, second!.key, "initial probes should spread across the two proxies");

  await releaseOpenCodeSharedProxy(first!, {
    provider: "opencode-zen",
    model: "space-bunny-free",
    status: 200,
    latencyMs: 40,
  });
  await releaseOpenCodeSharedProxy(second!, {
    provider: "opencode-zen",
    model: "space-bunny-free",
    status: 200,
    latencyMs: 900,
  });

  const ranked = getOpenCodeSharedProxyCandidates("opencode-zen", "space-bunny-free");
  assert.equal(ranked[0]?.key, proxyEgressKey(A));
  const sharedAgain = acquireOpenCodeSharedProxy("opencode-zen", "space-bunny-free");
  assert.equal(sharedAgain?.key, proxyEgressKey(A));
});

test("a real rate limit cools only that proxy + provider/model scope", async () => {
  registerOpenCodeSharedProxies([A, B]);
  const leaseA = acquireOpenCodeSharedProxy("opencode-zen", "space-bunny-free");
  assert.ok(leaseA);

  await releaseOpenCodeSharedProxy(leaseA!, {
    provider: "opencode-zen",
    model: "space-bunny-free",
    status: 429,
    response: new Response("", { status: 429, headers: { "retry-after": "60" } }),
    latencyMs: 100,
  });

  const sameScope = getOpenCodeSharedProxyCandidates("opencode-zen", "space-bunny-free");
  assert.ok(!sameScope.some((x) => x.key === leaseA!.key), "rate-limited proxy must leave this scope temporarily");

  const differentModel = getOpenCodeSharedProxyCandidates("opencode-zen", "another-model");
  assert.ok(differentModel.some((x) => x.key === leaseA!.key), "other models must keep using the healthy proxy");
});

test("a transport failure cools the proxy globally so other clients fail over quickly", async () => {
  registerOpenCodeSharedProxies([A, B]);
  const leaseA = acquireOpenCodeSharedProxy("opencode-zen", "big-pickle");
  assert.ok(leaseA);

  await releaseOpenCodeSharedProxy(leaseA!, {
    provider: "opencode-zen",
    model: "big-pickle",
    transportError: true,
    latencyMs: 5000,
  });

  const zen = getOpenCodeSharedProxyCandidates("opencode-zen", "big-pickle");
  const go = getOpenCodeSharedProxyCandidates("opencode-go", "big-pickle");
  assert.ok(!zen.some((x) => x.key === leaseA!.key));
  assert.ok(!go.some((x) => x.key === leaseA!.key));
});
