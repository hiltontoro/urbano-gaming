import { getSupabaseCredentials, requirePlatformAuthorityHttp } from "@/lib/gaming/predictions/httpAuth";
import { buildStationDeps, errorResponse, json } from "@/lib/gaming/redemption-station/http";
import { revokeStationBySlug } from "@/lib/gaming/redemption-station/service";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/** POST /api/gaming/canje/{slug}/revoke — OPERATIONAL authority. Takes the access away: the station and every session of it. Idempotent. */
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  const credentials = getSupabaseCredentials();
  const deps = buildStationDeps();
  if (!credentials || !deps) return json({ error: "Server misconfiguration." }, 500);
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) { admin.errorResponse.headers.set("cache-control", "no-store"); return admin.errorResponse; }
  try {
    await revokeStationBySlug(deps, params.slug);
    return json({ ok: true, revoked: true });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_REVOKE failed:", error);
    return json({ error: "Failed." }, 500);
  }
}
