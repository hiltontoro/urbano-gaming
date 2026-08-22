import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireGamingAdmin,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { finalizeMatchResult } from "@/lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "@/lib/gaming/predictions/correctMatchResult";
import { MatchResultNotFoundError } from "@/lib/gaming/predictions/types";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "@/lib/gaming/authority/types";

/**
 * POST /api/gaming/predictions/admin/matches/[matchId]/result/finalize
 * — finalizes the Match's current draft. Whether that means
 * finalize_match_result_atomically (first-time) or
 * correct_match_result_atomically (the draft supersedes an earlier
 * finalized version) is derived from the draft's own
 * supersedesMatchResultId — a single "Finalize" action from the admin
 * surface's point of view.
 */
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
  const admin = await requireGamingAdmin(request, credentials);
  if ("errorResponse" in admin) return admin.errorResponse;

  const repo = buildPredictionsRepo(credentials);

  let reason: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string") {
      reason = (body as { reason: string }).reason;
    }
  } catch {
    // No body, or non-JSON body — reason stays null, matching every
    // other optional-field route in this codebase's own tolerance for
    // an empty POST body.
  }

  try {
    const draft = await repo.getDraftMatchResult(params.matchId);
    if (!draft) throw new MatchResultNotFoundError();

    const result = draft.supersedesMatchResultId
      ? await correctMatchResult(repo, draft.matchResultId, admin.gamingMemberId, reason ?? "")
      : await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId, reason);

    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof InsufficientPlatformAuthorityError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ReasonRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("FINALIZE_RESULT failed:", err);
    return NextResponse.json({ error: "Failed to finalize result." }, { status: 500 });
  }
}
