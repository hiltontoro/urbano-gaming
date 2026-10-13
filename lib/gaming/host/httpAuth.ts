import { NextResponse } from "next/server";

import { SupabaseHostRepository } from "./db/supabaseHostRepository";
import {
  InvalidHostApplicationError,
  InvalidHostCompetitionError,
  InvalidHostDecisionError,
  InvalidHostReviewViewError,
  HostReasonRequiredError,
  HostReviewerAuthorityRequiredError,
  HostSelfReviewForbiddenError,
  HostCapabilityRequiredError,
  HostCapabilityRevokedError,
  HostApplicationNotFoundError,
  HostCapabilityNotFoundError,
  HostApplicationAlreadyActiveError,
  HostApplicationNotPendingError,
  HostApplicationAlreadyDecidedError,
  HostCapabilityAlreadyConsumedError,
} from "./types";

// Credentials and the verified-member resolver are shared with Competitions on
// purpose: there is exactly one way to establish WHO is calling, and it never
// reads an identity from the request body, query or headers other than the
// bearer token the verifier checks with Supabase Auth.
export { getSupabaseCredentials, requireGamingMember } from "../competitions/httpAuth";

/**
 * Exact-"true" feature gate, the same fail-closed shape as
 * COMPETITIONS_SCHEMA_READY: absent, empty, "false", "TRUE", "1" or a stray
 * space all mean unavailable. Read fresh on every call and never inferred from
 * environment name, hostname, branch, or a successful authentication. Until the
 * Become a Host migrations are applied to an environment this stays off, and
 * every host route answers 503 before reading credentials or touching Supabase.
 */
export function normalizeBecomeAHostSchemaReady(rawValue: string | undefined): boolean {
  return rawValue === "true";
}

export function isBecomeAHostSchemaReady(): boolean {
  return normalizeBecomeAHostSchemaReady(process.env.BECOME_A_HOST_SCHEMA_READY);
}

const HOST_UNAVAILABLE_MESSAGE = "Become a Host is not open yet.";

/** The first call every host route makes — before credentials, authentication, body parsing or any repository. */
export function requireHostSchemaReady(): NextResponse | null {
  if (isBecomeAHostSchemaReady()) return null;
  return NextResponse.json({ error: HOST_UNAVAILABLE_MESSAGE }, { status: 503 });
}

export function buildHostRepo(credentials: { url: string; serviceKey: string }) {
  return new SupabaseHostRepository(credentials.url, credentials.serviceKey);
}

/** Maps a known host domain error to its HTTP status; null if unrecognized. */
export function statusForHostError(err: unknown): number | null {
  if (err instanceof HostApplicationNotFoundError || err instanceof HostCapabilityNotFoundError) return 404;
  if (
    err instanceof HostReviewerAuthorityRequiredError ||
    err instanceof HostSelfReviewForbiddenError ||
    err instanceof HostCapabilityRequiredError ||
    err instanceof HostCapabilityRevokedError
  ) {
    return 403;
  }
  if (
    err instanceof HostApplicationAlreadyActiveError ||
    err instanceof HostApplicationNotPendingError ||
    err instanceof HostApplicationAlreadyDecidedError ||
    err instanceof HostCapabilityAlreadyConsumedError
  ) {
    return 409;
  }
  if (
    err instanceof InvalidHostApplicationError ||
    err instanceof InvalidHostCompetitionError ||
    err instanceof InvalidHostDecisionError ||
    err instanceof InvalidHostReviewViewError ||
    err instanceof HostReasonRequiredError
  ) {
    return 400;
  }
  return null;
}

/**
 * The JSON body for a known host error. Typed errors carry their own
 * plain-language messages (no database text ever reaches a browser); a
 * rejected field is named so the page can attach the message to that field.
 */
export function bodyForHostError(err: unknown): { error: string; field?: string } {
  const message = err instanceof Error ? err.message : "The request could not be completed.";
  if (err instanceof InvalidHostApplicationError || err instanceof InvalidHostCompetitionError) {
    return { error: message, field: err.field };
  }
  return { error: message };
}

/**
 * Server-side log line for an unexpected failure: the failure class and the
 * PostgREST/Postgres code only. The message is deliberately omitted — database
 * errors can quote row values, and applicant text must never reach logs.
 */
export function logHostFailure(label: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : "none";
  console.error(`${label} failed: ${name} (code ${code})`);
}
