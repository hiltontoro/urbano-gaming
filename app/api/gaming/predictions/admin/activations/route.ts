import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createVenueActivation } from "@/lib/gaming/predictions/adminCatalog";
import { visibleInAdminView } from "@/lib/gaming/predictions/fixtureExclusion";
import { PROGRESSIVE_PREDICTION_CONTRACT, computeLadderOffer } from "@/lib/gaming/predictions/prizeLadder";

/**
 * GET: every Venue Activation of every Match, cancelled Matches included,
 * with its Venue name and Prize Tiers. The admin Activations and Prizes
 * controls read this instead of the public match list, which omits
 * cancelled Matches.
 */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requireAnyAdminAuthority(request, credentials);
  if ("errorResponse" in admin) return admin.errorResponse;

  const repo = buildPredictionsRepo(credentials);
  // Default view: the matches of the temporary fixture manifest are left out BEFORE their activations, venues and tiers are read
  // (?includeFixtures=1 brings the historical test data back). The activation ids of the manifest are left out as well.
  const matches = visibleInAdminView(request, await repo.listMatches(), "matches", (match) => match.matchId);
  const perMatch = await Promise.all(
    matches.map(async (match) => {
      const activations = await repo.listVenueActivationsForMatch(match.matchId);
      return Promise.all(
        activations.map(async (activation) => {
          const [venue, prizeTiers] = await Promise.all([
            repo.getVenueById(activation.venueId),
            repo.listPrizeTiersForActivation(activation.venueActivationId),
          ]);
          return {
            matchId: match.matchId,
            predictionContract: match.predictionContract,
            venueActivationId: activation.venueActivationId,
            enabled: activation.enabled,
            venue: venue ? { venueId: venue.venueId, name: venue.name } : null,
            prizeTiers: prizeTiers.map((tier) => ({
              prizeTierId: tier.prizeTierId,
              correctDimensionCount: tier.correctDimensionCount,
              ladderLevel: tier.ladderLevel,
              prizeLabel: tier.prizeLabel,
            })),
            // What this activation offers members under the progressive
            // contract, so the admin sees whether it takes participations.
            offer:
              match.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT
                ? computeLadderOffer(prizeTiers)
                : null,
          };
        })
      );
    })
  );
  const activations = visibleInAdminView(request, perMatch.flat(), "activations", (activation) => activation.venueActivationId);
  return NextResponse.json({ activations });
}

export async function POST(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { matchId, venueId } = body;
  if (typeof matchId !== "string" || typeof venueId !== "string") {
    return NextResponse.json({ error: "Invalid venue activation payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  try {
    const activation = await createVenueActivation(repo, { matchId, venueId });
    return NextResponse.json({ activation }, { status: 201 });
  } catch (err) {
    console.error("CREATE_VENUE_ACTIVATION failed:", err);
    return NextResponse.json({ error: "Failed to create venue activation." }, { status: 500 });
  }
}
