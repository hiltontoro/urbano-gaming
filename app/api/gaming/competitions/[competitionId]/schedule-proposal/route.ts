import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE,
  createScheduleProposal,
  parseScheduleProposalRequest,
  publicScheduleProposal,
  publicScheduleRead,
  readScheduleProposals,
  scheduleProposalFailure,
} from "@/lib/gaming/competitions/scheduleProposal";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * One answer for everything that is not the active organizer of an existing competition: a malformed identifier, an unknown competition, a frozen captain, a scorekeeper, a
 * registrant, an operational grant, a former host. It carries no state, role, draw or plan and no hint of whether anything exists, and it is uncached. (The existing
 * authentication boundary still answers 401 first, from the credential alone.)
 */
function notAvailable() {
  return NextResponse.json({ error: SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
}

/**
 * GET /api/gaming/competitions/[competitionId]/schedule-proposal — the schedule proposals of ONE addressed competition (UG-CR-GATE-SSS-022), for its ACTIVE ORGANIZER only:
 * the current accepted plan as the proposal is judged against it (with the pitch identifiers a proposal must name), the latest proposal in full, and the bounded history.
 * The database decides who the organizer is; everyone else, and every unknown or malformed address, receives the one identical 404 above. The answer is bounded and uncached,
 * and carries no identifier of a plan revision, a draw, a request, an intent or a member.
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
    const read = await readScheduleProposals(repo, competitionId, auth.gamingMemberId);
    if (!read) return notAvailable();
    return NextResponse.json(publicScheduleRead(read), { headers: NO_STORE });
  } catch (err) {
    console.error("GET_COMPETITION_SCHEDULE_PROPOSALS failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load the schedule proposals." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/gaming/competitions/[competitionId]/schedule-proposal — PROPOSE_COMPETITION_SCHEDULE. The body is exactly `{ intentId, placements }`: three placements, one per
 * role (SEMIFINAL_1, SEMIFINAL_2, FINAL), each exactly `{ fixtureRole, planningPitchId, planDate, startTime }` with the start in the venue's own clock. No team, pairing,
 * instant, zone, duration, capacity, venue fact, format, timing, actor or fixture is ever accepted — the organizer is always the verified caller, the teams are the draw's, the
 * venue, dates, windows, pitches, capacity and zone are the current accepted plan's, the timing is the format registry's, and every decision (lock, exact ownership, host
 * revocation, the request, replay, lifecycle, every scheduling rule, the sequence) is made again inside the one atomic database operation, so this route is never the only
 * guard. It creates no fixture, publishes nothing and changes no state.
 *
 * 201 for a new version; 200 for an exact replay of the same request (`alreadyProposed`); 400 with every problem found (the request, or the schedule — with the stable code
 * of the rule it breaks); 404 for anyone who is not the active organizer; 409 for a refusal with its stable code (the wrong state, the freeze, the draw or the plan missing, a
 * plan change awaiting the captains, an identifier already used for a different schedule).
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
    const proposalRequest = parseScheduleProposalRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const result = await createScheduleProposal(repo, competitionId, auth.gamingMemberId, proposalRequest);
    return NextResponse.json({ proposal: publicScheduleProposal(result.proposal), alreadyProposed: result.alreadyProposed }, { status: result.alreadyProposed ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    const failure = scheduleProposalFailure(err);
    if (failure) return NextResponse.json(failure.body, { status: failure.status, headers: NO_STORE });
    console.error("PROPOSE_COMPETITION_SCHEDULE failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to propose the schedule." }, { status: 500, headers: NO_STORE });
  }
}
