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
import { submitHostApplication } from "@/lib/gaming/host/submitHostApplication";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/host/applications — SUBMIT_HOST_APPLICATION. The applicant
 * is always the verified caller: no member, status, reviewer or timestamp field
 * is read from the body, and unknown body fields are ignored. A member may hold
 * one live (pending or approved) application at a time; a second submission is
 * truthfully refused with 409, never silently duplicated.
 */
export async function POST(request: Request) {
  const unavailable = requireHostSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const result = await submitHostApplication(buildHostRepo(credentials), auth.gamingMemberId, body);
    return NextResponse.json({ application: result }, { status: 201 });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("SUBMIT_HOST_APPLICATION", err);
    return NextResponse.json({ error: "Failed to submit your host application." }, { status: 500 });
  }
}
