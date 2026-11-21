import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  LifetimeTeamError, lifetimeErrorFromDatabase, normalizeLifetimeTeamName, parseBackfillScope, parseClaimBatch, parseClaimDecision, parseOfferDecision, parseOfferKind, requireUuid,
  type ClaimDecision, type EntriesFrozen, type EntryCreated, type EntryFlowEnabled, type EntryWithdrawn, type LegacyBackfillResult, type LeadershipDecision, type LeadershipEnded,
  type LeadershipOffer, type LifetimeEntryView, type LifetimeTeamCreated, type LifetimeTeamDisbanded, type LifetimeTeamsStore, type LifetimeTeamView, type MemberTeamSummary,
  type MembershipDecision, type MembershipEnded, type MembershipOffer, type OfferDecision, type OfferKind, type OfferWithdrawn, type RosterClaimDecision, type RosterClaimProposed,
  type RosterClaimReleased,
} from "../lifetimeTeams";
import { CompetitionAccessDeniedError, TeamRegistrationNotOpenError } from "../types";
import { translateError } from "./supabaseCompetitionsRepository";

/**
 * UG-CR-GATE-CFM-001 — the Supabase implementation of the lifetime-team store.
 *
 * Every write is one atomic database operation, called by its exact name with its exact parameter names (the operations are executable by the service role
 * only; no browser role can call them). Nothing here decides a rule. A refusal comes back as a coded P0001 error and is turned into a typed one:
 * this gate's own codes become a LifetimeTeamError, the codes the competitions repository already knows (access, cancellation, registration, closed
 * registration, revoked host, duplicate name, captaincy) become its existing typed errors, and anything else — an unknown refusal, a raw database failure,
 * an answer without a row — becomes the bounded UNAVAILABLE. The database's own words never reach a caller.
 *
 * Identifiers and decisions are validated before a call is made; a malformed request never reaches the database.
 */

/** Translates a database error into a typed one. Exported so tests can prove the mapping without a database. */
export function translateLifetimeError(error: { code?: string; message?: string }): Error {
  const message = typeof error.message === "string" ? error.message : "";
  if (error.code === "P0001") {
    const own = lifetimeErrorFromDatabase(message);
    if (own) return own;
    const shared = translateError(error);
    // The two shared refusals this gate's operations raise are rebuilt with their own bounded messages: the database's words (its code token and the internal
    // name of the feature) are never passed on, though the class — and so the status a route gives it — is the same.
    if (shared instanceof CompetitionAccessDeniedError) return new CompetitionAccessDeniedError();
    if (shared instanceof TeamRegistrationNotOpenError) return new TeamRegistrationNotOpenError();
    // The shared translator returns a plain Error carrying the database's own words for a code it does not know: never pass that on.
    if (shared.constructor !== Error) return shared;
  }
  return new LifetimeTeamError("UNAVAILABLE");
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value);
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export class SupabaseLifetimeTeamsRepository implements LifetimeTeamsStore {
  private readonly client: SupabaseClient;

  /** `client` is for tests only: the production wiring is the URL and the service-role key, like every other competitions repository. */
  constructor(supabaseUrl: string, serviceRoleKey: string, client?: SupabaseClient) {
    // Like every sibling repository, no Next.js Data Cache: a membership, leadership or claim read must never be a stale copy.
    this.client = client ?? createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
    });
  }

  private async rows(name: string, args: Record<string, unknown>): Promise<Row[]> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw translateLifetimeError(error);
    if (!Array.isArray(data)) throw new LifetimeTeamError("UNAVAILABLE");
    return data as Row[];
  }

  private async row(name: string, args: Record<string, unknown>): Promise<Row> {
    const rows = await this.rows(name, args);
    if (rows.length === 0) throw new LifetimeTeamError("UNAVAILABLE");
    return rows[0];
  }

  async createLifetimeTeam(creatorGamingMemberId: string, name: string): Promise<LifetimeTeamCreated> {
    const r = await this.row("create_lifetime_team_atomically", { p_creator_gaming_member_id: requireUuid(creatorGamingMemberId), p_name: normalizeLifetimeTeamName(name) });
    return { lifetimeTeamId: str(r.lifetime_team_id), publicCode: str(r.public_code), createdAt: str(r.created_at) };
  }

  async disbandLifetimeTeam(lifetimeTeamId: string, actorGamingMemberId: string): Promise<LifetimeTeamDisbanded> {
    const r = await this.row("disband_lifetime_team_atomically", { p_lifetime_team_id: requireUuid(lifetimeTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId) });
    return { lifetimeTeamId: str(r.lifetime_team_id), status: "DISBANDED", disbandedAt: str(r.disbanded_at) };
  }

  async proposeMembership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<MembershipOffer> {
    const r = await this.row("propose_lifetime_team_membership_atomically", {
      p_lifetime_team_id: requireUuid(lifetimeTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId), p_subject_gaming_member_id: requireUuid(subjectGamingMemberId),
    });
    return { lifetimeTeamMembershipId: str(r.lifetime_team_membership_id), status: "PENDING", initiatedBySide: r.initiated_by_side === "PERSON" ? "PERSON" : "TEAM", expiresAt: str(r.expires_at) };
  }

  async decideMembership(membershipId: string, actorGamingMemberId: string, decision: OfferDecision): Promise<MembershipDecision> {
    const parsed = parseOfferDecision(decision);
    const r = await this.row("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: requireUuid(membershipId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId), p_decision: parsed });
    return { lifetimeTeamMembershipId: str(r.lifetime_team_membership_id), status: r.status === "ACTIVE" ? "ACTIVE" : "ENDED", joinedAt: strOrNull(r.joined_at) };
  }

  async withdrawOffer(kind: OfferKind, offerId: string, actorGamingMemberId: string): Promise<OfferWithdrawn> {
    const parsed = parseOfferKind(kind);
    const r = await this.row("withdraw_lifetime_team_offer_atomically", { p_offer_kind: parsed, p_offer_id: requireUuid(offerId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId) });
    return { offerId: str(r.offer_id), status: "ENDED" };
  }

  async endMembership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string, successorGamingMemberId?: string | null): Promise<MembershipEnded> {
    const team = requireUuid(lifetimeTeamId);
    const actor = requireUuid(actorGamingMemberId);
    const subject = requireUuid(subjectGamingMemberId);
    const successor = successorGamingMemberId === undefined || successorGamingMemberId === null ? null : requireUuid(successorGamingMemberId);
    const r = await this.row("end_lifetime_team_membership_atomically", {
      p_lifetime_team_id: team, p_actor_gaming_member_id: actor, p_subject_gaming_member_id: subject, p_successor_gaming_member_id: successor,
    });
    return { lifetimeTeamMembershipId: str(r.lifetime_team_membership_id), endedAt: str(r.ended_at), successorLeadershipId: strOrNull(r.successor_leadership_id) };
  }

  async offerLeadership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<LeadershipOffer> {
    const r = await this.row("offer_lifetime_team_leadership_atomically", {
      p_lifetime_team_id: requireUuid(lifetimeTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId), p_subject_gaming_member_id: requireUuid(subjectGamingMemberId),
    });
    return { lifetimeTeamLeadershipId: str(r.lifetime_team_leadership_id), status: "PENDING", expiresAt: str(r.expires_at) };
  }

  async decideLeadership(leadershipId: string, actorGamingMemberId: string, decision: OfferDecision): Promise<LeadershipDecision> {
    const parsed = parseOfferDecision(decision);
    const r = await this.row("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: requireUuid(leadershipId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId), p_decision: parsed });
    return { lifetimeTeamLeadershipId: str(r.lifetime_team_leadership_id), status: r.status === "ACTIVE" ? "ACTIVE" : "ENDED", startedAt: strOrNull(r.started_at) };
  }

  async endLeadership(lifetimeTeamId: string, actorGamingMemberId: string): Promise<LeadershipEnded> {
    const r = await this.row("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: requireUuid(lifetimeTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId) });
    return { lifetimeTeamLeadershipId: str(r.lifetime_team_leadership_id), endedAt: str(r.ended_at), endReason: r.end_reason === "REMOVED" ? "REMOVED" : "STEPPED_DOWN" };
  }

  async enableEntryFlow(competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowEnabled> {
    const r = await this.row("enable_lifetime_entry_flow_atomically", { p_competition_id: requireUuid(competitionId), p_organizer_gaming_member_id: requireUuid(organizerGamingMemberId) });
    return { competitionId: str(r.competition_id), enabledAt: str(r.enabled_at), alreadyEnabled: r.already_enabled === true };
  }

  async enterTeam(competitionId: string, lifetimeTeamId: string, actorGamingMemberId: string): Promise<EntryCreated> {
    const r = await this.row("enter_lifetime_team_into_competition_atomically", {
      p_competition_id: requireUuid(competitionId), p_lifetime_team_id: requireUuid(lifetimeTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId),
    });
    return { competitionTeamId: str(r.competition_team_id), publicCode: str(r.public_code), createdAt: str(r.created_at) };
  }

  async withdrawEntry(competitionTeamId: string, actorGamingMemberId: string): Promise<EntryWithdrawn> {
    const r = await this.row("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: requireUuid(competitionTeamId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId) });
    return { competitionTeamId: str(r.competition_team_id), status: "REJECTED", releasedClaims: Number(r.released_claims) };
  }

  async proposeRosterClaims(competitionTeamId: string, actorGamingMemberId: string, gamingMemberIds: string[]): Promise<RosterClaimProposed[]> {
    const entry = requireUuid(competitionTeamId);
    const actor = requireUuid(actorGamingMemberId);
    const rows = await this.rows("propose_lifetime_entry_roster_claims_atomically", { p_competition_team_id: entry, p_actor_gaming_member_id: actor, p_gaming_member_ids: parseClaimBatch(gamingMemberIds) });
    return rows.map((r) => ({ claimId: str(r.competition_lifetime_roster_claim_id), gamingMemberId: str(r.gaming_member_id), status: "PROPOSED" as const, expiresAt: str(r.expires_at) }));
  }

  async decideRosterClaim(claimId: string, actorGamingMemberId: string, decision: ClaimDecision): Promise<RosterClaimDecision> {
    const parsed = parseClaimDecision(decision);
    const r = await this.row("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: requireUuid(claimId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId), p_decision: parsed });
    return { claimId: str(r.competition_lifetime_roster_claim_id), status: r.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED", acceptedAt: strOrNull(r.accepted_at) };
  }

  async releaseRosterClaim(claimId: string, actorGamingMemberId: string): Promise<RosterClaimReleased> {
    const r = await this.row("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: requireUuid(claimId), p_actor_gaming_member_id: requireUuid(actorGamingMemberId) });
    return { claimId: str(r.competition_lifetime_roster_claim_id), status: r.status === "REMOVED" ? "REMOVED" : "WITHDRAWN", releaseReason: str(r.release_reason) };
  }

  async freezeEntries(competitionId: string, organizerGamingMemberId: string): Promise<EntriesFrozen> {
    const r = await this.row("freeze_lifetime_competition_entries_atomically", { p_competition_id: requireUuid(competitionId), p_organizer_gaming_member_id: requireUuid(organizerGamingMemberId) });
    return { competitionId: str(r.competition_id), frozenAt: str(r.frozen_at), entryCount: Number(r.entry_count), claimCount: Number(r.claim_count), alreadyFrozen: r.already_frozen === true };
  }

  async backfillLegacyTeams(competitionIds: string[]): Promise<LegacyBackfillResult> {
    const r = await this.row("backfill_legacy_competition_teams_atomically", { p_competition_ids: parseBackfillScope(competitionIds) });
    return {
      teamsCreated: Number(r.teams_created), membershipsCreated: Number(r.memberships_created), leadershipsCreated: Number(r.leaderships_created),
      skippedAlreadyLinked: Number(r.skipped_already_linked), skippedNotAccepted: Number(r.skipped_not_accepted),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Bounded reads (the tables are server-only: only the service role can read them)
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async getLifetimeTeam(lifetimeTeamId: string): Promise<LifetimeTeamView | null> {
    const id = requireUuid(lifetimeTeamId);
    // ONE request — one statement, so one snapshot: the team with its active leaders and active members can never describe a state that never existed.
    const { data, error } = await this.client.from("lifetime_teams")
      .select("lifetime_team_id, public_code, name, status, origin, created_at, disbanded_at, lifetime_team_leaderships(role, gaming_member_id, started_at, seq), lifetime_team_memberships(gaming_member_id, joined_at, is_legacy, seq)")
      .eq("lifetime_team_id", id).eq("lifetime_team_leaderships.status", "ACTIVE").eq("lifetime_team_memberships.status", "ACTIVE").maybeSingle();
    if (error) throw translateLifetimeError(error);
    if (!data) return null;
    const t = data as unknown as Row & { lifetime_team_leaderships: Row[] | null; lifetime_team_memberships: Row[] | null };
    const bySeq = (a: Row, b: Row) => Number(a.seq) - Number(b.seq);
    return {
      lifetimeTeamId: str(t.lifetime_team_id), publicCode: str(t.public_code), name: str(t.name), status: t.status === "DISBANDED" ? "DISBANDED" : "ACTIVE",
      origin: t.origin === "LEGACY_BACKFILL" ? "LEGACY_BACKFILL" : "NEW", createdAt: str(t.created_at), disbandedAt: strOrNull(t.disbanded_at),
      leaders: [...(t.lifetime_team_leaderships ?? [])].sort(bySeq).map((l) => ({ role: l.role === "CAPTAIN" ? "CAPTAIN" as const : "SUB_CAPTAIN" as const, gamingMemberId: str(l.gaming_member_id), startedAt: str(l.started_at) })),
      members: [...(t.lifetime_team_memberships ?? [])].sort(bySeq).map((m) => ({ gamingMemberId: str(m.gaming_member_id), joinedAt: str(m.joined_at), isLegacy: m.is_legacy === true })),
    };
  }

  async listActiveTeamsOfMember(gamingMemberId: string): Promise<MemberTeamSummary[]> {
    const id = requireUuid(gamingMemberId);
    const { data, error } = await this.client
      .from("lifetime_team_memberships")
      .select("lifetime_team_id, joined_at, is_legacy, team:lifetime_teams(public_code, name, status)")
      .eq("gaming_member_id", id).eq("status", "ACTIVE").order("seq");
    if (error) throw translateLifetimeError(error);
    return ((data ?? []) as unknown as Array<Row & { team: Row | Row[] | null }>).flatMap((m) => {
      const team = Array.isArray(m.team) ? m.team[0] : m.team;
      if (!team) return [];
      return [{ lifetimeTeamId: str(m.lifetime_team_id), publicCode: str(team.public_code), name: str(team.name), status: team.status === "DISBANDED" ? "DISBANDED" as const : "ACTIVE" as const, joinedAt: str(m.joined_at), isLegacy: m.is_legacy === true }];
    });
  }

  async getEntry(competitionTeamId: string): Promise<LifetimeEntryView | null> {
    const id = requireUuid(competitionTeamId);
    // ONE request — one statement, so one snapshot: the entry and its claims can never describe a state that never existed (an entry that looks live beside claims that
    // were all released a moment later).
    const { data, error } = await this.client.from("competition_teams")
      .select("competition_team_id, competition_id, lifetime_team_id, public_code, name, captain_gaming_member_id, sub_captain_gaming_member_id, status, created_at, competition_lifetime_roster_claims(competition_lifetime_roster_claim_id, gaming_member_id, status, accepted_at, departed_at, seq)")
      .eq("competition_team_id", id).eq("entry_flow", "LIFETIME").maybeSingle();
    if (error) throw translateLifetimeError(error);
    if (!data) return null;
    const e = data as unknown as Row & { competition_lifetime_roster_claims: Row[] | null };
    const bySeq = (a: Row, b: Row) => Number(a.seq) - Number(b.seq);
    return {
      competitionTeamId: str(e.competition_team_id), competitionId: str(e.competition_id), lifetimeTeamId: str(e.lifetime_team_id), publicCode: str(e.public_code), name: str(e.name),
      captainGamingMemberId: str(e.captain_gaming_member_id), subCaptainGamingMemberId: strOrNull(e.sub_captain_gaming_member_id), status: str(e.status), createdAt: str(e.created_at),
      claims: [...(e.competition_lifetime_roster_claims ?? [])].sort(bySeq).map((c) => ({
        claimId: str(c.competition_lifetime_roster_claim_id), gamingMemberId: str(c.gaming_member_id), status: str(c.status), acceptedAt: strOrNull(c.accepted_at), departedAt: strOrNull(c.departed_at),
      })),
    };
  }
}
