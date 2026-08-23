import { NextResponse } from "next/server";
import { SupabaseGamingRepository } from "../db/supabaseGamingRepository";
import {
  resolveGamingAuth,
  SupabaseAuthUserVerifier,
  type GamingAuthState,
} from "../auth";
import { SupabasePredictionsRepository } from "./db/supabasePredictionsRepository";
import { SupabaseAuthorityRepository } from "../authority/db/supabaseAuthorityRepository";
import { requirePlatformAuthority, requireAnyPlatformAuthority } from "../authority/requirePlatformAuthority";
import type { PlatformAuthorityClass } from "../authority/types";
import { InsufficientPlatformAuthorityError } from "../authority/types";
import {
  MatchNotFoundError,
  MatchCancelledError,
  KickoffPassedError,
  VenueActivationNotFoundError,
  VenueActivationMatchMismatchError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
  GeoNotEligibleError,
  GeoUnavailableError,
  InvalidPredictionScoreError,
  InvalidGoalMinuteError,
  InvalidOfficialGoalMinuteError,
  InvalidFirstTeamError,
  InvalidGoalscorerSelectionError,
  MatchResultNotFoundError,
  NotACorrectionError,
  SupersededResultNotFinalizedError,
  PrizeQualificationNotFoundError,
  QualificationSupersededError,
  InvalidPrizeTierDimensionCountError,
  DraftResultAlreadyExistsError,
  NoFinalizedResultToCorrectError,
  ResultAlreadyBeingCorrectedError,
  ActivityClassificationLockedError,
  XpEligibilityLockedError,
} from "./types";

/** Maps a known Predictions domain error to its HTTP status; null if unrecognized. */
export function statusForPredictionsError(err: unknown): number | null {
  if (
    err instanceof MatchNotFoundError ||
    err instanceof VenueActivationNotFoundError ||
    err instanceof MatchResultNotFoundError ||
    err instanceof PrizeQualificationNotFoundError
  ) {
    return 404;
  }
  if (
    err instanceof MatchCancelledError ||
    err instanceof KickoffPassedError ||
    err instanceof VenueActivationDisabledError ||
    err instanceof VenueActivationMatchMismatchError ||
    err instanceof VenueActivationImmutableError ||
    err instanceof NotACorrectionError ||
    err instanceof SupersededResultNotFinalizedError ||
    err instanceof QualificationSupersededError ||
    err instanceof DraftResultAlreadyExistsError ||
    err instanceof NoFinalizedResultToCorrectError ||
    err instanceof ResultAlreadyBeingCorrectedError ||
    err instanceof ActivityClassificationLockedError ||
    err instanceof XpEligibilityLockedError
  ) {
    return 409;
  }
  if (
    err instanceof GeoNotEligibleError ||
    err instanceof GeoUnavailableError ||
    err instanceof InvalidPredictionScoreError ||
    err instanceof InvalidGoalMinuteError ||
    err instanceof InvalidOfficialGoalMinuteError ||
    err instanceof InvalidFirstTeamError ||
    err instanceof InvalidGoalscorerSelectionError ||
    err instanceof InvalidPrizeTierDimensionCountError
  ) {
    return 400;
  }
  return null;
}

/** Shared boilerplate every app/api/gaming/predictions/* route needs. */

export function getSupabaseCredentials(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

export function buildPredictionsRepo(credentials: { url: string; serviceKey: string }) {
  return new SupabasePredictionsRepository(credentials.url, credentials.serviceKey);
}

export async function resolveRequestGamingAuth(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<GamingAuthState> {
  const gamingRepo = new SupabaseGamingRepository(credentials.url, credentials.serviceKey);
  const verifier = new SupabaseAuthUserVerifier(credentials.url, credentials.serviceKey);
  return resolveGamingAuth(gamingRepo, verifier, request.headers.get("authorization"));
}

/** Any platform authority class is sufficient to read the Predictions admin surface — see requireAnyAdminAuthority below. */
const ADMIN_READ_CLASSES: PlatformAuthorityClass[] = ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"];

/**
 * Resolves the caller as an authenticated Gaming Member holding the
 * given platform authority class, fresh-checked every call against
 * authority_grants — never cached, mirroring the former requireGamingAdmin's
 * own convention (retired in Predictions A1, superseded by this and
 * requireAnyAdminAuthority below). Classes are non-hierarchical: this
 * never passes for a caller holding only a different class.
 */
export async function requirePlatformAuthorityHttp(
  request: Request,
  credentials: { url: string; serviceKey: string },
  authorityClass: PlatformAuthorityClass
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const authState = await resolveRequestGamingAuth(request, credentials);

  if (authState.status !== "authenticated") {
    return {
      errorResponse: NextResponse.json(
        { error: "A valid Authorization header for an authenticated Gaming Member is required." },
        { status: 401 }
      ),
    };
  }

  const authorityRepo = new SupabaseAuthorityRepository(credentials.url, credentials.serviceKey);
  try {
    await requirePlatformAuthority(authorityRepo, authState.gamingMember.gamingMemberId, authorityClass);
  } catch (err) {
    if (err instanceof InsufficientPlatformAuthorityError) {
      return { errorResponse: NextResponse.json({ error: err.message }, { status: 403 }) };
    }
    throw err;
  }

  return { gamingMemberId: authState.gamingMember.gamingMemberId };
}

/**
 * Resolves the caller as an authenticated Gaming Member holding at
 * least one active platform authority class — the accepted bounded
 * read-access rule (Predictions A1 classification, §5): mutation stays
 * strictly class-specific; reads are pooled across all three classes
 * so a Finalizer-only actor can see the evidence an Operator prepared,
 * and vice versa.
 */
export async function requireAnyAdminAuthority(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const authState = await resolveRequestGamingAuth(request, credentials);

  if (authState.status !== "authenticated") {
    return {
      errorResponse: NextResponse.json(
        { error: "A valid Authorization header for an authenticated Gaming Member is required." },
        { status: 401 }
      ),
    };
  }

  const authorityRepo = new SupabaseAuthorityRepository(credentials.url, credentials.serviceKey);
  try {
    await requireAnyPlatformAuthority(authorityRepo, authState.gamingMember.gamingMemberId, ADMIN_READ_CLASSES);
  } catch (err) {
    if (err instanceof InsufficientPlatformAuthorityError) {
      return { errorResponse: NextResponse.json({ error: err.message }, { status: 403 }) };
    }
    throw err;
  }

  return { gamingMemberId: authState.gamingMember.gamingMemberId };
}

/** Resolves the caller as any authenticated Gaming Member (no admin requirement). */
export async function requireGamingMember(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const authState = await resolveRequestGamingAuth(request, credentials);
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
