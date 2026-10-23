import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  PlanningIntentMismatchError,
  PlanningValidationError,
  parsePlanningSaveRequest,
  planningContextFor,
  publicRevision,
  readCompetitionPlanning,
  saveCompetitionPlanning,
} from "@/lib/gaming/competitions/planning";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * One answer for everything that is not the active organizer reading their own competition: a malformed identifier, an unknown competition, an unrelated
 * member, a scorekeeper-only member, an applicant or capability-only member, a former host. It carries no format, state, context or revision status and
 * no hint of whether anything exists, and it is uncached.
 */
function notAvailable() {
  return NextResponse.json({ error: "Planning was not found for this competition." }, { status: 404, headers: NO_STORE });
}

/**
 * GET /api/gaming/competitions/[competitionId]/planning — the current DRAFT PLAN revision of ONE addressed competition (UG-CR-GATE-SSS-004).
 * Organizer-only: the caller must be the competition's active organizer. Anyone else — and every unknown or malformed address — receives the one
 * identical 404 described above (the existing authentication boundary still answers 401 first, from the credential alone).
 *
 * For the active organizer the answer is ALWAYS a 200 with exactly `{ context, revision }`: `context` is the read-only profile of the competition's OWN
 * format (roster ranges, fixed timing, limits) and `revision` is the current saved revision, or `null` when no plan has been saved yet. Having no plan
 * yet is the normal first state of a draft, not a not-found. The response carries no identifier, no author and nothing about any other competition or venue.
 */
export async function GET(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return noStore(unavailable);

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500, headers: NO_STORE });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return noStore(auth.errorResponse);

  const competitionId = params?.competitionId;
  if (typeof competitionId !== "string" || !UUID.test(competitionId)) return notAvailable();

  try {
    const repo = buildCompetitionsRepo(credentials);
    const planning = await readCompetitionPlanning(repo, competitionId, auth.gamingMemberId);
    if (!planning) return notAvailable();
    return NextResponse.json({ context: planning.context, revision: planning.revision ? publicRevision(planning.revision) : null }, { headers: NO_STORE });
  } catch (err) {
    console.error("GET_COMPETITION_PLANNING failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load the plan." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/gaming/competitions/[competitionId]/planning — SAVE_COMPETITION_PLANNING_REVISION. The body is exactly `{ intentId, plan }`: the
 * organizer is always the verified caller, the format is always the stored competition's, and nothing else is accepted from the request. Every
 * decision is made again inside the one atomic database operation (lock, exact ownership, host revocation, DRAFT, the whole payload), so this
 * route is never the only guard.
 *
 * 201 for a new immutable revision; 200 for an exact replay of an earlier save (`alreadySaved`); 400 with every problem found; 403/404 for an
 * organizer or competition problem; 409 for a competition that is no longer a draft or an intent already used for a different plan.
 */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return noStore(unavailable);

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500, headers: NO_STORE });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return noStore(auth.errorResponse);

  const competitionId = params?.competitionId;
  if (typeof competitionId !== "string" || !UUID.test(competitionId)) return notAvailable();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: NO_STORE });
  }

  try {
    const { intentId, plan } = parsePlanningSaveRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const saved = await saveCompetitionPlanning(repo, competitionId, auth.gamingMemberId, intentId, plan);
    return NextResponse.json(
      { revision: publicRevision(saved.revision), alreadySaved: saved.alreadySaved, isCurrent: saved.isCurrent, context: planningContextFor(saved.revision.formatKey) },
      { status: saved.alreadySaved ? 200 : 201, headers: NO_STORE }
    );
  } catch (err) {
    if (err instanceof PlanningValidationError) {
      return NextResponse.json({ error: err.message, problems: err.violations }, { status: 400, headers: NO_STORE });
    }
    if (err instanceof PlanningIntentMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 409, headers: NO_STORE });
    }
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status, headers: NO_STORE });
    console.error("SAVE_COMPETITION_PLANNING failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to save the plan." }, { status: 500, headers: NO_STORE });
  }
}
