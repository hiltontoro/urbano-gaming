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

    const [teamARoster, teamBRoster, checkIns, attestations, evidence, goalEvents, assistEvents, shootout, disputes, finalization, registrations] = await Promise.all([
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
      repo.getCompetitionRegistrations(fixture.competitionId),
    ]);

    // UG-CR-GATE-082 (REV-053 #4) — "competition-scoped eligible members":
    // every registrant of THIS competition, by display name, so the
    // scorekeeper/scorer/assister/attestation selectors never ask a human
    // to type or paste a raw gaming-member UUID, and never enumerate
    // anyone outside this one competition. Also resolves names for the
    // already-appointed scorekeeper and every current roster/check-in
    // entry, so those surfaces render a name instead of a raw id too.
    const allMemberIds = Array.from(new Set([
      ...registrations.map((r) => r.gamingMemberId),
      ...(teamARoster?.gamingMemberIds ?? []),
      ...(teamBRoster?.gamingMemberIds ?? []),
      ...checkIns.map((c) => c.gamingMemberId),
      ...(fixture.scorekeeperGamingMemberId ? [fixture.scorekeeperGamingMemberId] : []),
    ]));
    const displayNames = await repo.getDisplayNames(allMemberIds);
    const eligibleMembers = registrations
      .map((r) => ({ gamingMemberId: r.gamingMemberId, displayName: displayNames[r.gamingMemberId] ?? "Unknown" }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return NextResponse.json({
      fixture, teamARoster, teamBRoster, checkIns, attestations, evidence, goalEvents, assistEvents, shootout, disputes, finalization,
      eligibleMembers, displayNames,
    });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("GET_FIXTURE_ADMIN_DETAIL failed:", err);
    return NextResponse.json({ error: "Failed to load fixture detail." }, { status: 500 });
  }
}
