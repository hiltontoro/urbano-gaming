import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RutasRepository } from "./rutasRepository";
import type {
  RutasActionEvent,
  RutasAttemptRecord,
  RutasDirection,
  RutasPiecePosition,
} from "../types";
import {
  RutasAttemptAlreadyAbandonedError,
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasNothingToUndoError,
  RutasStaleAttemptStateError,
} from "../types";

function mapAttempt(row: any): RutasAttemptRecord {
  return {
    attemptId: row.attempt_id,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    currentPiecePositions: row.current_piece_positions,
    moveCount: row.move_count,
    undoCount: row.undo_count,
    restartOfAttemptId: row.restart_of_attempt_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

function mapAction(row: any): RutasActionEvent {
  return {
    sequenceNumber: row.sequence_number,
    type: row.event_type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/**
 * Translates the named errcode='P0001' exceptions raised by the atomic
 * Rutas RPC functions (0157-0159) into the same typed error vocabulary
 * the in-memory repository throws directly — mirrors
 * supabasePokerRepository.ts's own translateNamedError convention.
 */
function translateNamedError(error: { message?: string } | null | undefined): Error | null {
  const message = error?.message ?? "";
  if (message.includes("RUTAS_ATTEMPT_NOT_FOUND")) return new RutasAttemptNotFoundError();
  if (message.includes("RUTAS_ATTEMPT_NOT_IN_PROGRESS")) return new RutasAttemptNotInProgressError();
  if (message.includes("RUTAS_STALE_ATTEMPT_STATE")) return new RutasStaleAttemptStateError();
  if (message.includes("RUTAS_NOTHING_TO_UNDO")) return new RutasNothingToUndoError();
  if (message.includes("RUTAS_ATTEMPT_ALREADY_ABANDONED")) return new RutasAttemptAlreadyAbandonedError();
  return null;
}

export class SupabaseRutasRepository implements RutasRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceRoleKey: string) {
    // The established Next.js Data Cache workaround (see
    // supabasePokerRepository.ts's identical comment, originally
    // discovered for Predictions) — found the hard way during the Final
    // Local Acceptance gate's own fresh audit: a route-level
    // Cache-Control: no-store header on this repository's OWN caller
    // does not stop Next.js from caching the supabase-js client's
    // *internal* fetch() calls (the ones this repository never sees
    // directly), which are GET-shaped for every .select()/.maybeSingle()
    // read. RPC mutations (POST-shaped) were never affected — only
    // reads — which is exactly why the earlier bug looked "fixed" after
    // the implementation gate's own browser proving (mutations always
    // reflected correctly) while reads were silently frozen at
    // whichever value the first GET for a given attemptId happened to
    // return, never invalidating afterward. Missed here initially by
    // not checking this exact established pattern before writing a new
    // Supabase repository from scratch.
    this.client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  async createAttempt(input: {
    attemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialPositions: Record<string, RutasPiecePosition>;
    restartOfAttemptId: string | null;
  }): Promise<RutasAttemptRecord> {
    const { data, error } = await this.client
      .from("rutas_attempts")
      .insert({
        attempt_id: input.attemptId,
        scenario_id: input.scenarioId,
        scenario_version: input.scenarioVersion,
        current_piece_positions: input.initialPositions,
        restart_of_attempt_id: input.restartOfAttemptId,
      })
      .select("*")
      .single();

    if (error) throw error;
    return mapAttempt(data);
  }

  async getAttempt(attemptId: string): Promise<RutasAttemptRecord | null> {
    const { data, error } = await this.client
      .from("rutas_attempts")
      .select("*")
      .eq("attempt_id", attemptId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAttempt(data) : null;
  }

  async listActionsForAttempt(attemptId: string): Promise<RutasActionEvent[]> {
    const { data, error } = await this.client
      .from("rutas_attempt_actions")
      .select("*")
      .eq("attempt_id", attemptId)
      .order("sequence_number", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAction);
  }

  async commitMove(input: {
    attemptId: string;
    expectedCurrentPositions: Record<string, RutasPiecePosition>;
    newPositions: Record<string, RutasPiecePosition>;
    pieceId: string;
    direction: RutasDirection;
    distance: number;
    cleared: boolean;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("apply_rutas_move_atomically", {
      p_attempt_id: input.attemptId,
      p_expected_positions: input.expectedCurrentPositions,
      p_new_positions: input.newPositions,
      p_piece_id: input.pieceId,
      p_direction: input.direction,
      p_distance: input.distance,
      p_cleared: input.cleared,
      p_completes: input.completes,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      attempt: {
        attemptId: row.attempt_id,
        scenarioId: row.scenario_id,
        scenarioVersion: row.scenario_version,
        currentPiecePositions: row.current_piece_positions,
        moveCount: row.move_count,
        undoCount: row.undo_count,
        restartOfAttemptId: row.restart_of_attempt_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        outcome: row.outcome,
        createdAt: row.created_at,
      },
      alreadyApplied: row.already_applied as boolean,
    };
  }

  async commitUndo(input: {
    attemptId: string;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("undo_rutas_move_atomically", {
      p_attempt_id: input.attemptId,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      attempt: {
        attemptId: row.attempt_id,
        scenarioId: row.scenario_id,
        scenarioVersion: row.scenario_version,
        currentPiecePositions: row.current_piece_positions,
        moveCount: row.move_count,
        undoCount: row.undo_count,
        restartOfAttemptId: row.restart_of_attempt_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        outcome: row.outcome,
        createdAt: row.created_at,
      },
      alreadyApplied: row.already_applied as boolean,
    };
  }

  async commitRestart(input: {
    oldAttemptId: string;
    newAttemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialPositions: Record<string, RutasPiecePosition>;
    idempotencyKey: string;
  }): Promise<{ newAttempt: RutasAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("restart_rutas_attempt_atomically", {
      p_old_attempt_id: input.oldAttemptId,
      p_new_attempt_id: input.newAttemptId,
      p_scenario_id: input.scenarioId,
      p_scenario_version: input.scenarioVersion,
      p_initial_positions: input.initialPositions,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      newAttempt: {
        attemptId: row.new_attempt_id,
        scenarioId: input.scenarioId,
        scenarioVersion: input.scenarioVersion,
        currentPiecePositions: row.current_piece_positions,
        moveCount: row.move_count,
        undoCount: row.undo_count,
        restartOfAttemptId: row.restart_of_attempt_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        outcome: row.outcome,
        createdAt: row.created_at,
      },
      abandonedAttemptId: row.abandoned_attempt_id,
      alreadyApplied: row.already_applied as boolean,
    };
  }
}
