import type { PokerRepository } from "./db/pokerRepository";
import type { PlayerActionResult, PokerActionType } from "./types";
import { PokerHandNotFoundError } from "./types";
import { computeBoardCards, computeSidePots, type Pot } from "./pokerRules";
import { evaluateHand, rankHandsBestToWorst } from "./handEvaluator";

/**
 * PLAYER_ACTION command handler. Calls apply_player_action_atomically
 * (via the repository) for the actual betting-state mutation. If the
 * result reports showdownReached, this function — not the SQL layer,
 * which has no Poker hand evaluator — fetches the authoritative hole
 * cards for every non-folded seat (the same deck_order-derivation
 * getTableState.ts already uses), evaluates each with pokersolver,
 * decomposes side pots (pokerRules.computeSidePots), and calls
 * settleShowdown to atomically apply the payout. This two-step
 * "SQL advances to Showdown, then TypeScript evaluates and settles" is
 * safe: no further player action is possible once street = 'SHOWDOWN',
 * and settleShowdown is itself idempotent.
 *
 * Reveal rule (v1, chosen and documented — see
 * POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md): every seat that reached
 * Showdown without folding is revealed; folded hands are never
 * revealed, at any point.
 */
export async function applyPlayerAction(
  repo: PokerRepository,
  input: {
    pokerHandId: string;
    seatNumber: number;
    actionType: PokerActionType;
    amount: number | null;
    idempotencyKey: string;
  }
): Promise<PlayerActionResult> {
  const result = await repo.applyPlayerAction(input);

  if (!result.showdownReached || result.alreadyApplied) {
    return result;
  }

  const hand = await repo.getHandById(result.pokerHandId);
  if (!hand) throw new PokerHandNotFoundError();

  const existingResult = await repo.getHandResult(result.pokerHandId);
  if (existingResult) {
    // Already settled by a concurrent caller between our two RPCs.
    return result;
  }

  const players = await repo.getHandPlayers(result.pokerHandId);
  const board = computeBoardCards(hand.deckOrder, hand.dealtSeatNumbers.length, "RIVER");

  const contestants = players.filter((p) => !p.folded);
  const n = hand.dealtSeatNumbers.length;
  const holeCardsBySeat = new Map<number, [string, string]>();
  for (const seatNumber of hand.dealtSeatNumbers) {
    const position = hand.dealtSeatNumbers.indexOf(seatNumber);
    holeCardsBySeat.set(seatNumber, [hand.deckOrder[position], hand.deckOrder[n + position]]);
  }

  const evaluated = contestants.map((p) =>
    evaluateHand(p.seatNumber, holeCardsBySeat.get(p.seatNumber)!, board)
  );
  const rankedGroups = rankHandsBestToWorst(evaluated);

  const committedThisHand: Record<number, number> = {};
  const foldedSeats = new Set<number>();
  for (const p of players) {
    committedThisHand[p.seatNumber] = p.committedThisHand;
    if (p.folded) foldedSeats.add(p.seatNumber);
  }

  const pots: Pot[] = computeSidePots(committedThisHand, foldedSeats, (eligibleSeats) => {
    const eligibleSet = new Set(eligibleSeats);
    return rankedGroups
      .map((group) => group.filter((s) => eligibleSet.has(s)))
      .filter((group) => group.length > 0);
  });

  // Poker Playtest UX + Showdown Transparency Slice: descr is
  // pokersolver's own already-computed human-readable qualifier
  // ("Pair, A's", "Straight, 10 High") — previously discarded here,
  // now persisted alongside rankName so the participant client can
  // render a truthful "why you won/lost" line without a second
  // evaluation. showdown_hands is a jsonb column (0077); no migration.
  const showdownHands: Record<string, { cards: [string, string]; rankName: string; descr: string }> = {};
  for (const e of evaluated) {
    showdownHands[String(e.seatNumber)] = {
      cards: holeCardsBySeat.get(e.seatNumber)!,
      rankName: e.rankName,
      descr: e.descr,
    };
  }

  await repo.settleShowdown({
    pokerHandId: result.pokerHandId,
    board,
    pots,
    showdownHands,
  });

  return result;
}
