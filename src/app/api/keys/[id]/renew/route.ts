import { NextResponse } from "next/server";
import { renewApiKey } from "@/lib/db/apiKeys";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { renewKeySchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import * as log from "@/sse/utils/logger";

/**
 * POST /api/keys/[id]/renew
 *
 * Renews a plan API key for the given plan, extending the expiry from
 * max(now, current expires_at). Revoked keys cannot be renewed.
 */
export async function POST(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing key ID" }, { status: 400 });
    }

    const body = await request.json();
    const validation = validateBody(renewKeySchema, body);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const result = await renewApiKey(id, validation.data.planId);
    if (result.status === "not_found") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    if (result.status === "revoked") {
      return NextResponse.json({ error: "Key is revoked and cannot be renewed" }, { status: 400 });
    }

    return NextResponse.json({
      message: "API key renewed successfully",
      id: result.id,
      planId: result.planId,
      planDays: result.planDays,
      expiresAt: result.expiresAt,
      renewalsCount: result.renewalsCount,
    });
  } catch (error) {
    log.error("keys", "Error renewing key", error);
    return NextResponse.json({ error: "Failed to renew key" }, { status: 500 });
  }
}
