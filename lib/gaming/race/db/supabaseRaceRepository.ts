import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RaceRepository } from "./raceRepository";
import { SupabaseTowersRepository } from "../../towers/db/supabaseTowersRepository";
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
import {
  RaceEventAlreadyTerminalError,
  RaceEventFullError,
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceIllegalMoveError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceNothingToUndoError,
  RaceOrganizerCannotCancelAfterCountdownError,
  RaceStaleAttemptStateError,
} from "../types";

function mapEvent(row: any): RaceEventRecord {
  return {
    raceEventId: row.race_event_id,
    organizerToken: row.organizer_token,
    childGame: row.child_game,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    competitorAToken: row.competitor_a_token,
    competitorBToken: row.competitor_b_token,
    competitorAAttemptId: row.competitor_a_attempt_id,
    competitorBAttemptId: row.competitor_b_attempt_id,
    competitorAReady: row.competitor_a_ready,
    competitorBReady: row.competitor_b_ready,
    competitorACancelRequested: row.competitor_a_cancel_requested,
    competitorBCancelRequested: row.competitor_b_cancel_requested,
    secondCompetitorAssignedAt: row.second_competitor_assigned_at,
    sharedStartAt: row.shared_start_at,
    terminalResolution: row.terminal_resolution,
    winnerSlot: row.winner_slot,
    terminalReason: row.terminal_reason,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

/** Mirrors supabaseTowersRepository.ts's own translateNamedError convention. */
function translateNamedError(error: { message?: string } | null | undefined): Error | null {
  const message = error?.message ?? "";
  if (message.includes("RACE_IDEMPOTENCY_KEY_CONFLICT")) return new RaceIdempotencyKeyConflictError();
  if (message.includes("RACE_EVENT_NOT_FOUND")) return new RaceEventNotFoundError();
  if (message.includes("RACE_EVENT_FULL")) return new RaceEventFullError();
  if (message.includes("RACE_INVALID_COMPETITOR_TOKEN")) return new RaceInvalidTokenError();
  if (message.includes("RACE_INVALID_CALLER_TOKEN")) return new RaceInvalidTokenError();
  if (message.includes("RACE_NOT_YET_STARTED")) return new RaceNotYetStartedError();
  if (message.includes("RACE_ATTEMPT_NOT_ASSIGNED")) return new RaceNotYetStartedError();
  if (message.includes("RACE_ORGANIZER_CANNOT_CANCEL_AFTER_COUNTDOWN"))
    return new RaceOrganizerCannotCancelAfterCountdownError();
  if (message.includes("TOWERS_STALE_ATTEMPT_STATE")) return new RaceStaleAttemptStateError();
  if (message.includes("TOWERS_NOTHING_TO_UNDO")) return new RaceNothingToUndoError();
  if (message.includes("TOWERS_ATTEMPT_NOT_IN_PROGRESS")) return new RaceIllegalMoveError("This Race competitor's board is no longer in progress.");
  return null;
}

export class SupabaseRaceRepository implements RaceRepository {
  private client: SupabaseClient;
  private towersRepo: SupabaseTowersRepository;

  constructor(supabaseUrl: string, supabaseServiceRoleKey: string) {
    // Same no-store override as supabaseTowersRepository.ts — MANDATORY
    // per the Rutas/Towers Slice 001 implementation record, otherwise
    // Next.js's own fetch-patching layer silently caches supabase-js's
    // internal GET-shaped read calls.
    this.client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
    this.towersRepo = new SupabaseTowersRepository(supabaseUrl, supabaseServiceRoleKey);
  }

  async createEvent(input: {
    idempotencyKey: string;
    scenarioId: string;
    scenarioVersion: number;
  }): Promise<CreateRaceEventResult> {
    const { data, error } = await this.client.rpc("create_race_event_atomically", {
      p_idempotency_key: input.idempotencyKey,
      p_scenario_id: input.scenarioId,
      p_scenario_version: input.scenarioVersion,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      raceEventId: row.race_event_id,
      organizerToken: row.organizer_token,
      scenarioId: row.scenario_id,
      scenarioVersion: row.scenario_version,
    };
  }

  async joinEvent(input: { raceEventId: string; idempotencyKey: string }): Promise<JoinRaceEventResult> {
    const { data, error } = await this.client.rpc("join_race_event_atomically", {
      p_race_event_id: input.raceEventId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { competitorSlot: row.competitor_slot, competitorToken: row.competitor_token };
  }

  async getEvent(raceEventId: string): Promise<RaceEventRecord | null> {
    const { data, error } = await this.client.rpc("get_race_event_projection_atomically", {
      p_race_event_id: raceEventId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? mapEvent(row) : null;
  }

  async getBoard(attemptId: string): Promise<RaceBoardView | null> {
    const attempt = await this.towersRepo.getAttempt(attemptId);
    if (!attempt) return null;
    return {
      currentStacks: attempt.currentStacks,
      moveCount: attempt.moveCount,
      undoCount: attempt.undoCount,
      outcome: attempt.outcome,
    };
  }

  async peekMoveReplay(input: {
    raceEventId: string;
    competitorToken: string;
    fromTowerId: string;
    toTowerId: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult | null> {
    const { data, error } = await this.client
      .from("race_event_operations")
      .select("command, caller_token, payload_fingerprint, result")
      .eq("race_event_id", input.raceEventId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const fingerprint = `${input.fromTowerId}>${input.toTowerId}`;
    if (data.command !== "MOVE" || data.caller_token !== input.competitorToken || data.payload_fingerprint !== fingerprint) {
      throw new RaceIdempotencyKeyConflictError();
    }
    const result = data.result as any;
    return {
      towersOutcome: result.towers_outcome,
      currentStacks: result.current_stacks,
      moveCount: result.move_count,
      raceTerminalResolution: result.race_terminal_resolution,
      raceWinnerSlot: result.race_winner_slot,
      alreadyApplied: true,
    };
  }

  async peekUndoReplay(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult | null> {
    const { data, error } = await this.client
      .from("race_event_operations")
      .select("command, caller_token, result")
      .eq("race_event_id", input.raceEventId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    if (data.command !== "UNDO" || data.caller_token !== input.competitorToken) {
      throw new RaceIdempotencyKeyConflictError();
    }
    const result = data.result as any;
    return {
      towersOutcome: result.towers_outcome,
      currentStacks: result.current_stacks,
      moveCount: result.move_count,
      undoCount: result.undo_count,
      raceTerminalResolution: null,
      alreadyApplied: true,
    };
  }

  async confirmReadiness(input: {
    raceEventId: string;
    competitorToken: string;
    initialStacks: TowersStacks;
  }): Promise<ConfirmRaceReadinessResult> {
    const { data, error } = await this.client.rpc("confirm_race_readiness_atomically", {
      p_race_event_id: input.raceEventId,
      p_competitor_token: input.competitorToken,
      p_initial_stacks: input.initialStacks,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      bothReady: row.both_ready,
      sharedStartAt: row.shared_start_at,
      terminalResolution: row.terminal_resolution,
    };
  }

  async commitMove(input: {
    raceEventId: string;
    competitorToken: string;
    expectedStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: string;
    toTowerId: string;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult> {
    const { data, error } = await this.client.rpc("apply_race_move_atomically", {
      p_race_event_id: input.raceEventId,
      p_competitor_token: input.competitorToken,
      p_expected_stacks: input.expectedStacks,
      p_new_stacks: input.newStacks,
      p_from_tower_id: input.fromTowerId,
      p_to_tower_id: input.toTowerId,
      p_piece_rank: input.pieceRank,
      p_completes: input.completes,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row.towers_outcome === "RACE_EVENT_ALREADY_TERMINAL") {
      throw new RaceEventAlreadyTerminalError(row.race_terminal_resolution, row.race_winner_slot);
    }
    return {
      towersOutcome: row.towers_outcome,
      currentStacks: row.current_stacks,
      moveCount: row.move_count,
      raceTerminalResolution: row.race_terminal_resolution,
      raceWinnerSlot: row.race_winner_slot,
      alreadyApplied: row.already_applied,
    };
  }

  async commitUndo(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult> {
    const { data, error } = await this.client.rpc("apply_race_undo_atomically", {
      p_race_event_id: input.raceEventId,
      p_competitor_token: input.competitorToken,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row.towers_outcome === "RACE_EVENT_ALREADY_TERMINAL") {
      throw new RaceEventAlreadyTerminalError(row.race_terminal_resolution, null);
    }
    return {
      towersOutcome: row.towers_outcome,
      currentStacks: row.current_stacks,
      moveCount: row.move_count,
      undoCount: row.undo_count,
      raceTerminalResolution: row.race_terminal_resolution,
      alreadyApplied: row.already_applied,
    };
  }

  async requestCancellation(input: {
    raceEventId: string;
    callerToken: string;
    idempotencyKey: string;
  }): Promise<RequestRaceCancellationResult> {
    const { data, error } = await this.client.rpc("request_race_cancellation_atomically", {
      p_race_event_id: input.raceEventId,
      p_caller_token: input.callerToken,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { terminalResolution: row.terminal_resolution, cancelPending: row.cancel_pending };
  }
}
