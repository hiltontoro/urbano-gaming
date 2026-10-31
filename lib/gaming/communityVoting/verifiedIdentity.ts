import { createClient } from "@supabase/supabase-js";

import type { VerifiedVoterIdentity } from "./types";
import { CommunityVotingError } from "./types";

/**
 * Verified-voter identity for Community Voting (UG-IV-GATE-002).
 *
 * Identity is ALWAYS derived from the server's own verification of the bearer token against
 * Supabase Auth — never from anything the client claims — and the production verifier is
 * FAIL-CLOSED: a malformed token, an Auth error, a network failure, an unexpected shape or a user
 * without a confirmed phone all yield "not verified". This module never touches Gaming Member
 * state: a verified phone is sufficient, a completed profile is neither required nor created.
 *
 * It deliberately mirrors lib/gaming/auth.ts's AuthUserVerifier seam but is a SEPARATE interface:
 * the shared one returns only an id, and widening it would change every existing caller.
 */
export interface VoterIdentityVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedVoterIdentity | null>;
}

/**
 * Maps the user object Supabase Auth returned to a verified identity. Pure and fail-closed:
 * phone verification requires BOTH a non-empty phone string AND a confirmation timestamp string.
 * Returns null when there is no usable user id at all.
 */
export function mapAuthUserToVerifiedIdentity(user: unknown): VerifiedVoterIdentity | null {
  if (typeof user !== "object" || user === null) return null;
  const candidate = user as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;

  const hasPhone = typeof candidate.phone === "string" && candidate.phone.length > 0;
  const phoneConfirmed =
    typeof candidate.phone_confirmed_at === "string" && candidate.phone_confirmed_at.length > 0;

  return { authUserId: candidate.id, phoneVerified: hasPhone && phoneConfirmed };
}

/**
 * Verifies a bearer access token by asking Supabase Auth itself (`auth.getUser`) rather than decoding
 * the JWT locally. Any failure, thrown or returned, is "not verified".
 */
export class SupabaseVoterIdentityVerifier implements VoterIdentityVerifier {
  constructor(
    private supabaseUrl: string,
    private supabaseServiceKey: string
  ) {}

  async verifyAccessToken(accessToken: string): Promise<VerifiedVoterIdentity | null> {
    try {
      // no-store, like every other repository: who a token belongs to is never answered from Next's data cache
      const client = createClient(this.supabaseUrl, this.supabaseServiceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
      });
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data?.user) return null;
      return mapAuthUserToVerifiedIdentity(data.user);
    } catch {
      return null;
    }
  }
}

/**
 * Resolves a request's Authorization header to a server-verified identity that holds a confirmed
 * phone. Throws AUTHENTICATION_REQUIRED for a missing/malformed/unverifiable bearer and
 * VERIFIED_PHONE_REQUIRED for a verified Auth user without a confirmed phone.
 */
export async function resolveVerifiedVoter(
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined
): Promise<VerifiedVoterIdentity> {
  const unauthenticated = () =>
    new CommunityVotingError("AUTHENTICATION_REQUIRED", "A valid Authorization bearer token is required.");

  if (!authorizationHeader) throw unauthenticated();
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!match) throw unauthenticated();

  const identity = await verifier.verifyAccessToken(match[1].trim());
  if (!identity) throw unauthenticated();

  if (!identity.phoneVerified) {
    throw new CommunityVotingError(
      "VERIFIED_PHONE_REQUIRED",
      "A verified phone number is required to take part."
    );
  }
  return identity;
}
