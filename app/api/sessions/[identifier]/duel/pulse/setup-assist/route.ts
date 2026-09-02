import { NextResponse } from "next/server";
import { generatePulseAssistedSetup } from "@/lib/session/generatePulseAssistedSetup";

/**
 * POST /api/sessions/[identifier]/duel/pulse/setup-assist —
 * GENERATE_ASSISTED_SETUP
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Participant-authenticated
 * (Bearer), but stateless — no duelId, no repository call, nothing
 * persisted. Returns a fresh, always-valid, non-overlapping draft
 * layout; the client may edit it freely before COMMIT_SETUP, which
 * always fully revalidates the final layout server-side regardless of
 * origin (see commit-setup/route.ts).
 */
export async function POST(request: Request, { params }: { params: { identifier: string } }) {
  void params.identifier;

  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);
  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }

  const forms = generatePulseAssistedSetup();
  return NextResponse.json({ forms }, { status: 200 });
}
