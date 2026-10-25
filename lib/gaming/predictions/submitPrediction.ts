import type { PredictionsRepository } from "./db/predictionsRepository";
import type { PredictionRecord, GeoSubmission } from "./types";
import { VenueActivationNotFoundError, GeoUnavailableError } from "./types";
import { evaluateGeoEligibility } from "./geolocation";
import { parseProgressiveAnswers, assertCoherentAnswers, isExactProgressiveReplay } from "./prizeLadder";
import type { ProgressiveAnswers, ScorerSide } from "./prizeLadder";
import type { AdmissionGate } from "../legal/requirements";

/**
 * SUBMIT_PREDICTION — the single write path for both a first-time
 * Prediction and every revision before kickoff. Geolocation eligibility
 * is recomputed here from the venue's own coordinates on every call
 * (never cached from a prior submission), then handed to
 * upsert_prediction_atomically as pre-computed evidence — the atomic
 * function re-checks geoEligible is true rather than trusting it
 * blindly, but the actual distance computation happens here, once,
 * against the specific Venue this Activation belongs to.
 *
 * The four Prediction dimensions are independent: predictedGoalscorer-
 * PlayerId, predictedGoalMinuteRegulation/predictedGoalMinuteStoppage,
 * and predictedFirstTeamToScore are each passed through untouched (a
 * player id, a (regulation, stoppage) integer pair, and an enum — none
 * need normalization) and each nullable, with null meaning the member
 * deliberately chose "No Goal" for that dimension. Roster membership/
 * activity validation and Goal-Minute shape validation both happen
 * inside upsert_prediction_atomically itself, not here.
 *
 * geo === null (no reported position at all — permission denied, or
 * the browser could not produce a fix) fails honestly with
 * GeoUnavailableError; there is no IP-geolocation or other fallback.
 */
export async function submitPrediction(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    predictedHomeScore: number;
    predictedAwayScore: number;
    predictedGoalscorerPlayerId: string | null;
    predictedGoalMinuteRegulation: number | null;
    predictedGoalMinuteStoppage: number | null;
    predictedFirstTeamToScore: "HOME" | "AWAY" | null;
    geo: GeoSubmission | null;
  },
  gate?: AdmissionGate
): Promise<PredictionRecord> {
  if (!input.geo) {
    throw new GeoUnavailableError();
  }

  // Every submission of the historical contract is an admission or an edit: the conditions are asked for each time (no replay concept here).
  if (gate) await gate.assertConditions();

  const activation = await repo.getVenueActivationById(input.venueActivationId);
  if (!activation) {
    throw new VenueActivationNotFoundError();
  }
  const venue = await repo.getVenueById(activation.venueId);
  if (!venue) {
    throw new VenueActivationNotFoundError();
  }

  const geoResult = evaluateGeoEligibility(
    input.geo.latitude,
    input.geo.longitude,
    venue.latitude,
    venue.longitude,
    venue.radiusMeters
  );

  return repo.upsertPrediction({
    matchId: input.matchId,
    gamingMemberId: input.gamingMemberId,
    venueActivationId: input.venueActivationId,
    predictedHomeScore: input.predictedHomeScore,
    predictedAwayScore: input.predictedAwayScore,
    predictedGoalscorerPlayerId: input.predictedGoalscorerPlayerId,
    predictedGoalMinuteRegulation: input.predictedGoalMinuteRegulation,
    predictedGoalMinuteStoppage: input.predictedGoalMinuteStoppage,
    predictedFirstTeamToScore: input.predictedFirstTeamToScore,
    geoVerifiedAt: new Date().toISOString(),
    measuredDistanceMeters: geoResult.measuredDistanceMeters,
    reportedAccuracyMeters: input.geo.accuracyMeters,
    geoEligible: geoResult.eligible,
  });
}

/**
 * SUBMIT_PREDICTION for a Match under the progressive contract — the
 * single write path for a first submission and every revision before
 * kickoff. Same geolocation rule as the historical path (recomputed on
 * every call from the venue's own coordinates, no fallback), then the
 * answers are validated here — gaps, categories above the declared level,
 * bare nulls, NONE carrying a value, PICKED carrying none are refused —
 * and again by the atomic function and the table's own constraints.
 *
 * offerDigest is the fingerprint of the prize offer the member saw. If the
 * offer has since changed the submission is refused, so an accepted offer
 * can never change silently underneath a prediction.
 *
 * Conditions (the legal texts): a new participation or a real edit needs the current conditions accepted (the `gate`); an exact replay of a
 * participation that already exists does not, and does not become a new admission.
 *
 * Coherence: the answers must be able to come from one scoreline (see
 * progressiveCoherenceProblems). That judges a new answer or an edit; an
 * exact repeat of the prediction already stored is a replay and keeps its
 * confirmation semantics, so it is never judged again. Because it is checked
 * here, before the database function runs, a coherence refusal (400) takes
 * precedence over a state refusal (409) for the same request; the database
 * function mirrors the same rule after its shape checks.
 */
export async function submitProgressivePrediction(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    answers: unknown;
    offerDigest: string | null;
    geo: GeoSubmission | null;
  },
  gate?: AdmissionGate
): Promise<PredictionRecord> {
  if (!input.geo) {
    throw new GeoUnavailableError();
  }

  const answers = parseProgressiveAnswers(input.answers);

  const stored = await repo.getPredictionForMember(input.matchId, input.gamingMemberId);
  const replay = isExactProgressiveReplay(stored, input.venueActivationId, answers, input.offerDigest);
  if (!replay) {
    assertCoherentAnswers(answers, await scorerSideOf(repo, input.matchId, answers));
    // A new participation or a real edit is an admission: the current conditions must be in place. An exact repeat of a participation that
    // already exists is not an admission and is never judged against conditions again (same reasoning as the coherence check above).
    if (gate) await gate.assertConditions();
  }

  const activation = await repo.getVenueActivationById(input.venueActivationId);
  if (!activation) {
    throw new VenueActivationNotFoundError();
  }
  const venue = await repo.getVenueById(activation.venueId);
  if (!venue) {
    throw new VenueActivationNotFoundError();
  }

  const geoResult = evaluateGeoEligibility(
    input.geo.latitude,
    input.geo.longitude,
    venue.latitude,
    venue.longitude,
    venue.radiusMeters
  );

  return repo.upsertProgressivePrediction({
    matchId: input.matchId,
    gamingMemberId: input.gamingMemberId,
    venueActivationId: input.venueActivationId,
    answers,
    offerDigest: input.offerDigest,
    geoVerifiedAt: new Date().toISOString(),
    measuredDistanceMeters: geoResult.measuredDistanceMeters,
    reportedAccuracyMeters: input.geo.accuracyMeters,
    geoEligible: geoResult.eligible,
  });
}

/**
 * Which side of THIS match the picked goalscorer plays for, or null when none is picked or the player is not one of the two teams'
 * (that refusal belongs to the roster check, not to coherence).
 */
async function scorerSideOf(repo: PredictionsRepository, matchId: string, answers: ProgressiveAnswers): Promise<ScorerSide | null> {
  if (!answers.goalscorer || answers.goalscorer.kind !== "PICKED") return null;
  const [player, match] = await Promise.all([repo.getPlayerById(answers.goalscorer.playerId), repo.getMatchById(matchId)]);
  if (!player || !match) return null;
  if (player.teamId === match.homeTeamId) return "HOME";
  if (player.teamId === match.awayTeamId) return "AWAY";
  return null;
}
