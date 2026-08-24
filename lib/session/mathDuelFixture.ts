/**
 * Math Duel Slice 001 — challenge content.
 *
 * A small, code-owned, human-vetted fixture — deliberately NOT a
 * production content-management system or a persistent database bank
 * table (implementation-readiness §3/§7's own explicit disposition).
 * Historical Duel evidence never depends on this fixture staying
 * unchanged later: startMathDuel.ts selects from it once, and the
 * actual selected question text and correct answer are persisted as
 * immutable duel_math_challenges rows at that moment — the same
 * "persist the authoritative outcome, not a regenerable recipe"
 * discipline this codebase already applies to poker_hands.deck_order.
 *
 * No live or procedural generation — every answer here is fixed and
 * human-checkable, matching the Founder's own accepted "pre-authored,
 * human-vetted challenge bank" direction and the "a competitive Duel
 * cannot depend on untraceable or non-reproducible question
 * generation" principle from Math Duel's own architecture gate.
 */

export interface MathDuelFixtureChallenge {
  questionText: string;
  correctAnswer: number;
}

export const MATH_DUEL_STANDARD_COUNT = 5;
/**
 * Deliberately generous — comfortably clears the 20-consecutive-tied-
 * round operational pressure test with margin. An honest Slice 001
 * limit, not a Product cap: exhausting it is a vanishingly improbable
 * real-world event (20+ consecutive exact ties), and the honest
 * response when it happens is MathDuelChallengesExhaustedError, never
 * a fabricated winner or a fabricated new challenge — see that error
 * class's own doc comment.
 */
export const MATH_DUEL_SUDDEN_DEATH_SUPPLY = 25;

// Intentionally "a little tricky" per the Founder's own framing — not
// trivial single-digit addition, but no exotic operations either:
// two-step arithmetic a competitor can genuinely solve under mild time
// pressure without a calculator.
const MATH_DUEL_FIXTURE: MathDuelFixtureChallenge[] = [
  { questionText: "14 × 6", correctAnswer: 84 },
  { questionText: "23 + 58", correctAnswer: 81 },
  { questionText: "144 ÷ 12", correctAnswer: 12 },
  { questionText: "9 × 9 − 17", correctAnswer: 64 },
  { questionText: "37 + 26 + 15", correctAnswer: 78 },
  { questionText: "100 − 63", correctAnswer: 37 },
  { questionText: "7 × 13", correctAnswer: 91 },
  { questionText: "8² − 5²", correctAnswer: 39 },
  { questionText: "156 ÷ 4", correctAnswer: 39 },
  { questionText: "12 × 11 − 40", correctAnswer: 92 },
  { questionText: "6 × 7 + 8 × 3", correctAnswer: 66 },
  { questionText: "225 ÷ 15", correctAnswer: 15 },
  { questionText: "19 + 24 × 2", correctAnswer: 67 },
  { questionText: "13²", correctAnswer: 169 },
  { questionText: "84 − 29", correctAnswer: 55 },
  { questionText: "15 × 4 − 18", correctAnswer: 42 },
  { questionText: "72 ÷ 8 + 11", correctAnswer: 20 },
  { questionText: "9 × 12", correctAnswer: 108 },
  { questionText: "48 + 37 − 22", correctAnswer: 63 },
  { questionText: "16 × 5", correctAnswer: 80 },
  { questionText: "11²  − 21", correctAnswer: 100 },
  { questionText: "132 ÷ 6", correctAnswer: 22 },
  { questionText: "27 + 15 × 3", correctAnswer: 72 },
  { questionText: "17 × 6 − 30", correctAnswer: 72 },
  { questionText: "9 × 9 + 9", correctAnswer: 90 },
  { questionText: "210 ÷ 7", correctAnswer: 30 },
  { questionText: "45 − 18 + 26", correctAnswer: 53 },
  { questionText: "14 × 8", correctAnswer: 112 },
  { questionText: "6³ ÷ 4", correctAnswer: 54 },
  { questionText: "33 + 29 + 18", correctAnswer: 80 },
];

if (MATH_DUEL_FIXTURE.length < MATH_DUEL_STANDARD_COUNT + MATH_DUEL_SUDDEN_DEATH_SUPPLY) {
  throw new Error(
    "Math Duel fixture does not contain enough challenges for one Duel."
  );
}

export interface SelectedMathDuelChallenge extends MathDuelFixtureChallenge {
  phase: "STANDARD" | "SUDDEN_DEATH";
}

/**
 * Selects MATH_DUEL_STANDARD_COUNT + MATH_DUEL_SUDDEN_DEATH_SUPPLY
 * challenges without replacement, in persistence order: the standard
 * phase first (ordinal 1..5 once persisted), then the full sudden-
 * death supply (ordinal 6..30). Both competitors receive the
 * identical set/order, per the Founder's own explicit requirement —
 * this function is called exactly once per Duel, by the Host's own
 * START_MATH_DUEL action, and its result is persisted verbatim.
 *
 * `random` is injectable for deterministic test control — a constant
 * `() => 0` function performs no shuffling at all (a Fisher-Yates
 * swap against itself is a no-op), so tests can predict the exact
 * selected sequence from this fixture's own declared array order
 * without needing to compute anything.
 */
export function selectMathDuelChallenges(
  random: () => number = Math.random
): SelectedMathDuelChallenge[] {
  const need = MATH_DUEL_STANDARD_COUNT + MATH_DUEL_SUDDEN_DEATH_SUPPLY;
  const pool = [...MATH_DUEL_FIXTURE];
  for (let i = 0; i < need; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, need).map((challenge, index) => ({
    ...challenge,
    phase: index < MATH_DUEL_STANDARD_COUNT ? "STANDARD" : "SUDDEN_DEATH",
  }));
}
