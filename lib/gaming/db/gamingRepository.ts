import type { GamingMemberRecord } from "../types";

/**
 * URBANO Gaming Identity Foundation.
 *
 * Gaming Member is a separate aggregate from Session/Participant — it
 * is never joined, locked, or completed the way a Session is, and it
 * outlives any single Session. This repository is intentionally its
 * own interface rather than an extension of SessionRepository, mirroring
 * the accepted architecture: Gaming Member must never replace
 * Participant inside gameplay, and the two persistence boundaries stay
 * separate at the repository layer too.
 *
 * Two distinct write operations only — no update, no delete (Gaming
 * Member account deletion is out of scope for this phase; deleting the
 * underlying auth.users row cascades via 0045's FK instead):
 *
 *   resolveGamingMemberByAuthUserId — pure lookup, never creates. A
 *   null result means the given auth user has not completed profile
 *   creation, not an error.
 *
 *   createGamingMember — the one-time profile-completion write.
 *   Idempotent under retry/concurrency for the same authUserId (see
 *   create_gaming_member_atomically, 0047, and this interface's two
 *   implementations for how each honors that).
 *
 * The former binary Gaming-admin authority (isGamingAdmin/gaming_admins)
 * was retired in Predictions A1 — superseded by Admin Control Plane
 * A0's platform authority classes (lib/gaming/authority/).
 */
export interface GamingRepository {
  resolveGamingMemberByAuthUserId(
    authUserId: string
  ): Promise<GamingMemberRecord | null>;

  createGamingMember(
    authUserId: string,
    displayName: string
  ): Promise<GamingMemberRecord>;
}
