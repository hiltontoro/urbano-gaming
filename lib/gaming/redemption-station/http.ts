import { NextResponse } from "next/server";

import { getSupabaseCredentials, buildPredictionsRepo } from "@/lib/gaming/predictions/httpAuth";
import { SupabaseStationRepository } from "./db/supabaseStationRepository";
import { authenticate, type StationContext, type StationDeps } from "./service";
import {
  InvalidPinError,
  InvalidStationRequestError,
  PrizeCodeNotFoundError,
  PrizeNotAvailableError,
  PublicCodeCollisionError,
  StationClosedError,
  StationLockedError,
  StationMisconfiguredError,
  StationNotActivatedError,
  StationNotFoundError,
  StationUnauthorizedError,
} from "./types";

/** The station answers are never cached, never indexed and never leak the address of the page that linked to them. */
export const STATION_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export const COOKIE_NAME = "urbano_canje";

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...STATION_HEADERS, ...extra } });
}

export function buildStationDeps(): StationDeps | null {
  const credentials = getSupabaseCredentials();
  if (!credentials) return null;
  return { stations: new SupabaseStationRepository(credentials.url, credentials.serviceKey), predictions: buildPredictionsRepo(credentials) };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** A browser that is not on this site's own page does not get to act: the Origin (or Sec-Fetch-Site) must be this site's. */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: string, request: Request): string {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api/gaming/canje; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/gaming/canje; Max-Age=0`;
}

export function errorResponse(error: unknown) {
  if (error instanceof StationNotFoundError) return json({ error: "Not found.", code: "STATION_NOT_FOUND" }, 404);
  if (error instanceof StationClosedError) return json({ error: "Este puesto de canje está cerrado.", code: "STATION_CLOSED" }, 410, { "set-cookie": clearCookie() });
  if (error instanceof StationLockedError) return json({ error: "Demasiados intentos. Espera unos minutos.", code: "TOO_MANY_ATTEMPTS", retryAfterSeconds: error.retryAfterSeconds }, 429, { "retry-after": String(error.retryAfterSeconds) });
  if (error instanceof InvalidPinError) return json({ error: "El PIN no es correcto.", code: "INVALID_PIN" }, 401);
  if (error instanceof StationUnauthorizedError) return json({ error: "La sesión terminó. Entra de nuevo con el PIN.", code: "SESSION_INVALID" }, 401, { "set-cookie": clearCookie() });
  if (error instanceof InvalidStationRequestError) return json({ error: error.message, code: "INVALID_REQUEST" }, 400);
  if (error instanceof PrizeCodeNotFoundError) return json({ error: "Ese código no es un premio de este puesto.", code: "PRIZE_CODE_NOT_FOUND" }, 404);
  if (error instanceof PrizeNotAvailableError) return json({ error: "Este premio no se puede entregar desde aquí. Consulta con URBANO.", code: "PRIZE_NOT_AVAILABLE" }, 409);
  if (error instanceof StationNotActivatedError) return json({ error: "Este puesto de canje todavía no está activado. Avisa a URBANO.", code: "STATION_NOT_ACTIVATED" }, 409);
  if (error instanceof StationMisconfiguredError) return json({ error: "El puesto no puede operar ahora. Avisa a URBANO.", code: "STATION_UNAVAILABLE" }, 503);
  if (error instanceof PublicCodeCollisionError) return json({ error: "El puesto no puede operar ahora. Avisa a URBANO.", code: "CODE_COLLISION" }, 503);
  return null;
}

export async function authenticateRequest(deps: StationDeps, slug: string, request: Request): Promise<StationContext> {
  return authenticate(deps, slug, tokenFromRequest(request));
}
