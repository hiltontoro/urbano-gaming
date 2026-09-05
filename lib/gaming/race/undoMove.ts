import type { RaceRepository } from "./db/raceRepository";
import type { ApplyRaceUndoResult } from "./types";
import { RaceEventAlreadyTerminalError, RaceEventNotFoundError } from "./types";

/**
 * UNDO command handler. Undo is entirely server-derived within Towers'
 * own atomic function (no client-supplied target) — this handler only
 * needs to relay through the same Race+Towers transaction boundary as
 * move, no separate legality derivation.
 *
 * Before surfacing an "already terminal" rejection, re-checks the
 * durable Race operation ledger for an exact replay of this
 * idempotencyKey (UG-CR-GATE-025 Correction A) — a retry of an undo
 * that already succeeded, arriving after the event has since
 * terminalized (e.g. the opponent won while the response was in
 * transit), must replay its original result rather than being rejected
 * generically.
 */
export async function undoRaceMove(
  repo: RaceRepository,
  input: { raceEventId: string; competitorToken: string; idempotencyKey: string }
): Promise<ApplyRaceUndoResult> {
  const event = await repo.getEvent(input.raceEventId);
  if (!event) throw new RaceEventNotFoundError();
  if (event.terminalResolution) {
    const replay = await repo.peekUndoReplay({
      raceEventId: input.raceEventId,
      competitorToken: input.competitorToken,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) return replay;
    throw new RaceEventAlreadyTerminalError(event.terminalResolution, event.winnerSlot);
  }

  return repo.commitUndo({
    raceEventId: input.raceEventId,
    competitorToken: input.competitorToken,
    idempotencyKey: input.idempotencyKey,
  });
}
