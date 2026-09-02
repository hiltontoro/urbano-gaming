import { NextResponse } from "next/server";
import { targetPulseCell } from "@/lib/session/targetPulseCell";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  PulseNotFoundError,
  PulseAccessDeniedError,
  PulseNotActiveError,
  PulseTurnExpiredError,
  PulseNotYourTurnError,
  PulseTargetOutOfBoundsError,
  PulseCellAlreadyTargetedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/pulse/target — TARGET_CELL
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Participant-authenticated
 * only (Bearer). PulseTurnExpiredError maps to 409 — the caller's own
 * signal to invoke claim-timeout instead, mirroring the CLOSE_QUIZ
 * pattern's own "explicit, dedicated resolution action" shape.
 */
export async function POST(request: Request, { params }: { params: { identifier: string } }) {
  void params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);
  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }
  const participantToken = bearerMatch[1];

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { duelId, row, col, idempotencyKey } = body ?? {};
  if (typeof duelId !== "string" || duelId.length === 0) {
    return NextResponse.json({ error: "duelId is required and must be a string." }, { status: 400 });
  }
  if (typeof row !== "number" || typeof col !== "number") {
    return NextResponse.json({ error: "row and col are required and must be numbers." }, { status: 400 });
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return NextResponse.json({ error: "idempotencyKey is required and must be a string." }, { status: 400 });
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await targetPulseCell(repo, duelId, participantToken, row, col, idempotencyKey);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PulseNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PulseAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (
      err instanceof PulseNotActiveError ||
      err instanceof PulseTurnExpiredError ||
      err instanceof PulseNotYourTurnError
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PulseTargetOutOfBoundsError || err instanceof PulseCellAlreadyTargetedError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }

    console.error("TARGET_PULSE_CELL failed:", err);
    return NextResponse.json({ error: "Failed to submit Pulse target." }, { status: 500 });
  }
}
