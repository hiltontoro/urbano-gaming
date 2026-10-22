import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { saveMatchResultDraft } from "@/lib/gaming/predictions/adminCatalog";
import { readResultView } from "@/lib/gaming/predictions/resultView";
import type { OfficialGoalEventInput } from "@/lib/gaming/predictions/types";

/**
 * GET: the Match's current draft (if any) and current finalized Result
 * Version, each with their own official goal events and the contentDigest
 * of exactly that content — enough for the admin surface to render
 * "Enter Result" vs "Start Correction" vs "Result already finalized,
 * editing this draft is a correction", and to finalize only content it
 * has actually loaded and reviewed. Each view is verified so the digest
 * always describes the score and events returned beside it.
 *
 * POST: saves a draft in one transaction. Whether the draft is a first
 * result or a correction of the current finalized one is decided inside
 * that transaction (reported as isCorrection) — the caller does not
 * choose which, and the route does not guess from a separate read. The
 * body must carry saveBase: the token GET returned for the state the
 * caller loaded (the draft's digest, FINAL:<digest> when only a finalized
 * result existed, or NONE). A save whose state changed since — a draft
 * edited, finalized or corrected meanwhile — is rejected with 409; invalid
 * data is rejected without changing the prior draft.
 */
export async function GET(
  request: Request,
  { params }: { params: { matchId: string } }
) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requireAnyAdminAuthority(request, credentials);
  if ("errorResponse" in admin) return admin.errorResponse;

  const repo = buildPredictionsRepo(credentials);
  try {
    const { draft, currentFinalized, saveBase } = await readResultView(repo, params.matchId);
    return NextResponse.json({ draft, currentFinalized, saveBase });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("READ_RESULT failed:", err);
    return NextResponse.json({ error: "Failed to load the result." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: { matchId: string } }
) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { homeScore, awayScore, officialGoalEvents, saveBase } = body;
  if (
    typeof homeScore !== "number" ||
    typeof awayScore !== "number" ||
    !Array.isArray(officialGoalEvents)
  ) {
    return NextResponse.json({ error: "Invalid result payload." }, { status: 400 });
  }
  if (typeof saveBase !== "string" || saveBase.trim().length === 0) {
    return NextResponse.json(
      { error: "saveBase is required: send the saveBase returned when you loaded this result." },
      { status: 400 }
    );
  }

  const events: OfficialGoalEventInput[] = officialGoalEvents.map((e: any) => ({
    scorerPlayerId: e?.scorerPlayerId,
    minuteRegulation: e?.minuteRegulation,
    minuteStoppage: e?.minuteStoppage ?? null,
    isOwnGoal: e?.isOwnGoal ?? false,
  }));

  const repo = buildPredictionsRepo(credentials);

  try {
    const result = await saveMatchResultDraft(repo, {
      matchId: params.matchId,
      homeScore,
      awayScore,
      officialGoalEvents: events,
      enteredByGamingMemberId: admin.gamingMemberId,
      saveBase: saveBase.trim(),
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("SAVE_DRAFT_RESULT failed:", err);
    return NextResponse.json({ error: "Failed to save draft result." }, { status: 500 });
  }
}
