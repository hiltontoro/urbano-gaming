import { NextResponse } from "next/server";
import { isBecomeAHostSchemaReady } from "@/lib/gaming/host/httpAuth";

// Read on every request. Without this, Next.js would evaluate a parameterless GET once at build time and freeze whatever the
// readiness variable held then.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/host/availability — whether Become a Host is open, as one bounded boolean.
 *
 * The landing page asks this before it shows an actionable Become a Host card. It is the server's own answer, read from the
 * same exact-"true" gate (BECOME_A_HOST_SCHEMA_READY) every other host route enforces: absent, empty, "false", "TRUE", "1" or a
 * stray space all mean closed. The response is exactly `{ "available": true | false }` and nothing else: no variable name or
 * value, no project, schema, provider or configuration detail, no identity. It reads no credentials, no session and no
 * database, so it cannot be used to probe any of them; it accepts no input and exposes no mutation (GET only). It is the one
 * host route that does not call requireHostSchemaReady(), because it is the readiness answer itself.
 *
 * Fail closed on the server too: if reading the gate were ever to throw, the answer is "unavailable". Not cacheable, so a
 * shared cache can never keep an old "open" after the gate is closed.
 */
export async function GET() {
  let available = false;
  try {
    available = isBecomeAHostSchemaReady() === true;
  } catch {
    available = false;
  }
  return NextResponse.json({ available }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
