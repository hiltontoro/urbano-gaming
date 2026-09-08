import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { proposeCompetitionTeam } from "../lib/gaming/competitions/proposeCompetitionTeam";
import { decideCompetitionTeam } from "../lib/gaming/competitions/decideCompetitionTeam";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { checkIn } from "../lib/gaming/competitions/checkIn";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { raiseDispute } from "../lib/gaming/competitions/raiseDispute";
import { correctFixture } from "../lib/gaming/competitions/correctFixture";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import {
  ScorekeeperConflictOfInterestError,
  OperationalAuthorityRequiredError,
  RegulationScoreEventMismatchError,
  EvidenceParticipantNotAttestedError,
  MinimumParticipationNotMetError,
  EmptyRosterError,
  DuplicateRosterEntryError,
  RosterMemberNotApprovedError,
  UnsupportedTargetFactTypeError,
  TargetFactNotFoundError,
  TargetFactFixtureMismatchError,
  TargetFactNotCurrentError,
  DisputeNotAuthorizedError,
  CompetitionAccessDeniedError,
  ReasonRequiredError,
  CompetitionNotDraftError,
  CompetitionNotPublishedError,
  CompetitionNotReadyToPublishError,
  CompetitionRegistrationRequiredError,
  TeamRegistrationNotOpenError,
  TeamRegistrationCapacityNotReachedError,
  TeamCapacityReachedError,
  TeamDecisionAlreadyMadeError,
  TeamNotAcceptedError,
  DuplicateTeamNameError,
  AlreadyCaptainOrMemberError,
  AlreadyTeamMemberError,
} from "../lib/gaming/competitions/types";
import type { GoalEventInput, AssistEventInput, ParticipationAttestationInput } from "../lib/gaming/competitions/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// This project's committed .env.local targets the linked REMOTE Supabase
// project; contract tests must run only against the confirmed local
// stack — fail loudly rather than silently mutating a non-local database
// if SUPABASE_URL was not explicitly overridden to 127.0.0.1 for this run
// (see raceSupabaseRepository.contract.test.ts's identical guard).
if (!/127\.0\.0\.1|localhost/.test(supabaseUrl)) {
  throw new Error(
    `Refusing to run Competitions contract tests against a non-local SUPABASE_URL (${supabaseUrl}). ` +
      "Export SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY for the local stack before running this file."
  );
}

const repo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const anonClient = createClient(supabaseUrl, supabaseAnonKey);

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];
const createdCompetitionIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<{ authUserId: string; gamingMemberId: string }> {
  const email = `competitions-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
}

async function grantOperationalAuthority(gamingMemberId: string): Promise<void> {
  const { error } = await cleanupClient.from("authority_grants").insert({ gaming_member_id: gamingMemberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
}

async function cleanupCompetitions(competitionIds: string[]): Promise<void> {
  if (competitionIds.length === 0) return;
  const { data: fixtures } = await cleanupClient.from("competition_fixtures").select("competition_fixture_id").in("competition_id", competitionIds);
  const fixtureIds = (fixtures ?? []).map((f) => f.competition_fixture_id);

  if (fixtureIds.length > 0) {
    const { data: revisions } = await cleanupClient.from("competition_roster_revisions").select("competition_roster_revision_id").in("competition_fixture_id", fixtureIds);
    const revisionIds = (revisions ?? []).map((r) => r.competition_roster_revision_id);
    if (revisionIds.length > 0) {
      await cleanupClient.from("competition_roster_revision_entries").delete().in("competition_roster_revision_id", revisionIds);
    }
    await cleanupClient.from("competition_roster_revisions").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("soccer_assist_events").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("soccer_goal_events").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("soccer_penalty_shootouts").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_fixture_evidence").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_participation_attestations").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_checkins").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_disputes").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_fixture_corrections").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_member_participation_records").delete().in("competition_fixture_id", fixtureIds);
    await cleanupClient.from("competition_fixture_finalizations").delete().in("competition_fixture_id", fixtureIds);
  }

  await cleanupClient.from("competition_fixtures").delete().in("competition_id", competitionIds);
  await cleanupClient.from("competition_team_memberships").delete().in("competition_id", competitionIds);
  await cleanupClient.from("competition_join_requests").delete().in("competition_id", competitionIds);
  await cleanupClient.from("competition_registrations").delete().in("competition_id", competitionIds);
  await cleanupClient.from("competition_teams").delete().in("competition_id", competitionIds);
  await cleanupClient.from("competitions").delete().in("competition_id", competitionIds);
}

afterAll(async () => {
  await cleanupCompetitions(createdCompetitionIds);
  if (createdGamingMemberIds.length > 0) {
    await cleanupClient.from("authority_grants").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

async function setUpCompetitionWith4Teams() {
  const organizer = await createRealGamingMember("Organizer");
  await grantOperationalAuthority(organizer.gamingMemberId);
  const competition = await createCompetition(repo, organizer.gamingMemberId, `Contract Cup ${randomUUID().slice(0, 8)}`, "SOCCER_5V5");
  createdCompetitionIds.push(competition.competitionId);

  const captains = await Promise.all([
    createRealGamingMember("Captain A"),
    createRealGamingMember("Captain B"),
    createRealGamingMember("Captain C"),
    createRealGamingMember("Captain D"),
  ]);
  const teams = [];
  for (let i = 0; i < 4; i++) {
    const team = await addCompetitionTeam(repo, competition.competitionId, organizer.gamingMemberId, `Team ${String.fromCharCode(65 + i)}`, captains[i].gamingMemberId);
    teams.push({ competitionTeamId: team.competitionTeamId, captainId: captains[i].gamingMemberId });
  }
  // UG-CR-RPT-041/042 §3/§4 (Founder decision 1 — one unified lifecycle):
  // PUBLISH_COMPETITION now requires READY_TO_PUBLISH, reached only via
  // OPEN_TEAM_REGISTRATION -> (all four teams already ACCEPTED above,
  // added while still DRAFT, which ADD_COMPETITION_TEAM still allows) ->
  // CLOSE_TEAM_REGISTRATION. Every existing fixture-level contract test
  // that builds its own context through this helper is unaffected beyond
  // this: the resulting competition is still exactly four ACCEPTED
  // organizer-created teams, just reached through the two additional,
  // deliberate organizer checkpoints the corrected lifecycle now shares
  // with the member-proposal path.
  await openTeamRegistration(repo, competition.competitionId, organizer.gamingMemberId);
  await closeTeamRegistration(repo, competition.competitionId, organizer.gamingMemberId);
  return { organizerId: organizer.gamingMemberId, competitionId: competition.competitionId, teams };
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** A competition with team registration already open, no teams yet — the entry point for the Branded Team Registration and Invitation Journey's own contract tests (UG-CR-RPT-041/042). */
async function setUpCompetitionForTeamRegistration() {
  const organizer = await createRealGamingMember("Organizer");
  await grantOperationalAuthority(organizer.gamingMemberId);
  const competition = await createCompetition(repo, organizer.gamingMemberId, `Registration Cup ${randomUUID().slice(0, 8)}`, "SOCCER_5V5");
  createdCompetitionIds.push(competition.competitionId);
  await openTeamRegistration(repo, competition.competitionId, organizer.gamingMemberId);
  return { organizerId: organizer.gamingMemberId, competitionId: competition.competitionId };
}

/** A registered member, ready to propose or request-join a team. */
async function registeredMember(competitionId: string, displayName: string) {
  const member = await createRealGamingMember(displayName);
  await registerForCompetition(repo, competitionId, member.gamingMemberId, true);
  return member;
}

async function publishDefault(competitionId: string, organizerId: string, teams: Array<{ competitionTeamId: string }>) {
  return publishCompetition(
    repo, competitionId, organizerId,
    teams[0].competitionTeamId, teams[1].competitionTeamId, teams[2].competitionTeamId, teams[3].competitionTeamId,
    futureIso(3600_000), futureIso(7200_000), futureIso(10800_000)
  );
}

/** Registers a fresh member, requests to join the given team, and has its captain approve — returns the new member's gamingMemberId. */
async function joinTeamAsApprovedMember(competitionId: string, teamId: string, captainId: string, displayName: string): Promise<string> {
  const member = await createRealGamingMember(displayName);
  await registerForCompetition(repo, competitionId, member.gamingMemberId, true);
  const joinRequest = await requestJoinTeam(repo, competitionId, teamId, member.gamingMemberId);
  await decideJoinRequest(repo, joinRequest.competitionJoinRequestId, captainId, "APPROVE", false);
  return member.gamingMemberId;
}

async function buildApprovedRosterOfFive(competitionId: string, teamId: string, captainId: string, label: string): Promise<string[]> {
  const memberIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    memberIds.push(await joinTeamAsApprovedMember(competitionId, teamId, captainId, `${label} Player ${i}`));
  }
  return memberIds;
}

describe("SupabaseCompetitionsRepository contract", () => {
  it(
    "full Soccer Slice 001 happy path against real local Postgres: create, publish, register, join, roster, check-in, evidence, finalize, persistent record, FINAL slot population, idempotent retry, RLS denial",
    async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      expect(published.state).toBe("PUBLISHED");

      const sf1TeamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "SF1-A");
      const sf1TeamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "SF1-B");

      const rosterA = await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, sf1TeamAMembers);
      expect(rosterA.fixtureState).toBe("SCHEDULED");
      const rosterB = await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, sf1TeamBMembers);
      expect(rosterB.fixtureState).toBe("ROSTER_DECLARED");

      for (const memberId of [...sf1TeamAMembers, ...sf1TeamBMembers]) {
        const result = await checkIn(repo, published.semifinal1FixtureId, memberId);
        expect(result.alreadyCheckedIn).toBe(false);
      }

      const scorekeeper = await createRealGamingMember("Scorekeeper SF1");
      const appointed = await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      expect(appointed.scorekeeperGamingMemberId).toBe(scorekeeper.gamingMemberId);

      // A team's own captain cannot be appointed scorekeeper for that fixture — checkpoint 1 of 5.
      await expect(
        appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, teams[0].captainId)
      ).rejects.toBeInstanceOf(ScorekeeperConflictOfInterestError);

      const attestations: ParticipationAttestationInput[] = [...sf1TeamAMembers, ...sf1TeamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const goalEvents: GoalEventInput[] = [
        { scorerGamingMemberId: sf1TeamAMembers[0], competitionTeamId: teams[0].competitionTeamId },
        { scorerGamingMemberId: sf1TeamAMembers[1], competitionTeamId: teams[0].competitionTeamId },
      ];
      const assistEvents: AssistEventInput[] = [{ assistingGamingMemberId: sf1TeamAMembers[2], goalEventIndex: 0 }];

      const evidence = await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 2, 0, goalEvents, assistEvents, attestations, null);
      expect(evidence.alreadySubmitted).toBe(false);
      expect(evidence.fixtureState).toBe("EVIDENCE_SUBMITTED");

      const finalized = await finalizeFixture(repo, published.semifinal1FixtureId, organizerId);
      expect(finalized.alreadyFinalized).toBe(false);
      expect(finalized.winningCompetitionTeamId).toBe(teams[0].competitionTeamId);

      const records = await repo.getMemberParticipationRecords(competitionId, sf1TeamAMembers[0]);
      expect(records).toHaveLength(1);
      expect(records[0].goals).toBe(1);
      expect(records[0].appeared).toBe(true);
      const assisterRecords = await repo.getMemberParticipationRecords(competitionId, sf1TeamAMembers[2]);
      expect(assisterRecords[0].assists).toBe(1);

      const finalFixture = await repo.getFixtureById(published.finalFixtureId);
      expect(finalFixture!.teamACompetitionTeamId).toBe(teams[0].competitionTeamId);

      // Idempotent finalize retry: same result, no duplicate persistent records.
      const retryFinalize = await finalizeFixture(repo, published.semifinal1FixtureId, organizerId);
      expect(retryFinalize.alreadyFinalized).toBe(true);
      expect(retryFinalize.competitionFixtureFinalizationId).toBe(finalized.competitionFixtureFinalizationId);
      const recordsAfterRetry = await repo.getMemberParticipationRecords(competitionId, sf1TeamAMembers[0]);
      expect(recordsAfterRetry).toHaveLength(1);

      // RLS/grant default-deny: an anonymous client is rejected outright, never merely filtered to zero rows.
      const anonResult = await anonClient.from("competitions").select("*").eq("competition_id", competitionId);
      expect(anonResult.error).not.toBeNull();
      expect(anonResult.error!.code).toBe("42501");
    },
    30000
  );

  it("rejects creating a competition without active platform OPERATIONAL authority", async () => {
    const unauthorized = await createRealGamingMember("No Authority");
    await expect(
      createCompetition(repo, unauthorized.gamingMemberId, "Should Not Be Created", "SOCCER_5V5")
    ).rejects.toBeInstanceOf(OperationalAuthorityRequiredError);
  }, 15000);

  it("rejects an evidence submission where a credited goal scorer is not attested as actually participating", async () => {
    const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
    const published = await publishDefault(competitionId, organizerId, teams);
    const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "EV-A");
    const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "EV-B");
    await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
    await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
    const scorekeeper = await createRealGamingMember("EV Scorekeeper");
    await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);

    await expect(
      submitFixtureEvidence(
        repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0,
        [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }],
        [], [], null
      )
    ).rejects.toBeInstanceOf(EvidenceParticipantNotAttestedError);
  }, 20000);

  it("rejects a regulation score that does not equal the count of attributed goal events per team", async () => {
    const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
    const published = await publishDefault(competitionId, organizerId, teams);
    const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "MM-A");
    const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "MM-B");
    await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
    await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
    const scorekeeper = await createRealGamingMember("MM Scorekeeper");
    await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);

    await expect(
      submitFixtureEvidence(
        repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 2, 0,
        [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }],
        [], [{ gamingMemberId: teamAMembers[0], actuallyParticipated: true }], null
      )
    ).rejects.toBeInstanceOf(RegulationScoreEventMismatchError);
  }, 20000);

  describe("negative and concurrency cases named by UG-CR-GATE-029", () => {
    it("two concurrent APPROVE decisions on the SAME join request create exactly one team membership", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      await publishDefault(competitionId, organizerId, teams);
      const member = await createRealGamingMember("Race Applicant");
      await registerForCompetition(repo, competitionId, member.gamingMemberId, true);
      const joinRequest = await requestJoinTeam(repo, competitionId, teams[0].competitionTeamId, member.gamingMemberId);

      const [r1, r2] = await Promise.allSettled([
        decideJoinRequest(repo, joinRequest.competitionJoinRequestId, teams[0].captainId, "APPROVE", false),
        decideJoinRequest(repo, joinRequest.competitionJoinRequestId, teams[0].captainId, "APPROVE", false),
      ]);
      const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);

      const { data: memberships } = await cleanupClient
        .from("competition_team_memberships")
        .select("*")
        .eq("competition_id", competitionId)
        .eq("gaming_member_id", member.gamingMemberId);
      expect(memberships).toHaveLength(1);
    }, 20000);

    it("concurrent roster declarations for the same fixture/team serialize via the advisory lock to exactly one current revision", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const members = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Branch");

      const [r1, r2] = await Promise.all([
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, members.slice(0, 3)),
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, members.slice(0, 5)),
      ]);
      expect(r1.competitionRosterRevisionId).not.toBe(r2.competitionRosterRevisionId);

      const { data: currentRevisions } = await cleanupClient
        .from("competition_roster_revisions")
        .select("*")
        .eq("competition_fixture_id", published.semifinal1FixtureId)
        .eq("competition_team_id", teams[0].competitionTeamId)
        .eq("is_current", true);
      expect(currentRevisions).toHaveLength(1);
    }, 20000);

    it("a repeated evidence submission is idempotent by construction and never duplicates the evidence row", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Retry-A");
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Retry-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("Retry Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);

      const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const goalEvents: GoalEventInput[] = [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }];
      const first = await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0, goalEvents, [], attestations, null);
      // A retry with a DIFFERENT (deliberately wrong) payload still returns the ORIGINAL bundle untouched — evidence is submitted exactly once.
      const retry = await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 9, 9, [], [], [], null);
      expect(retry.alreadySubmitted).toBe(true);
      expect(retry.competitionFixtureEvidenceId).toBe(first.competitionFixtureEvidenceId);

      const { data: evidenceRows } = await cleanupClient
        .from("competition_fixture_evidence")
        .select("*")
        .eq("competition_fixture_id", published.semifinal1FixtureId);
      expect(evidenceRows).toHaveLength(1);
      expect(evidenceRows![0].team_a_score).toBe(1);
    }, 20000);

    it("an open dispute is atomically resolved as FINALIZED_AS_SUBMITTED in the same transaction as finalize", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Dispute-A");
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Dispute-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("Dispute Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const evidence = await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0, [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null);

      // Target is SF1's own CURRENT evidence row (the real SCORE fact) — raise_competition_dispute_atomically
      // (UG-CR-GATE-032) independently derives and enforces that the raiser is the captain of one of the two
      // competing teams; the fixture id itself is never a valid SCORE target.
      const dispute = await raiseDispute(repo, published.semifinal1FixtureId, teams[1].captainId, "SCORE", evidence.competitionFixtureEvidenceId, "We believe the score is wrong.");
      await finalizeFixture(repo, published.semifinal1FixtureId, organizerId);

      const disputes = await repo.getDisputes(published.semifinal1FixtureId);
      const resolved = disputes.find((d) => d.competitionDisputeId === dispute.competitionDisputeId);
      expect(resolved!.resolutionAction).toBe("FINALIZED_AS_SUBMITTED");
      expect(resolved!.resolvedAt).not.toBeNull();
    }, 20000);

    it("finalize retry does not re-derive or duplicate persistent participation records", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Rederive-A");
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Rederive-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("Rederive Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0, [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null);
      await finalizeFixture(repo, published.semifinal1FixtureId, organizerId);

      const { data: before } = await cleanupClient.from("competition_member_participation_records").select("*").eq("competition_fixture_id", published.semifinal1FixtureId);
      await Promise.all([
        finalizeFixture(repo, published.semifinal1FixtureId, organizerId),
        finalizeFixture(repo, published.semifinal1FixtureId, organizerId),
      ]);
      const { data: after } = await cleanupClient.from("competition_member_participation_records").select("*").eq("competition_fixture_id", published.semifinal1FixtureId);
      expect(after).toHaveLength(before!.length);
    }, 20000);
  });

  describe("the semifinal-correction cascade (UG-CR-RPT-024 §7)", () => {
    async function setUpTwoFinalizedSemifinals() {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);

      async function playAndFinalize(fixtureId: string, teamAIndex: number, teamBIndex: number, label: string) {
        const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[teamAIndex].competitionTeamId, teams[teamAIndex].captainId, `${label}-A`);
        const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[teamBIndex].competitionTeamId, teams[teamBIndex].captainId, `${label}-B`);
        await declareRoster(repo, fixtureId, teams[teamAIndex].competitionTeamId, teams[teamAIndex].captainId, false, null, teamAMembers);
        await declareRoster(repo, fixtureId, teams[teamBIndex].competitionTeamId, teams[teamBIndex].captainId, false, null, teamBMembers);
        const scorekeeper = await createRealGamingMember(`${label} Scorekeeper`);
        await appointScorekeeper(repo, fixtureId, organizerId, scorekeeper.gamingMemberId);
        const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
        await submitFixtureEvidence(repo, fixtureId, scorekeeper.gamingMemberId, 1, 0, [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[teamAIndex].competitionTeamId }], [], attestations, null);
        const finalization = await finalizeFixture(repo, fixtureId, organizerId);
        return { teamAMembers, teamBMembers, finalization };
      }

      const sf1 = await playAndFinalize(published.semifinal1FixtureId, 0, 1, "SF1");
      const sf2 = await playAndFinalize(published.semifinal2FixtureId, 2, 3, "SF2");
      return { organizerId, competitionId, teams, published, sf1, sf2 };
    }

    it("a winner-changing correction BEFORE the final's check-in opens atomically swaps the FINAL's finalist and reverts it to SCHEDULED", async () => {
      const { organizerId, teams, published, sf1 } = await setUpTwoFinalizedSemifinals();

      const finalBefore = await repo.getFixtureById(published.finalFixtureId);
      expect(finalBefore!.teamACompetitionTeamId).toBe(teams[0].competitionTeamId);

      // Correct SF1 so team B (index 1) wins instead of team A.
      const corrected = await correctFixture(
        repo, published.semifinal1FixtureId, organizerId, "Scorekeeper mis-recorded the winner.",
        0, 1, [{ scorerGamingMemberId: sf1.teamBMembers[0], competitionTeamId: teams[1].competitionTeamId }], [], null
      );
      expect(corrected.cascadeOutcome).toBe("FINALIST_REPLACED_BEFORE_CHECKIN");
      expect(corrected.newWinningCompetitionTeamId).toBe(teams[1].competitionTeamId);

      const finalAfter = await repo.getFixtureById(published.finalFixtureId);
      expect(finalAfter!.teamACompetitionTeamId).toBe(teams[1].competitionTeamId);
      expect(finalAfter!.state).toBe("SCHEDULED");

      // Both the original and corrected finalization rows survive — nothing is erased.
      const { data: finalizations } = await cleanupClient.from("competition_fixture_finalizations").select("*").eq("competition_fixture_id", published.semifinal1FixtureId);
      expect(finalizations).toHaveLength(2);
    }, 30000);

    it("a winner-changing correction AFTER the final's check-in has opened cancels the whole competition, retaining every prior assertion", async () => {
      const { organizerId, competitionId, teams, published, sf1, sf2 } = await setUpTwoFinalizedSemifinals();

      // Open the final's check-in: declare both finalist rosters and check in one member.
      await declareRoster(repo, published.finalFixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, sf1.teamAMembers);
      await declareRoster(repo, published.finalFixtureId, teams[2].competitionTeamId, teams[2].captainId, false, null, sf2.teamAMembers);
      await checkIn(repo, published.finalFixtureId, sf1.teamAMembers[0]);
      const finalDuringCheckin = await repo.getFixtureById(published.finalFixtureId);
      expect(finalDuringCheckin!.state).toBe("CHECKIN_OPEN");

      const corrected = await correctFixture(
        repo, published.semifinal1FixtureId, organizerId, "Post-checkin winner correction.",
        0, 1, [{ scorerGamingMemberId: sf1.teamBMembers[0], competitionTeamId: teams[1].competitionTeamId }], [], null
      );
      expect(corrected.cascadeOutcome).toBe("COMPETITION_CANCELLED_AFTER_FINAL_CHECKIN");
      expect(corrected.competitionState).toBe("CANCELLED_WITHOUT_CHAMPION");

      const competition = await repo.getCompetitionById(competitionId);
      expect(competition!.state).toBe("CANCELLED_WITHOUT_CHAMPION");
      expect(competition!.cancelledReason).toContain("after final check-in opened");

      const { data: finalizations } = await cleanupClient.from("competition_fixture_finalizations").select("*").eq("competition_fixture_id", published.semifinal1FixtureId);
      expect(finalizations).toHaveLength(2);
    }, 30000);

    it("directly voiding a semifinal immediately cancels the whole competition without a champion", async () => {
      const { organizerId, competitionId, teams, published } = await setUpCompetitionWith4Teams().then(async (setup) => {
        const published = await publishDefault(setup.competitionId, setup.organizerId, setup.teams);
        return { ...setup, published };
      });

      const voided = await voidFixture(repo, published.semifinal2FixtureId, organizerId, "Field unavailable — match could not be played.");
      expect(voided.alreadyFinalized).toBe(false);
      expect(voided.competitionState).toBe("CANCELLED_WITHOUT_CHAMPION");

      const fixture = await repo.getFixtureById(published.semifinal2FixtureId);
      expect(fixture!.state).toBe("VOID");
      const competition = await repo.getCompetitionById(competitionId);
      expect(competition!.state).toBe("CANCELLED_WITHOUT_CHAMPION");

      const retry = await voidFixture(repo, published.semifinal2FixtureId, organizerId, "retry");
      expect(retry.alreadyFinalized).toBe(true);
      void teams;
    }, 20000);

    it("forfeit is idempotent on an already-finalized fixture", async () => {
      const { organizerId, teams, published, sf2 } = await setUpTwoFinalizedSemifinals();
      const retry = await forfeitFixture(repo, published.semifinal2FixtureId, organizerId, teams[3].competitionTeamId, "Should be a no-op — already finalized.");
      expect(retry.alreadyFinalized).toBe(true);
      expect(retry.winningCompetitionTeamId).toBe(teams[2].competitionTeamId);
      void sf2;
    }, 30000);
  });

  describe("minimum-participation invariant (UG-CR-REV-015 decision 4) — UG-CR-RPT-030 correction 1", () => {
    it("a roster below 4 actually-participating members per team cannot support an ordinary evidence submission", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = [
        await joinTeamAsApprovedMember(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Under-A1"),
        await joinTeamAsApprovedMember(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Under-A2"),
      ];
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Under-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("Min Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);

      const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      await expect(
        submitFixtureEvidence(
          repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0,
          [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null
        )
      ).rejects.toBeInstanceOf(MinimumParticipationNotMetError);
    }, 20000);

    it("exactly 4 actually-participating members per team can proceed to an ordinary result", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers: string[] = [];
      for (let i = 0; i < 4; i++) teamAMembers.push(await joinTeamAsApprovedMember(competitionId, teams[0].competitionTeamId, teams[0].captainId, `Exact4-A${i}`));
      const teamBMembers: string[] = [];
      for (let i = 0; i < 4; i++) teamBMembers.push(await joinTeamAsApprovedMember(competitionId, teams[1].competitionTeamId, teams[1].captainId, `Exact4-B${i}`));
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("Exact4 Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      const attestations: ParticipationAttestationInput[] = [...teamAMembers, ...teamBMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const evidence = await submitFixtureEvidence(
        repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0,
        [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null
      );
      expect(evidence.alreadySubmitted).toBe(false);
      const finalized = await finalizeFixture(repo, published.semifinal1FixtureId, organizerId);
      expect(finalized.outcomeType).toBe("NORMAL");
    }, 20000);

    it("check-in alone does not prove participation — a checked-in member explicitly attested as NOT participating never counts toward the minimum", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "CheckinOnly-A");
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "CheckinOnly-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      for (const memberId of teamAMembers) await checkIn(repo, published.semifinal1FixtureId, memberId);
      const scorekeeper = await createRealGamingMember("CheckinOnly Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      const attestations: ParticipationAttestationInput[] = [
        ...teamAMembers.slice(0, 3).map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true })),
        ...teamAMembers.slice(3).map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: false })),
        ...teamBMembers.map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true })),
      ];
      await expect(
        submitFixtureEvidence(
          repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0,
          [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null
        )
      ).rejects.toBeInstanceOf(MinimumParticipationNotMetError);
    }, 20000);

    it("roster membership alone does not prove participation — an on-roster member simply omitted from the attestation array never counts toward the minimum", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "RosterOnly-A");
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "RosterOnly-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);
      const scorekeeper = await createRealGamingMember("RosterOnly Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper.gamingMemberId);
      const attestations: ParticipationAttestationInput[] = [
        ...teamAMembers.slice(0, 3).map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true })),
        ...teamBMembers.map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true })),
      ];
      await expect(
        submitFixtureEvidence(
          repo, published.semifinal1FixtureId, scorekeeper.gamingMemberId, 1, 0,
          [{ scorerGamingMemberId: teamAMembers[0], competitionTeamId: teams[0].competitionTeamId }], [], attestations, null
        )
      ).rejects.toBeInstanceOf(MinimumParticipationNotMetError);
    }, 20000);

    it("forfeit and void remain available under the minimum, without inventing any participation record", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamAMembers = [await joinTeamAsApprovedMember(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Forfeit-A1")];
      const teamBMembers = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Forfeit-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, teamAMembers);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, teamBMembers);

      const forfeited = await forfeitFixture(repo, published.semifinal1FixtureId, organizerId, teams[0].competitionTeamId, "Team A could not field the minimum of 4 players.");
      expect(forfeited.alreadyFinalized).toBe(false);
      expect(forfeited.winningCompetitionTeamId).toBe(teams[1].competitionTeamId);
      const { data: sf1Records } = await cleanupClient.from("competition_member_participation_records").select("*").eq("competition_fixture_id", published.semifinal1FixtureId);
      expect(sf1Records).toHaveLength(0);

      const voided = await voidFixture(repo, published.semifinal2FixtureId, organizerId, "Neither team could field the minimum.");
      expect(voided.competitionState).toBe("CANCELLED_WITHOUT_CHAMPION");
      const { data: sf2Records } = await cleanupClient.from("competition_member_participation_records").select("*").eq("competition_fixture_id", published.semifinal2FixtureId);
      expect(sf2Records).toHaveLength(0);
    }, 20000);

    it("rejects an empty roster", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      await expect(
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, [])
      ).rejects.toBeInstanceOf(EmptyRosterError);
    }, 15000);

    it("rejects a roster listing the same gaming member twice", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const member = await joinTeamAsApprovedMember(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Dup");
      await expect(
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, [member, member])
      ).rejects.toBeInstanceOf(DuplicateRosterEntryError);
    }, 15000);

    it("rejects a cross-team roster entry (a member approved on a different team)", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      const teamBMember = await joinTeamAsApprovedMember(competitionId, teams[1].competitionTeamId, teams[1].captainId, "CrossTeam");
      await expect(
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, [teamBMember])
      ).rejects.toBeInstanceOf(RosterMemberNotApprovedError);
    }, 15000);

    it("rejects a malformed roster entry (a gaming member ID with no membership at all)", async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);
      await expect(
        declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, [randomUUID()])
      ).rejects.toBeInstanceOf(RosterMemberNotApprovedError);
    }, 15000);
  });

  describe("full 20-member, 4-team tournament to COMPLETE (UG-CR-RPT-030 correction 3)", () => {
    it(
      "runs the complete accepted Soccer Slice 001 journey end to end: create/publish, 20 members register/join/approve, both semifinals (one normal, one tied-with-shootout) finalize and populate the final, a dispute and a non-winner-changing correction supersede a semifinal's persistent records without erasing history, the final finalizes to COMPLETE with a verified champion, and every relevant member's private persistent record is correct",
      async () => {
        const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
        const published = await publishDefault(competitionId, organizerId, teams);

        // 20 synthetic members total: 5 per team, register+join+approve — the gate-required minimum local dataset.
        const teamMembers = await Promise.all(
          teams.map((team, i) => buildApprovedRosterOfFive(competitionId, team.competitionTeamId, team.captainId, `T${i}`))
        );
        expect(teamMembers.flat()).toHaveLength(20);

        async function runFixtureToFinalization(
          fixtureId: string, teamAIndex: number, teamBIndex: number,
          teamAScore: number, teamBScore: number, shootoutWinnerIndex: number | null, label: string
        ) {
          await declareRoster(repo, fixtureId, teams[teamAIndex].competitionTeamId, teams[teamAIndex].captainId, false, null, teamMembers[teamAIndex]);
          await declareRoster(repo, fixtureId, teams[teamBIndex].competitionTeamId, teams[teamBIndex].captainId, false, null, teamMembers[teamBIndex]);
          for (const memberId of [...teamMembers[teamAIndex], ...teamMembers[teamBIndex]]) {
            await checkIn(repo, fixtureId, memberId);
          }
          const scorekeeper = await createRealGamingMember(`${label} Scorekeeper`);
          await appointScorekeeper(repo, fixtureId, organizerId, scorekeeper.gamingMemberId);

          const attestations: ParticipationAttestationInput[] = [...teamMembers[teamAIndex], ...teamMembers[teamBIndex]].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
          const goalEvents: GoalEventInput[] = [];
          for (let i = 0; i < teamAScore; i++) goalEvents.push({ scorerGamingMemberId: teamMembers[teamAIndex][i % 5], competitionTeamId: teams[teamAIndex].competitionTeamId });
          for (let i = 0; i < teamBScore; i++) goalEvents.push({ scorerGamingMemberId: teamMembers[teamBIndex][i % 5], competitionTeamId: teams[teamBIndex].competitionTeamId });
          const shootoutWinnerTeamId = shootoutWinnerIndex !== null ? teams[shootoutWinnerIndex].competitionTeamId : null;

          const evidence = await submitFixtureEvidence(repo, fixtureId, scorekeeper.gamingMemberId, teamAScore, teamBScore, goalEvents, [], attestations, shootoutWinnerTeamId);
          const finalized = await finalizeFixture(repo, fixtureId, organizerId);
          return { scorekeeper, finalized, evidence };
        }

        // Semifinal 1 (teams 0 vs 1): a normal, decisive result.
        const sf1 = await runFixtureToFinalization(published.semifinal1FixtureId, 0, 1, 2, 1, null, "SF1");
        expect(sf1.finalized.winningCompetitionTeamId).toBe(teams[0].competitionTeamId);

        // A dispute is raised against SF1's own CURRENT evidence row (the real SCORE fact), still open at this point.
        const dispute = await raiseDispute(repo, published.semifinal1FixtureId, teams[1].captainId, "SCORE", sf1.evidence.competitionFixtureEvidenceId, "We believe a goal was miscredited.");

        // A non-winner-changing correction (score unchanged, one goal re-attributed to a different Team 0 player) supersedes SF1's persistent records without erasing history, and atomically resolves the open dispute.
        const correctedGoalEvents: GoalEventInput[] = [
          { scorerGamingMemberId: teamMembers[0][1], competitionTeamId: teams[0].competitionTeamId },
          { scorerGamingMemberId: teamMembers[0][2], competitionTeamId: teams[0].competitionTeamId },
          { scorerGamingMemberId: teamMembers[1][0], competitionTeamId: teams[1].competitionTeamId },
        ];
        const corrected = await correctFixture(repo, published.semifinal1FixtureId, organizerId, "Re-attributing the second goal to the correct scorer.", 2, 1, correctedGoalEvents, [], null);
        expect(corrected.cascadeOutcome).toBe("NONE");
        expect(corrected.newWinningCompetitionTeamId).toBe(teams[0].competitionTeamId);

        const disputes = await repo.getDisputes(published.semifinal1FixtureId);
        expect(disputes.find((d) => d.competitionDisputeId === dispute.competitionDisputeId)!.resolutionAction).toBe("CORRECTED");

        // The corrected scorer's record now shows the goal; the record is a NEW superseding row, and the original still exists (never erased).
        const correctedScorerRecords = await repo.getMemberParticipationRecords(competitionId, teamMembers[0][2]);
        expect(correctedScorerRecords).toHaveLength(1);
        expect(correctedScorerRecords[0].goals).toBe(1);
        const { data: allSf1RecordsForThatMember } = await cleanupClient
          .from("competition_member_participation_records")
          .select("*")
          .eq("competition_fixture_id", published.semifinal1FixtureId)
          .eq("gaming_member_id", teamMembers[0][2]);
        expect(allSf1RecordsForThatMember).toHaveLength(2); // original (goals: 0, is_current: false) + corrected (goals: 1, is_current: true)
        expect(allSf1RecordsForThatMember!.some((r) => r.is_current === false)).toBe(true);

        // Semifinal 2 (teams 2 vs 3): tied regulation, resolved by shootout.
        const sf2 = await runFixtureToFinalization(published.semifinal2FixtureId, 2, 3, 1, 1, 3, "SF2");
        expect(sf2.finalized.winningCompetitionTeamId).toBe(teams[3].competitionTeamId);

        // Both semifinal winners populate the FINAL's slots.
        const finalBeforePlay = await repo.getFixtureById(published.finalFixtureId);
        expect(finalBeforePlay!.teamACompetitionTeamId).toBe(teams[0].competitionTeamId);
        expect(finalBeforePlay!.teamBCompetitionTeamId).toBe(teams[3].competitionTeamId);

        // The FINAL: team 0 (SF1 winner) vs team 3 (SF2 winner).
        const final = await runFixtureToFinalization(published.finalFixtureId, 0, 3, 3, 1, null, "FINAL");
        expect(final.finalized.winningCompetitionTeamId).toBe(teams[0].competitionTeamId);

        const competition = await repo.getCompetitionById(competitionId);
        expect(competition!.state).toBe("COMPLETE");

        // The champion's own scoring member has a correct, private persistent record for the FINAL.
        const championScorerRecords = await repo.getMemberParticipationRecords(competitionId, teamMembers[0][0]);
        const finalRecordForChampionScorer = championScorerRecords.find((r) => r.competitionFixtureId === published.finalFixtureId);
        expect(finalRecordForChampionScorer).toBeDefined();
        expect(finalRecordForChampionScorer!.appeared).toBe(true);
        expect(finalRecordForChampionScorer!.goals).toBeGreaterThan(0);

        // The losing finalist's non-scoring member has an accurate record too: appeared, zero fabricated goals/assists.
        const runnerUpRecords = await repo.getMemberParticipationRecords(competitionId, teamMembers[3][4]);
        const finalRecordForRunnerUp = runnerUpRecords.find((r) => r.competitionFixtureId === published.finalFixtureId);
        expect(finalRecordForRunnerUp).toBeDefined();
        expect(finalRecordForRunnerUp!.appeared).toBe(true);
        expect(finalRecordForRunnerUp!.goals).toBe(0);
        expect(finalRecordForRunnerUp!.assists).toBe(0);
      },
      60000
    );
  });

  // UG-CR-GATE-032: Code Review returned RPT-031 for exactly one bounded
  // correction — raise_competition_dispute_atomically had no authorization
  // check at all beyond "the fixture exists," so any authenticated member
  // could dispute any fact naming anyone. This block proves the corrected
  // RPC now independently derives, from current database state alone,
  // whether the caller is the directly-affected member or an authorized
  // captain for the SPECIFIC target fact named — never trusting the UI,
  // the HTTP route, or any client-supplied claim.
  describe("dispute authorization at the SQL boundary (UG-CR-GATE-032)", () => {
    type DisputeAuthFixture = {
      competitionId: string;
      organizerId: string;
      teams: Array<{ competitionTeamId: string; captainId: string }>;
      sf1FixtureId: string;
      sf2FixtureId: string;
      sf1EvidenceId: string;
      sf1GoalId: string;
      sf1AssistId: string;
      sf1AttestationTeam0Player0Id: string;
      sf1AttestationTeam1Player0Id: string;
      sf2SupersededEvidenceId: string;
      team0Players: string[];
      team1Players: string[];
      unrelatedRegisteredMemberId: string;
      unregisteredMemberId: string;
      otherCompetitionCaptainId: string;
    };

    let ctx: DisputeAuthFixture;

    async function currentGoalEventId(fixtureId: string, scorerGamingMemberId: string): Promise<string> {
      const { data, error } = await cleanupClient
        .from("soccer_goal_events").select("soccer_goal_event_id")
        .eq("competition_fixture_id", fixtureId).eq("scorer_gaming_member_id", scorerGamingMemberId).eq("is_current", true).single();
      if (error || !data) throw error ?? new Error("goal event not found");
      return data.soccer_goal_event_id;
    }
    async function currentAssistEventId(fixtureId: string, assistingGamingMemberId: string): Promise<string> {
      const { data, error } = await cleanupClient
        .from("soccer_assist_events").select("soccer_assist_event_id")
        .eq("competition_fixture_id", fixtureId).eq("assisting_gaming_member_id", assistingGamingMemberId).eq("is_current", true).single();
      if (error || !data) throw error ?? new Error("assist event not found");
      return data.soccer_assist_event_id;
    }
    async function currentAttestationId(fixtureId: string, gamingMemberId: string): Promise<string> {
      const { data, error } = await cleanupClient
        .from("competition_participation_attestations").select("competition_participation_attestation_id")
        .eq("competition_fixture_id", fixtureId).eq("gaming_member_id", gamingMemberId).eq("is_current", true).single();
      if (error || !data) throw error ?? new Error("attestation not found");
      return data.competition_participation_attestation_id;
    }

    beforeAll(async () => {
      const { organizerId, competitionId, teams } = await setUpCompetitionWith4Teams();
      const published = await publishDefault(competitionId, organizerId, teams);

      const team0Players = await buildApprovedRosterOfFive(competitionId, teams[0].competitionTeamId, teams[0].captainId, "Disp-A");
      const team1Players = await buildApprovedRosterOfFive(competitionId, teams[1].competitionTeamId, teams[1].captainId, "Disp-B");
      await declareRoster(repo, published.semifinal1FixtureId, teams[0].competitionTeamId, teams[0].captainId, false, null, team0Players);
      await declareRoster(repo, published.semifinal1FixtureId, teams[1].competitionTeamId, teams[1].captainId, false, null, team1Players);
      const scorekeeper1 = await createRealGamingMember("Dispute-Auth SF1 Scorekeeper");
      await appointScorekeeper(repo, published.semifinal1FixtureId, organizerId, scorekeeper1.gamingMemberId);
      const attestations1: ParticipationAttestationInput[] = [...team0Players, ...team1Players].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const goalEvents1: GoalEventInput[] = [{ scorerGamingMemberId: team0Players[0], competitionTeamId: teams[0].competitionTeamId }];
      const assistEvents1: AssistEventInput[] = [{ assistingGamingMemberId: team0Players[1], goalEventIndex: 0 }];
      const sf1Evidence = await submitFixtureEvidence(repo, published.semifinal1FixtureId, scorekeeper1.gamingMemberId, 1, 0, goalEvents1, assistEvents1, attestations1, null);

      // SF2 — an independently-evidenced second fixture, used only to obtain
      // real fact ids that genuinely exist but belong to a DIFFERENT fixture
      // than SF1 (the fabricated-cross-fixture-reference case), and then
      // corrected to obtain a real, once-current, now-SUPERSEDED fact.
      const team2Players = await buildApprovedRosterOfFive(competitionId, teams[2].competitionTeamId, teams[2].captainId, "Disp-C");
      const team3Players = await buildApprovedRosterOfFive(competitionId, teams[3].competitionTeamId, teams[3].captainId, "Disp-D");
      await declareRoster(repo, published.semifinal2FixtureId, teams[2].competitionTeamId, teams[2].captainId, false, null, team2Players);
      await declareRoster(repo, published.semifinal2FixtureId, teams[3].competitionTeamId, teams[3].captainId, false, null, team3Players);
      const scorekeeper2 = await createRealGamingMember("Dispute-Auth SF2 Scorekeeper");
      await appointScorekeeper(repo, published.semifinal2FixtureId, organizerId, scorekeeper2.gamingMemberId);
      const attestations2: ParticipationAttestationInput[] = [...team2Players, ...team3Players].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
      const sf2Evidence = await submitFixtureEvidence(
        repo, published.semifinal2FixtureId, scorekeeper2.gamingMemberId, 1, 0,
        [{ scorerGamingMemberId: team2Players[0], competitionTeamId: teams[2].competitionTeamId }], [], attestations2, null
      );
      const sf2SupersededEvidenceId = sf2Evidence.competitionFixtureEvidenceId;
      // The organizer corrects SF2 (2-0 instead of 1-0) — this marks the
      // ORIGINAL evidence row (captured above) is_current = false, without
      // touching SF1 at all.
      await correctFixture(
        repo, published.semifinal2FixtureId, organizerId, "Correcting for the dispute-authorization fixture.", 2, 0,
        [
          { scorerGamingMemberId: team2Players[0], competitionTeamId: teams[2].competitionTeamId },
          { scorerGamingMemberId: team2Players[1], competitionTeamId: teams[2].competitionTeamId },
        ],
        [], null
      );

      const unrelatedRegistered = await createRealGamingMember("Unrelated Registered Member");
      await registerForCompetition(repo, competitionId, unrelatedRegistered.gamingMemberId, true);
      const unregistered = await createRealGamingMember("Never Registered Member");
      const otherCompetition = await setUpCompetitionWith4Teams();

      ctx = {
        competitionId, organizerId, teams,
        sf1FixtureId: published.semifinal1FixtureId,
        sf2FixtureId: published.semifinal2FixtureId,
        sf1EvidenceId: sf1Evidence.competitionFixtureEvidenceId,
        sf1GoalId: await currentGoalEventId(published.semifinal1FixtureId, team0Players[0]),
        sf1AssistId: await currentAssistEventId(published.semifinal1FixtureId, team0Players[1]),
        sf1AttestationTeam0Player0Id: await currentAttestationId(published.semifinal1FixtureId, team0Players[0]),
        sf1AttestationTeam1Player0Id: await currentAttestationId(published.semifinal1FixtureId, team1Players[0]),
        sf2SupersededEvidenceId,
        team0Players, team1Players,
        unrelatedRegisteredMemberId: unrelatedRegistered.gamingMemberId,
        unregisteredMemberId: unregistered.gamingMemberId,
        otherCompetitionCaptainId: otherCompetition.teams[0].captainId,
      };
    }, 60000);

    it("a member can dispute their own participation attestation", async () => {
      const result = await raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "PARTICIPATION_ATTESTATION", ctx.sf1AttestationTeam0Player0Id, "I did actually play.");
      expect(result.competitionDisputeId).toBeTruthy();
    });

    it("a member can dispute their own goal attribution", async () => {
      const result = await raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "GOAL_EVENT", ctx.sf1GoalId, "That wasn't my goal.");
      expect(result.competitionDisputeId).toBeTruthy();
    });

    it("a member can dispute their own assist attribution", async () => {
      const result = await raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[1], "ASSIST_EVENT", ctx.sf1AssistId, "I did not assist that goal.");
      expect(result.competitionDisputeId).toBeTruthy();
    });

    it("the captain of a competing team can dispute that team's score", async () => {
      const result = await raiseDispute(repo, ctx.sf1FixtureId, ctx.teams[1].captainId, "SCORE", ctx.sf1EvidenceId, "We believe the score is wrong.");
      expect(result.competitionDisputeId).toBeTruthy();
    });

    it("the captain can dispute a fact affecting their own rostered player (a goal credited to a teammate, not the captain themselves)", async () => {
      const result = await raiseDispute(repo, ctx.sf1FixtureId, ctx.teams[0].captainId, "GOAL_EVENT", ctx.sf1GoalId, "Wrong player credited for our team's goal.");
      expect(result.competitionDisputeId).toBeTruthy();
    });

    it("an unrelated registered member is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.unrelatedRegisteredMemberId, "GOAL_EVENT", ctx.sf1GoalId, "I don't like this result.")
      ).rejects.toBeInstanceOf(DisputeNotAuthorizedError);
    });

    it("an unregistered authenticated member is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.unregisteredMemberId, "PARTICIPATION_ATTESTATION", ctx.sf1AttestationTeam0Player0Id, "Objection.")
      ).rejects.toBeInstanceOf(DisputeNotAuthorizedError);
    });

    it("the opposing team's ordinary member is rejected from disputing another player's individual attribution", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.team1Players[0], "GOAL_EVENT", ctx.sf1GoalId, "I think that goal is fake.")
      ).rejects.toBeInstanceOf(DisputeNotAuthorizedError);
    });

    it("a captain from another competition team (same competition, not competing in this fixture) is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.teams[2].captainId, "SCORE", ctx.sf1EvidenceId, "Objection from an uninvolved team's captain.")
      ).rejects.toBeInstanceOf(DisputeNotAuthorizedError);
    });

    it("a captain from a different competition entirely is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.otherCompetitionCaptainId, "SCORE", ctx.sf1EvidenceId, "Objection from a captain with no relation to this competition.")
      ).rejects.toBeInstanceOf(DisputeNotAuthorizedError);
    });

    it("a fabricated target ID is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "GOAL_EVENT", randomUUID(), "This ID does not exist.")
      ).rejects.toBeInstanceOf(TargetFactNotFoundError);
    });

    it("a real target ID belonging to another fixture is rejected", async () => {
      // sf2Evidence's own fixture is SF2, not SF1 — a real, once-valid id, just the wrong fixture.
      const { data: sf2CurrentEvidence } = await cleanupClient
        .from("competition_fixture_evidence").select("competition_fixture_evidence_id")
        .eq("competition_fixture_id", ctx.sf2FixtureId).eq("is_current", true).single();
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "SCORE", sf2CurrentEvidence!.competition_fixture_evidence_id, "Cross-fixture reference attempt.")
      ).rejects.toBeInstanceOf(TargetFactFixtureMismatchError);
    });

    it("an unsupported target type (SHOOTOUT — never in the accepted design's dispute enum, UG-CR-RPT-020 §3, and removed from the table's own CHECK constraint by UG-CR-GATE-033) is rejected", async () => {
      await expect(
        raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "SHOOTOUT", randomUUID(), "Disputing the shootout outcome.")
      ).rejects.toBeInstanceOf(UnsupportedTargetFactTypeError);
    });

    it("a superseded/non-current fact cannot receive a new dispute", async () => {
      await expect(
        raiseDispute(repo, ctx.sf2FixtureId, ctx.teams[2].captainId, "SCORE", ctx.sf2SupersededEvidenceId, "Disputing the old, now-corrected score.")
      ).rejects.toBeInstanceOf(TargetFactNotCurrentError);
    });

    it("concurrent valid disputes on the same fact remain additive and never change the underlying authoritative fact", async () => {
      const [d1, d2] = await Promise.all([
        raiseDispute(repo, ctx.sf1FixtureId, ctx.team0Players[0], "GOAL_EVENT", ctx.sf1GoalId, "Concurrent dispute 1."),
        raiseDispute(repo, ctx.sf1FixtureId, ctx.teams[0].captainId, "GOAL_EVENT", ctx.sf1GoalId, "Concurrent dispute 2."),
      ]);
      expect(d1.competitionDisputeId).not.toBe(d2.competitionDisputeId);

      const { data: goalRow } = await cleanupClient
        .from("soccer_goal_events").select("*").eq("soccer_goal_event_id", ctx.sf1GoalId).single();
      expect(goalRow!.is_current).toBe(true);
      expect(goalRow!.scorer_gaming_member_id).toBe(ctx.team0Players[0]);
      expect(goalRow!.competition_team_id).toBe(ctx.teams[0].competitionTeamId);
    });
  });
});

describe("Branded Team Registration and Invitation Journey — corrected lifecycle contract (UG-CR-RPT-041/042)", () => {
  describe("lifecycle transitions", () => {
    it("registration works in TEAM_REGISTRATION_OPEN and READY_TO_PUBLISH, not only PUBLISHED — a strict widening of the original PUBLISHED-only rule", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const memberInOpen = await createRealGamingMember("Member In Open");
      const reg1 = await registerForCompetition(repo, ctx.competitionId, memberInOpen.gamingMemberId, true);
      expect(reg1.alreadyRegistered).toBe(false);

      // Advance to READY_TO_PUBLISH via 4 accepted organizer-created teams.
      const captains = await Promise.all([1, 2, 3, 4].map((i) => createRealGamingMember(`Cap ${i}`)));
      for (let i = 0; i < 4; i++) {
        await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, `Team ${i}`, captains[i].gamingMemberId);
      }
      await closeTeamRegistration(repo, ctx.competitionId, ctx.organizerId);

      const memberInReady = await createRealGamingMember("Member In Ready");
      const reg2 = await registerForCompetition(repo, ctx.competitionId, memberInReady.gamingMemberId, true);
      expect(reg2.alreadyRegistered).toBe(false);
    });

    it("registration still fails from DRAFT (before team registration ever opens)", async () => {
      const organizer = await createRealGamingMember("Draft Organizer");
      await grantOperationalAuthority(organizer.gamingMemberId);
      const competition = await createCompetition(repo, organizer.gamingMemberId, `Draft Cup ${randomUUID().slice(0, 8)}`, "SOCCER_5V5");
      createdCompetitionIds.push(competition.competitionId);
      const member = await createRealGamingMember("Eager Member");

      await expect(registerForCompetition(repo, competition.competitionId, member.gamingMemberId, true)).rejects.toBeInstanceOf(CompetitionNotPublishedError);
    });

    it("OPEN_TEAM_REGISTRATION is organizer-only and DRAFT-only", async () => {
      const organizer = await createRealGamingMember("Organizer");
      await grantOperationalAuthority(organizer.gamingMemberId);
      const competition = await createCompetition(repo, organizer.gamingMemberId, `Cup ${randomUUID().slice(0, 8)}`, "SOCCER_5V5");
      createdCompetitionIds.push(competition.competitionId);
      const impostor = await createRealGamingMember("Impostor");

      await expect(openTeamRegistration(repo, competition.competitionId, impostor.gamingMemberId)).rejects.toBeInstanceOf(CompetitionAccessDeniedError);

      await openTeamRegistration(repo, competition.competitionId, organizer.gamingMemberId);
      await expect(openTeamRegistration(repo, competition.competitionId, organizer.gamingMemberId)).rejects.toBeInstanceOf(CompetitionNotDraftError);
    });

    it("PUBLISH_COMPETITION fails from DRAFT and from TEAM_REGISTRATION_OPEN — only READY_TO_PUBLISH is accepted", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captains = await Promise.all([1, 2, 3, 4].map((i) => createRealGamingMember(`Cap ${i}`)));
      const teams = [];
      for (let i = 0; i < 4; i++) {
        const t = await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, `Team ${i}`, captains[i].gamingMemberId);
        teams.push(t.competitionTeamId);
      }
      const publishArgs = [
        ctx.competitionId, ctx.organizerId, teams[0], teams[1], teams[2], teams[3],
        futureIso(60000), futureIso(120000), futureIso(180000),
      ] as const;

      // Still TEAM_REGISTRATION_OPEN — not yet closed.
      await expect(publishCompetition(repo, ...publishArgs)).rejects.toBeInstanceOf(CompetitionNotReadyToPublishError);

      await closeTeamRegistration(repo, ctx.competitionId, ctx.organizerId);
      const published = await publishCompetition(repo, ...publishArgs);
      expect(published.state).toBe("PUBLISHED");
    });

    it("CLOSE_TEAM_REGISTRATION requires exactly four ACCEPTED teams, and is organizer-only", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const impostor = await createRealGamingMember("Impostor");
      await expect(closeTeamRegistration(repo, ctx.competitionId, impostor.gamingMemberId)).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
      await expect(closeTeamRegistration(repo, ctx.competitionId, ctx.organizerId)).rejects.toBeInstanceOf(TeamRegistrationCapacityNotReachedError);

      const captains = await Promise.all([1, 2, 3].map((i) => createRealGamingMember(`Cap ${i}`)));
      for (let i = 0; i < 3; i++) await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, `Team ${i}`, captains[i].gamingMemberId);
      await expect(closeTeamRegistration(repo, ctx.competitionId, ctx.organizerId)).rejects.toBeInstanceOf(TeamRegistrationCapacityNotReachedError);

      const fourth = await createRealGamingMember("Cap 4");
      await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "Team 4", fourth.gamingMemberId);
      const closed = await closeTeamRegistration(repo, ctx.competitionId, ctx.organizerId);
      expect(closed.state).toBe("READY_TO_PUBLISH");
    });

    it("ADD_COMPETITION_TEAM (the organizer-created path) is ALSO hard-capped at four — a fifth organizer-created team fails with TeamCapacityReachedError rather than being silently accepted", async () => {
      // Regression coverage for a real defect caught only by live browser
      // validation (UG-CR-RPT-042 §15): the organizer-created path used
      // its own `competitions` row lock, never the shared
      // 'competition_team_scope:<id>' advisory lock that
      // DECIDE_COMPETITION_TEAM's APPROVE branch and
      // CLOSE_TEAM_REGISTRATION already use, and never rechecked the
      // four-accepted-team count at all — so a fifth organizer-created
      // team was accepted outright, producing "5 of 4 teams accepted".
      const ctx = await setUpCompetitionForTeamRegistration();
      const captains = await Promise.all([1, 2, 3, 4, 5].map((i) => createRealGamingMember(`ACT Cap ${i}`)));
      for (let i = 0; i < 4; i++) {
        await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, `ACT Team ${i}`, captains[i].gamingMemberId);
      }
      await expect(
        addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "ACT Team 4", captains[4].gamingMemberId)
      ).rejects.toBeInstanceOf(TeamCapacityReachedError);

      const accepted = await repo.getCompetitionTeams(ctx.competitionId);
      expect(accepted.filter((t) => t.status === "ACCEPTED")).toHaveLength(4);
    });

    it("a fifth team accepted via one path is refused via the OTHER path too — ADD_COMPETITION_TEAM and DECIDE_COMPETITION_TEAM share the same capacity count", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const organizerCaptains = await Promise.all([1, 2, 3].map((i) => createRealGamingMember(`Mixed Cap ${i}`)));
      for (let i = 0; i < 3; i++) {
        await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, `Mixed Team ${i}`, organizerCaptains[i].gamingMemberId);
      }
      const proposer = await registeredMember(ctx.competitionId, "Mixed Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Mixed Proposed Team", proposer.gamingMemberId);
      const decision = await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);
      expect(decision.status).toBe("ACCEPTED"); // 4th accepted team, via the proposal path

      const fifthCaptain = await createRealGamingMember("Mixed Cap 5");
      await expect(
        addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "Mixed Team 3", fifthCaptain.gamingMemberId)
      ).rejects.toBeInstanceOf(TeamCapacityReachedError);
    });
  });

  describe("team proposal, decision, and atomic captain/membership confirmation", () => {
    it("a registered member may propose a team while registration is open; it starts PENDING_ORGANIZER_APPROVAL and consumes no accepted slot", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const member = await registeredMember(ctx.competitionId, "Proposer");

      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Proposed United", member.gamingMemberId);
      expect(proposal.status).toBe("PENDING_ORGANIZER_APPROVAL");

      const teams = await repo.getCompetitionTeams(ctx.competitionId);
      const row = teams.find((t) => t.competitionTeamId === proposal.competitionTeamId)!;
      expect(row.status).toBe("PENDING_ORGANIZER_APPROVAL");
      expect(row.provenance).toBe("MEMBER_PROPOSED");
      expect(row.captainGamingMemberId).toBe(member.gamingMemberId);

      const membership = await repo.getMyTeamMembership(ctx.competitionId, member.gamingMemberId);
      expect(membership).toBeNull(); // no membership yet — only organizer acceptance confirms it
    });

    it("proposing without registering first fails with CompetitionRegistrationRequiredError", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const unregistered = await createRealGamingMember("Unregistered");
      await expect(proposeCompetitionTeam(repo, ctx.competitionId, "No Registration FC", unregistered.gamingMemberId)).rejects.toBeInstanceOf(CompetitionRegistrationRequiredError);
    });

    it("proposing outside TEAM_REGISTRATION_OPEN fails with TeamRegistrationNotOpenError", async () => {
      const organizer = await createRealGamingMember("Organizer");
      await grantOperationalAuthority(organizer.gamingMemberId);
      const competition = await createCompetition(repo, organizer.gamingMemberId, `Draft Cup ${randomUUID().slice(0, 8)}`, "SOCCER_5V5");
      createdCompetitionIds.push(competition.competitionId);
      const member = await createRealGamingMember("Eager Member");
      await expect(proposeCompetitionTeam(repo, competition.competitionId, "Too Early FC", member.gamingMemberId)).rejects.toBeInstanceOf(TeamRegistrationNotOpenError);
    });

    it("a duplicate team name (case/whitespace normalized) is rejected — but rejected history does not block a later proposal reusing the same normalized name", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const first = await registeredMember(ctx.competitionId, "First Proposer");
      const second = await registeredMember(ctx.competitionId, "Second Proposer");
      const third = await registeredMember(ctx.competitionId, "Third Proposer");

      await proposeCompetitionTeam(repo, ctx.competitionId, "United FC", first.gamingMemberId);
      await expect(proposeCompetitionTeam(repo, ctx.competitionId, "  united fc  ", second.gamingMemberId)).rejects.toBeInstanceOf(DuplicateTeamNameError);

      // Reject the first, freeing the normalized name for reuse.
      const teams = await repo.getCompetitionTeams(ctx.competitionId);
      const firstTeam = teams.find((t) => t.captainGamingMemberId === first.gamingMemberId)!;
      await decideCompetitionTeam(repo, firstTeam.competitionTeamId, ctx.organizerId, "REJECT", "Duplicate submission.");

      const reproposed = await proposeCompetitionTeam(repo, ctx.competitionId, "United FC", third.gamingMemberId);
      expect(reproposed.status).toBe("PENDING_ORGANIZER_APPROVAL");
    });

    it("a member already holding a confirmed team membership cannot propose a second team", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captain = await registeredMember(ctx.competitionId, "Captain");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Team One", captain.gamingMemberId);
      await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);

      await expect(proposeCompetitionTeam(repo, ctx.competitionId, "Team Two", captain.gamingMemberId)).rejects.toBeInstanceOf(AlreadyTeamMemberError);
    });

    it("a member already holding an active (pending or accepted) captaincy cannot propose a second team", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captain = await registeredMember(ctx.competitionId, "Captain");
      await proposeCompetitionTeam(repo, ctx.competitionId, "Team One", captain.gamingMemberId);

      await expect(proposeCompetitionTeam(repo, ctx.competitionId, "Team Two", captain.gamingMemberId)).rejects.toBeInstanceOf(AlreadyCaptainOrMemberError);
    });

    it("organizer acceptance atomically confirms the proposer as captain AND creates exactly one team membership — no separate join-request or approval step", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Atomic FC", proposer.gamingMemberId);

      const decision = await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);
      expect(decision.status).toBe("ACCEPTED");
      expect(decision.competitionTeamMembershipId).not.toBeNull();

      const team = await repo.getCompetitionTeamById(proposal.competitionTeamId);
      expect(team!.status).toBe("ACCEPTED");
      expect(team!.captainGamingMemberId).toBe(proposer.gamingMemberId);

      const membership = await repo.getMyTeamMembership(ctx.competitionId, proposer.gamingMemberId);
      expect(membership).not.toBeNull();
      expect(membership!.competitionTeamId).toBe(proposal.competitionTeamId);
      expect(membership!.approvedByGamingMemberId).toBe(ctx.organizerId);
    });

    it("the creator never requests entry to their own team, and is never separately approved — request-join against their OWN pending team fails as TEAM_NOT_ACCEPTED, and once accepted their membership already exists so a self-request would fail as ALREADY_TEAM_MEMBER", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Self Proof FC", proposer.gamingMemberId);

      // While pending: cannot request-join at all (team not accepted yet).
      await expect(requestJoinTeam(repo, ctx.competitionId, proposal.competitionTeamId, proposer.gamingMemberId)).rejects.toBeInstanceOf(TeamNotAcceptedError);

      await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);

      // Once accepted, the proposer already has a membership from acceptance itself.
      await expect(requestJoinTeam(repo, ctx.competitionId, proposal.competitionTeamId, proposer.gamingMemberId)).rejects.toBeInstanceOf(AlreadyTeamMemberError);
    });

    it("rejecting a team proposal requires a reason, and retains the row (never deleted) with that reason attached", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Rejected FC", proposer.gamingMemberId);

      await expect(decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "REJECT", "")).rejects.toBeInstanceOf(ReasonRequiredError);

      const decision = await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "REJECT", "Roster incomplete.");
      expect(decision.status).toBe("REJECTED");

      const team = await repo.getCompetitionTeamById(proposal.competitionTeamId);
      expect(team).not.toBeNull(); // retained, never deleted
      expect(team!.status).toBe("REJECTED");
      expect(team!.rejectionReason).toBe("Roster incomplete.");
    });

    it("rejection and resubmission — a rejected proposer may propose a brand-new team; the original rejected row is untouched", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const first = await proposeCompetitionTeam(repo, ctx.competitionId, "First Attempt", proposer.gamingMemberId);
      await decideCompetitionTeam(repo, first.competitionTeamId, ctx.organizerId, "REJECT", "Not ready.");

      const second = await proposeCompetitionTeam(repo, ctx.competitionId, "Second Attempt", proposer.gamingMemberId);
      expect(second.competitionTeamId).not.toBe(first.competitionTeamId);

      const firstStillRejected = await repo.getCompetitionTeamById(first.competitionTeamId);
      expect(firstStillRejected!.status).toBe("REJECTED");
      expect(firstStillRejected!.rejectionReason).toBe("Not ready.");
    });

    it("DECIDE_COMPETITION_TEAM is idempotent for a repeated identical decision, but rejects a conflicting re-decision", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Idempotent FC", proposer.gamingMemberId);

      const first = await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);
      const second = await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "APPROVE", null);
      expect(second.competitionTeamMembershipId).toBe(first.competitionTeamMembershipId);
      expect(second.decidedAt).toBe(first.decidedAt);

      await expect(decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "REJECT", "changed my mind")).rejects.toBeInstanceOf(TeamDecisionAlreadyMadeError);
    });

    it("acceptance is hard-capped at four — a fifth ACCEPT attempt fails with TeamCapacityReachedError, and the rejected fifth team's own row is untouched", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposers = await Promise.all([1, 2, 3, 4, 5].map((i) => registeredMember(ctx.competitionId, `Proposer ${i}`)));
      const proposals = [];
      for (let i = 0; i < 5; i++) {
        proposals.push(await proposeCompetitionTeam(repo, ctx.competitionId, `Team ${i}`, proposers[i].gamingMemberId));
      }
      for (let i = 0; i < 4; i++) {
        const decision = await decideCompetitionTeam(repo, proposals[i].competitionTeamId, ctx.organizerId, "APPROVE", null);
        expect(decision.status).toBe("ACCEPTED");
      }
      await expect(decideCompetitionTeam(repo, proposals[4].competitionTeamId, ctx.organizerId, "APPROVE", null)).rejects.toBeInstanceOf(TeamCapacityReachedError);

      const fifthTeam = await repo.getCompetitionTeamById(proposals[4].competitionTeamId);
      expect(fifthTeam!.status).toBe("PENDING_ORGANIZER_APPROVAL"); // untouched — organizer may still explicitly reject it later
    });
  });

  describe("captaincy and membership exclusivity across proposal and join-request paths", () => {
    it("a member holding an active captaincy (pending or accepted) cannot be approved into another team via join-request", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captain = await registeredMember(ctx.competitionId, "Captain");
      await proposeCompetitionTeam(repo, ctx.competitionId, "Own Team", captain.gamingMemberId);

      const otherProposer = await registeredMember(ctx.competitionId, "Other Proposer");
      const otherTeam = await proposeCompetitionTeam(repo, ctx.competitionId, "Other Team", otherProposer.gamingMemberId);
      await decideCompetitionTeam(repo, otherTeam.competitionTeamId, ctx.organizerId, "APPROVE", null);

      // The early, friendly rejection at request time (captain already holds an active role).
      await expect(requestJoinTeam(repo, ctx.competitionId, otherTeam.competitionTeamId, captain.gamingMemberId)).rejects.toBeInstanceOf(AlreadyCaptainOrMemberError);
    });

    it("a confirmed team member cannot also propose a team (the reverse exclusivity direction) — reported as AlreadyTeamMemberError, the more precise of the two exclusivity errors for a MEMBER (as opposed to a captain)", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captain = await registeredMember(ctx.competitionId, "Captain");
      const team = await proposeCompetitionTeam(repo, ctx.competitionId, "Home Team", captain.gamingMemberId);
      await decideCompetitionTeam(repo, team.competitionTeamId, ctx.organizerId, "APPROVE", null);

      const joiner = await registeredMember(ctx.competitionId, "Joiner");
      const joinRequest = await requestJoinTeam(repo, ctx.competitionId, team.competitionTeamId, joiner.gamingMemberId);
      await decideJoinRequest(repo, joinRequest.competitionJoinRequestId, captain.gamingMemberId, "APPROVE", false);

      await expect(proposeCompetitionTeam(repo, ctx.competitionId, "Second Team", joiner.gamingMemberId)).rejects.toBeInstanceOf(AlreadyTeamMemberError);
    });

    it("request-join against a PENDING_ORGANIZER_APPROVAL team fails with TeamNotAcceptedError — an invitation opened before acceptance cannot be used to join", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Still Pending FC", proposer.gamingMemberId);
      const wouldBeJoiner = await registeredMember(ctx.competitionId, "Would-be Joiner");

      await expect(requestJoinTeam(repo, ctx.competitionId, proposal.competitionTeamId, wouldBeJoiner.gamingMemberId)).rejects.toBeInstanceOf(TeamNotAcceptedError);
    });

    it("request-join against a REJECTED team also fails with TeamNotAcceptedError", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposer = await registeredMember(ctx.competitionId, "Proposer");
      const proposal = await proposeCompetitionTeam(repo, ctx.competitionId, "Doomed FC", proposer.gamingMemberId);
      await decideCompetitionTeam(repo, proposal.competitionTeamId, ctx.organizerId, "REJECT", "Not viable.");
      const wouldBeJoiner = await registeredMember(ctx.competitionId, "Would-be Joiner");

      await expect(requestJoinTeam(repo, ctx.competitionId, proposal.competitionTeamId, wouldBeJoiner.gamingMemberId)).rejects.toBeInstanceOf(TeamNotAcceptedError);
    });
  });

  describe("concurrency — real Postgres, not merely an application precheck", () => {
    it("concurrent fifth-team accept attempts cannot produce five accepted teams — the advisory lock plus the recount serializes them correctly", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposers = await Promise.all([1, 2, 3, 4, 5].map((i) => registeredMember(ctx.competitionId, `Racer ${i}`)));
      const proposals = [];
      for (let i = 0; i < 5; i++) {
        proposals.push(await proposeCompetitionTeam(repo, ctx.competitionId, `Racer Team ${i}`, proposers[i].gamingMemberId));
      }
      // Accept the first three sequentially, then race the last two for the final slot.
      for (let i = 0; i < 3; i++) {
        await decideCompetitionTeam(repo, proposals[i].competitionTeamId, ctx.organizerId, "APPROVE", null);
      }
      const results = await Promise.allSettled([
        decideCompetitionTeam(repo, proposals[3].competitionTeamId, ctx.organizerId, "APPROVE", null),
        decideCompetitionTeam(repo, proposals[4].competitionTeamId, ctx.organizerId, "APPROVE", null),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TeamCapacityReachedError);

      const teams = await repo.getCompetitionTeams(ctx.competitionId);
      expect(teams.filter((t) => t.status === "ACCEPTED")).toHaveLength(4);
    });

    it("concurrent duplicate-normalized-name proposals produce at most one active (non-rejected) proposal", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const proposerA = await registeredMember(ctx.competitionId, "Proposer A");
      const proposerB = await registeredMember(ctx.competitionId, "Proposer B");

      const results = await Promise.allSettled([
        proposeCompetitionTeam(repo, ctx.competitionId, "Race Condition FC", proposerA.gamingMemberId),
        proposeCompetitionTeam(repo, ctx.competitionId, "race condition fc", proposerB.gamingMemberId),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateTeamNameError);

      const teams = await repo.getCompetitionTeams(ctx.competitionId);
      expect(teams.filter((t) => t.status !== "REJECTED")).toHaveLength(1);
    });

    it("a proposal race and a membership-approval race for the SAME member cannot place them across conflicting teams", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const contested = await registeredMember(ctx.competitionId, "Contested Member");
      const otherProposer = await registeredMember(ctx.competitionId, "Other Proposer");
      const otherTeam = await proposeCompetitionTeam(repo, ctx.competitionId, "Other Team", otherProposer.gamingMemberId);
      await decideCompetitionTeam(repo, otherTeam.competitionTeamId, ctx.organizerId, "APPROVE", null);
      const joinRequest = await requestJoinTeam(repo, ctx.competitionId, otherTeam.competitionTeamId, contested.gamingMemberId);

      // Race: the contested member's own team proposal vs. the captain approving their join request into a DIFFERENT team.
      const results = await Promise.allSettled([
        proposeCompetitionTeam(repo, ctx.competitionId, "Contested Team", contested.gamingMemberId),
        decideJoinRequest(repo, joinRequest.competitionJoinRequestId, otherProposer.gamingMemberId, "APPROVE", false),
      ]);
      const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
      expect(fulfilledCount).toBe(1); // exactly one of the two conflicting outcomes wins

      const membership = await repo.getMyTeamMembership(ctx.competitionId, contested.gamingMemberId);
      const proposedTeams = (await repo.getCompetitionTeams(ctx.competitionId)).filter((t) => t.captainGamingMemberId === contested.gamingMemberId);
      // Never both: a confirmed membership on one team AND an active captaincy proposal on another.
      expect(membership !== null && proposedTeams.some((t) => t.status !== "REJECTED")).toBe(false);
    });
  });

  describe("organizer-created teams migrate/insert truthfully", () => {
    it("an organizer-created team is ACCEPTED/ORGANIZER_CREATED from the moment it is created, and ADD_COMPETITION_TEAM still works from TEAM_REGISTRATION_OPEN (not only DRAFT)", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const captain = await createRealGamingMember("Organizer-Assigned Captain");
      const team = await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "Organizer Team", captain.gamingMemberId);

      const row = await repo.getCompetitionTeamById(team.competitionTeamId);
      expect(row!.status).toBe("ACCEPTED");
      expect(row!.provenance).toBe("ORGANIZER_CREATED");
    });

    it("an organizer cannot assign the same captain to two teams in the same competition (the shared one-active-captaincy index applies to organizer-created teams too)", async () => {
      const ctx = await setUpCompetitionForTeamRegistration();
      const sharedCaptain = await createRealGamingMember("Double-Booked Captain");
      await addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "Team One", sharedCaptain.gamingMemberId);

      await expect(addCompetitionTeam(repo, ctx.competitionId, ctx.organizerId, "Team Two", sharedCaptain.gamingMemberId)).rejects.toBeInstanceOf(AlreadyCaptainOrMemberError);
    });
  });
});
