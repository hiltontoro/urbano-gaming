import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  PLAN_AMENDMENT_NOT_FOUND_MESSAGE,
  parsePlanAmendmentRequest,
  planAmendmentFailure,
  proposeCompetitionPlanAmendment,
  publicPlanAmendmentStatus,
  publicProposal,
  readCompetitionPlanAmendment,
} from "@/lib/gaming/competitions/planAmendment";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * One answer for everything that is not the active organizer or a frozen captain reading their own competition's plan change: a malformed identifier, an
 * unknown competition, an unrelated member, a scorekeeper, a registrant, an operational grant, a former host. It carries no format, state, role or proposal
 * and no hint of whether anything exists, and it is uncached. (The existing authentication boundary still answers 401 first, from the credential alone.)
 */
function notAvailable() {
  return NextResponse.json({ error: PLAN_AMENDMENT_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
}

/**
 * GET /api/gaming/competitions/[competitionId]/plan-amendment — the latest proposed change to the plan of ONE addressed competition and where it stands
 * (UG-CR-GATE-SSS-011). Only the active organizer and the four frozen captains are answered; the database decides who they are. Everyone else, and every
 * unknown or malformed address, receives the one identical 404 above. The answer is `{ amendment }`, bounded and uncached, and carries no identifier of a team,
 * member, proposal or revision.
 */
export async function GET(request: Request, { params }: { params: { competitionId: string } }) {
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

  try {
    const repo = buildCompetitionsRepo(credentials);
    const record = await readCompetitionPlanAmendment(repo, competitionId, auth.gamingMemberId);
    if (!record) return notAvailable();
    return NextResponse.json({ amendment: publicPlanAmendmentStatus(record) }, { headers: NO_STORE });
  } catch (err) {
    console.error("GET_COMPETITION_PLAN_AMENDMENT failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load the plan change." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/gaming/competitions/[competitionId]/plan-amendment — PROPOSE_COMPETITION_PLAN_AMENDMENT. The body is exactly `{ intentId, amendment }` and the
 * amendment carries only the venue's description, the pitches and the dates: the organizer is always the verified caller, and every preserved fact is composed
 * from the current revision. Every decision is made again inside the one atomic database operation (lock, exact ownership, host revocation, the amendment
 * window, the whole payload, the lead time and the expiry by the database clock), so this route is never the only guard.
 *
 * 201 for a new proposal; 200 for an exact replay of an earlier one (`alreadyProposed`); 400 with every problem found; 404 for anyone who is not the active
 * organizer; 409 for a refusal with its stable code (outside the window, too close to the first window, a save identifier used for a different proposal).
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
    const { intentId, amendment } = parsePlanAmendmentRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const result = await proposeCompetitionPlanAmendment(repo, competitionId, auth.gamingMemberId, intentId, amendment);
    return NextResponse.json({ amendment: publicProposal(result) }, { status: result.alreadyProposed ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    const failure = planAmendmentFailure(err);
    if (failure) return NextResponse.json(failure.body, { status: failure.status, headers: NO_STORE });
    console.error("PROPOSE_COMPETITION_PLAN_AMENDMENT failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to record the plan change." }, { status: 500, headers: NO_STORE });
  }
}
