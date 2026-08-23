import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { GamingRepository } from "./gamingRepository";
import type { GamingMemberRecord } from "../types";
import {
  EmptyGamingDisplayNameError,
  GamingDisplayNameTooLongError,
} from "../types";

/**
 * Supabase-backed GamingRepository. Always constructed with the
 * service_role key, exactly like SupabaseSessionRepository — this
 * table is reached only through the server, never directly from the
 * browser (see 0045's migration comment on the local/production RLS
 * divergence).
 */
export class SupabaseGamingRepository implements GamingRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async resolveGamingMemberByAuthUserId(
    authUserId: string
  ): Promise<GamingMemberRecord | null> {
    const { data, error } = await this.client
      .from("gaming_members")
      .select("*")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      gamingMemberId: data.gaming_member_id,
      authUserId: data.auth_user_id,
      displayName: data.display_name,
      createdAt: data.created_at,
    };
  }

  async createGamingMember(
    authUserId: string,
    displayName: string
  ): Promise<GamingMemberRecord> {
    const { data, error } = await this.client.rpc(
      "create_gaming_member_atomically",
      {
        p_auth_user_id: authUserId,
        p_display_name: displayName,
      }
    );

    if (error) {
      // gaming_members_display_name_length_check (0045) is the schema-
      // level backstop to createGamingMember.ts's own validation — only
      // reachable if a caller ever bypasses that validation directly
      // against this repository.
      if (
        error.code === "23514" &&
        error.message.includes("gaming_members_display_name_length_check")
      ) {
        const trimmed = displayName.trim();
        throw trimmed.length === 0
          ? new EmptyGamingDisplayNameError()
          : new GamingDisplayNameTooLongError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      gamingMemberId: row.gaming_member_id,
      authUserId: row.auth_user_id,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }
}
