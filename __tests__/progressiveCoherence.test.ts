import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitProgressivePrediction } from "../lib/gaming/predictions/submitPrediction";
import {
  INCOHERENCE_MESSAGES,
  assertCoherentAnswers,
  isExactProgressiveReplay,
  parseProgressiveAnswers,
  progressiveCoherenceProblems,
  wonLevelOf,
  type ProgressiveAnswers,
} from "../lib/gaming/predictions/prizeLadder";
import { statusForPredictionsError } from "../lib/gaming/predictions/httpAuth";
import { IncoherentAnswersError, InvalidAttemptShapeError } from "../lib/gaming/predictions/types";
import { NEAR, answersFor, buildLadderWorld, offerDigestOf, submitAs, type LadderEnv, type LadderWorld } from "./helpers/progressiveLadderScenarios";

/**
 * Coherence between the answers of a progressive prediction.
 *
 *   0-0            a category that is attempted can only be answered with an explicit NONE
 *   any goal       NONE is not an answer
 *   first team     needs at least one goal in the predicted scoreline
 *   goalscorer     must belong to a team with at least one predicted goal; the minute need not be that player's goal
 *
 * The rules judge a NEW answer or an EDIT. An exact repeat of the prediction already stored is a replay and keeps its confirmation
 * semantics. A category that was not attempted stays "not attempted" (it is never completed) and the attempted level is never raised.
 */

const NONE = { kind: "NONE" } as const;
const HOME = { kind: "PICKED", team: "HOME" } as const;
const AWAY = { kind: "PICKED", team: "AWAY" } as const;
const FINALIZER = "gm-finalizer";

function freshEnv(): { env: LadderEnv; repo: InMemoryPredictionsRepository } {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(FINALIZER, "CONSEQUENTIAL_FINALIZER");
  return { repo, env: { repo, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: FINALIZER, operatorId: FINALIZER } };
}

const minute = (regulation = 30) => ({ kind: "PICKED", regulation, stoppage: null }) as const;
const scorer = (playerId: string) => ({ kind: "PICKED", playerId }) as const;

function make(attemptedLevel: 1 | 2 | 3 | 4, home: number, away: number, rest: Partial<Pick<ProgressiveAnswers, "firstTeam" | "goalscorer" | "goalMinute">> = {}): ProgressiveAnswers {
  return { attemptedLevel, scoreline: { home, away }, ...rest } as ProgressiveAnswers;
}

describe("the rules, as pure functions of the answers", () => {
  const codes = (answers: ProgressiveAnswers, side: "HOME" | "AWAY" | null = null) => progressiveCoherenceProblems(answers, side).map((p) => `${p.category}:${p.code}`);

  it("a 0-0 scoreline accepts only an explicit NONE in every category that is attempted", () => {
    expect(codes(make(4, 0, 0, { firstTeam: NONE, goalscorer: NONE, goalMinute: NONE }))).toEqual([]);
    expect(codes(make(2, 0, 0, { firstTeam: NONE }))).toEqual([]);
    expect(codes(make(3, 0, 0, { firstTeam: NONE, goalscorer: NONE }))).toEqual([]);
    expect(codes(make(1, 0, 0))).toEqual([]); // only the scoreline: nothing to contradict
    expect(codes(make(2, 0, 0, { firstTeam: HOME }))).toEqual(["firstTeam:ONLY_NONE_WITH_NO_GOALS"]);
    expect(codes(make(3, 0, 0, { firstTeam: NONE, goalscorer: scorer("p") }), "HOME")).toEqual(["goalscorer:ONLY_NONE_WITH_NO_GOALS"]);
    expect(codes(make(4, 0, 0, { firstTeam: NONE, goalscorer: NONE, goalMinute: minute() }))).toEqual(["goalMinute:ONLY_NONE_WITH_NO_GOALS"]);
    expect(codes(make(4, 0, 0, { firstTeam: AWAY, goalscorer: scorer("p"), goalMinute: minute() }), "AWAY")).toEqual([
      "firstTeam:ONLY_NONE_WITH_NO_GOALS",
      "goalscorer:ONLY_NONE_WITH_NO_GOALS",
      "goalMinute:ONLY_NONE_WITH_NO_GOALS",
    ]);
  });

  it("any goal makes NONE a non-answer for team, player and minute", () => {
    for (const [home, away] of [[1, 0], [0, 1], [2, 1], [3, 3]]) {
      expect(codes(make(2, home, away, { firstTeam: NONE })), `${home}-${away}`).toEqual(["firstTeam:NONE_NOT_ALLOWED_WITH_GOALS"]);
      expect(codes(make(3, home, away, { firstTeam: home > 0 ? HOME : AWAY, goalscorer: NONE })), `${home}-${away}`).toEqual(["goalscorer:NONE_NOT_ALLOWED_WITH_GOALS"]);
      expect(codes(make(4, home, away, { firstTeam: home > 0 ? HOME : AWAY, goalscorer: scorer("p"), goalMinute: NONE }), home > 0 ? "HOME" : "AWAY")).toEqual(["goalMinute:NONE_NOT_ALLOWED_WITH_GOALS"]);
    }
  });

  it("the first team must have scored in the predicted scoreline", () => {
    expect(codes(make(2, 1, 0, { firstTeam: HOME }))).toEqual([]);
    expect(codes(make(2, 1, 0, { firstTeam: AWAY }))).toEqual(["firstTeam:FIRST_TEAM_WITHOUT_GOALS"]);
    expect(codes(make(2, 0, 3, { firstTeam: HOME }))).toEqual(["firstTeam:FIRST_TEAM_WITHOUT_GOALS"]);
    expect(codes(make(2, 0, 3, { firstTeam: AWAY }))).toEqual([]);
    expect(codes(make(2, 2, 2, { firstTeam: HOME }))).toEqual([]);
    expect(codes(make(2, 2, 2, { firstTeam: AWAY }))).toEqual([]);
  });

  it("the goalscorer must belong to a team with a predicted goal (when the side is known), and need not agree with the first team or the minute", () => {
    expect(codes(make(3, 1, 0, { firstTeam: HOME, goalscorer: scorer("p") }), "HOME")).toEqual([]);
    expect(codes(make(3, 1, 0, { firstTeam: HOME, goalscorer: scorer("p") }), "AWAY")).toEqual(["goalscorer:SCORER_TEAM_WITHOUT_GOALS"]);
    expect(codes(make(3, 0, 2, { firstTeam: AWAY, goalscorer: scorer("p") }), "HOME")).toEqual(["goalscorer:SCORER_TEAM_WITHOUT_GOALS"]);
    // both teams score: a scorer from either side is coherent, even against the first team
    expect(codes(make(3, 2, 1, { firstTeam: HOME, goalscorer: scorer("p") }), "AWAY")).toEqual([]);
    // the minute does not have to be the scorer's goal: any minute goes with any scorer
    expect(codes(make(4, 1, 1, { firstTeam: HOME, goalscorer: scorer("p"), goalMinute: minute(88) }), "AWAY")).toEqual([]);
    // when the side is not known the rule that needs it is not applied (the roster check owns that refusal)
    expect(codes(make(3, 1, 0, { firstTeam: HOME, goalscorer: scorer("p") }), null)).toEqual([]);
  });

  it("an omitted category is not an answer: it is never judged, never completed and the level is never raised", () => {
    const before = make(2, 0, 0, { firstTeam: NONE });
    const snapshot = JSON.stringify(before);
    expect(codes(before)).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot); // the check reads the answers and changes nothing
    expect("goalscorer" in before).toBe(false);
    expect("goalMinute" in before).toBe(false);
    expect(before.attemptedLevel).toBe(2);
    // and the stored form keeps "not attempted" distinct from NONE
    const parsed = parseProgressiveAnswers({ attemptedLevel: 1, scoreline: { home: 0, away: 0 } });
    expect(parsed.firstTeam).toBeUndefined();
  });

  it("is deterministic and independent of the order the categories are given in", () => {
    const answers = make(4, 0, 0, { firstTeam: AWAY, goalscorer: scorer("p"), goalMinute: NONE });
    const again = progressiveCoherenceProblems(answers, "AWAY");
    expect(again).toEqual(progressiveCoherenceProblems(answers, "AWAY"));
    expect(again.map((p) => p.category)).toEqual(["firstTeam", "goalscorer"]);
  });

  it("assertCoherentAnswers throws one fixed message per rule, as an InvalidAttemptShapeError (so every handler already answers 400)", () => {
    const cases: Array<[ProgressiveAnswers, "HOME" | "AWAY" | null, keyof typeof INCOHERENCE_MESSAGES]> = [
      [make(2, 0, 0, { firstTeam: HOME }), null, "ONLY_NONE_WITH_NO_GOALS"],
      [make(2, 1, 0, { firstTeam: NONE }), null, "NONE_NOT_ALLOWED_WITH_GOALS"],
      [make(2, 1, 0, { firstTeam: AWAY }), null, "FIRST_TEAM_WITHOUT_GOALS"],
      [make(3, 1, 0, { firstTeam: HOME, goalscorer: scorer("p") }), "AWAY", "SCORER_TEAM_WITHOUT_GOALS"],
    ];
    for (const [answers, side, code] of cases) {
      let thrown: unknown;
      try { assertCoherentAnswers(answers, side); } catch (error) { thrown = error; }
      expect(thrown, code).toBeInstanceOf(IncoherentAnswersError);
      expect(thrown, code).toBeInstanceOf(InvalidAttemptShapeError);
      expect((thrown as IncoherentAnswersError).code).toBe(code);
      expect((thrown as Error).message).toBe(INCOHERENCE_MESSAGES[code]);
      expect(statusForPredictionsError(thrown)).toBe(400);
    }
    expect(() => assertCoherentAnswers(make(4, 2, 1, { firstTeam: HOME, goalscorer: scorer("p"), goalMinute: minute() }), "HOME")).not.toThrow();
  });
});

describe("the ladder itself is unchanged: attempting a higher level never costs an earlier prize", () => {
  it("the won level is the run of right answers from the scoreline, whatever is wrong after it", () => {
    expect(wonLevelOf({ scoreline: true, firstTeam: true, goalscorer: true, goalMinute: false })).toBe(3);
    expect(wonLevelOf({ scoreline: true, firstTeam: true, goalscorer: true, goalMinute: null })).toBe(3);
    expect(wonLevelOf({ scoreline: true, firstTeam: true, goalscorer: false, goalMinute: true })).toBe(2);
    expect(wonLevelOf({ scoreline: true, firstTeam: false, goalscorer: true, goalMinute: true })).toBe(1);
    expect(wonLevelOf({ scoreline: false, firstTeam: true, goalscorer: true, goalMinute: true })).toBe(0);
  });
});

describe("through the domain (submitProgressivePrediction) and through the repository the verdict is the same", () => {
  async function world(): Promise<{ env: LadderEnv; repo: InMemoryPredictionsRepository; w: LadderWorld }> {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    return { env, repo, w };
  }

  // Every combination of scoreline family, first team, goalscorer side and minute answer, each judged by three layers.
  const scorelines: Array<[number, number]> = [[0, 0], [1, 0], [0, 2], [2, 1]];
  type Combo = { label: string; build: (w: LadderWorld) => ProgressiveAnswers; side: "HOME" | "AWAY" | null };
  function combos(): Combo[] {
    const out: Combo[] = [];
    for (const [h, a] of scorelines) {
      for (const first of [NONE, HOME, AWAY] as const) {
        for (const sc of ["NONE", "HOME", "AWAY"] as const) {
          for (const min of ["NONE", "PICKED"] as const) {
            out.push({
              label: `${h}-${a} first=${"team" in first ? first.team : "NONE"} scorer=${sc} minute=${min}`,
              side: sc === "NONE" ? null : sc,
              build: (w) =>
                make(4, h, a, {
                  firstTeam: first,
                  goalscorer: sc === "NONE" ? NONE : scorer(sc === "HOME" ? w.players.mbappe : w.players.lewa),
                  goalMinute: min === "NONE" ? NONE : minute(),
                }),
            });
          }
        }
      }
    }
    return out;
  }

  it("agree on all combinations: accepted exactly when the pure rules find no contradiction, refused with the same code otherwise", async () => {
    const all = combos();
    expect(all.length).toBe(4 * 3 * 3 * 2);
    let accepted = 0;
    let refused = 0;
    for (const combo of all) {
      const { env, repo, w } = await world();
      const member = await env.newMember("m");
      const answers = combo.build(w);
      const expected = progressiveCoherenceProblems(answers, combo.side);

      // layer 1: the domain
      let domain: unknown = null;
      try { await submitAs(env, w, member, answers); } catch (error) { domain = error; }
      // layer 2: the repository on its own (what the database function mirrors)
      const member2 = await env.newMember("n");
      let repoVerdict: unknown = null;
      try {
        await repo.upsertProgressivePrediction({
          matchId: w.matchId, gamingMemberId: member2, venueActivationId: w.activationId, answers: parseProgressiveAnswers(JSON.parse(JSON.stringify(answers))),
          offerDigest: await offerDigestOf(env, w), geoVerifiedAt: new Date().toISOString(), measuredDistanceMeters: 5, reportedAccuracyMeters: 5, geoEligible: true,
        });
      } catch (error) { repoVerdict = error; }

      if (expected.length === 0) {
        expect(domain, combo.label).toBeNull();
        expect(repoVerdict, combo.label).toBeNull();
        accepted += 1;
      } else {
        expect(domain, combo.label).toBeInstanceOf(IncoherentAnswersError);
        expect(repoVerdict, combo.label).toBeInstanceOf(IncoherentAnswersError);
        expect((domain as IncoherentAnswersError).code, combo.label).toBe(expected[0]!.code);
        expect((repoVerdict as IncoherentAnswersError).code, combo.label).toBe(expected[0]!.code);
        expect(await repo.getPredictionForMember(w.matchId, member), combo.label).toBeNull(); // a refusal stores nothing
        refused += 1;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(accepted); // the contradictory combinations are the majority of the table
  }, 120_000);

  it("0-0 explicit: the whole prediction can be sent as 0-0 with none for team, player and minute", async () => {
    const { env, w } = await world();
    const member = await env.newMember("m");
    const saved = await submitAs(env, w, member, make(4, 0, 0, { firstTeam: NONE, goalscorer: NONE, goalMinute: NONE }));
    expect([saved.predictedHomeScore, saved.predictedAwayScore]).toEqual([0, 0]);
    expect([saved.firstTeamState, saved.goalscorerState, saved.goalMinuteState]).toEqual(["NONE", "NONE", "NONE"]);
    expect(saved.attemptedLevel).toBe(4);
  });

  it("a scorer from a team with no predicted goal is refused only when that team really has none", async () => {
    const { env, w } = await world();
    const member = await env.newMember("m");
    await expect(submitAs(env, w, member, make(3, 1, 0, { firstTeam: HOME, goalscorer: scorer(w.players.lewa) }))).rejects.toMatchObject({ code: "SCORER_TEAM_WITHOUT_GOALS" });
    const ok = await submitAs(env, w, member, make(3, 1, 1, { firstTeam: HOME, goalscorer: scorer(w.players.lewa) }));
    expect(ok.predictedGoalscorerPlayerId).toBe(w.players.lewa);
  });

  it("changing the scoreline, the team or the scorer of a stored prediction is judged as an edit, and a refusal leaves the stored row untouched", async () => {
    const { env, repo, w } = await world();
    const member = await env.newMember("m");
    const stored = await submitAs(env, w, member, make(3, 2, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe) }));
    // scoreline to 0-0 while the picks stay: contradictory
    await expect(submitAs(env, w, member, make(3, 0, 0, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe) }))).rejects.toMatchObject({ code: "ONLY_NONE_WITH_NO_GOALS" });
    // team to AWAY with the away team scoreless
    await expect(submitAs(env, w, member, make(3, 2, 0, { firstTeam: AWAY, goalscorer: scorer(w.players.mbappe) }))).rejects.toMatchObject({ code: "FIRST_TEAM_WITHOUT_GOALS" });
    // scorer from the away team while the away team is scoreless
    await expect(submitAs(env, w, member, make(3, 2, 0, { firstTeam: HOME, goalscorer: scorer(w.players.lewa) }))).rejects.toMatchObject({ code: "SCORER_TEAM_WITHOUT_GOALS" });
    expect(await repo.getPredictionForMember(w.matchId, member)).toEqual(stored);
    // the coherent edits go through
    const moved = await submitAs(env, w, member, make(3, 2, 2, { firstTeam: AWAY, goalscorer: scorer(w.players.lewa) }));
    expect(moved.predictionId).toBe(stored.predictionId);
    expect(moved.predictedFirstTeamToScore).toBe("AWAY");
  });

  it("reducing the level drops the later answers: what is not sent is not stored and a lower level is never judged on what it does not carry", async () => {
    const { env, w } = await world();
    const member = await env.newMember("m");
    await submitAs(env, w, member, make(4, 2, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe), goalMinute: minute() }));
    const reduced = await submitAs(env, w, member, make(2, 0, 0, { firstTeam: NONE }));
    expect([reduced.firstTeamState, reduced.goalscorerState, reduced.goalMinuteState]).toEqual(["NONE", "NOT_ATTEMPTED", "NOT_ATTEMPTED"]);
    expect(reduced.attemptedLevel).toBe(2);
    expect(reduced.predictedGoalscorerPlayerId).toBeNull();
  });

  it("minute and scorer do not have to be the same goal, and a minute never needs the scorer's side", async () => {
    const { env, w } = await world();
    const member = await env.newMember("m");
    const saved = await submitAs(env, w, member, make(4, 1, 1, { firstTeam: HOME, goalscorer: scorer(w.players.lewa), goalMinute: minute(5) }));
    expect(saved.predictedGoalMinuteRegulation).toBe(5);
    expect(saved.predictedGoalscorerPlayerId).toBe(w.players.lewa);
  });

  it("the stoppage rule is untouched: added time only with minute 45 or 90", async () => {
    const { env, w } = await world();
    const member = await env.newMember("m");
    await expect(submitAs(env, w, member, make(4, 1, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe), goalMinute: { kind: "PICKED", regulation: 30, stoppage: 2 } }))).rejects.toBeInstanceOf(InvalidAttemptShapeError);
    const ok = await submitAs(env, w, member, make(4, 1, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe), goalMinute: { kind: "PICKED", regulation: 45, stoppage: 3 } }));
    expect([ok.predictedGoalMinuteRegulation, ok.predictedGoalMinuteStoppage]).toEqual([45, 3]);
    const ninety = await submitAs(env, w, member, make(4, 1, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe), goalMinute: { kind: "PICKED", regulation: 90, stoppage: 1 } }));
    expect(ninety.predictedGoalMinuteStoppage).toBe(1);
  });
});

describe("predictions stored before this rule, and exact retries", () => {
  /** Turns a stored prediction into one the rule would refuse today, as a row accepted before the rule existed would be. */
  function makeLegacy(repo: InMemoryPredictionsRepository, predictionId: string, over: Record<string, unknown>) {
    const map = (repo as unknown as { predictions: Map<string, Record<string, unknown>> }).predictions;
    map.set(predictionId, { ...map.get(predictionId)!, ...over });
  }

  it("an exact retry of a stored prediction that today's rule would refuse is returned as stored: a replay, not a new edit", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const first = await submitAs(env, w, member, make(2, 3, 4, { firstTeam: HOME }));
    // what Production holds from the rehearsal: 3-4 with "no team" (accepted before the rule)
    makeLegacy(repo, first.predictionId, { firstTeamState: "NONE", predictedFirstTeamToScore: null });
    const stored = (await repo.getPredictionForMember(w.matchId, member))!;
    expect(progressiveCoherenceProblems(parseProgressiveAnswers({ attemptedLevel: 2, scoreline: { home: 3, away: 4 }, firstTeam: NONE }), null)).not.toEqual([]);

    const retry = await submitAs(env, w, member, make(2, 3, 4, { firstTeam: NONE }));
    expect(retry).toEqual(stored); // same row, same updatedAt, same evidence
    expect(retry.updatedAt).toBe(stored.updatedAt);
    expect(retry.measuredDistanceMeters).toBe(stored.measuredDistanceMeters);
    expect(await repo.listPredictionsForMatch(w.matchId)).toHaveLength(1);
  });

  it("any change to that stored prediction is an edit and must be coherent: the old combination cannot be re-sent with one more difference", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const first = await submitAs(env, w, member, make(2, 3, 4, { firstTeam: HOME }));
    makeLegacy(repo, first.predictionId, { firstTeamState: "NONE", predictedFirstTeamToScore: null });
    const stored = (await repo.getPredictionForMember(w.matchId, member))!;

    // a different score that keeps the contradiction: refused, stored row untouched
    await expect(submitAs(env, w, member, make(2, 5, 4, { firstTeam: NONE }))).rejects.toMatchObject({ code: "NONE_NOT_ALLOWED_WITH_GOALS" });
    // a different level that keeps it: refused too
    await expect(submitAs(env, w, member, make(1, 3, 4))).resolves.toBeTruthy(); // reducing to level 1 carries no contradiction at all
    // (the reduction above replaced the row, so rebuild the legacy one for the next check)
    const again = await submitAs(env, w, member, make(2, 3, 4, { firstTeam: HOME }));
    makeLegacy(repo, again.predictionId, { firstTeamState: "NONE", predictedFirstTeamToScore: null });
    const stored2 = (await repo.getPredictionForMember(w.matchId, member))!;
    await expect(submitAs(env, w, member, make(3, 3, 4, { firstTeam: NONE, goalscorer: scorer(w.players.mbappe) }))).rejects.toBeInstanceOf(IncoherentAnswersError);
    expect(await repo.getPredictionForMember(w.matchId, member)).toEqual(stored2);
    expect(stored.predictionId).toBe(stored2.predictionId);
    // correcting it is the way out
    const fixed = await submitAs(env, w, member, make(2, 3, 4, { firstTeam: AWAY }));
    expect(fixed.firstTeamState).toBe("PICKED");
  });

  it("a replay is exactly the database function's replay: same venue, same fingerprint, every answer equal; anything else is not", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const answers = make(3, 2, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe) });
    const stored = await submitAs(env, w, member, answers);
    const digest = (await offerDigestOf(env, w)) as string;
    expect(isExactProgressiveReplay(stored, w.activationId, answers, digest)).toBe(true);
    expect(isExactProgressiveReplay(null, w.activationId, answers, digest)).toBe(false);
    expect(isExactProgressiveReplay(stored, w.activationId, answers, null)).toBe(false);
    expect(isExactProgressiveReplay(stored, w.activationId, answers, "0".repeat(64))).toBe(false);
    expect(isExactProgressiveReplay(stored, randomUUID(), answers, digest)).toBe(false);
    for (const changed of [
      make(3, 3, 1, { firstTeam: HOME, goalscorer: scorer(w.players.mbappe) }),
      make(3, 2, 1, { firstTeam: AWAY, goalscorer: scorer(w.players.mbappe) }),
      make(3, 2, 1, { firstTeam: HOME, goalscorer: scorer(w.players.vini) }),
      make(2, 2, 1, { firstTeam: HOME }),
    ]) {
      expect(isExactProgressiveReplay(stored, w.activationId, changed, digest)).toBe(false);
    }
    expect(NEAR.accuracyMeters).toBe(5); // (the helper's geo is not part of a replay: the evidence of the first acceptance stays)
    expect((await repo.listPredictionsForMatch(w.matchId)).length).toBe(1);
  });

  it("a request that is not a replay of the stored prediction is judged even when most of it matches", async () => {
    const { env } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const base = await submitAs(env, w, member, make(2, 2, 1, { firstTeam: HOME }));
    expect(base.attemptedLevel).toBe(2);
    await expect(submitAs(env, w, member, make(2, 0, 0, { firstTeam: HOME }))).rejects.toBeInstanceOf(IncoherentAnswersError);
  });
});

describe("what the page and the server say to each other", () => {
  it("refusals are 400 with the fixed texts, and the texts are the ones the Spanish/English table translates", async () => {
    const texts = Object.values(INCOHERENCE_MESSAGES);
    expect(new Set(texts).size).toBe(4);
    for (const text of texts) expect(text.length).toBeGreaterThan(20);
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const module_ = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
    for (const text of texts) expect(module_, text).toContain(JSON.stringify(text).slice(1, -1));
  });
});
