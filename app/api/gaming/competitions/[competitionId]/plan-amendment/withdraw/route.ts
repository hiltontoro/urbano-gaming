import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  PLAN_AMENDMENT_NOT_FOUND_MESSAGE,
  parsePlanAmendmentWithdrawRequest,
  planAmendmentFailure,
  withdrawCompetitionPlanAmendment,
} from "@/lib/gaming/competitions/planAmendment";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/** The one 404 for everyone who is not the active organizer, and for every unknown or malformed address. It names nothing and is uncached. */
function notAvailable() {
  return NextResponse.json({ error: PLAN_AMENDMENT_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
}

/**
 * POST /api/gaming/competitions/[competitionId]/plan-amendment/withdraw — WITHDRAW_COMPETITION_PLAN_AMENDMENT. The body is exactly `{ amendmentDigest }`. Only the
 * competition's active organizer can withdraw, and only a proposal that is still pending and unexpired; the database judges all of it again, atomically, so a
 * withdrawal racing the fourth confirmation has exactly one winner.
 *
 * 200 with `{ status: "WITHDRAWN", alreadyWithdrawn }` (an exact repeat is a 200); 400 for an invalid body; 404 for anyone who is not the active organizer; 409 with
 * a stable code (stale digest, expired, no longer pending, window closed).
 */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return noStore(unavailable);

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500, headers: NO_STORE });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return noStore(auth.errorResponse);

  const competitionId = params?.competitionId;
  if (typeof competitionId !== "string" || !UUID.test(competitionId)) return notAvailable();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: NO_STORE });
  }

  try {
    const { amendmentDigest } = parsePlanAmendmentWithdrawRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const result = await withdrawCompetitionPlanAmendment(repo, competitionId, auth.gamingMemberId, amendmentDigest);
    return NextResponse.json({ status: result.status, alreadyWithdrawn: result.alreadyWithdrawn }, { headers: NO_STORE });
  } catch (err) {
    const failure = planAmendmentFailure(err);
    if (failure) return NextResponse.json(failure.body, { status: failure.status, headers: NO_STORE });
    console.error("WITHDRAW_COMPETITION_PLAN_AMENDMENT failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to withdraw the plan change." }, { status: 500, headers: NO_STORE });
  }
}
