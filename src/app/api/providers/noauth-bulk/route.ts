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

  // Each generated OpenCode account is represented by its own connection row.
  // The runtime still combines all rows into the synthetic no-auth credential
  // pool, so account rotation/proxy assignment remains global while the
  // dashboard can manage/delete accounts one connection at a time.
  const existingFingerprints = new Set(
    existing.flatMap((connection) => connectionFingerprints(connection))
  );
  const newAccountIds = uniqueIncoming.filter((accountId) => !existingFingerprints.has(accountId));
  const createdConnectionIds: string[] = [];

  for (const accountId of newAccountIds) {
    const suffix = accountId.slice(-8);
    const connection = await createProviderConnection({
      provider: "opencode",
      authType: "noauth",
      name: `OpenCode Free • ${suffix}`,
      priority: 1,
      globalPriority: null,
      defaultModel: null,
      providerSpecificData: {
        fingerprints: [accountId],
        accountProxies: [],
      },
      isActive: true,
      testStatus: "unknown",
    });
    createdConnectionIds.push(connection.id);
  }

  return NextResponse.json({
    success: newAccountIds.length,
    failed: 0,
    total: uniqueIncoming.length,
    skipped: uniqueIncoming.length - newAccountIds.length,
    connectionIds: createdConnectionIds,
  });
}
