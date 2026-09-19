"use client";

import { Card } from "@/shared/components";
import { useDisplayBaseUrl } from "@/shared/hooks";

/*
 * Reference page for the plan-based API key endpoints. These endpoints let you
 * auto-provision customer keys that expire automatically and can only call
 * combos built inside OmniRoute. The dashboard UI (/dashboard/api-manager) has
 * an equivalent form; this page documents the raw API surface you can script.
 */

const PLANS: { id: string; days: number; note: string }[] = [
  { id: "3d", days: 3, note: "Short-lived trial / proof-of-concept keys." },
  { id: "7d", days: 7, note: "Weekly plans." },
  { id: "15d", days: 15, note: "Bi-weekly plans." },
  { id: "30d", days: 30, note: "Monthly plans." },
];

const STATUS_COLORS: Record<string, string> = {
  "200": "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  "201": "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  "400": "bg-amber-500/15 text-amber-500 border-amber-500/30",
  "401": "bg-amber-500/15 text-amber-500 border-amber-500/30",
  "403": "bg-red-500/15 text-red-500 border-red-500/30",
  "404": "bg-amber-500/15 text-amber-500 border-amber-500/30",
};

function EndpointBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded border text-[11px] font-bold font-mono ${STATUS_COLORS[status] ?? "bg-gray-500/15 text-gray-500 border-gray-500/30"}`}
    >
      {status}
    </span>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-text-main overflow-x-auto">
      {children}
    </pre>
  );
}

export default function ApiKeyPlansPage() {
  const baseUrl = useDisplayBaseUrl();
  const origin = baseUrl ?? "http://localhost:20128";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-text-main">Client Keys &amp; Endpoints</h1>
        <p className="text-sm text-text-muted mt-1">
          Auto-provision customer API keys. A plan key expires automatically after its plan window,
          can only call combos built in OmniRoute, and can be renewed in rounds without changing the
          key material.
        </p>
      </div>

      <Card title="Available plans">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider border-b border-border">
              <th className="py-2 pr-4">planId</th>
              <th className="py-2 pr-4">Duration</th>
              <th className="py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {PLANS.map((plan) => (
              <tr key={plan.id} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-4 font-mono text-primary">{plan.id}</td>
                <td className="py-2 pr-4 font-mono">{plan.days} days</td>
                <td className="py-2 text-text-muted">{plan.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-text-muted mt-2">
          A plan key always runs with combos-only access: it fails with 403 unless the request
          targets a combo (for example <span className="font-mono">combo/assignment-helper</span>).
          Requests that name a raw model or an <span className="font-mono">auto/*</span> alias are
          rejected.
        </p>
      </Card>

      <Card title="POST /api/keys — Create a customer key">
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Request
            </p>
            <CodeBlock>{`curl -X POST ${origin}/api/keys \\
  -H "Authorization: Bearer <MANAGE_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Client plan key",
    "planId": "30d",
    "customerEmail": "client@example.com"
  }'`}</CodeBlock>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Fields
            </p>
            <ul className="list-disc list-inside text-sm text-text-main flex flex-col gap-1">
              <li>
                <span className="font-mono text-xs">name</span> — required key name.
              </li>
              <li>
                <span className="font-mono text-xs">planId</span> — one of
                <span className="font-mono text-xs"> 3d / 7d / 15d / 30d</span>. Optional; omit for
                a permanent key.
              </li>
              <li>
                <span className="font-mono text-xs">customerEmail</span> — optional identifier shown
                as a badge in the API Keys dashboard.
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Responses
            </p>
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <EndpointBadge status="201" />
                <span>
                  Created. Body returns <span className="font-mono text-xs">key</span>,{" "}
                  <span className="font-mono text-xs">planId</span>,{" "}
                  <span className="font-mono text-xs">planDays</span>,{" "}
                  <span className="font-mono text-xs">expiresAt</span>,{" "}
                  <span className="font-mono text-xs">renewalsCount</span>. The raw key is shown
                  only once — store it immediately.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <EndpointBadge status="400" />
                <span>Validation error (bad planId, missing name, unknown scopes).</span>
              </div>
              <div className="flex items-center gap-2">
                <EndpointBadge status="401" />
                <span>Missing or invalid authorization.</span>
              </div>
              <div className="flex items-center gap-2">
                <EndpointBadge status="403" />
                <span>Authenticated but the key lacks the manage scope.</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card title="POST /api/keys/:id/renew — Extend a plan key">
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Request
            </p>
            <CodeBlock>{`curl -X POST ${origin}/api/keys/KEY_ID/renew \\
  -H "Authorization: Bearer <MANAGE_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "planId": "30d"
  }'`}</CodeBlock>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Behavior
            </p>
            <ul className="list-disc list-inside text-sm text-text-main flex flex-col gap-1">
              <li>
                Extends <span className="font-mono text-xs">expiresAt</span> from the current
                expiration date (a key that expired 2 days ago is restored from its last expiry, not
                from today).
              </li>
              <li>
                Increments <span className="font-mono text-xs">renewalsCount</span>, shown as a
                badge in the dashboard.
              </li>
              <li>Only keys created with a plan can be renewed.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Responses
            </p>
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <EndpointBadge status="200" />
                <span>
                  Renewed. Body returns <span className="font-mono text-xs">planId</span>,{" "}
                  <span className="font-mono text-xs">planDays</span>,{" "}
                  <span className="font-mono text-xs">expiresAt</span>,{" "}
                  <span className="font-mono text-xs">renewalsCount</span>.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <EndpointBadge status="400" />
                <span>Invalid planId or the key is not a plan key.</span>
              </div>
              <div className="flex items-center gap-2">
                <EndpointBadge status="404" />
                <span>Key not found or the plan does not match the key.</span>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
