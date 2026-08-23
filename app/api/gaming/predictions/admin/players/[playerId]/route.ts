import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { editPlayer, setPlayerActive } from "@/lib/gaming/predictions/adminCatalog";

/**
 * PATCH: edit a Player's name and/or set active/inactive (deactivation
 * only — there is no delete). Both fields are optional independently
 * so the admin surface can rename and activate/deactivate as two
 * separate actions without one clobbering the other.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { playerId: string } }
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

  const { name, active } = body;
  if (name === undefined && active === undefined) {
    return NextResponse.json({ error: "Invalid player payload." }, { status: 400 });
  }
  if (name !== undefined && typeof name !== "string") {
    return NextResponse.json({ error: "Invalid player payload." }, { status: 400 });
  }
  if (active !== undefined && typeof active !== "boolean") {
    return NextResponse.json({ error: "Invalid player payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  let player = name !== undefined ? await editPlayer(repo, params.playerId, { name }) : null;
  if (active !== undefined) {
    player = await setPlayerActive(repo, params.playerId, active);
  }
  return NextResponse.json({ player: player ?? (await repo.getPlayerById(params.playerId)) });
}
