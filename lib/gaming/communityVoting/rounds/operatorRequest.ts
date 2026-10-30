import { resolveGamingAuth, type AuthUserVerifier } from "../../auth";
import type { GamingRepository } from "../../db/gamingRepository";
import { CommunityVotingError } from "../types";
import type { OperatorContext } from "./types";

/**
 * The credentials of an operator request: the Session's host token (header `x-host-token`) AND a Supabase access token
 * (`Authorization: Bearer`) whose user is a Gaming Member. The member id is derived HERE, from the verified token, and is
 * handed to the database, which compares it with the operator recorded on the Instance. A browser never supplies it.
 *
 * Missing credentials are 401; a verified user who is not a Gaming Member cannot be the operator (403).
 */
export async function resolveOperatorCredentials(
  deps: { gamingRepo: GamingRepository; verifier: AuthUserVerifier },
  authorizationHeader: string | null | undefined,
  hostTokenHeader: string | null | undefined
): Promise<{ operatorMemberId: string; hostToken: string }> {
  const hostToken = typeof hostTokenHeader === "string" ? hostTokenHeader.trim() : "";
  if (hostToken.length === 0) {
    throw new CommunityVotingError("AUTHENTICATION_REQUIRED", "The session host token is required in the x-host-token header.");
  }
  const auth = await resolveGamingAuth(deps.gamingRepo, deps.verifier, authorizationHeader);
  if (auth.status === "guest" || auth.status === "invalid_token") {
    throw new CommunityVotingError("AUTHENTICATION_REQUIRED", "A valid Authorization bearer token is required.");
  }
  if (auth.status === "profile_incomplete") {
    throw new CommunityVotingError("OPERATOR_REQUIRED", "Only the designated operator may do this.");
  }
  return { operatorMemberId: auth.gamingMember.gamingMemberId, hostToken };
}

export function toOperatorContext(instanceId: string, credentials: { operatorMemberId: string; hostToken: string }): OperatorContext {
  return { instanceId, hostToken: credentials.hostToken, operatorMemberId: credentials.operatorMemberId };
}
