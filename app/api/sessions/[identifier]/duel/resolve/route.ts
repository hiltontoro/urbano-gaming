import { NextResponse } from "next/server";
import { resolveDuel } from "@/lib/session/resolveDuel";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  DuelNotFoundError,
  HostTokenMismatchError,
  DuelAlreadyResolvedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/resolve — RESOLVE_DUEL
 *
 * Duel / SESSION_SUBGAME v1. Host-authenticated only, via body
 * hostToken. The normal, mechanic-derived resolution — Host-triggered
 * pacing, no timer, mirroring close-submissions/route.ts's own
 * discipline. See resolveDuel.ts for the deterministic winner logic.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  void params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let hostToken: unknown;
  let duelId: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    duelId = body?.duelId;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof hostToken !== "string" || hostToken.length === 0) {
    return NextResponse.json(
      { error: "hostToken is required and must be a string." },
      { status: 400 }
    );
  }
  if (typeof duelId !== "string" || duelId.length === 0) {
    return NextResponse.json(
      { error: "duelId is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await resolveDuel(repo, duelId, hostToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof DuelNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof DuelAlreadyResolvedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("RESOLVE_DUEL failed:", err);
    return NextResponse.json(
      { error: "Failed to resolve Duel." },
      { status: 500 }
    );
  }
}
