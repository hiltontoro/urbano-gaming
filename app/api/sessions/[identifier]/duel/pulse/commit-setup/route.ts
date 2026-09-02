import { NextResponse } from "next/server";
import { commitPulseSetup } from "@/lib/session/commitPulseSetup";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  PulseNotFoundError,
  PulseAccessDeniedError,
  PulseNotActiveError,
  PulseSetupAlreadyCommittedError,
  PulseInvalidSetupError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/pulse/commit-setup —
 * COMMIT_SETUP
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Participant-authenticated
 * only (Bearer), mirrors duel/respond's own convention exactly. The
 * server always fully revalidates forms regardless of wasAssisted.
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

  const { duelId, forms, wasAssisted, idempotencyKey } = body ?? {};
  if (typeof duelId !== "string" || duelId.length === 0) {
    return NextResponse.json({ error: "duelId is required and must be a string." }, { status: 400 });
  }
  if (!Array.isArray(forms)) {
    return NextResponse.json({ error: "forms is required and must be an array." }, { status: 400 });
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return NextResponse.json({ error: "idempotencyKey is required and must be a string." }, { status: 400 });
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await commitPulseSetup(
      repo,
      duelId,
      participantToken,
      forms as any,
      Boolean(wasAssisted),
      idempotencyKey
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PulseNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PulseAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PulseNotActiveError || err instanceof PulseSetupAlreadyCommittedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PulseInvalidSetupError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }

    console.error("COMMIT_PULSE_SETUP failed:", err);
    return NextResponse.json({ error: "Failed to commit Pulse setup." }, { status: 500 });
  }
}
