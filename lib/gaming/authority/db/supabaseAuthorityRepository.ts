import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuthorityRepository } from "./authorityRepository";
import type { PlatformAuthorityClass } from "../types";
import {
  InvalidAuthorityClassError,
  ReasonRequiredError,
  GamingMemberNotFoundError,
  GovernanceAlreadyBootstrappedError,
  GovernanceAuthorityRequiredError,
  AuthorityGrantNotFoundError,
} from "../types";

function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const table: Array<[string, () => Error]> = [
    ["INVALID_AUTHORITY_CLASS", () => new InvalidAuthorityClassError()],
    ["REASON_REQUIRED", () => new ReasonRequiredError()],
    ["GAMING_MEMBER_NOT_FOUND", () => new GamingMemberNotFoundError()],
    ["GOVERNANCE_ALREADY_BOOTSTRAPPED", () => new GovernanceAlreadyBootstrappedError()],
    ["GOVERNANCE_AUTHORITY_REQUIRED", () => new GovernanceAuthorityRequiredError()],
    ["AUTHORITY_GRANT_NOT_FOUND", () => new AuthorityGrantNotFoundError()],
  ];
  for (const [code, build] of table) {
    if (error.message.includes(code)) return build();
  }
  return null;
}

/**
 * Supabase-backed AuthorityRepository. service_role only, matching
 * every other repository in this codebase — authority_grants is
 * reached only through the server, never directly from the browser.
 */
export class SupabaseAuthorityRepository implements AuthorityRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async bootstrapGovernanceAuthority(gamingMemberId: string, reason: string) {
    const { data, error } = await this.client.rpc("bootstrap_governance_authority_atomically", {
      p_gaming_member_id: gamingMemberId,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      authorityGrantId: row.authority_grant_id,
      gamingMemberId: row.gaming_member_id,
      authorityClass: row.authority_class as PlatformAuthorityClass,
      grantedAt: row.granted_at,
    };
  }

  async grantPlatformAuthority(
    grantingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ) {
    const { data, error } = await this.client.rpc("grant_platform_authority_atomically", {
      p_granting_gaming_member_id: grantingGamingMemberId,
      p_target_gaming_member_id: targetGamingMemberId,
      p_authority_class: authorityClass,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      authorityGrantId: row.authority_grant_id,
      gamingMemberId: row.gaming_member_id,
      authorityClass: row.authority_class as PlatformAuthorityClass,
      grantedAt: row.granted_at,
      alreadyActive: row.already_active,
    };
  }

  async revokePlatformAuthority(
    revokingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ) {
    const { data, error } = await this.client.rpc("revoke_platform_authority_atomically", {
      p_revoking_gaming_member_id: revokingGamingMemberId,
      p_target_gaming_member_id: targetGamingMemberId,
      p_authority_class: authorityClass,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      authorityGrantId: row.authority_grant_id,
      gamingMemberId: row.gaming_member_id,
      authorityClass: row.authority_class as PlatformAuthorityClass,
      revokedAt: row.revoked_at,
      alreadyRevoked: row.already_revoked,
    };
  }

  async hasActiveAuthority(gamingMemberId: string, authorityClass: PlatformAuthorityClass): Promise<boolean> {
    const { data, error } = await this.client
      .from("authority_grants")
      .select("authority_grant_id")
      .eq("gaming_member_id", gamingMemberId)
      .eq("authority_class", authorityClass)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async listActiveAuthorityClasses(gamingMemberId: string): Promise<PlatformAuthorityClass[]> {
    const { data, error } = await this.client
      .from("authority_grants")
      .select("authority_class")
      .eq("gaming_member_id", gamingMemberId)
      .is("revoked_at", null);
    if (error) throw error;
    return (data ?? []).map((row) => row.authority_class as PlatformAuthorityClass);
  }
}
