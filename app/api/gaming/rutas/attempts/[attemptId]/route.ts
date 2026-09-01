import { NextResponse } from "next/server";
import { getAttempt } from "@/lib/gaming/rutas/getAttempt";
import { SupabaseRutasRepository } from "@/lib/gaming/rutas/db/supabaseRutasRepository";
import { RutasAttemptNotFoundError } from "@/lib/gaming/rutas/types";

/**
 * GET /api/gaming/rutas/attempts/[attemptId] — GET_ATTEMPT. Reload/
 * reconnect always calls this. Cache-Control: no-store is required, not
 * decorative — proven live during this Slice's own browser proving: a
 * plain `fetch()` GET with no explicit cache directive was served stale
 * by the browser's default HTTP cache after the attempt had genuinely
 * completed server-side (confirmed correct in Postgres, wrong only in
 * the cached response), so reload showed an IN_PROGRESS attempt that
 * had actually reached COMPLETE. This route's response changes on every
 * mutation and must never be cached by any layer.
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

  const repo = new SupabaseRutasRepository(supabaseUrl, supabaseServiceKey);

  try {
    const attempt = await getAttempt(repo, params.attemptId);
    return NextResponse.json(attempt, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof RutasAttemptNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    console.error("GET_ATTEMPT failed:", err);
    return NextResponse.json({ error: "Failed to load Rutas attempt." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
