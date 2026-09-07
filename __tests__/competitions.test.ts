import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted by Vitest above every import in this file. Mocks the ONE module
// boundary between an app/api/gaming/competitions/* route and the outside
// world (credentials, repository construction, caller identity resolution,
// error-status mapping) — the narrow fake this correction calls for at the
// route boundary, mirroring the fake CompetitionsRepository used above at
// the command boundary. statusForCompetitionsError keeps its REAL
// implementation (via importActual) since it is pure, Competitions-owned
// logic worth exercising for real, not faking.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
  };
});

import type { CompetitionsRepository } from "../lib/gaming/competitions/db/competitionsRepository";
import type {
  CompetitionRecord,
  CompetitionTeamRecord,
  CompetitionFixtureRecord,
  CompetitionRosterRevisionRecord,
  CompetitionJoinRequestRecord,
} from "../lib/gaming/competitions/types";

import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { organizerReviewJoinRequest } from "../lib/gaming/competitions/organizerReviewJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { checkIn } from "../lib/gaming/competitions/checkIn";
import type { CompetitionMemberParticipationRecord } from "../lib/gaming/competitions/types";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { raiseDispute } from "../lib/gaming/competitions/raiseDispute";
import { correctFixture } from "../lib/gaming/competitions/correctFixture";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import { statusForCompetitionsError } from "../lib/gaming/competitions/httpAuth";
import {
  CompetitionNotFoundError,
  CompetitionTeamNotFoundError,
  JoinRequestNotFoundError,
  FixtureNotFoundError,
  EvidenceMissingError,
  CompetitionAccessDeniedError,
  OperationalAuthorityRequiredError,
  NotTeamCaptainError,
  ScorekeeperConflictOfInterestError,
  CompetitionNotDraftError,
  CompetitionNotPublishedError,
  JoinRequestNotPendingError,
  JoinRequestNotRejectedError,
  JoinRequestAlreadyReviewedError,
  FixtureNotOpenForRosterError,
  FixtureNotReadyForCheckinError,
  FixtureNotInEvidencePhaseError,
  FixtureNotReadyToFinalizeError,
  AlreadyTeamMemberError,
  DuplicatePendingJoinRequestError,
  CompetitionRegistrationRequiredError,
  NotOnRosterError,
  RosterMemberNotApprovedError,
  ShootoutRequiredError,
  EvidenceParticipantNotAttestedError,
  RegulationScoreEventMismatchError,
  MinimumParticipationNotMetError,
  EmptyRosterError,
  DuplicateRosterEntryError,
  ReasonRequiredError,
  InvalidDecisionError,
  InvalidScoreError,
  InvalidShootoutWinnerError,
  InvalidGoalTeamError,
  InvalidAssistError,
  InvalidForfeitingTeamError,
  CompetitionTeamCountInvalidError,
  CompetitionPairingInvalidError,
  UnsupportedActivityKeyError,
  UnsupportedTargetFactTypeError,
  TargetFactNotFoundError,
  TargetFactFixtureMismatchError,
  TargetFactNotCurrentError,
  DisputeNotAuthorizedError,
} from "../lib/gaming/competitions/types";
import { readFileSync } from "node:fs";

/**
 * URBANO Gaming Competitions — targeted behavioral coverage (UG-CR-
 * RPT-030 correction 2). Deliberately NOT an in-memory reimplementation
 * of Postgres semantics (advisory locks, partial unique indexes, atomic
 * multi-table cascades remain the real-local-Postgres contract suite's
 * job — __tests__/competitionsSupabaseRepository.contract.test.ts). This
 * file instead uses a narrow, hand-written CompetitionsRepository fake
 * at the command/route boundary: every method is a vi.fn() the test
 * configures per-case, proving (a) each thin command handler maps its
 * own arguments onto the correct repository method call, one-for-one,
 * with nothing added, dropped, or reordered; (b) getCompetitionView's
 * role-aware projection and privacy behavior — the one piece of real
 * Competitions-specific logic that lives in TypeScript, not SQL;
 * (c) the domain-error -> HTTP-status mapping table is complete and
 * correct for every one of the ~35 typed errors; (d) — via
 * vitest.config.ts's new "@/" alias resolution, added specifically for
 * this correction — that the actual route handlers under app/api/gaming/
 * competitions/ never forward a client-supplied actor, authority,
 * winner, timestamp, or terminal-state field to the repository, and
 * reject malformed request bodies before ever calling it.
 *
 * "Authenticated actor derivation" itself (resolveGamingAuth's own
 * guest/invalid_token/profile_incomplete/authenticated state machine) is
 * NOT re-tested here: it is shared platform code, already covered with
 * fakes in __tests__/gamingMember.test.ts, and Competitions' own
 * requireGamingMember (lib/gaming/competitions/httpAuth.ts) is a direct,
 * one-line passthrough to it with no Competitions-specific branching of
 * its own to exercise.
 */

function makeFakeRepository(): CompetitionsRepository {
  return {
    createCompetition: vi.fn(),
    addCompetitionTeam: vi.fn(),
    publishCompetition: vi.fn(),
    registerForCompetition: vi.fn(),
    requestJoinTeam: vi.fn(),
    decideJoinRequest: vi.fn(),
    organizerReviewJoinRequest: vi.fn(),
    declareRoster: vi.fn(),
    checkIn: vi.fn(),
    appointScorekeeper: vi.fn(),
    submitFixtureEvidence: vi.fn(),
    raiseDispute: vi.fn(),
    correctFixture: vi.fn(),
    finalizeFixture: vi.fn(),
    forfeitFixture: vi.fn(),
    voidFixture: vi.fn(),
    listCompetitions: vi.fn(),
    getCompetitionById: vi.fn(),
    getCompetitionTeams: vi.fn(),
    getCompetitionTeamById: vi.fn(),
    getCompetitionFixtures: vi.fn(),
    getFixtureById: vi.fn(),
    getMyRegistration: vi.fn(),
    getMyTeamMembership: vi.fn(),
    getMyPendingJoinRequest: vi.fn(),
    getPendingJoinRequestsForTeam: vi.fn(),
    getCurrentRoster: vi.fn(),
    getCheckIns: vi.fn(),
    getCurrentAttestations: vi.fn(),
    getCurrentEvidence: vi.fn(),
    getCurrentGoalEvents: vi.fn(),
    getCurrentAssistEvents: vi.fn(),
    getCurrentShootout: vi.fn(),
    getDisputes: vi.fn(),
    getCurrentFinalization: vi.fn(),
    getMemberParticipationRecords: vi.fn(),
  };
}

describe("Competitions command handlers — input mapping onto the repository (UG-CR-RPT-030 correction 2)", () => {
  let repo: CompetitionsRepository;

  beforeEach(() => {
    repo = makeFakeRepository();
  });

  it("createCompetition maps onto repo.createCompetition exactly", async () => {
    await createCompetition(repo, "org-1", "Cup", "SOCCER_5V5");
    expect(repo.createCompetition).toHaveBeenCalledWith("org-1", "Cup", "SOCCER_5V5");
    expect(repo.createCompetition).toHaveBeenCalledTimes(1);
  });

  it("addCompetitionTeam maps onto repo.addCompetitionTeam exactly", async () => {
    await addCompetitionTeam(repo, "comp-1", "org-1", "Team A", "cap-1");
    expect(repo.addCompetitionTeam).toHaveBeenCalledWith("comp-1", "org-1", "Team A", "cap-1");
  });

  it("publishCompetition maps onto repo.publishCompetition exactly, preserving argument order", async () => {
    await publishCompetition(repo, "comp-1", "org-1", "ta1", "tb1", "ta2", "tb2", "t1", "t2", "t3");
    expect(repo.publishCompetition).toHaveBeenCalledWith("comp-1", "org-1", "ta1", "tb1", "ta2", "tb2", "t1", "t2", "t3");
  });

  it("registerForCompetition maps onto repo.registerForCompetition exactly", async () => {
    await registerForCompetition(repo, "comp-1", "mem-1", true);
    expect(repo.registerForCompetition).toHaveBeenCalledWith("comp-1", "mem-1", true);
  });

  it("requestJoinTeam maps onto repo.requestJoinTeam exactly", async () => {
    await requestJoinTeam(repo, "comp-1", "team-1", "mem-1");
    expect(repo.requestJoinTeam).toHaveBeenCalledWith("comp-1", "team-1", "mem-1");
  });

  it("decideJoinRequest maps onto repo.decideJoinRequest exactly", async () => {
    await decideJoinRequest(repo, "jr-1", "cap-1", "APPROVE", false);
    expect(repo.decideJoinRequest).toHaveBeenCalledWith("jr-1", "cap-1", "APPROVE", false);
  });

  it("organizerReviewJoinRequest maps onto repo.organizerReviewJoinRequest exactly", async () => {
    await organizerReviewJoinRequest(repo, "jr-1", "org-1", "REJECT", "reason");
    expect(repo.organizerReviewJoinRequest).toHaveBeenCalledWith("jr-1", "org-1", "REJECT", "reason");
  });

  it("declareRoster maps onto repo.declareRoster exactly, including a null reason", async () => {
    await declareRoster(repo, "fx-1", "team-1", "cap-1", false, null, ["m1", "m2"]);
    expect(repo.declareRoster).toHaveBeenCalledWith("fx-1", "team-1", "cap-1", false, null, ["m1", "m2"]);
  });

  it("checkIn maps onto repo.checkIn exactly", async () => {
    await checkIn(repo, "fx-1", "mem-1");
    expect(repo.checkIn).toHaveBeenCalledWith("fx-1", "mem-1");
  });

  it("appointScorekeeper maps onto repo.appointScorekeeper exactly", async () => {
    await appointScorekeeper(repo, "fx-1", "org-1", "sk-1");
    expect(repo.appointScorekeeper).toHaveBeenCalledWith("fx-1", "org-1", "sk-1");
  });

  it("submitFixtureEvidence maps onto repo.submitFixtureEvidence exactly, including empty arrays and a null shootout", async () => {
    await submitFixtureEvidence(repo, "fx-1", "sk-1", 2, 1, [], [], [], null);
    expect(repo.submitFixtureEvidence).toHaveBeenCalledWith("fx-1", "sk-1", 2, 1, [], [], [], null);
  });

  it("raiseDispute maps onto repo.raiseDispute exactly", async () => {
    await raiseDispute(repo, "fx-1", "mem-1", "SCORE", "fact-1", "reason");
    expect(repo.raiseDispute).toHaveBeenCalledWith("fx-1", "mem-1", "SCORE", "fact-1", "reason");
  });

  it("correctFixture maps onto repo.correctFixture exactly", async () => {
    await correctFixture(repo, "fx-1", "org-1", "reason", 1, 1, [], [], "team-a");
    expect(repo.correctFixture).toHaveBeenCalledWith("fx-1", "org-1", "reason", 1, 1, [], [], "team-a");
  });

  it("finalizeFixture maps onto repo.finalizeFixture exactly — no winner/timestamp/outcome parameter exists to pass through", async () => {
    await finalizeFixture(repo, "fx-1", "org-1");
    expect(repo.finalizeFixture).toHaveBeenCalledWith("fx-1", "org-1");
  });

  it("forfeitFixture maps onto repo.forfeitFixture exactly", async () => {
    await forfeitFixture(repo, "fx-1", "org-1", "team-a", "reason");
    expect(repo.forfeitFixture).toHaveBeenCalledWith("fx-1", "org-1", "team-a", "reason");
  });

  it("voidFixture maps onto repo.voidFixture exactly", async () => {
    await voidFixture(repo, "fx-1", "org-1", "reason");
    expect(repo.voidFixture).toHaveBeenCalledWith("fx-1", "org-1", "reason");
  });
});

describe("statusForCompetitionsError — complete domain-error to HTTP-status mapping (UG-CR-RPT-030 correction 2)", () => {
  const NOT_FOUND: [string, Error][] = [
    ["CompetitionNotFoundError", new CompetitionNotFoundError()],
    ["CompetitionTeamNotFoundError", new CompetitionTeamNotFoundError()],
    ["JoinRequestNotFoundError", new JoinRequestNotFoundError()],
    ["FixtureNotFoundError", new FixtureNotFoundError()],
    ["EvidenceMissingError", new EvidenceMissingError()],
    ["TargetFactNotFoundError", new TargetFactNotFoundError()],
  ];
  const FORBIDDEN: [string, Error][] = [
    ["CompetitionAccessDeniedError", new CompetitionAccessDeniedError()],
    ["OperationalAuthorityRequiredError", new OperationalAuthorityRequiredError()],
    ["NotTeamCaptainError", new NotTeamCaptainError()],
    ["ScorekeeperConflictOfInterestError", new ScorekeeperConflictOfInterestError()],
    ["DisputeNotAuthorizedError", new DisputeNotAuthorizedError()],
  ];
  const CONFLICT: [string, Error][] = [
    ["CompetitionNotDraftError", new CompetitionNotDraftError()],
    ["CompetitionNotPublishedError", new CompetitionNotPublishedError()],
    ["JoinRequestNotPendingError", new JoinRequestNotPendingError()],
    ["JoinRequestNotRejectedError", new JoinRequestNotRejectedError()],
    ["JoinRequestAlreadyReviewedError", new JoinRequestAlreadyReviewedError()],
    ["FixtureNotOpenForRosterError", new FixtureNotOpenForRosterError()],
    ["FixtureNotReadyForCheckinError", new FixtureNotReadyForCheckinError()],
    ["FixtureNotInEvidencePhaseError", new FixtureNotInEvidencePhaseError()],
    ["FixtureNotReadyToFinalizeError", new FixtureNotReadyToFinalizeError()],
    ["AlreadyTeamMemberError", new AlreadyTeamMemberError()],
    ["DuplicatePendingJoinRequestError", new DuplicatePendingJoinRequestError()],
    ["CompetitionRegistrationRequiredError", new CompetitionRegistrationRequiredError()],
    ["NotOnRosterError", new NotOnRosterError()],
    ["RosterMemberNotApprovedError", new RosterMemberNotApprovedError()],
    ["ShootoutRequiredError", new ShootoutRequiredError()],
    ["EvidenceParticipantNotAttestedError", new EvidenceParticipantNotAttestedError()],
    ["RegulationScoreEventMismatchError", new RegulationScoreEventMismatchError()],
    ["MinimumParticipationNotMetError", new MinimumParticipationNotMetError()],
    ["TargetFactNotCurrentError", new TargetFactNotCurrentError()],
  ];
  const BAD_REQUEST: [string, Error][] = [
    ["EmptyRosterError", new EmptyRosterError()],
    ["DuplicateRosterEntryError", new DuplicateRosterEntryError()],
    ["ReasonRequiredError", new ReasonRequiredError()],
    ["InvalidDecisionError", new InvalidDecisionError()],
    ["InvalidScoreError", new InvalidScoreError()],
    ["InvalidShootoutWinnerError", new InvalidShootoutWinnerError()],
    ["InvalidGoalTeamError", new InvalidGoalTeamError()],
    ["InvalidAssistError", new InvalidAssistError()],
    ["InvalidForfeitingTeamError", new InvalidForfeitingTeamError()],
    ["CompetitionTeamCountInvalidError", new CompetitionTeamCountInvalidError("x")],
    ["CompetitionPairingInvalidError", new CompetitionPairingInvalidError("x")],
    ["UnsupportedActivityKeyError", new UnsupportedActivityKeyError()],
    ["UnsupportedTargetFactTypeError", new UnsupportedTargetFactTypeError()],
    ["TargetFactFixtureMismatchError", new TargetFactFixtureMismatchError()],
  ];

  it.each(NOT_FOUND)("%s maps to 404", (_name, err) => {
    expect(statusForCompetitionsError(err)).toBe(404);
  });
  it.each(FORBIDDEN)("%s maps to 403", (_name, err) => {
    expect(statusForCompetitionsError(err)).toBe(403);
  });
  it.each(CONFLICT)("%s maps to 409", (_name, err) => {
    expect(statusForCompetitionsError(err)).toBe(409);
  });
  it.each(BAD_REQUEST)("%s maps to 400", (_name, err) => {
    expect(statusForCompetitionsError(err)).toBe(400);
  });

  it("an unrecognized error maps to null (the route falls through to a generic 500, never a misleading domain status)", () => {
    expect(statusForCompetitionsError(new Error("something else"))).toBeNull();
  });

  it("this file's own four buckets cover every exported Competitions error class (fails loudly if a new error class is added without updating this test)", async () => {
    const typesModule = await import("../lib/gaming/competitions/types");
    const exportedErrorNames = Object.keys(typesModule).filter((key) => key.endsWith("Error"));
    const coveredNames = new Set([...NOT_FOUND, ...FORBIDDEN, ...CONFLICT, ...BAD_REQUEST].map(([name]) => name));
    const uncovered = exportedErrorNames.filter((name) => !coveredNames.has(name));
    expect(uncovered).toEqual([]);
  });
});

function fixture(overrides: Partial<CompetitionFixtureRecord>): CompetitionFixtureRecord {
  return {
    competitionFixtureId: "fx-1", competitionId: "comp-1", fixtureRole: "SEMIFINAL_1", scheduledAt: "2026-01-01T00:00:00Z",
    teamACompetitionTeamId: "team-a", teamBCompetitionTeamId: "team-b", teamASourceFixtureId: null, teamBSourceFixtureId: null,
    state: "SCHEDULED", scorekeeperGamingMemberId: null, createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function roster(overrides: Partial<CompetitionRosterRevisionRecord>): CompetitionRosterRevisionRecord {
  return {
    competitionRosterRevisionId: "rev-1", competitionFixtureId: "fx-1", competitionTeamId: "team-a",
    declaredByGamingMemberId: "cap-1", declaredAt: "2026-01-01T00:00:00Z", reason: null, supersedesRevisionId: null,
    isCurrent: true, gamingMemberIds: ["m1", "m2"],
    ...overrides,
  };
}

describe("getCompetitionView — role-aware projection and privacy behavior (UG-CR-RPT-030 correction 2)", () => {
  let repo: CompetitionsRepository;

  beforeEach(() => {
    repo = makeFakeRepository();
    (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "PUBLISHED", cancelledReason: null, createdAt: "x", publishedAt: "x" } satisfies CompetitionRecord);
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([] as CompetitionTeamRecord[]);
    (repo.getMyRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getMyPendingJoinRequest as ReturnType<typeof vi.fn>).mockResolvedValue(null as CompetitionJoinRequestRecord | null);
    (repo.getMemberParticipationRecords as ReturnType<typeof vi.fn>).mockResolvedValue([] as CompetitionMemberParticipationRecord[]);
    (repo.getCurrentRoster as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getCurrentEvidence as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getCurrentGoalEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (repo.getCurrentAssistEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (repo.getCurrentFinalization as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getCurrentAttestations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("throws CompetitionNotFoundError when the competition does not exist, before touching any other repository method", async () => {
    (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(getCompetitionView(repo, "comp-1", "mem-1")).rejects.toBeInstanceOf(CompetitionNotFoundError);
    expect(repo.getCompetitionTeams).not.toHaveBeenCalled();
  });

  it("a SCHEDULED fixture exposes no score/goals/assists/finalization even if the repository has that data — the gate is checked, not merely the value", async () => {
    (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ state: "SCHEDULED" })]);
    (repo.getCurrentEvidence as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionFixtureEvidenceId: "ev-1", competitionFixtureId: "fx-1", teamAScore: 5, teamBScore: 0, enteredByGamingMemberId: "sk-1", enteredAt: "x", supersedesEvidenceId: null, isCurrent: true });

    const view = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(view.fixtures[0].score).toBeNull();
    expect(view.fixtures[0].goalScorers).toBeNull();
    expect(view.fixtures[0].finalization).toBeNull();
    // Never even queried — the withholding is structural, not a value filtered out after fetching.
    expect(repo.getCurrentEvidence).not.toHaveBeenCalled();
    expect(repo.getCurrentFinalization).not.toHaveBeenCalled();
  });

  it.each(["EVIDENCE_SUBMITTED", "UNDER_REVIEW", "FINALIZED", "CORRECTED_AND_FINALIZED", "FORFEIT_FINALIZED"] as const)(
    "a %s fixture exposes the score once evidence exists",
    async (state) => {
      (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ state })]);
      (repo.getCurrentEvidence as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionFixtureEvidenceId: "ev-1", competitionFixtureId: "fx-1", teamAScore: 2, teamBScore: 1, enteredByGamingMemberId: "sk-1", enteredAt: "x", supersedesEvidenceId: null, isCurrent: true });

      const view = await getCompetitionView(repo, "comp-1", "mem-1");
      expect(view.fixtures[0].score).toEqual({ competitionFixtureEvidenceId: "ev-1", teamAScore: 2, teamBScore: 1 });
    }
  );

  it("a member with no team membership sees myRoster: null and opponentRosterDeclared: false, and never queries any roster at all", async () => {
    (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({})]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const view = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(view.fixtures[0].myRoster).toBeNull();
    expect(view.fixtures[0].opponentRosterDeclared).toBe(false);
    expect(repo.getCurrentRoster).not.toHaveBeenCalled();
  });

  it("a member sees their OWN team's roster member list, but the opponent's roster is exposed only as a boolean — never a member list", async () => {
    (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ teamACompetitionTeamId: "team-a", teamBCompetitionTeamId: "team-b" })]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamMembershipId: "cm-1", competitionId: "comp-1", competitionTeamId: "team-a", gamingMemberId: "mem-1", approvedAt: "x", approvedByGamingMemberId: "org-1" });
    (repo.getCurrentRoster as ReturnType<typeof vi.fn>).mockImplementation(async (_fixtureId: string, teamId: string) =>
      teamId === "team-a" ? roster({ competitionTeamId: "team-a", gamingMemberIds: ["mem-1", "mem-2", "mem-3", "mem-4"] })
        : teamId === "team-b" ? roster({ competitionTeamId: "team-b", gamingMemberIds: ["opp-1", "opp-2", "opp-3", "opp-4"] })
        : null
    );

    const view = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(view.fixtures[0].myRoster).toEqual(["mem-1", "mem-2", "mem-3", "mem-4"]);
    expect(view.fixtures[0].opponentRosterDeclared).toBe(true);
    const serialized = JSON.stringify(view.fixtures[0]);
    expect(serialized).not.toContain("opp-1");
    expect(serialized).not.toContain("opp-2");
  });

  describe("myDisputableFacts — the viewer's own current disputable facts only (UG-CR-GATE-033)", () => {
    it("is null outside evidence-visible states, and no attestation/goal/assist query is even made", async () => {
      (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ state: "ROSTER_DECLARED" })]);

      const view = await getCompetitionView(repo, "comp-1", "mem-1");
      expect(view.fixtures[0].myDisputableFacts).toBeNull();
      expect(repo.getCurrentAttestations).not.toHaveBeenCalled();
    });

    it("exposes only the caller's OWN participation attestation id, goal event id, and assist event id", async () => {
      (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ state: "FINALIZED" })]);
      (repo.getCurrentAttestations as ReturnType<typeof vi.fn>).mockResolvedValue([
        { competitionParticipationAttestationId: "att-mine", competitionFixtureId: "fx-1", gamingMemberId: "mem-1", actuallyParticipated: true, attestedByGamingMemberId: "sk-1", attestedAt: "x", supersedesAttestationId: null, isCurrent: true },
        { competitionParticipationAttestationId: "att-other", competitionFixtureId: "fx-1", gamingMemberId: "opp-1", actuallyParticipated: true, attestedByGamingMemberId: "sk-1", attestedAt: "x", supersedesAttestationId: null, isCurrent: true },
      ]);
      (repo.getCurrentGoalEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
        { soccerGoalEventId: "goal-mine", competitionFixtureId: "fx-1", scorerGamingMemberId: "mem-1", competitionTeamId: "team-a", enteredByGamingMemberId: "sk-1", enteredAt: "x", isCurrent: true },
        { soccerGoalEventId: "goal-other", competitionFixtureId: "fx-1", scorerGamingMemberId: "opp-1", competitionTeamId: "team-b", enteredByGamingMemberId: "sk-1", enteredAt: "x", isCurrent: true },
      ]);
      (repo.getCurrentAssistEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
        { soccerAssistEventId: "assist-mine", competitionFixtureId: "fx-1", assistingGamingMemberId: "mem-1", assistedGoalEventId: "goal-other", enteredByGamingMemberId: "sk-1", enteredAt: "x", isCurrent: true },
        { soccerAssistEventId: "assist-other", competitionFixtureId: "fx-1", assistingGamingMemberId: "opp-1", assistedGoalEventId: "goal-mine", enteredByGamingMemberId: "sk-1", enteredAt: "x", isCurrent: true },
      ]);

      const view = await getCompetitionView(repo, "comp-1", "mem-1");
      expect(view.fixtures[0].myDisputableFacts).toEqual({
        participationAttestationId: "att-mine",
        goalEventIds: ["goal-mine"],
        assistEventIds: ["assist-mine"],
      });
      const serialized = JSON.stringify(view.fixtures[0].myDisputableFacts);
      expect(serialized).not.toContain("att-other");
      expect(serialized).not.toContain("assist-other");
      // "goal-other" is legitimately absent (never our own), so this also proves
      // the opponent's own goal event id never leaked into OUR disputable-facts list.
      expect(serialized).not.toContain("goal-other");
    });

    it("returns null/empty fields (never throws, never a placeholder id) for a viewer with no facts of their own in this fixture", async () => {
      (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([fixture({ state: "FINALIZED" })]);
      (repo.getCurrentAttestations as ReturnType<typeof vi.fn>).mockResolvedValue([
        { competitionParticipationAttestationId: "att-other", competitionFixtureId: "fx-1", gamingMemberId: "opp-1", actuallyParticipated: true, attestedByGamingMemberId: "sk-1", attestedAt: "x", supersedesAttestationId: null, isCurrent: true },
      ]);

      const view = await getCompetitionView(repo, "comp-1", "mem-1");
      expect(view.fixtures[0].myDisputableFacts).toEqual({ participationAttestationId: null, goalEventIds: [], assistEventIds: [] });
    });
  });
});

describe("Competitions API routes — client-supplied field rejection and malformed-request validation (UG-CR-RPT-030 correction 2)", () => {
  // Enabled by vitest.config.ts's new "@/" alias — without it, no route
  // file with a real internal import (i.e. every Competitions route) can
  // be imported by a test at all, confirmed repo-wide as a pre-existing
  // gap (see this file's header comment).
  let httpAuth: typeof import("../lib/gaming/competitions/httpAuth");
  let repo: CompetitionsRepository;

  beforeEach(async () => {
    httpAuth = await import("../lib/gaming/competitions/httpAuth");
    vi.clearAllMocks();
    repo = makeFakeRepository();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as unknown as ReturnType<typeof httpAuth.buildCompetitionsRepo>);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "auth-derived-member" });
  });

  function jsonRequest(method: string, body: unknown) {
    return new Request("http://localhost/probe", { method, headers: { authorization: "Bearer token" }, body: JSON.stringify(body) });
  }

  it("POST /competitions never forwards a client-supplied organizerGamingMemberId — the acting identity is always the one requireGamingMember resolved", async () => {
    const { POST } = await import("../app/api/gaming/competitions/route");
    (repo.createCompetition as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "c1", state: "DRAFT", createdAt: "x" });

    const res = await POST(jsonRequest("POST", { name: "Cup", activityKey: "SOCCER_5V5", organizerGamingMemberId: "attacker-supplied-id" }));

    expect(res.status).toBe(201);
    expect(repo.createCompetition).toHaveBeenCalledWith("auth-derived-member", "Cup", "SOCCER_5V5");
  });

  it("POST fixtures/[fixtureId]/finalize never reads or forwards a client-supplied winner, timestamp, or outcome type — it does not even parse a request body", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/finalize/route");
    (repo.finalizeFixture as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionFixtureFinalizationId: "f1", outcomeType: "NORMAL", winningCompetitionTeamId: "team-a", alreadyFinalized: false });

    const res = await POST(
      jsonRequest("POST", { winningCompetitionTeamId: "attacker-team", finalizedAt: "1999-01-01T00:00:00Z", outcomeType: "FORFEIT" }),
      { params: { fixtureId: "fx-1" } }
    );

    expect(res.status).toBe(201);
    expect(repo.finalizeFixture).toHaveBeenCalledWith("fx-1", "auth-derived-member");
    expect(repo.finalizeFixture).toHaveBeenCalledTimes(1);
    // The only two arguments finalizeFixture's own signature accepts —
    // there is no third parameter this call could have smuggled a
    // client-supplied winner/timestamp/outcome into even if it tried.
    expect((repo.finalizeFixture as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
  });

  it("POST fixtures/[fixtureId]/correct never forwards a client-supplied winningCompetitionTeamId or competitionState — only reason/scores/events/shootout reach the repository", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/correct/route");
    (repo.correctFixture as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionFixtureEvidenceId: "ev-2", newWinningCompetitionTeamId: "team-a", competitionState: "PUBLISHED", cascadeOutcome: "NONE" });

    const res = await POST(
      jsonRequest("POST", {
        reason: "fixing a mistake", teamAScore: 1, teamBScore: 0, goalEvents: [], assistEvents: [], penaltyShootoutWinningTeamId: null,
        winningCompetitionTeamId: "attacker-team", competitionState: "COMPLETE",
      }),
      { params: { fixtureId: "fx-1" } }
    );

    expect(res.status).toBe(200);
    expect(repo.correctFixture).toHaveBeenCalledWith("fx-1", "auth-derived-member", "fixing a mistake", 1, 0, [], [], null);
  });

  it("POST fixtures/[fixtureId]/void never forwards a client-supplied competitionState", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/void/route");
    (repo.voidFixture as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionFixtureFinalizationId: "f2", competitionState: "CANCELLED_WITHOUT_CHAMPION", alreadyFinalized: false });

    const res = await POST(jsonRequest("POST", { reason: "field unavailable", competitionState: "COMPLETE" }), { params: { fixtureId: "fx-1" } });

    expect(res.status).toBe(201);
    expect(repo.voidFixture).toHaveBeenCalledWith("fx-1", "auth-derived-member", "field unavailable");
  });

  it("rejects an unauthenticated caller before ever constructing a repository or calling it", async () => {
    const { POST } = await import("../app/api/gaming/competitions/route");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({
      errorResponse: new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }) as never,
    });

    const res = await POST(jsonRequest("POST", { name: "Cup", activityKey: "SOCCER_5V5" }));

    expect(res.status).toBe(401);
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
    expect(repo.createCompetition).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-JSON) request body with 400, never reaching the repository", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/route");
    const badRequest = new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" }, body: "not json" });

    const res = await POST(badRequest, { params: { competitionId: "comp-1" } });

    expect(res.status).toBe(400);
    expect(repo.addCompetitionTeam).not.toHaveBeenCalled();
  });

  it("rejects a request body missing a required field with 400, never reaching the repository", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/route");

    const res = await POST(jsonRequest("POST", { name: "Team Alpha" /* captainGamingMemberId missing */ }), { params: { competitionId: "comp-1" } });

    expect(res.status).toBe(400);
    expect(repo.addCompetitionTeam).not.toHaveBeenCalled();
  });

  it("maps a domain error thrown by the repository to its correct HTTP status via statusForCompetitionsError's REAL implementation", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/finalize/route");
    (repo.finalizeFixture as ReturnType<typeof vi.fn>).mockRejectedValue(new FixtureNotFoundError());

    const res = await POST(jsonRequest("POST", {}), { params: { fixtureId: "does-not-exist" } });

    expect(res.status).toBe(404);
  });

  it("maps the new MinimumParticipationNotMetError through to a 409 at the application boundary (UG-CR-RPT-030 correction 1, exposed end to end)", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/evidence/route");
    (repo.submitFixtureEvidence as ReturnType<typeof vi.fn>).mockRejectedValue(new MinimumParticipationNotMetError());

    const res = await POST(
      jsonRequest("POST", { teamAScore: 1, teamBScore: 0, goalEvents: [], assistEvents: [], participationAttestations: [], penaltyShootoutWinningTeamId: null }),
      { params: { fixtureId: "fx-1" } }
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at least 4/);
  });

  it("POST fixtures/[fixtureId]/disputes never forwards a client-supplied actor identity — raisedByGamingMemberId always comes from the authenticated session, never the request body (UG-CR-GATE-032)", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/disputes/route");
    (repo.raiseDispute as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionDisputeId: "d1", raisedAt: "2026-01-01T00:00:00Z" });

    const res = await POST(
      jsonRequest("POST", {
        targetFactType: "SCORE", targetFactId: "ev-1", reason: "wrong score",
        raisedByGamingMemberId: "attacker-supplied-id", gamingMemberId: "attacker-supplied-id",
      }),
      { params: { fixtureId: "fx-1" } }
    );

    expect(res.status).toBe(201);
    expect(repo.raiseDispute).toHaveBeenCalledWith("fx-1", "auth-derived-member", "SCORE", "ev-1", "wrong score");
  });

  it("POST fixtures/[fixtureId]/disputes rejects a malformed target type or id with 400, never reaching the repository", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/disputes/route");

    const numericType = await POST(jsonRequest("POST", { targetFactType: 123, targetFactId: "ev-1", reason: "x" }), { params: { fixtureId: "fx-1" } });
    expect(numericType.status).toBe(400);

    const missingId = await POST(jsonRequest("POST", { targetFactType: "SCORE", reason: "x" }), { params: { fixtureId: "fx-1" } });
    expect(missingId.status).toBe(400);

    expect(repo.raiseDispute).not.toHaveBeenCalled();
  });

  it("maps the new DisputeNotAuthorizedError through to a 403, and UnsupportedTargetFactTypeError through to a 400, at the application boundary (UG-CR-GATE-032, exposed end to end)", async () => {
    const { POST } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/disputes/route");

    (repo.raiseDispute as ReturnType<typeof vi.fn>).mockRejectedValue(new DisputeNotAuthorizedError());
    const denied = await POST(jsonRequest("POST", { targetFactType: "SCORE", targetFactId: "ev-1", reason: "x" }), { params: { fixtureId: "fx-1" } });
    expect(denied.status).toBe(403);

    (repo.raiseDispute as ReturnType<typeof vi.fn>).mockRejectedValue(new UnsupportedTargetFactTypeError());
    const unsupported = await POST(jsonRequest("POST", { targetFactType: "SHOOTOUT", targetFactId: "sh-1", reason: "x" }), { params: { fixtureId: "fx-1" } });
    expect(unsupported.status).toBe(400);
  });
});

describe("public/competitions.html — dispute UI does not expose an obviously unauthorized dispute action (UG-CR-GATE-032/033)", () => {
  const html = readFileSync("public/competitions.html", "utf-8");
  const adminHtml = readFileSync("public/competitions-admin.html", "utf-8");

  it("the SCORE dispute control is gated behind isCaptainOfFixtureTeam, the same variable already used to gate roster declaration to the fixture's own team captain — an ordinary member never sees it", () => {
    const gateIndex = html.indexOf('if (isCaptainOfFixtureTeam && entry.score) {\n          actions.appendChild(buildDisputeControl("the Score", "SCORE"');
    expect(gateIndex).toBeGreaterThan(-1);
  });

  it("never sends the fixture's own id as a dispute target — SCORE always targets the real evidence record's own id", () => {
    expect(html).not.toMatch(/targetFactId:\s*f\.competitionFixtureId/);
    expect(html).toContain('buildDisputeControl("the Score", "SCORE", entry.score.competitionFixtureEvidenceId)');
  });

  it("the member's own participation/goal/assist dispute controls read exclusively from entry.myDisputableFacts (the role-aware projection's own caller-scoped ids) — never an id sourced from anywhere else", () => {
    expect(html).toContain('buildDisputeControl("Your Participation", "PARTICIPATION_ATTESTATION", entry.myDisputableFacts.participationAttestationId)');
    expect(html).toMatch(/entry\.myDisputableFacts\.goalEventIds\.forEach/);
    expect(html).toMatch(/entry\.myDisputableFacts\.assistEventIds\.forEach/);
    expect(html).toMatch(/"GOAL_EVENT",\s*id/);
    expect(html).toMatch(/"ASSIST_EVENT",\s*id/);
  });

  it("a dispute submission re-fetches authoritative state on success via renderApp(), for both the SCORE control and the member's own personal-fact controls (there is exactly one dispute-submit handler, shared by every control)", () => {
    const handlerStart = html.indexOf('disputeForm.querySelector(".dispute-submit").addEventListener("click", async () => {');
    expect(handlerStart).toBeGreaterThan(-1);
    // Only one such handler should exist at all — every dispute control (SCORE
    // and each personal fact) is built by the single shared buildDisputeControl
    // helper, never a second, independently-written copy.
    expect(html.indexOf('disputeForm.querySelector(".dispute-submit").addEventListener', handlerStart + 1)).toBe(-1);
    const handlerEnd = html.indexOf("wrapEl.appendChild(disputeToggle);", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handlerBody = html.slice(handlerStart, handlerEnd);
    expect(handlerBody).toContain("renderApp()");
  });

  it("SHOOTOUT is not a selectable dispute type anywhere in either Competitions page", () => {
    expect(html).not.toContain("SHOOTOUT");
    expect(adminHtml).not.toContain("SHOOTOUT");
  });
});
