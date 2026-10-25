import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireGamingMember,
} from "@/lib/gaming/predictions/httpAuth";
import { buildLegalRepo, currentLegalRegistry, legalErrorResponse } from "@/lib/gaming/legal/httpLegal";
import { acceptConditions, conditionStatus, type SubmittedAcceptance } from "@/lib/gaming/legal/requirements";
import { InvalidLegalSubmissionError } from "@/lib/gaming/legal/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ITEM_FIELDS = ["documentKey", "documentVersion", "contentSha256", "ageDeclared18"];

/**
 * GET /api/gaming/legal/acceptances — the caller's own acts: with ?matchId=..., what that match needs and what this member has and has not
 * accepted (the same question the admission gate asks); without it, the member's own record. Always the verified caller's: no member id is
 * ever taken from the request. 401 without a session.
 */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const matchId = new URL(request.url).searchParams.get("matchId");
  try {
    const legalRepo = buildLegalRepo(credentials);
    if (matchId === null) {
      const rows = await legalRepo.listForMember(auth.gamingMemberId);
      return NextResponse.json(
        {
          acceptances: rows.map((row) => ({
            documentKey: row.documentKey,
            documentVersion: row.documentVersion,
            actType: row.actType,
            scopeMatchId: row.scopeMatchId,
            locale: row.locale,
            acceptedAt: row.acceptedAt,
          })),
        },
        { headers: { "cache-control": "no-store" } }
      );
    }
    if (!UUID.test(matchId)) return NextResponse.json({ error: "matchId must be a match id." }, { status: 400 });
    const match = await buildPredictionsRepo(credentials).getMatchById(matchId);
    if (!match) return NextResponse.json({ error: "No match exists for this id." }, { status: 404 });
    const status = await conditionStatus(legalRepo, currentLegalRegistry(), { matchId: match.matchId, kickoffAt: match.kickoffAt }, auth.gamingMemberId);
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("LIST_LEGAL_ACCEPTANCES failed:", err);
    return NextResponse.json({ error: "Failed to read the acceptances." }, { status: 500 });
  }
}

/**
 * POST /api/gaming/legal/acceptances — { matchId, acceptances: [{ documentKey, documentVersion, contentSha256, ageDeclared18? }] }.
 * Records the caller's own acts for that match's current texts. Each one names the version and the hash of the text the member was shown:
 * a stale one is refused (409), the event rules need the declaration of being 18 or older (400), a text that is not published cannot be
 * accepted (409). Idempotent: asking again records nothing new (200); anything new is 201.
 */
export async function POST(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new InvalidLegalSubmissionError("Invalid acceptance payload.");
    const { matchId, acceptances, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new InvalidLegalSubmissionError(`The request carries an unexpected field "${Object.keys(rest)[0]}".`);
    if (typeof matchId !== "string" || !UUID.test(matchId)) throw new InvalidLegalSubmissionError("matchId must be a match id.");
    if (!Array.isArray(acceptances) || acceptances.length === 0 || acceptances.length > 3) {
      throw new InvalidLegalSubmissionError("acceptances must list between one and three documents.");
    }
    const submitted: SubmittedAcceptance[] = acceptances.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new InvalidLegalSubmissionError("Each acceptance must be an object.");
      const record = item as Record<string, unknown>;
      for (const field of Object.keys(record)) {
        if (!ALLOWED_ITEM_FIELDS.includes(field)) throw new InvalidLegalSubmissionError(`An acceptance carries an unexpected field "${field}".`);
      }
      if (typeof record.documentKey !== "string" || typeof record.documentVersion !== "string" || typeof record.contentSha256 !== "string") {
        throw new InvalidLegalSubmissionError("An acceptance needs documentKey, documentVersion and contentSha256 as text.");
      }
      if (record.ageDeclared18 !== undefined && typeof record.ageDeclared18 !== "boolean") {
        throw new InvalidLegalSubmissionError("ageDeclared18 must be true or false.");
      }
      return {
        documentKey: record.documentKey,
        documentVersion: record.documentVersion,
        contentSha256: record.contentSha256,
        ...(record.ageDeclared18 === undefined ? {} : { ageDeclared18: record.ageDeclared18 }),
      };
    });

    const match = await buildPredictionsRepo(credentials).getMatchById(matchId);
    if (!match) return NextResponse.json({ error: "No match exists for this id." }, { status: 404 });
    const result = await acceptConditions(
      buildLegalRepo(credentials),
      currentLegalRegistry(),
      { matchId: match.matchId, kickoffAt: match.kickoffAt },
      auth.gamingMemberId,
      submitted
    );
    return NextResponse.json(
      { recorded: result.recorded, alreadyRecorded: result.alreadyRecorded, ...result.status },
      { status: result.recorded > 0 ? 201 : 200, headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    const legal = legalErrorResponse(err);
    if (legal) return legal;
    console.error("RECORD_LEGAL_ACCEPTANCE failed:", err);
    return NextResponse.json({ error: "Failed to record the acceptance." }, { status: 500 });
  }
}
