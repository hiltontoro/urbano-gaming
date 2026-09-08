import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

// Hoisted by Vitest above every import in this file. Mocks the ONE module
// boundary between an app/api/gaming/competitions/* route and the outside
// world (credentials, repository construction, caller identity resolution,
// error-status mapping) — the narrow fake this correction calls for at the
// route boundary, mirroring the fake CompetitionsRepository used above at
// the command boundary. statusForCompetitionsError AND
// requireCompetitionsSchemaReady both keep their REAL implementation (via
// importActual) — the former is pure, Competitions-owned logic worth
// exercising for real rather than faking; the latter (UG-CR-GATE-036) is
// the exact production-availability guard this file's own tests must
// prove actually runs inside each real route handler, never a re-faked
// stand-in that would just assume the wiring is correct.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

import type { CompetitionsRepository } from "../lib/gaming/competitions/db/competitionsRepository";
import type {
  CompetitionRecord,
  CompetitionTeamRecord,
  CompetitionTeamMembershipRecord,
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
import { statusForCompetitionsError, normalizeCompetitionsSchemaReady, isCompetitionsSchemaReady, requireCompetitionsSchemaReady } from "../lib/gaming/competitions/httpAuth";
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
  CompetitionNotReadyToPublishError,
  TeamRegistrationNotOpenError,
  TeamRegistrationCapacityNotReachedError,
  TeamCapacityReachedError,
  TeamDecisionAlreadyMadeError,
  DuplicateTeamNameError,
  AlreadyCaptainOrMemberError,
  TeamNotAcceptedError,
} from "../lib/gaming/competitions/types";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { proposeCompetitionTeam } from "../lib/gaming/competitions/proposeCompetitionTeam";
import { decideCompetitionTeam } from "../lib/gaming/competitions/decideCompetitionTeam";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
    openTeamRegistration: vi.fn(),
    proposeCompetitionTeam: vi.fn(),
    decideCompetitionTeam: vi.fn(),
    closeTeamRegistration: vi.fn(),
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
    getTeamMemberships: vi.fn(),
    getDisplayNames: vi.fn(),
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

  it("openTeamRegistration maps onto repo.openTeamRegistration exactly", async () => {
    await openTeamRegistration(repo, "comp-1", "org-1");
    expect(repo.openTeamRegistration).toHaveBeenCalledWith("comp-1", "org-1");
  });

  it("proposeCompetitionTeam maps onto repo.proposeCompetitionTeam exactly — the proposer id is passed straight through, never re-derived or defaulted here", async () => {
    await proposeCompetitionTeam(repo, "comp-1", "My Team", "mem-1");
    expect(repo.proposeCompetitionTeam).toHaveBeenCalledWith("comp-1", "My Team", "mem-1");
  });

  it("decideCompetitionTeam maps onto repo.decideCompetitionTeam exactly, including a null reason on APPROVE", async () => {
    await decideCompetitionTeam(repo, "team-1", "org-1", "APPROVE", null);
    expect(repo.decideCompetitionTeam).toHaveBeenCalledWith("team-1", "org-1", "APPROVE", null);
  });

  it("decideCompetitionTeam maps a REJECT reason through exactly", async () => {
    await decideCompetitionTeam(repo, "team-1", "org-1", "REJECT", "not enough players");
    expect(repo.decideCompetitionTeam).toHaveBeenCalledWith("team-1", "org-1", "REJECT", "not enough players");
  });

  it("closeTeamRegistration maps onto repo.closeTeamRegistration exactly", async () => {
    await closeTeamRegistration(repo, "comp-1", "org-1");
    expect(repo.closeTeamRegistration).toHaveBeenCalledWith("comp-1", "org-1");
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
    ["CompetitionNotReadyToPublishError", new CompetitionNotReadyToPublishError()],
    ["TeamRegistrationNotOpenError", new TeamRegistrationNotOpenError()],
    ["TeamRegistrationCapacityNotReachedError", new TeamRegistrationCapacityNotReachedError()],
    ["TeamCapacityReachedError", new TeamCapacityReachedError()],
    ["TeamDecisionAlreadyMadeError", new TeamDecisionAlreadyMadeError()],
    ["DuplicateTeamNameError", new DuplicateTeamNameError()],
    ["AlreadyCaptainOrMemberError", new AlreadyCaptainOrMemberError()],
    ["TeamNotAcceptedError", new TeamNotAcceptedError()],
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
    (repo.getTeamMemberships as ReturnType<typeof vi.fn>).mockResolvedValue([] as CompetitionTeamMembershipRecord[]);
    (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({} as Record<string, string>);
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

function team(overrides: Partial<CompetitionTeamRecord>): CompetitionTeamRecord {
  return {
    competitionTeamId: "team-1", competitionId: "comp-1", name: "Team A", captainGamingMemberId: "cap-1",
    status: "ACCEPTED", provenance: "ORGANIZER_CREATED", decidedAt: null, decidedByGamingMemberId: null,
    rejectionReason: null, createdAt: "x",
    ...overrides,
  };
}

describe("getCompetitionView — team status/provenance role-aware projection (UG-CR-RPT-041/042 §7/§10)", () => {
  let repo: CompetitionsRepository;

  beforeEach(() => {
    repo = makeFakeRepository();
    (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null } satisfies CompetitionRecord);
    (repo.getCompetitionFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (repo.getMyRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getMyPendingJoinRequest as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.getMemberParticipationRecords as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({ "cap-1": "Alice", "cap-2": "Bob", "cap-3": "Carol", "mem-1": "Dana" });
  });

  it("`teams` is ACCEPTED-only for every viewer — a PENDING or REJECTED row never appears there, organizer or not", async () => {
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([
      team({ competitionTeamId: "t-accepted", status: "ACCEPTED", captainGamingMemberId: "cap-1" }),
      team({ competitionTeamId: "t-pending", status: "PENDING_ORGANIZER_APPROVAL", captainGamingMemberId: "cap-2" }),
      team({ competitionTeamId: "t-rejected", status: "REJECTED", captainGamingMemberId: "cap-3" }),
    ]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const asOrganizer = await getCompetitionView(repo, "comp-1", "org-1");
    expect(asOrganizer.teams.map((t) => t.competitionTeamId)).toEqual(["t-accepted"]);

    const asMember = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(asMember.teams.map((t) => t.competitionTeamId)).toEqual(["t-accepted"]);
  });

  it("pendingTeamProposals and rejectedTeamProposals are empty for a non-organizer caller, and populated (with captain display names) for the organizer", async () => {
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([
      team({ competitionTeamId: "t-pending", status: "PENDING_ORGANIZER_APPROVAL", captainGamingMemberId: "cap-2", provenance: "MEMBER_PROPOSED" }),
      team({ competitionTeamId: "t-rejected", status: "REJECTED", captainGamingMemberId: "cap-3", provenance: "MEMBER_PROPOSED", rejectionReason: "Duplicate roster" }),
    ]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const asMember = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(asMember.pendingTeamProposals).toEqual([]);
    expect(asMember.rejectedTeamProposals).toEqual([]);
    expect(asMember.isOrganizer).toBe(false);

    const asOrganizer = await getCompetitionView(repo, "comp-1", "org-1");
    expect(asOrganizer.isOrganizer).toBe(true);
    expect(asOrganizer.pendingTeamProposals).toHaveLength(1);
    expect(asOrganizer.pendingTeamProposals[0].captainDisplayName).toBe("Bob");
    expect(asOrganizer.rejectedTeamProposals).toHaveLength(1);
    expect(asOrganizer.rejectedTeamProposals[0].rejectionReason).toBe("Duplicate roster");
  });

  it("myTeamProposals shows only the CALLER's own pending/rejected proposal, never another member's — proposer visibility, not organizer visibility", async () => {
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([
      team({ competitionTeamId: "t-mine-pending", status: "PENDING_ORGANIZER_APPROVAL", captainGamingMemberId: "mem-1", provenance: "MEMBER_PROPOSED" }),
      team({ competitionTeamId: "t-other-rejected", status: "REJECTED", captainGamingMemberId: "cap-3", provenance: "MEMBER_PROPOSED", rejectionReason: "Not enough players" }),
    ]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const view = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(view.myTeamProposals.map((t) => t.competitionTeamId)).toEqual(["t-mine-pending"]);
    const serialized = JSON.stringify(view.myTeamProposals);
    expect(serialized).not.toContain("Not enough players");
    expect(serialized).not.toContain("t-other-rejected");
  });

  it("an ACCEPTED team of the caller's own never appears in myTeamProposals — it is myTeamMembership's concern, not a proposal in progress", async () => {
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([
      team({ competitionTeamId: "t-mine-accepted", status: "ACCEPTED", captainGamingMemberId: "mem-1", provenance: "MEMBER_PROPOSED" }),
    ]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamMembershipId: "cm-1", competitionId: "comp-1", competitionTeamId: "t-mine-accepted", gamingMemberId: "mem-1", approvedAt: "x", approvedByGamingMemberId: "org-1" });
    (repo.getTeamMemberships as ReturnType<typeof vi.fn>).mockResolvedValue([
      { competitionTeamMembershipId: "cm-1", competitionId: "comp-1", competitionTeamId: "t-mine-accepted", gamingMemberId: "mem-1", approvedAt: "x", approvedByGamingMemberId: "org-1" },
    ]);

    const view = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(view.myTeamProposals).toEqual([]);
    expect(view.teams.map((t) => t.competitionTeamId)).toEqual(["t-mine-accepted"]);
  });

  it("myTeamMemberships lists the caller's OWN team's confirmed members with display names, and getTeamMemberships is never called when the caller has no team", async () => {
    (repo.getCompetitionTeams as ReturnType<typeof vi.fn>).mockResolvedValue([team({ competitionTeamId: "t-1", captainGamingMemberId: "cap-1" })]);
    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const noTeamView = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(noTeamView.myTeamMemberships).toEqual([]);
    expect(repo.getTeamMemberships).not.toHaveBeenCalled();

    (repo.getMyTeamMembership as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamMembershipId: "cm-1", competitionId: "comp-1", competitionTeamId: "t-1", gamingMemberId: "mem-1", approvedAt: "x", approvedByGamingMemberId: "org-1" });
    (repo.getTeamMemberships as ReturnType<typeof vi.fn>).mockResolvedValue([
      { competitionTeamMembershipId: "cm-1", competitionId: "comp-1", competitionTeamId: "t-1", gamingMemberId: "cap-1", approvedAt: "x", approvedByGamingMemberId: "org-1" },
      { competitionTeamMembershipId: "cm-2", competitionId: "comp-1", competitionTeamId: "t-1", gamingMemberId: "mem-1", approvedAt: "x", approvedByGamingMemberId: "org-1" },
    ]);

    const withTeamView = await getCompetitionView(repo, "comp-1", "mem-1");
    expect(withTeamView.myTeamMemberships).toHaveLength(2);
    expect(withTeamView.myTeamMemberships.find((m) => m.gamingMemberId === "cap-1")?.gamingMemberDisplayName).toBe("Alice");
    expect(withTeamView.myTeamMemberships.find((m) => m.gamingMemberId === "mem-1")?.gamingMemberDisplayName).toBe("Dana");
  });
});

describe("Competitions API routes — client-supplied field rejection and malformed-request validation (UG-CR-RPT-030 correction 2)", () => {
  // Enabled by vitest.config.ts's new "@/" alias — without it, no route
  // file with a real internal import (i.e. every Competitions route) can
  // be imported by a test at all, confirmed repo-wide as a pre-existing
  // gap (see this file's header comment).
  let httpAuth: typeof import("../lib/gaming/competitions/httpAuth");
  let repo: CompetitionsRepository;

  // UG-CR-GATE-036: every route handler now checks the REAL
  // requireCompetitionsSchemaReady() first (see the vi.mock above), so
  // every pre-existing test in this describe block — none of which is
  // about availability — needs COMPETITIONS_SCHEMA_READY="true" simply to
  // reach the code it actually means to exercise. Captured/restored
  // around the whole describe block so this file never leaks a changed
  // environment variable into any other test file's own process, and
  // reset to "true" again in every beforeEach so a single test that
  // deliberately disables it (see the dedicated guard describe below)
  // can never leave a later test order-dependent on that disabling.
  const ORIGINAL_COMPETITIONS_SCHEMA_READY = process.env.COMPETITIONS_SCHEMA_READY;

  afterAll(() => {
    if (ORIGINAL_COMPETITIONS_SCHEMA_READY === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
    else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL_COMPETITIONS_SCHEMA_READY;
  });

  beforeEach(async () => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
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

  describe("POST .../teams/propose — PROPOSE_COMPETITION_TEAM (UG-CR-RPT-041/042 §7)", () => {
    it("never forwards a client-supplied proposer/captain identity — the acting identity is always the one requireGamingMember resolved", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/propose/route");
      (repo.proposeCompetitionTeam as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamId: "t1", status: "PENDING_ORGANIZER_APPROVAL", createdAt: "x" });

      const res = await POST(jsonRequest("POST", { name: "My Team", captainGamingMemberId: "attacker-supplied-id", status: "ACCEPTED" }), { params: { competitionId: "comp-1" } });

      expect(res.status).toBe(201);
      expect(repo.proposeCompetitionTeam).toHaveBeenCalledWith("comp-1", "My Team", "auth-derived-member");
    });

    it("rejects a malformed (non-JSON) body with 400, never reaching the repository", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/propose/route");
      const badRequest = new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" }, body: "not json" });

      const res = await POST(badRequest, { params: { competitionId: "comp-1" } });

      expect(res.status).toBe(400);
      expect(repo.proposeCompetitionTeam).not.toHaveBeenCalled();
    });

    it("rejects a missing or blank team name with 400, never reaching the repository", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/propose/route");

      const missing = await POST(jsonRequest("POST", {}), { params: { competitionId: "comp-1" } });
      const blank = await POST(jsonRequest("POST", { name: "   " }), { params: { competitionId: "comp-1" } });

      expect(missing.status).toBe(400);
      expect(blank.status).toBe(400);
      expect(repo.proposeCompetitionTeam).not.toHaveBeenCalled();
    });

    it("maps DuplicateTeamNameError/AlreadyCaptainOrMemberError/TeamRegistrationNotOpenError to 409 at the application boundary", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/teams/propose/route");
      for (const err of [new DuplicateTeamNameError(), new AlreadyCaptainOrMemberError(), new TeamRegistrationNotOpenError()]) {
        (repo.proposeCompetitionTeam as ReturnType<typeof vi.fn>).mockRejectedValue(err);
        const res = await POST(jsonRequest("POST", { name: "My Team" }), { params: { competitionId: "comp-1" } });
        expect(res.status).toBe(409);
      }
    });
  });

  describe("POST .../teams/[teamId]/decide — DECIDE_COMPETITION_TEAM (UG-CR-RPT-041/042 §7)", () => {
    it("never forwards a client-supplied organizer identity, decision timestamp, or membership id", async () => {
      const { POST } = await import("../app/api/gaming/competitions/teams/[teamId]/decide/route");
      (repo.decideCompetitionTeam as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamId: "t1", status: "ACCEPTED", decidedAt: "x", competitionTeamMembershipId: "m1" });

      const res = await POST(jsonRequest("POST", { decision: "APPROVE", organizerGamingMemberId: "attacker-supplied-id", decidedAt: "fake", competitionTeamMembershipId: "fake" }), { params: { teamId: "t1" } });

      expect(res.status).toBe(200);
      expect(repo.decideCompetitionTeam).toHaveBeenCalledWith("t1", "auth-derived-member", "APPROVE", null);
    });

    it("rejects an invalid decision value with 400, never reaching the repository", async () => {
      const { POST } = await import("../app/api/gaming/competitions/teams/[teamId]/decide/route");

      const res = await POST(jsonRequest("POST", { decision: "MAYBE" }), { params: { teamId: "t1" } });

      expect(res.status).toBe(400);
      expect(repo.decideCompetitionTeam).not.toHaveBeenCalled();
    });

    it("rejects a REJECT decision with no reason with 400, never reaching the repository", async () => {
      const { POST } = await import("../app/api/gaming/competitions/teams/[teamId]/decide/route");

      const res = await POST(jsonRequest("POST", { decision: "REJECT" }), { params: { teamId: "t1" } });

      expect(res.status).toBe(400);
      expect(repo.decideCompetitionTeam).not.toHaveBeenCalled();
    });

    it("passes a REJECT reason through exactly", async () => {
      const { POST } = await import("../app/api/gaming/competitions/teams/[teamId]/decide/route");
      (repo.decideCompetitionTeam as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionTeamId: "t1", status: "REJECTED", decidedAt: "x", competitionTeamMembershipId: null });

      const res = await POST(jsonRequest("POST", { decision: "REJECT", reason: "Not enough players" }), { params: { teamId: "t1" } });

      expect(res.status).toBe(200);
      expect(repo.decideCompetitionTeam).toHaveBeenCalledWith("t1", "auth-derived-member", "REJECT", "Not enough players");
    });
  });

  describe("POST .../open-team-registration and .../close-team-registration (UG-CR-RPT-041/042 §7)", () => {
    it("open-team-registration never forwards a client-supplied organizer identity", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/open-team-registration/route");
      (repo.openTeamRegistration as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", state: "TEAM_REGISTRATION_OPEN" });

      const res = await POST(new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" } }), { params: { competitionId: "comp-1" } });

      expect(res.status).toBe(200);
      expect(repo.openTeamRegistration).toHaveBeenCalledWith("comp-1", "auth-derived-member");
    });

    it("open-team-registration returns 401 and never touches the repository when unauthenticated", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/open-team-registration/route");
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }) as never });

      const res = await POST(new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" } }), { params: { competitionId: "comp-1" } });

      expect(res.status).toBe(401);
      expect(repo.openTeamRegistration).not.toHaveBeenCalled();
    });

    it("close-team-registration never forwards a client-supplied organizer identity, and maps TeamRegistrationCapacityNotReachedError to 409", async () => {
      const { POST } = await import("../app/api/gaming/competitions/[competitionId]/close-team-registration/route");
      (repo.closeTeamRegistration as ReturnType<typeof vi.fn>).mockRejectedValue(new TeamRegistrationCapacityNotReachedError());

      const res = await POST(new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" } }), { params: { competitionId: "comp-1" } });

      expect(res.status).toBe(409);
      expect(repo.closeTeamRegistration).toHaveBeenCalledWith("comp-1", "auth-derived-member");
    });
  });

  describe("GET .../invitation-preview — the one deliberately unauthenticated Competitions route (UG-CR-RPT-041/042 §8/§9)", () => {
    it("never calls requireGamingMember, and still returns 200 for a valid accepted-team pair", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null });
      (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(team({ competitionTeamId: "team-1", competitionId: "comp-1", name: "Team A", captainGamingMemberId: "cap-1", status: "ACCEPTED" }));
      (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({ "cap-1": "Alice" });
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "comp-1", teamId: "team-1" } });
      const json = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
      expect(json.preview).toEqual({
        competitionName: "Cup",
        competitionState: "TEAM_REGISTRATION_OPEN",
        competitionAcceptingParticipants: true,
        teamName: "Team A",
        teamStatus: "ACCEPTED",
        teamAccepted: true,
        captainDisplayName: "Alice",
      });
    });

    it("never returns a raw Gaming Member id, an organizer id, or any field beyond the documented safe subset", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-secret-id", state: "PUBLISHED", cancelledReason: null, createdAt: "x", publishedAt: "x" });
      (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(team({ competitionTeamId: "team-1", competitionId: "comp-1", captainGamingMemberId: "captain-secret-id", status: "ACCEPTED" }));
      (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({ "captain-secret-id": "Alice" });
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "comp-1", teamId: "team-1" } });
      const bodyText = JSON.stringify(await res.json());

      expect(bodyText).not.toContain("org-secret-id");
      expect(bodyText).not.toContain("captain-secret-id");
      expect(Object.keys(JSON.parse(bodyText).preview).sort()).toEqual(
        ["captainDisplayName", "competitionAcceptingParticipants", "competitionName", "competitionState", "teamAccepted", "teamName", "teamStatus"].sort()
      );
    });

    it("a fabricated competitionId fails safely with 404", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "does-not-exist", teamId: "team-1" } });

      expect(res.status).toBe(404);
    });

    it("a teamId that belongs to a DIFFERENT competition fails safely with 404 rather than leaking cross-competition data", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "PUBLISHED", cancelledReason: null, createdAt: "x", publishedAt: "x" });
      (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(team({ competitionTeamId: "team-1", competitionId: "some-other-competition", status: "ACCEPTED" }));
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "comp-1", teamId: "team-1" } });

      expect(res.status).toBe(404);
    });

    it("a PENDING_ORGANIZER_APPROVAL team is reported truthfully, never presented as accepted", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null });
      (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(team({ competitionTeamId: "team-1", competitionId: "comp-1", status: "PENDING_ORGANIZER_APPROVAL" }));
      (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "comp-1", teamId: "team-1" } });
      const json = (await res.json()) as any;

      expect(json.preview.teamStatus).toBe("PENDING_ORGANIZER_APPROVAL");
      expect(json.preview.teamAccepted).toBe(false);
    });

    it("a REJECTED team is reported truthfully, never presented as accepted", async () => {
      (repo.getCompetitionById as ReturnType<typeof vi.fn>).mockResolvedValue({ competitionId: "comp-1", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null });
      (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(team({ competitionTeamId: "team-1", competitionId: "comp-1", status: "REJECTED" }));
      (repo.getDisplayNames as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/teams/[teamId]/invitation-preview/route");

      const res = await GET(new Request("http://localhost/probe"), { params: { competitionId: "comp-1", teamId: "team-1" } });
      const json = (await res.json()) as any;

      expect(json.preview.teamStatus).toBe("REJECTED");
      expect(json.preview.teamAccepted).toBe(false);
    });
  });

  describe("GET /competitions — DRAFT visibility is organizer-only (UG-CR-RPT-041/042 §7)", () => {
    it("excludes another organizer's DRAFT competition from the list, but includes the caller's OWN DRAFT and every non-DRAFT competition", async () => {
      const { GET } = await import("../app/api/gaming/competitions/route");
      (repo.listCompetitions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { competitionId: "c-other-draft", activityKey: "SOCCER_5V5", name: "Other Draft", organizerGamingMemberId: "some-other-organizer", state: "DRAFT", cancelledReason: null, createdAt: "x", publishedAt: null },
        { competitionId: "c-my-draft", activityKey: "SOCCER_5V5", name: "My Draft", organizerGamingMemberId: "auth-derived-member", state: "DRAFT", cancelledReason: null, createdAt: "x", publishedAt: null },
        { competitionId: "c-open", activityKey: "SOCCER_5V5", name: "Open Cup", organizerGamingMemberId: "some-other-organizer", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null },
      ]);

      const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }));
      const json = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(json.competitions.map((c: { competitionId: string }) => c.competitionId).sort()).toEqual(["c-my-draft", "c-open"]);
    });
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

  it("GET teams/[teamId]/join-requests — an unexpected repository failure is now caught and returns the established controlled 500, never an uncaught exception (UG-CR-GATE-036 correction 5, previously unguarded)", async () => {
    const { GET } = await import("../app/api/gaming/competitions/teams/[teamId]/join-requests/route");
    (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("relation \"competition_teams\" does not exist"));

    const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }), { params: { teamId: "team-1" } });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to load pending join requests.");
    expect(body.error).not.toMatch(/relation|does not exist/i);
  });

  it("GET teams/[teamId]/join-requests — a recognized domain error (e.g. not found) keeps its own specific status, never masked by the new generic catch", async () => {
    const { GET } = await import("../app/api/gaming/competitions/teams/[teamId]/join-requests/route");
    (repo.getCompetitionTeamById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }), { params: { teamId: "team-1" } });

    expect(res.status).toBe(404);
  });

  it("GET fixtures/[fixtureId]/admin-detail — an unexpected repository failure is now caught and returns the established controlled 500, never an uncaught exception (UG-CR-GATE-036 correction 5, previously unguarded)", async () => {
    const { GET } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/admin-detail/route");
    (repo.getFixtureById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("relation \"competition_fixtures\" does not exist"));

    const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }), { params: { fixtureId: "fx-1" } });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to load fixture detail.");
    expect(body.error).not.toMatch(/relation|does not exist/i);
  });

  it("GET fixtures/[fixtureId]/admin-detail — a recognized domain error (fixture not found) keeps its own specific status, never masked by the new generic catch", async () => {
    const { GET } = await import("../app/api/gaming/competitions/fixtures/[fixtureId]/admin-detail/route");
    (repo.getFixtureById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }), { params: { fixtureId: "fx-1" } });

    expect(res.status).toBe(404);
  });
});

describe("Competitions production-availability guard (UG-CR-GATE-036)", () => {
  describe("normalizeCompetitionsSchemaReady — the fail-closed truth table", () => {
    const cases: Array<[string, string | undefined, boolean]> = [
      ["undefined (the variable is absent)", undefined, false],
      ["empty string", "", false],
      ['"false"', "false", false],
      ['"true" — the only accepted value', "true", true],
      ["uppercase TRUE", "TRUE", false],
      ["leading space", " true", false],
      ["trailing space", "true ", false],
      ['numeric "1"', "1", false],
      ['"yes"', "yes", false],
      ["mixed case True", "True", false],
      ["an arbitrary malformed string", "enabled-please", false],
    ];
    it.each(cases)("%s -> %s", (_label, input, expected) => {
      expect(normalizeCompetitionsSchemaReady(input)).toBe(expected);
    });
  });

  describe("isCompetitionsSchemaReady / requireCompetitionsSchemaReady — reading the real environment variable", () => {
    const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
      else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL;
    });

    it("missing variable returns a guard response with status 503", () => {
      delete process.env.COMPETITIONS_SCHEMA_READY;
      expect(isCompetitionsSchemaReady()).toBe(false);
      const res = requireCompetitionsSchemaReady();
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
    });

    it("empty value returns 503", () => {
      process.env.COMPETITIONS_SCHEMA_READY = "";
      expect(requireCompetitionsSchemaReady()!.status).toBe(503);
    });

    it('"false" returns 503', () => {
      process.env.COMPETITIONS_SCHEMA_READY = "false";
      expect(requireCompetitionsSchemaReady()!.status).toBe(503);
    });

    it("a malformed value returns 503", () => {
      process.env.COMPETITIONS_SCHEMA_READY = "TRUE";
      expect(requireCompetitionsSchemaReady()!.status).toBe(503);
    });

    it('only "true" enables execution — the guard returns null, not a response', () => {
      process.env.COMPETITIONS_SCHEMA_READY = "true";
      expect(isCompetitionsSchemaReady()).toBe(true);
      expect(requireCompetitionsSchemaReady()).toBeNull();
    });

    it("the unavailable response carries exactly one field, a truthful non-sensitive message, and never a stack trace, relation name, migration number, or provider identifier", async () => {
      delete process.env.COMPETITIONS_SCHEMA_READY;
      const res = requireCompetitionsSchemaReady()!;
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toBe("URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.");
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/relation|does not exist|supabase|postgres|migration|0125|stack|at Object|at eval/i);
    });
  });

  describe("no readiness value is ever returned through /api/gaming/config or any other public config surface", () => {
    it("GET /api/gaming/config never mentions COMPETITIONS_SCHEMA_READY, regardless of the variable's value", async () => {
      process.env.COMPETITIONS_SCHEMA_READY = "true";
      process.env.SUPABASE_URL = "http://fake";
      process.env.SUPABASE_ANON_KEY = "fake-anon-key";
      const { GET } = await import("../app/api/gaming/config/route");
      const res = await GET();
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["supabaseAnonKey", "supabaseUrl"]);
      expect(JSON.stringify(body)).not.toMatch(/COMPETITIONS_SCHEMA_READY/i);
    });
  });

  describe("every Competitions route handler is guarded — structural coverage, not a source-text search", () => {
    // Discovers every app/api/gaming/competitions/**/route.ts file from the
    // real filesystem (never a hand-maintained list) — a future handler
    // added without this loop being updated is still discovered and still
    // tested; if it lacks the guard, the assertions below fail for real,
    // not merely because a name wasn't typed into this file.
    function findRouteFiles(dir: string): string[] {
      let files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) files = files.concat(findRouteFiles(full));
        else if (entry === "route.ts") files.push(full);
      }
      return files;
    }

    const competitionsDir = join(process.cwd(), "app/api/gaming/competitions");
    const routeFiles = findRouteFiles(competitionsDir);
    const routeSpecifiers = routeFiles.map((f) => "../" + relative(process.cwd(), f).replace(/\.ts$/, ""));

    let httpAuth: typeof import("../lib/gaming/competitions/httpAuth");
    let repo: CompetitionsRepository;
    const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;

    beforeEach(async () => {
      httpAuth = await import("../lib/gaming/competitions/httpAuth");
      vi.clearAllMocks();
      repo = makeFakeRepository();
      vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
      vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as unknown as ReturnType<typeof httpAuth.buildCompetitionsRepo>);
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "auth-derived-member" });
    });
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
      else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL;
    });

    it("discovered exactly the 24 known route files (canary — bump this alongside the review if a route is genuinely added or removed; UG-CR-RPT-041/042 added open-team-registration, close-team-registration, teams/propose, teams/[teamId]/decide, and teams/[teamId]/invitation-preview)", () => {
      expect(routeFiles).toHaveLength(24);
    });

    it("with readiness disabled, every one of the 25 discovered handlers (GET+POST both counted on the base route) returns 503 immediately, WITHOUT authenticating (including the deliberately-unauthenticated invitation-preview route — the schema-readiness guard fires before even that route's own intentional auth omission is reached), parsing the request body, or constructing a repository", async () => {
      delete process.env.COMPETITIONS_SCHEMA_READY;
      let handlersTested = 0;

      for (const specifier of routeSpecifiers) {
        const mod = (await import(specifier)) as Record<string, unknown>;
        const paramNames = [...specifier.matchAll(/\[(\w+)\]/g)].map((m) => m[1]);
        const params = Object.fromEntries(paramNames.map((name) => [name, "test-id"]));

        for (const method of ["GET", "POST"] as const) {
          const handler = mod[method];
          if (typeof handler !== "function") continue;
          handlersTested += 1;
          vi.clearAllMocks();

          // A deliberately UNPARSEABLE body: if the guard failed to run
          // first, a POST handler would hit `request.json()` and this
          // test would observe a 400 ("must be valid JSON"), not a 503 —
          // proving conclusively that body-parsing never happened.
          const request = new Request("http://localhost/probe", {
            method,
            headers: { authorization: "Bearer token" },
            body: method === "POST" ? "not valid json {{{" : undefined,
          });

          const res = await (handler as (req: Request, ctx?: unknown) => Promise<Response>)(request, { params });

          expect(res.status, `${specifier} [${method}] should return 503 when readiness is disabled`).toBe(503);
          const body = (await res.json()) as Record<string, unknown>;
          expect(body.error, `${specifier} [${method}]`).toBe(
            "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared."
          );
          expect(httpAuth.requireGamingMember, `${specifier} [${method}] must not authenticate`).not.toHaveBeenCalled();
          expect(httpAuth.buildCompetitionsRepo, `${specifier} [${method}] must not construct a repository`).not.toHaveBeenCalled();
        }
      }

      expect(handlersTested).toBe(25);
    });
  });
});

describe("Competitions UI — truthful unavailable state, never a masked empty/auth/broken state (UG-CR-GATE-036)", () => {
  const html = readFileSync("public/competitions.html", "utf-8");
  const adminHtml = readFileSync("public/competitions-admin.html", "utf-8");

  it("renderCompetitionList checks res.status before ever reading res.json.competitions — a 503 can never fall through to the empty-catalog message", () => {
    const fnStart = html.indexOf("async function renderCompetitionList() {");
    expect(fnStart).toBeGreaterThan(-1);
    const statusCheckIndex = html.indexOf("res.status !== 200", fnStart);
    const emptyMessageIndex = html.indexOf("No competitions have been created yet", fnStart);
    expect(statusCheckIndex).toBeGreaterThan(fnStart);
    expect(emptyMessageIndex).toBeGreaterThan(statusCheckIndex);
  });

  it("renderCompetitionList's unavailable branch returns before any interactive competition row is built — no consequential control is ever rendered alongside it", () => {
    const fnStart = html.indexOf("async function renderCompetitionList() {");
    const statusCheckIndex = html.indexOf("res.status !== 200", fnStart);
    const rowLoopIndex = html.indexOf("for (const c of competitions)", fnStart);
    expect(statusCheckIndex).toBeGreaterThan(fnStart);
    expect(statusCheckIndex).toBeLessThan(rowLoopIndex);
  });

  it("the captain's pending-join-requests panel also checks status before reading .joinRequests, so a 503 there never renders as \"No pending requests.\"", () => {
    const fnStart = html.indexOf("teams/${capTeam.competitionTeamId}/join-requests");
    expect(fnStart).toBeGreaterThan(-1);
    const statusCheckIndex = html.indexOf("r.status !== 200", fnStart);
    const emptyMessageIndex = html.indexOf("No pending requests.", fnStart);
    expect(statusCheckIndex).toBeGreaterThan(fnStart);
    expect(statusCheckIndex).toBeLessThan(emptyMessageIndex);
  });

  it("renderCompetitionDetail already surfaces the server's own truthful error message for any non-200 (unchanged since UG-CR-GATE-031/032) — a 503 here shows the guard's own message, never a generic broken page", () => {
    // Signature grew a second parameter, teamId, for the Branded Team
    // Registration and Invitation Journey (UG-CR-RPT-041/042 §8/§11) —
    // the search string below follows that rename; the guarantee itself
    // (status checked immediately after the fetch, before anything else)
    // is otherwise unchanged.
    const fnStart = html.indexOf("async function renderCompetitionDetail(competitionId, teamId) {");
    expect(fnStart).toBeGreaterThan(-1);
    const statusCheckIndex = html.indexOf("res.status !== 200", fnStart);
    expect(statusCheckIndex).toBeGreaterThan(fnStart);
    const preamble = html.slice(fnStart, statusCheckIndex);
    // The check is the very first thing the function does after its own fetch — no
    // intervening logic could act on a body shape a 503 response doesn't have.
    expect(preamble).toContain("await authedFetch");
  });

  it("admin loadCompetitions checks status before populating the dropdown or leaving it silently empty", () => {
    const fnStart = adminHtml.indexOf("async function loadCompetitions() {");
    expect(fnStart).toBeGreaterThan(-1);
    const statusCheckIndex = adminHtml.indexOf("res.status !== 200", fnStart);
    const dropdownFillIndex = adminHtml.indexOf("for (const c of cachedCompetitions)", fnStart);
    expect(statusCheckIndex).toBeGreaterThan(fnStart);
    expect(statusCheckIndex).toBeLessThan(dropdownFillIndex);
  });

  it("neither Competitions page ever polls the Competitions API automatically — the one existing setInterval (competitions.html's own return-to-intent auth poll, UG-CR-GATE-031) targets only UrbanoAuth.getState(), never /api/gaming/competitions", () => {
    for (const [name, source] of [["competitions.html", html], ["competitions-admin.html", adminHtml]] as const) {
      const intervalBodies = [...source.matchAll(/setInterval\(([\s\S]{0,300}?)\}, \d+\)/g)].map((m) => m[1]);
      for (const body of intervalBodies) {
        expect(body, `${name}'s setInterval body must never call the Competitions API`).not.toMatch(/api\/gaming\/competitions/);
      }
    }
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

describe("competitions-admin.html — inline organizer rejection interaction replaces window.prompt() (UG-CR-RPT-043 Condition B)", () => {
  const adminHtml = readFileSync("public/competitions-admin.html", "utf-8");

  it("never CALLS window.prompt anywhere on this page — the prior blocking-dialog dependency is fully removed (mentions of it by name in explanatory comments are fine and expected)", () => {
    expect(adminHtml).not.toContain("const reason = window.prompt(");
    expect(adminHtml).not.toMatch(/=\s*window\.prompt\(/);
  });

  it("buildRejectionPanelRow shows the team name and proposer by display name only, never a raw competitionTeamId in rendered text", () => {
    const fnStart = adminHtml.indexOf("function buildRejectionPanelRow(t, competition, acceptBtn, rejectBtn) {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = adminHtml.indexOf("\nfunction renderCompetitionDetail() {", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = adminHtml.slice(fnStart, fnEnd);
    expect(fnBody).toContain("${t.name}");
    expect(fnBody).toContain("${t.captainDisplayName || \"Unknown\"}");
    // t.competitionTeamId is used only inside the reason input's `id`
    // attribute and the fetch URL — never interpolated into a rendered
    // <p>, <strong>, or aria-label text node.
    expect(fnBody).not.toMatch(/<(p|strong)[^>]*>\$\{[^}]*competitionTeamId/);
    expect(fnBody).not.toMatch(/aria-label="[^"]*\$\{[^}]*competitionTeamId/);
  });

  it("the Confirm Rejection control starts disabled and is only enabled once the reason textarea holds non-whitespace text", () => {
    const fnStart = adminHtml.indexOf("function buildRejectionPanelRow(t, competition, acceptBtn, rejectBtn) {");
    const fnEnd = adminHtml.indexOf("\nfunction renderCompetitionDetail() {", fnStart);
    const fnBody = adminHtml.slice(fnStart, fnEnd);
    expect(fnBody).toContain('class="danger reject-confirm-btn" disabled');
    expect(fnBody).toContain('confirmBtn.disabled = reasonInput.value.trim().length === 0;');
  });

  it("Confirm Rejection guards against duplicate submission by checking and then synchronously setting disabled before any await", () => {
    const handlerStart = adminHtml.indexOf('confirmBtn.addEventListener("click", async () => {');
    expect(handlerStart).toBeGreaterThan(-1);
    const guardIndex = adminHtml.indexOf("if (confirmBtn.disabled) return;", handlerStart);
    const disableIndex = adminHtml.indexOf("confirmBtn.disabled = true; cancelBtn.disabled = true; reasonInput.disabled = true;", handlerStart);
    const firstAwaitIndex = adminHtml.indexOf("await authedFetch(", handlerStart);
    expect(guardIndex).toBeGreaterThan(handlerStart);
    expect(disableIndex).toBeGreaterThan(guardIndex);
    expect(firstAwaitIndex).toBeGreaterThan(disableIndex);
  });

  it("requires a non-empty reason both client-side (disabled button) and defensively inside the click handler itself before ever calling the API", () => {
    const handlerStart = adminHtml.indexOf('confirmBtn.addEventListener("click", async () => {');
    const firstAwaitIndex = adminHtml.indexOf("await authedFetch(", handlerStart);
    const handlerPreamble = adminHtml.slice(handlerStart, firstAwaitIndex);
    expect(handlerPreamble).toContain('if (!reason) {');
    expect(handlerPreamble).toContain("A reason is required to reject.");
  });

  it("shows a busy state (\"Rejecting…\") before the request resolves, and a distinct success state after it resolves 200", () => {
    const handlerStart = adminHtml.indexOf('confirmBtn.addEventListener("click", async () => {');
    const firstAwaitIndex = adminHtml.indexOf("await authedFetch(", handlerStart);
    const afterAwait = adminHtml.slice(firstAwaitIndex, firstAwaitIndex + 400);
    expect(adminHtml.slice(handlerStart, firstAwaitIndex)).toContain("Rejecting…");
    expect(afterAwait).toContain('res.status === 200');
    expect(afterAwait).toContain("Rejected.");
    expect(afterAwait).toContain('"msg reject-status success"');
  });

  it("a failed rejection re-enables the controls and shows the server's own typed error message, rather than leaving the panel stuck in a busy state", () => {
    const handlerStart = adminHtml.indexOf('confirmBtn.addEventListener("click", async () => {');
    const fnEnd = adminHtml.indexOf("\n  return row;", handlerStart);
    const handlerBody = adminHtml.slice(handlerStart, fnEnd);
    const elseIndex = handlerBody.indexOf("} else {");
    expect(elseIndex).toBeGreaterThan(-1);
    const elseBranch = handlerBody.slice(elseIndex);
    expect(elseBranch).toContain("cancelBtn.disabled = false; reasonInput.disabled = false;");
    expect(elseBranch).toContain('(res.json && res.json.error) || "Failed to reject."');
    expect(elseBranch).toContain('"msg reject-status error"');
  });

  it("Cancel restores the row's Accept/Reject controls and returns focus to the Reject button that opened the panel — never leaves the page in a state with no visible action for that row", () => {
    const resetStart = adminHtml.indexOf("function resetAndClose(focusEl) {");
    expect(resetStart).toBeGreaterThan(-1);
    const resetEnd = adminHtml.indexOf("\n  }", resetStart);
    const resetBody = adminHtml.slice(resetStart, resetEnd);
    expect(resetBody).toContain("acceptBtn.hidden = false; rejectBtn.hidden = false;");
    expect(resetBody).toContain("(focusEl || rejectBtn).focus();");
    expect(adminHtml).toContain('cancelBtn.addEventListener("click", () => resetAndClose());');
  });

  it("a successful rejection moves focus to the Proposed Teams heading after the view reloads — a deliberate, programmatic focus target, not an incidental document.body reset", () => {
    const handlerStart = adminHtml.indexOf('confirmBtn.addEventListener("click", async () => {');
    const handlerEnd = adminHtml.indexOf("\n  });\n\n  return row;", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const successBranch = adminHtml.slice(handlerStart, handlerEnd);
    expect(successBranch).toContain('getElementById("pending-teams-heading")');
    expect(successBranch).toContain("heading.focus()");
    expect(adminHtml).toContain('<h3 id="pending-teams-heading" tabindex="-1">Proposed Teams — Pending Approval</h3>');
  });

  it("Escape closes the panel the same way Cancel does, and is wired on the reason input so it works without leaving the keyboard", () => {
    expect(adminHtml).toContain('if (e.key === "Escape") { e.preventDefault(); resetAndClose(); }');
  });

  it("opening Reject hides this row's own Accept/Reject buttons and reveals the panel, focusing the reason field — never a native prompt()", () => {
    const openStart = adminHtml.indexOf('rejectBtn.addEventListener("click", () => {');
    expect(openStart).toBeGreaterThan(-1);
    const openEnd = adminHtml.indexOf("\n    });", openStart);
    const openBody = adminHtml.slice(openStart, openEnd);
    expect(openBody).toContain("acceptBtn.hidden = true; rejectBtn.hidden = true;");
    expect(openBody).toContain("panelRow.hidden = false;");
    expect(openBody).toContain('panelRow.querySelector(".reject-reason-input").focus();');
  });

  it("the reason field has an associated <label> (for/id) — an accessible name is not provided by placeholder text alone", () => {
    const fnStart = adminHtml.indexOf("function buildRejectionPanelRow(t, competition, acceptBtn, rejectBtn) {");
    const fnEnd = adminHtml.indexOf("\nfunction renderCompetitionDetail() {", fnStart);
    const fnBody = adminHtml.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/<label for="\$\{reasonId\}">Reason \(required\)<\/label>/);
    expect(fnBody).toMatch(/<textarea id="\$\{reasonId\}" class="reject-reason-input"/);
  });

  it("the rejection status region is aria-live so busy/success/error updates are announced without moving focus away from the panel", () => {
    expect(adminHtml).toContain('<p class="msg reject-status" aria-live="polite"></p>');
  });

  it("builds the panel's <tr> via elRow(), never the plain el() div-context helper — el()'s div.innerHTML silently strips <tr>/<td> tags outside a real table context, which would leave the panel permanently visible (its `hidden` attribute lives on the discarded <tr>) and its content sitting as an invalid direct child of <tbody> instead of inside a <td>", () => {
    expect(adminHtml).toContain("function elRow(html) {");
    expect(adminHtml).toContain("const table = document.createElement(\"table\");");
    expect(adminHtml).toContain('const row = elRow(`<tr class="reject-panel-row" hidden>');
    expect(adminHtml).not.toContain('const row = el(`<tr class="reject-panel-row"');
  });
});
