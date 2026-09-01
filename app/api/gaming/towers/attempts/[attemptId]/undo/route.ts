import { NextResponse } from "next/server";
import { undoMove } from "@/lib/gaming/towers/undoMove";
import { SupabaseTowersRepository } from "@/lib/gaming/towers/db/supabaseTowersRepository";
import {
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersNothingToUndoError,
} from "@/lib/gaming/towers/types";

/**
 * POST /api/gaming/towers/attempts/[attemptId]/undo — UNDO_MOVE
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

  const repo = new SupabaseTowersRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await undoMove(repo, { attemptId: params.attemptId, idempotencyKey });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TowersAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TowersAttemptNotInProgressError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof TowersNothingToUndoError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("UNDO_MOVE failed:", err);
    return NextResponse.json({ error: "Failed to undo Towers move." }, { status: 500 });
  }
}
