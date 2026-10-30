import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { completeSession } from "../lib/session/completeSession";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import { InMemoryGamingRepository } from "../lib/gaming/db/inMemoryGamingRepository";
import { resolveGamingAuth, type AuthUserVerifier } from "../lib/gaming/auth";
import { HostTokenMismatchError, SessionNotFoundError, SelfVoteNotAllowedError } from "../lib/session/types";

import { CommunityVotingError, type GeofenceConfig, type LocationClaim } from "../lib/gaming/communityVoting/types";
import {
  assessLocationEligibility,
  haversineMeters,
  validateGeofenceConfig,
  validateLocationClaim,
} from "../lib/gaming/communityVoting/eligibility";
import {
  mapAuthUserToVerifiedIdentity,
  resolveVerifiedVoter,
  type VoterIdentityVerifier,
} from "../lib/gaming/communityVoting/verifiedIdentity";
import { registerCommunityVotingInstance } from "../lib/gaming/communityVoting/registerInstance";
import { bindCommunityVotingVoter } from "../lib/gaming/communityVoting/bindVoter";
import { issueCommunityVotingIntent } from "../lib/gaming/communityVoting/issueVoteIntent";
import { castCommunityVote } from "../lib/gaming/communityVoting/castCommunityVote";
import {
  createCommunityVotingEntry,
  confirmCommunityVotingEntry,
  readCommunityVotingPreparation,
  removeCommunityVotingEntry,
} from "../lib/gaming/communityVoting/preparation";
import { claimCommunityVotingEntry } from "../lib/gaming/communityVoting/claimEntry";
import { startCommunityVoting } from "../lib/gaming/communityVoting/startVoting";
import { getCommunityVotingStatus } from "../lib/gaming/communityVoting/getVoterStatus";
import { communityVotingErrorBody, statusForCommunityVotingError } from "../lib/gaming/communityVoting/httpSupport";
import { InMemoryCommunityVotingRepository } from "../lib/gaming/communityVoting/db/inMemoryCommunityVotingRepository";

/**
 * UG-IV-GATE-002 / UG-IV-GATE-003 — Community Voting local foundation, in-memory behavioral suite.
 *
 * GATE-003 contract (Canon: IDENTITY_VOTING_LITERAL_PREPARATION_AND_ATOMIC_START_ACCEPTED):
 * PROMPT_ACTIVE means Voting is actually open. All preparation — the complete ballot and a verified,
 * host-confirmed contestant for every entry — happens BEFORE it, and one explicit, atomic, host-authorized
 * start materializes the attributed candidates and opens the Session's Voting interaction. There is no
 * "open but still preparing" state anywhere.
 *
 * The real Postgres behavior (grants, locks, rollback, races, deletion containment, the guards on
 * ordinary joining and ordinary starting) is proven separately in communityVotingSupabase.contract.test.ts.
 * Everything below uses synthetic identities and synthetic venue facts only.
 */

// ---------------------------------------------------------------- fixtures

const VENUE: GeofenceConfig = {
  venueLatitude: 14.1,
  venueLongitude: -87.2,
  venueRadiusMeters: 100,
  maxAccuracyMeters: 50,
  insideMarginFactor: 1,
  outsideMarginFactor: 1,
};

const METERS_PER_DEGREE_LAT = 111_195;
/** A position `meters` due north of the synthetic venue centre, with a distinctive longitude so leaks are greppable. */
function northOfVenue(meters: number, accuracyMeters: number, lonJitter = 0.000_013): LocationClaim {
  return {
    latitude: VENUE.venueLatitude + meters / METERS_PER_DEGREE_LAT,
    longitude: VENUE.venueLongitude + lonJitter,
    accuracyMeters,
  };
}
const INSIDE = northOfVenue(10, 5);
const OUTSIDE = northOfVenue(300, 5);
const AMBIGUOUS = northOfVenue(100, 20);

/** Shared across verifiers so a token issued for one event is genuinely unknown to another event's verifier. */
let issuedIdentities = 0;

class FakeVerifier implements VoterIdentityVerifier {
  private identities = new Map<string, { authUserId: string; phoneVerified: boolean }>();
  issue(opts: { phoneVerified?: boolean } = {}): { token: string; authUserId: string; header: string } {
    issuedIdentities += 1;
    const authUserId = `00000000-0000-4000-8000-${String(issuedIdentities).padStart(12, "0")}`;
    const token = `fake-access-token-${issuedIdentities}`;
    this.identities.set(token, { authUserId, phoneVerified: opts.phoneVerified ?? true });
    return { token, authUserId, header: `Bearer ${token}` };
  }
  async verifyAccessToken(accessToken: string) {
    return this.identities.get(accessToken) ?? null;
  }
  asAuthUserVerifier(): AuthUserVerifier {
    return {
      verifyAccessToken: async (accessToken: string) => {
        const found = this.identities.get(accessToken);
        return found ? { authUserId: found.authUserId } : null;
      },
    };
  }
}

async function setupEvent(opts: { registerCapabilities?: string[] } = {}) {
  const sessionRepo = new InMemorySessionRepository();
  const clock = { t: Date.parse("2026-10-21T12:00:00Z") };
  const repo = new InMemoryCommunityVotingRepository(sessionRepo, { now: () => clock.t });
  const verifier = new FakeVerifier();
  const session = await createSession(sessionRepo);
  await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, (opts.registerCapabilities ?? ["VOTING"]) as never);
  const instance = await registerCommunityVotingInstance(repo, {
    sessionId: session.sessionId,
    hostToken: session.hostToken,
    config: VENUE,
    ruleVersion: 1,
  });
  return { sessionRepo, repo, verifier, session, instance, clock };
}
type Ctx = Awaited<ReturnType<typeof setupEvent>>;

async function bindNewVoter(ctx: Ctx, opts: { phoneVerified?: boolean } = {}) {
  const voter = ctx.verifier.issue(opts);
  const binding = await bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId);
  return { ...voter, binding };
}
type Voter = Awaited<ReturnType<typeof bindNewVoter>>;

const hostOf = (ctx: Ctx) => ({ instanceId: ctx.instance.instanceId, hostToken: ctx.session.hostToken });

/** Full private preparation for each label: bind a contestant, host creates the entry, contestant claims it, host confirms it. */
async function prepareContestants(ctx: Ctx, labels: string[]): Promise<Voter[]> {
  const contestants: Voter[] = [];
  for (const label of labels) {
    const contestant = await bindNewVoter(ctx);
    const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label });
    const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, contestant.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
    await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    contestants.push(contestant);
  }
  return contestants;
}

/** The explicit start: lock the lobby if the host has not, then the Community Voting start. Never called implicitly by preparation. */
async function startBallot(ctx: Ctx, promptText = "Mejor disfraz") {
  const session = await ctx.sessionRepo.getSessionById(ctx.session.sessionId);
  if (session!.state === "LOBBY_OPEN") await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
  const started = await startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText });
  const candidates = await ctx.sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
  return { interactionInstanceId: started.interactionInstanceId, candidates, started };
}

async function openVoting(ctx: Ctx, labels = ["Vampiro", "Bruja", "Fantasma"]) {
  const contestants = await prepareContestants(ctx, labels);
  const ballot = await startBallot(ctx);
  return { ...ballot, contestants };
}

/** A fully prepared, opened event: 3 confirmed contestants, then a plain voter who arrives while voting is open. */
async function preparedEvent() {
  const ctx = await setupEvent();
  const voting = await openVoting(ctx);
  const voter = await bindNewVoter(ctx);
  return { ctx, voting, contestants: voting.contestants, voter };
}

async function cast(
  ctx: Ctx,
  voter: Voter,
  voting: { interactionInstanceId: string },
  candidateId: string,
  intentNo: number,
  location: LocationClaim = INSIDE
) {
  return castCommunityVote(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, {
    bindingId: voter.binding.bindingId,
    intentNo,
    interactionInstanceId: voting.interactionInstanceId,
    candidateId,
    location,
  });
}
async function issue(ctx: Ctx, voter: Voter) {
  return issueCommunityVotingIntent(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId);
}
async function status(ctx: Ctx, voter: Voter) {
  return getCommunityVotingStatus(ctx.repo, ctx.sessionRepo, ctx.verifier, voter.header, ctx.instance.instanceId);
}
function voteCastEvents(ctx: Ctx) {
  return ((ctx.sessionRepo as unknown as { events: Array<{ eventType: string }> }).events).filter((e) => e.eventType === "VOTE_CAST");
}
async function expectCode(promise: Promise<unknown>, code: string) {
  const outcome = await promise.then(() => null, (e: unknown) => e);
  expect(outcome, `expected CommunityVotingError ${code}`).toBeInstanceOf(CommunityVotingError);
  expect((outcome as CommunityVotingError).code).toBe(code);
  return outcome as CommunityVotingError;
}

// ---------------------------------------------------------------- geolocation

describe("Geolocation — validation (untrusted client claims)", () => {
  it("accepts a well-formed reading", () => {
    expect(validateLocationClaim({ latitude: 14.1, longitude: -87.2, accuracyMeters: 8 })).toEqual({
      latitude: 14.1,
      longitude: -87.2,
      accuracyMeters: 8,
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "14.1,-87.2"],
    ["an array", [14.1, -87.2, 5]],
    ["missing latitude", { longitude: -87.2, accuracyMeters: 5 }],
    ["missing longitude", { latitude: 14.1, accuracyMeters: 5 }],
    ["missing accuracy", { latitude: 14.1, longitude: -87.2 }],
    ["string latitude", { latitude: "14.1", longitude: -87.2, accuracyMeters: 5 }],
    ["NaN latitude", { latitude: Number.NaN, longitude: -87.2, accuracyMeters: 5 }],
    ["Infinity longitude", { latitude: 14.1, longitude: Number.POSITIVE_INFINITY, accuracyMeters: 5 }],
    ["latitude above 90", { latitude: 90.000001, longitude: -87.2, accuracyMeters: 5 }],
    ["latitude below -90", { latitude: -90.000001, longitude: -87.2, accuracyMeters: 5 }],
    ["longitude above 180", { latitude: 14.1, longitude: 180.000001, accuracyMeters: 5 }],
    ["longitude below -180", { latitude: 14.1, longitude: -180.000001, accuracyMeters: 5 }],
    ["zero accuracy", { latitude: 14.1, longitude: -87.2, accuracyMeters: 0 }],
    ["negative accuracy", { latitude: 14.1, longitude: -87.2, accuracyMeters: -3 }],
    ["NaN accuracy", { latitude: 14.1, longitude: -87.2, accuracyMeters: Number.NaN }],
    ["Infinite accuracy", { latitude: 14.1, longitude: -87.2, accuracyMeters: Number.POSITIVE_INFINITY }],
    ["string accuracy", { latitude: 14.1, longitude: -87.2, accuracyMeters: "5" }],
  ])("rejects a reading that is %s", (_label, raw) => {
    expect(() => validateLocationClaim(raw)).toThrowError(CommunityVotingError);
    try {
      validateLocationClaim(raw);
    } catch (e) {
      expect((e as CommunityVotingError).code).toBe("INVALID_LOCATION_READING");
    }
  });

  it("rejects (0,0) as the explicit current pilot policy", () => {
    expect(() => validateLocationClaim({ latitude: 0, longitude: 0, accuracyMeters: 5 })).toThrowError(CommunityVotingError);
    // ... but only as policy: a reading on the equator OR the prime meridian alone is not rejected.
    expect(() => validateLocationClaim({ latitude: 0, longitude: 10, accuracyMeters: 5 })).not.toThrow();
    expect(() => validateLocationClaim({ latitude: 10, longitude: 0, accuracyMeters: 5 })).not.toThrow();
  });

  it("never echoes coordinate values in its error text", () => {
    for (const raw of [
      { latitude: 91.123456, longitude: -87.654321, accuracyMeters: 5 },
      { latitude: 14.123456, longitude: -187.654321, accuracyMeters: 5 },
      { latitude: 14.123456, longitude: -87.654321, accuracyMeters: -987.654 },
    ]) {
      let thrown: unknown = null;
      try {
        validateLocationClaim(raw);
      } catch (e) {
        thrown = e;
      }
      // A real validation rejection — not "any error" (a stub or a crash must not satisfy this test).
      expect(thrown).toBeInstanceOf(CommunityVotingError);
      expect((thrown as CommunityVotingError).code).toBe("INVALID_LOCATION_READING");
      const text = `${(thrown as Error).message} ${(thrown as Error).stack ?? ""}`;
      for (const needle of ["91.123456", "14.123456", "87.654321", "187.654321", "987.654"]) {
        expect(text).not.toContain(needle);
      }
    }
  });
});

describe("Geolocation — server-side assessment", () => {
  it("computes the distance itself from stored venue facts", () => {
    const d = haversineMeters(VENUE.venueLatitude, VENUE.venueLongitude, northOfVenue(250, 1).latitude, VENUE.venueLongitude);
    expect(d).toBeGreaterThan(245);
    expect(d).toBeLessThan(255);
    expect(assessLocationEligibility(northOfVenue(250, 1, 0), VENUE).distanceMeters).toBeCloseTo(d, 3);
  });

  it("INSIDE when distance plus the inside accuracy margin fits the radius", () => {
    expect(assessLocationEligibility(INSIDE, VENUE).decision).toBe("INSIDE");
  });

  it("OUTSIDE when distance minus the outside accuracy margin still exceeds the radius", () => {
    expect(assessLocationEligibility(OUTSIDE, VENUE).decision).toBe("OUTSIDE");
  });

  it("AMBIGUOUS in the band the accuracy circle straddles", () => {
    expect(assessLocationEligibility(AMBIGUOUS, VENUE).decision).toBe("AMBIGUOUS");
  });

  it("a reading centred exactly on the boundary with any accuracy is AMBIGUOUS, not INSIDE", () => {
    expect(assessLocationEligibility(northOfVenue(100, 1, 0), VENUE).decision).toBe("AMBIGUOUS");
  });

  it("uses the configured margin factors rather than fixed constants", () => {
    const strict = { ...VENUE, insideMarginFactor: 3 };
    // 60 m away, accuracy 20 m: inside with factor 1 (80 <= 100), not inside with factor 3 (120 > 100).
    const claim = northOfVenue(60, 20, 0);
    expect(assessLocationEligibility(claim, VENUE).decision).toBe("INSIDE");
    expect(assessLocationEligibility(claim, strict).decision).toBe("AMBIGUOUS");
  });

  it("an excessive-accuracy reading is rejected even when its centre is inside", () => {
    expect(assessLocationEligibility(northOfVenue(1, 51, 0), VENUE).decision).toBe("ACCURACY_EXCESSIVE");
    expect(assessLocationEligibility(northOfVenue(1, 50, 0), VENUE).decision).toBe("INSIDE");
  });
});

describe("Geofence configuration validation", () => {
  it("accepts a well-formed configuration", () => {
    expect(validateGeofenceConfig(VENUE)).toEqual(VENUE);
  });
  it.each([
    ["latitude out of range", { ...VENUE, venueLatitude: 91 }],
    ["longitude out of range", { ...VENUE, venueLongitude: -181 }],
    ["NaN latitude", { ...VENUE, venueLatitude: Number.NaN }],
    ["zero radius", { ...VENUE, venueRadiusMeters: 0 }],
    ["negative radius", { ...VENUE, venueRadiusMeters: -5 }],
    ["zero max accuracy", { ...VENUE, maxAccuracyMeters: 0 }],
    ["negative inside margin", { ...VENUE, insideMarginFactor: -1 }],
    ["negative outside margin", { ...VENUE, outsideMarginFactor: -0.5 }],
    ["string radius", { ...VENUE, venueRadiusMeters: "100" }],
    ["missing field", { venueLatitude: 14.1 }],
    ["not an object", "synthetic"],
  ])("rejects %s", (_label, raw) => {
    try {
      validateGeofenceConfig(raw);
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(CommunityVotingError);
      expect((e as CommunityVotingError).code).toBe("INVALID_GEOFENCE_CONFIG");
    }
  });
});

// ---------------------------------------------------------------- verified identity

describe("Verified identity — fail-closed mapping of server-verified Auth user details", () => {
  it("a phone-confirmed user is a verified-phone identity", () => {
    expect(
      mapAuthUserToVerifiedIdentity({ id: "u1", phone: "+10000000001", phone_confirmed_at: "2026-10-20T10:00:00Z" })
    ).toEqual({ authUserId: "u1", phoneVerified: true });
  });

  it.each([
    ["phone present but unconfirmed", { id: "u2", phone: "+10000000002" }],
    ["confirmation timestamp without a phone", { id: "u3", phone: "", phone_confirmed_at: "2026-10-20T10:00:00Z" }],
    ["an email-only user", { id: "u4", email: "x@example.invalid", email_confirmed_at: "2026-10-20T10:00:00Z" }],
    ["non-string phone", { id: "u5", phone: 12345, phone_confirmed_at: "2026-10-20T10:00:00Z" }],
    ["non-string confirmation", { id: "u6", phone: "+10000000006", phone_confirmed_at: true }],
  ])("is NOT phone-verified for %s", (_label, user) => {
    expect(mapAuthUserToVerifiedIdentity(user)).toEqual({ authUserId: (user as { id: string }).id, phoneVerified: false });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a user without an id", { phone: "+10000000007", phone_confirmed_at: "2026-10-20T10:00:00Z" }],
    ["an empty id", { id: "", phone: "+10000000008", phone_confirmed_at: "2026-10-20T10:00:00Z" }],
    ["a non-object", "u9"],
  ])("yields no identity at all for %s", (_label, user) => {
    expect(mapAuthUserToVerifiedIdentity(user)).toBeNull();
  });
});

describe("resolveVerifiedVoter — bearer handling", () => {
  it("rejects a missing header, a malformed scheme and an unknown token as authentication failures", async () => {
    const verifier = new FakeVerifier();
    await expectCode(resolveVerifiedVoter(verifier, undefined), "AUTHENTICATION_REQUIRED");
    await expectCode(resolveVerifiedVoter(verifier, null), "AUTHENTICATION_REQUIRED");
    await expectCode(resolveVerifiedVoter(verifier, "Basic abc"), "AUTHENTICATION_REQUIRED");
    await expectCode(resolveVerifiedVoter(verifier, "Bearer"), "AUTHENTICATION_REQUIRED");
    await expectCode(resolveVerifiedVoter(verifier, "Bearer not-a-real-token"), "AUTHENTICATION_REQUIRED");
  });

  it("rejects a verified Auth user without a verified phone", async () => {
    const verifier = new FakeVerifier();
    const emailOnly = verifier.issue({ phoneVerified: false });
    await expectCode(resolveVerifiedVoter(verifier, emailOnly.header), "VERIFIED_PHONE_REQUIRED");
  });

  it("returns the server-verified identity", async () => {
    const verifier = new FakeVerifier();
    const phone = verifier.issue();
    expect(await resolveVerifiedVoter(verifier, phone.header)).toEqual({ authUserId: phone.authUserId, phoneVerified: true });
  });
});

// ---------------------------------------------------------------- instance registration

describe("Instance registration", () => {
  it("binds one Instance to one Session, with no lifecycle state of its own", async () => {
    const { sessionRepo, instance, session } = await setupEvent();
    expect(instance.sessionId).toBe(session.sessionId);
    expect(instance.ruleVersion).toBe(1);
    expect(instance).not.toHaveProperty("state");
    expect(instance).toMatchObject(VENUE);
    // The Session lifecycle is untouched by registration.
    expect((await sessionRepo.getSessionById(session.sessionId))!.state).toBe("LOBBY_OPEN");
  });

  it("requires the Session's host authority", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    await expect(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: "wrong", config: VENUE, ruleVersion: 1 })
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: "", config: VENUE, ruleVersion: 1 })
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(
      registerCommunityVotingInstance(repo, {
        sessionId: "00000000-0000-4000-8000-00000000dead",
        hostToken: session.hostToken,
        config: VENUE,
        ruleVersion: 1,
      })
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it.each([
    ["no capability declared", [] as string[]],
    ["VOTING plus another capability", ["VOTING", "OPEN_RESPONSE"]],
    ["a different capability", ["OPEN_RESPONSE"]],
  ])("requires the declared capability set to be exactly VOTING (%s)", async (_label, caps) => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    if (caps.length > 0) await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, caps as never);
    await expectCode(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }),
      "CAPABILITY_SET_NOT_EXACTLY_VOTING"
    );
  });

  it("must precede any Participant", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    await joinSession(sessionRepo, session.roomCode, "Ordinary Guest");
    await expectCode(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }),
      "PARTICIPANTS_ALREADY_EXIST"
    );
  });

  it("enforces one Instance per Session", async () => {
    const { repo, session } = await setupEvent();
    await expectCode(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }),
      "INSTANCE_ALREADY_REGISTERED"
    );
  });

  it("only registers a Session that has not completed", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    await completeSession(sessionRepo, session.sessionId, session.hostToken);
    await expectCode(
      registerCommunityVotingInstance(repo, { sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }),
      "SESSION_NOT_REGISTRABLE"
    );
  });

  it("may register a locked Session that has no Participant yet", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    const instance = await registerCommunityVotingInstance(repo, {
      sessionId: session.sessionId,
      hostToken: session.hostToken,
      config: VENUE,
      ruleVersion: 7,
    });
    expect(instance.ruleVersion).toBe(7);
  });

  it("rejects malformed geofence configuration and rule versions", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const repo = new InMemoryCommunityVotingRepository(sessionRepo);
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    const base = { sessionId: session.sessionId, hostToken: session.hostToken };
    await expectCode(registerCommunityVotingInstance(repo, { ...base, config: { ...VENUE, venueRadiusMeters: 0 }, ruleVersion: 1 }), "INVALID_GEOFENCE_CONFIG");
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      await expectCode(registerCommunityVotingInstance(repo, { ...base, config: VENUE, ruleVersion: bad }), "INVALID_REQUEST");
    }
  });
});

// ---------------------------------------------------------------- verified voter binding

describe("Verified voter binding", () => {
  it("binds a profile-incomplete verified-phone identity and creates NO Gaming Member profile", async () => {
    const ctx = await setupEvent();
    const gaming = new InMemoryGamingRepository();
    const voter = ctx.verifier.issue();
    const before = await resolveGamingAuth(gaming, ctx.verifier.asAuthUserVerifier(), voter.header);
    expect(before).toEqual({ status: "profile_incomplete", authUserId: voter.authUserId });

    const binding = await bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId);
    expect(binding).toMatchObject({ instanceId: ctx.instance.instanceId, created: true });

    const after = await resolveGamingAuth(gaming, ctx.verifier.asAuthUserVerifier(), voter.header);
    expect(after).toEqual({ status: "profile_incomplete", authUserId: voter.authUserId });
    expect(await gaming.resolveGamingMemberByAuthUserId(voter.authUserId)).toBeNull();
  });

  it("requires a verified phone and a valid bearer", async () => {
    const ctx = await setupEvent();
    const emailOnly = ctx.verifier.issue({ phoneVerified: false });
    await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, emailOnly.header, ctx.instance.instanceId), "VERIFIED_PHONE_REQUIRED");
    await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, undefined, ctx.instance.instanceId), "AUTHENTICATION_REQUIRED");
    await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, "Bearer forged", ctx.instance.instanceId), "AUTHENTICATION_REQUIRED");
    expect(await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)).toHaveLength(0);
  });

  it("the Instance id (the QR context) alone grants nothing", async () => {
    const ctx = await setupEvent();
    await expectCode(getCommunityVotingStatus(ctx.repo, ctx.sessionRepo, ctx.verifier, undefined, ctx.instance.instanceId), "AUTHENTICATION_REQUIRED");
    await expectCode(issueCommunityVotingIntent(ctx.repo, ctx.verifier, undefined, ctx.instance.instanceId), "AUTHENTICATION_REQUIRED");
  });

  it("an unknown Instance is not found", async () => {
    const ctx = await setupEvent();
    const voter = ctx.verifier.issue();
    await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, "00000000-0000-4000-8000-00000000beef"), "INSTANCE_NOT_FOUND");
  });

  it("is idempotent: one binding and one Participant per Instance and Auth user, across retries and concurrency", async () => {
    const ctx = await setupEvent();
    const voter = ctx.verifier.issue();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId))
    );
    expect(new Set(results.map((r) => r.bindingId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)).toHaveLength(1);
    const again = await bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId);
    expect(again).toMatchObject({ bindingId: results[0].bindingId, created: false });
  });

  it("creates an opaque Participant that carries no identity and no profile link", async () => {
    const ctx = await setupEvent();
    const voters: Voter[] = [];
    for (let i = 0; i < 12; i++) voters.push(await bindNewVoter(ctx));
    const participants = await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId);
    expect(participants).toHaveLength(12);
    expect(new Set(participants.map((p) => p.displayName)).size).toBe(12);
    for (const p of participants) {
      expect(p.displayName).toMatch(/^cv-[0-9a-f]{16}$/);
      expect(p.gamingMemberId).toBeNull();
      expect(p.participantToken.length).toBeGreaterThanOrEqual(32);
      for (const v of voters) {
        expect(p.displayName).not.toContain(v.authUserId.slice(0, 8));
        expect(p.displayName).not.toContain(v.binding.bindingId.slice(0, 8));
        expect(p.participantId).not.toBe(v.authUserId);
      }
    }
  });

  it("re-checks the declared capability set at bind time", async () => {
    const ctx = await setupEvent();
    // Before the first Participant exists the host could still widen the set after registration.
    await setSessionCapabilities(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken, ["VOTING", "TRIVIA"]);
    const voter = ctx.verifier.issue();
    await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
    expect(await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)).toHaveLength(0);
  });

  describe("bounded admission states", () => {
    it("admits while the lobby is open", async () => {
      const ctx = await setupEvent();
      await expect(bindNewVoter(ctx)).resolves.toBeDefined();
    });

    it("admits a locked Session that has not started an interaction yet", async () => {
      const ctx = await setupEvent();
      await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
      await expect(bindNewVoter(ctx)).resolves.toBeDefined();
    });

    it("admits while the event Voting interaction is open (a late arrival)", async () => {
      const ctx = await setupEvent();
      await openVoting(ctx);
      await expect(bindNewVoter(ctx)).resolves.toBeDefined();
    });

    it("rejects admission once the Voting interaction is closed, revealed, or the Session is completed", async () => {
      const ctx = await setupEvent();
      const early = await bindNewVoter(ctx);
      await openVoting(ctx);
      const participantsAtClose = (await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)).length;
      await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
      const lateA = ctx.verifier.issue();
      await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, lateA.header, ctx.instance.instanceId), "ADMISSION_CLOSED");

      await revealResults(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
      await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, lateA.header, ctx.instance.instanceId), "ADMISSION_CLOSED");

      await completeSession(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
      await expectCode(bindCommunityVotingVoter(ctx.repo, ctx.verifier, lateA.header, ctx.instance.instanceId), "ADMISSION_CLOSED");

      // An EXISTING binding is still recoverable in every one of those states (idempotent, no new admission).
      const recovered = await bindCommunityVotingVoter(ctx.repo, ctx.verifier, early.header, ctx.instance.instanceId);
      expect(recovered).toMatchObject({ bindingId: early.binding.bindingId, created: false });
      expect(await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)).toHaveLength(participantsAtClose);
    });
  });
});

// ---------------------------------------------------------------- private preparation (before opening)

async function entryStates(ctx: Ctx) {
  const view = await readCommunityVotingPreparation(ctx.repo, hostOf(ctx));
  return view.entries.map((e) => [e.label, e.state] as const);
}

describe("Private preparation: entries, claims and host confirmation (all before opening)", () => {
  it("builds a complete, confirmed ballot WITHOUT opening Voting — preparation never opens anything", async () => {
    const ctx = await setupEvent();
    const watcher = await bindNewVoter(ctx);
    await prepareContestants(ctx, ["Uno", "Dos", "Tres"]);

    const view = await readCommunityVotingPreparation(ctx.repo, hostOf(ctx));
    expect(view.readiness).toEqual({ entryCount: 3, confirmedCount: 3, ready: true });
    expect(await entryStates(ctx)).toEqual([["Uno", "CONFIRMED"], ["Dos", "CONFIRMED"], ["Tres", "CONFIRMED"]]);

    // ready, yet nothing is open: no interaction, no candidate, the Session unchanged, no vote path.
    expect(await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId)).toHaveLength(0);
    expect((await ctx.sessionRepo.getSessionById(ctx.session.sessionId))!.state).toBe("LOBBY_OPEN");
    expect((await status(ctx, watcher)).phase).toBe("NOT_OPEN");
    await expectCode(issue(ctx, watcher), "VOTING_NOT_OPEN");
  });

  it("tracks readiness honestly: not ready until there are two entries and every one is confirmed", async () => {
    const ctx = await setupEvent();
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).readiness).toEqual({ entryCount: 0, confirmedCount: 0, ready: false });
    await prepareContestants(ctx, ["Uno"]);
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).readiness).toEqual({ entryCount: 1, confirmedCount: 1, ready: false });
    await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Dos" }); // unclaimed
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).readiness).toEqual({ entryCount: 2, confirmedCount: 1, ready: false });
  });

  it("hands the host a single-use claim credential once; no later host read contains it, or any identity", async () => {
    const ctx = await setupEvent();
    const contestant = await bindNewVoter(ctx);
    const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Vampiro" });
    expect(entry.claimCode).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.label).toBe("Vampiro");

    const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, contestant.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
    expect(claimed.confirmationCode).toMatch(/^[0-9A-F]{8}$/);

    const participant = (await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId))[0];
    const hostView = JSON.stringify(await readCommunityVotingPreparation(ctx.repo, hostOf(ctx)));
    for (const secret of [entry.claimCode, claimed.confirmationCode, contestant.authUserId, contestant.binding.bindingId, contestant.token, participant.displayName, participant.participantId, participant.participantToken]) {
      expect(hostView).not.toContain(secret);
    }
    const [row] = (await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries;
    expect(Object.keys(row).sort()).toEqual(["claimExpiresAt", "claimable", "entryId", "label", "state"]);
    expect(row.state).toBe("PENDING_CONFIRMATION");
  });

  it("validates labels: trimmed, 1..60 characters, unique ignoring case", async () => {
    const ctx = await setupEvent();
    const base = hostOf(ctx);
    for (const bad of ["", "   ", "x".repeat(61), 42 as unknown as string, null as unknown as string]) {
      await expectCode(createCommunityVotingEntry(ctx.repo, { ...base, label: bad }), "ENTRY_LABEL_INVALID");
    }
    const ok = await createCommunityVotingEntry(ctx.repo, { ...base, label: "  Drácula  " });
    expect(ok.label).toBe("Drácula");
    await expectCode(createCommunityVotingEntry(ctx.repo, { ...base, label: "drácula" }), "ENTRY_LABEL_DUPLICATE");
    await expectCode(createCommunityVotingEntry(ctx.repo, { ...base, label: "Ok", claimTtlSeconds: 0 }), "INVALID_REQUEST");
    await expectCode(createCommunityVotingEntry(ctx.repo, { ...base, label: "Ok", claimTtlSeconds: 86401 }), "INVALID_REQUEST");
    expect((await readCommunityVotingPreparation(ctx.repo, base)).entries).toHaveLength(1);
  });

  it("every host operation requires the Session's host authority", async () => {
    const ctx = await setupEvent();
    const wrong = { instanceId: ctx.instance.instanceId, hostToken: "not-the-host" };
    const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
    await expect(createCommunityVotingEntry(ctx.repo, { ...wrong, label: "Dos" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(readCommunityVotingPreparation(ctx.repo, wrong)).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(removeCommunityVotingEntry(ctx.repo, { ...wrong, entryId: entry.entryId })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(confirmCommunityVotingEntry(ctx.repo, { ...wrong, entryId: entry.entryId, confirmationCode: "ABCDEF12" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(startCommunityVoting(ctx.repo, { ...wrong, promptText: "Q" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries).toHaveLength(1);
  });

  describe("the claim: authenticated, single-use, scoped to one entry of one event", () => {
    it("authenticates the claimant and requires a binding to THIS Instance", async () => {
      const ctx = await setupEvent();
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const body = { claimCode: entry.claimCode };
      const id = ctx.instance.instanceId;
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, undefined, id, body), "AUTHENTICATION_REQUIRED");
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, "Bearer forged", id, body), "AUTHENTICATION_REQUIRED");
      const emailOnly = ctx.verifier.issue({ phoneVerified: false });
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, emailOnly.header, id, body), "VERIFIED_PHONE_REQUIRED");
      const unbound = ctx.verifier.issue();
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, unbound.header, id, body), "NOT_BOUND");
      expect(await entryStates(ctx)).toEqual([["Uno", "UNCLAIMED"]]); // none of the failures touched the entry
      for (const bad of [null, "x", {}, { claimCode: 7 }, { claimCode: ["a"] }]) {
        const bound = await bindNewVoter(ctx);
        await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, bound.header, id, bad), "INVALID_REQUEST");
      }
    });

    it("consumes the credential: a second presentation — by anyone — fails closed", async () => {
      const ctx = await setupEvent();
      const a = await bindNewVoter(ctx);
      const b = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const id = ctx.instance.instanceId;
      await claimCommunityVotingEntry(ctx.repo, ctx.verifier, a.header, id, { claimCode: entry.claimCode });
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, b.header, id, { claimCode: entry.claimCode }), "CLAIM_INVALID");
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, a.header, id, { claimCode: entry.claimCode }), "CLAIM_INVALID");
      expect(await entryStates(ctx)).toEqual([["Uno", "PENDING_CONFIRMATION"]]);
    });

    it("fails closed on a wrong, malformed or foreign-event credential, and changes nothing", async () => {
      const ctx = await setupEvent();
      const other = await setupEvent();
      const mine = await bindNewVoter(ctx);
      const theirs = await bindNewVoter(other);
      const myEntry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const theirEntry = await createCommunityVotingEntry(other.repo, { ...hostOf(other), label: "Uno" });
      const id = ctx.instance.instanceId;

      for (const wrong of ["0".repeat(32), "z".repeat(32), "short", myEntry.claimCode.slice(0, 31), `${myEntry.claimCode}0`]) {
        await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, mine.header, id, { claimCode: wrong }), "CLAIM_INVALID");
      }
      // event B's credential, presented to event A by someone bound to event A
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, mine.header, id, { claimCode: theirEntry.claimCode }), "CLAIM_INVALID");
      // event A's credential, presented to event B by someone bound to event B
      await expectCode(claimCommunityVotingEntry(other.repo, other.verifier, theirs.header, other.instance.instanceId, { claimCode: myEntry.claimCode }), "CLAIM_INVALID");
      // a claimant bound only to event B cannot touch event A at all
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, theirs.header, id, { claimCode: myEntry.claimCode }), "AUTHENTICATION_REQUIRED");
      expect(await entryStates(ctx)).toEqual([["Uno", "UNCLAIMED"]]);
      expect(await entryStates(other)).toEqual([["Uno", "UNCLAIMED"]]);
    });

    it("fails closed once the credential has expired", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno", claimTtlSeconds: 60 });
      ctx.clock.t += 59_000;
      expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries[0].claimable).toBe(true);
      ctx.clock.t += 2_000;
      expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries[0].claimable).toBe(false);
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode }), "CLAIM_EXPIRED");
      expect(await entryStates(ctx)).toEqual([["Uno", "UNCLAIMED"]]);
    });

    it("a contestant identity holds exactly ONE entry in this Slice", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const one = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const two = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Dos" });
      const id = ctx.instance.instanceId;
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, id, { claimCode: one.claimCode });
      // while PENDING ...
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, id, { claimCode: two.claimCode }), "CONTESTANT_ALREADY_HAS_ENTRY");
      // ... and after CONFIRMED
      await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: one.entryId, confirmationCode: claimed.confirmationCode });
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, id, { claimCode: two.claimCode }), "CONTESTANT_ALREADY_HAS_ENTRY");
      expect(await entryStates(ctx)).toEqual([["Uno", "CONFIRMED"], ["Dos", "UNCLAIMED"]]);
    });
  });

  describe("the confirmation: the host confirms the intended entry against the claimant's own device", () => {
    it("associates the entry with the claimant's binding only after the matching confirmation code", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
      expect(await entryStates(ctx)).toEqual([["Uno", "PENDING_CONFIRMATION"]]);
      expect(await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode.toLowerCase() })).toEqual({ entryId: entry.entryId, state: "CONFIRMED" });
      expect(await entryStates(ctx)).toEqual([["Uno", "CONFIRMED"]]);
      // confirming again is refused (nothing pending), and the association did not move
      await expectCode(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode }), "CONFIRMATION_NOT_PENDING");
    });

    it("rejects a wrong code, limits attempts, and VOIDS the pending claim when they are exhausted", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
      const confirm = (code: string) => confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: code });
      const wrong = claimed.confirmationCode === "00000000" ? "11111111" : "00000000";
      for (let i = 0; i < 4; i++) await expectCode(confirm(wrong), "CONFIRMATION_REJECTED");
      expect(await entryStates(ctx)).toEqual([["Uno", "PENDING_CONFIRMATION"]]); // still pending after 4 failures
      await expectCode(confirm(wrong), "CLAIM_VOIDED"); // the 5th voids it
      expect(await entryStates(ctx)).toEqual([["Uno", "UNCLAIMED"]]);
      // even the RIGHT code is now useless, and the old claim credential is gone: the host must recreate the entry
      await expectCode(confirm(claimed.confirmationCode), "CONFIRMATION_NOT_PENDING");
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode }), "CLAIM_INVALID");
      expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries[0].claimable).toBe(false);
    });

    it("malformed confirmation input is rejected without counting as an attempt", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
      for (const bad of [undefined, null, 12345678, "", "   "]) {
        await expectCode(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: bad }), "INVALID_REQUEST");
      }
      await expect(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode })).resolves.toMatchObject({ state: "CONFIRMED" });
    });

    it("the confirmation window expires", async () => {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno", claimTtlSeconds: 60 });
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
      ctx.clock.t += 61_000;
      await expectCode(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode }), "CLAIM_EXPIRED");
      expect(await entryStates(ctx)).toEqual([["Uno", "PENDING_CONFIRMATION"]]);
    });

    it("an unknown or foreign entry is not found", async () => {
      const ctx = await setupEvent();
      const other = await setupEvent();
      const foreign = await createCommunityVotingEntry(other.repo, { ...hostOf(other), label: "Uno" });
      for (const entryId of ["00000000-0000-4000-8000-00000000e0e0", foreign.entryId]) {
        await expectCode(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId, confirmationCode: "ABCDEF12" }), "ENTRY_NOT_FOUND");
        await expectCode(removeCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId }), "ENTRY_NOT_FOUND");
      }
      expect(await entryStates(other)).toEqual([["Uno", "UNCLAIMED"]]); // the other event's entry was untouched
    });

    it("a voter who obtains the claim code first cannot be mistaken for the contestant: the host simply does not confirm, and recreates the entry", async () => {
      const ctx = await setupEvent();
      const intended = await bindNewVoter(ctx);
      const thief = await bindNewVoter(ctx);
      const first = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const id = ctx.instance.instanceId;

      const stolen = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, thief.header, id, { claimCode: first.claimCode });
      await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, intended.header, id, { claimCode: first.claimCode }), "CLAIM_INVALID");
      expect(stolen.confirmationCode).toMatch(/^[0-9A-F]{8}$/);
      // The host looks at the person in front of them: the code on THAT phone is not the thief's. Nothing is confirmed.
      await removeCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: first.entryId });
      const second = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, intended.header, id, { claimCode: second.claimCode });
      await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: second.entryId, confirmationCode: claimed.confirmationCode });

      // the thief's old pending claim is gone with the old entry; the intended contestant owns the entry
      await prepareContestants(ctx, ["Dos"]);
      const ballot = await startBallot(ctx);
      const owner = ballot.candidates.find((c) => c.label === "Uno")!.participantId;
      expect(owner).toBe(ctx.repo.testParticipantIdForBinding(intended.binding.bindingId));
      expect(owner).not.toBe(ctx.repo.testParticipantIdForBinding(thief.binding.bindingId));
    });
  });

  it("the host can remove and recreate an entry while preparing", async () => {
    const ctx = await setupEvent();
    const voter = await bindNewVoter(ctx);
    const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
    await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
    await removeCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId });
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries).toHaveLength(0);
    // the removal freed the contestant: they may claim a fresh entry
    const again = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
    await expect(claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: again.claimCode })).resolves.toBeDefined();
  });

  it("shows a voter only their OWN entry — label and state — and never a claim or confirmation secret", async () => {
    const ctx = await setupEvent();
    const mine = await bindNewVoter(ctx);
    const other = await bindNewVoter(ctx);
    expect((await status(ctx, mine)).myEntry).toBeNull();
    const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Vampiro" });
    const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, mine.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
    expect((await status(ctx, mine)).myEntry).toEqual({ label: "Vampiro", state: "PENDING_CONFIRMATION" });
    expect((await status(ctx, other)).myEntry).toBeNull();
    await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    expect((await status(ctx, mine)).myEntry).toEqual({ label: "Vampiro", state: "CONFIRMED" });
    const text = JSON.stringify(await status(ctx, mine));
    expect(text).not.toContain(entry.claimCode);
    expect(text).not.toContain(claimed.confirmationCode);
  });

  it("never lets a claim credential or confirmation code reach an event, a stored snapshot (only digests), or a log line", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const ctx = await setupEvent();
      const voter = await bindNewVoter(ctx);
      const entry = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Uno" });
      await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: "f".repeat(32) }).catch(() => {});
      const claimed = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, { claimCode: entry.claimCode });
      await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: "FFFFFFFF" }).catch(() => {});
      await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
      const stored = JSON.stringify({
        events: (ctx.sessionRepo as unknown as { events: unknown[] }).events,
        community: ctx.repo.testSnapshot(),
        logs: spies.flatMap((s) => s.mock.calls),
      });
      expect(stored).not.toContain(entry.claimCode);
      expect(stored).not.toContain(claimed.confirmationCode);
      expect(stored).not.toContain("f".repeat(32));
      // the stored entry carries digests, not secrets
      const [stored0] = ctx.repo.testSnapshot().entries as unknown as Array<Record<string, unknown>>;
      expect(JSON.stringify(stored0)).not.toMatch(/claimCode"|confirmationCode"/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------- the explicit, atomic start

describe("Atomic Community Voting start", () => {
  it("opens Voting in ONE step: attributed candidates, PROMPT_ACTIVE, exactly one INTERACTION_STARTED — and nothing before it", async () => {
    const ctx = await setupEvent();
    const contestants = await prepareContestants(ctx, ["Uno", "Dos", "Tres"]);
    const startedEventsBefore = (ctx.sessionRepo as unknown as { events: Array<{ eventType: string }> }).events.filter((e) => e.eventType === "INTERACTION_STARTED");
    expect(startedEventsBefore).toHaveLength(0);

    const ballot = await startBallot(ctx, "  Mejor disfraz  ");
    expect(ballot.started).toMatchObject({ state: "PROMPT_ACTIVE", candidateCount: 3, segmentNumber: 1 });

    const interactions = await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ state: "PROMPT_ACTIVE", engineType: "VOTING", interactionInstanceId: ballot.interactionInstanceId });
    expect((await ctx.sessionRepo.getSessionById(ctx.session.sessionId))!.state).toBe("LOBBY_LOCKED");
    const events = (ctx.sessionRepo as unknown as { events: Array<{ eventType: string; payload: Record<string, unknown> }> }).events.filter((e) => e.eventType === "INTERACTION_STARTED");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ interactionInstanceId: ballot.interactionInstanceId, engineType: "VOTING" });

    // candidate i is exactly contestant i, by the entry order; labels are the entries'
    expect(ballot.candidates.map((c) => c.label)).toEqual(["Uno", "Dos", "Tres"]);
    expect(ballot.candidates.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(ballot.candidates.map((c) => c.participantId)).toEqual(contestants.map((c) => ctx.repo.testParticipantIdForBinding(c.binding.bindingId)));
    // Voting owns the prompt
    const prompt = await ctx.sessionRepo.getPromptById(interactions[0].promptId);
    expect(prompt!.text).toBe("Mejor disfraz");
  });

  it("every active candidate carries a contestant: an open ballot is never partly attributed", async () => {
    const { ctx, voting } = await preparedEvent();
    const rows = await ctx.sessionRepo.getVotingCandidatesForInteraction(voting.interactionInstanceId);
    expect(rows.every((r) => typeof r.participantId === "string" && r.participantId.length > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.participantId)).size).toBe(rows.length);
  });

  it("refuses to start — leaving nothing behind — unless every precondition holds", async () => {
    const ctx = await setupEvent();
    const watcher = await bindNewVoter(ctx);
    const noInteraction = async () => {
      expect(await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId)).toHaveLength(0);
      expect((ctx.sessionRepo as unknown as { votingCandidates: Map<string, unknown> }).votingCandidates.size).toBe(0);
      expect((await status(ctx, watcher)).phase).toBe("NOT_OPEN");
    };
    const start = () => startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Mejor disfraz" });

    // lobby not locked yet
    await prepareContestants(ctx, ["Uno", "Dos"]);
    await expectCode(start(), "SESSION_NOT_STARTABLE");
    await noInteraction();
    await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);

    // a prompt must be real text
    for (const bad of ["", "   ", undefined, 5, "q".repeat(1001)]) {
      await expectCode(startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: bad }), "INVALID_REQUEST");
    }
    await noInteraction();

    // an unclaimed, a pending and a missing association each block the start
    const unclaimed = await createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Tres" });
    await expectCode(start(), "PREPARATION_INCOMPLETE");
    const lateContestant = await bindNewVoter(ctx);
    const pending = await claimCommunityVotingEntry(ctx.repo, ctx.verifier, lateContestant.header, ctx.instance.instanceId, { claimCode: unclaimed.claimCode });
    await expectCode(start(), "PREPARATION_INCOMPLETE");
    await noInteraction();
    await confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: unclaimed.entryId, confirmationCode: pending.confirmationCode });

    // ... and then, with nothing left to fix, the very same ballot starts
    const started = await start();
    expect(started.candidateCount).toBe(3);
  });

  it("needs at least two entries", async () => {
    const ctx = await setupEvent();
    await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    await expectCode(startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Q" }), "PREPARATION_INCOMPLETE");
    await prepareContestants(ctx, ["Solo"]);
    await expectCode(startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Q" }), "PREPARATION_INCOMPLETE");
    expect(await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId)).toHaveLength(0);
  });

  it("refuses a Session whose capability set is no longer exactly VOTING", async () => {
    const ctx = await setupEvent();
    await prepareContestants(ctx, ["Uno", "Dos"]);
    // capabilities are locked once a Participant exists, so a widened set can only be simulated at the record level
    (await ctx.sessionRepo.getSessionById(ctx.session.sessionId));
    (ctx.sessionRepo as unknown as { sessions: Map<string, { declaredCapabilities: string[] }> }).sessions.get(ctx.session.sessionId)!.declaredCapabilities = ["OPEN_RESPONSE", "VOTING"];
    await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    await expectCode(startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Q" }), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
    expect(await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId)).toHaveLength(0);
  });

  it("a second start is refused and the first ballot is untouched", async () => {
    const { ctx, voting } = await preparedEvent();
    const before = JSON.stringify(await ctx.sessionRepo.getVotingCandidatesForInteraction(voting.interactionInstanceId));
    await expectCode(startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Otra" }), "ALREADY_OPENED");
    expect(await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId)).toHaveLength(1);
    expect(JSON.stringify(await ctx.sessionRepo.getVotingCandidatesForInteraction(voting.interactionInstanceId))).toBe(before);
  });

  it("concurrent starts create exactly one interaction and one ballot", async () => {
    const ctx = await setupEvent();
    await prepareContestants(ctx, ["Uno", "Dos", "Tres"]);
    await lockLobby(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => startCommunityVoting(ctx.repo, { ...hostOf(ctx), promptText: "Q" })));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const o of outcomes) if (o.status === "rejected") expect((o.reason as CommunityVotingError).code).toBe("ALREADY_OPENED");
    const interactions = await ctx.sessionRepo.getInteractionInstancesForSession(ctx.session.sessionId);
    expect(interactions).toHaveLength(1);
    expect(await ctx.sessionRepo.getVotingCandidatesForInteraction(interactions[0].interactionInstanceId)).toHaveLength(3);
  });

  it("after opening, every preparation operation fails closed and no association can change", async () => {
    const { ctx, voting, contestants } = await preparedEvent();
    const attributionBefore = JSON.stringify((await ctx.sessionRepo.getVotingCandidatesForInteraction(voting.interactionInstanceId)).map((c) => [c.candidateId, c.participantId]));
    const [first] = (await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries;
    const stranger = await bindNewVoter(ctx);

    await expectCode(createCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), label: "Tarde" }), "PREPARATION_CLOSED");
    await expectCode(removeCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: first.entryId }), "PREPARATION_CLOSED");
    await expectCode(confirmCommunityVotingEntry(ctx.repo, { ...hostOf(ctx), entryId: first.entryId, confirmationCode: "ABCDEF12" }), "PREPARATION_CLOSED");
    await expectCode(claimCommunityVotingEntry(ctx.repo, ctx.verifier, stranger.header, ctx.instance.instanceId, { claimCode: "a".repeat(32) }), "PREPARATION_CLOSED");
    // reading remains possible; nothing moved
    expect((await readCommunityVotingPreparation(ctx.repo, hostOf(ctx))).entries.map((e) => e.state)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
    expect(JSON.stringify((await ctx.sessionRepo.getVotingCandidatesForInteraction(voting.interactionInstanceId)).map((c) => [c.candidateId, c.participantId]))).toBe(attributionBefore);
    expect(contestants).toHaveLength(3);
  });

  it("voting works immediately after the start, with no further step", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    expect((await status(ctx, voter)).phase).toBe("OPEN");
    const { intentNo } = await issue(ctx, voter);
    await expect(cast(ctx, voter, voting, voting.candidates[0].candidateId, intentNo)).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  it("the existing Voting self-vote enforcement uses the final participant: a contestant cannot vote for their own entry", async () => {
    const { ctx, voting, contestants } = await preparedEvent();
    const owner = contestants[0];
    await issue(ctx, owner);
    await expect(cast(ctx, owner, voting, voting.candidates[0].candidateId, 1)).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
    expect(voteCastEvents(ctx)).toHaveLength(0);
    expect((await status(ctx, owner)).intents).toEqual({ issued: 1, applied: 0 }); // the rejection consumed nothing
    // other contestants' entries are fair game, and the owner may vote for them with the SAME intent
    await expect(cast(ctx, owner, voting, voting.candidates[1].candidateId, 1)).resolves.toMatchObject({ outcome: "APPLIED" });
  });
});

// ---------------------------------------------------------------- the superseded behaviour is gone

describe("The superseded 'attribution while open' behaviour is removed", () => {
  const root = path.resolve(__dirname, "..");
  const exists = (rel: string) => {
    try {
      statSync(path.join(root, rel));
      return true;
    } catch {
      return false;
    }
  };

  it("has no attribution operation, route, domain function or repository method left", () => {
    expect(exists("lib/gaming/communityVoting/attributeContestant.ts")).toBe(false);
    expect(exists("app/api/gaming/community-voting/instances/[instanceId]/contestants")).toBe(false);
    const proto = Object.getOwnPropertyNames(InMemoryCommunityVotingRepository.prototype);
    expect(proto).not.toContain("attributeContestant");
    expect(proto).toEqual(expect.arrayContaining(["createEntry", "removeEntry", "readPreparation", "claimEntry", "confirmEntry", "startVoting", "castVote", "readVoterStatus"]));
  });

  it("no Community Voting source or migration still speaks of PREPARING, VOTING_NOT_PREPARED, preparationComplete or attribution while open", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(path.join(root, "lib/gaming/communityVoting"));
    walk(path.join(root, "app/api/gaming/community-voting"));
    for (const name of readdirSync(path.join(root, "supabase/migrations"))) {
      if (name.startsWith("202610201")) files.push(path.join(root, "supabase/migrations", name));
    }
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /PREPARING|VOTING_NOT_PREPARED|preparationComplete|preparation_complete|attribute_community_voting_contestant|attributeCommunityVotingContestant|ATTRIBUTION_CLOSED/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

// ---------------------------------------------------------------- intents, replay, ordering

describe("Server-controlled intent ordering with payload-bound idempotency", () => {
  it("issues strictly increasing intents scoped to the caller's own binding", async () => {
    const { ctx, voter, contestants } = await preparedEvent();
    const a = await issue(ctx, voter);
    const b = await issue(ctx, voter);
    const c = await issue(ctx, voter);
    expect([a.intentNo, b.intentNo, c.intentNo]).toEqual([1, 2, 3]);
    expect(a.bindingId).toBe(voter.binding.bindingId);
    // Another voter's counter is independent.
    expect((await issue(ctx, contestants[0])).intentNo).toBe(1);
  });

  it("applies a first vote through the existing Voting store and returns the authoritative result", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    const { intentNo } = await issue(ctx, voter);
    const result = await cast(ctx, voter, voting, voting.candidates[1].candidateId, intentNo);
    expect(result).toMatchObject({
      outcome: "APPLIED",
      bindingId: voter.binding.bindingId,
      intentNo: 1,
      interactionInstanceId: voting.interactionInstanceId,
      candidateId: voting.candidates[1].candidateId,
    });
    const votes = await ctx.sessionRepo.getVotesForInteractionInstance(voting.interactionInstanceId);
    expect(votes).toHaveLength(1);
    expect(votes[0].candidateId).toBe(voting.candidates[1].candidateId);
    expect(result.voteUpdatedAt).toBe(votes[0].updatedAt);
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("rejects an unissued intent and a malformed one", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 2), "INTENT_UNISSUED");
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 999), "INTENT_UNISSUED");
    for (const bad of [0, -1, 1.5, Number.NaN, "1" as unknown as number]) {
      await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, bad), "INVALID_REQUEST");
    }
    expect(voteCastEvents(ctx)).toHaveLength(0);
  });

  it("rejects an intent presented against another voter's binding", async () => {
    const { ctx, voting, voter, contestants } = await preparedEvent();
    await issue(ctx, voter);
    await issue(ctx, contestants[0]);
    // The voter authenticates as themselves but names the contestant's binding.
    await expectCode(
      castCommunityVote(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, {
        bindingId: contestants[0].binding.bindingId,
        intentNo: 1,
        interactionInstanceId: voting.interactionInstanceId,
        candidateId: voting.candidates[1].candidateId,
        location: INSIDE,
      }),
      "INTENT_BINDING_MISMATCH"
    );
    expect(voteCastEvents(ctx)).toHaveLength(0);
  });

  it("replaying the same committed intent returns its authoritative result and writes nothing", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    const first = await cast(ctx, voter, voting, voting.candidates[2].candidateId, 1);
    const replay = await cast(ctx, voter, voting, voting.candidates[2].candidateId, 1);
    expect(replay).toMatchObject({ outcome: "REPLAYED", intentNo: 1, candidateId: first.candidateId, voteUpdatedAt: first.voteUpdatedAt });
    expect(voteCastEvents(ctx)).toHaveLength(1);
    expect((await ctx.sessionRepo.getVotesForInteractionInstance(voting.interactionInstanceId))).toHaveLength(1);
  });

  it("a replay does not need a fresh (or any acceptable) location — it re-evaluates nothing", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE);
    await expect(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, OUTSIDE)).resolves.toMatchObject({ outcome: "REPLAYED" });
  });

  it("reusing an applied intent with another payload is a conflict that exposes only the caller's own state", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    const err = await expectCode(cast(ctx, voter, voting, voting.candidates[1].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
    expect(err.current).toMatchObject({ myCandidateId: voting.candidates[0].candidateId, appliedIntentNo: 1 });
    // The payload commitment covers the Voting interaction too.
    const err2 = await expectCode(
      castCommunityVote(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, {
        bindingId: voter.binding.bindingId,
        intentNo: 1,
        interactionInstanceId: "00000000-0000-4000-8000-0000000000f1",
        candidateId: voting.candidates[0].candidateId,
        location: INSIDE,
      }),
      "INTENT_PAYLOAD_MISMATCH"
    );
    expect(err2.current?.appliedIntentNo).toBe(1);
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("a revision with a newer intent replaces the vote while voting is open", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    await issue(ctx, voter);
    const revised = await cast(ctx, voter, voting, voting.candidates[1].candidateId, 2);
    expect(revised).toMatchObject({ outcome: "APPLIED", intentNo: 2, candidateId: voting.candidates[1].candidateId });
    const votes = await ctx.sessionRepo.getVotesForInteractionInstance(voting.interactionInstanceId);
    expect(votes).toHaveLength(1);
    expect(votes[0].candidateId).toBe(voting.candidates[1].candidateId);
    expect(voteCastEvents(ctx)).toHaveLength(2);
  });

  it("an older intent can never overwrite a newer applied one", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter); // 1
    await issue(ctx, voter); // 2
    await issue(ctx, voter); // 3
    await cast(ctx, voter, voting, voting.candidates[1].candidateId, 3);
    const err = await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 2), "STALE_INTENT");
    expect(err.current).toMatchObject({ myCandidateId: voting.candidates[1].candidateId, appliedIntentNo: 3 });
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1), "STALE_INTENT");
    expect((await status(ctx, voter)).myCandidateId).toBe(voting.candidates[1].candidateId);
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("an intent that failed (e.g. outside the venue) is NOT consumed and can be retried", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, OUTSIDE), "LOCATION_OUTSIDE");
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, AMBIGUOUS), "LOCATION_AMBIGUOUS");
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, northOfVenue(1, 51)), "LOCATION_ACCURACY_EXCESSIVE");
    expect((await status(ctx, voter)).intents).toEqual({ issued: 1, applied: 0 });
    expect(voteCastEvents(ctx)).toHaveLength(0);
    await expect(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE)).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  describe("no-op reselection (explicit semantics)", () => {
    it("CONSUMES the intent but performs NO Voting transition", async () => {
      const { ctx, voting, voter } = await preparedEvent();
      await issue(ctx, voter);
      const first = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
      await issue(ctx, voter);
      const noop = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 2);
      expect(noop).toMatchObject({ outcome: "UNCHANGED", intentNo: 2, candidateId: voting.candidates[0].candidateId });
      // no new Voting transition: one VOTE_CAST event, vote row untouched
      expect(voteCastEvents(ctx)).toHaveLength(1);
      expect(noop.voteUpdatedAt).toBe(first.voteUpdatedAt);
      expect((await status(ctx, voter)).intents).toEqual({ issued: 2, applied: 2 });
    });

    it("still supersedes older intents (an older intent is stale after a no-op consumed a newer one)", async () => {
      const { ctx, voting, voter } = await preparedEvent();
      await issue(ctx, voter); // 1
      await issue(ctx, voter); // 2
      await issue(ctx, voter); // 3
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 3); // no-op, consumes 3
      await expectCode(cast(ctx, voter, voting, voting.candidates[2].candidateId, 2), "STALE_INTENT");
      expect((await status(ctx, voter)).myCandidateId).toBe(voting.candidates[0].candidateId);
    });

    it("is itself replayable and payload-bound", async () => {
      const { ctx, voting, voter } = await preparedEvent();
      await issue(ctx, voter);
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
      await issue(ctx, voter);
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 2);
      await expect(cast(ctx, voter, voting, voting.candidates[0].candidateId, 2)).resolves.toMatchObject({ outcome: "REPLAYED" });
      await expectCode(cast(ctx, voter, voting, voting.candidates[1].candidateId, 2), "INTENT_PAYLOAD_MISMATCH");
    });

    it("still requires an acceptable location (a consumed intent is a state change)", async () => {
      const { ctx, voting, voter } = await preparedEvent();
      await issue(ctx, voter);
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
      await issue(ctx, voter);
      await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 2, OUTSIDE), "LOCATION_OUTSIDE");
      expect((await status(ctx, voter)).intents).toEqual({ issued: 2, applied: 1 });
    });
  });

  it("two devices racing: the older intent never overwrites the newer, whatever the arrival order", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter); // device A holds 1
    await issue(ctx, voter); // device B holds 2 (the newer intent)
    const results = await Promise.allSettled([
      cast(ctx, voter, voting, voting.candidates[1].candidateId, 2), // newer arrives first
      cast(ctx, voter, voting, voting.candidates[0].candidateId, 1), // older arrives second
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(((results[1] as PromiseRejectedResult).reason as CommunityVotingError).code).toBe("STALE_INTENT");
    expect((await status(ctx, voter)).myCandidateId).toBe(voting.candidates[1].candidateId);
  });

  it("two devices racing with the SAME intent number: one applies, the other gets a coherent replay or conflict", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    const [a, b] = await Promise.allSettled([
      cast(ctx, voter, voting, voting.candidates[0].candidateId, 1),
      cast(ctx, voter, voting, voting.candidates[1].candidateId, 1),
    ]);
    expect(a.status).toBe("fulfilled");
    expect((a as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe("APPLIED");
    expect(b.status).toBe("rejected");
    expect(((b as PromiseRejectedResult).reason as CommunityVotingError).code).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("rejects a candidate that is not in the stated interaction, or a stated interaction that is not current", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await expect(
      cast(ctx, voter, voting, "00000000-0000-4000-8000-0000000000c9", 1)
    ).rejects.toBeDefined();
    await expectCode(
      castCommunityVote(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, {
        bindingId: voter.binding.bindingId,
        intentNo: 1,
        interactionInstanceId: "00000000-0000-4000-8000-0000000000f2",
        candidateId: voting.candidates[0].candidateId,
        location: INSIDE,
      }),
      "INTERACTION_MISMATCH"
    );
    expect(voteCastEvents(ctx)).toHaveLength(0);
  });

  it("the client eligibility claim is ignored — only the server's own evaluation counts", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await expectCode(
      castCommunityVote(ctx.repo, ctx.verifier, voter.header, ctx.instance.instanceId, {
        bindingId: voter.binding.bindingId,
        intentNo: 1,
        interactionInstanceId: voting.interactionInstanceId,
        candidateId: voting.candidates[0].candidateId,
        location: OUTSIDE,
        eligible: true,
        outcome: "INSIDE",
        locationDecision: "INSIDE",
      }),
      "LOCATION_OUTSIDE"
    );
  });
});

// ---------------------------------------------------------------- lifecycle: close, reveal, recovery

describe("Intent recovery truth table", () => {
  it("answers every presented intent with exactly one of: not issued / replayed / payload conflict / stale / a new attempt", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    const [A, B, C] = voting.candidates.map((c) => c.candidateId);
    for (let i = 0; i < 6; i++) await issue(ctx, voter); // intents 1..6 issued

    // row: n > issued
    await expectCode(cast(ctx, voter, voting, A, 7), "INTENT_UNISSUED");
    // row: a NEW attempt (n > applied) — applied for real
    expect(await cast(ctx, voter, voting, A, 2)).toMatchObject({ outcome: "APPLIED", intentNo: 2, candidateId: A });
    // row: n == applied, same payload  -> replayed (the genuinely committed intent)
    expect(await cast(ctx, voter, voting, A, 2)).toMatchObject({ outcome: "REPLAYED", intentNo: 2, candidateId: A });
    // row: n == applied, different payload -> conflict, and it says the intent WAS applied, with another payload
    const clash = await expectCode(cast(ctx, voter, voting, B, 2), "INTENT_PAYLOAD_MISMATCH");
    expect(clash.intentOutcome).toBe("APPLIED_WITH_DIFFERENT_PAYLOAD");
    expect(clash.current).toMatchObject({ myCandidateId: A, appliedIntentNo: 2 });

    // a newer vote supersedes it
    expect(await cast(ctx, voter, voting, C, 5)).toMatchObject({ outcome: "APPLIED", intentNo: 5, candidateId: C });

    // row: n < applied. The server keeps only the LAST applied intent, so it cannot say what intents 1..4 did:
    //      intent 2 WAS applied once (to A), intents 1, 3 and 4 never were. The answers must be identical, and
    //      neither may claim success or the current candidate for them.
    const oldApplied = await expectCode(cast(ctx, voter, voting, A, 2), "STALE_INTENT");
    const oldUnapplied1 = await expectCode(cast(ctx, voter, voting, A, 1), "STALE_INTENT");
    const oldUnapplied3 = await expectCode(cast(ctx, voter, voting, C, 3), "STALE_INTENT"); // even naming the CURRENT candidate
    for (const e of [oldApplied, oldUnapplied1, oldUnapplied3]) {
      expect(e.intentOutcome).toBe("HISTORICAL_OUTCOME_UNAVAILABLE");
      expect(e.current).toMatchObject({ myCandidateId: C, appliedIntentNo: 5, issuedIntentNo: 6 });
    }
    expect(JSON.stringify(communityVotingErrorBody(oldApplied))).toBe(JSON.stringify(communityVotingErrorBody(oldUnapplied1)));
    expect(JSON.stringify(communityVotingErrorBody(oldUnapplied1))).toBe(JSON.stringify(communityVotingErrorBody(oldUnapplied3)));

    // the authoritative vote and its history were never disturbed by any of the above
    expect((await status(ctx, voter)).myCandidateId).toBe(C);
    expect(voteCastEvents(ctx)).toHaveLength(2);
  });

  it("an UNAPPLIED intent is never reported as applied: a lost response is retried, a failed attempt is retried, neither is replayed", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    // failed attempt: nothing committed -> retrying the same intent is a NEW attempt, not a replay
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, OUTSIDE), "LOCATION_OUTSIDE");
    const retried = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE);
    expect(retried.outcome).toBe("APPLIED");
    // lost response: the SAME committed intent is re-sent -> an explicit REPLAY of what was committed
    const resent = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE);
    expect(resent).toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: retried.voteUpdatedAt });
  });

  it("replay after close confirms only a genuinely committed, matching intent", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter); await issue(ctx, voter);
    const committed = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    // committed + matching -> confirmed
    expect(await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1)).toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: committed.voteUpdatedAt });
    // committed + different payload -> a conflict, not a confirmation
    await expectCode(cast(ctx, voter, voting, voting.candidates[1].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
    // issued but NEVER applied -> not confirmed: voting is closed, so nothing can be reported as applied
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 2), "VOTING_NOT_OPEN");
    expect((await status(ctx, voter)).intents).toEqual({ issued: 2, applied: 1 });
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("a delayed older request cannot overwrite a newer applied intent, from any device", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter); await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[1].candidateId, 2);
    await expectCode(cast(ctx, voter, voting, voting.candidates[0].candidateId, 1), "STALE_INTENT");
    expect((await status(ctx, voter)).myCandidateId).toBe(voting.candidates[1].candidateId);
  });
});

describe("Close, publication and recovery", () => {
  it("never permits a vote or a revision after close, but recovers an already-committed vote", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    const committed = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    await issue(ctx, voter); // intent 2 issued while open ...
    await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);

    // ... but cannot be used after close
    await expectCode(cast(ctx, voter, voting, voting.candidates[1].candidateId, 2), "VOTING_NOT_OPEN");
    await expectCode(issue(ctx, voter), "VOTING_NOT_OPEN");

    // recovery of the committed confirmation after close (a lost response, or a new session)
    expect(await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1)).toMatchObject({
      outcome: "REPLAYED",
      voteUpdatedAt: committed.voteUpdatedAt,
    });
    const s = await status(ctx, voter);
    expect(s).toMatchObject({ bound: true, phase: "CLOSED", myCandidateId: voting.candidates[0].candidateId });
    expect(voteCastEvents(ctx)).toHaveLength(1);
  });

  it("a replay of the committed intent with a different payload after close is still a conflict", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    await expectCode(cast(ctx, voter, voting, voting.candidates[1].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
  });

  it("totals stay hidden until the Session reveals, and respect the Session's reveal gate", async () => {
    const { ctx, voting, voter, contestants } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    await issue(ctx, contestants[1]);
    await cast(ctx, contestants[1], voting, voting.candidates[0].candidateId, 1);

    expect((await status(ctx, voter)).results).toBeNull(); // PROMPT_ACTIVE
    await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    expect((await status(ctx, voter)).results).toBeNull(); // CLOSED, not yet revealed

    await revealResults(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    const published = await status(ctx, voter);
    expect(published.phase).toBe("PUBLISHED");
    expect(published.results).not.toBeNull();
    const top = published.results!.find((r) => r.candidateId === voting.candidates[0].candidateId)!;
    expect(top).toMatchObject({ voteCount: 2, rank: 1 });

    // Like GET_SESSION, results are not extended past SESSION_COMPLETE.
    await completeSession(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    const ended = await status(ctx, voter);
    expect(ended.phase).toBe("ENDED");
    expect(ended.results).toBeNull();
    expect(ended.myCandidateId).toBe(voting.candidates[0].candidateId);
  });

  it("recovers the same state for the same Auth user on a new authenticated session", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[2].candidateId, 1);
    // A brand-new access token for the SAME Auth user (new device / refreshed session).
    const newToken = "fake-access-token-second-device";
    (ctx.verifier as unknown as { identities: Map<string, unknown> }).identities.set(newToken, { authUserId: voter.authUserId, phoneVerified: true });
    const recovered = await getCommunityVotingStatus(ctx.repo, ctx.sessionRepo, ctx.verifier, `Bearer ${newToken}`, ctx.instance.instanceId);
    expect(recovered).toMatchObject({
      bound: true,
      bindingId: voter.binding.bindingId,
      myCandidateId: voting.candidates[2].candidateId,
      intents: { issued: 1, applied: 1 },
      phase: "OPEN",
    });
    const rebound = await bindCommunityVotingVoter(ctx.repo, ctx.verifier, `Bearer ${newToken}`, ctx.instance.instanceId);
    expect(rebound).toMatchObject({ bindingId: voter.binding.bindingId, created: false });
  });

  it("status for an unbound caller reveals nothing", async () => {
    const ctx = await setupEvent();
    const stranger = ctx.verifier.issue();
    expect(await getCommunityVotingStatus(ctx.repo, ctx.sessionRepo, ctx.verifier, stranger.header, ctx.instance.instanceId)).toEqual({
      bound: false,
      instanceId: ctx.instance.instanceId,
      phase: null,
      interactionInstanceId: null,
      candidates: null,
      myCandidateId: null,
      myEntry: null,
      intents: null,
      bindingId: null,
      results: null,
    });
  });

  it("derives open / closed / published / ended from the Session and Voting only — there is no preparation phase", async () => {
    const ctx = await setupEvent();
    const voter = await bindNewVoter(ctx);
    expect((await status(ctx, voter)).phase).toBe("NOT_OPEN");
    // Even a complete, confirmed ballot is NOT_OPEN: preparation is not an opening.
    await prepareContestants(ctx, ["Uno", "Dos"]);
    const prepared = await status(ctx, voter);
    expect(prepared.phase).toBe("NOT_OPEN");
    expect(prepared.candidates).toBeNull();
    const ballot = await startBallot(ctx);
    const opened = await status(ctx, voter);
    expect(opened.phase).toBe("OPEN");
    expect(opened.candidates!.map((c) => c.label)).toEqual(["Uno", "Dos"]);
    expect(ballot.candidates).toHaveLength(2);
    await closeSubmissions(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    expect((await status(ctx, voter)).phase).toBe("CLOSED");
    await revealResults(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    expect((await status(ctx, voter)).phase).toBe("PUBLISHED");
    await completeSession(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    expect((await status(ctx, voter)).phase).toBe("ENDED");
    // the superseded phase is not part of the contract at all
    const phases = JSON.stringify([prepared.phase, opened.phase]);
    expect(phases).not.toContain("PREPARING");
  });
});

// ---------------------------------------------------------------- rollback

describe("Rollback", () => {
  it("a Voting rejection (self-vote) leaves no partial intent application and no misleading confirmation", async () => {
    const { ctx, voting, contestants } = await preparedEvent();
    const owner = contestants[2];
    await issue(ctx, owner);
    await expect(cast(ctx, owner, voting, voting.candidates[2].candidateId, 1)).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
    const snapshot = ctx.repo.testSnapshot();
    const binding = (snapshot.bindings as unknown as Array<Record<string, unknown>>).find((b) => b.bindingId === owner.binding.bindingId)!;
    expect(binding).toMatchObject({ issuedIntentNo: 1, appliedIntentNo: 0, appliedPayloadDigest: null });
    expect(await ctx.sessionRepo.getVotesForInteractionInstance(voting.interactionInstanceId)).toHaveLength(0);
    expect(voteCastEvents(ctx)).toHaveLength(0);
    expect((await status(ctx, owner)).myCandidateId).toBeNull();
  });
});

// ---------------------------------------------------------------- privacy

describe("Token, identity and location privacy", () => {
  it("never exposes Participant tokens, labels, ids, Auth ids or coordinates through any caller-visible result", async () => {
    const { ctx, voting, voter, contestants } = await preparedEvent();
    const participants = await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId);
    const secrets = [
      ...participants.map((p) => p.participantToken),
      ...participants.map((p) => p.displayName),
      ...participants.map((p) => p.participantId),
      voter.authUserId,
      ...contestants.map((c) => c.authUserId),
    ];

    const issued = await issue(ctx, voter);
    const castResult = await cast(ctx, voter, voting, voting.candidates[0].candidateId, issued.intentNo);
    const replay = await cast(ctx, voter, voting, voting.candidates[0].candidateId, issued.intentNo);
    await issue(ctx, voter);
    const noop = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 2);
    const visible = JSON.stringify({
      bind: voter.binding,
      issued,
      castResult,
      replay,
      noop,
      status: await status(ctx, voter),
      statusOfContestant: await status(ctx, contestants[0]),
    });
    for (const secret of secrets) expect(visible).not.toContain(secret);
    // No other voter's selection or identity: the response keys are a closed set.
    expect(Object.keys(castResult).sort()).toEqual(["bindingId", "candidateId", "intentNo", "interactionInstanceId", "outcome", "voteUpdatedAt"]);
    expect(Object.keys(voter.binding).sort()).toEqual(["bindingId", "created", "instanceId"]);
  });

  it("the host's GET_SESSION view contains no Auth identity, no token and no per-voter selection", async () => {
    const { ctx, voting, voter, contestants } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1);
    const host = await getSession(ctx.sessionRepo, ctx.session.sessionId, ctx.session.hostToken);
    const text = JSON.stringify(host);
    for (const who of [voter, ...contestants]) {
      expect(text).not.toContain(who.authUserId);
      expect(text).not.toContain(who.token);
    }
    for (const p of await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)) {
      expect(text).not.toContain(p.participantToken);
    }
    expect(host.myVoteCandidateId).toBeNull();
    expect(host.votingResults).toBeNull(); // hidden until reveal
  });

  it("no Session event and no Instance state ever contains a token, an Auth id or a coordinate", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE);
    await issue(ctx, voter);
    await cast(ctx, voter, voting, voting.candidates[0].candidateId, 2, INSIDE);
    const sessionEvents = JSON.stringify((ctx.sessionRepo as unknown as { events: unknown[] }).events);
    const community = JSON.stringify(ctx.repo.testSnapshot());
    for (const p of await ctx.sessionRepo.getParticipantsForSession(ctx.session.sessionId)) {
      expect(sessionEvents).not.toContain(p.participantToken);
      expect(community).not.toContain(p.participantToken);
    }
    // The binding IS the Auth-identity link, so the Instance's own state may name the Auth user —
    // but no Session event may: events carry the opaque Participant only.
    expect(sessionEvents).not.toContain(voter.authUserId);
    expect(community).toContain(voter.authUserId);
    for (const text of [sessionEvents, community]) {
      expect(text).not.toContain(String(INSIDE.latitude));
      expect(text).not.toContain(String(INSIDE.longitude));
      expect(text).not.toContain(String(INSIDE.latitude).slice(0, 10));
    }
  });

  it("never writes a coordinate to the console during a full flow (including rejected readings)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { ctx, voting, voter } = await preparedEvent();
      await issue(ctx, voter);
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, OUTSIDE).catch(() => {});
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, { latitude: 91.234567, longitude: -87.654321, accuracyMeters: 5 }).catch(() => {});
      await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, INSIDE);
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(String(OUTSIDE.latitude).slice(0, 9));
      expect(logged).not.toContain("91.234567");
      expect(logged).not.toContain(String(INSIDE.latitude).slice(0, 9));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("rejection errors from a cast never carry the submitted coordinates", async () => {
    const { ctx, voting, voter } = await preparedEvent();
    await issue(ctx, voter);
    for (const reading of [OUTSIDE, AMBIGUOUS, { latitude: 91.234567, longitude: -87.654321, accuracyMeters: 5 }]) {
      const err = await cast(ctx, voter, voting, voting.candidates[0].candidateId, 1, reading).then(() => null, (e: unknown) => e as Error);
      const text = `${err?.message} ${err?.stack ?? ""} ${JSON.stringify(communityVotingErrorBody(err))}`;
      expect(text).not.toContain(String(reading.latitude).slice(0, 9));
      expect(text).not.toContain(String(reading.longitude).slice(0, 9));
    }
  });
});

// ---------------------------------------------------------------- HTTP contract

describe("HTTP error contract", () => {
  it.each([
    ["AUTHENTICATION_REQUIRED", 401],
    ["VERIFIED_PHONE_REQUIRED", 403],
    ["INVALID_REQUEST", 400],
    ["INVALID_GEOFENCE_CONFIG", 400],
    ["INSTANCE_NOT_FOUND", 404],
    ["NOT_BOUND", 404],
    ["INSTANCE_ALREADY_REGISTERED", 409],
    ["PARTICIPANTS_ALREADY_EXIST", 409],
    ["CAPABILITY_SET_NOT_EXACTLY_VOTING", 409],
    ["SESSION_NOT_REGISTRABLE", 409],
    ["ADMISSION_CLOSED", 409],
    ["VOTING_NOT_OPEN", 409],
    ["PREPARATION_CLOSED", 409],
    ["PREPARATION_INCOMPLETE", 409],
    ["ALREADY_OPENED", 409],
    ["SESSION_NOT_STARTABLE", 409],
    ["ENTRY_NOT_FOUND", 404],
    ["ENTRY_LABEL_INVALID", 400],
    ["ENTRY_LABEL_DUPLICATE", 409],
    ["CLAIM_INVALID", 403],
    ["CLAIM_EXPIRED", 409],
    ["CLAIM_VOIDED", 409],
    ["CONTESTANT_ALREADY_HAS_ENTRY", 409],
    ["CONFIRMATION_NOT_PENDING", 409],
    ["CONFIRMATION_REJECTED", 403],
    ["INTERACTION_MISMATCH", 409],
    ["INTENT_UNISSUED", 400],
    ["INTENT_BINDING_MISMATCH", 403],
    ["INTENT_PAYLOAD_MISMATCH", 409],
    ["STALE_INTENT", 409],
    ["INVALID_LOCATION_READING", 400],
    ["LOCATION_ACCURACY_EXCESSIVE", 400],
    ["LOCATION_OUTSIDE", 403],
    ["LOCATION_AMBIGUOUS", 422],
  ])("%s maps to HTTP %i", (code, httpStatus) => {
    const err = new CommunityVotingError(code as never);
    expect(statusForCommunityVotingError(err)).toEqual({ status: httpStatus, code });
    expect(communityVotingErrorBody(err)).toMatchObject({ code });
  });

  it("maps the existing Session errors this module re-uses, and leaves unknown errors unmapped", () => {
    expect(statusForCommunityVotingError(new HostTokenMismatchError())).toMatchObject({ status: 403 });
    expect(statusForCommunityVotingError(new SessionNotFoundError())).toMatchObject({ status: 404 });
    expect(statusForCommunityVotingError(new SelfVoteNotAllowedError())).toMatchObject({ status: 400 });
    expect(statusForCommunityVotingError(new Error("boom"))).toBeNull();
  });

  const SNAPSHOT = {
    instanceId: "i",
    bindingId: "b",
    sessionState: "LOBBY_LOCKED",
    interactionInstanceId: "x",
    interactionState: "PROMPT_ACTIVE",
    engineType: "VOTING",
    issuedIntentNo: 3,
    appliedIntentNo: 3,
    myCandidateId: "c",
    myEntry: null,
  };

  it("a conflict body carries only the caller's own current state", () => {
    const body = communityVotingErrorBody(new CommunityVotingError("STALE_INTENT", undefined, SNAPSHOT)) as { current?: Record<string, unknown> };
    expect(Object.keys(body.current ?? {}).sort()).toEqual(
      ["appliedIntentNo", "bindingId", "engineType", "instanceId", "interactionInstanceId", "interactionState", "issuedIntentNo", "myCandidateId", "myEntry", "sessionState"].sort()
    );
  });

  it("keeps the CURRENT vote state and the intent's HISTORICAL outcome apart: a stale conflict claims nothing about the intent", () => {
    const stale = communityVotingErrorBody(new CommunityVotingError("STALE_INTENT", undefined, SNAPSHOT, "HISTORICAL_OUTCOME_UNAVAILABLE")) as Record<string, unknown>;
    expect(stale.intentOutcome).toBe("HISTORICAL_OUTCOME_UNAVAILABLE");
    expect(stale.current).toBeDefined();
    for (const claim of ["outcome", "candidateId", "voteUpdatedAt", "intentNo", "applied"]) expect(stale).not.toHaveProperty(claim);
    const mismatch = communityVotingErrorBody(new CommunityVotingError("INTENT_PAYLOAD_MISMATCH", undefined, SNAPSHOT, "APPLIED_WITH_DIFFERENT_PAYLOAD")) as Record<string, unknown>;
    expect(mismatch.intentOutcome).toBe("APPLIED_WITH_DIFFERENT_PAYLOAD");
  });
});

// ---------------------------------------------------------------- ordinary Session regression

describe("Ordinary Session behaviour is unchanged", () => {
  it("an ordinary, non-event Session still joins, locks and votes exactly as before", async () => {
    const sessionRepo = new InMemorySessionRepository();
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    const alex = await joinSession(sessionRepo, session.roomCode, "Alex");
    await joinSession(sessionRepo, session.roomCode, "Sam");
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    const started = await startSession(sessionRepo, session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Q",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
    });
    const candidates = await sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
    const result = await sessionRepo.castVote(session.sessionId, alex.participantId, alex.participantToken, candidates[0].candidateId);
    expect(result.candidateId).toBe(candidates[0].candidateId);
  });
});

// ---------------------------------------------------------------- static: no TypeScript participant writer

describe("No TypeScript source writes to the participants table directly", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (name === "node_modules" || name === ".next") return [];
      return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx|js)$/.test(name) ? [full] : [];
    });
  }

  it("every participant row is created by a database function, so the database guard sees every join path", () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(root, "lib")), ...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "scripts"))]) {
      const text = readFileSync(file, "utf8");
      // .from("participants") followed (within the same chained call) by a write verb
      if (/\.from\(\s*["']participants["']\s*\)\s*\.(insert|upsert|update|delete)\b/.test(text)) {
        offenders.push(path.relative(root, file));
      }
      // raw SQL strings that write participants
      if (/(insert\s+into|update|delete\s+from)\s+(public\.)?participants\b/i.test(text) && !/\/db\/inMemory/.test(file)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
