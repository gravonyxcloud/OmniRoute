import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/models";

const MAX_ACCOUNTS_PER_REQUEST = 1000;

function validAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function connectionFingerprints(connection: Record<string, unknown>): string[] {
  const psd =
    connection.providerSpecificData &&
    typeof connection.providerSpecificData === "object" &&
    !Array.isArray(connection.providerSpecificData)
      ? (connection.providerSpecificData as Record<string, unknown>)
      : {};
  return Array.isArray(psd.fingerprints)
    ? psd.fingerprints.filter((value): value is string => typeof value === "string")
    : [];
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const provider = typeof data.provider === "string" ? data.provider : "";
  const accountIds = Array.isArray(data.accountIds) ? data.accountIds : [];

  if (provider !== "opencode") {
    return NextResponse.json(
      { error: "Bulk no-auth account creation is only supported for opencode" },
      { status: 400 }
    );
  }
  if (accountIds.length < 1 || accountIds.length > MAX_ACCOUNTS_PER_REQUEST) {
    return NextResponse.json(
      { error: `accountIds must contain between 1 and ${MAX_ACCOUNTS_PER_REQUEST} items` },
      { status: 400 }
    );
  }
  if (!accountIds.every(validAccountId)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  const uniqueIncoming = [...new Set(accountIds as string[])];
  const existing = (await getProviderConnections({ provider: "opencode" })) as Array<
    Record<string, unknown>
  >;

  // OpenCode Free is a no-auth provider. Multiple fingerprints are rotation
  // identities inside ONE logical connection; they are not API credentials.
  // Prefer a canonical noauth row. For compatibility, reuse a legacy empty-key
  // row that already carries fingerprints instead of creating another row.
  const target =
    existing.find((connection) => connection.authType === "noauth") ??
    existing.find((connection) => {
      const apiKey =
        typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
      return apiKey.length === 0 && connectionFingerprints(connection).length > 0;
    });

  if (target) {
    const current = connectionFingerprints(target);
    const merged = [...new Set([...current, ...uniqueIncoming])];
    const updated = await updateProviderConnection(String(target.id), {
      authType: "noauth",
      providerSpecificData: {
        ...((target.providerSpecificData as Record<string, unknown> | undefined) ?? {}),
        fingerprints: merged,
      },
      isActive: true,
    });

    return NextResponse.json({
      success: uniqueIncoming.length,
      failed: 0,
      total: uniqueIncoming.length,
      connectionId: updated?.id ?? target.id,
      fingerprints: merged.length,
    });
  }

  const connection = await createProviderConnection({
    provider: "opencode",
    authType: "noauth",
    name: "OpenCode Free",
    priority: 1,
    globalPriority: null,
    defaultModel: null,
    providerSpecificData: { fingerprints: uniqueIncoming },
    isActive: true,
    testStatus: "unknown",
  });

  return NextResponse.json({
    success: uniqueIncoming.length,
    failed: 0,
    total: uniqueIncoming.length,
    connectionId: connection.id,
    fingerprints: uniqueIncoming.length,
  });
}
