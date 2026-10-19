import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { appointedFixtureIds } from "@/lib/gaming/competitions/administration";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/** One answer for everything that is not scorekeeper access to this competition, so it reveals nothing about what exists. */
function notAvailable() {
  return NextResponse.json({ error: "Scorekeeper access was not found for this competition." }, { status: 404, headers: NO_STORE });
}

/**
 * GET /api/gaming/competitions/[competitionId]/scorekeeper-administration — the scorekeeper's view of ONE addressed competition
 * (UG-CR-GATE-100). Scorekeeper access is contextual: it starts from the member competition page (/competitions.html) after the
 * member has loaded this one competition, and the page passes that exact competition id here. It is never a list and never global.
 *
 * The server re-confirms the appointment itself, from the fixture rows as they are NOW: the caller must be the current scorekeeper of at
 * least one fixture of this competition. Re-appointing someone else ends it; a revoked host gains nothing by having appointed themselves.
 * The response carries only the competition's id, name and state, the fixtures currently assigned to the caller (with the minimum the
 * evidence workflow needs to label them), and the names of the teams in those fixtures. It never carries other fixtures, other
 * competitions, an organizer id, a public code or any appointment elsewhere.
 *
 * A malformed id, an unknown competition, a competition the caller does not score in, a removed or replaced appointment and a revoked
 * host's self-appointment all receive the identical 404, uncached. Authentication follows the existing bounded contract (401); an
 * internal failure is a generic 500. The evidence itself is submitted and read through the existing fixture routes, which re-authorize
 * every call; this route adds no authority.
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
    const competition = await repo.getCompetitionById(competitionId);
    if (!competition) return notAvailable();
    const fixtures = await repo.getCompetitionFixtures(competitionId);
    const assigned = new Set(appointedFixtureIds(competition, fixtures, auth.gamingMemberId));
    if (assigned.size === 0) return notAvailable();

    const mine = fixtures.filter((f) => assigned.has(f.competitionFixtureId));
    const teamIds = new Set<string>();
    for (const f of mine) {
      if (f.teamACompetitionTeamId) teamIds.add(f.teamACompetitionTeamId);
      if (f.teamBCompetitionTeamId) teamIds.add(f.teamBCompetitionTeamId);
    }
    const teams = (await repo.getCompetitionTeams(competitionId))
      .filter((t) => t.status === "ACCEPTED" && teamIds.has(t.competitionTeamId))
      .map((t) => ({ competitionTeamId: t.competitionTeamId, name: t.name }));

    return NextResponse.json(
      {
        competition: { competitionId: competition.competitionId, name: competition.name, state: competition.state },
        teams,
        fixtures: mine.map((f) => ({
          competitionFixtureId: f.competitionFixtureId, fixtureRole: f.fixtureRole, state: f.state, scheduledAt: f.scheduledAt,
          teamACompetitionTeamId: f.teamACompetitionTeamId, teamBCompetitionTeamId: f.teamBCompetitionTeamId,
        })),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error("GET_SCOREKEEPER_ADMINISTRATION failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load your scorekeeper assignment." }, { status: 500, headers: NO_STORE });
  }
}
