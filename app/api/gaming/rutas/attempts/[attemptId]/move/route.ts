import { NextResponse } from "next/server";
import { applyMove } from "@/lib/gaming/rutas/applyMove";
import { SupabaseRutasRepository } from "@/lib/gaming/rutas/db/supabaseRutasRepository";
import {
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasIllegalMoveError,
  RutasInvalidDistanceError,
  RutasScenarioNotFoundError,
  RutasStaleAttemptStateError,
} from "@/lib/gaming/rutas/types";

/**
 * POST /api/gaming/rutas/attempts/[attemptId]/move — APPLY_MOVE
 *
 * Body: { pieceId, direction, distance, idempotencyKey }. The server
 * independently re-validates the move against its own authoritative
 * state — never trusts the client's claimed resulting position (see
 * applyMove.ts / geometry.ts). A stale-state conflict (409) means the
 * client's local copy is behind; it should GET the attempt and retry.
 */
export async function POST(request: Request, { params }: { params: { attemptId: string } }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // handled by the validation below
  }

  const { pieceId, direction, distance, idempotencyKey } = body ?? {};
  if (
    typeof pieceId !== "string" ||
    !["N", "S", "E", "W"].includes(direction) ||
    typeof distance !== "number" ||
    typeof idempotencyKey !== "string"
  ) {
    return NextResponse.json(
      { error: "pieceId (string), direction (N|S|E|W), distance (number), and idempotencyKey (string) are required." },
      { status: 400 }
    );
  }

  const repo = new SupabaseRutasRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await applyMove(repo, {
      attemptId: params.attemptId,
      pieceId,
      direction,
      distance,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RutasAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RutasScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RutasAttemptNotInProgressError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RutasStaleAttemptStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RutasInvalidDistanceError || err instanceof RutasIllegalMoveError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("APPLY_MOVE failed:", err);
    return NextResponse.json({ error: "Failed to apply Rutas move." }, { status: 500 });
  }
}
