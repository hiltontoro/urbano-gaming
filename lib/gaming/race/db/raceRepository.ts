import type { TowersStacks } from "../../towers/types";
import type {
  ApplyRaceMoveResult,
  ApplyRaceUndoResult,
  ConfirmRaceReadinessResult,
  CreateRaceEventResult,
  JoinRaceEventResult,
  RaceBoardView,
  RaceEventRecord,
  RequestRaceCancellationResult,
} from "../types";

/**
 * Race persistence boundary. Unlike Towers/Rutas (exactly one legitimate
 * writer per attempt), Race has exactly two legitimate writers (the two
 * competitors) racing against a shared event — every mutating method
 * here must be backed by the Race-owned atomic transaction boundary
 * (lock the Race event row, then invoke Towers' own atomic function
 * inside the SAME transaction, never a separate HTTP call). See
 * supabase/migrations/20260904085843_create_race_functions.sql.
 *
 * Every mutating method is additionally backed by the Race-owned
 * operation ledger (race_event_creations / race_event_operations),
 * checked under the same lock before any terminal-state rejection or
 * child mutation — durable idempotency owned by Race itself, not
 * borrowed from Towers' own per-attempt action history (UG-CR-GATE-025
 * Correction A).
 */
export interface RaceRepository {
  /** Ledger-backed: a lost-response retry with the same idempotencyKey returns the same event/organizerToken, never a second event. */
  createEvent(input: {
    idempotencyKey: string;
    scenarioId: string;
    scenarioVersion: number;
  }): Promise<CreateRaceEventResult>;

  /** Ledger-backed: a lost-response retry with the same idempotencyKey returns the same slot/token, never the other slot. */
  joinEvent(input: { raceEventId: string; idempotencyKey: string }): Promise<JoinRaceEventResult>;

  /**
   * Read-and-possibly-lazily-terminalize projection of the full event
   * row (server-internal shape, including attempt ids — callers building
   * a client-facing projection must strip them).
   */
  getEvent(raceEventId: string): Promise<RaceEventRecord | null>;

  /** Read-only lookup of a competitor's own board via Towers' own repository (never the opponent's, by construction of the caller). */
  getBoard(attemptId: string): Promise<RaceBoardView | null>;

  /**
   * Plain (unlocked) read of the Race-owned operation ledger for a MOVE
   * command. Used only as a fast-path recovery when the domain layer's
   * own legality prevalidation, run against a possibly-already-mutated
   * board, is about to reject a request — before surfacing that
   * rejection, it re-checks whether this is actually a genuine replay.
   * Returns the original result on an exact match (same caller, same
   * payload); throws RaceIdempotencyKeyConflictError if the key exists
   * but the caller or payload differs; returns null if no ledger entry
   * exists at all (the original rejection should proceed). This is a
   * best-effort optimization only — the atomic RPC's own locked ledger
   * check remains the sole authoritative safety net for genuine
   * concurrency (UG-CR-GATE-025 Correction A).
   */
  peekMoveReplay(input: {
    raceEventId: string;
    competitorToken: string;
    fromTowerId: string;
    toTowerId: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult | null>;

  /** Same fast-path-recovery role as peekMoveReplay, for the UNDO command. */
  peekUndoReplay(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult | null>;

  confirmReadiness(input: {
    raceEventId: string;
    competitorToken: string;
    initialStacks: TowersStacks;
  }): Promise<ConfirmRaceReadinessResult>;

  /**
   * Commits one official move through the single atomic transaction
   * boundary: locks the Race event, checks the operation ledger for an
   * exact replay, authorizes the competitor slot, validates timing, and
   * invokes Towers' apply_towers_move_atomically as a nested call in
   * the same transaction.
   */
  commitMove(input: {
    raceEventId: string;
    competitorToken: string;
    expectedStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: string;
    toTowerId: string;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult>;

  commitUndo(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult>;

  requestCancellation(input: {
    raceEventId: string;
    callerToken: string;
    idempotencyKey: string;
  }): Promise<RequestRaceCancellationResult>;
}
