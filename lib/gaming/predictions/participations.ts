import type { PredictionsRepository } from "./db/predictionsRepository";
import type { PredictionContract, PredictionRecord } from "./types";
import { LADDER_LEVELS, PROGRESSIVE_PREDICTION_CONTRACT, computeLadderOffer } from "./prizeLadder";

/**
 * MY PARTICIPATIONS — a member's own history in URBANO Score, built for one member and for nobody else.
 *
 * It answers three different questions about each participation and never mixes them up:
 *   - what was SENT: the venue, the level that was attempted, the answers, when it was sent and last changed;
 *   - the state of the participation WINDOW: open (the match has not started), closed (it started) or cancelled;
 *   - what was EVALUATED, if anything: the member's own evaluation of that participation, with the ladder level it reached.
 * A level that was sent is not a prize that was won: `attemptedLevel` and `evaluation.ladderLevel` are separate fields, and an
 * evaluation exists only after the official result has been evaluated.
 *
 * `editable` answers one more question: would a NEW edit of this participation be admitted right now? It follows what the server
 * enforces when an edit is sent (the match is not cancelled and has not started, nothing has been evaluated, the venue activation is
 * enabled, the offer is still valid) and what the Score page offers (the venue is available), and when it is false `editBlockedReason`
 * says which. An exact repeat of the participation already saved is NOT an edit: the server answers it as a replay with what is stored,
 * decided before those checks, so a participation that is no longer `editable` is still answered, unchanged, to an identical resend.
 * Geolocation is not part of it: it is measured at the moment of sending and cannot be known here.
 *
 * What it reads: the member's predictions, and for each one its match, teams, venue, roster name of the scorer, prize tiers of its
 * activation (to know whether the offer is still valid) and the member's own current evaluation — all in batches, one request per kind
 * for the whole history, so the cost does not grow with the number of participations. What it never reads: match results, Gaming XP,
 * qualifications or redemptions. What it never returns: coordinates, distance, accuracy, any geolocation evidence, the offer
 * fingerprint, member ids or anything of another member.
 *
 * It returns the newest PARTICIPATIONS_LIMIT participations and says whether there are older ones (`truncated`), so a short list is
 * never mistaken for the whole history.
 */

export type ParticipationState = "OPEN" | "CLOSED" | "CANCELLED";

/** Why a new edit would not be admitted, in the order the reasons are checked. null means it would be. */
export type EditBlockedReason =
  | "MATCH_CANCELLED"
  | "MATCH_STARTED"
  | "EVALUATED"
  | "ACTIVATION_DISABLED"
  | "VENUE_UNAVAILABLE"
  | "OFFER_UNAVAILABLE";

export interface ParticipationView {
  matchId: string;
  match: { competition: string; homeTeam: string | null; awayTeam: string | null; kickoffAt: string; cancelled: boolean };
  venueName: string | null;
  contract: PredictionContract;
  /** The level that was sent; null for a participation under the historical contract. NOT a prize that was won. */
  attemptedLevel: number | null;
  answers: {
    scoreline: { home: number; away: number };
    firstTeam?: { kind: "NONE" } | { kind: "PICKED"; team: "HOME" | "AWAY" };
    goalscorer?: { kind: "NONE" } | { kind: "PICKED"; playerName: string | null; jerseyNumber: number | null };
    goalMinute?: { kind: "NONE" } | { kind: "PICKED"; regulation: number; stoppage: number | null };
  };
  sentAt: string;
  lastChangedAt: string | null;
  state: ParticipationState;
  /** Would a new edit be admitted now (see above)? The server still decides when an edit is sent. */
  editable: boolean;
  editBlockedReason: EditBlockedReason | null;
  evaluation: { evaluated: false } | { evaluated: true; evaluatedAt: string; reachedLevel: number | null };
}

export interface MemberParticipations {
  participations: ParticipationView[];
  /** The most participations that are returned. */
  limit: number;
  /** true when the member has older participations than the ones returned. */
  truncated: boolean;
}

export const PARTICIPATIONS_LIMIT = 50;

export async function buildMemberParticipations(
  repo: PredictionsRepository,
  gamingMemberId: string,
  now: Date = new Date(),
  limit: number = PARTICIPATIONS_LIMIT
): Promise<MemberParticipations> {
  const cap = Math.max(1, Math.min(Math.floor(limit), PARTICIPATIONS_LIMIT));
  // One more than will be shown: that extra row is how "there are older ones" is known without counting the whole history.
  const fetched = await repo.listPredictionsForMember(gamingMemberId, cap + 1);
  // Belt and braces: whatever the repository returned, only this member's own rows are used, and the ids of the batch reads below come
  // from those rows alone — an id of anyone else's never leaves this function.
  const own = fetched.filter((prediction) => prediction.gamingMemberId === gamingMemberId);
  const shown = own.slice(0, cap);
  if (shown.length === 0) return { participations: [], limit: cap, truncated: false };

  const isProgressive = (prediction: PredictionRecord) => prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT;
  const scorerIds = shown
    .filter((prediction) => isProgressive(prediction) && prediction.goalscorerState === "PICKED" && prediction.predictedGoalscorerPlayerId !== null)
    .map((prediction) => prediction.predictedGoalscorerPlayerId as string);
  const activationIds = shown.map((prediction) => prediction.venueActivationId);

  const [matches, activations, evaluations, players] = await Promise.all([
    repo.getMatchesByIds(shown.map((prediction) => prediction.matchId)),
    repo.getVenueActivationsByIds(activationIds),
    repo.getCurrentEvaluationsForPredictions(shown.map((prediction) => prediction.predictionId)),
    scorerIds.length > 0 ? repo.getPlayersByIds(scorerIds) : Promise.resolve([]),
  ]);
  const progressiveActivationIds = shown.filter(isProgressive).map((prediction) => prediction.venueActivationId);
  const [teams, venues, tiers] = await Promise.all([
    repo.getTeamsByIds(matches.flatMap((match) => [match.homeTeamId, match.awayTeamId])),
    repo.getVenuesByIds(activations.map((activation) => activation.venueId)),
    progressiveActivationIds.length > 0 ? repo.listPrizeTiersForActivations(progressiveActivationIds) : Promise.resolve([]),
  ]);

  const matchById = new Map(matches.map((match) => [match.matchId, match]));
  const activationById = new Map(activations.map((activation) => [activation.venueActivationId, activation]));
  const evaluationByPrediction = new Map(evaluations.map((evaluation) => [evaluation.predictionId, evaluation]));
  const playerById = new Map(players.map((player) => [player.playerId, player]));
  const teamById = new Map(teams.map((team) => [team.teamId, team]));
  const venueById = new Map(venues.map((venue) => [venue.venueId, venue]));

  const participations: ParticipationView[] = [];
  for (const prediction of shown) {
    const match = matchById.get(prediction.matchId);
    if (!match) continue;
    const activation = activationById.get(prediction.venueActivationId) ?? null;
    const venue = activation ? venueById.get(activation.venueId) ?? null : null;
    const evaluation = evaluationByPrediction.get(prediction.predictionId) ?? null;
    const progressive = isProgressive(prediction);

    const cancelled = match.cancelledAt !== null;
    const started = now.getTime() >= new Date(match.kickoffAt).getTime();
    const state: ParticipationState = cancelled ? "CANCELLED" : started ? "CLOSED" : "OPEN";
    const offerAvailable = !progressive || computeLadderOffer(tiers.filter((tier) => tier.venueActivationId === prediction.venueActivationId)).available;

    // The order is the order the reasons are explained in: the match first, then what has been evaluated, then the venue's side.
    const editBlockedReason: EditBlockedReason | null = cancelled
      ? "MATCH_CANCELLED"
      : started
        ? "MATCH_STARTED"
        : evaluation !== null
          ? "EVALUATED"
          : activation === null || !activation.enabled
            ? "ACTIVATION_DISABLED"
            : venue === null || !venue.active
              ? "VENUE_UNAVAILABLE"
              : !offerAvailable
                ? "OFFER_UNAVAILABLE"
                : null;

    const answers: ParticipationView["answers"] = { scoreline: { home: prediction.predictedHomeScore, away: prediction.predictedAwayScore } };
    if (progressive) {
      if (prediction.firstTeamState === "NONE") answers.firstTeam = { kind: "NONE" };
      else if (prediction.firstTeamState === "PICKED" && prediction.predictedFirstTeamToScore !== null) answers.firstTeam = { kind: "PICKED", team: prediction.predictedFirstTeamToScore };
      if (prediction.goalscorerState === "NONE") answers.goalscorer = { kind: "NONE" };
      else if (prediction.goalscorerState === "PICKED" && prediction.predictedGoalscorerPlayerId !== null) {
        const player = playerById.get(prediction.predictedGoalscorerPlayerId);
        answers.goalscorer = { kind: "PICKED", playerName: player ? player.name : null, jerseyNumber: player && typeof player.jerseyNumber === "number" ? player.jerseyNumber : null };
      }
      if (prediction.goalMinuteState === "NONE") answers.goalMinute = { kind: "NONE" };
      else if (prediction.goalMinuteState === "PICKED" && prediction.predictedGoalMinuteRegulation !== null) {
        answers.goalMinute = { kind: "PICKED", regulation: prediction.predictedGoalMinuteRegulation, stoppage: prediction.predictedGoalMinuteStoppage };
      }
    }

    const edited = new Date(prediction.updatedAt).getTime() - new Date(prediction.createdAt).getTime() > 1000;
    const home = teamById.get(match.homeTeamId);
    const away = teamById.get(match.awayTeamId);
    participations.push({
      matchId: match.matchId,
      match: { competition: match.competition, homeTeam: home ? home.name : null, awayTeam: away ? away.name : null, kickoffAt: match.kickoffAt, cancelled },
      venueName: venue ? venue.name : null,
      contract: prediction.predictionContract,
      attemptedLevel: progressive && LADDER_LEVELS.some((entry) => entry.level === prediction.attemptedLevel) ? prediction.attemptedLevel : null,
      answers,
      sentAt: prediction.createdAt,
      lastChangedAt: edited ? prediction.updatedAt : null,
      state,
      editable: editBlockedReason === null,
      editBlockedReason,
      evaluation: evaluation ? { evaluated: true, evaluatedAt: evaluation.evaluatedAt, reachedLevel: evaluation.ladderLevel } : { evaluated: false },
    });
  }
  return { participations, limit: cap, truncated: own.length > cap };
}
