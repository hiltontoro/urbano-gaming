import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createPlayer, listPlayersForTeam } from "@/lib/gaming/predictions/adminCatalog";

/**
 * Roster CRUD for one Team. active defaults true on create — there is
 * no delete path anywhere in this domain, so a player_id already
 * referenced by a historical Prediction or official goal event can
 * never dangle even after the Player is later deactivated via
 * admin/players/[playerId].
 */
export async function GET(
  request: Request,
  { params }: { params: { teamId: string } }
) {
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
  const players = await listPlayersForTeam(repo, params.teamId);
  return NextResponse.json({ players });
}

export async function POST(
  request: Request,
  { params }: { params: { teamId: string } }
) {
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

  const { name } = body;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "Invalid player payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  const player = await createPlayer(repo, { teamId: params.teamId, name });
  return NextResponse.json({ player }, { status: 201 });
}
