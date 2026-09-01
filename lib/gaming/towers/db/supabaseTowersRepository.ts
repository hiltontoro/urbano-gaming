import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { TowersRepository } from "./towersRepository";
import type { TowerId, TowersActionEvent, TowersAttemptRecord, TowersStacks } from "../types";
import {
  TowersAttemptAlreadyAbandonedError,
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersNothingToUndoError,
  TowersStaleAttemptStateError,
} from "../types";

function mapAttempt(row: any): TowersAttemptRecord {
  return {
    attemptId: row.attempt_id,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    currentStacks: row.current_stacks,
    moveCount: row.move_count,
    undoCount: row.undo_count,
    restartOfAttemptId: row.restart_of_attempt_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

function mapAction(row: any): TowersActionEvent {
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
 * Towers RPC functions into the same typed error vocabulary the
 * in-memory repository throws directly — mirrors
 * supabaseRutasRepository.ts's own translateNamedError convention.
 */
function translateNamedError(error: { message?: string } | null | undefined): Error | null {
  const message = error?.message ?? "";
  if (message.includes("TOWERS_ATTEMPT_NOT_FOUND")) return new TowersAttemptNotFoundError();
  if (message.includes("TOWERS_ATTEMPT_NOT_IN_PROGRESS")) return new TowersAttemptNotInProgressError();
  if (message.includes("TOWERS_STALE_ATTEMPT_STATE")) return new TowersStaleAttemptStateError();
  if (message.includes("TOWERS_NOTHING_TO_UNDO")) return new TowersNothingToUndoError();
  if (message.includes("TOWERS_ATTEMPT_ALREADY_ABANDONED")) return new TowersAttemptAlreadyAbandonedError();
  return null;
}

export class SupabaseTowersRepository implements TowersRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceRoleKey: string) {
    // MANDATORY per the Rutas Slice 001 implementation record: without
    // this override, Next.js's own fetch-patching layer silently caches
    // the supabase-js client's internal GET-shaped .select()/.maybeSingle()
    // calls, independent of any Cache-Control header on this repository's
    // caller. RPC mutations are POST-shaped and unaffected — only reads —
    // which is exactly why this class of bug is invisible to contract
    // tests (they never run inside a live Next.js server) and only
    // surfaces as stale GETs after a real mutation. See
    // supabaseRutasRepository.ts's identical comment and the Towers
    // Slice 001 gate's own explicit checklist item for this pattern.
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
    initialStacks: TowersStacks;
    restartOfAttemptId: string | null;
  }): Promise<TowersAttemptRecord> {
    const { data, error } = await this.client
      .from("towers_attempts")
      .insert({
        attempt_id: input.attemptId,
        scenario_id: input.scenarioId,
        scenario_version: input.scenarioVersion,
        current_stacks: input.initialStacks,
        restart_of_attempt_id: input.restartOfAttemptId,
      })
      .select("*")
      .single();

    if (error) throw error;
    return mapAttempt(data);
  }

  async getAttempt(attemptId: string): Promise<TowersAttemptRecord | null> {
    const { data, error } = await this.client
      .from("towers_attempts")
      .select("*")
      .eq("attempt_id", attemptId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAttempt(data) : null;
  }

  async listActionsForAttempt(attemptId: string): Promise<TowersActionEvent[]> {
    const { data, error } = await this.client
      .from("towers_attempt_actions")
      .select("*")
      .eq("attempt_id", attemptId)
      .order("sequence_number", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(mapAction);
  }

  async commitMove(input: {
    attemptId: string;
    expectedCurrentStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: TowerId;
    toTowerId: TowerId;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("apply_towers_move_atomically", {
      p_attempt_id: input.attemptId,
      p_expected_stacks: input.expectedCurrentStacks,
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
    return { attempt: mapAttempt(row), alreadyApplied: row.already_applied as boolean };
  }

  async commitUndo(input: {
    attemptId: string;
    idempotencyKey: string;
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("undo_towers_move_atomically", {
      p_attempt_id: input.attemptId,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return { attempt: mapAttempt(row), alreadyApplied: row.already_applied as boolean };
  }

  async commitRestart(input: {
    oldAttemptId: string;
    newAttemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialStacks: TowersStacks;
    idempotencyKey: string;
  }): Promise<{ newAttempt: TowersAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc("restart_towers_attempt_atomically", {
      p_old_attempt_id: input.oldAttemptId,
      p_new_attempt_id: input.newAttemptId,
      p_scenario_id: input.scenarioId,
      p_scenario_version: input.scenarioVersion,
      p_initial_stacks: input.initialStacks,
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
        currentStacks: row.current_stacks,
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
