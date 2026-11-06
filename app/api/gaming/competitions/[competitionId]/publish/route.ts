import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { publishCompetition } from "@/lib/gaming/competitions/publishCompetition";
import {
  parsePublishRequest,
  publicScheduledPublication,
  publishScheduledCompetition,
  schedulePublicationFailure,
} from "@/lib/gaming/competitions/schedulePublication";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/**
 * How a failed publication is answered, for either request shape: the competition-level refusals (access denied, a former host, an unknown competition, the lifecycle errors the
 * manual publication always raised) by the shared status table; this gate's own typed refusals with their stable codes; anything else as a bounded 500 that names nothing.
 */
function failure(err: unknown, label: string, logWhole: boolean) {
  const status = statusForCompetitionsError(err);
  if (status) return NextResponse.json({ error: (err as Error).message }, { status, headers: NO_STORE });
  const mine = schedulePublicationFailure(err);
  if (mine) return NextResponse.json(mine.body, { status: mine.status, headers: NO_STORE });
  if (logWhole) console.error(`${label} failed:`, err);
  else console.error(`${label} failed:`, (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? "unknown");
  return NextResponse.json({ error: "Failed to publish competition." }, { status: 500, headers: NO_STORE });
}

/**
 * POST /api/gaming/competitions/[competitionId]/publish — PUBLISH_COMPETITION. The request is exactly one of two shapes, never both and never anything more:
 *
 *   - `{ scheduleProposalDigest }` (UG-CR-GATE-SSS-025): publishes the frozen, drawn four-team competition from its permanent draw and the ONE exact CURRENT schedule proposal the
 *     organizer reviewed. The server derives the teams, the pairing, the instants, the pitches, the venue, the zone, the format, the draw, the plan revision, the fixtures and the
 *     actor; every decision (lock, exact ownership, host revocation, the replay, the lifecycle, the latest and CURRENT proposal, every scheduling rule again at the publication
 *     instant) is made again inside the one atomic database operation, so this route is never the only guard. 201 for a new publication; 200 for an exact replay by the still
 *     authorized organizer (`alreadyPublished`); 400 for a request that is not exactly this shape, with every problem; 403 for anyone who is not the active organizer or a former
 *     host; 404 for an unknown competition or a proposal that is not this competition's; 409 for a refusal with its stable code.
 *   - the seven legacy manual fields (the two semifinals' teams and the three kickoff times): the MANUAL publication, retained only for competitions outside the schedule journey.
 *     The database refuses it, with the stable code SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED (409), for every competition that has a registration freeze, a draw or a schedule
 *     proposal. It is not a way to publish a new competition.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: NO_STORE });
  }

  let parsed: ReturnType<typeof parsePublishRequest>;
  try {
    parsed = parsePublishRequest(body);
  } catch (err) {
    const rejected = schedulePublicationFailure(err);
    if (rejected) return NextResponse.json(rejected.body, { status: rejected.status, headers: NO_STORE });
    throw err;
  }

  if (parsed.kind === "SCHEDULE") {
    const competitionId = params?.competitionId;
    if (typeof competitionId !== "string" || !UUID.test(competitionId)) {
      return NextResponse.json({ error: "Competition not found." }, { status: 404, headers: NO_STORE });
    }
    const repo = buildCompetitionsRepo(credentials);
    try {
      const result = await publishScheduledCompetition(repo, competitionId, auth.gamingMemberId, { scheduleProposalDigest: parsed.scheduleProposalDigest });
      return NextResponse.json(publicScheduledPublication(result), { status: result.alreadyPublished ? 200 : 201, headers: NO_STORE });
    } catch (err) {
      return failure(err, "PUBLISH_COMPETITION_SCHEDULE", false);
    }
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await publishCompetition(
      repo, params.competitionId, auth.gamingMemberId,
      parsed.semifinal1TeamAId, parsed.semifinal1TeamBId, parsed.semifinal2TeamAId, parsed.semifinal2TeamBId,
      parsed.semifinal1ScheduledAt, parsed.semifinal2ScheduledAt, parsed.finalScheduledAt
    );
    return NextResponse.json({ result }, { headers: NO_STORE });
  } catch (err) {
    return failure(err, "PUBLISH_COMPETITION", true);
  }
}
