import { NextResponse } from "next/server";
import { restartAttempt } from "@/lib/gaming/rutas/restartAttempt";
import { SupabaseRutasRepository } from "@/lib/gaming/rutas/db/supabaseRutasRepository";
import {
  RutasAttemptAlreadyAbandonedError,
  RutasAttemptNotFoundError,
  RutasScenarioNotFoundError,
} from "@/lib/gaming/rutas/types";

/**
 * POST /api/gaming/rutas/attempts/[attemptId]/restart — RESTART_ATTEMPT
 *
 * Body: { idempotencyKey }. Creates a NEW attempt; the old one is
 * finalized ABANDONED only if it was still IN_PROGRESS — see
 * restartAttempt.ts.
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
    const result = await restartAttempt(repo, { attemptId: params.attemptId, idempotencyKey });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RutasAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RutasScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RutasAttemptAlreadyAbandonedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("RESTART_ATTEMPT failed:", err);
    return NextResponse.json({ error: "Failed to restart Rutas attempt." }, { status: 500 });
  }
}
