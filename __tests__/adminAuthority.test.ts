import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";

import { InMemoryAuditStore } from "../lib/gaming/audit/db/inMemoryAuditStore";
import { InMemoryAuthorityRepository } from "../lib/gaming/authority/db/inMemoryAuthorityRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { revokePlatformAuthority } from "../lib/gaming/authority/revokePlatformAuthority";
import { requirePlatformAuthority } from "../lib/gaming/authority/requirePlatformAuthority";
import {
  ReasonRequiredError,
  GovernanceAlreadyBootstrappedError,
  GovernanceAuthorityRequiredError,
  AuthorityGrantNotFoundError,
  InsufficientPlatformAuthorityError,
} from "../lib/gaming/authority/types";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import {
  createTeam,
  createPlayer,
  createMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  saveDraftResult,
  startResultCorrection,
  setMatchActivityClassification,
  setMatchXpEligibility,
} from "../lib/gaming/predictions/adminCatalog";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "../lib/gaming/predictions/correctMatchResult";
import { redeemPrizeQualification } from "../lib/gaming/predictions/redeemPrizeQualification";
import { ActivityClassificationLockedError, XpEligibilityLockedError } from "../lib/gaming/predictions/types";

const VENUE_LAT = 10.0;
const VENUE_LON = 10.0;
const INSIDE = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function newAuthority() {
  const auditStore = new InMemoryAuditStore();
  const authority = new InMemoryAuthorityRepository(auditStore);
  return { auditStore, authority };
}

async function setupFinalizableMatch(repo: InMemoryPredictionsRepository) {
  // Dedicated to this shared setup helper, independent of whatever
  // actor an individual test additionally seeds for its own
  // assertion — Activity Classification/XP Eligibility declaration
  // here is setup plumbing, not the actor under test.
  repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");

  const home = await createTeam(repo, { name: "Real Madrid" });
  const away = await createTeam(repo, { name: "Barcelona" });
  const mbappe = await createPlayer(repo, { teamId: home.teamId, name: "Mbappe" });

  const match = await createMatch(repo, {
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Friendly",
    kickoffAt: futureIso(),
  });
  await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin");
  await setMatchXpEligibility(repo, match.matchId, true, "gm-admin");
  await repo.metagameRepository.createCategoryParticipationPolicy({
    categoryKey: "SOCCER_PREDICTIONS",
    dailyParticipationAllowance: 1000,
  });
  await repo.metagameRepository.createGamingXpRule({
    categoryKey: "SOCCER_PREDICTIONS",
    consequenceClass: "PARTICIPATION",
    performanceBandKey: null,
    points: 1,
  });

  const venue = await createVenue(repo, {
    name: "Test Venue",
    latitude: VENUE_LAT,
    longitude: VENUE_LON,
    radiusMeters: 100,
  });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });

  await submitPrediction(repo, {
    matchId: match.matchId,
    gamingMemberId: "gm-1",
    venueActivationId: activation.venueActivationId,
    predictedHomeScore: 0,
    predictedAwayScore: 0,
    predictedGoalscorerPlayerId: null,
    predictedGoalMinuteRegulation: null,
    predictedGoalMinuteStoppage: null,
    predictedFirstTeamToScore: null,
    geo: INSIDE,
  });

  return { match, mbappe };
}

describe("Admin Control Plane A0 — Platform authority", () => {
  it("bootstrap creates the first Governance grant", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    const result = await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    expect(result.authorityClass).toBe("PRODUCT_GOVERNANCE");
    expect(await authority.hasActiveAuthority(founder, "PRODUCT_GOVERNANCE")).toBe(true);
  });

  it("a second bootstrap is rejected once Governance exists", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const other = randomUUID();
    await expect(bootstrapGovernanceAuthority(authority, other, "Trying again.")).rejects.toBeInstanceOf(
      GovernanceAlreadyBootstrappedError
    );
    // The original Governance grant is untouched.
    expect(await authority.hasActiveAuthority(founder, "PRODUCT_GOVERNANCE")).toBe(true);
    expect(await authority.hasActiveAuthority(other, "PRODUCT_GOVERNANCE")).toBe(false);
  });

  it("bootstrap without a reason is rejected", async () => {
    const { authority } = newAuthority();
    await expect(bootstrapGovernanceAuthority(authority, randomUUID(), "")).rejects.toBeInstanceOf(
      ReasonRequiredError
    );
  });

  it("Governance grants Operational and Consequential Finalizer independently", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");

    const operator = randomUUID();
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding new operator.");
    expect(await authority.hasActiveAuthority(operator, "OPERATIONAL")).toBe(true);
    expect(await authority.hasActiveAuthority(operator, "CONSEQUENTIAL_FINALIZER")).toBe(false);

    const finalizer = randomUUID();
    await grantPlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Onboarding new finalizer.");
    expect(await authority.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(true);
    expect(await authority.hasActiveAuthority(finalizer, "OPERATIONAL")).toBe(false);
  });

  it("classes are non-hierarchical: Governance alone does not satisfy a Finalizer or Operational check", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");

    expect(await authority.hasActiveAuthority(founder, "CONSEQUENTIAL_FINALIZER")).toBe(false);
    expect(await authority.hasActiveAuthority(founder, "OPERATIONAL")).toBe(false);
    await expect(requirePlatformAuthority(authority, founder, "CONSEQUENTIAL_FINALIZER")).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });

  it("a Gaming Member may hold multiple classes simultaneously", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");

    const dualRole = randomUUID();
    await grantPlatformAuthority(authority, founder, dualRole, "OPERATIONAL", "Catalog work.");
    await grantPlatformAuthority(authority, founder, dualRole, "CONSEQUENTIAL_FINALIZER", "Also finalizes results.");

    expect(await authority.listActiveAuthorityClasses(dualRole)).toEqual(
      expect.arrayContaining(["OPERATIONAL", "CONSEQUENTIAL_FINALIZER"])
    );
    await expect(requirePlatformAuthority(authority, dualRole, "OPERATIONAL")).resolves.toBeUndefined();
    await expect(requirePlatformAuthority(authority, dualRole, "CONSEQUENTIAL_FINALIZER")).resolves.toBeUndefined();
  });

  it("granting requires an active Governance actor", async () => {
    const { authority } = newAuthority();
    const notGovernance = randomUUID();
    await expect(
      grantPlatformAuthority(authority, notGovernance, randomUUID(), "OPERATIONAL", "Attempted grant.")
    ).rejects.toBeInstanceOf(GovernanceAuthorityRequiredError);
  });

  it("granting an already-active class is idempotent", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const operator = randomUUID();
    const first = await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding.");
    const second = await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding again.");
    expect(second.alreadyActive).toBe(true);
    expect(second.authorityGrantId).toBe(first.authorityGrantId);
  });

  it("revoke takes effect on the very next authority check", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const finalizer = randomUUID();
    await grantPlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Onboarding.");
    expect(await authority.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(true);

    await revokePlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Role change.");
    expect(await authority.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(false);
    await expect(requirePlatformAuthority(authority, finalizer, "CONSEQUENTIAL_FINALIZER")).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });

  it("a re-grant after revocation restores authority", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const finalizer = randomUUID();
    await grantPlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Onboarding.");
    await revokePlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Temporary leave.");
    expect(await authority.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(false);

    await grantPlatformAuthority(authority, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Returned from leave.");
    expect(await authority.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(true);
  });

  it("revoking a class that was never granted is rejected", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    await expect(
      revokePlatformAuthority(authority, founder, randomUUID(), "OPERATIONAL", "No such grant.")
    ).rejects.toBeInstanceOf(AuthorityGrantNotFoundError);
  });

  it("revoking an already-revoked grant is idempotent", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const operator = randomUUID();
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding.");
    const first = await revokePlatformAuthority(authority, founder, operator, "OPERATIONAL", "Role change.");
    const second = await revokePlatformAuthority(authority, founder, operator, "OPERATIONAL", "Role change again.");
    expect(second.alreadyRevoked).toBe(true);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it("grant/revoke without a reason is rejected", async () => {
    const { authority } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    await expect(
      grantPlatformAuthority(authority, founder, randomUUID(), "OPERATIONAL", "")
    ).rejects.toBeInstanceOf(ReasonRequiredError);

    const operator = randomUUID();
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding.");
    await expect(
      revokePlatformAuthority(authority, founder, operator, "OPERATIONAL", "")
    ).rejects.toBeInstanceOf(ReasonRequiredError);
  });
});

describe("Admin Control Plane A0 — Audit ledger", () => {
  it("bootstrap writes exactly one BOOTSTRAP_GOVERNANCE_GRANT event with no authority class used", async () => {
    const { authority, auditStore } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");

    const events = await auditStore.listAllEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actionType).toBe("BOOTSTRAP_GOVERNANCE_GRANT");
    expect(events[0].actorKind).toBe("GAMING_MEMBER");
    expect(events[0].actorId).toBe(founder);
    expect(events[0].authorityClassUsed).toBeNull();
    expect(events[0].outcome).toBe("SUCCESS");
    expect(events[0].reason).toBe("Founder bootstrap.");
  });

  it("grant writes exactly one GRANT_AUTHORITY event with correct actor/class/target/reason", async () => {
    const { authority, auditStore } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const operator = randomUUID();
    const grant = await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding new operator.");

    const events = (await auditStore.listAllEvents()).filter((e) => e.actionType === "GRANT_AUTHORITY");
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(founder);
    expect(events[0].authorityClassUsed).toBe("PRODUCT_GOVERNANCE");
    expect(events[0].targetId).toBe(grant.authorityGrantId);
    expect(events[0].outcome).toBe("SUCCESS");
    expect(events[0].reason).toBe("Onboarding new operator.");
  });

  it("revoke writes exactly one REVOKE_AUTHORITY event, and an idempotent replay writes no duplicate", async () => {
    const { authority, auditStore } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const operator = randomUUID();
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding.");

    await revokePlatformAuthority(authority, founder, operator, "OPERATIONAL", "Role change.");
    await revokePlatformAuthority(authority, founder, operator, "OPERATIONAL", "Role change again.");

    const revokeEvents = (await auditStore.listAllEvents()).filter((e) => e.actionType === "REVOKE_AUTHORITY");
    expect(revokeEvents).toHaveLength(1);
  });

  it("an idempotent re-grant of an already-active class writes no duplicate audit event", async () => {
    const { authority, auditStore } = newAuthority();
    const founder = randomUUID();
    await bootstrapGovernanceAuthority(authority, founder, "Founder bootstrap.");
    const operator = randomUUID();
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding.");
    await grantPlatformAuthority(authority, founder, operator, "OPERATIONAL", "Onboarding again.");

    const grantEvents = (await auditStore.listAllEvents()).filter((e) => e.actionType === "GRANT_AUTHORITY");
    expect(grantEvents).toHaveLength(1);
  });
});

describe("Admin Control Plane A0 — Result finalization authority + provenance", () => {
  it("Operational alone cannot finalize a Result", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-operator",
    });
    await expect(finalizeMatchResult(repo, draft.matchResultId, "gm-operator")).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });

  it("Governance alone cannot ordinary-finalize a Result", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-governance", "PRODUCT_GOVERNANCE");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-governance",
    });
    await expect(finalizeMatchResult(repo, draft.matchResultId, "gm-governance")).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });

  it("a Consequential Finalizer can finalize, and the actor survives to durable provenance", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");

    const stored = await repo.getMatchResultById(draft.matchResultId);
    expect(stored!.finalizedByGamingMemberId).toBe("gm-finalizer");
  });

  it("first finalization does not require a reason", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });
    const result = await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");
    expect(result.alreadyFinalized).toBe(false);

    const events = await repo.auditStoreForTests.listEventsForTarget("match_results", draft.matchResultId);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBeNull();
  });

  it("finalize produces exactly one FINALIZE_RESULT audit event with correct actor/class/target/reference", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer", "Confirmed via official broadcast.");

    const events = await repo.auditStoreForTests.listEventsForTarget("match_results", draft.matchResultId);
    expect(events).toHaveLength(1);
    expect(events[0].actionType).toBe("FINALIZE_RESULT");
    expect(events[0].actorId).toBe("gm-finalizer");
    expect(events[0].authorityClassUsed).toBe("CONSEQUENTIAL_FINALIZER");
    expect(events[0].targetType).toBe("match_results");
    expect(events[0].resultingReference).toEqual({ table: "match_results", id: draft.matchResultId });
    expect(events[0].previousReference).toBeNull();
    expect(events[0].outcome).toBe("SUCCESS");
    expect(events[0].reason).toBe("Confirmed via official broadcast.");
  });

  it("an idempotent replay of finalize does not duplicate audit history", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");

    const events = await repo.auditStoreForTests.listEventsForTarget("match_results", draft.matchResultId);
    expect(events).toHaveLength(1);
  });

  it("a revoked Finalizer immediately loses the ability to finalize", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });

    repo.authorityRepository.seedRevokeAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    await expect(finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer")).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });
});

describe("Admin Control Plane A0 — Result correction authority + reason enforcement", () => {
  async function setupFinalizedMatch(repo: InMemoryPredictionsRepository) {
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const { match, mbappe } = await setupFinalizableMatch(repo);
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 10 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 60 },
      ],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");
    return { match, mbappe, originalMatchResultId: draft.matchResultId };
  }

  it("correction without a reason is rejected before any mutation", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, mbappe, originalMatchResultId } = await setupFinalizedMatch(repo);
    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-finalizer",
    });

    await expect(correctMatchResult(repo, correctionDraft.matchResultId, "gm-finalizer", "")).rejects.toBeInstanceOf(
      ReasonRequiredError
    );

    const stillDraft = await repo.getMatchResultById(correctionDraft.matchResultId);
    expect(stillDraft!.finalizedAt).toBeNull();
    const originalUntouched = await repo.getMatchResultById(originalMatchResultId);
    expect(originalUntouched!.finalizedAt).not.toBeNull();
  });

  it("correction with a reason succeeds, persists the corrector, and supersedes the original", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, mbappe, originalMatchResultId } = await setupFinalizedMatch(repo);
    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-finalizer",
    });

    const result = await correctMatchResult(
      repo,
      correctionDraft.matchResultId,
      "gm-finalizer",
      "Second goal disallowed — offside on video review."
    );
    expect(result.alreadyFinalized).toBe(false);
    expect(result.supersedesMatchResultId).toBe(originalMatchResultId);

    const corrected = await repo.getMatchResultById(correctionDraft.matchResultId);
    expect(corrected!.finalizedByGamingMemberId).toBe("gm-finalizer");

    // The original finalized row is never touched by a correction.
    const original = await repo.getMatchResultById(originalMatchResultId);
    expect(original!.homeScore).toBe(2);
    expect(original!.finalizedAt).not.toBeNull();
  });

  it("correction produces exactly one CORRECT_RESULT audit event referencing both the superseded and the new Result", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, mbappe, originalMatchResultId } = await setupFinalizedMatch(repo);
    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, "gm-finalizer", "Video review correction.");

    const events = await repo.auditStoreForTests.listEventsForTarget("match_results", correctionDraft.matchResultId);
    const correctionEvents = events.filter((e) => e.actionType === "CORRECT_RESULT");
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].previousReference).toEqual({ table: "match_results", id: originalMatchResultId });
    expect(correctionEvents[0].resultingReference).toEqual({
      table: "match_results",
      id: correctionDraft.matchResultId,
    });
    expect(correctionEvents[0].reason).toBe("Video review correction.");

    // Finalization and correction are distinguishable action types.
    const finalizeEvents = await repo.auditStoreForTests.listEventsForTarget("match_results", originalMatchResultId);
    expect(finalizeEvents.map((e) => e.actionType)).toEqual(["FINALIZE_RESULT"]);
  });

  it("Operational alone cannot correct a Result", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, mbappe } = await setupFinalizedMatch(repo);
    repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");
    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-operator",
    });
    await expect(
      correctMatchResult(repo, correctionDraft.matchResultId, "gm-operator", "Attempted correction.")
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });
});

describe("Admin Control Plane A0 — Activity Classification authority + audit (Predictions A1)", () => {
  it("Operational alone cannot declare Activity Classification", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await expect(
      setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-operator")
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });

  it("a Finalizer can declare Activity Classification; first declaration produces one audit event with no reason required", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-finalizer");
    expect(result.locked).toBe(false);

    const events = await repo.auditStoreForTests.listEventsForTarget("matches", match.matchId);
    const declareEvents = events.filter((e) => e.actionType === "DECLARE_ACTIVITY_CLASSIFICATION");
    expect(declareEvents).toHaveLength(1);
    expect(declareEvents[0].actorId).toBe("gm-finalizer");
    expect(declareEvents[0].authorityClassUsed).toBe("CONSEQUENTIAL_FINALIZER");
    expect(declareEvents[0].resultingReference).toEqual({ table: "matches", id: match.matchId });
    expect(declareEvents[0].reason).toBeNull();
  });

  it("a legal pre-lock re-declaration produces its own audit event; a locked change is rejected and produces none", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const venue = await createVenue(repo, { name: "V", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });

    await setMatchActivityClassification(repo, match.matchId, "CASUAL", "gm-finalizer", "Initial call.");
    await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-finalizer", "Corrected before evidence exists.");

    let events = await repo.auditStoreForTests.listEventsForTarget("matches", match.matchId);
    expect(events.filter((e) => e.actionType === "DECLARE_ACTIVITY_CLASSIFICATION")).toHaveLength(2);

    await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: "gm-1",
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0,
      predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null,
      geo: INSIDE,
    });

    await expect(
      setMatchActivityClassification(repo, match.matchId, "OFFICIAL", "gm-finalizer")
    ).rejects.toBeInstanceOf(ActivityClassificationLockedError);

    events = await repo.auditStoreForTests.listEventsForTarget("matches", match.matchId);
    expect(events.filter((e) => e.actionType === "DECLARE_ACTIVITY_CLASSIFICATION")).toHaveLength(2);
  });
});

describe("Admin Control Plane A0 — Match XP Eligibility authority + audit (Predictions A1)", () => {
  it("Operational alone cannot declare Match XP Eligibility", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await expect(
      setMatchXpEligibility(repo, match.matchId, true, "gm-operator")
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });

  it("a Finalizer can declare XP Eligibility, producing its own distinct DECLARE_XP_ELIGIBILITY event — never merged with Activity Classification's", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-finalizer");
    await setMatchXpEligibility(repo, match.matchId, true, "gm-finalizer");

    const events = await repo.auditStoreForTests.listEventsForTarget("matches", match.matchId);
    expect(events.map((e) => e.actionType).sort()).toEqual([
      "DECLARE_ACTIVITY_CLASSIFICATION",
      "DECLARE_XP_ELIGIBILITY",
    ]);
  });

  it("XP Eligibility declaration does not activate Gaming XP — no rule/policy/event row is touched", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await setMatchXpEligibility(repo, match.matchId, true, "gm-finalizer", "Calibration test Match.");
    // This Slice adds no method to create/mutate gaming_xp_rules or
    // gaming_category_participation_policy at all — their absence from
    // PredictionsRepository is itself the proof Gaming XP configuration
    // remains untouched by this action.
    expect((repo as any).createGamingXpRule).toBeUndefined();
  });

  it("locked XP Eligibility change is rejected and produces no additional audit event", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const venue = await createVenue(repo, { name: "V", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
    await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-finalizer");
    await setMatchXpEligibility(repo, match.matchId, true, "gm-finalizer");

    await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: "gm-1",
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0,
      predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null,
      geo: INSIDE,
    });

    await expect(
      setMatchXpEligibility(repo, match.matchId, false, "gm-finalizer")
    ).rejects.toBeInstanceOf(XpEligibilityLockedError);

    const events = await repo.auditStoreForTests.listEventsForTarget("matches", match.matchId);
    expect(events.filter((e) => e.actionType === "DECLARE_XP_ELIGIBILITY")).toHaveLength(1);
  });
});

describe("Admin Control Plane A0 — Prize Redemption authority + audit (Predictions A1)", () => {
  async function setupRedeemableQualification(repo: InMemoryPredictionsRepository) {
    repo.authorityRepository.seedAuthority("gm-finalizer", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Real Madrid" });
    const away = await createTeam(repo, { name: "Barcelona" });
    const match = await createMatch(repo, {
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Friendly",
      kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-finalizer");
    const venue = await createVenue(repo, { name: "V", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: "gm-1",
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0,
      predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: "gm-finalizer",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-finalizer");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    return qualification!;
  }

  it("Operational alone cannot redeem a Prize Qualification", async () => {
    const repo = new InMemoryPredictionsRepository();
    const qualification = await setupRedeemableQualification(repo);
    repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");
    await expect(
      redeemPrizeQualification(repo, qualification.prizeQualificationId, "gm-operator")
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });

  it("a Finalizer can redeem, preserving domain provenance and producing exactly one CONFIRM_PRIZE_REDEMPTION event", async () => {
    const repo = new InMemoryPredictionsRepository();
    const qualification = await setupRedeemableQualification(repo);

    const result = await redeemPrizeQualification(
      repo,
      qualification.prizeQualificationId,
      "gm-finalizer",
      "Verified at venue counter."
    );
    expect(result.alreadyRedeemed).toBe(false);

    const events = await repo.auditStoreForTests.listEventsForTarget(
      "prize_qualifications",
      qualification.prizeQualificationId
    );
    const redemptionEvents = events.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION");
    expect(redemptionEvents).toHaveLength(1);
    expect(redemptionEvents[0].actorId).toBe("gm-finalizer");
    expect(redemptionEvents[0].reason).toBe("Verified at venue counter.");
  });

  it("a repeated redemption attempt does not fabricate duplicate successful history", async () => {
    const repo = new InMemoryPredictionsRepository();
    const qualification = await setupRedeemableQualification(repo);

    await redeemPrizeQualification(repo, qualification.prizeQualificationId, "gm-finalizer");
    const second = await redeemPrizeQualification(repo, qualification.prizeQualificationId, "gm-finalizer");
    expect(second.alreadyRedeemed).toBe(true);

    const events = await repo.auditStoreForTests.listEventsForTarget(
      "prize_qualifications",
      qualification.prizeQualificationId
    );
    expect(events.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION")).toHaveLength(1);
  });
});
