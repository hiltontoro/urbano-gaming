import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  PLAN_AMENDMENT_NOT_FOUND_MESSAGE,
  decideCompetitionPlanAmendment,
  parsePlanAmendmentDecisionRequest,
  planAmendmentFailure,
} from "@/lib/gaming/competitions/planAmendment";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/** The one 404 for everyone who is not a frozen captain of this competition, and for every unknown or malformed address. It names nothing and is uncached. */
function notAvailable() {
  return NextResponse.json({ error: PLAN_AMENDMENT_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
}

/**
 * POST /api/gaming/competitions/[competitionId]/plan-amendment/decision — DECIDE_COMPETITION_PLAN_AMENDMENT. The body is exactly `{ amendmentDigest, decision }`:
 * the decision is CONFIRMED or REJECTED and names the proposal's exact digest, and the captain is always the verified caller — never a field of the request. Only a
 * frozen captain (from the registration-freeze snapshot) can decide; the database judges that, the window, the expiry and the digest, and the fourth distinct
 * confirmation creates the next planning revision in the same transaction. One rejection ends the proposal; there is no override.
 *
 * 200 with `{ decision, status, confirmedCount, requiredCount, alreadyDecided, activatedRevisionNumber }`; 400 for an invalid body; 404 for anyone who is not a
 * frozen captain; 409 with a stable code (stale digest, expired, no longer pending, a different earlier answer, window closed).
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
    const { amendmentDigest, decision } = parsePlanAmendmentDecisionRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const result = await decideCompetitionPlanAmendment(repo, competitionId, auth.gamingMemberId, amendmentDigest, decision);
    return NextResponse.json(
      {
        decision: result.decision, status: result.status, confirmedCount: result.confirmedCount, requiredCount: result.requiredCount,
        alreadyDecided: result.alreadyDecided, activatedRevisionNumber: result.activatedRevisionNumber,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    const failure = planAmendmentFailure(err);
    if (failure) return NextResponse.json(failure.body, { status: failure.status, headers: NO_STORE });
    console.error("DECIDE_COMPETITION_PLAN_AMENDMENT failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to record the answer." }, { status: 500, headers: NO_STORE });
  }
}
