import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";

/**
 * GET /api/gaming/competitions/teams/[teamId]/join-requests — pending
 * join requests targeting this team. Read-side access is restricted to
 * the team's own captain or the competition's organizer — the same two
 * actors decide_join_request_atomically itself would accept — so a
 * member cannot enumerate another team's pending applicants.
 */
export async function GET(request: Request, { params }: { params: { teamId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const repo = buildCompetitionsRepo(credentials);
  try {
    const team = await repo.getCompetitionTeamById(params.teamId);
    if (!team) return NextResponse.json({ error: "No such team exists." }, { status: 404 });

    const competition = await repo.getCompetitionById(team.competitionId);
    const isCaptain = team.captainGamingMemberId === auth.gamingMemberId;
    const isOrganizer = competition?.organizerGamingMemberId === auth.gamingMemberId;
    if (!isCaptain && !isOrganizer) {
      return NextResponse.json({ error: "Only this team's captain or the competition organizer may view its pending join requests." }, { status: 403 });
    }

    const joinRequests = await repo.getPendingJoinRequestsForTeam(params.teamId);
    const displayNames = await repo.getDisplayNames(joinRequests.map((jr) => jr.requestingGamingMemberId));
    const withDisplayNames = joinRequests.map((jr) => ({
      ...jr,
      requestingGamingMemberDisplayName: displayNames[jr.requestingGamingMemberId],
    }));
    return NextResponse.json({ joinRequests: withDisplayNames });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("GET_TEAM_JOIN_REQUESTS failed:", err);
    return NextResponse.json({ error: "Failed to load pending join requests." }, { status: 500 });
  }
}
