import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { setVenueActivationEnabled } from "@/lib/gaming/predictions/adminCatalog";

export async function PATCH(
  request: Request,
  { params }: { params: { activationId: string } }
) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { enabled } = body;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  const activation = await setVenueActivationEnabled(repo, params.activationId, enabled);
  return NextResponse.json({ activation });
}
