import type { PredictionsRepository } from "./db/predictionsRepository";
import type {
  TeamRecord,
  PlayerRecord,
  MatchRecord,
  VenueRecord,
  VenueActivationRecord,
  PrizeTierRecord,
  SavedMatchResult,
  OfficialGoalEventInput,
} from "./types";
import { InvalidPrizeTierDimensionCountError, InvalidPrizeTierLadderLevelError } from "./types";
import type { PredictionContract } from "./types";
import { validateGoalEventInputs, validateResultScores } from "./resultIntegrity";

/**
 * The smallest founder/admin catalog surface: Team/Player roster,
 * Match, Venue, Venue Activation, Prize Tier CRUD, and draft Result
 * entry (both first-time and correction). Grouped in one file — none
 * of these carry the concurrency/invariant weight that earns a
 * dedicated atomic function (see finalizeMatchResult.ts /
 * correctMatchResult.ts for the two that do) — plain repository
 * operations, matching this codebase's own "not every insert needs to
 * be an RPC" precedent (e.g. prepareQuestions). Admin authority itself
 * is checked by the caller (the API route), via lib/gaming/auth.ts's
 * isCurrentlyGamingAdmin — never here.
 *
 * Roster is deliberately the smallest v1 capability: no league
 * management, no sports-data-provider integration. A future provider
 * may automate Team/Player/Match population; this manual admin
 * workflow is the v1 source of truth either way, and every id here is
 * this domain's own stable internal id — a future provider's own ids
 * would map into these, never replace them.
 */

export async function createTeam(
  repo: PredictionsRepository,
  input: { name: string }
): Promise<TeamRecord> {
  return repo.createTeam({ name: input.name.trim() });
}

export async function listTeams(repo: PredictionsRepository): Promise<TeamRecord[]> {
  return repo.listTeams();
}

/** active defaults true — deactivation (never deletion) is how a Player stops being selectable. */
export async function createPlayer(
  repo: PredictionsRepository,
  input: { teamId: string; name: string }
): Promise<PlayerRecord> {
  return repo.createPlayer({ teamId: input.teamId, name: input.name.trim() });
}

export async function editPlayer(
  repo: PredictionsRepository,
  playerId: string,
  input: { name: string }
): Promise<PlayerRecord> {
  return repo.editPlayer(playerId, { name: input.name.trim() });
}

export async function setPlayerActive(
  repo: PredictionsRepository,
  playerId: string,
  active: boolean
): Promise<PlayerRecord> {
  return repo.setPlayerActive(playerId, active);
}

export async function listPlayersForTeam(
  repo: PredictionsRepository,
  teamId: string
): Promise<PlayerRecord[]> {
  return repo.listPlayersForTeam(teamId);
}

export async function createMatch(
  repo: PredictionsRepository,
  input: {
    homeTeamId: string;
    awayTeamId: string;
    competition: string;
    kickoffAt: string;
    /** Defaults to the historical contract; the admin route creates new matches progressive. */
    predictionContract?: PredictionContract;
  }
): Promise<MatchRecord> {
  return repo.createMatch({
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    competition: input.competition.trim(),
    kickoffAt: input.kickoffAt,
    ...(input.predictionContract ? { predictionContract: input.predictionContract } : {}),
  });
}

export async function editMatch(
  repo: PredictionsRepository,
  matchId: string,
  input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
): Promise<MatchRecord> {
  return repo.editMatch(matchId, {
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    competition: input.competition.trim(),
    kickoffAt: input.kickoffAt,
  });
}

export async function cancelMatch(
  repo: PredictionsRepository,
  matchId: string
): Promise<MatchRecord> {
  return repo.cancelMatch(matchId);
}

const ACTIVITY_CLASSIFICATIONS = ["TRAINING", "CASUAL", "RANKED", "OFFICIAL"] as const;
type ActivityClassificationInput = (typeof ACTIVITY_CLASSIFICATIONS)[number];

/**
 * SET_MATCH_ACTIVITY_CLASSIFICATION — declares (or re-declares, while
 * still free to change) the Match-level Activity Classification a
 * Prediction on it will be recognized under. Must be called before
 * any Prediction can be submitted (enforced inside
 * upsert_prediction_atomically); becomes immutable the moment
 * Prediction or Result evidence exists (enforced inside
 * set_match_activity_classification_atomically itself). This is a
 * Predictions-owned concept — Venue Activation never owns it.
 */
export async function setMatchActivityClassification(
  repo: PredictionsRepository,
  matchId: string,
  activityClassification: string,
  actorGamingMemberId: string,
  reason?: string | null
): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
  if (!ACTIVITY_CLASSIFICATIONS.includes(activityClassification as ActivityClassificationInput)) {
    throw new Error("activityClassification must be one of TRAINING, CASUAL, RANKED, OFFICIAL.");
  }
  return repo.setMatchActivityClassification(
    matchId,
    activityClassification as ActivityClassificationInput,
    actorGamingMemberId,
    reason ?? null
  );
}

/**
 * SET_MATCH_XP_ELIGIBILITY — declares (or re-declares, while still
 * free to change) whether Predictions on this Match are eligible to
 * generate persistent Gaming XP. PLAYABLE MATCH != XP-ELIGIBLE MATCH:
 * unlike Activity Classification, this has no precondition for
 * Prediction submission — a Match may be fully playable with this
 * left undeclared (null) indefinitely. Becomes immutable the moment
 * Prediction or Result evidence exists (enforced inside
 * set_match_xp_eligibility_atomically itself), for the same reason
 * Activity Classification locks: previously non-XP activity must
 * never be retroactively converted into XP-eligible activity, and a
 * currently-eligible Match must never be quietly un-curated after
 * members have already earned real recognition under it.
 *
 * Predictions A1 exposes this through an authorized admin route
 * (CONSEQUENTIAL_FINALIZER) — see app/api/gaming/predictions/admin/
 * matches/[matchId]/xp-eligibility/route.ts.
 */
export async function setMatchXpEligibility(
  repo: PredictionsRepository,
  matchId: string,
  xpEligible: boolean,
  actorGamingMemberId: string,
  reason?: string | null
): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }> {
  return repo.setMatchXpEligibility(matchId, xpEligible, actorGamingMemberId, reason ?? null);
}

export async function createVenue(
  repo: PredictionsRepository,
  input: { name: string; latitude: number; longitude: number; radiusMeters: number }
): Promise<VenueRecord> {
  return repo.createVenue({ ...input, name: input.name.trim() });
}

export async function editVenue(
  repo: PredictionsRepository,
  venueId: string,
  input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    active: boolean;
  }
): Promise<VenueRecord> {
  return repo.editVenue(venueId, { ...input, name: input.name.trim() });
}

export async function createVenueActivation(
  repo: PredictionsRepository,
  input: { matchId: string; venueId: string }
): Promise<VenueActivationRecord> {
  return repo.createVenueActivation(input);
}

export async function setVenueActivationEnabled(
  repo: PredictionsRepository,
  venueActivationId: string,
  enabled: boolean
): Promise<VenueActivationRecord> {
  return repo.setVenueActivationEnabled(venueActivationId, enabled);
}

export async function createPrizeTier(
  repo: PredictionsRepository,
  input: { venueActivationId: string; correctDimensionCount: number; prizeLabel: string }
): Promise<PrizeTierRecord> {
  if (
    !Number.isInteger(input.correctDimensionCount) ||
    input.correctDimensionCount < 1 ||
    input.correctDimensionCount > 4
  ) {
    throw new InvalidPrizeTierDimensionCountError();
  }
  return repo.createPrizeTier({ ...input, prizeLabel: input.prizeLabel.trim() });
}

/**
 * Adds a prize tier keyed by ladder level to an activation of a
 * progressive Match. Levels 1 to 4 are Easy, Medium, Hard and Legendary;
 * an activation is offered up to the consecutive prefix that is
 * configured, so Easy comes first and there are no gaps. Once any
 * prediction exists for the activation its tiers are frozen.
 */
export async function createLadderPrizeTier(
  repo: PredictionsRepository,
  input: { venueActivationId: string; ladderLevel: number; prizeLabel: string }
): Promise<PrizeTierRecord> {
  if (!Number.isInteger(input.ladderLevel) || input.ladderLevel < 1 || input.ladderLevel > 4) {
    throw new InvalidPrizeTierLadderLevelError();
  }
  return repo.createLadderPrizeTier({ ...input, prizeLabel: input.prizeLabel.trim() });
}

/**
 * Saves the Match's one un-finalized draft: a first result when the
 * Match has no finalized one, a correction of the current finalized
 * result when it has. The caller never chooses which — the repository
 * decides inside the same transaction that serializes finalization — and
 * reports it in isCorrection.
 *
 * saveBase is the digest of the draft the caller loaded, or
 * NO_RESULT_SAVE_BASE when it loaded none; a save over a draft that has
 * changed since is rejected. Malformed input, a score that the
 * regulation-time goal events do not add up to, and a scorer outside the
 * match's two teams are all rejected without changing the prior draft.
 * The returned contentDigest identifies the exact saved content — it is
 * what finalize/correct must be given.
 */
export async function saveMatchResultDraft(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    saveBase: string;
  }
): Promise<SavedMatchResult> {
  validateResultScores(input.homeScore, input.awayScore);
  validateGoalEventInputs(input.officialGoalEvents);
  return repo.saveDraftMatchResult(input);
}
