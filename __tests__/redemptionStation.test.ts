import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { InMemoryStationRepository } from "../lib/gaming/redemption-station/db/inMemoryStationRepository";
import { generateSalt, hashPin, newPinProblem, verifyPin } from "../lib/gaming/redemption-station/pin";
import { PUBLIC_CODE_PATTERN, assignPublicCodes, prizePublicCode } from "../lib/gaming/redemption-station/publicCode";
import { cleanOperatorName } from "../lib/gaming/redemption-station/operatorName";
import * as service from "../lib/gaming/redemption-station/service";
import {
  InvalidPinError,
  InvalidStationRequestError,
  PrizeCodeNotFoundError,
  PrizeNotAvailableError,
  PublicCodeCollisionError,
  StationClosedError,
  StationLockedError,
  StationMisconfiguredError,
  StationNotActivatedError,
  StationNotFoundError,
  StationUnauthorizedError,
} from "../lib/gaming/redemption-station/types";
import { ACTOR, ADMIN, PIN, SLUG, STATION_ACTOR, T0, DAY, fixture, login } from "./helpers/redemptionStationFixtures";

/**
 * THE REDEMPTION STATION — what its rules guarantee, on the real in-memory prize repository: the PIN is checked on the server and
 * limited, and can be changed without a deployment (which ends every earlier session); sessions expire and can be revoked; the page can
 * only see (and redeem) the prizes of its ONE activation, and only as name, code, prize and state; a delivery is made under the station's
 * own identity (no authority), decided inside one operation that re-checks the scope whatever the request says, once, even when many
 * people confirm at the same time.
 */

describe("the PIN", () => {
  it("is checked against a salted hash; a wrong PIN, a malformed one and a missing one are all refused", async () => {
    const f = await fixture();
    expect(verifyPin(PIN, f.station.pinSalt!, f.station.pinHash!)).toBe(true);
    for (const bad of ["48151624", "4815162", "abcdefgh", "", "48151623 ", null, undefined, 48151623]) expect(verifyPin(bad, f.station.pinSalt!, f.station.pinHash!)).toBe(false);
    expect(f.station.pinHash).not.toContain(PIN);
    expect(hashPin(PIN, generateSalt())).not.toBe(f.station.pinHash); // the salt matters
  });

  it("opens a session whose token is never stored (only its hash) and is not the PIN", async () => {
    const f = await fixture();
    const { token, expiresAt } = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1");
    expect(token).not.toContain(PIN);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(new Date(expiresAt).getTime()).toBe(T0 + 240 * 60_000);
    const stored = [...f.stations.sessions.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("a wrong PIN is InvalidPin; an unknown station is NotFound; a closed one is Closed (and counts no attempt)", async () => {
    const f = await fixture();
    await expect(service.loginWithPin(f.deps, SLUG, "00000000", "10.0.0.1")).rejects.toBeInstanceOf(InvalidPinError);
    await expect(service.loginWithPin(f.deps, "otro-puesto", PIN, "10.0.0.1")).rejects.toBeInstanceOf(StationNotFoundError);
    await service.revokeStationBySlug(f.deps, SLUG);
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1")).rejects.toBeInstanceOf(StationClosedError);
  });
});

describe("repeated attempts are limited", () => {
  it("after 5 wrong PINs from one client even the correct PIN is refused for that client (with the time to wait); another client still gets in", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await expect(service.loginWithPin(f.deps, SLUG, "11111111", "10.0.0.9")).rejects.toBeInstanceOf(InvalidPinError);
    const locked = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.9").catch((e) => e);
    expect(locked).toBeInstanceOf(StationLockedError);
    expect((locked as StationLockedError).retryAfterSeconds).toBeGreaterThan(0);
    expect((locked as StationLockedError).retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.77")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("the lock ends when the window passes", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await service.loginWithPin(f.deps, SLUG, "11111111", "10.0.0.9").catch(() => undefined);
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.9")).rejects.toBeInstanceOf(StationLockedError);
    f.clock.now += 15 * 60_000 + 1000;
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.9")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("a station-wide limit stops an attack spread over many addresses: after 30 wrong PINs nobody gets in, not even with the right one", async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++) await expect(service.loginWithPin(f.deps, SLUG, "22222222", `10.1.0.${i}`)).rejects.toBeInstanceOf(InvalidPinError);
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.9.9.9")).rejects.toBeInstanceOf(StationLockedError);
  });

  it("parallel wrong attempts from one client are all counted: only 5 are even checked, the rest are locked out", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => service.loginWithPin(f.deps, SLUG, "33333333", "10.0.0.5").catch((e) => e)));
    expect(results.filter((r) => r instanceof InvalidPinError)).toHaveLength(5);
    expect(results.filter((r) => r instanceof StationLockedError)).toHaveLength(15);
  });

  it("successful logins do not use up the limit", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.3");
    await expect(service.loginWithPin(f.deps, SLUG, "99999999", "10.0.0.3")).rejects.toBeInstanceOf(InvalidPinError);
  });
});

describe("sessions expire and can be revoked", () => {
  it("a session stops working when it expires, and never lasts past the end of the station", async () => {
    const f = await fixture({ ttlMinutes: 60 });
    const { token } = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1");
    await expect(service.authenticate(f.deps, SLUG, token)).resolves.toBeDefined();
    f.clock.now += 61 * 60_000;
    await expect(service.authenticate(f.deps, SLUG, token)).rejects.toBeInstanceOf(StationUnauthorizedError);

    const short = await fixture({ expiresInMs: 30 * 60_000, ttlMinutes: 240 });
    const login30 = await service.loginWithPin(short.deps, SLUG, PIN, "10.0.0.1");
    expect(new Date(login30.expiresAt).getTime()).toBe(T0 + 30 * 60_000); // capped by the station's end
    short.clock.now += 31 * 60_000;
    await expect(service.authenticate(short.deps, SLUG, login30.token)).rejects.toBeInstanceOf(StationUnauthorizedError);
    await expect(service.loginWithPin(short.deps, SLUG, PIN, "10.0.0.1")).rejects.toBeInstanceOf(StationClosedError);
  });

  it("logging out ends that session only; revoking the station ends every session and the station", async () => {
    const f = await fixture();
    const a = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1");
    const b = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.2");
    await service.logout(f.deps, await service.authenticate(f.deps, SLUG, a.token));
    await expect(service.authenticate(f.deps, SLUG, a.token)).rejects.toBeInstanceOf(StationUnauthorizedError);
    await expect(service.authenticate(f.deps, SLUG, b.token)).resolves.toBeDefined();
    await service.revokeStationBySlug(f.deps, SLUG);
    await service.revokeStationBySlug(f.deps, SLUG); // idempotent
    await expect(service.authenticate(f.deps, SLUG, b.token)).rejects.toBeInstanceOf(StationUnauthorizedError);
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.3")).rejects.toBeInstanceOf(StationClosedError);
  });

  it("a token of another station, a made-up token and a missing token are refused", async () => {
    const f = await fixture();
    const { token } = await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1");
    await expect(service.authenticate(f.deps, "otro-puesto", token)).rejects.toBeInstanceOf(StationUnauthorizedError);
    for (const bad of [undefined, null, "", "x", "a".repeat(43), 12345]) await expect(service.authenticate(f.deps, SLUG, bad)).rejects.toBeInstanceOf(StationUnauthorizedError);
  });
});

describe("the PIN can be changed without a new deployment, and a change ends every earlier session", () => {
  it("a station with no PIN yet lets nobody in, says so, and counts no attempt", async () => {
    const f = await fixture({ withPin: false });
    for (const pin of [PIN, "00000000", undefined, ""]) await expect(service.loginWithPin(f.deps, SLUG, pin, "10.0.0.1")).rejects.toBeInstanceOf(StationNotActivatedError);
    expect(f.stations.attemptRows()).toHaveLength(0);
    const status = await service.stationAdminStatus(f.deps, SLUG);
    expect(status).toMatchObject({ pinSet: false, pinVersion: 0, activeSessions: 0, lastPinChangeAt: null });
  });

  it("setting the PIN activates the station: the new PIN opens a session, any other does not", async () => {
    const f = await fixture({ withPin: false });
    const done = await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    expect(done).toEqual({ pinVersion: 1, sessionsRevoked: 0 });
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.1")).rejects.toBeInstanceOf(InvalidPinError);
    await expect(service.loginWithPin(f.deps, SLUG, "73920461", "10.0.0.1")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("changing the PIN: the old PIN stops working, the new one works, and EVERY earlier session is dead (cannot list, cannot deliver)", async () => {
    const f = await fixture();
    const a = await login(f, "10.0.0.1");
    const b = await login(f, "10.0.0.2");
    const code = (await service.listPrizes(f.deps, a))[0]!.code;
    expect((await service.stationAdminStatus(f.deps, SLUG)).activeSessions).toBe(2);

    const changed = await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    expect(changed).toEqual({ pinVersion: 2, sessionsRevoked: 2 });
    expect((await service.stationAdminStatus(f.deps, SLUG)).activeSessions).toBe(0);

    for (const ctx of [a, b]) {
      await expect(service.authenticate(f.deps, SLUG, "x".repeat(43))).rejects.toBeInstanceOf(StationUnauthorizedError);
      // the session of before is refused by the service ...
      const stored = await f.stations.getSessionByTokenSha256(ctx.tokenSha256);
      expect(stored!.session.revokedAt).not.toBeNull();
      // ... and by the delivery itself, even if someone calls it directly with the old session
      await expect(f.stations.redeemInScope({ sessionTokenSha256: ctx.tokenSha256, prizeQualificationId: f.prizeIds.bruno, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(StationUnauthorizedError);
      await expect(service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(StationUnauthorizedError);
    }
    await expect(service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.3")).rejects.toBeInstanceOf(InvalidPinError);
    const fresh = await service.loginWithPin(f.deps, SLUG, "73920461", "10.0.0.3");
    await expect(service.authenticate(f.deps, SLUG, fresh.token)).resolves.toBeDefined();
    expect((await f.repo.listQualificationDetailsForActivation(f.world.activationId)).every((q) => q.redeemedAt === null)).toBe(true);
  });

  it("a session that was being opened while the PIN changed is dead on arrival (it belongs to the old PIN version)", async () => {
    const f = await fixture();
    const before = (await f.stations.getStationBySlug(SLUG))!; // what a login read before the change
    await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    // the login finishes after the change and stores its session under the version it checked
    const lateToken = "l".repeat(43);
    const lateSha = createHash("sha256").update(lateToken, "utf8").digest("hex");
    const late = await f.stations.createSession({ stationId: before.stationId, tokenSha256: lateSha, pinVersion: before.pinVersion, expiresAt: new Date(T0 + DAY).toISOString() });
    expect(late.revokedAt).toBeNull(); // nothing revoked it ...
    await expect(service.authenticate(f.deps, SLUG, lateToken)).rejects.toBeInstanceOf(StationUnauthorizedError); // ... the version does, for the page ...
    await expect(f.stations.redeemInScope({ sessionTokenSha256: lateSha, prizeQualificationId: f.prizeIds.bruno, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(StationUnauthorizedError); // ... and for the delivery
    expect((await service.stationAdminStatus(f.deps, SLUG)).activeSessions).toBe(0);
  });

  it("the change is logged (who, when, how many sessions) and the PIN, its hash and its salt are in no log, no status and no return value", async () => {
    const f = await fixture();
    await login(f);
    f.clock.now += 60_000;
    const result = await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    expect(JSON.stringify(result)).not.toContain("73920461");
    const log = await f.stations.listPinChanges(f.station.stationId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ changedByGamingMemberId: ADMIN, newPinVersion: 2, sessionsRevoked: 1, changedAt: new Date(T0 + 60_000).toISOString() });
    const status = await service.stationAdminStatus(f.deps, SLUG);
    expect(Object.keys(status).sort()).toEqual(["activeSessions", "expiresAt", "label", "lastPinChangeAt", "pinSet", "pinVersion", "revokedAt", "slug"]);
    expect(JSON.stringify([log, status])).not.toMatch(/73920461|pin_?hash|pin_?salt/i);
    const stored = (await f.stations.getStationBySlug(SLUG))!;
    expect(stored.pinHash).not.toContain("73920461");
    expect(verifyPin("73920461", stored.pinSalt!, stored.pinHash!)).toBe(true);
    expect(stored.pinSalt).not.toBe(f.station.pinSalt); // a new salt every time
  });

  it("changing the PIN to the same digits still ends the sessions (a forced sign-out) and a leaked PIN can be replaced as often as needed", async () => {
    const f = await fixture();
    const ctx = await login(f);
    await service.setStationPin(f.deps, SLUG, PIN, ADMIN);
    await expect(service.authenticate(f.deps, SLUG, "z".repeat(43))).rejects.toBeInstanceOf(StationUnauthorizedError);
    expect((await f.stations.getSessionByTokenSha256(ctx.tokenSha256))!.session.revokedAt).not.toBeNull();
    await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    await service.setStationPin(f.deps, SLUG, "56018347", ADMIN);
    expect((await f.stations.getStationBySlug(SLUG))!.pinVersion).toBe(4);
  });

  it("a PIN that is not 8 to 12 digits, or is obvious, is refused and changes nothing", async () => {
    const f = await fixture();
    const ctx = await login(f);
    for (const bad of [undefined, null, "", "1234567", "1234567890123", "abcdefgh", "7392046a", " 73920461", 73920461, "11111111", "12345678", "98765432", "12121212", "12341234", "00000000"]) {
      await expect(service.setStationPin(f.deps, SLUG, bad, ADMIN)).rejects.toBeInstanceOf(InvalidStationRequestError);
    }
    expect((await f.stations.getStationBySlug(SLUG))!.pinVersion).toBe(1);
    await expect(service.authenticate(f.deps, SLUG, "x".repeat(43))).rejects.toBeInstanceOf(StationUnauthorizedError);
    expect((await f.stations.getSessionByTokenSha256(ctx.tokenSha256))!.session.revokedAt).toBeNull();
    expect(await f.stations.listPinChanges(f.station.stationId)).toHaveLength(0);
    for (const ok of ["73920461", "480195726301", "10293847"]) expect(newPinProblem(ok)).toBeNull();
  });

  it("a closed station (revoked or past its end) keeps its PIN as it was; an unknown station is NotFound", async () => {
    const f = await fixture();
    await expect(service.setStationPin(f.deps, "otro-puesto", "73920461", ADMIN)).rejects.toBeInstanceOf(StationNotFoundError);
    f.clock.now += 3 * DAY;
    await expect(service.setStationPin(f.deps, SLUG, "73920461", ADMIN)).rejects.toBeInstanceOf(StationClosedError);
    await expect(f.stations.setPin({ stationId: f.station.stationId, pinSalt: generateSalt(), pinHash: "0".repeat(128), changedByGamingMemberId: ADMIN })).rejects.toBeInstanceOf(StationClosedError);
    const g = await fixture();
    await service.revokeStationBySlug(g.deps, SLUG);
    await expect(service.setStationPin(g.deps, SLUG, "73920461", ADMIN)).rejects.toBeInstanceOf(StationClosedError);
    expect((await g.stations.getStationBySlug(SLUG))!.pinVersion).toBe(1);
  });

  it("a PIN change does not give back the attempts of a client that was guessing", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await service.loginWithPin(f.deps, SLUG, "11111111", "10.0.0.9").catch(() => undefined);
    await service.setStationPin(f.deps, SLUG, "73920461", ADMIN);
    await expect(service.loginWithPin(f.deps, SLUG, "73920461", "10.0.0.9")).rejects.toBeInstanceOf(StationLockedError);
  });
});

describe("what the station shows", () => {
  it("lists ONLY the prizes of its activation, as name, public code, prize and state — nothing else", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const list = await service.listPrizes(f.deps, ctx);
    expect(list).toHaveLength(3); // not the loser, not the other match's winner
    for (const prize of list) expect(Object.keys(prize).sort()).toEqual(["code", "displayName", "prizeLabel", "redeemedAt", "status"]);
    expect(list.map((p) => p.displayName).sort()).toEqual(["Ana", "Ana", "Bruno"]);
    expect(list.every((p) => PUBLIC_CODE_PATTERN.test(p.code))).toBe(true);
    expect(new Set(list.map((p) => p.code)).size).toBe(3); // two accounts called Ana are told apart by the code
    expect(list.every((p) => p.status === "PENDING" && p.redeemedAt === null)).toBe(true);
    expect(list.find((p) => p.displayName === "Bruno")!.prizeLabel).toBe("Prize L3");
    expect(list.filter((p) => p.displayName === "Ana").every((p) => p.prizeLabel === "Prize L1")).toBe(true);
    // nothing internal: no identifier of any kind in what is sent
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(JSON.stringify(list)).not.toMatch(/@|member|qualification|activation/i);
    expect(list.map((p) => p.code)).not.toContain(prizePublicCode(f.otherPrizeId));
  });

  it("a name with line breaks or odd spacing is shown on one clean line", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const details = await f.repo.listQualificationDetailsForActivation(f.world.activationId);
    f.repo.setMemberDisplayName(details[0]!.gamingMemberId, "  Zeta\n \t Dos  ");
    const list = await service.listPrizes(f.deps, ctx);
    expect(list.map((p) => p.displayName)).toContain("Zeta Dos");
  });

  it("a prize that was superseded, put on hold or already satisfied is UNAVAILABLE, never offered, and a request to deliver it is refused and logged", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const ids = [f.prizeIds.ana1, f.prizeIds.ana2, f.prizeIds.bruno];
    const now = new Date(T0).toISOString();
    const set = (id: string, change: Partial<typeof f.qualifications extends Map<string, infer V> ? V : never>) => f.qualifications.set(id, { ...f.qualifications.get(id)!, ...change });
    set(ids[0]!, { supersededAt: now });
    set(ids[1]!, { heldAt: now, releasedAt: null });
    set(ids[2]!, { fulfilledByPrizeQualificationId: randomUUID() });
    const list = await service.listPrizes(f.deps, ctx);
    expect(list.map((p) => p.status)).toEqual(["UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE"]);
    for (const prize of list) {
      await expect(service.redeem(f.deps, ctx, { code: prize.code, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(PrizeNotAvailableError);
    }
    expect(f.stations.events.map((e) => e.outcome)).toEqual(["REFUSED", "REFUSED", "REFUSED"]);
    expect(f.stations.events.map((e) => e.detail).sort()).toEqual(["FULFILLED", "HELD", "SUPERSEDED"]);
    expect(f.stations.events.every((e) => e.declaredOperator === null)).toBe(true); // no name is kept for something that was not delivered
    expect([...f.qualifications.values()].filter((q) => q.venueActivationId === f.world.activationId).every((q) => q.redeemedAt === null)).toBe(true);
  });
});

describe("delivering a prize", () => {
  it("needs the explicit confirmation, a clean declared name and a code that belongs to this station", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const code = (await service.listPrizes(f.deps, ctx))[0]!.code;
    for (const confirm of [false, undefined, "true", 1, null]) {
      await expect(service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm })).rejects.toBeInstanceOf(InvalidStationRequestError);
    }
    for (const operatorName of [undefined, null, "", " ", "J", "x".repeat(41), "<script>", "a\u0000b", "Josué; drop", 5]) {
      await expect(service.redeem(f.deps, ctx, { code, operatorName, confirm: true })).rejects.toBeInstanceOf(InvalidStationRequestError);
    }
    for (const bad of [undefined, null, "", "CL-AAAAAA", "cl-123456", prizePublicCode(f.otherPrizeId), f.prizeIds.ana1]) {
      await expect(service.redeem(f.deps, ctx, { code: bad, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(PrizeCodeNotFoundError);
    }
    expect((await f.repo.listQualificationDetailsForActivation(f.world.activationId)).every((q) => q.redeemedAt === null)).toBe(true);
    expect(f.stations.events).toHaveLength(0);
  });

  it("clean names are accepted as written: initials, accents, a double surname", () => {
    for (const ok of ["JD", "Josué DiBrasco", "María-José", "O'Neil", "Ana 2", "  Ana   Luisa "]) expect(() => cleanOperatorName(ok)).not.toThrow();
    expect(cleanOperatorName("  Ana   Luisa ")).toBe("Ana Luisa");
  });

  it("is made under the STATION's own identity, never a person's authority and never the general redemption", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const list = await service.listPrizes(f.deps, ctx);
    const bruno = list.find((p) => p.displayName === "Bruno")!;
    const general = vi.spyOn(f.repo, "redeemPrizeQualification");
    const result = await service.redeem(f.deps, ctx, { code: bruno.code, operatorName: "Josué D", confirm: true });
    expect(result.outcome).toBe("REDEEMED");
    expect(result.prize).toMatchObject({ code: bruno.code, status: "REDEEMED", displayName: "Bruno" });
    expect(result.prize.redeemedAt).not.toBeNull();
    expect(general).not.toHaveBeenCalled(); // the CONSEQUENTIAL_FINALIZER redemption is not the station's way
    // the single source of truth, with the station as the one who delivered
    const q = f.qualifications.get(f.prizeIds.bruno)!;
    expect(q.redeemedAt).toBe(result.prize.redeemedAt);
    expect(q.redeemedByGamingMemberId).toBe(STATION_ACTOR);
    expect(q.redeemedByGamingMemberId).not.toBe(ACTOR);
    expect(q.redeemedPrizeLabel).toBe("Prize L3");
    expect(q.redeemedPrizeLabelBasis).toBe("SNAPSHOT_AT_REDEMPTION");
    // exactly one audit event, by the station, with no authority class and no personal name
    const audit = (await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", f.prizeIds.bruno)).filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: "GAMING_MEMBER", actorId: STATION_ACTOR, authorityClassUsed: null, outcome: "SUCCESS" });
    expect(audit[0]!.reason).toContain("PIN compartido");
    expect(audit[0]!.reason).toContain("no acredita individualmente quién operó");
    expect(audit[0]!.reason).toContain(f.stations.events[0]!.eventId); // it points at the station record ...
    expect(audit[0]!.reason).not.toContain("Josué"); // ... instead of repeating the name
    // the declared name is recorded apart, once
    expect(f.stations.events).toHaveLength(1);
    expect(f.stations.events[0]).toMatchObject({ outcome: "REDEEMED", declaredOperator: "Josué D", prizeQualificationId: f.prizeIds.bruno, sessionId: ctx.session.sessionId });
    // only that prize changed
    expect((await service.listPrizes(f.deps, ctx)).map((p) => p.status).sort()).toEqual(["PENDING", "PENDING", "REDEEMED"]);
  });

  it("a prize already delivered says so and cannot be delivered again: no second delivery, no second audit event, and no second name kept", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const code = (await service.listPrizes(f.deps, ctx)).find((p) => p.displayName === "Bruno")!.code;
    const first = await service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm: true });
    const second = await service.redeem(f.deps, ctx, { code, operatorName: "Otra Persona", confirm: true });
    expect(first.outcome).toBe("REDEEMED");
    expect(second.outcome).toBe("ALREADY_REDEEMED");
    expect(second.prize.redeemedAt).toBe(first.prize.redeemedAt);
    const audit = await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", f.prizeIds.bruno);
    expect(audit.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION")).toHaveLength(1);
    expect(f.stations.events.map((e) => [e.outcome, e.declaredOperator])).toEqual([["REDEEMED", "Josué D"], ["ALREADY_REDEEMED", null]]);
    expect(JSON.stringify(f.stations.events)).not.toContain("Otra Persona");
  });

  it("twelve people confirming the same prize at the same moment, from three sessions, end in ONE delivery", async () => {
    const f = await fixture();
    const contexts = [await login(f, "10.0.0.1"), await login(f, "10.0.0.2"), await login(f, "10.0.0.3")];
    const code = (await service.listPrizes(f.deps, contexts[0]!)).find((p) => p.displayName === "Bruno")!.code;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => service.redeem(f.deps, contexts[i % 3]!, { code, operatorName: `Encargado ${i}`, confirm: true })));
    expect(results.filter((r) => r.outcome === "REDEEMED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "ALREADY_REDEEMED")).toHaveLength(11);
    expect(new Set(results.map((r) => r.prize.redeemedAt)).size).toBe(1);
    const audit = await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", f.prizeIds.bruno);
    expect(audit.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION")).toHaveLength(1);
    expect(f.stations.events.filter((e) => e.declaredOperator !== null)).toHaveLength(1);
  });
});

describe("a delivery is limited, in the data layer, to the approved event and venue — whatever the request says", () => {
  it("a prize of ANOTHER match and activation is refused even when the code check above it is bypassed or fooled", async () => {
    const f = await fixture();
    const ctx = await login(f);
    // (1) straight to the delivery, with the foreign prize's identifier
    await expect(f.stations.redeemInScope({ sessionTokenSha256: ctx.tokenSha256, prizeQualificationId: f.otherPrizeId, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(PrizeCodeNotFoundError);
    // (2) the listing is made to include the foreign prize (as if the activation check above had been fooled)
    const foreign = await f.repo.listQualificationDetailsForActivation(f.otherWorld.activationId);
    const spy = vi.spyOn(f.repo, "listQualificationDetailsForActivation").mockResolvedValue(foreign);
    const shown = await service.listPrizes(f.deps, ctx);
    await expect(service.redeem(f.deps, ctx, { code: shown[0]!.code, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(PrizeCodeNotFoundError);
    spy.mockRestore();
    // (3) an identifier that is no prize at all
    for (const id of [randomUUID(), "", "not-a-prize"]) await expect(f.stations.redeemInScope({ sessionTokenSha256: ctx.tokenSha256, prizeQualificationId: id, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(PrizeCodeNotFoundError);
    expect(f.qualifications.get(f.otherPrizeId)!.redeemedAt).toBeNull();
    expect(f.stations.events).toHaveLength(0);
    expect(await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", f.otherPrizeId)).toEqual([]);
  });

  it("the station is whatever the SESSION says: there is no way to name another station, and a made-up session delivers nothing", async () => {
    const f = await fixture();
    const ctx = await login(f);
    expect(f.stations.redeemInScope.length).toBe(1); // one argument: the session token, the prize and the name — no station among them
    expect(Object.keys({ sessionTokenSha256: 1, prizeQualificationId: 1, declaredOperator: 1 })).not.toContain("stationId");
    for (const token of ["f".repeat(64), "", "x"]) await expect(f.stations.redeemInScope({ sessionTokenSha256: token, prizeQualificationId: f.prizeIds.bruno, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(StationUnauthorizedError);
    expect(f.qualifications.get(f.prizeIds.bruno)!.redeemedAt).toBeNull();
    expect(ctx).toBeDefined();
  });

  it("a closed station delivers nothing: revoked, past its end, or its session expired — even with a session that was good a moment ago", async () => {
    const f = await fixture({ ttlMinutes: 60 });
    const ctx = await login(f);
    const code = (await service.listPrizes(f.deps, ctx))[0]!.code;
    f.clock.now += 61 * 60_000; // session expired
    await expect(service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(StationUnauthorizedError);

    const g = await fixture();
    const gctx = await login(g);
    await service.revokeStationBySlug(g.deps, SLUG);
    await expect(g.stations.redeemInScope({ sessionTokenSha256: gctx.tokenSha256, prizeQualificationId: g.prizeIds.bruno, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(StationUnauthorizedError);

    const h = await fixture({ expiresInMs: 90 * 60_000, ttlMinutes: 240 });
    const hctx = await login(h);
    h.clock.now += 91 * 60_000;
    await expect(h.stations.redeemInScope({ sessionTokenSha256: hctx.tokenSha256, prizeQualificationId: h.prizeIds.bruno, declaredOperator: "Josué D" })).rejects.toBeInstanceOf(StationUnauthorizedError);
    for (const x of [f, g, h]) expect([...x.qualifications.values()].every((q) => q.redeemedAt === null)).toBe(true);
  });

  it("if the identity of the station ever held ANY authority, it refuses to deliver rather than run with more than it should", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const code = (await service.listPrizes(f.deps, ctx))[0]!.code;
    f.authorityHolders.add(STATION_ACTOR);
    await expect(service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm: true })).rejects.toBeInstanceOf(StationMisconfiguredError);
    expect([...f.qualifications.values()].every((q) => q.redeemedAt === null)).toBe(true);
  });

  it("the declared name is checked again at the delivery (length, no control characters), so a request that skips the page's check cannot store anything else", async () => {
    const f = await fixture();
    const ctx = await login(f);
    for (const name of ["", " ", "J", "x".repeat(41), "a\u0000b", "a\nb", "\u0007\u0007"]) {
      await expect(f.stations.redeemInScope({ sessionTokenSha256: ctx.tokenSha256, prizeQualificationId: f.prizeIds.bruno, declaredOperator: name })).rejects.toBeInstanceOf(InvalidStationRequestError);
    }
    expect(f.stations.events).toHaveLength(0);
  });
});

describe("what is kept about people, and for how long", () => {
  it("the station keeps no address and no name beyond two things: a salted hash of the address in the attempts, and the declared name of a delivery", async () => {
    const f = await fixture();
    const ctx = await login(f, "203.0.113.77");
    const code = (await service.listPrizes(f.deps, ctx))[0]!.code;
    await service.redeem(f.deps, ctx, { code, operatorName: "Josué D", confirm: true });
    const everything = JSON.stringify([[...f.stations.sessions.values()], f.stations.events, f.stations.attemptRows(), await f.stations.listPinChanges(f.station.stationId)]);
    expect(everything).not.toContain("203.0.113.77");
    for (const session of f.stations.sessions.values()) expect(Object.keys(session).sort()).toEqual(["expiresAt", "pinVersion", "revokedAt", "sessionId", "stationId", "tokenSha256"]); // no address on a session
    expect(f.stations.attemptRows()[0]!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.stations.attemptRows()[0]!.ipHash).toBe(service.ipHashOf("203.0.113.77", f.station.ipSalt));
    expect(f.station.ipSalt).not.toBe(f.station.pinSalt); // the address salt is its own
  });

  it("attempts older than 24 hours are deleted when the next attempt is recorded; closing the station deletes the rest", async () => {
    const f = await fixture();
    await service.loginWithPin(f.deps, SLUG, "11111111", "10.0.0.1").catch(() => undefined);
    await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.2");
    expect(f.stations.attemptRows()).toHaveLength(2);
    f.clock.now += 25 * 3600_000;
    await service.loginWithPin(f.deps, SLUG, PIN, "10.0.0.3");
    expect(f.stations.attemptRows()).toHaveLength(1); // only the new one remains
    await service.revokeStationBySlug(f.deps, SLUG);
    expect(f.stations.attemptRows()).toHaveLength(0);
  });

  it("the declared name is kept only for a delivery this station made, in the immutable station log — never for a repeat or a refusal", async () => {
    const f = await fixture();
    const ctx = await login(f);
    const list = await service.listPrizes(f.deps, ctx);
    await service.redeem(f.deps, ctx, { code: list[0]!.code, operatorName: "Primera Persona", confirm: true });
    await service.redeem(f.deps, ctx, { code: list[0]!.code, operatorName: "Segunda Persona", confirm: true });
    f.qualifications.set(f.prizeIds.bruno, { ...f.qualifications.get(f.prizeIds.bruno)!, supersededAt: new Date(T0).toISOString() });
    const bruno = list.find((p) => p.displayName === "Bruno")!;
    await service.redeem(f.deps, ctx, { code: bruno.code, operatorName: "Tercera Persona", confirm: true }).catch(() => undefined);
    const withName = f.stations.events.filter((e) => e.declaredOperator !== null);
    expect(withName.map((e) => [e.outcome, e.declaredOperator])).toEqual([["REDEEMED", "Primera Persona"]]);
    expect(JSON.stringify(f.stations.events)).not.toMatch(/Segunda|Tercera/);
  });
});

describe("the identity of the station is not a person's", () => {
  it("no tracked file names the Founder's personal account as the actor of the station", () => {
    const personal = ["a802c9b5-8d07-413c-b65e-a3b1ca98f29a"];
    const roots = ["lib/gaming/redemption-station", "app/api/gaming/canje", "public/canje-the-pub.html", "public/canjeStation.js", "public/canje-admin.html", "public/canjeAdmin.js", "supabase/migrations/20261028120000_create_redemption_station.sql", "supabase/migrations/20261028121000_create_clasico_the_pub_redemption_station.sql"];
    const files: string[] = [];
    const walk = (target: string) => {
      const full = path.join(process.cwd(), target);
      let info;
      try { info = statSync(full); } catch { return; }
      if (info.isDirectory()) for (const entry of readdirSync(full)) walk(path.join(target, entry));
      else files.push(full);
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) for (const id of personal) expect(readFileSync(file, "utf8"), file).not.toContain(id);
  });

  it("the migrations grant no authority to anyone and never call the general redemption", () => {
    for (const file of ["20261028120000_create_redemption_station.sql", "20261028121000_create_clasico_the_pub_redemption_station.sql"]) {
      const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8").replace(/^\s*--.*$/gm, ""); // the comments explain; the code is what counts
      expect(sql, file).not.toMatch(/insert\s+into\s+authority_grants|grant_platform_authority|bootstrap_governance/i);
      expect(sql, file).not.toMatch(/redeem_prize_qualification_atomically/i);
      expect(sql, file).not.toMatch(/CONSEQUENTIAL_FINALIZER/);
    }
  });
});

describe("the station can do nothing else", () => {
  it("exposes no way to undo a delivery, change a prize, change a result or look at another event", () => {
    expect(Object.keys(service).sort()).toEqual(["authenticate", "ipHashOf", "listPrizes", "loginWithPin", "logout", "redeem", "revokeStationBySlug", "setStationPin", "stationAdminStatus"]);
    const repoMethods = Object.getOwnPropertyNames(InMemoryStationRepository.prototype).filter((n) => n !== "constructor" && n !== "addStation" && n !== "attemptRows" && n !== "publicSession").sort(); // addStation and attemptRows only serve tests
    expect(repoMethods).toEqual(["beginAttempt", "createSession", "getAdminFacts", "getSessionByTokenSha256", "getStationBySlug", "listEvents", "listPinChanges", "markAttemptSucceeded", "redeemInScope", "revokeSession", "revokeStation", "setPin"].sort());
  });

  it("its code only ever READS the activation's qualifications from the prize repository and never calls the general redemption", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/gaming/redemption-station/service.ts"), "utf8");
    const calls = [...source.matchAll(/deps\.predictions\.(\w+)/g)].map((m) => m[1]).sort();
    expect([...new Set(calls)]).toEqual(["listQualificationDetailsForActivation"]);
    expect(source).not.toContain("redeemPrizeQualification");
    for (const file of ["lib/gaming/redemption-station/db/supabaseStationRepository.ts", "lib/gaming/redemption-station/http.ts"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toContain("redeem_prize_qualification_atomically");
    }
  });

  it("the routes are exactly: open session, close session, list prizes, deliver a prize, revoke the access, and the PIN (read the state, set it)", () => {
    const base = path.join(process.cwd(), "app/api/gaming/canje/[slug]");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") {
          const methods = [...readFileSync(full, "utf8").matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
          found.push(path.relative(base, full) + ":" + methods.sort().join(","));
        }
      }
    };
    walk(base);
    expect(found.sort()).toEqual(["pin/route.ts:GET,POST", "prizes/route.ts:GET", "redeem/route.ts:POST", "revoke/route.ts:POST", "session/route.ts:DELETE,POST"]);
  });
});

describe("the public code", () => {
  it("is stable, short, readable and different for different prizes", () => {
    const id = randomUUID();
    expect(prizePublicCode(id)).toBe(prizePublicCode(id.toUpperCase()));
    expect(prizePublicCode(id)).toMatch(PUBLIC_CODE_PATTERN);
    const codes = new Set(Array.from({ length: 5000 }, () => prizePublicCode(randomUUID())));
    expect(codes.size).toBeGreaterThan(4990);
    for (const code of codes) expect(code.slice(3)).not.toMatch(/[ILOU]/);
  });

  it("refuses to run (fails closed) if two prizes would ever share a code, rather than hand out an ambiguous one", () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 400000 && !pair; i++) {
      const id = randomUUID();
      const code = prizePublicCode(id);
      const earlier = seen.get(code);
      if (earlier) pair = [earlier, id];
      else seen.set(code, id);
    }
    expect(pair).not.toBeNull();
    expect(() => assignPublicCodes(pair!)).toThrow(PublicCodeCollisionError);
    expect(assignPublicCodes([pair![0]]).size).toBe(1);
  });
});

describe("no secret is written anywhere that is published", () => {
  it("the PIN logic keeps only a salted hash and compares in constant time", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/gaming/redemption-station/pin.ts"), "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("scryptSync");
    expect(source).not.toMatch(/pin\s*[:=]\s*["'`]\d{4,}/i);
  });

  it("the page, its script, the QR target and the code carry no PIN-looking value", () => {
    for (const file of ["public/canje-the-pub.html", "public/canjeStation.js", "lib/gaming/redemption-station/service.ts", "lib/gaming/redemption-station/http.ts"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(/\bpin\b[^\n]{0,20}[:=]\s*["'`]?\d{6,12}\b/i);
    }
  });
});
