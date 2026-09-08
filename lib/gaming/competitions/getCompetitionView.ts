import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CompetitionView, CompetitionFixtureViewEntry, FixtureState } from "./types";
import { CompetitionNotFoundError } from "./types";

const EVIDENCE_VISIBLE_STATES: FixtureState[] = [
  "EVIDENCE_SUBMITTED",
  "UNDER_REVIEW",
  "FINALIZED",
  "CORRECTED_AND_FINALIZED",
  "FORFEIT_FINALIZED",
];

/**
 * GET_COMPETITION_VIEW — the one role-aware projection every route reads
 * through (UG-CR-RPT-020 §9). A member sees only their OWN team's
 * current roster for a fixture, never the opponent's — opponentRosterDeclared
 * only ever reveals a boolean, never opponent membership. Score/goal/assist
 * detail is withheld until the scorekeeper has actually submitted evidence,
 * even though only the scorekeeper can call submitFixtureEvidence in the
 * first place — this keeps the read model correct independent of that
 * write-side guarantee.
 */
export async function getCompetitionView(
  repo: CompetitionsRepository,
  competitionId: string,
  callerGamingMemberId: string
): Promise<CompetitionView> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition) throw new CompetitionNotFoundError();

  const isOrganizer = competition.organizerGamingMemberId === callerGamingMemberId;

  const [allTeams, fixtures, myRegistration, myTeamMembership, myPendingJoinRequest, myPersistentRecords] = await Promise.all([
    repo.getCompetitionTeams(competitionId),
    repo.getCompetitionFixtures(competitionId),
    repo.getMyRegistration(competitionId, callerGamingMemberId),
    repo.getMyTeamMembership(competitionId, callerGamingMemberId),
    repo.getMyPendingJoinRequest(competitionId, callerGamingMemberId),
    repo.getMemberParticipationRecords(competitionId, callerGamingMemberId),
  ]);

  // UG-CR-RPT-041 §7/§10: `teams` (the shared, general-purpose list every
  // viewer reads) is always ACCEPTED-only, regardless of role — a
  // pending or rejected proposal never appears there. The organizer's
  // own review queue and rejection history are separate, organizer-only
  // fields; a non-organizer never receives them (empty arrays), and
  // `myTeamProposals` is the one proposer-visibility exception, scoped
  // to the caller's own captaincy only, for every viewer regardless of
  // role.
  const acceptedTeams = allTeams.filter((t) => t.status === "ACCEPTED");
  const pendingTeamProposals = isOrganizer ? allTeams.filter((t) => t.status === "PENDING_ORGANIZER_APPROVAL") : [];
  const rejectedTeamProposals = isOrganizer ? allTeams.filter((t) => t.status === "REJECTED") : [];
  const myTeamProposals = allTeams.filter(
    (t) => t.captainGamingMemberId === callerGamingMemberId && t.status !== "ACCEPTED"
  );

  const displayNameIds = new Set<string>();
  for (const t of acceptedTeams) displayNameIds.add(t.captainGamingMemberId);
  for (const t of pendingTeamProposals) displayNameIds.add(t.captainGamingMemberId);
  for (const t of rejectedTeamProposals) displayNameIds.add(t.captainGamingMemberId);

  let myTeamMemberships: CompetitionView["myTeamMemberships"] = [];
  if (myTeamMembership) {
    const rawMemberships = await repo.getTeamMemberships(myTeamMembership.competitionTeamId);
    for (const m of rawMemberships) displayNameIds.add(m.gamingMemberId);
    myTeamMemberships = rawMemberships; // display names attached below, once resolved
  }

  const displayNames = await repo.getDisplayNames(Array.from(displayNameIds));
  const withCaptainName = (t: (typeof allTeams)[number]) => ({ ...t, captainDisplayName: displayNames[t.captainGamingMemberId] });
  const teams = acceptedTeams.map(withCaptainName);
  const pendingTeamProposalsNamed = pendingTeamProposals.map(withCaptainName);
  const rejectedTeamProposalsNamed = rejectedTeamProposals.map(withCaptainName);
  const myTeamProposalsNamed = myTeamProposals.map(withCaptainName);
  myTeamMemberships = myTeamMemberships.map((m) => ({ ...m, gamingMemberDisplayName: displayNames[m.gamingMemberId] }));

  const fixtureViews: CompetitionFixtureViewEntry[] = await Promise.all(
    fixtures.map(async (fixture): Promise<CompetitionFixtureViewEntry> => {
      const myTeamId = myTeamMembership?.competitionTeamId ?? null;
      const opponentTeamId =
        myTeamId && fixture.teamACompetitionTeamId && fixture.teamBCompetitionTeamId
          ? fixture.teamACompetitionTeamId === myTeamId
            ? fixture.teamBCompetitionTeamId
            : fixture.teamACompetitionTeamId
          : null;

      const [myRosterRevision, opponentRosterRevision] = await Promise.all([
        myTeamId ? repo.getCurrentRoster(fixture.competitionFixtureId, myTeamId) : Promise.resolve(null),
        opponentTeamId ? repo.getCurrentRoster(fixture.competitionFixtureId, opponentTeamId) : Promise.resolve(null),
      ]);

      let score: CompetitionFixtureViewEntry["score"] = null;
      let goalScorers: CompetitionFixtureViewEntry["goalScorers"] = null;
      let assistProviders: CompetitionFixtureViewEntry["assistProviders"] = null;
      let finalization: CompetitionFixtureViewEntry["finalization"] = null;
      let myDisputableFacts: CompetitionFixtureViewEntry["myDisputableFacts"] = null;

      if (EVIDENCE_VISIBLE_STATES.includes(fixture.state)) {
        const [evidence, goalEvents, assistEvents, currentFinalization, attestations] = await Promise.all([
          repo.getCurrentEvidence(fixture.competitionFixtureId),
          repo.getCurrentGoalEvents(fixture.competitionFixtureId),
          repo.getCurrentAssistEvents(fixture.competitionFixtureId),
          repo.getCurrentFinalization(fixture.competitionFixtureId),
          repo.getCurrentAttestations(fixture.competitionFixtureId),
        ]);
        if (evidence) {
          score = {
            competitionFixtureEvidenceId: evidence.competitionFixtureEvidenceId,
            teamAScore: evidence.teamAScore,
            teamBScore: evidence.teamBScore,
          };
        }
        goalScorers = goalEvents.map((g) => ({ gamingMemberId: g.scorerGamingMemberId, competitionTeamId: g.competitionTeamId }));
        const goalIdToIndex = new Map(goalEvents.map((g, i) => [g.soccerGoalEventId, i]));
        assistProviders = assistEvents
          .filter((a) => goalIdToIndex.has(a.assistedGoalEventId))
          .map((a) => ({ gamingMemberId: a.assistingGamingMemberId, goalEventIndex: goalIdToIndex.get(a.assistedGoalEventId)! }));
        finalization = currentFinalization;

        // UG-CR-GATE-033: the viewer's OWN disputable facts only — every
        // source here (goalEvents/assistEvents/attestations) already
        // holds every current member's facts, but only the entries whose
        // owning member equals the caller are ever placed into the
        // response. Never the full attestations list, never another
        // member's goal/assist id.
        myDisputableFacts = {
          participationAttestationId:
            attestations.find((a) => a.gamingMemberId === callerGamingMemberId)?.competitionParticipationAttestationId ?? null,
          goalEventIds: goalEvents.filter((g) => g.scorerGamingMemberId === callerGamingMemberId).map((g) => g.soccerGoalEventId),
          assistEventIds: assistEvents.filter((a) => a.assistingGamingMemberId === callerGamingMemberId).map((a) => a.soccerAssistEventId),
        };
      }

      return {
        fixture,
        myRoster: myRosterRevision?.gamingMemberIds ?? null,
        opponentRosterDeclared: opponentRosterRevision !== null,
        score,
        goalScorers,
        assistProviders,
        finalization,
        myDisputableFacts,
      };
    })
  );

  return {
    competition,
    teams,
    pendingTeamProposals: pendingTeamProposalsNamed,
    rejectedTeamProposals: rejectedTeamProposalsNamed,
    myTeamProposals: myTeamProposalsNamed,
    fixtures: fixtureViews,
    myRegistration,
    myTeamMembership,
    myTeamMemberships,
    myPendingJoinRequest,
    myPersistentRecords,
    isOrganizer,
  };
}
