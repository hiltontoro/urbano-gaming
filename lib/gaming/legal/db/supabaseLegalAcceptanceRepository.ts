import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LegalAcceptanceRecord, LegalActType, LegalDocumentKey, LegalLocale } from "../types";
import { LegalAcceptanceHashConflictError } from "../types";
import type { LegalAcceptanceRepository, RecordLegalAcceptanceInput } from "./legalAcceptanceRepository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapRow(row: Record<string, unknown>): LegalAcceptanceRecord {
  return {
    legalAcceptanceId: row.legal_acceptance_id as string,
    gamingMemberId: row.gaming_member_id as string,
    documentKey: row.document_key as LegalDocumentKey,
    documentVersion: row.document_version as string,
    contentSha256: row.content_sha256 as string,
    actType: row.act_type as LegalActType,
    scopeMatchId: (row.scope_match_id as string | null) ?? null,
    ageDeclared18: (row.age_declared_18 as boolean | null) ?? null,
    locale: row.locale as LegalLocale,
    source: row.source as "PRE_PARTICIPATION",
    acceptedAt: row.accepted_at as string,
  };
}

/**
 * Supabase-backed LegalAcceptanceRepository. service_role only, like every repository here: legal_acceptances is reached through the
 * server, never from the browser. The write goes through record_legal_acceptance(), the single writer, which is idempotent and safe
 * under concurrency (partial unique indexes cover the global documents whose scope is NULL).
 */
export class SupabaseLegalAcceptanceRepository implements LegalAcceptanceRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async recordAcceptance(input: RecordLegalAcceptanceInput) {
    const { data, error } = await this.client.rpc("record_legal_acceptance", {
      p_gaming_member_id: input.gamingMemberId,
      p_document_key: input.documentKey,
      p_document_version: input.documentVersion,
      p_content_sha256: input.contentSha256,
      p_act_type: input.actType,
      p_scope_match_id: input.scopeMatchId,
      p_age_declared_18: input.ageDeclared18,
      p_locale: input.locale,
      p_source: input.source,
    });
    if (error) {
      if (error.code === "P0001" && typeof error.message === "string" && error.message.includes("LEGAL_ACCEPTANCE_HASH_CONFLICT")) {
        throw new LegalAcceptanceHashConflictError();
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { record: mapRow(row.acceptance as Record<string, unknown>), alreadyRecorded: row.already_recorded === true };
  }

  async listForMember(gamingMemberId: string, scopeMatchId?: string | null) {
    // the id goes into a filter expression: only a real uuid is ever allowed there
    if (typeof scopeMatchId === "string" && !UUID.test(scopeMatchId)) throw new Error("scopeMatchId must be a uuid.");
    let query = this.client.from("legal_acceptances").select("*").eq("gaming_member_id", gamingMemberId);
    if (scopeMatchId !== undefined) {
      query = scopeMatchId === null ? query.is("scope_match_id", null) : query.or(`scope_match_id.is.null,scope_match_id.eq.${scopeMatchId}`);
    }
    const { data, error } = await query.order("accepted_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
  }
}
