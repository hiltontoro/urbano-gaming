import { NextResponse } from "next/server";

/**
 * URBANO Race production-availability guard (Race Availability
 * Containment Gate). Fail-closed by construction: only the exact
 * string "true" enables the capability — absent, empty, "false", or
 * any other value (a stray space, "TRUE", "1") all normalize to
 * unavailable, with no per-case branching required. Never inferred by
 * probing a table at runtime, and never derived from environment
 * name, hostname, branch, Vercel context, authentication, or the
 * presence of another Product's own schema — this environment
 * variable is the ONLY signal. Read fresh on every call, never
 * cached, so a value change takes effect immediately.
 *
 * Race has no pre-existing shared HTTP boundary module the way
 * Competitions' httpAuth.ts does (every Race route inlines its own
 * Supabase-credentials check) — this file is the one new, narrowly-
 * scoped addition needed to centralize the readiness decision once,
 * rather than 7 independently written copies of the same check.
 * Mirrors the accepted Competitions guard (lib/gaming/competitions/
 * httpAuth.ts, requireCompetitionsSchemaReady) and the original Pulse
 * precedent (commit 18c4751, PULSE_PRODUCTION_SCHEMA_READY) exactly in
 * shape.
 */
export function normalizeRaceSchemaReady(rawValue: string | undefined): boolean {
  return rawValue === "true";
}

export function isRaceSchemaReady(): boolean {
  return normalizeRaceSchemaReady(process.env.RACE_SCHEMA_READY);
}

const RACE_UNAVAILABLE_MESSAGE =
  "URBANO Race is temporarily unavailable while its database is being prepared.";

/**
 * The one call every Race route handler makes FIRST — before reading
 * Supabase credentials, authenticating, parsing a request body,
 * constructing a repository, or touching Supabase in any way. Returns
 * the exact response to return immediately when unavailable, or null
 * when the handler may proceed normally. The response body is
 * deliberately generic: no stack trace, table/relation name,
 * migration number, provider identifier, or raw environment value is
 * ever included.
 */
export function requireRaceSchemaReady(): NextResponse | null {
  if (isRaceSchemaReady()) return null;
  return NextResponse.json({ error: RACE_UNAVAILABLE_MESSAGE }, { status: 503 });
}
