import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildPredictionsRepo } from "@/lib/gaming/predictions/httpAuth";
import { selectPublicMatches } from "@/lib/gaming/predictions/publicMatchList";

// This route has no dynamic path segment and never reads the request
// object, so Next.js would otherwise treat it as statically
// prerenderable at build time — hitting live Supabase during `next
// build` itself. It must always run per-request.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/predictions/matches — public: every non-cancelled Match, its two
 * Teams (each with its currently-active selectable roster, for the
 * member-facing Goalscorer picker — grouped by Team, no free text),
 * its Venue Activations (with Venue coordinates/radius for client-side
 * distance display), configured Prize Tiers, and the current finalized
 * result if one exists. No Guest/member distinction — browsing is
 * open; submitting a Prediction (matches/[matchId]/predict) requires
 * authentication.
 */
export async function GET() {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = buildPredictionsRepo(credentials);
  const matches = selectPublicMatches(await repo.listMatches());

  const result = await Promise.all(
    matches.map(async (match) => {
      const [homeTeam, awayTeam, homePlayers, awayPlayers] = await Promise.all([
        repo.getTeamById(match.homeTeamId),
        repo.getTeamById(match.awayTeamId),
        repo.listPlayersForTeam(match.homeTeamId),
        repo.listPlayersForTeam(match.awayTeamId),
      ]);
      const activations = await repo.listVenueActivationsForMatch(match.matchId);
      const venueActivations = await Promise.all(
        activations.map(async (activation) => {
          const venue = await repo.getVenueById(activation.venueId);
          const prizeTiers = await repo.listPrizeTiersForActivation(
            activation.venueActivationId
          );
          return {
            venueActivationId: activation.venueActivationId,
            enabled: activation.enabled,
            venue: venue
              ? {
                  venueId: venue.venueId,
                  name: venue.name,
                  latitude: venue.latitude,
                  longitude: venue.longitude,
                  radiusMeters: venue.radiusMeters,
                  active: venue.active,
                }
              : null,
            prizeTiers: prizeTiers.map((tier) => ({
              prizeTierId: tier.prizeTierId,
              correctDimensionCount: tier.correctDimensionCount,
              prizeLabel: tier.prizeLabel,
            })),
          };
        })
      );

      const currentResult = await repo.getCurrentFinalizedMatchResult(match.matchId);

      return {
        matchId: match.matchId,
        homeTeam: homeTeam
          ? {
              teamId: homeTeam.teamId,
              name: homeTeam.name,
              players: homePlayers
                .filter((p) => p.active)
                .map((p) => ({ playerId: p.playerId, name: p.name })),
            }
          : null,
        awayTeam: awayTeam
          ? {
              teamId: awayTeam.teamId,
              name: awayTeam.name,
              players: awayPlayers
                .filter((p) => p.active)
                .map((p) => ({ playerId: p.playerId, name: p.name })),
            }
          : null,
        competition: match.competition,
        kickoffAt: match.kickoffAt,
        cancelledAt: match.cancelledAt,
        finalized: currentResult !== null,
        finalResult: currentResult
          ? { homeScore: currentResult.homeScore, awayScore: currentResult.awayScore }
          : null,
        venueActivations,
      };
    })
  );

  return NextResponse.json({ matches: result });
}
