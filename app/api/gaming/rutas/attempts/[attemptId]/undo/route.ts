import { NextResponse } from "next/server";
import { undoMove } from "@/lib/gaming/rutas/undoMove";
import { SupabaseRutasRepository } from "@/lib/gaming/rutas/db/supabaseRutasRepository";
import {
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasNothingToUndoError,
} from "@/lib/gaming/rutas/types";

/**
 * POST /api/gaming/rutas/attempts/[attemptId]/undo — UNDO_MOVE
 *
 * Body: { idempotencyKey }. Single-step: reverses only the immediately
 * preceding MOVE. No target is ever accepted from the client — see
 * undoMove.ts.
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

  const { idempotencyKey } = body ?? {};
  if (typeof idempotencyKey !== "string") {
    return NextResponse.json({ error: "idempotencyKey (string) is required." }, { status: 400 });
  }

  const repo = new SupabaseRutasRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await undoMove(repo, { attemptId: params.attemptId, idempotencyKey });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RutasAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RutasAttemptNotInProgressError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RutasNothingToUndoError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("UNDO_MOVE failed:", err);
    return NextResponse.json({ error: "Failed to undo Rutas move." }, { status: 500 });
  }
}
