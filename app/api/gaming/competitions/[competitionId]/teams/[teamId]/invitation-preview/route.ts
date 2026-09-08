import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview
 * — the one deliberately UNAUTHENTICATED Competitions read (UG-CR-
 * RPT-041/UG-CR-RPT-042 §8/§9; accepted decisions §10 — "invitations are
 * navigation, not authority"). A visitor who has not yet signed in must
 * be able to see WHAT they were invited to before completing their
 * URBANO identity — mirroring Race's own precedent for a coarse,
 * pre-join, no-bearer-token read (app/api/gaming/race/events/
 * [raceEventId]/route.ts).
 *
 * requireCompetitionsSchemaReady() is still the literal first operation
 * — the fail-closed guard is never bypassed, only the identity check is
 * intentionally absent here. This route performs no mutation, ever.
 *
 * Returns ONLY: competition name, truthful competition/joinability
 * state, team name, truthful team status, and the captain's display
 * name. It never returns an auth identifier, a raw Gaming Member id
 * (including the captain's own), a registration record, a join
 * request, a membership list, a roster, a check-in, evidence, a
 * statistic, a dispute, another team, or any authority metadata. A
 * fabricated or mismatched competitionId/teamId pair fails safely with
 * the same generic 404 shape this domain already uses everywhere else.
 * A PENDING or REJECTED team is reported exactly as such — never
 * presented as an accepted, joinable invitation.
 */
export async function GET(request: Request, { params }: { params: { competitionId: string; teamId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const competition = await repo.getCompetitionById(params.competitionId);
    if (!competition) {
      return NextResponse.json({ error: "No such competition exists." }, { status: 404 });
    }

    const team = await repo.getCompetitionTeamById(params.teamId);
    if (!team || team.competitionId !== competition.competitionId) {
      return NextResponse.json({ error: "No such team exists in this competition." }, { status: 404 });
    }

    const displayNames = await repo.getDisplayNames([team.captainGamingMemberId]);

    const competitionAcceptingParticipants =
      competition.state === "TEAM_REGISTRATION_OPEN" ||
      competition.state === "READY_TO_PUBLISH" ||
      competition.state === "PUBLISHED";

    return NextResponse.json({
      preview: {
        competitionName: competition.name,
        competitionState: competition.state,
        competitionAcceptingParticipants,
        teamName: team.name,
        teamStatus: team.status,
        teamAccepted: team.status === "ACCEPTED",
        captainDisplayName: displayNames[team.captainGamingMemberId] ?? null,
      },
    });
  } catch (err) {
    console.error("GET_COMPETITION_INVITATION_PREVIEW failed:", err);
    return NextResponse.json({ error: "Failed to load invitation preview." }, { status: 500 });
  }
}
