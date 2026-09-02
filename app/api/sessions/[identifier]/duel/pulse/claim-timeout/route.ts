import { NextResponse } from "next/server";
import { claimPulseTimeoutForfeit } from "@/lib/session/claimPulseTimeoutForfeit";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  PulseNotFoundError,
  PulseAccessDeniedError,
  PulseNotActiveError,
  PulseTurnNotExpiredError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/pulse/claim-timeout —
 * CLAIM_TIMEOUT
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). The CLOSE_QUIZ pattern:
 * dual-authority (either competitor may call this), participant-
 * authenticated only (Bearer). No idempotencyKey — idempotent by
 * construction (a call against an already-COMPLETED duel simply
 * returns the cached terminal facts).
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

  const { duelId } = body ?? {};
  if (typeof duelId !== "string" || duelId.length === 0) {
    return NextResponse.json({ error: "duelId is required and must be a string." }, { status: 400 });
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await claimPulseTimeoutForfeit(repo, duelId, participantToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PulseNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PulseAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PulseNotActiveError || err instanceof PulseTurnNotExpiredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("CLAIM_PULSE_TIMEOUT failed:", err);
    return NextResponse.json({ error: "Failed to claim Pulse timeout." }, { status: 500 });
  }
}
