import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { hasOrganizerAccess } from "@/lib/gaming/competitions/administration";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * GET /api/gaming/competitions/organizer-access — whether the signed-in member currently holds Organizer Access, as one
 * bounded boolean: `{ "organizerAccess": true | false }` and nothing else (UG-CR-GATE-100).
 *
 * Route name: it lives in the Competitions API, gated only by Competitions readiness — NOT under /host/, whose routes are
 * gated by the application-availability flag and carry the retired "host" vocabulary. It therefore keeps working while
 * applications to host competitions are closed, which is exactly when an already-approved Competition Organizer must still be
 * recognized. A static segment, it takes precedence over [competitionId] (as /resolve already does), and it mirrors the
 * public label "Organizer Access".
 *
 * True means: the caller currently holds ACTIVE organizer authority — they organize at least one competition that is still being run (and,
 * if it is a host's pilot, that access has not been revoked). A finished competition (COMPLETE, CANCELLED_WITHOUT_CHAMPION) gives none.
 * Applicants, rejected applicants, approved members who have not yet created a pilot (an unused capability is not authority over any
 * competition), revoked organizers, scorekeepers (a scorekeeper is never global organizer access), captains, registrants and members who
 * merely hold the internal OPERATIONAL authority all receive false. The response never carries a name, identifier, count, role,
 * application, capability or authority detail, and is never cached.
 *
 * Authentication follows the existing bounded contract (requireGamingMember): a missing, invalid or expired token is a 401.
 * Any internal failure is a 500 with a generic message, never a `true`.
 *
 * HOME INTEGRATION CONTRACT (the consumer is the Home page; this route changes nothing there):
 *   - show `Organizer Access` ONLY when the page has an authenticated session AND this request returned HTTP 200 with a body
 *     that is exactly one key, `organizerAccess`, whose value is the boolean `true`;
 *   - signed out, first paint, pending, `false`, 401/403/500/503, timeout, network error or any malformed body: do not show it;
 *   - destination: /competitions-admin.html. This route says nothing about member discovery or about application availability.
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
    const organizerAccess = (await hasOrganizerAccess(buildCompetitionsRepo(credentials), auth.gamingMemberId)) === true;
    return NextResponse.json({ organizerAccess }, { headers: NO_STORE });
  } catch (err) {
    console.error("GET_ORGANIZER_ACCESS failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Could not determine organizer access." }, { status: 500, headers: NO_STORE });
  }
}
