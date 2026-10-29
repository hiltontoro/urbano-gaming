import { randomUUID } from "node:crypto";

import {
  InvalidStationRequestError,
  PrizeCodeNotFoundError,
  StationClosedError,
  StationMisconfiguredError,
  StationNotFoundError,
  StationUnauthorizedError,
  type AttemptDecision,
  type PinChangeRecord,
  type ScopedRedemptionResult,
  type StationEventRecord,
  type StationLimits,
  type StationRecord,
  type StationSessionRecord,
} from "../types";
import type { StationRepository } from "./stationRepository";

/** A prize as the ledger of prizes holds it. */
export interface LedgerPrize {
  venueActivationId: string;
  matchId: string;
  redeemedAt: string | null;
  supersededAt: string | null;
  fulfilledByPrizeQualificationId: string | null;
  heldAt: string | null;
  releasedAt: string | null;
  prizeLabel: string | null;
}

/**
 * The part of the world the station's delivery touches, as the in-memory twin needs it (the database twin reaches the same facts in the
 * same transaction). Everything is synchronous so a delivery is atomic, as the row locks make it in the database.
 */
export interface PrizeLedger {
  find(prizeQualificationId: string): LedgerPrize | null;
  /** Does this member hold any active platform authority? */
  holdsAuthority(gamingMemberId: string): boolean;
  /** The delivery itself, with its audit event; the evidence is the one the database function writes. */
  markRedeemed(input: { prizeQualificationId: string; byGamingMemberId: string; at: string; prizeLabel: string | null; reason: string }): void;
}

interface Attempt { id: number; stationId: string; ipHash: string; at: number; succeeded: boolean }
type SessionRow = StationSessionRecord & { tokenSha256: string };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * In-memory twin of the database implementation: the same limits, the same sessions, the same scoped delivery, the same log. The attempt is
 * written as a failure before the PIN is checked, exactly as the database function does, and a queue stands in for the per-station advisory
 * lock.
 */
export class InMemoryStationRepository implements StationRepository {
  stations = new Map<string, StationRecord>();
  sessions = new Map<string, SessionRow>();
  events: StationEventRecord[] = [];
  pinChanges: PinChangeRecord[] = [];
  private attempts: Attempt[] = [];
  private nextAttempt = 1;
  private clock: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private ledger: PrizeLedger;

  constructor(ledger: PrizeLedger, clock: () => number = () => Date.now()) { this.ledger = ledger; this.clock = clock; }

  addStation(station: StationRecord): void { this.stations.set(station.stationId, { ...station }); }

  /** Test support: the attempts as the table holds them. */
  attemptRows(): Array<{ stationId: string; ipHash: string; at: number; succeeded: boolean }> { return this.attempts.map(({ stationId, ipHash, at, succeeded }) => ({ stationId, ipHash, at, succeeded })); }

  async getStationBySlug(slug: string) {
    for (const station of this.stations.values()) if (station.slug === slug) return { ...station };
    return null;
  }

  beginAttempt(stationId: string, ipHash: string, limits: StationLimits): Promise<AttemptDecision> {
    const run = async (): Promise<AttemptDecision> => {
      const now = this.clock();
      this.attempts = this.attempts.filter((a) => !(a.stationId === stationId && a.at < now - 24 * 3600_000));
      const since = now - limits.windowSeconds * 1000;
      const failures = this.attempts.filter((a) => a.stationId === stationId && !a.succeeded && a.at >= since);
      const mine = failures.filter((a) => a.ipHash === ipHash);
      let retry = 0;
      if (mine.length >= limits.perClient) retry = Math.max(retry, Math.ceil((Math.min(...mine.map((a) => a.at)) + limits.windowSeconds * 1000 - now) / 1000));
      if (failures.length >= limits.perStation) retry = Math.max(retry, Math.ceil((Math.min(...failures.map((a) => a.at)) + limits.windowSeconds * 1000 - now) / 1000));
      if (retry > 0) return { allowed: false, attemptId: null, retryAfterSeconds: retry };
      const attempt: Attempt = { id: this.nextAttempt++, stationId, ipHash, at: now, succeeded: false };
      this.attempts.push(attempt);
      return { allowed: true, attemptId: String(attempt.id), retryAfterSeconds: 0 };
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async markAttemptSucceeded(attemptId: string) {
    const attempt = this.attempts.find((a) => String(a.id) === attemptId);
    if (attempt) attempt.succeeded = true;
  }

  async createSession(input: { stationId: string; tokenSha256: string; pinVersion: number; expiresAt: string }) {
    const record: SessionRow = { sessionId: randomUUID(), stationId: input.stationId, pinVersion: input.pinVersion, expiresAt: input.expiresAt, revokedAt: null, tokenSha256: input.tokenSha256 };
    this.sessions.set(record.sessionId, record);
    return this.publicSession(record);
  }

  private publicSession(s: SessionRow): StationSessionRecord {
    return { sessionId: s.sessionId, stationId: s.stationId, pinVersion: s.pinVersion, expiresAt: s.expiresAt, revokedAt: s.revokedAt };
  }

  async getSessionByTokenSha256(tokenSha256: string) {
    for (const session of this.sessions.values()) {
      if (session.tokenSha256 !== tokenSha256) continue;
      const station = this.stations.get(session.stationId);
      if (!station) return null;
      return { session: this.publicSession(session), station: { ...station } };
    }
    return null;
  }

  async revokeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) session.revokedAt = new Date(this.clock()).toISOString();
  }

  async revokeStation(stationId: string) {
    const station = this.stations.get(stationId);
    const when = new Date(this.clock()).toISOString();
    if (station && !station.revokedAt) station.revokedAt = when;
    for (const session of this.sessions.values()) if (session.stationId === stationId && !session.revokedAt) session.revokedAt = when;
    this.attempts = this.attempts.filter((a) => a.stationId !== stationId);
  }

  async setPin(input: { stationId: string; pinSalt: string; pinHash: string; changedByGamingMemberId: string }) {
    const station = this.stations.get(input.stationId);
    if (!station) throw new StationNotFoundError();
    const nowMs = this.clock();
    if (station.revokedAt !== null || nowMs >= new Date(station.expiresAt).getTime()) throw new StationClosedError();
    station.pinSalt = input.pinSalt;
    station.pinHash = input.pinHash;
    station.pinVersion += 1;
    const when = new Date(nowMs).toISOString();
    let revoked = 0;
    for (const session of this.sessions.values()) if (session.stationId === input.stationId && !session.revokedAt) { session.revokedAt = when; revoked += 1; }
    this.pinChanges.push({ changeId: randomUUID(), stationId: input.stationId, changedByGamingMemberId: input.changedByGamingMemberId, newPinVersion: station.pinVersion, sessionsRevoked: revoked, changedAt: when });
    return { pinVersion: station.pinVersion, sessionsRevoked: revoked };
  }

  async getAdminFacts(stationId: string) {
    const station = this.stations.get(stationId);
    const nowMs = this.clock();
    const active = [...this.sessions.values()].filter((s) => s.stationId === stationId && !s.revokedAt && s.pinVersion === station?.pinVersion && nowMs < new Date(s.expiresAt).getTime()).length;
    const changes = this.pinChanges.filter((c) => c.stationId === stationId);
    return { activeSessions: active, lastPinChangeAt: changes.length ? changes[changes.length - 1]!.changedAt : null };
  }

  async redeemInScope(input: { sessionTokenSha256: string; prizeQualificationId: string; declaredOperator: string }): Promise<ScopedRedemptionResult> {
    const session = [...this.sessions.values()].find((s) => s.tokenSha256 === input.sessionTokenSha256);
    if (!session) throw new StationUnauthorizedError();
    const station = this.stations.get(session.stationId);
    if (!station) throw new StationUnauthorizedError();
    const nowMs = this.clock();
    if (session.revokedAt !== null || nowMs >= new Date(session.expiresAt).getTime() || session.pinVersion !== station.pinVersion) throw new StationUnauthorizedError();
    if (station.revokedAt !== null || nowMs >= new Date(station.expiresAt).getTime()) throw new StationClosedError();
    if (this.ledger.holdsAuthority(station.actorGamingMemberId)) throw new StationMisconfiguredError();
    const operator = (input.declaredOperator ?? "").trim();
    if (operator.length < 2 || operator.length > 40 || CONTROL.test(operator)) throw new InvalidStationRequestError("Write your name or initials (2 to 40 letters or numbers).");

    const prize = this.ledger.find(input.prizeQualificationId);
    if (!prize || prize.venueActivationId !== station.venueActivationId || prize.matchId !== station.matchId) throw new PrizeCodeNotFoundError();

    const at = new Date(nowMs).toISOString();
    const log = (outcome: StationEventRecord["outcome"], declaredOperator: string | null, detail: string | null): StationEventRecord => {
      const record: StationEventRecord = { eventId: randomUUID(), stationId: station.stationId, sessionId: session.sessionId, prizeQualificationId: input.prizeQualificationId, declaredOperator, outcome, detail, occurredAt: at };
      this.events.push(record);
      return record;
    };

    if (prize.redeemedAt !== null) {
      const e = log("ALREADY_REDEEMED", null, null);
      return { outcome: "ALREADY_REDEEMED", redeemedAt: prize.redeemedAt, refusal: null, eventId: e.eventId };
    }
    const refusal = prize.supersededAt !== null ? "SUPERSEDED" : prize.fulfilledByPrizeQualificationId !== null ? "FULFILLED" : prize.heldAt !== null && prize.releasedAt === null ? "HELD" : null;
    if (refusal) {
      const e = log("REFUSED", null, refusal);
      return { outcome: "REFUSED", redeemedAt: null, refusal, eventId: e.eventId };
    }
    const e = log("REDEEMED", operator, null);
    this.ledger.markRedeemed({
      prizeQualificationId: input.prizeQualificationId,
      byGamingMemberId: station.actorGamingMemberId,
      at,
      prizeLabel: prize.prizeLabel,
      reason: `Canje en la estación «${station.label}» con PIN compartido (no acredita individualmente quién operó); el encargado declarado consta en el registro de la estación, evento ${e.eventId}.`,
    });
    return { outcome: "REDEEMED", redeemedAt: at, refusal: null, eventId: e.eventId };
  }

  async listEvents(stationId: string) { return this.events.filter((e) => e.stationId === stationId); }
  async listPinChanges(stationId: string) { return this.pinChanges.filter((c) => c.stationId === stationId); }
}
