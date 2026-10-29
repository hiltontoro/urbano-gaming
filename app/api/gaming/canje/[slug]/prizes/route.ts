import { authenticateRequest, buildStationDeps, errorResponse, json } from "@/lib/gaming/redemption-station/http";
import { listPrizes } from "@/lib/gaming/redemption-station/service";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/** GET /api/gaming/canje/{slug}/prizes — the prizes of this station's ONE activation: name, public code, prize and state. Needs a session. */
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const deps = buildStationDeps();
  if (!deps) return json({ error: "Server misconfiguration." }, 500);
  try {
    const ctx = await authenticateRequest(deps, params.slug, request);
    return json({ station: { label: ctx.station.label, expiresAt: ctx.station.expiresAt, sessionExpiresAt: ctx.session.expiresAt }, prizes: await listPrizes(deps, ctx) });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_PRIZES failed:", error);
    return json({ error: "Failed." }, 500);
  }
}
