// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Import component (no module-level mocks needed) ──────────────────────────

const { default: NoAuthAccountCard } =
  await import("../../../src/shared/components/NoAuthAccountCard");

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROVIDER_ID = "mimocode";

function makeFingerprints(n: number): string[] {
  // Deterministic, distinguishable, > 10 chars each so the truncation is exercised.
  return Array.from({ length: n }, (_, i) => `fp${String(i).padStart(2, "0")}deadbeefcafe`);
}

function setupFetch(fingerprints: string[]) {
  const connections =
    fingerprints.length > 0
      ? [
          {
            id: "conn-1",
            provider: PROVIDER_ID,
            providerSpecificData: { fingerprints, accountProxies: [] },
          },
        ]
      : [];
  const mockFetch = vi.fn((url: string) => {
    if (String(url).includes("/api/providers")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ connections }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderCard(enableBulkAccountAdd = false, providerId = PROVIDER_ID) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let counter = 0;
  act(() => {
    root.render(
      <NoAuthAccountCard
        providerId={providerId}
        providerName="MiMoCode"
        generateAccountId={() => `gen-${counter++}`}
        enableBulkAccountAdd={enableBulkAccountAdd}
      />
    );
  });
  containers.push({ root, el });
  return el;
}

async function waitForCondition(fn: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const grid = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-testid='noauth-account-grid']");

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("NoAuthAccountCard compact grid", () => {
  it("renders the account list as a multi-column grid container", async () => {
    setupFetch(makeFingerprints(15));
    const el = renderCard();
    await waitForCondition(() => grid(el) !== null);
    const container = grid(el)!;
    // Must be a responsive grid (not the old single-column stack) so 15 accounts stay compact.
    expect(container.className).toContain("grid");
    expect(container.className).toMatch(/sm:grid-cols-2|lg:grid-cols-3/);
  });

  it("renders one chip per account fingerprint", async () => {
    setupFetch(makeFingerprints(15));
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 15);
    expect(grid(el)!.querySelectorAll("[data-account-id]").length).toBe(15);
  });

  it("constrains height with vertical scroll so a long list never grows unbounded", async () => {
    setupFetch(makeFingerprints(15));
    const el = renderCard();
    await waitForCondition(() => grid(el) !== null);
    const container = grid(el)!;
    expect(container.className).toContain("overflow-y-auto");
    expect(container.className).toMatch(/max-h-/);
  });

  it("keeps a proxy control on every chip (shield icon)", async () => {
    setupFetch(makeFingerprints(3));
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 3);
    const chips = Array.from(grid(el)!.querySelectorAll<HTMLElement>("[data-account-id]"));
    for (const chip of chips) {
      const proxyBtn = chip.querySelector("button[title]");
      expect(proxyBtn).toBeTruthy();
      expect(proxyBtn!.textContent).toContain("shield");
    }
  });

  it("opens the proxy editor when a chip's shield is clicked", async () => {
    setupFetch(makeFingerprints(3));
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 3);
    const firstChip = grid(el)!.querySelector<HTMLElement>("[data-account-id]")!;
    const proxyBtn = firstChip.querySelector<HTMLButtonElement>("button[title]")!;
    act(() => {
      proxyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForCondition(() => el.textContent?.includes("Proxy for Account 1") ?? false);
    expect(el.textContent).toContain("Proxy for Account 1");
    // No saved proxies in this fixture → editor falls back to the custom inputs.
    expect(el.querySelector("input[placeholder='Host']")).toBeTruthy();
  });
});

// ── #5217 (Gap 1): Proxy Pool dropdown (by-id reference) ──────────────────────

const SAVED_PROXIES = [
  { id: "pool-1", name: "US East", type: "socks5", host: "1.2.3.4", port: 1080, status: "active" },
  { id: "pool-2", name: "EU West", type: "http", host: "9.9.9.9", port: 8080, status: "active" },
];

function setupFetchWithProxies(
  fingerprints: string[],
  accountProxies: unknown[] = [],
  providerId = PROVIDER_ID
) {
  const connections = [
    {
      id: "conn-1",
      provider: providerId,
      providerSpecificData: { fingerprints, accountProxies },
    },
  ];
  const putBodies: unknown[] = [];
  const bulkBodies: unknown[] = [];
  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/settings/proxies")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: SAVED_PROXIES }),
      } as Response);
    }
    if (u.includes("/api/providers/noauth-bulk")) {
      if (init?.method === "POST" && typeof init.body === "string") {
        const parsed = JSON.parse(init.body);
        bulkBodies.push(parsed);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: parsed.accountIds?.length ?? 0,
              failed: 0,
              total: parsed.accountIds?.length ?? 0,
            }),
        } as Response);
      }
    }
    if (u.includes("/api/providers")) {
      if (init?.method === "PUT" && typeof init.body === "string") {
        putBodies.push(JSON.parse(init.body));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ connections }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", mockFetch);
  return { mockFetch, putBodies, bulkBodies };
}

describe("NoAuthAccountCard bulk account add", () => {
  it("adds 100 generated accounts through one bulk connection request", async () => {
    const fps = makeFingerprints(2);
    const { putBodies, bulkBodies } = setupFetchWithProxies(fps, [], "opencode");
    const el = renderCard(true, "opencode");
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);

    const countInput = el.querySelector<HTMLInputElement>("[data-testid='bulk-account-count']")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(countInput, "100");
      countInput.dispatchEvent(new Event("input", { bubbles: true }));
      countInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitForCondition(() => el.textContent?.includes("Add Account ×100") ?? false);
    const addBtn = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Account ×100")
    )!;
    act(() => addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await waitForCondition(() => bulkBodies.length > 0);
    expect(putBodies).toHaveLength(0);
    expect(bulkBodies).toHaveLength(1);
    const body = bulkBodies[0] as { provider?: string; accountIds?: string[] };
    expect(body.provider).toBe("opencode");
    expect(body.accountIds).toHaveLength(100);
    expect(body.accountIds).toEqual(
      Array.from({ length: 100 }, (_, index) => `gen-${index}`)
    );
  });

  it("clamps a bulk add operation to 1000 accounts", async () => {
    const fps = makeFingerprints(1);
    const { bulkBodies } = setupFetchWithProxies(fps, [], "opencode");
    const el = renderCard(true, "opencode");
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 1);

    const countInput = el.querySelector<HTMLInputElement>("[data-testid='bulk-account-count']")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(countInput, "5000");
      countInput.dispatchEvent(new Event("input", { bubbles: true }));
      countInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const addBtn = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Account ×1000")
    )!;
    act(() => addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await waitForCondition(() => bulkBodies.length > 0);
    const body = bulkBodies[0] as { accountIds?: string[] };
    expect(body.accountIds).toHaveLength(1000);
  });
});

describe("NoAuthAccountCard proxy pool dropdown (#5217 Gap 1)", () => {
  it("defaults the editor to the Saved Proxy Pool dropdown when pool proxies exist", async () => {
    setupFetchWithProxies(makeFingerprints(2));
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);
    const proxyBtn = grid(el)!
      .querySelector<HTMLElement>("[data-account-id]")!
      .querySelector<HTMLButtonElement>("button[title]")!;
    act(() => proxyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitForCondition(() => el.textContent?.includes("Proxy for Account 1") ?? false);
    // The saved dropdown lists every pool proxy by name; the manual Host input is hidden.
    const select = el.querySelector<HTMLSelectElement>("select")!;
    expect(select).toBeTruthy();
    expect(el.textContent).toContain("US East");
    expect(el.textContent).toContain("EU West");
    expect(el.querySelector("input[placeholder='Host']")).toBeNull();
  });

  it("persists a by-id reference {fingerprint, proxyId} when a pool proxy is selected", async () => {
    const fps = makeFingerprints(2);
    const { putBodies } = setupFetchWithProxies(fps);
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);
    const proxyBtn = grid(el)!
      .querySelector<HTMLElement>("[data-account-id]")!
      .querySelector<HTMLButtonElement>("button[title]")!;
    act(() => proxyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitForCondition(() => el.querySelector("select") !== null);

    const select = el.querySelector<HTMLSelectElement>("select")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(select, "pool-2");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save"
    )!;
    act(() => saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await waitForCondition(() => putBodies.length > 0);
    const body = putBodies.at(-1) as { providerSpecificData?: { accountProxies?: unknown[] } };
    const stored = body.providerSpecificData?.accountProxies ?? [];
    expect(stored).toEqual([{ fingerprint: fps[0], proxyId: "pool-2" }]);
  });

  it("lights the shield for an account stored as a by-id reference", async () => {
    const fps = makeFingerprints(2);
    setupFetchWithProxies(fps, [{ fingerprint: fps[0], proxyId: "pool-1" }]);
    const el = renderCard();
    await waitForCondition(() => grid(el)?.querySelectorAll("[data-account-id]").length === 2);
    const firstShield = grid(el)!
      .querySelector<HTMLElement>("[data-account-id]")!
      .querySelector<HTMLButtonElement>("button[title]")!;
    // Tooltip is resolved from the referenced pool record, not an inline proxy.
    expect(firstShield.getAttribute("title")).toContain("1.2.3.4");
    expect(firstShield.className).toContain("text-blue-400");
  });
});
