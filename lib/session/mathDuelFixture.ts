/**
 * Math Duel Slice 001 — challenge content.
 *
 * Pre-Deployment Product-Invariant Correction: the standard phase and
 * sudden death now have two genuinely different content sources,
 * matching their two different Product roles. STANDARD is a fixed,
 * exactly-5-challenge proving ground — pre-authored, human-vetted,
 * identical set/order for both competitors, drawn from
 * MATH_DUEL_FIXTURE below. SUDDEN_DEATH is explicitly open-ended (the
 * Founder-confirmed Product Definition: "no round cap") — a finite
 * fixture, however large, cannot honestly satisfy that; a fixed
 * larger number is still a hard cap, just a further-away one. Sudden-
 * death rounds are instead produced by generateSuddenDeathChallenge, a
 * small, bounded, code-owned deterministic generator: pure function of
 * (duelId, challengeOrdinal), so it is reproducible/auditable without
 * being live/AI-generated or backed by any content-management system —
 * no external calls, no persisted authoring state, no randomness that
 * cannot be recomputed later from the same two inputs. As with the
 * standard fixture, the actual generated question text and correct
 * answer are persisted verbatim into duel_math_challenges the moment a
 * round is created, never re-derived at read time — history never
 * depends on this generator staying byte-for-byte unchanged, the same
 * "persist the authoritative outcome, not a regenerable recipe"
 * discipline this codebase already applies to poker_hands.deck_order.
 *
 * No live or procedural generation over an external source, and no
 * production content-management system — both explicitly ruled out by
 * the correction gate that introduced generateSuddenDeathChallenge.
 * Every problem, standard or sudden-death, is fixed-form, human-
 * checkable integer arithmetic — matching the Founder's own accepted
 * "pre-authored, human-vetted" standard-phase direction and, for
 * sudden death, the same "a competitive Duel cannot depend on
 * untraceable or non-reproducible question generation" principle
 * extended to content that is generated rather than hand-picked.
 */

export interface MathDuelFixtureChallenge {
  questionText: string;
  correctAnswer: number;
}

export const MATH_DUEL_STANDARD_COUNT = 5;

// Intentionally "a little tricky" per the Founder's own framing — not
// trivial single-digit addition, but no exotic operations either:
// two-step arithmetic a competitor can genuinely solve under mild time
// pressure without a calculator. Used only for the STANDARD phase —
// see this file's own top comment for why SUDDEN_DEATH draws from
// generateSuddenDeathChallenge instead.
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

if (MATH_DUEL_FIXTURE.length < MATH_DUEL_STANDARD_COUNT) {
  throw new Error(
    "Math Duel fixture does not contain enough challenges for one Duel's standard phase."
  );
}

/**
 * Selects MATH_DUEL_STANDARD_COUNT challenges without replacement, in
 * persistence order (ordinal 1..5 once persisted). Both competitors
 * receive the identical set/order, per the Founder's own explicit
 * requirement — this function is called exactly once per Duel, by the
 * Host's own START_MATH_DUEL action, and its result is persisted
 * verbatim.
 *
 * `random` is injectable for deterministic test control — a constant
 * `() => 0` function performs no shuffling at all (a Fisher-Yates
 * swap against itself is a no-op), so tests can predict the exact
 * selected sequence from this fixture's own declared array order
 * without needing to compute anything.
 */
export function selectMathDuelChallenges(
  random: () => number = Math.random
): MathDuelFixtureChallenge[] {
  const need = MATH_DUEL_STANDARD_COUNT;
  const pool = [...MATH_DUEL_FIXTURE];
  for (let i = 0; i < need; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, need);
}

/**
 * A small, fixed set of two-step integer-arithmetic templates —
 * multiplication, addition, subtraction, division (always exact,
 * never fractional), and one two-operation combination — each
 * parameterized over a bounded, hand-chosen range matching
 * MATH_DUEL_FIXTURE's own "a little tricky" difficulty voice. Bounded
 * and code-owned: reviewed once, like any other code in this
 * repository, never authored or altered at runtime.
 */
const SUDDEN_DEATH_TEMPLATES: Array<
  (rand: () => number) => MathDuelFixtureChallenge
> = [
  (rand) => {
    const a = 12 + Math.floor(rand() * 76);
    const b = 2 + Math.floor(rand() * 11);
    return { questionText: `${a} × ${b}`, correctAnswer: a * b };
  },
  (rand) => {
    const a = 20 + Math.floor(rand() * 180);
    const b = 10 + Math.floor(rand() * 90);
    return { questionText: `${a} + ${b}`, correctAnswer: a + b };
  },
  (rand) => {
    const a = 50 + Math.floor(rand() * 150);
    const b = 5 + Math.floor(rand() * (a - 4));
    return { questionText: `${a} − ${b}`, correctAnswer: a - b };
  },
  (rand) => {
    const b = 2 + Math.floor(rand() * 11);
    const q = 4 + Math.floor(rand() * 20);
    return { questionText: `${b * q} ÷ ${b}`, correctAnswer: q };
  },
  (rand) => {
    const a = 6 + Math.floor(rand() * 15);
    const b = 6 + Math.floor(rand() * 15);
    const c = 2 + Math.floor(rand() * 20);
    return { questionText: `${a} × ${b} − ${c}`, correctAnswer: a * b - c };
  },
];

/**
 * Deterministic 32-bit string hash (FNV-1a) — not cryptographic, only
 * needs a decent, stable distribution across (duelId, ordinal) pairs
 * for this non-adversarial use (competitors cannot benefit from
 * predicting their own next sudden-death question's difficulty
 * bucket, only its already-visible text once authorized).
 */
function deterministicSeed(duelId: string, challengeOrdinal: number): number {
  const input = `${duelId}:${challengeOrdinal}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a small, fast, deterministic PRNG seeded from a 32-bit integer. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Produces the sudden-death challenge for one specific (duelId,
 * challengeOrdinal) pair — a pure function: the same two inputs always
 * produce the same question and answer, so the generator itself is
 * reproducible/auditable even though the actual persisted
 * duel_math_challenges row (written once, by whichever
 * submit_math_duel_answer_atomically call detects the tie that needs
 * it) remains the sole authoritative source of historical truth. No
 * external state, no live/AI call, no upper bound on challengeOrdinal
 * — this function can produce a valid challenge for any ordinal,
 * satisfying the Founder-confirmed "no round cap" requirement
 * structurally rather than by making a finite reserve merely large.
 */
export function generateSuddenDeathChallenge(
  duelId: string,
  challengeOrdinal: number
): MathDuelFixtureChallenge {
  const seed = deterministicSeed(duelId, challengeOrdinal);
  const rand = mulberry32(seed);
  const template =
    SUDDEN_DEATH_TEMPLATES[Math.floor(rand() * SUDDEN_DEATH_TEMPLATES.length)];
  return template(rand);
}
