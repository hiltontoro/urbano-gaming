import { NextResponse } from "next/server";
import { closeTable } from "@/lib/gaming/poker/closeTable";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import {
  PokerTableNotFoundError,
  PokerTableAccessDeniedError,
  PokerTableHasActiveHandError,
} from "@/lib/gaming/poker/types";

/**
 * POST /api/gaming/poker/tables/[identifier]/close — CLOSE_TABLE
 *
 * Host-only, same authority pattern as .../hand. Makes the table's
 * lifecycle terminal (closed_at) — legal only between Hands. Idempotent:
 * a double-tapped "End Table" reports alreadyClosed rather than erroring.
 * Never mutates Hand history; Room Registry is untouched by design (the
 * table's room code keeps resolving to this same runtimeId — see
 * lib/rooms/resolveRoom.ts's own fast-path, which is not closed_at-aware
 * by design, matching how a completed Session's room code also keeps
 * resolving).
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const pokerTableId = params.identifier;

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
  const bearerToken = bearerMatch[1];

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const table = await repo.getTableById(pokerTableId);
    if (!table) {
      return NextResponse.json(
        { error: "No poker table exists for this id." },
        { status: 404 }
      );
    }
    if (bearerToken !== table.hostToken) {
      throw new PokerTableAccessDeniedError();
    }

    const result = await closeTable(repo, pokerTableId);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PokerTableNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PokerTableAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PokerTableHasActiveHandError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("CLOSE_TABLE failed:", err);
    return NextResponse.json(
      { error: "Failed to close poker table." },
      { status: 500 }
    );
  }
}
