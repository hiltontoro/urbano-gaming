import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { InMemoryPredictionsRepository } from "../../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import type { PrizeQualificationRecord, PrizeTierRecord } from "../../lib/gaming/predictions/types";
import { InMemoryStationRepository, type PrizeLedger } from "../../lib/gaming/redemption-station/db/inMemoryStationRepository";
import { generateSalt, hashPin } from "../../lib/gaming/redemption-station/pin";
import * as service from "../../lib/gaming/redemption-station/service";
import type { StationRecord } from "../../lib/gaming/redemption-station/types";
import { buildLadderWorld, settle, submitAs, answersFor, type LadderEnv, type LadderWorld } from "./progressiveLadderScenarios";

/**
 * A finished match with winners, on the real in-memory prize repository, and a redemption station for its ONE activation: two accounts called
 * Ana (Easy), Bruno (Hard), a loser — and, in ANOTHER match and activation, Carla, whose prize the station must never show or deliver.
 *
 * ACTOR is the finalizer who settles the match (a person with general authority); STATION_ACTOR is the identity of the station, which holds
 * NO authority; ADMIN is the operator who sets the PIN. The station's delivery never uses ACTOR's authority.
 */

export const PIN = "48151623";
export const SLUG = "clasico-the-pub-test";
export const ACTOR = "actor-with-finalizer";
export const STATION_ACTOR = "station-identity-no-authority";
export const ADMIN = "operator-who-sets-the-pin";
export const T0 = Date.parse("2026-10-29T15:00:00.000Z");
export const DAY = 24 * 3600_000;

export interface Fixture {
  repo: InMemoryPredictionsRepository;
  stations: InMemoryStationRepository;
  deps: service.StationDeps;
  world: LadderWorld;
  otherWorld: LadderWorld;
  station: StationRecord;
  clock: { now: number };
  prizeIds: { ana1: string; ana2: string; bruno: string };
  otherPrizeId: string;
  /** Test support: the prizes as the repository holds them, and a way to change one the way a correction would. */
  qualifications: Map<string, PrizeQualificationRecord>;
  authorityHolders: Set<string>;
}

async function winnersOf(env: LadderEnv, world: LadderWorld, names: Array<{ name: string; flags: { S: boolean; F: boolean; G: boolean; M: boolean }; level: number }>) {
  const ids: string[] = [];
  for (const entry of names) {
    const id = await env.newMember(entry.name);
    (env.repo as InMemoryPredictionsRepository).setMemberDisplayName(id, entry.name);
    await submitAs(env, world, id, answersFor(world, entry.level, entry.flags));
    ids.push(id);
  }
  return ids;
}

interface RepoInternals {
  qualifications: Map<string, PrizeQualificationRecord>;
  prizeTiers: Map<string, PrizeTierRecord>;
  activations: Map<string, { venueActivationId: string; matchId: string }>;
}

/** The ledger of prizes the in-memory station twin delivers through, over the real in-memory prize repository (test support reaches its maps). */
function ledgerOf(repo: InMemoryPredictionsRepository, authorityHolders: Set<string>): { ledger: PrizeLedger; qualifications: Map<string, PrizeQualificationRecord> } {
  const internals = repo as unknown as RepoInternals;
  const grantsOf = (repo.authorityRepository as unknown as { grants: Map<string, { gamingMemberId: string; revokedAt: string | null }> }).grants;
  const ledger: PrizeLedger = {
    find: (id) => {
      const q = internals.qualifications.get(id);
      if (!q) return null;
      const activation = internals.activations.get(q.venueActivationId);
      if (!activation) return null;
      return {
        venueActivationId: q.venueActivationId,
        matchId: activation.matchId,
        redeemedAt: q.redeemedAt,
        supersededAt: q.supersededAt,
        fulfilledByPrizeQualificationId: q.fulfilledByPrizeQualificationId,
        heldAt: q.heldAt,
        releasedAt: q.releasedAt,
        prizeLabel: internals.prizeTiers.get(q.prizeTierId)?.prizeLabel ?? null,
      };
    },
    holdsAuthority: (id) => authorityHolders.has(id) || [...grantsOf.values()].some((g) => g.gamingMemberId === id && g.revokedAt === null),
    markRedeemed: ({ prizeQualificationId, byGamingMemberId, at, prizeLabel, reason }) => {
      const existing = internals.qualifications.get(prizeQualificationId)!;
      internals.qualifications.set(prizeQualificationId, {
        ...existing,
        redeemedAt: at,
        redeemedByGamingMemberId: byGamingMemberId,
        redeemedPrizeLabel: prizeLabel,
        redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION",
        legacyObservedPrizeLabel: null,
      });
      repo.auditStoreForTests.record({
        actionType: "CONFIRM_PRIZE_REDEMPTION",
        actorKind: "GAMING_MEMBER",
        actorId: byGamingMemberId,
        authorityClassUsed: null,
        targetType: "prize_qualifications",
        targetId: prizeQualificationId,
        previousReference: null,
        resultingReference: { table: "prize_qualifications", id: prizeQualificationId },
        outcome: "SUCCESS",
        reason,
      });
    },
  };
  return { ledger, qualifications: internals.qualifications };
}

export async function fixture(options: { expiresInMs?: number; ttlMinutes?: number; withPin?: boolean } = {}): Promise<Fixture> {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(ACTOR, "CONSEQUENTIAL_FINALIZER");
  const env: LadderEnv = { repo, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: ACTOR, operatorId: ACTOR };
  const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
  const otherWorld = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
  // two accounts with the SAME visible name win Easy, one wins Hard (Easy, Medium and Hard right, the minute wrong), one loses
  await winnersOf(env, world, [
    { name: "Ana", flags: { S: true, F: false, G: false, M: false }, level: 1 },
    { name: "Ana", flags: { S: true, F: false, G: false, M: false }, level: 1 },
    { name: "Bruno", flags: { S: true, F: true, G: true, M: false }, level: 4 },
    { name: "Perdedor", flags: { S: false, F: false, G: false, M: false }, level: 1 },
  ]);
  await winnersOf(env, otherWorld, [{ name: "Carla", flags: { S: true, F: false, G: false, M: false }, level: 1 }]);
  await settle(env, world, "TWO_ONE");
  await settle(env, otherWorld, "TWO_ONE");
  const mine = await repo.listQualificationDetailsForActivation(world.activationId);
  const other = await repo.listQualificationDetailsForActivation(otherWorld.activationId);
  expect(mine).toHaveLength(3);
  expect(other).toHaveLength(1);
  const clock = { now: T0 };
  const salt = generateSalt();
  const withPin = options.withPin ?? true;
  const station: StationRecord = {
    stationId: randomUUID(),
    slug: SLUG,
    label: "The Pub · El Clásico",
    venueActivationId: world.activationId,
    matchId: world.matchId,
    actorGamingMemberId: STATION_ACTOR,
    pinSalt: withPin ? salt : null,
    pinHash: withPin ? hashPin(PIN, salt) : null,
    pinVersion: withPin ? 1 : 0,
    ipSalt: generateSalt(),
    sessionTtlMinutes: options.ttlMinutes ?? 240,
    expiresAt: new Date(T0 + (options.expiresInMs ?? 2 * DAY)).toISOString(),
    revokedAt: null,
  };
  const authorityHolders = new Set<string>();
  const { ledger, qualifications } = ledgerOf(repo, authorityHolders);
  const stations = new InMemoryStationRepository(ledger, () => clock.now);
  stations.addStation(station);
  const deps: service.StationDeps = { stations, predictions: repo, now: () => new Date(clock.now), failureDelayMs: 0 };
  const byName = (name: string) => mine.filter((q) => q.memberDisplayName === name);
  return {
    repo,
    stations,
    deps,
    world,
    otherWorld,
    station,
    clock,
    prizeIds: { ana1: byName("Ana")[0]!.prizeQualificationId, ana2: byName("Ana")[1]!.prizeQualificationId, bruno: byName("Bruno")[0]!.prizeQualificationId },
    otherPrizeId: other[0]!.prizeQualificationId,
    qualifications,
    authorityHolders,
  };
}

export async function login(f: Fixture, ip = "10.0.0.1") {
  const { token } = await service.loginWithPin(f.deps, SLUG, PIN, ip);
  return service.authenticate(f.deps, SLUG, token);
}
