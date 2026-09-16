import { NextResponse } from "next/server";

/**
 * URBANO Pulse production-availability guard (UG-CR-GATE-050, replacing
 * the duplicated hardcoded PULSE_PRODUCTION_SCHEMA_READY constant that
 * previously lived only in duel/start/route.ts and covered only the
 * PULSE branch of that one shared route). Fail-closed by construction:
 * only the exact string "true" enables the capability — absent, empty,
 * "false", or any other value (a stray space, "TRUE", "1") all
 * normalize to unavailable, with no per-case branching required. Never
 * inferred by probing a table at runtime, and never derived from
 * environment name, hostname, branch, Vercel context, authentication,
 * or the presence of another Product's own schema — this environment
 * variable is the ONLY signal. Read fresh on every call, never cached,
 * so a value change takes effect immediately and a per-request
 * evaluation never captures a stale value at module load.
 *
 * Mirrors lib/gaming/race/schemaAvailability.ts and lib/gaming/
 * competitions/httpAuth.ts's own requireCompetitionsSchemaReady exactly
 * in shape.
 */
export function normalizePulseSchemaReady(rawValue: string | undefined): boolean {
  return rawValue === "true";
}

export function isPulseSchemaReady(): boolean {
  return normalizePulseSchemaReady(process.env.PULSE_SCHEMA_READY);
}

const PULSE_UNAVAILABLE_MESSAGE =
  "Pulse is temporarily unavailable while its database schema is being prepared. Try again later.";

/**
 * The one call every Pulse route handler makes FIRST — before reading
 * Supabase credentials, authenticating, parsing a request body,
 * constructing a repository, generating randomness, or touching Pulse
 * in any way. Returns the exact response to return immediately when
 * unavailable, or null when the handler may proceed normally. The
 * response body is deliberately generic: no stack trace, table/
 * relation name, migration number, provider identifier, or raw
 * environment value is ever included.
 */
export function requirePulseSchemaReady(): NextResponse | null {
  if (isPulseSchemaReady()) return null;
  return NextResponse.json({ error: PULSE_UNAVAILABLE_MESSAGE }, { status: 503 });
}
