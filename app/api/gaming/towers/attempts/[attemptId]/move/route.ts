import { NextResponse } from "next/server";
import { applyMove } from "@/lib/gaming/towers/applyMove";
import { SupabaseTowersRepository } from "@/lib/gaming/towers/db/supabaseTowersRepository";
import {
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersIllegalMoveError,
  TowersScenarioNotFoundError,
  TowersStaleAttemptStateError,
} from "@/lib/gaming/towers/types";

/**
 * POST /api/gaming/towers/attempts/[attemptId]/move — MOVE_TOP_PIECE
 *
 * Body: { fromTowerId, toTowerId, idempotencyKey }. The client never
 * supplies which piece moves — the server derives it from the
 * authoritative top of fromTowerId and independently re-validates the
 * move (see applyMove.ts / moveLogic.ts). A stale-state conflict (409)
 * means the client's local copy is behind; it should GET the attempt and
 * retry.
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

  const { fromTowerId, toTowerId, idempotencyKey } = body ?? {};
  if (typeof fromTowerId !== "string" || typeof toTowerId !== "string" || typeof idempotencyKey !== "string") {
    return NextResponse.json(
      { error: "fromTowerId (string), toTowerId (string), and idempotencyKey (string) are required." },
      { status: 400 }
    );
  }

  const repo = new SupabaseTowersRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await applyMove(repo, {
      attemptId: params.attemptId,
      fromTowerId,
      toTowerId,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TowersAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TowersScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TowersAttemptNotInProgressError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof TowersStaleAttemptStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof TowersIllegalMoveError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("MOVE_TOP_PIECE failed:", err);
    return NextResponse.json({ error: "Failed to apply Towers move." }, { status: 500 });
  }
}
