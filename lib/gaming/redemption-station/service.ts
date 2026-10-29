import { createHash, randomBytes } from "node:crypto";

import type { PredictionsRepository } from "@/lib/gaming/predictions/db/predictionsRepository";
import type { PrizeQualificationDetailRecord } from "@/lib/gaming/predictions/types";
import type { StationRepository } from "./db/stationRepository";
import { cleanOperatorName } from "./operatorName";
import { generateSalt, hashPin, newPinProblem, verifyPin } from "./pin";
import { PUBLIC_CODE_PATTERN, assignPublicCodes } from "./publicCode";
import {
  DEFAULT_LIMITS,
  InvalidPinError,
  InvalidStationRequestError,
  PrizeCodeNotFoundError,
  PrizeNotAvailableError,
  StationClosedError,
  StationLockedError,
  StationNotActivatedError,
  StationNotFoundError,
  StationUnauthorizedError,
  type StationAdminStatus,
  type StationEventOutcome,
  type StationLimits,
  type StationPrizeView,
  type StationRecord,
  type StationSessionRecord,
} from "./types";

export interface StationDeps {
  stations: StationRepository;
  /**
   * The existing prize repository, for READING the prizes of the station's activation only. The station never writes a delivery through it:
   * a delivery is made by the station's own database operation, which decides the scope itself.
   */
  predictions: Pick<PredictionsRepository, "listQualificationDetailsForActivation">;
  now?: () => Date;
  limits?: StationLimits;
  /** A pause before answering a wrong PIN. */
  failureDelayMs?: number;
}

export interface StationContext {
  station: StationRecord;
  session: StationSessionRecord;
  /** The hash of the session token: what names the session to the database. */
  tokenSha256: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const nowOf = (deps: StationDeps) => (deps.now ?? (() => new Date()))();

function isClosed(station: StationRecord, now: Date): boolean {
  return station.revokedAt !== null || now.getTime() >= new Date(station.expiresAt).getTime();
}

export function ipHashOf(ip: string, stationSalt: string): string {
  return sha256(stationSalt + ":" + ip);
}

/**
 * Checks the PIN and opens a session. A wrong PIN counts against the client and against the station; once a limit is reached nothing is
 * checked at all (not even a correct PIN) until the window passes. The attempt is recorded before the PIN is looked at, so parallel
 * attempts are all counted.
 */
export async function loginWithPin(deps: StationDeps, slug: string, pin: unknown, clientIp: string): Promise<{ token: string; expiresAt: string }> {
  const station = await deps.stations.getStationBySlug(slug);
  if (!station) throw new StationNotFoundError();
  const now = nowOf(deps);
  if (isClosed(station, now)) throw new StationClosedError();
  // no PIN has been set yet: there is nothing to check and nobody can come in (this is not a guess, so it is not counted as an attempt)
  if (station.pinSalt === null || station.pinHash === null) throw new StationNotActivatedError();

  const decision = await deps.stations.beginAttempt(station.stationId, ipHashOf(clientIp, station.ipSalt), deps.limits ?? DEFAULT_LIMITS);
  if (!decision.allowed || decision.attemptId === null) throw new StationLockedError(decision.retryAfterSeconds);

  if (!verifyPin(pin, station.pinSalt, station.pinHash)) {
    if ((deps.failureDelayMs ?? 400) > 0) await new Promise((resolve) => setTimeout(resolve, deps.failureDelayMs ?? 400));
    throw new InvalidPinError();
  }
  await deps.stations.markAttemptSucceeded(decision.attemptId);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Math.min(now.getTime() + station.sessionTtlMinutes * 60_000, new Date(station.expiresAt).getTime())).toISOString();
  // the session carries the PIN version the PIN was checked against: if the PIN changes meanwhile, this session is dead on arrival
  await deps.stations.createSession({ stationId: station.stationId, tokenSha256: sha256(token), pinVersion: station.pinVersion, expiresAt });
  return { token, expiresAt };
}

/** The session behind a token, if it is still good: not revoked, not expired, opened under the current PIN, of this station, and the station itself still open. */
export async function authenticate(deps: StationDeps, slug: string, token: unknown): Promise<StationContext> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new StationUnauthorizedError();
  const tokenSha256 = sha256(token);
  const found = await deps.stations.getSessionByTokenSha256(tokenSha256);
  if (!found || found.station.slug !== slug) throw new StationUnauthorizedError();
  const now = nowOf(deps);
  if (found.session.revokedAt !== null || now.getTime() >= new Date(found.session.expiresAt).getTime()) throw new StationUnauthorizedError();
  if (found.session.pinVersion !== found.station.pinVersion) throw new StationUnauthorizedError();
  if (isClosed(found.station, now)) throw new StationUnauthorizedError();
  return { station: found.station, session: found.session, tokenSha256 };
}

export async function logout(deps: StationDeps, ctx: StationContext): Promise<void> {
  await deps.stations.revokeSession(ctx.session.sessionId);
}

/** Closes the station for good: the station, all of its sessions and its attempts. */
export async function revokeStationBySlug(deps: StationDeps, slug: string): Promise<void> {
  const station = await deps.stations.getStationBySlug(slug);
  if (!station) throw new StationNotFoundError();
  await deps.stations.revokeStation(station.stationId);
}

/**
 * Sets or changes the PIN (the caller has already proven OPERATIONAL authority). The PIN is checked, hashed here and handed to the database
 * as a salt and a hash; the database moves the PIN version and revokes every earlier session, so nobody who knew the old PIN keeps access.
 * The PIN is not logged and not returned.
 */
export async function setStationPin(deps: StationDeps, slug: string, pin: unknown, changedByGamingMemberId: string): Promise<{ pinVersion: number; sessionsRevoked: number }> {
  const problem = newPinProblem(pin);
  if (problem) throw new InvalidStationRequestError(problem);
  const station = await deps.stations.getStationBySlug(slug);
  if (!station) throw new StationNotFoundError();
  if (isClosed(station, nowOf(deps))) throw new StationClosedError();
  const pinSalt = generateSalt();
  return deps.stations.setPin({ stationId: station.stationId, pinSalt, pinHash: hashPin(pin as string, pinSalt), changedByGamingMemberId });
}

/** What the administration page shows about the station. Never the PIN, its hash or its salt. */
export async function stationAdminStatus(deps: StationDeps, slug: string): Promise<StationAdminStatus> {
  const station = await deps.stations.getStationBySlug(slug);
  if (!station) throw new StationNotFoundError();
  const facts = await deps.stations.getAdminFacts(station.stationId);
  return {
    slug: station.slug,
    label: station.label,
    expiresAt: station.expiresAt,
    revokedAt: station.revokedAt,
    pinSet: station.pinHash !== null,
    pinVersion: station.pinVersion,
    activeSessions: facts.activeSessions,
    lastPinChangeAt: facts.lastPinChangeAt,
  };
}

function statusOf(q: PrizeQualificationDetailRecord): StationPrizeView["status"] {
  if (q.redeemedAt !== null) return "REDEEMED";
  if (q.supersededAt !== null || q.fulfilledByPrizeQualificationId !== null || (q.heldAt !== null && q.releasedAt === null)) return "UNAVAILABLE";
  return "PENDING";
}

const oneLine = (text: string | null) => (text ?? "").normalize("NFC").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();

interface Listed { view: StationPrizeView; prizeQualificationId: string }

/**
 * The prizes of the station's ONE activation, read from the existing prize repository: the visible name, the public code, the prize and
 * the state — nothing else (no e-mail, no phone, no internal identifier). The activation belongs to exactly one match, so asking for the
 * activation is asking for that match only; there is no parameter that could ask for another event.
 */
async function listInScope(deps: StationDeps, station: StationRecord): Promise<Listed[]> {
  const details = await deps.predictions.listQualificationDetailsForActivation(station.venueActivationId);
  const codes = assignPublicCodes(details.map((d) => d.prizeQualificationId));
  return details
    .map((d) => ({
      prizeQualificationId: d.prizeQualificationId,
      view: {
        code: codes.get(d.prizeQualificationId)!,
        displayName: oneLine(d.memberDisplayName) || "Sin nombre",
        prizeLabel: oneLine(d.prizeLabel) || "Premio",
        status: statusOf(d),
        redeemedAt: d.redeemedAt,
      } satisfies StationPrizeView,
    }))
    .sort((a, b) => a.view.displayName.localeCompare(b.view.displayName, "es") || a.view.code.localeCompare(b.view.code));
}

export async function listPrizes(deps: StationDeps, ctx: StationContext): Promise<StationPrizeView[]> {
  return (await listInScope(deps, ctx.station)).map((l) => l.view);
}

export interface RedeemInput {
  code: unknown;
  operatorName: unknown;
  /** The explicit confirmation: "I already handed the prize over". */
  confirm: unknown;
}

export interface RedeemResult {
  outcome: Exclude<StationEventOutcome, "REFUSED">;
  prize: StationPrizeView;
}

/**
 * Marks a prize as delivered. The code is turned into a prize only among the prizes of the station's own activation (an unknown code is
 * "not found"), and then ONE database operation does the rest: it re-checks the session, the station and — whatever this request says —
 * that the prize belongs to the station's activation and match, applies the rules of a delivery (a delivered prize is returned as it was;
 * a superseded, satisfied or held one is refused), and writes the delivery, the declared name and the audit event in one transaction. Two
 * people confirming the same prize at the same time end in ONE delivery: the second one is told it was already delivered.
 */
export async function redeem(deps: StationDeps, ctx: StationContext, input: RedeemInput): Promise<RedeemResult> {
  if (input.confirm !== true) throw new InvalidStationRequestError("Confirm that you already handed the prize over.");
  const operator = cleanOperatorName(input.operatorName);
  if (typeof input.code !== "string" || !PUBLIC_CODE_PATTERN.test(input.code)) throw new PrizeCodeNotFoundError();

  const listed = (await listInScope(deps, ctx.station)).find((l) => l.view.code === input.code);
  if (!listed) throw new PrizeCodeNotFoundError();

  const result = await deps.stations.redeemInScope({ sessionTokenSha256: ctx.tokenSha256, prizeQualificationId: listed.prizeQualificationId, declaredOperator: operator });
  if (result.outcome === "REFUSED" || result.redeemedAt === null) throw new PrizeNotAvailableError();
  return { outcome: result.outcome, prize: { ...listed.view, status: "REDEEMED", redeemedAt: result.redeemedAt } };
}
