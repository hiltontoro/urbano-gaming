import { createClient } from "@supabase/supabase-js";

import type { GamingRepository } from "../../db/gamingRepository";
import { resolveGamingMember } from "../../resolveGamingMember";
import { CommunityVotingError } from "../types";

/** What Supabase Auth itself reports about a bearer token's user: an id, and whether the EMAIL is confirmed. Nothing else leaves this module. */
export interface EmailVerifiedIdentity {
  authUserId: string;
  emailVerified: boolean;
}

export interface EmailIdentityVerifier {
  verifyAccessToken(accessToken: string): Promise<EmailVerifiedIdentity | null>;
}

export function mapAuthUserToEmailIdentity(user: unknown): EmailVerifiedIdentity | null {
  if (typeof user !== "object" || user === null) return null;
  const candidate = user as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  const hasEmail = typeof candidate.email === "string" && candidate.email.length > 0;
  const confirmed = typeof candidate.email_confirmed_at === "string" && candidate.email_confirmed_at.length > 0;
  return { authUserId: candidate.id, emailVerified: hasEmail && confirmed };
}

export class SupabaseEmailIdentityVerifier implements EmailIdentityVerifier {
  constructor(
    private supabaseUrl: string,
    private supabaseServiceKey: string
  ) {}

  async verifyAccessToken(accessToken: string): Promise<EmailVerifiedIdentity | null> {
    try {
      // no-store, like every other repository: whether an email is confirmed is never answered from Next's data cache
      const client = createClient(this.supabaseUrl, this.supabaseServiceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
      });
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data?.user) return null;
      return mapAuthUserToEmailIdentity(data.user);
    } catch {
      return null;
    }
  }
}

/**
 * The pilot's voter identity (UG-IV-GATE-004A): a Supabase Auth session whose EMAIL is confirmed AND a Gaming Member profile.
 *
 * Everything is derived on the SERVER from the bearer token on EVERY request; nothing is trusted from the browser. The email is
 * verified with the platform's existing mechanism (the one-time code Supabase Auth emails, driven by public/urbanoAuth.js); the
 * profile is the existing Gaming Member record, whose mere existence proves the profile step finished (migration 0045). This module
 * creates nothing — no identity, no profile — and links or merges nothing. A telephone is not part of it.
 *
 *   no/malformed/forged/expired token  -> AUTHENTICATION_REQUIRED (401)
 *   token whose user has no confirmed email -> VERIFIED_EMAIL_REQUIRED (403)
 *   confirmed email, no Gaming Member yet   -> PROFILE_INCOMPLETE (403): the person completes the profile, then continues
 *
 * Fail-closed: an Auth error, a network failure or an unexpected shape all mean "not verified".
 */
export interface RoundVoterIdentity {
  authUserId: string;
  gamingMemberId: string;
}

export interface RoundIdentityDeps {
  emailVerifier: EmailIdentityVerifier;
  gamingRepo: GamingRepository;
}

export async function resolveRoundVoter(
  deps: RoundIdentityDeps,
  authorizationHeader: string | null | undefined
): Promise<RoundVoterIdentity> {
  const unauthenticated = () => new CommunityVotingError("AUTHENTICATION_REQUIRED", "A valid Authorization bearer token is required.");
  if (!authorizationHeader) throw unauthenticated();
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!match) throw unauthenticated();

  const identity = await deps.emailVerifier.verifyAccessToken(match[1].trim());
  if (!identity) throw unauthenticated();
  if (!identity.emailVerified) {
    throw new CommunityVotingError("VERIFIED_EMAIL_REQUIRED", "A verified email address is required to take part.");
  }

  const member = await resolveGamingMember(deps.gamingRepo, identity.authUserId);
  if (!member) {
    throw new CommunityVotingError("PROFILE_INCOMPLETE", "Complete your URBANO Gaming profile to take part.");
  }
  return { authUserId: identity.authUserId, gamingMemberId: member.gamingMemberId };
}
