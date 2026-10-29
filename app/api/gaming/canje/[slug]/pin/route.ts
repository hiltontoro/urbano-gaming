import { getSupabaseCredentials, requirePlatformAuthorityHttp } from "@/lib/gaming/predictions/httpAuth";
import { buildStationDeps, errorResponse, json, readJson, sameOrigin } from "@/lib/gaming/redemption-station/http";
import { setStationPin, stationAdminStatus } from "@/lib/gaming/redemption-station/service";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/** GET /api/gaming/canje/{slug}/pin — OPERATIONAL authority. The state of the station for the administration page: never the PIN, its hash or its salt. */
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const credentials = getSupabaseCredentials();
  const deps = buildStationDeps();
  if (!credentials || !deps) return json({ error: "Server misconfiguration." }, 500);
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) { admin.errorResponse.headers.set("cache-control", "no-store"); return admin.errorResponse; }
  try {
    return json(await stationAdminStatus(deps, params.slug));
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_STATUS failed:", error);
    return json({ error: "Failed." }, 500);
  }
}

/**
 * POST /api/gaming/canje/{slug}/pin — { pin, confirmPin }, OPERATIONAL authority. Sets or changes the PIN of the station WITHOUT a new
 * deployment and revokes every earlier session. The PIN is hashed here and neither stored, logged nor returned.
 */
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  const credentials = getSupabaseCredentials();
  const deps = buildStationDeps();
  if (!credentials || !deps) return json({ error: "Server misconfiguration." }, 500);
  if (!sameOrigin(request)) return json({ error: "Forbidden.", code: "CROSS_ORIGIN" }, 403);
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) { admin.errorResponse.headers.set("cache-control", "no-store"); return admin.errorResponse; }
  const body = await readJson(request);
  if (!body || Object.keys(body).some((key) => key !== "pin" && key !== "confirmPin")) return json({ error: "Invalid request.", code: "INVALID_REQUEST" }, 400);
  if (typeof body.pin !== "string" || body.pin !== body.confirmPin) return json({ error: "Los dos PIN no coinciden.", code: "PIN_MISMATCH" }, 400);
  try {
    const result = await setStationPin(deps, params.slug, body.pin, admin.gamingMemberId);
    return json({ ok: true, pinVersion: result.pinVersion, sessionsRevoked: result.sessionsRevoked });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_SET_PIN failed:", error instanceof Error ? error.name : "error");
    return json({ error: "Failed." }, 500);
  }
}
