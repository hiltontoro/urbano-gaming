import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CompetitionView, CompetitionFixtureViewEntry, FixtureState } from "./types";
import { CompetitionNotFoundError } from "./types";
import { isActiveOrganizer, toPublicCompetition } from "./organizerAccess";
import { appointedFixtureIds } from "./administration";
import { buildRegistrationReadiness, summarizeRegistrationFreeze, toRegistrationStatus } from "./registrationFreeze";

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

  const isOrganizer = isActiveOrganizer(competition, callerGamingMemberId);

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

  // UG-CR-GATE-SSS-007 — the registration deadline, as the server derives it, for THIS addressed competition only. A draft has none (its plan is still
  // a draft), and neither does a competition with no USABLE plan: for that one the answer is null, and null means CLOSED (UG-CR-GATE-SSS-007A) — the page offers
  // no write for a missing status, and the database refuses every write the same way. The read is the database's own word on "passed" and "accepting"; it is
  // not part of the general list, and a failure to read it fails the whole view rather than rendering a page that could offer a write it cannot vouch for.
  const registrationRead = competition.state === "DRAFT" ? null : await repo.getRegistrationStatus(competitionId);
  const registration = toRegistrationStatus(registrationRead, competition.state);
  let registrationReadiness: CompetitionView["registrationReadiness"] = null;
  let registrationFreeze: CompetitionView["registrationFreeze"] = null;
  if (registrationRead && registration && isOrganizer) {
    if (registration.frozen) {
      const evidence = await repo.getRegistrationFreeze(competitionId);
      registrationFreeze = evidence ? summarizeRegistrationFreeze(evidence, acceptedTeams) : null;
    } else if (competition.state === "TEAM_REGISTRATION_OPEN") {
      // What the freeze still needs, as counts: bounded by the four accepted teams, and read only for the organizer who administers them.
      const perTeam = await Promise.all(
        acceptedTeams.map(async (team) => {
          const [memberships, requests] = await Promise.all([repo.getTeamMemberships(team.competitionTeamId), repo.getPendingJoinRequestsForTeam(team.competitionTeamId)]);
          return { name: team.name, memberCount: memberships.length, pendingRequests: requests.length };
        })
      );
      registrationReadiness = buildRegistrationReadiness(
        registrationRead,
        perTeam,
        allTeams.filter((t) => t.status === "PENDING_ORGANIZER_APPROVAL").length,
        perTeam.reduce((sum, t) => sum + t.pendingRequests, 0)
      );
    }
  }

  // UG-CR-GATE-SSS-011 — the one bounded signal a later page gate can use: present only while registration is frozen and the competition is ready to publish,
  // and only for the active organizer and for a captain of an accepted team (the same four captains the freeze recorded). It is built from what this view
  // has already read, carries no proposal and no digest, and is ABSENT for everyone else, so an unrelated member's view is exactly what it was. The amendment
  // routes and the database decide every right to act; this decides nothing.
  const isAcceptedCaptain = acceptedTeams.some((t) => t.captainGamingMemberId === callerGamingMemberId);
  const amendmentSignal =
    competition.state === "READY_TO_PUBLISH" && registration?.frozen === true && (isOrganizer || isAcceptedCaptain)
      ? { planAmendment: { organizer: isOrganizer, captain: isAcceptedCaptain } }
      : {};

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
    competition: toPublicCompetition(competition),
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
    // UG-CR-GATE-100: the fixtures of THIS addressed competition the caller is currently appointed to score — the only way the member
    // competition page learns it may offer the scorekeeper action. Decided here, per competition; never a list across competitions.
    myScorekeeperFixtureIds: appointedFixtureIds(competition, fixtures, callerGamingMemberId),
    registration,
    registrationReadiness,
    registrationFreeze,
    ...amendmentSignal,
  };
}
