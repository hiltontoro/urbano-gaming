import { NextResponse } from "next/server";
import { resolveDuelExceptionally } from "@/lib/session/resolveDuelExceptionally";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import type { DuelExceptionalResolution } from "@/lib/session/types";
import {
  DuelNotFoundError,
  HostTokenMismatchError,
  DuelAlreadyResolvedError,
  InvalidDuelResolutionError,
  DuelReasonRequiredError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/resolve-exceptionally —
 * RESOLVE_DUEL_EXCEPTIONALLY
 *
 * Duel / SESSION_SUBGAME v1. Host-authenticated only, via body
 * hostToken. The Host's exceptional-resolution tier — CANCELLED,
 * VOID, or a named competitor's FORFEIT — for a stalled or disputed
 * Duel. Never callable against an already-COMPLETED Duel.
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
  let resolution: unknown;
  let reason: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    duelId = body?.duelId;
    resolution = body?.resolution;
    reason = body?.reason;
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
  if (
    typeof resolution !== "string" ||
    !["CANCELLED", "VOID", "FORFEIT_A", "FORFEIT_B"].includes(resolution)
  ) {
    return NextResponse.json(
      { error: "resolution is required and must be one of CANCELLED, VOID, FORFEIT_A, FORFEIT_B." },
      { status: 400 }
    );
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return NextResponse.json(
      { error: "reason, if supplied, must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await resolveDuelExceptionally(
      repo,
      duelId,
      hostToken,
      resolution as DuelExceptionalResolution,
      typeof reason === "string" ? reason : null
    );
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
    if (
      err instanceof InvalidDuelResolutionError ||
      err instanceof DuelReasonRequiredError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("RESOLVE_DUEL_EXCEPTIONALLY failed:", err);
    return NextResponse.json(
      { error: "Failed to resolve Duel exceptionally." },
      { status: 500 }
    );
  }
}
