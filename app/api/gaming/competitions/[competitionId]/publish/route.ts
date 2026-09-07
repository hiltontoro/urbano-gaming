import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { publishCompetition } from "@/lib/gaming/competitions/publishCompetition";

/** POST /api/gaming/competitions/[competitionId]/publish — PUBLISH_COMPETITION. Organizer supplies the 4-team pairing and the 3 kickoff times. */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const {
    semifinal1TeamAId, semifinal1TeamBId, semifinal2TeamAId, semifinal2TeamBId,
    semifinal1ScheduledAt, semifinal2ScheduledAt, finalScheduledAt,
  } = body;
  if (
    typeof semifinal1TeamAId !== "string" || typeof semifinal1TeamBId !== "string" ||
    typeof semifinal2TeamAId !== "string" || typeof semifinal2TeamBId !== "string" ||
    typeof semifinal1ScheduledAt !== "string" || typeof semifinal2ScheduledAt !== "string" || typeof finalScheduledAt !== "string"
  ) {
    return NextResponse.json({ error: "Invalid publish payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await publishCompetition(
      repo, params.competitionId, auth.gamingMemberId,
      semifinal1TeamAId, semifinal1TeamBId, semifinal2TeamAId, semifinal2TeamBId,
      semifinal1ScheduledAt, semifinal2ScheduledAt, finalScheduledAt
    );
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("PUBLISH_COMPETITION failed:", err);
    return NextResponse.json({ error: "Failed to publish competition." }, { status: 500 });
  }
}
