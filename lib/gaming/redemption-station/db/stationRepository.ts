import type { AttemptDecision, PinChangeRecord, ScopedRedemptionResult, StationEventRecord, StationLimits, StationRecord, StationSessionRecord } from "../types";

/**
 * The station's OWN storage: its configuration, the PIN attempts, the sessions and the log of what it did. A delivery is made by ONE
 * operation of this repository (redeemInScope): the database checks the session, the station and the scope, writes the delivery, the
 * station log and the audit event together, and nothing in the request can widen what it may touch.
 */
export interface StationRepository {
  getStationBySlug(slug: string): Promise<StationRecord | null>;

  /** Opens a PIN attempt (recorded as a failure until it succeeds) or refuses it when the limits are reached. Serialised per station. */
  beginAttempt(stationId: string, ipHash: string, limits: StationLimits): Promise<AttemptDecision>;
  markAttemptSucceeded(attemptId: string): Promise<void>;

  createSession(input: { stationId: string; tokenSha256: string; pinVersion: number; expiresAt: string }): Promise<StationSessionRecord>;
  getSessionByTokenSha256(tokenSha256: string): Promise<{ session: StationSessionRecord; station: StationRecord } | null>;
  revokeSession(sessionId: string): Promise<void>;
  /** Closes the station for good: the station, every one of its sessions and its attempts. Idempotent. */
  revokeStation(stationId: string): Promise<void>;

  /** Sets the PIN (salt + hash), moves the PIN version, revokes every session and logs who did it. */
  setPin(input: { stationId: string; pinSalt: string; pinHash: string; changedByGamingMemberId: string }): Promise<{ pinVersion: number; sessionsRevoked: number }>;
  /** Sessions that would still open the page now, and the last PIN change. */
  getAdminFacts(stationId: string): Promise<{ activeSessions: number; lastPinChangeAt: string | null }>;

  /**
   * Delivers ONE prize on behalf of a session, or says why not, all decided by the database: the session names the station; the prize must be
   * of the station's activation and match; the outcome and (for a delivery) the declared name are logged in the same transaction.
   */
  redeemInScope(input: { sessionTokenSha256: string; prizeQualificationId: string; declaredOperator: string }): Promise<ScopedRedemptionResult>;

  listEvents(stationId: string): Promise<StationEventRecord[]>;
  listPinChanges(stationId: string): Promise<PinChangeRecord[]>;
}
