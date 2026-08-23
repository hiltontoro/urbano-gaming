import { createClient } from "@supabase/supabase-js";

import type { GamingRepository } from "./db/gamingRepository";
import type { GamingMemberRecord } from "./types";
import { resolveGamingMember } from "./resolveGamingMember";

/**
 * URBANO Gaming Identity Foundation — server-side Gaming Auth boundary.
 *
 * Authenticated Gaming-domain requests carry
 * `Authorization: Bearer <Supabase access token>`. This module: (1)
 * verifies that token against Supabase Auth itself (not a local JWT
 * decode — see AuthUserVerifier below); (2) resolves the auth.users
 * identity from the verification result; (3) resolves the Gaming
 * Member for that identity; never (4) trusts a gaming_member_id
 * supplied by request JSON/body/query as identity authority — every
 * caller reaches step 4 (using the identity) only through the
 * GamingMemberRecord this module itself resolved.
 *
 * Distinguishes exactly the cases the join route and sign-in UX need
 * to branch on: no header at all (Guest-capable — the caller decides
 * whether that's fine); a header that fails verification (covers both
 * a malformed/forged token and a genuinely expired one identically,
 * since Supabase Auth's own verification rejects both the same way);
 * a verified identity with no completed Gaming Member profile yet; a
 * fully resolved Gaming Member.
 */

/**
 * Isolates the one genuinely network-dependent step (verifying a token
 * against the real Supabase Auth service) behind an interface, so
 * resolveGamingAuth itself stays unit-testable with a fake verifier —
 * mirroring how GamingRepository isolates persistence.
 */
export interface AuthUserVerifier {
  verifyAccessToken(
    accessToken: string
  ): Promise<{ authUserId: string } | null>;
}

/**
 * Verifies a bearer access token by asking Supabase Auth itself
 * (`auth.getUser(accessToken)`) rather than decoding the JWT locally —
 * this is what actually confirms the token is genuine and unexpired,
 * not merely well-formed.
 */
export class SupabaseAuthUserVerifier implements AuthUserVerifier {
  constructor(
    private supabaseUrl: string,
    private supabaseServiceKey: string
  ) {}

  async verifyAccessToken(
    accessToken: string
  ): Promise<{ authUserId: string } | null> {
    const client = createClient(this.supabaseUrl, this.supabaseServiceKey);
    const { data, error } = await client.auth.getUser(accessToken);

    if (error || !data?.user) {
      return null;
    }

    return { authUserId: data.user.id };
  }
}

export type GamingAuthState =
  | { status: "guest" }
  | { status: "invalid_token" }
  | { status: "profile_incomplete"; authUserId: string }
  | { status: "authenticated"; gamingMember: GamingMemberRecord };

/**
 * Resolves the Gaming Auth state of one request from its raw
 * Authorization header value (or null/undefined if absent).
 */
export async function resolveGamingAuth(
  repo: GamingRepository,
  verifier: AuthUserVerifier,
  authorizationHeader: string | null | undefined
): Promise<GamingAuthState> {
  if (!authorizationHeader) {
    return { status: "guest" };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!match) {
    return { status: "invalid_token" };
  }

  const verified = await verifier.verifyAccessToken(match[1]);
  if (!verified) {
    return { status: "invalid_token" };
  }

  const gamingMember = await resolveGamingMember(repo, verified.authUserId);
  if (!gamingMember) {
    return { status: "profile_incomplete", authUserId: verified.authUserId };
  }

  return { status: "authenticated", gamingMember };
}
