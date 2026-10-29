import { authenticateRequest, buildStationDeps, clearCookie, clientIp, errorResponse, json, readJson, sameOrigin, sessionCookie, tokenFromRequest } from "@/lib/gaming/redemption-station/http";
import { loginWithPin, logout } from "@/lib/gaming/redemption-station/service";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * POST /api/gaming/canje/{slug}/session — { pin }. Checks the shared PIN on the server (never in a page, a URL or a QR) and opens a session
 * that expires; a wrong PIN counts toward a limit per client and per station. DELETE closes the current session.
 */
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  const deps = buildStationDeps();
  if (!deps) return json({ error: "Server misconfiguration." }, 500);
  if (!sameOrigin(request)) return json({ error: "Forbidden.", code: "CROSS_ORIGIN" }, 403);
  const body = await readJson(request);
  if (!body || Object.keys(body).some((key) => key !== "pin")) return json({ error: "Invalid request.", code: "INVALID_REQUEST" }, 400);
  try {
    const { token, expiresAt } = await loginWithPin(deps, params.slug, body.pin, clientIp(request));
    return json({ ok: true, expiresAt }, 200, { "set-cookie": sessionCookie(token, expiresAt, request) });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    console.error("REDEMPTION_STATION_LOGIN failed:", error);
    return json({ error: "Failed." }, 500);
  }
}

export async function DELETE(request: Request, { params }: { params: { slug: string } }) {
  const deps = buildStationDeps();
  if (!deps) return json({ error: "Server misconfiguration." }, 500);
  if (!sameOrigin(request)) return json({ error: "Forbidden.", code: "CROSS_ORIGIN" }, 403);
  try {
    if (tokenFromRequest(request)) await logout(deps, await authenticateRequest(deps, params.slug, request));
  } catch (error) {
    if (!errorResponse(error)) console.error("REDEMPTION_STATION_LOGOUT failed:", error);
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}
