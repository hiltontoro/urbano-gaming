import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { RoomRepository } from "./roomRepository";
import type { RoomRecord, RoomRuntimeType } from "../types";

function mapRoom(row: Record<string, unknown>): RoomRecord {
  const runtimeType: RoomRuntimeType = row.session_id ? "SESSION" : "POKER_TABLE";
  const runtimeId = (row.session_id ?? row.poker_table_id) as string;
  return {
    roomId: row.room_id as string,
    roomCode: row.room_code as string,
    runtimeType,
    runtimeId,
    createdAt: row.created_at as string,
  };
}

export class SupabaseRoomRepository implements RoomRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  async findByRoomCode(roomCode: string): Promise<RoomRecord | null> {
    const { data, error } = await this.client
      .from("rooms")
      .select("*")
      .eq("room_code", roomCode)
      .maybeSingle();
    if (error) throw error;
    return data ? mapRoom(data) : null;
  }
}
