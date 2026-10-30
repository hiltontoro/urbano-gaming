import { describe, expect, it, vi } from "vitest";

import { InMemoryGamingRepository } from "../lib/gaming/db/inMemoryGamingRepository";
import { createGamingMember } from "../lib/gaming/createGamingMember";
import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import { ORDERING_ALGORITHM, orderCandidatesForVoter } from "../lib/gaming/communityVoting/rounds/ordering";
import { sanitizeJpeg } from "../lib/gaming/communityVoting/rounds/jpeg";
import { parseOperatorAllowlist } from "../lib/gaming/communityVoting/rounds/operatorAuth";
import * as constants from "../lib/gaming/communityVoting/rounds/constants";
import {
  FINAL_PROMPT,
  FINAL_WINDOW_SECONDS,
  FINALIST_CUTOFF,
  GALLERY_CONSENT_SHA256,
  GALLERY_CONSENT_TEXT,
  GALLERY_CONSENT_VERSION,
  PRELIMINARY_PROMPT,
  PROMO_CONSENT_SHA256,
  PROMO_CONSENT_TEXT,
  PROMO_CONSENT_VERSION,
  sha256Hex,
} from "../lib/gaming/communityVoting/rounds/constants";
import {
  competitionRanks,
  finalistSelectionDigest,
  reviewDigest,
  roundResultsDigest,
  selectFinalists,
  selectWinners,
  type RoundTally,
} from "../lib/gaming/communityVoting/rounds/finalists";
import { resolveRoundVoter } from "../lib/gaming/communityVoting/rounds/identity";
import {
  recordGalleryConsent,
  recordPromoConsent,
  registerCommunityVotingRound,
} from "../lib/gaming/communityVoting/rounds/operations";
import { deadlineRemainingMs, deriveRoundPhase } from "../lib/gaming/communityVoting/rounds/phase";
import type { RoundsRepository } from "../lib/gaming/communityVoting/rounds/repository";
import type { RoundPublicInfo } from "../lib/gaming/communityVoting/rounds/types";
import { bindRoundVoter, castRoundVote, getRoundPublicInfo, issueRoundIntent } from "../lib/gaming/communityVoting/rounds/voterOperations";

/**
 * Two-round pilot (UG-IV-GATE-004 / 004A) — pure rule modules and the domain's guards (no database, no network).
 *
 * Everything the database enforces (uniqueness, atomicity, the window, the geofence, the table guards) is proven separately against
 * real Postgres in communityVotingRoundsSupabase.contract.test.ts, and the HTTP edge against a real Auth service in
 * communityVotingRoundsRoutes.contract.test.ts. This file pins the rules themselves and the order in which the domain refuses things.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tally = (votes: number[], withdrawn: number[] = []): RoundTally[] =>
  votes.map((v, i) => ({ ordinal: i + 1, label: `#${1000 + i}`, withdrawn: withdrawn.includes(i), votes: v }));

// ---------------------------------------------------------------- fixed facts from the pilot authority

describe("Pilot constants are exactly what the pilot authority says", () => {
  it("advances ten contestants plus ties and runs a five-minute final; no retention period is an operative constant", () => {
    expect(FINALIST_CUTOFF).toBe(10);
    expect(FINAL_WINDOW_SECONDS).toBe(300);
    expect(Object.keys(constants).filter((k) => /RETENTION|REMOVAL/i.test(k))).toEqual([]);
  });

  it("keeps the gallery/contest consent and the promotional consent as two different, separately versioned statements", () => {
    expect(GALLERY_CONSENT_VERSION).not.toBe(PROMO_CONSENT_VERSION);
    expect(GALLERY_CONSENT_TEXT).not.toBe(PROMO_CONSENT_TEXT);
    expect(GALLERY_CONSENT_SHA256).toBe(sha256Hex(GALLERY_CONSENT_TEXT));
    expect(PROMO_CONSENT_SHA256).toBe(sha256Hex(PROMO_CONSENT_TEXT));
    expect(GALLERY_CONSENT_SHA256).not.toBe(PROMO_CONSENT_SHA256);
    expect(GALLERY_CONSENT_VERSION).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(PROMO_CONSENT_VERSION).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it("the contest consent needs legal age and authorizes the gallery only; refusing promotion is explicitly compatible with competing", () => {
    expect(GALLERY_CONSENT_TEXT).toMatch(/mayor de edad/);
    expect(GALLERY_CONSENT_TEXT).toMatch(/galería pública/);
    expect(GALLERY_CONSENT_TEXT).not.toMatch(/TecnoMovi|The Pub|URBANO Gaming|comunicaciones promocionales/);
    expect(GALLERY_CONSENT_TEXT).toMatch(/sin autorizar ningún uso promocional/);
    expect(GALLERY_CONSENT_TEXT).not.toMatch(/72|horas/i);
  });

  it("the promotional consent is optional, revocable and cannot affect participation", () => {
    expect(PROMO_CONSENT_TEXT).toMatch(/opcional/);
    expect(PROMO_CONSENT_TEXT).toMatch(/sin que eso afecte mi participación/);
    expect(PROMO_CONSENT_TEXT).toMatch(/retirar esta autorización/);
  });

  it("asks each round for ONE favorite, revisable, and never names a contestant or a standing", () => {
    expect(PRELIMINARY_PROMPT).toMatch(/favorito/);
    expect(PRELIMINARY_PROMPT).toMatch(/cambiar tu voto/);
    expect(FINAL_PROMPT).toMatch(/finalistas/);
    for (const prompt of [PRELIMINARY_PROMPT, FINAL_PROMPT]) expect(prompt).not.toMatch(/#\d|ranking|puesto|líder|cinco/i);
  });
});

// ---------------------------------------------------------------- the cut and the winners

describe("competition ranks", () => {
  it("equal votes share a rank and the next rank is skipped (1, 1, 3)", () => {
    expect(competitionRanks(tally([5, 5, 2])).map((r) => r.rank)).toEqual([1, 1, 3]);
    expect(competitionRanks(tally([1, 4, 4, 4, 0])).map((r) => r.rank)).toEqual([4, 1, 1, 1, 5]);
  });

  it("a withdrawn contestant has no rank and does not count against the others", () => {
    const ranked = competitionRanks(tally([9, 3, 2], [0]));
    expect(ranked.map((r) => r.rank)).toEqual([null, 1, 2]);
  });

  it("returns the rows in ordinal order whatever order they arrive in", () => {
    const shuffled = [...tally([1, 2, 3])].reverse();
    expect(competitionRanks(shuffled).map((r) => r.ordinal)).toEqual([1, 2, 3]);
  });
});

describe("finalist selection", () => {
  it("takes the first ten when the tenth is not tied", () => {
    const votes = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const finalists = selectFinalists(tally(votes));
    expect(finalists).toHaveLength(10);
    expect(finalists.map((f) => f.votes)).toEqual(votes.slice(0, 10));
  });

  it("advances every contestant tied with the tenth: a group straddling the cutoff all advance, so there can be more than ten", () => {
    // 1 + 3 + 7 tied at 1 vote = 11 contestants at rank <= 10 ... the seven share rank 5; position ten sits inside their group
    const finalists = selectFinalists(tally([3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0]));
    expect(finalists).toHaveLength(11);
    expect(finalists.map((f) => f.rank)).toEqual([1, 2, 2, 2, 5, 5, 5, 5, 5, 5, 5]);
  });

  it("a tie that begins exactly at position ten pulls the whole group in", () => {
    const finalists = selectFinalists(tally([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0]));
    // ranks 1..9, then the three zeros share rank 10 -> all advance
    expect(finalists).toHaveLength(12);
  });

  it("a tie that begins at position eleven stays out", () => {
    const finalists = selectFinalists(tally([9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 0]));
    // ranks 1..8, the three 1s share rank 9 (positions 9-11) -> advance; the zero is rank 12 -> out
    expect(finalists).toHaveLength(11);
    expect(finalists.every((f) => (f.rank as number) <= 10)).toBe(true);
  });

  it("advances everyone when there are ten or fewer contestants, whatever their votes", () => {
    expect(selectFinalists(tally([2, 1, 0, 0]))).toHaveLength(4);
    expect(selectFinalists(tally([0]))).toHaveLength(1);
    expect(selectFinalists(tally(Array(10).fill(0)))).toHaveLength(10);
  });

  it("advances everyone when nobody voted (all tie at rank 1), even when there are more than ten", () => {
    expect(selectFinalists(tally(Array(14).fill(0)))).toHaveLength(14);
  });

  it("leaves a withdrawn contestant out and lets the next one in", () => {
    const votes = [20, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const without = selectFinalists(tally(votes, [0]));
    expect(without.map((f) => f.votes)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(without.find((f) => f.ordinal === 1)).toBeUndefined();
  });

  it("takes no list from anybody: the same tally always gives the same cut, in ordinal order", () => {
    const rows = tally([4, 1, 4, 2, 2, 0]);
    expect(selectFinalists(rows)).toEqual(selectFinalists([...rows].reverse()));
  });

  it("honors a smaller cutoff with the same tie rule (used for the test vectors only; the pilot's cutoff is ten)", () => {
    expect(selectFinalists(tally([5, 4, 4, 1]), 2).map((f) => f.ordinal)).toEqual([1, 2, 3]);
  });
});

describe("winners of the final", () => {
  it("a single leader wins alone", () => {
    expect(selectWinners(tally([3, 5, 1])).map((w) => w.ordinal)).toEqual([2]);
  });

  it("a tie for first is shared — never broken, never decided by anybody", () => {
    expect(selectWinners(tally([5, 5, 1])).map((w) => w.ordinal)).toEqual([1, 2]);
    // GATE-006: this line used to assert that a tie of ZEROS shared the win ([1, 2, 3]). That was the defect: shared winners apply only to a
    // positive highest count. A final with no valid votes has no winners — see communityVotingRoundsZeroVote.test.ts.
    expect(selectWinners(tally([2, 2, 2])).map((w) => w.ordinal)).toEqual([1, 2, 3]);
    expect(selectWinners(tally([0, 0, 0])).map((w) => w.ordinal)).toEqual([]);
  });

  it("a withdrawn leader hands the win to the next contestant", () => {
    expect(selectWinners(tally([9, 4, 3], [0])).map((w) => w.ordinal)).toEqual([2]);
  });
});

describe("digests", () => {
  const rows = tally([3, 2, 2, 0]);

  it("are deterministic and independent of row order", () => {
    expect(roundResultsDigest("FINAL", 7, rows)).toBe(roundResultsDigest("FINAL", 7, [...rows].reverse()));
    expect(finalistSelectionDigest(rows)).toBe(finalistSelectionDigest([...rows].reverse()));
    expect(roundResultsDigest("FINAL", 7, rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("change when a vote count, the round, the number of valid votes or a withdrawal changes", () => {
    const base = roundResultsDigest("PRELIMINARY", 7, rows);
    expect(roundResultsDigest("FINAL", 7, rows)).not.toBe(base);
    expect(roundResultsDigest("PRELIMINARY", 8, rows)).not.toBe(base);
    expect(roundResultsDigest("PRELIMINARY", 7, tally([3, 2, 1, 0]))).not.toBe(base);
    expect(roundResultsDigest("PRELIMINARY", 7, tally([3, 2, 2, 0], [3]))).not.toBe(base);
  });

  it("the review digest binds the round's result to the finalist cut", () => {
    const round = roundResultsDigest("PRELIMINARY", 7, rows);
    const cut = finalistSelectionDigest(rows);
    expect(reviewDigest(round, cut, [], [])).not.toBe(reviewDigest(round, null, [], []));
    expect(reviewDigest(round, cut, [], [])).not.toBe(reviewDigest(roundResultsDigest("PRELIMINARY", 8, rows), cut, [], []));
  });
});

// ---------------------------------------------------------------- the phase a person sees

describe("round phase", () => {
  const base = { sessionState: "LOBBY_LOCKED", interactionState: "PROMPT_ACTIVE", closed: false, deadlineAt: null as string | null, serverNow: "2026-10-31T21:00:00.000Z" };

  it("is NOT_OPEN before the explicit open and OPEN after it, while the deadline is ahead", () => {
    expect(deriveRoundPhase({ ...base, interactionState: null })).toBe("NOT_OPEN");
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-10-31T22:00:00.000Z" })).toBe("OPEN");
  });

  it("an open round with no deadline fails closed", () => {
    expect(deriveRoundPhase(base)).toBe("CLOSED");
  });

  it("is CLOSED after the close or the reveal, and ENDED when the Session is complete", () => {
    expect(deriveRoundPhase({ ...base, interactionState: "SUBMISSIONS_CLOSED" })).toBe("CLOSED");
    expect(deriveRoundPhase({ ...base, interactionState: "RESULT_REVEAL" })).toBe("CLOSED");
    expect(deriveRoundPhase({ ...base, closed: true })).toBe("CLOSED");
    expect(deriveRoundPhase({ ...base, sessionState: "SESSION_COMPLETE" })).toBe("ENDED");
  });

  it("a round whose deadline has passed on the SERVER's clock shows as closed even before the operator closes it", () => {
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-10-31T21:05:00.000Z" })).toBe("OPEN");
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-10-31T21:00:00.000Z" })).toBe("CLOSED");
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-10-31T20:59:59.000Z" })).toBe("CLOSED");
  });

  it("the remaining time is the server's, never negative, and absent while there is no deadline", () => {
    expect(deadlineRemainingMs({ deadlineAt: "2026-10-31T21:04:30.000Z", serverNow: base.serverNow })).toBe(270_000);
    expect(deadlineRemainingMs({ deadlineAt: "2026-10-31T20:00:00.000Z", serverNow: base.serverNow })).toBe(0);
    expect(deadlineRemainingMs({ deadlineAt: null, serverNow: base.serverNow })).toBeNull();
  });
});

// ---------------------------------------------------------------- identity: confirmed email + Gaming Member

function verifier(map: Record<string, { authUserId: string; emailVerified: boolean } | null>) {
  return { verifyAccessToken: vi.fn(async (token: string) => (token in map ? map[token] : null)) };
}

describe("round voter identity", () => {
  const authUserId = uuid(1);

  it("refuses a missing, malformed, invalid or forged token before anything else", async () => {
    const gamingRepo = new InMemoryGamingRepository();
    const emailVerifier = verifier({ good: { authUserId, emailVerified: true } });
    for (const header of [undefined, null, "", "Basic abc", "Bearer", "Bearer nope", "bearer   "]) {
      await expect(resolveRoundVoter({ emailVerifier, gamingRepo }, header as never)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    }
  });

  it("refuses an unverified email: VERIFIED_EMAIL_REQUIRED, and does not even look for a profile", async () => {
    const gamingRepo = new InMemoryGamingRepository();
    const spy = vi.spyOn(gamingRepo, "resolveGamingMemberByAuthUserId");
    const emailVerifier = verifier({ unverified: { authUserId, emailVerified: false } });
    await expect(resolveRoundVoter({ emailVerifier, gamingRepo }, "Bearer unverified")).rejects.toMatchObject({ code: "VERIFIED_EMAIL_REQUIRED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a confirmed email without a Gaming Member: PROFILE_INCOMPLETE — and accepts the SAME token once the profile is completed", async () => {
    const gamingRepo = new InMemoryGamingRepository();
    const emailVerifier = verifier({ t: { authUserId, emailVerified: true } });
    await expect(resolveRoundVoter({ emailVerifier, gamingRepo }, "Bearer t")).rejects.toMatchObject({ code: "PROFILE_INCOMPLETE" });
    const member = await createGamingMember(gamingRepo, authUserId, "Marta");
    await expect(resolveRoundVoter({ emailVerifier, gamingRepo }, "Bearer t")).resolves.toEqual({ authUserId, gamingMemberId: member.gamingMemberId });
  });

  it("derives the identity from the token alone: a body or header claiming another member changes nothing", async () => {
    const gamingRepo = new InMemoryGamingRepository();
    const mine = await createGamingMember(gamingRepo, authUserId, "Marta");
    await createGamingMember(gamingRepo, uuid(2), "Otra");
    const emailVerifier = verifier({ t: { authUserId, emailVerified: true } });
    const identity = await resolveRoundVoter({ emailVerifier, gamingRepo }, "Bearer t");
    expect(identity.gamingMemberId).toBe(mine.gamingMemberId);
  });

  it("fails closed when the Auth service cannot say who the token belongs to", async () => {
    const gamingRepo = new InMemoryGamingRepository();
    const emailVerifier = { verifyAccessToken: vi.fn(async () => null) };
    await expect(resolveRoundVoter({ emailVerifier, gamingRepo }, "Bearer t")).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});

// ---------------------------------------------------------------- the domain refuses before it reaches the database

function fakeRepo(overrides: Partial<RoundsRepository> & { info?: Partial<RoundPublicInfo> } = {}) {
  const info: RoundPublicInfo = {
    roundRole: "PRELIMINARY",
    sessionState: "LOBBY_LOCKED",
    interactionState: "PROMPT_ACTIVE",
    openedAt: "2026-10-31T20:00:00.000Z",
    windowSeconds: null,
    deadlineAt: "2026-10-31T21:30:00.000Z",
    serverNow: "2026-10-31T20:30:00.000Z",
    locationRequired: false,
    registrationOpensAt: null,
    contestantCutoffAt: null,
    votingOpensAt: null,
    votingClosesAt: null,
    scheduleStatus: null,
    approvedContestants: 3,
    closed: false,
    published: false,
    isTest: false,
    ...overrides.info,
  };
  const repo = {
    readRoundPublicInfo: vi.fn(async () => info),
    bindVoter: vi.fn(async () => ({ bindingId: uuid(50), instanceId: uuid(9), created: true })),
    issueIntent: vi.fn(async () => ({ bindingId: uuid(50), intentNo: 1 })),
    castRoundVote: vi.fn(async () => ({ outcome: "APPLIED", bindingId: uuid(50), intentNo: 1, interactionInstanceId: uuid(7), candidateId: uuid(8), voteUpdatedAt: "2026-10-31T20:30:00.000Z" })),
    registerRound: vi.fn(async () => ({ instanceId: uuid(9) })),
    recordEntryConsent: vi.fn(async () => ({ consentId: uuid(60), acceptedAt: "x" })),
    recordPromoConsent: vi.fn(async () => ({ promoConsentId: uuid(61), entryId: uuid(5), decision: "DECLINED", recordedAt: "x" })),
    ...overrides,
  };
  return { repo: repo as unknown as RoundsRepository & typeof repo };
}

async function deps(opts: { verified?: boolean; member?: boolean; repo?: RoundsRepository } = {}) {
  const authUserId = uuid(1);
  const gamingRepo = new InMemoryGamingRepository();
  if (opts.member !== false) await createGamingMember(gamingRepo, authUserId, "Marta");
  return {
    repo: opts.repo ?? fakeRepo().repo,
    emailVerifier: verifier({ t: { authUserId, emailVerified: opts.verified !== false } }),
    gamingRepo,
  };
}
const goodBody = { bindingId: uuid(50), intentNo: 1, interactionInstanceId: uuid(7), candidateId: uuid(8) };

describe("the domain refuses an unqualified voter before it touches the round", () => {
  it("bind, intent and vote all stop at the identity: no unverified email, no incomplete profile, no bad token reaches the repository", async () => {
    for (const d of [await deps({ verified: false }), await deps({ member: false })]) {
      const repo = d.repo as ReturnType<typeof fakeRepo>["repo"];
      await expect(bindRoundVoter(d, "Bearer t", uuid(9))).rejects.toBeInstanceOf(CommunityVotingError);
      await expect(issueRoundIntent(d, "Bearer t", uuid(9))).rejects.toBeInstanceOf(CommunityVotingError);
      await expect(castRoundVote(d, "Bearer t", uuid(9), goodBody)).rejects.toBeInstanceOf(CommunityVotingError);
      expect(repo.bindVoter).not.toHaveBeenCalled();
      expect(repo.issueIntent).not.toHaveBeenCalled();
      expect(repo.castRoundVote).not.toHaveBeenCalled();
    }
    const d = await deps();
    await expect(castRoundVote(d, "Bearer wrong", uuid(9), goodBody)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect((d.repo as ReturnType<typeof fakeRepo>["repo"]).castRoundVote).not.toHaveBeenCalled();
  });

  it("a person who completes the profile can continue with the very same request", async () => {
    const authUserId = uuid(1);
    const gamingRepo = new InMemoryGamingRepository();
    const { repo } = fakeRepo();
    const d = { repo, emailVerifier: verifier({ t: { authUserId, emailVerified: true } }), gamingRepo };
    await expect(castRoundVote(d, "Bearer t", uuid(9), goodBody)).rejects.toMatchObject({ code: "PROFILE_INCOMPLETE" });
    expect(repo.castRoundVote).not.toHaveBeenCalled();
    await createGamingMember(gamingRepo, authUserId, "Marta");
    await expect(castRoundVote(d, "Bearer t", uuid(9), goodBody)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(repo.castRoundVote).toHaveBeenCalledTimes(1);
  });

  it("rejects an instance id that is not an id, and an unknown round", async () => {
    const d = await deps();
    await expect(bindRoundVoter(d, "Bearer t", "not-an-id")).rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND" });
    const none = { ...d, repo: fakeRepo({ readRoundPublicInfo: vi.fn(async () => null) }).repo };
    await expect(bindRoundVoter(none, "Bearer t", uuid(9))).rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND" });
  });
});

describe("the location rule belongs to the round, not to the browser", () => {
  it("the PRELIMINARY needs no location: a request without one is accepted, and the repository is handed none", async () => {
    const d = await deps();
    await castRoundVote(d, "Bearer t", uuid(9), goodBody);
    expect((d.repo as ReturnType<typeof fakeRepo>["repo"]).castRoundVote).toHaveBeenCalledWith(expect.objectContaining({ location: null }));
  });

  it("the PRELIMINARY drops a location it is sent: even a malformed or far-away one is neither validated nor passed on", async () => {
    const d = await deps();
    await castRoundVote(d, "Bearer t", uuid(9), { ...goodBody, location: { latitude: 999, longitude: "x", accuracyMeters: -1 } });
    await castRoundVote(d, "Bearer t", uuid(9), { ...goodBody, location: { latitude: 1, longitude: 2, accuracyMeters: 3 } });
    const calls = vi.mocked((d.repo as ReturnType<typeof fakeRepo>["repo"]).castRoundVote).mock.calls as unknown as Array<[{ location: unknown }]>;
    expect(calls.map((c) => c[0].location)).toEqual([null, null]);
  });

  it("the FINAL needs a well-formed location for EVERY vote: none, malformed, zero-zero, out of range and non-positive accuracy are refused BEFORE the repository (no intent is consumed)", async () => {
    const { repo } = fakeRepo({ info: { roundRole: "FINAL", locationRequired: true, windowSeconds: 300, deadlineAt: "2026-10-31T20:55:00.000Z" } });
    const d = await deps({ repo });
    const bad: unknown[] = [undefined, null, "here", {}, { latitude: 15.5, longitude: -88 }, { latitude: 0, longitude: 0, accuracyMeters: 5 }, { latitude: 95, longitude: 0, accuracyMeters: 5 }, { latitude: 15.5, longitude: -88, accuracyMeters: 0 }];
    for (const location of bad) {
      await expect(castRoundVote(d, "Bearer t", uuid(9), { ...goodBody, location })).rejects.toMatchObject({ code: "INVALID_LOCATION_READING" });
    }
    expect(repo.castRoundVote).not.toHaveBeenCalled();
    await castRoundVote(d, "Bearer t", uuid(9), { ...goodBody, location: { latitude: 15.5, longitude: -88, accuracyMeters: 10, eligible: true } });
    // only the three known fields reach the repository: a claimed eligibility is never read
    expect(repo.castRoundVote).toHaveBeenCalledWith(expect.objectContaining({ location: { latitude: 15.5, longitude: -88, accuracyMeters: 10 } }));
  });

  it("validates the shape of a vote before the repository: ids and the intent number", async () => {
    const d = await deps();
    const repo = d.repo as ReturnType<typeof fakeRepo>["repo"];
    for (const body of [null, [], "x", { ...goodBody, bindingId: "x" }, { ...goodBody, candidateId: 5 }, { ...goodBody, interactionInstanceId: undefined }, { ...goodBody, intentNo: 0 }, { ...goodBody, intentNo: 1.5 }, { ...goodBody, intentNo: "1" }]) {
      await expect(castRoundVote(d, "Bearer t", uuid(9), body)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(repo.castRoundVote).not.toHaveBeenCalled();
  });
});

describe("public information", () => {
  it("derives the phase from the server's clock and carries the consent texts; the schedule is flagged as a plan until confirmed", async () => {
    const { repo } = fakeRepo({ info: { roundRole: "FINAL", locationRequired: true, windowSeconds: 300, openedAt: "2026-10-31T20:00:00.000Z", deadlineAt: "2026-10-31T20:05:00.000Z", serverNow: "2026-10-31T20:04:00.000Z", scheduleStatus: "TENTATIVE" } });
    const open = await getRoundPublicInfo(repo, uuid(9));
    expect(open.info).toMatchObject({ roundRole: "FINAL", phase: "OPEN", locationRequired: true, deadlineRemainingMs: 60_000, tentative: true });
    expect(open.texts.galleryConsent.version).toBe(GALLERY_CONSENT_VERSION);
    expect(open.texts.promoConsent.version).toBe(PROMO_CONSENT_VERSION);

    const { repo: later } = fakeRepo({ info: { roundRole: "FINAL", locationRequired: true, windowSeconds: 300, deadlineAt: "2026-10-31T20:05:00.000Z", serverNow: "2026-10-31T20:05:01.000Z", scheduleStatus: "CONFIRMED" } });
    const over = await getRoundPublicInfo(later, uuid(9));
    expect(over.info).toMatchObject({ phase: "CLOSED", deadlineRemainingMs: 0, tentative: false });
  });

  it("exposes no venue coordinate, no count of votes and no ranking", async () => {
    const { repo } = fakeRepo({ info: { roundRole: "FINAL", locationRequired: true } });
    const body = JSON.stringify(await getRoundPublicInfo(repo, uuid(9)));
    expect(body).not.toMatch(/latitude|longitude|venue|radius|votes|rank|total/i);
  });
});

// ---------------------------------------------------------------- operator-side guards

describe("round registration", () => {
  const operator = uuid(70);
  const allow = uuid(70);
  const venue = { venueLatitude: 15.5, venueLongitude: -88, venueRadiusMeters: 100, maxAccuracyMeters: 50, insideMarginFactor: 1, outsideMarginFactor: 1 };

  it("fails closed without a valid allow-list, and for a member who is not on it", async () => {
    const { repo } = fakeRepo();
    const body = { sessionId: uuid(3), roundRole: "PRELIMINARY" };
    for (const allowlistRaw of [undefined, "", "   ", "not-an-id", `${allow},oops`]) {
      await expect(registerCommunityVotingRound(repo, { body, hostToken: "h", operatorMemberId: operator, allowlistRaw })).rejects.toMatchObject({ code: "OPERATOR_NOT_CONFIGURED" });
    }
    await expect(registerCommunityVotingRound(repo, { body, hostToken: "h", operatorMemberId: uuid(71), allowlistRaw: allow })).rejects.toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(repo.registerRound).not.toHaveBeenCalled();
  });

  it("a preliminary takes no source and no venue (it is voted from anywhere)", async () => {
    const { repo } = fakeRepo();
    const base = { hostToken: "h", operatorMemberId: operator, allowlistRaw: allow };
    await expect(registerCommunityVotingRound(repo, { ...base, body: { sessionId: uuid(3), roundRole: "PRELIMINARY", venue } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(registerCommunityVotingRound(repo, { ...base, body: { sessionId: uuid(3), roundRole: "PRELIMINARY", sourceInstanceId: uuid(4) } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await registerCommunityVotingRound(repo, { ...base, body: { sessionId: uuid(3), roundRole: "PRELIMINARY" } });
    expect(repo.registerRound).toHaveBeenCalledWith(expect.objectContaining({ roundRole: "PRELIMINARY", venue: null, sourceInstanceId: null, windowSeconds: null }));
  });

  it("a final needs its preliminary and a complete, valid geofence, and always gets the contractual window — the request cannot choose it", async () => {
    const { repo } = fakeRepo();
    const base = { hostToken: "h", operatorMemberId: operator, allowlistRaw: allow };
    const final = { sessionId: uuid(3), roundRole: "FINAL", sourceInstanceId: uuid(4), venue };
    await expect(registerCommunityVotingRound(repo, { ...base, body: { ...final, sourceInstanceId: undefined } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(registerCommunityVotingRound(repo, { ...base, body: { ...final, venue: undefined } })).rejects.toMatchObject({ code: "INVALID_GEOFENCE_CONFIG" });
    await expect(registerCommunityVotingRound(repo, { ...base, body: { ...final, venue: { ...venue, venueRadiusMeters: -1 } } })).rejects.toMatchObject({ code: "INVALID_GEOFENCE_CONFIG" });
    await expect(registerCommunityVotingRound(repo, { ...base, body: { ...final, roundRole: "SEMIFINAL" } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(repo.registerRound).not.toHaveBeenCalled();
    await registerCommunityVotingRound(repo, { ...base, body: { ...final, windowSeconds: 9999 } });
    expect(repo.registerRound).toHaveBeenCalledWith(expect.objectContaining({ roundRole: "FINAL", venue, sourceInstanceId: uuid(4), windowSeconds: FINAL_WINDOW_SECONDS }));
  });
});

describe("consent recording", () => {
  const ctx = { instanceId: uuid(9), hostToken: "h", operatorMemberId: uuid(70) };

  it("the contest consent is the server's own text and digest; a stale page or an unticked box is refused, and age must be confirmed", async () => {
    const { repo } = fakeRepo();
    const ok = { photoId: uuid(11), consentVersion: GALLERY_CONSENT_VERSION, accepted: true, ageConfirmed: true };
    expect(() => recordGalleryConsent(repo, ctx, uuid(5), { ...ok, consentVersion: "halloween-2026-v1" })).toThrow(CommunityVotingError);
    expect(() => recordGalleryConsent(repo, ctx, uuid(5), { ...ok, accepted: false })).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    expect(() => recordGalleryConsent(repo, ctx, uuid(5), { ...ok, ageConfirmed: false })).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    expect(() => recordGalleryConsent(repo, ctx, uuid(5), { ...ok, accepted: "yes" })).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    expect(repo.recordEntryConsent).not.toHaveBeenCalled();
    await recordGalleryConsent(repo, ctx, uuid(5), { ...ok, statementSha256: "0".repeat(64), consentVersion: GALLERY_CONSENT_VERSION });
    expect(repo.recordEntryConsent).toHaveBeenCalledWith(expect.objectContaining({ consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256, ageConfirmed: true }));
  });

  it("the promotional decision carries its own version and digest, takes any of three decisions, and nothing else", async () => {
    const { repo } = fakeRepo();
    expect(() => recordPromoConsent(repo, ctx, uuid(5), { consentVersion: GALLERY_CONSENT_VERSION, decision: "ACCEPTED" })).toThrow(CommunityVotingError);
    expect(() => recordPromoConsent(repo, ctx, uuid(5), { consentVersion: PROMO_CONSENT_VERSION, decision: "MAYBE" })).toThrow(CommunityVotingError);
    for (const decision of ["ACCEPTED", "DECLINED", "WITHDRAWN"]) {
      await recordPromoConsent(repo, ctx, uuid(5), { consentVersion: PROMO_CONSENT_VERSION, decision });
    }
    expect(repo.recordPromoConsent).toHaveBeenCalledTimes(3);
    expect(repo.recordPromoConsent).toHaveBeenCalledWith(expect.objectContaining({ statementSha256: PROMO_CONSENT_SHA256, consentVersion: PROMO_CONSENT_VERSION }));
  });
});

// ---------------------------------------------------------------- the per-voter order

describe("per-voter discovery order (reused unchanged)", () => {
  it("is reproducible for a voter, independent of arrival order, and differs between voters", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ candidateId: uuid(100 + i), alias: `#${1000 + i}` }));
    const a = orderCandidatesForVoter(items, uuid(9), "voter-a");
    expect(orderCandidatesForVoter([...items].reverse(), uuid(9), "voter-a")).toEqual(a);
    expect(orderCandidatesForVoter(items, uuid(9), "voter-b")).not.toEqual(a);
    expect(a).toHaveLength(12);
  });
});

// ---------------------------------------------------------------- per-voter ordering (carried over from the superseded suite, assertions unchanged)

describe("Per-voter candidate ordering: deterministic, auditable and balanced", () => {
  const instanceId = uuid(7);
  const candidates = Array.from({ length: 120 }, (_, i) => ({ candidateId: uuid(1000 + i), label: `#${1000 + i}` }));

  it("names its algorithm so an audit can reproduce it", () => {
    expect(ORDERING_ALGORITHM).toBe("fisher-yates-sha256-v1");
  });

  it("is a permutation of the input and leaves the input untouched", () => {
    const before = JSON.stringify(candidates);
    const ordered = orderCandidatesForVoter(candidates, instanceId, uuid(5001));
    expect(ordered).toHaveLength(candidates.length);
    expect(new Set(ordered.map((c) => c.candidateId))).toEqual(new Set(candidates.map((c) => c.candidateId)));
    expect(JSON.stringify(candidates)).toBe(before);
  });

  it("is deterministic for one voter and independent of the order the database returned the rows in", () => {
    const a = orderCandidatesForVoter(candidates, instanceId, uuid(5001)).map((c) => c.candidateId);
    const b = orderCandidatesForVoter([...candidates].reverse(), instanceId, uuid(5001)).map((c) => c.candidateId);
    const c = orderCandidatesForVoter([...candidates].sort(() => 0.5 - Math.random()), instanceId, uuid(5001)).map((x) => x.candidateId);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("differs between voters and between events — there is no single shared ordering", () => {
    const first = orderCandidatesForVoter(candidates, instanceId, uuid(1)).map((c) => c.candidateId);
    let identical = 0;
    for (let v = 2; v <= 50; v++) {
      if (orderCandidatesForVoter(candidates, instanceId, uuid(v)).map((c) => c.candidateId).join() === first.join()) identical++;
    }
    expect(identical).toBe(0);
    expect(orderCandidatesForVoter(candidates, uuid(8), uuid(1)).map((c) => c.candidateId)).not.toEqual(first);
  });

  it("is not the canonical (arrival / label) order: early arrivals get no fixed advantage", () => {
    const natural = candidates.map((c) => c.candidateId);
    let sameAsNatural = 0;
    for (let v = 1; v <= 40; v++) {
      if (orderCandidatesForVoter(candidates, instanceId, uuid(v)).map((c) => c.candidateId).join() === natural.join()) sameAsNatural++;
    }
    expect(sameAsNatural).toBe(0);
  });

  it("spreads every contestant across early and late positions over 1,200 voters", () => {
    const voters = 1200;
    const n = candidates.length;
    const positionSum = new Map<string, number>();
    const inFirstTen = new Map<string, number>();
    const inLastTen = new Map<string, number>();
    for (let v = 0; v < voters; v++) {
      const ordered = orderCandidatesForVoter(candidates, instanceId, uuid(100000 + v));
      ordered.forEach((c, index) => {
        positionSum.set(c.candidateId, (positionSum.get(c.candidateId) ?? 0) + index);
        if (index < 10) inFirstTen.set(c.candidateId, (inFirstTen.get(c.candidateId) ?? 0) + 1);
        if (index >= n - 10) inLastTen.set(c.candidateId, (inLastTen.get(c.candidateId) ?? 0) + 1);
      });
    }
    const expectedMean = (n - 1) / 2; // 59.5
    const expectedTen = (voters * 10) / n; // 100
    for (const c of candidates) {
      const mean = (positionSum.get(c.candidateId) ?? 0) / voters;
      expect(Math.abs(mean - expectedMean)).toBeLessThan(6); // sd of a uniform position over 1,200 voters is ~1.0
      expect(Math.abs((inFirstTen.get(c.candidateId) ?? 0) - expectedTen)).toBeLessThan(40); // sd ~9.6
      expect(Math.abs((inLastTen.get(c.candidateId) ?? 0) - expectedTen)).toBeLessThan(40);
    }
  });

  it("handles the degenerate sizes", () => {
    expect(orderCandidatesForVoter([], instanceId, uuid(1))).toEqual([]);
    const one = [{ candidateId: uuid(1) }];
    expect(orderCandidatesForVoter(one, instanceId, uuid(1))).toEqual(one);
  });
});

// ---------------------------------------------------------------- photographs (carried over from the superseded suite, assertions unchanged)

interface JpegOptions {
  width?: number;
  height?: number;
  app1?: string;
  com?: string;
  progressive?: boolean;
  truncate?: boolean;
  fillerBytes?: number;
}

/** A structurally valid JPEG (markers, lengths, byte-stuffed scan, EOI). Not decodable pixels — the sanitizer is structural. */
function buildJpeg(o: JpegOptions = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  const segment = (marker: number, payload: number[]) => {
    const length = payload.length + 2;
    parts.push(0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload);
  };
  segment(0xe0, [...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  if (o.app1 !== undefined) segment(0xe1, [...Buffer.from(`Exif\0\0${o.app1}`)]);
  if (o.com !== undefined) segment(0xfe, [...Buffer.from(o.com)]);
  segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => (i % 7) + 1)]);
  const w = o.width ?? 640;
  const h = o.height ?? 480;
  segment(o.progressive ? 0xc2 : 0xc0, [8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 1, 1, 0x11, 0]);
  segment(0xc4, [0, ...Array.from({ length: 16 }, () => 0), 0]);
  segment(0xda, [1, 1, 0, 0, 63, 0]);
  parts.push(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78);
  for (let i = 0; i < (o.fillerBytes ?? 0); i++) parts.push(0x11);
  if (!o.truncate) parts.push(0xff, 0xd9);
  return Uint8Array.from(parts);
}

const LIMITS = { maxBytes: 1_500_000, maxLongSide: 2400 };

describe("Photograph sanitizing: structure-checked JPEG with metadata removed", () => {
  it("accepts a baseline and a progressive JPEG and reports its dimensions", () => {
    const base = sanitizeJpeg(buildJpeg({ width: 1200, height: 900 }), LIMITS);
    expect(base).toMatchObject({ ok: true, width: 1200, height: 900 });
    expect(sanitizeJpeg(buildJpeg({ progressive: true }), LIMITS)).toMatchObject({ ok: true, width: 640, height: 480 });
  });

  it("removes EXIF and comment segments — including a GPS position — and keeps the image data intact", () => {
    const input = buildJpeg({ app1: "GPS 14.0818 N 87.2068 W Tegucigalpa", com: "taken by Maria Lopez 9999-8888" });
    expect(Buffer.from(input).toString("latin1")).toContain("Tegucigalpa");
    const out = sanitizeJpeg(input, LIMITS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const text = Buffer.from(out.bytes).toString("latin1");
    for (const leaked of ["Exif", "GPS", "Tegucigalpa", "Maria", "9999-8888"]) expect(text).not.toContain(leaked);
    expect(out.removedSegments).toBe(2);
    expect(out.bytes[0]).toBe(0xff);
    expect(out.bytes[1]).toBe(0xd8);
    expect(out.bytes[out.bytes.length - 2]).toBe(0xff);
    expect(out.bytes[out.bytes.length - 1]).toBe(0xd9);
    // the entropy-coded scan (with its stuffed 0xFF00 and restart marker) is preserved byte for byte
    expect(Buffer.from(out.bytes).includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
  });

  it("is idempotent: sanitizing sanitized output changes nothing", () => {
    const once = sanitizeJpeg(buildJpeg({ app1: "x", com: "y" }), LIMITS);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = sanitizeJpeg(once.bytes, LIMITS);
    expect(twice.ok && Buffer.from(twice.bytes).equals(Buffer.from(once.bytes))).toBe(true);
  });

  it.each([
    ["an empty body", new Uint8Array(), "NOT_JPEG"],
    ["a PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), "NOT_JPEG"],
    ["plain text", Uint8Array.from(Buffer.from("<script>alert(1)</script>")), "NOT_JPEG"],
    ["a truncated JPEG", buildJpeg({ truncate: true }), "TRUNCATED"],
    ["an arithmetic-coded JPEG (unsupported)", (() => { const b = buildJpeg(); const i = b.indexOf(0xc0); const copy = Uint8Array.from(b); copy[i] = 0xc9; return copy; })(), "UNSUPPORTED_ENCODING"],
  ])("rejects %s", (_label, bytes, reason) => {
    expect(sanitizeJpeg(bytes as Uint8Array, LIMITS)).toEqual({ ok: false, reason });
  });

  it("enforces the byte and the dimension limits", () => {
    expect(sanitizeJpeg(buildJpeg({ fillerBytes: 2000 }), { maxBytes: 1000, maxLongSide: 2400 })).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(sanitizeJpeg(buildJpeg({ width: 2401, height: 100 }), LIMITS)).toEqual({ ok: false, reason: "DIMENSIONS_EXCEEDED" });
    expect(sanitizeJpeg(buildJpeg({ width: 100, height: 2401 }), LIMITS)).toEqual({ ok: false, reason: "DIMENSIONS_EXCEEDED" });
    expect(sanitizeJpeg(buildJpeg({ width: 0, height: 100 }), LIMITS)).toEqual({ ok: false, reason: "NOT_JPEG" });
  });

  it("never throws on hostile input", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const bytes = Uint8Array.from({ length: 5 + (seed % 90) }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : (i * seed * 31) % 256));
      expect(() => sanitizeJpeg(bytes, LIMITS)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------- operator allow-list (carried over from the superseded suite, assertions unchanged)

describe("Activation operator allow-list (fail closed)", () => {
  const hilton = uuid(900);

  it("is absent — so no round can be registered — unless explicitly configured", () => {
    for (const raw of [undefined, null, "", "   ", ",,,"]) expect(parseOperatorAllowlist(raw)).toBeNull();
  });

  it("parses a list of member ids, case-insensitively and without duplicates", () => {
    const set = parseOperatorAllowlist(` ${hilton.toUpperCase()} , ${hilton}, ${uuid(901)} `);
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual([hilton, uuid(901)].sort());
  });

  it("rejects the WHOLE configuration if any entry is malformed, rather than silently dropping it", () => {
    expect(parseOperatorAllowlist(`${hilton},not-a-uuid`)).toBeNull();
    expect(parseOperatorAllowlist("*")).toBeNull();
    expect(parseOperatorAllowlist("hilton")).toBeNull();
  });
});
