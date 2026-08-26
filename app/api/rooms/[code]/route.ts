import { NextResponse } from "next/server";
import { resolveRoom } from "@/lib/rooms/resolveRoom";
import { SupabaseRoomRepository } from "@/lib/rooms/db/supabaseRoomRepository";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import { RoomNotFoundError, AmbiguousRoomError } from "@/lib/rooms/types";

/**
 * GET /api/rooms/[code] — RESOLVE_ROOM
 *
 * Unauthenticated, mirroring the pre-join, discovery-only posture
 * Session's and Poker's own join endpoints already have — resolving a
 * code is not yet an action against anything, and this route returns
 * nothing that requires privacy (see resolveRoom.ts's own comment on
 * exactly what is and is not returned).
 *
 * [code] is always the human-facing room code, never a runtime id —
 * that distinction only exists for callers *after* this route tells
 * them which runtime owns it.
 */
export async function GET(
  request: Request,
  { params }: { params: { code: string } }
) {
  const roomCode = params.code;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repos = {
    rooms: new SupabaseRoomRepository(supabaseUrl, supabaseServiceKey),
    sessions: new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey),
    poker: new SupabasePokerRepository(supabaseUrl, supabaseServiceKey),
  };

  try {
    const result = await resolveRoom(repos, roomCode);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RoomNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof AmbiguousRoomError) {
      // Founder decision (Room Registry Slice 001 resolution): fail
      // closed and make it loud — this can only ever involve a
      // pre-registry legacy code, never one issued after this Slice.
      console.error("RESOLVE_ROOM ambiguous collision:", { roomCode });
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("RESOLVE_ROOM failed:", err);
    return NextResponse.json(
      { error: "Failed to resolve room." },
      { status: 500 }
    );
  }
}
