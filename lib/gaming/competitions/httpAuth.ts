import { NextResponse } from "next/server";
import { SupabaseGamingRepository } from "../db/supabaseGamingRepository";
import { resolveGamingAuth, SupabaseAuthUserVerifier, type GamingAuthState } from "../auth";
import { SupabaseCompetitionsRepository } from "./db/supabaseCompetitionsRepository";
import {
  CompetitionNotFoundError,
  CompetitionTeamNotFoundError,
  JoinRequestNotFoundError,
  FixtureNotFoundError,
  EvidenceMissingError,
  CompetitionAccessDeniedError,
  OperationalAuthorityRequiredError,
  NotTeamCaptainError,
  ScorekeeperConflictOfInterestError,
  CompetitionNotDraftError,
  CompetitionNotPublishedError,
  JoinRequestNotPendingError,
  JoinRequestNotRejectedError,
  JoinRequestAlreadyReviewedError,
  FixtureNotOpenForRosterError,
  FixtureNotReadyForCheckinError,
  FixtureNotInEvidencePhaseError,
  FixtureNotReadyToFinalizeError,
  AlreadyTeamMemberError,
  DuplicatePendingJoinRequestError,
  CompetitionRegistrationRequiredError,
  NotOnRosterError,
  RosterMemberNotApprovedError,
  ShootoutRequiredError,
  EvidenceParticipantNotAttestedError,
  RegulationScoreEventMismatchError,
  MinimumParticipationNotMetError,
  ReasonRequiredError,
  InvalidDecisionError,
  InvalidScoreError,
  InvalidShootoutWinnerError,
  InvalidGoalTeamError,
  InvalidAssistError,
  InvalidForfeitingTeamError,
  CompetitionTeamCountInvalidError,
  CompetitionPairingInvalidError,
  UnsupportedActivityKeyError,
  EmptyRosterError,
  DuplicateRosterEntryError,
  UnsupportedTargetFactTypeError,
  TargetFactNotFoundError,
  TargetFactFixtureMismatchError,
  TargetFactNotCurrentError,
  DisputeNotAuthorizedError,
} from "./types";

/** Shared boilerplate every app/api/gaming/competitions/* route needs — mirrors lib/gaming/predictions/httpAuth.ts. */

/**
 * URBANO Gaming Competitions production-availability guard (UG-CR-
 * GATE-036). Fail-closed by construction: only the exact string "true"
 * enables the capability — absent, empty, "false", or any other value
 * (a stray space, "TRUE", "1") all normalize to unavailable, with no
 * per-case branching required. Never inferred by probing a table at
 * runtime, and never derived from environment name, hostname, branch,
 * Vercel context, or successful authentication — this environment
 * variable is the ONLY signal. Read fresh on every call, never cached,
 * so a value change takes effect immediately (this also allows a
 * contract test to flip it between calls without stale state).
 *
 * Mirrors the accepted Pulse production-containment precedent (commit
 * 18c4751, PULSE_PRODUCTION_SCHEMA_READY) — the same shape, centralized
 * once here instead of duplicated across Competitions' 20 route
 * handlers, since 19 independent copies of this same conditional would
 * itself become a reviewability and drift risk.
 */
export function normalizeCompetitionsSchemaReady(rawValue: string | undefined): boolean {
  return rawValue === "true";
}

export function isCompetitionsSchemaReady(): boolean {
  return normalizeCompetitionsSchemaReady(process.env.COMPETITIONS_SCHEMA_READY);
}

const COMPETITIONS_UNAVAILABLE_MESSAGE =
  "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";

/**
 * The one call every Competitions route handler makes FIRST — before
 * reading Supabase credentials, authenticating, parsing a request
 * body, constructing a repository, or touching Supabase in any way.
 * Returns the exact response to return immediately when unavailable,
 * or null when the handler may proceed normally. The response body is
 * deliberately generic: no stack trace, table/relation name, migration
 * number, provider identifier, or raw environment value is ever
 * included, here or anywhere else this constant is used.
 */
export function requireCompetitionsSchemaReady(): NextResponse | null {
  if (isCompetitionsSchemaReady()) return null;
  return NextResponse.json({ error: COMPETITIONS_UNAVAILABLE_MESSAGE }, { status: 503 });
}

export function getSupabaseCredentials(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

export function buildCompetitionsRepo(credentials: { url: string; serviceKey: string }) {
  return new SupabaseCompetitionsRepository(credentials.url, credentials.serviceKey);
}

/**
 * Resolves the caller as any authenticated Gaming Member. Competitions
 * owns its own organizer/captain/scorekeeper authorization directly on
 * its records (UG-CR-RPT-018 Option A) — checked inside each atomic RPC,
 * never at this HTTP boundary. This function only ever establishes WHO
 * is calling; the caller's gamingMemberId is the only actor identity a
 * route may pass to a command — never a client-supplied field.
 */
export async function requireGamingMember(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const gamingRepo = new SupabaseGamingRepository(credentials.url, credentials.serviceKey);
  const verifier = new SupabaseAuthUserVerifier(credentials.url, credentials.serviceKey);
  const authState: GamingAuthState = await resolveGamingAuth(gamingRepo, verifier, request.headers.get("authorization"));
  if (authState.status !== "authenticated") {
    return {
      errorResponse: NextResponse.json(
        { error: "A valid Authorization header for an authenticated Gaming Member is required." },
        { status: 401 }
      ),
    };
  }
  return { gamingMemberId: authState.gamingMember.gamingMemberId };
}

/** Maps a known Competitions domain error to its HTTP status; null if unrecognized. */
export function statusForCompetitionsError(err: unknown): number | null {
  if (
    err instanceof CompetitionNotFoundError ||
    err instanceof CompetitionTeamNotFoundError ||
    err instanceof JoinRequestNotFoundError ||
    err instanceof FixtureNotFoundError ||
    err instanceof EvidenceMissingError ||
    err instanceof TargetFactNotFoundError
  ) {
    return 404;
  }
  if (
    err instanceof CompetitionAccessDeniedError ||
    err instanceof OperationalAuthorityRequiredError ||
    err instanceof NotTeamCaptainError ||
    err instanceof ScorekeeperConflictOfInterestError ||
    err instanceof DisputeNotAuthorizedError
  ) {
    return 403;
  }
  if (
    err instanceof CompetitionNotDraftError ||
    err instanceof CompetitionNotPublishedError ||
    err instanceof JoinRequestNotPendingError ||
    err instanceof JoinRequestNotRejectedError ||
    err instanceof JoinRequestAlreadyReviewedError ||
    err instanceof FixtureNotOpenForRosterError ||
    err instanceof FixtureNotReadyForCheckinError ||
    err instanceof FixtureNotInEvidencePhaseError ||
    err instanceof FixtureNotReadyToFinalizeError ||
    err instanceof AlreadyTeamMemberError ||
    err instanceof DuplicatePendingJoinRequestError ||
    err instanceof CompetitionRegistrationRequiredError ||
    err instanceof NotOnRosterError ||
    err instanceof RosterMemberNotApprovedError ||
    err instanceof ShootoutRequiredError ||
    err instanceof EvidenceParticipantNotAttestedError ||
    err instanceof RegulationScoreEventMismatchError ||
    err instanceof MinimumParticipationNotMetError ||
    err instanceof TargetFactNotCurrentError
  ) {
    return 409;
  }
  if (
    err instanceof ReasonRequiredError ||
    err instanceof InvalidDecisionError ||
    err instanceof InvalidScoreError ||
    err instanceof InvalidShootoutWinnerError ||
    err instanceof InvalidGoalTeamError ||
    err instanceof InvalidAssistError ||
    err instanceof InvalidForfeitingTeamError ||
    err instanceof CompetitionTeamCountInvalidError ||
    err instanceof CompetitionPairingInvalidError ||
    err instanceof UnsupportedActivityKeyError ||
    err instanceof EmptyRosterError ||
    err instanceof DuplicateRosterEntryError ||
    err instanceof UnsupportedTargetFactTypeError ||
    err instanceof TargetFactFixtureMismatchError
  ) {
    return 400;
  }
  return null;
}
