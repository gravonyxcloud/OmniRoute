import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createProviderConnection } from "@/models";

const MAX_ACCOUNTS_PER_REQUEST = 1000;

function validAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
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

  const created: Array<Record<string, unknown>> = [];
  const errors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < accountIds.length; i++) {
    const fingerprint = accountIds[i] as string;
    try {
      const connection = await createProviderConnection({
        provider,
        authType: "apikey",
        name: `OpenCode ${fingerprint.slice(0, 12)}`,
        priority: 1,
        globalPriority: null,
        defaultModel: null,
        providerSpecificData: { fingerprints: [fingerprint] },
        isActive: true,
        testStatus: "unknown",
      });
      created.push({
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
      });
    } catch (error) {
      errors.push({
        index: i,
        message: error instanceof Error ? error.message : "Failed to create connection",
      });
    }
  }

  return NextResponse.json({
    success: created.length,
    failed: errors.length,
    total: accountIds.length,
    created,
    errors,
  });
}
