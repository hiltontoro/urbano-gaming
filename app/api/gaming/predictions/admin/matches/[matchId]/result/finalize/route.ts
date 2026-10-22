import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { finalizeMatchResult } from "@/lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "@/lib/gaming/predictions/correctMatchResult";
import { MatchResultNotFoundError } from "@/lib/gaming/predictions/types";

/**
 * POST /api/gaming/predictions/admin/matches/[matchId]/result/finalize
 * — finalizes ONE named result with ONE named reviewed content. The body
 * must carry:
 *   matchResultId  the result the caller loaded and reviewed
 *   contentDigest  the digest of that result's content, as returned by
 *                  GET .../result
 *   reason         optional for a first result, required for a correction
 * Whether that means finalize_match_result_atomically (first-time) or
 * correct_match_result_atomically (the result supersedes an earlier
 * finalized version) is derived from the named result's own
 * supersedesMatchResultId — a single "Finalize" action from the admin
 * surface's point of view.
 *
 * The route never finalizes "whatever the current draft is": a missing
 * id or digest is a 400, and a digest that no longer matches the result
 * is a 409, so content that was not loaded and reviewed cannot be
 * settled. Possession of a digest is not authorization — the
 * CONSEQUENTIAL_FINALIZER check is independent and comes first. A retry
 * after a lost response is an idempotent replay only for the content
 * that was finalized.
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
  const admin = await requirePlatformAuthorityHttp(request, credentials, "CONSEQUENTIAL_FINALIZER");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: { matchResultId?: unknown; contentDigest?: unknown; reason?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    // No body, or non-JSON body — handled by the required-field checks below.
  }

  const matchResultId = typeof body.matchResultId === "string" ? body.matchResultId.trim() : "";
  const contentDigest = typeof body.contentDigest === "string" ? body.contentDigest.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : null;

  if (!matchResultId || !contentDigest) {
    return NextResponse.json(
      { error: "matchResultId and contentDigest are required: load and review the result, then finalize it." },
      { status: 400 }
    );
  }

  const repo = buildPredictionsRepo(credentials);

  try {
    const target = await repo.getMatchResultById(matchResultId);
    if (!target || target.matchId !== params.matchId) throw new MatchResultNotFoundError();

    const result = target.supersedesMatchResultId
      ? await correctMatchResult(repo, target.matchResultId, admin.gamingMemberId, contentDigest, reason ?? "")
      : await finalizeMatchResult(repo, target.matchResultId, admin.gamingMemberId, contentDigest, reason);

    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("FINALIZE_RESULT failed:", err);
    return NextResponse.json({ error: "Failed to finalize result." }, { status: 500 });
  }
}
