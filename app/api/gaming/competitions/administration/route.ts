import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { describeAdministration } from "@/lib/gaming/competitions/administration";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * GET /api/gaming/competitions/administration — the competitions the signed-in member ACTIVELY ORGANIZES (UG-CR-GATE-100): the
 * only data source of the default /competitions-admin.html experience.
 *
 * It is not member discovery and shares nothing with GET /api/gaming/competitions. The scoping is decided here, on the server,
 * from the caller's own relationship to each competition: `access: "ORGANIZER"` for competitions the caller organizes that are still
 * being run. Nothing else is ever returned: not an unrelated open or internal competition, not a scorekeeper appointment (scorekeeper
 * access is contextual to ONE addressed competition — GET .../[competitionId]/scorekeeper-administration), not a captaincy or
 * registration, not an application or capability, not a revoked organizer's pilot, and not a completed or cancelled competition.
 *
 * `operations.createCompetition` tells the page whether THIS caller may start a general competition: true only for the active internal
 * OPERATIONAL authority that the create-competition function itself requires. A member with no administrative relationship receives
 * exactly `{ "competitions": [], "operations": { "createCompetition": false } }` — the same body as every other such member — which
 * reveals nothing about what exists. The page offers no creation control unless that boolean is exactly `true`.
 *
 * Each entry carries only: competitionId, name, state, access. Never an organizer id, public code, count or authority detail.
 * Never cached. Authentication follows the existing bounded contract (401); internal failures are a generic 500.
 */
export async function GET(request: Request) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return noStore(unavailable);

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500, headers: NO_STORE });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return noStore(auth.errorResponse);

  try {
    const { competitions, operations } = await describeAdministration(buildCompetitionsRepo(credentials), auth.gamingMemberId);
    return NextResponse.json({ competitions, operations }, { headers: NO_STORE });
  } catch (err) {
    console.error("GET_ADMINISTRABLE_COMPETITIONS failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load your competitions." }, { status: 500, headers: NO_STORE });
  }
}
