import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";

/**
 * GET /api/gaming/competitions/fixtures/[fixtureId]/admin-detail — the
 * one consolidated read the Organizer/Scorekeeper admin surface uses
 * per fixture: both teams' current rosters, check-ins, attestations,
 * evidence, goal/assist events, shootout, disputes, and finalization.
 * Restricted to the competition's organizer or this fixture's currently
 * appointed scorekeeper — the same two actors who can act on this data.
 */
export async function GET(request: Request, { params }: { params: { fixtureId: string } }) {
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
    const fixture = await repo.getFixtureById(params.fixtureId);
    if (!fixture) return NextResponse.json({ error: "No such fixture exists." }, { status: 404 });

    const competition = await repo.getCompetitionById(fixture.competitionId);
    const isOrganizer = competition?.organizerGamingMemberId === auth.gamingMemberId;
    const isScorekeeper = fixture.scorekeeperGamingMemberId === auth.gamingMemberId;
    if (!isOrganizer && !isScorekeeper) {
      return NextResponse.json({ error: "Only this competition's organizer or this fixture's appointed scorekeeper may view this detail." }, { status: 403 });
    }

    const [teamARoster, teamBRoster, checkIns, attestations, evidence, goalEvents, assistEvents, shootout, disputes, finalization] = await Promise.all([
      fixture.teamACompetitionTeamId ? repo.getCurrentRoster(fixture.competitionFixtureId, fixture.teamACompetitionTeamId) : Promise.resolve(null),
      fixture.teamBCompetitionTeamId ? repo.getCurrentRoster(fixture.competitionFixtureId, fixture.teamBCompetitionTeamId) : Promise.resolve(null),
      repo.getCheckIns(fixture.competitionFixtureId),
      repo.getCurrentAttestations(fixture.competitionFixtureId),
      repo.getCurrentEvidence(fixture.competitionFixtureId),
      repo.getCurrentGoalEvents(fixture.competitionFixtureId),
      repo.getCurrentAssistEvents(fixture.competitionFixtureId),
      repo.getCurrentShootout(fixture.competitionFixtureId),
      repo.getDisputes(fixture.competitionFixtureId),
      repo.getCurrentFinalization(fixture.competitionFixtureId),
    ]);

    return NextResponse.json({
      fixture, teamARoster, teamBRoster, checkIns, attestations, evidence, goalEvents, assistEvents, shootout, disputes, finalization,
    });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("GET_FIXTURE_ADMIN_DETAIL failed:", err);
    return NextResponse.json({ error: "Failed to load fixture detail." }, { status: 500 });
  }
}
