import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildHostRepo,
  requireGamingMember,
  requireHostSchemaReady,
  statusForHostError,
  bodyForHostError,
  logHostFailure,
} from "@/lib/gaming/host/httpAuth";
import { withdrawHostApplication } from "@/lib/gaming/host/withdrawHostApplication";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/host/applications/[applicationCode]/withdraw — the applicant
 * withdraws their OWN pending application. Ownership is part of the database
 * lookup, so someone else's application is indistinguishable from one that does
 * not exist (404). Withdrawing twice is idempotent.
 */
export async function POST(request: Request, { params }: { params: { applicationCode: string } }) {
  const unavailable = requireHostSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  try {
    const result = await withdrawHostApplication(buildHostRepo(credentials), auth.gamingMemberId, params.applicationCode);
    return NextResponse.json({ application: result });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("WITHDRAW_HOST_APPLICATION", err);
    return NextResponse.json({ error: "Failed to withdraw your host application." }, { status: 500 });
  }
}
