import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import {
  DRAW_NOT_FOUND_MESSAGE,
  createCompetitionDraw,
  drawFailure,
  parseDrawRequest,
  publicDraw,
  readCompetitionDraw,
} from "@/lib/gaming/competitions/draw";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * One answer for everything that is not the active organizer or a frozen captain reading their own competition's draw: a malformed identifier, an unknown
 * competition, an unrelated member, a scorekeeper, a registrant, an operational grant, a former host. It carries no state, role or draw and no hint of whether
 * anything exists, and it is uncached. (The existing authentication boundary still answers 401 first, from the credential alone.)
 */
function notAvailable() {
  return NextResponse.json({ error: DRAW_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
}

/**
 * GET /api/gaming/competitions/[competitionId]/draw — the permanent draw of ONE addressed competition (UG-CR-GATE-SSS-019). Only the active organizer (who is told
 * `{ draw: null }` until a draw exists) and, once a draw exists, the four frozen captains with current access are answered; the database decides who they are.
 * Everyone else, and every unknown or malformed address, receives the one identical 404 above. The answer is `{ draw }`, bounded and uncached, and carries no
 * identifier of a member, an intent or a freeze record.
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
    const read = await readCompetitionDraw(repo, competitionId, auth.gamingMemberId);
    if (!read) return notAvailable();
    return NextResponse.json({ draw: read.draw ? publicDraw(read.draw) : null }, { headers: NO_STORE });
  } catch (err) {
    console.error("GET_COMPETITION_DRAW failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to load the draw." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/gaming/competitions/[competitionId]/draw — MAKE_COMPETITION_DRAW. The body is exactly `{ intentId }`: no seed, teams, order, pairing, format or actor
 * is ever accepted — the organizer is always the verified caller, the teams are the registration freeze's, and the entropy is generated inside the one atomic
 * database operation (lock, exact ownership, host revocation, replay, lifecycle, freeze, pending plan change, entropy, the permanent record), so this route is never
 * the only guard.
 *
 * 201 for a new draw; 200 for an exact replay of the same request (`alreadyDrawn`); 400 with every problem found; 404 for anyone who is not the active organizer;
 * 409 for a refusal with its stable code (the wrong state, the freeze missing or inconsistent, a pending plan change, a draw already made).
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
    const { intentId } = parseDrawRequest(body);
    const repo = buildCompetitionsRepo(credentials);
    const result = await createCompetitionDraw(repo, competitionId, auth.gamingMemberId, intentId);
    return NextResponse.json({ draw: publicDraw(result.draw), alreadyDrawn: result.alreadyDrawn }, { status: result.alreadyDrawn ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    const failure = drawFailure(err);
    if (failure) return NextResponse.json(failure.body, { status: failure.status, headers: NO_STORE });
    console.error("MAKE_COMPETITION_DRAW failed:", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
    return NextResponse.json({ error: "Failed to make the draw." }, { status: 500, headers: NO_STORE });
  }
}
