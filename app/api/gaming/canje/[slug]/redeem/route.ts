import { authenticateRequest, buildStationDeps, errorResponse, json, readJson, sameOrigin } from "@/lib/gaming/redemption-station/http";
import { redeem } from "@/lib/gaming/redemption-station/service";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * POST /api/gaming/canje/{slug}/redeem — { code, operatorName, confirm: true }. Marks ONE prize of this station as delivered through the
 * existing atomic redemption. There is no way to undo a delivery, change a prize or read another event from here.
 */
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  const deps = buildStationDeps();
  if (!deps) return json({ error: "Server misconfiguration." }, 500);
  if (!sameOrigin(request)) return json({ error: "Forbidden.", code: "CROSS_ORIGIN" }, 403);
  try {
    const ctx = await authenticateRequest(deps, params.slug, request);
    const body = await readJson(request);
    if (!body || Object.keys(body).some((key) => !["code", "operatorName", "confirm"].includes(key))) return json({ error: "Invalid request.", code: "INVALID_REQUEST" }, 400);
    const result = await redeem(deps, ctx, { code: body.code, operatorName: body.operatorName, confirm: body.confirm });
    return json({ outcome: result.outcome, prize: result.prize });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_REDEEM failed:", error);
    return json({ error: "Failed." }, 500);
  }
}
