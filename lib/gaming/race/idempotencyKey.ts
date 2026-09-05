/**
 * URBANO Race Slice 001 — the one shared idempotency-key contract used
 * across every layer (UG-CR-GATE-026's key validation boundary):
 * browser (public/race.html's own uuid()/isValidIdempotencyKey()),
 * this API-route-level validator, and the database (both ledger
 * tables' idempotency_key columns are the native `uuid` type — see
 * supabase/migrations/20260904085836_create_race_events.sql). A
 * standard RFC 4122 UUID string, produced by crypto.randomUUID() in
 * the browser. Rejecting a malformed key here, before any repository
 * call, keeps a bad value from ever reaching the database as anything
 * other than a clean 400 — Postgres would otherwise reject it too (the
 * column type guarantees that independently), but as a raw type-cast
 * error, not a deliberate application-level validation response.
 */

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && IDEMPOTENCY_KEY_PATTERN.test(value);
}
