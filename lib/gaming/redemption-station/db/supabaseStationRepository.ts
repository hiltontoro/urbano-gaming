import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  InvalidStationRequestError,
  PrizeCodeNotFoundError,
  StationClosedError,
  StationMisconfiguredError,
  StationNotFoundError,
  StationUnauthorizedError,
  type AttemptDecision,
  type PinChangeRecord,
  type ScopedRedemptionResult,
  type StationEventOutcome,
  type StationEventRecord,
  type StationLimits,
  type StationRecord,
  type StationSessionRecord,
} from "../types";
import type { StationRepository } from "./stationRepository";

type Row = Record<string, unknown>;

function station(row: Row): StationRecord {
  return {
    stationId: row.station_id as string,
    slug: row.slug as string,
    label: row.label as string,
    venueActivationId: row.venue_activation_id as string,
    matchId: row.match_id as string,
    actorGamingMemberId: row.actor_gaming_member_id as string,
    pinSalt: (row.pin_salt as string | null) ?? null,
    pinHash: (row.pin_hash as string | null) ?? null,
    pinVersion: row.pin_version as number,
    ipSalt: row.ip_salt as string,
    sessionTtlMinutes: row.session_ttl_minutes as number,
    expiresAt: row.expires_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

function session(row: Row): StationSessionRecord {
  return { sessionId: row.session_id as string, stationId: row.station_id as string, pinVersion: row.pin_version as number, expiresAt: row.expires_at as string, revokedAt: (row.revoked_at as string | null) ?? null };
}

function event(row: Row): StationEventRecord {
  return {
    eventId: row.event_id as string,
    stationId: row.station_id as string,
    sessionId: row.session_id as string,
    prizeQualificationId: row.prize_qualification_id as string,
    declaredOperator: (row.declared_operator as string | null) ?? null,
    outcome: row.outcome as StationEventOutcome,
    detail: (row.detail as string | null) ?? null,
    occurredAt: row.occurred_at as string,
  };
}

/** The database raises its refusals with a stable code at the start of the message; this turns them into the station's own errors. */
function mapDatabaseError(error: { message?: string } | null): Error {
  const message = error?.message ?? "";
  if (message.startsWith("REDEMPTION_STATION_SESSION_INVALID")) return new StationUnauthorizedError();
  if (message.startsWith("REDEMPTION_STATION_CLOSED")) return new StationClosedError();
  if (message.startsWith("REDEMPTION_STATION_NOT_FOUND")) return new StationNotFoundError();
  if (message.startsWith("REDEMPTION_STATION_SCOPE")) return new PrizeCodeNotFoundError();
  if (message.startsWith("REDEMPTION_STATION_ACTOR")) return new StationMisconfiguredError();
  if (message.startsWith("REDEMPTION_STATION_OPERATOR")) return new InvalidStationRequestError("Write your name or initials (2 to 40 letters or numbers).");
  return Object.assign(new Error(message || "Database error"), { cause: error });
}

/**
 * Supabase-backed station storage. Service key only: nothing here is reachable from a browser. Every request goes out with no-store, so a
 * session that was revoked or a station that was closed is never answered from the framework's data cache.
 */
export class SupabaseStationRepository implements StationRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    });
  }

  async getStationBySlug(slug: string) {
    const { data, error } = await this.client.from("redemption_stations").select("*").eq("slug", slug).maybeSingle();
    if (error) throw error;
    return data ? station(data as Row) : null;
  }

  async beginAttempt(stationId: string, ipHash: string, limits: StationLimits): Promise<AttemptDecision> {
    const { data, error } = await this.client.rpc("redemption_station_attempt_begin", {
      p_station_id: stationId,
      p_ip_hash: ipHash,
      p_ip_limit: limits.perClient,
      p_station_limit: limits.perStation,
      p_window_seconds: limits.windowSeconds,
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; attempt_id: string | number | null; retry_after_seconds: number };
    return { allowed: row.allowed, attemptId: row.attempt_id === null ? null : String(row.attempt_id), retryAfterSeconds: row.retry_after_seconds };
  }

  async markAttemptSucceeded(attemptId: string) {
    const { error } = await this.client.rpc("redemption_station_attempt_succeed", { p_attempt_id: Number(attemptId) });
    if (error) throw error;
  }

  async createSession(input: { stationId: string; tokenSha256: string; pinVersion: number; expiresAt: string }) {
    const { data, error } = await this.client
      .from("redemption_station_sessions")
      .insert({ station_id: input.stationId, token_sha256: input.tokenSha256, pin_version: input.pinVersion, expires_at: input.expiresAt })
      .select()
      .single();
    if (error) throw error;
    return session(data as Row);
  }

  async getSessionByTokenSha256(tokenSha256: string) {
    const { data: s, error } = await this.client.from("redemption_station_sessions").select("*").eq("token_sha256", tokenSha256).maybeSingle();
    if (error) throw error;
    if (!s) return null;
    const { data: st, error: e2 } = await this.client.from("redemption_stations").select("*").eq("station_id", (s as Row).station_id as string).maybeSingle();
    if (e2) throw e2;
    if (!st) return null;
    return { session: session(s as Row), station: station(st as Row) };
  }

  async revokeSession(sessionId: string) {
    const { error } = await this.client.from("redemption_station_sessions").update({ revoked_at: new Date().toISOString() }).eq("session_id", sessionId).is("revoked_at", null);
    if (error) throw error;
  }

  async revokeStation(stationId: string) {
    const { error } = await this.client.rpc("redemption_station_revoke", { p_station_id: stationId });
    if (error) throw error;
  }

  async setPin(input: { stationId: string; pinSalt: string; pinHash: string; changedByGamingMemberId: string }) {
    const { data, error } = await this.client.rpc("redemption_station_set_pin", {
      p_station_id: input.stationId,
      p_pin_salt: input.pinSalt,
      p_pin_hash: input.pinHash,
      p_changed_by_gaming_member_id: input.changedByGamingMemberId,
    });
    if (error) throw mapDatabaseError(error);
    const row = (Array.isArray(data) ? data[0] : data) as { pin_version: number; sessions_revoked: number };
    return { pinVersion: row.pin_version, sessionsRevoked: row.sessions_revoked };
  }

  async getAdminFacts(stationId: string) {
    const stationRow = await this.client.from("redemption_stations").select("pin_version").eq("station_id", stationId).maybeSingle();
    if (stationRow.error) throw stationRow.error;
    const pinVersion = (stationRow.data as Row | null)?.pin_version as number | undefined;
    const now = new Date().toISOString();
    const sessions = await this.client
      .from("redemption_station_sessions")
      .select("session_id", { count: "exact", head: true })
      .eq("station_id", stationId)
      .eq("pin_version", pinVersion ?? -1)
      .is("revoked_at", null)
      .gt("expires_at", now);
    if (sessions.error) throw sessions.error;
    const last = await this.client.from("redemption_station_pin_changes").select("changed_at").eq("station_id", stationId).order("changed_at", { ascending: false }).limit(1);
    if (last.error) throw last.error;
    return { activeSessions: sessions.count ?? 0, lastPinChangeAt: ((last.data ?? [])[0] as Row | undefined)?.changed_at as string | null ?? null };
  }

  async redeemInScope(input: { sessionTokenSha256: string; prizeQualificationId: string; declaredOperator: string }): Promise<ScopedRedemptionResult> {
    const { data, error } = await this.client.rpc("redemption_station_redeem", {
      p_session_token_sha256: input.sessionTokenSha256,
      p_prize_qualification_id: input.prizeQualificationId,
      p_declared_operator: input.declaredOperator,
    });
    if (error) throw mapDatabaseError(error);
    const row = (Array.isArray(data) ? data[0] : data) as { outcome: StationEventOutcome; redeemed_at: string | null; refusal: string | null; event_id: string };
    return { outcome: row.outcome, redeemedAt: row.redeemed_at ?? null, refusal: row.refusal ?? null, eventId: row.event_id };
  }

  async listEvents(stationId: string) {
    const { data, error } = await this.client.from("redemption_station_events").select("*").eq("station_id", stationId).order("occurred_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => event(row as Row));
  }

  async listPinChanges(stationId: string): Promise<PinChangeRecord[]> {
    const { data, error } = await this.client.from("redemption_station_pin_changes").select("*").eq("station_id", stationId).order("changed_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => {
      const r = row as Row;
      return { changeId: r.change_id as string, stationId: r.station_id as string, changedByGamingMemberId: r.changed_by_gaming_member_id as string, newPinVersion: r.new_pin_version as number, sessionsRevoked: r.sessions_revoked as number, changedAt: r.changed_at as string };
    });
  }
}
