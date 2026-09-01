import { NextResponse } from "next/server";
import { getAttempt } from "@/lib/gaming/towers/getAttempt";
import { SupabaseTowersRepository } from "@/lib/gaming/towers/db/supabaseTowersRepository";
import { TowersAttemptNotFoundError } from "@/lib/gaming/towers/types";

/**
 * GET /api/gaming/towers/attempts/[attemptId] — GET_ATTEMPT. Reload/
 * reconnect always calls this. Cache-Control: no-store is required, not
 * decorative — see the Rutas Slice 001 implementation record for the
 * exact defect class this defends against (a browser or Next.js-layer
 * cache serving a frozen response after the attempt has genuinely
 * changed server-side). This route's response changes on every mutation
 * and must never be cached by any layer.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { attemptId: string } }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const repo = new SupabaseTowersRepository(supabaseUrl, supabaseServiceKey);

  try {
    const attempt = await getAttempt(repo, params.attemptId);
    return NextResponse.json(attempt, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof TowersAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    console.error("GET_ATTEMPT failed:", err);
    return NextResponse.json({ error: "Failed to load Towers attempt." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
