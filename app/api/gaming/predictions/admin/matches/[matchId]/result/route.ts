import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { saveDraftResult, startResultCorrection } from "@/lib/gaming/predictions/adminCatalog";
import type { OfficialGoalEventInput } from "@/lib/gaming/predictions/types";

/**
 * GET: the Match's current draft (if any) and current finalized Result
 * Version, each with their own official goal events — enough for the
 * admin surface to render "Enter Result" vs "Start Correction" vs
 * "Result already finalized, editing this draft is a correction."
 *
 * POST: saves a draft. If the Match has no finalized Result yet, this
 * is first-time draft entry (saveDraftResult). If it already has one,
 * this is a correction draft (startResultCorrection, supersedes the
 * current finalized version) — the caller does not choose which; it is
 * derived from the Match's own state, so the UI cannot accidentally
 * send the wrong kind of draft.
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
  const draft = await repo.getDraftMatchResult(params.matchId);
  const currentFinalized = await repo.getCurrentFinalizedMatchResult(params.matchId);

  const draftGoalEvents = draft ? await repo.listGoalEventsForResult(draft.matchResultId) : [];
  const finalizedGoalEvents = currentFinalized
    ? await repo.listGoalEventsForResult(currentFinalized.matchResultId)
    : [];

  return NextResponse.json({
    draft: draft ? { ...draft, goalEvents: draftGoalEvents } : null,
    currentFinalized: currentFinalized
      ? { ...currentFinalized, goalEvents: finalizedGoalEvents }
      : null,
  });
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

  const { homeScore, awayScore, officialGoalEvents } = body;
  if (
    typeof homeScore !== "number" ||
    typeof awayScore !== "number" ||
    !Array.isArray(officialGoalEvents)
  ) {
    return NextResponse.json({ error: "Invalid result payload." }, { status: 400 });
  }

  const events: OfficialGoalEventInput[] = officialGoalEvents.map((e: any) => ({
    scorerPlayerId: e?.scorerPlayerId,
    minuteRegulation: e?.minuteRegulation,
    minuteStoppage: e?.minuteStoppage ?? null,
    isOwnGoal: e?.isOwnGoal ?? false,
  }));

  const repo = buildPredictionsRepo(credentials);

  try {
    const currentFinalized = await repo.getCurrentFinalizedMatchResult(params.matchId);
    const result = currentFinalized
      ? await startResultCorrection(repo, {
          matchId: params.matchId,
          homeScore,
          awayScore,
          officialGoalEvents: events,
          enteredByGamingMemberId: admin.gamingMemberId,
        })
      : await saveDraftResult(repo, {
          matchId: params.matchId,
          homeScore,
          awayScore,
          officialGoalEvents: events,
          enteredByGamingMemberId: admin.gamingMemberId,
        });
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("SAVE_DRAFT_RESULT failed:", err);
    return NextResponse.json({ error: "Failed to save draft result." }, { status: 500 });
  }
}
