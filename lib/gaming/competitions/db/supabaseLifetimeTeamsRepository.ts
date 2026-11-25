import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  LifetimeTeamError, lifetimeErrorFromDatabase, normalizeLifetimeTeamName, parseBackfillScope, parseClaimBatch, parseClaimDecision, parseEntryDecisionRequest, parseOfferDecision, parseOfferKind,
  requireUuid,
  type ClaimDecision, type EntriesFrozen, type EntryCreated, type EntryDecided, type EntryDecision, type EntryDecisionReason, type EntryFlowDisabled, type EntryFlowEnabled,
  type EntryWithdrawn, type LedEntryView, type LegacyBackfillResult, type LeadershipDecision, type LeadershipEnded,
  type LeadershipOffer, type LifetimeEntryView, type LifetimeTeamCreated, type LifetimeTeamDisbanded, type LifetimeTeamsStore, type LifetimeTeamView, type LiveEntryStatus, type MemberTeamSummary,
  type MembershipDecision, type MembershipEnded, type MembershipOffer, type OfferDecision, type OfferKind, type OfferWithdrawn, type OpenClaimStatus, type OrganizerEntryView, type OwnClaimView,
  type PendingOfferView, type RosterClaimDecision, type RosterClaimProposed, type RosterClaimReleased, type TeamRole, type JoinLinkTeam, type RosterCandidate,
} from "../lifetimeTeams";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, TeamRegistrationNotOpenError } from "../types";
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-CFM-012 — the read side: the member's role on each team, and the member's own pending offers.
//
// Everything below is derived from the verified member alone. The statements are filtered by that member, but the filter is only a convenience: the code that follows
// decides what the member may see from the rows themselves (their status, their parties, the team's own current seats), and a row that is malformed or contradicts
// itself is dropped — it is never shown, never repaired and never grants anything. Every result is built field by field; no database row leaves this file.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidText = (value: unknown): value is string => typeof value === "string" && UUID_SHAPE.test(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const sameMember = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row)) : []);

/** A team's seats, embedded in the same statement as whatever asks about them: its whole seat history, so that a pending or ended seat can be told from an active one. */
const SEATS_OF_TEAM = "leaders:lifetime_team_leaderships(gaming_member_id, role, status, started_at, ended_at)";
const TEAM_OF_OFFER = `team:lifetime_teams(lifetime_team_id, public_code, name, status, ${SEATS_OF_TEAM})`;
const SEAT_ROWS = "lifetime_team_id, gaming_member_id, role, status, started_at, ended_at";
const MEMBERSHIP_OFFER_ROWS = `lifetime_team_membership_id, seq, created_at, expires_at, status, lifetime_team_id, gaming_member_id, initiated_by_side, initiated_by_gaming_member_id, ${TEAM_OF_OFFER}`;
const SEAT_OFFER_ROWS = `lifetime_team_leadership_id, seq, created_at, expires_at, status, role, lifetime_team_id, gaming_member_id, offered_by_gaming_member_id, ${TEAM_OF_OFFER}`;
/** The only columns of a member's profile this file ever asks for: never the authentication identity, never contact details. */
const COUNTERPARTY_ROWS = "gaming_member_id, display_name";

/** A seat exactly as a current one is recorded — ACTIVE, started, not ended, a known role, a known holder — or null (pending, ended, malformed or contradictory). */
function activeSeat(value: unknown): { member: string; role: "CAPTAIN" | "SUB_CAPTAIN" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const seat = value as Row;
  if (seat.status !== "ACTIVE" || !isUuidText(seat.gaming_member_id)) return null;
  if (seat.role !== "CAPTAIN" && seat.role !== "SUB_CAPTAIN") return null;
  if (!isText(seat.started_at) || seat.ended_at !== null) return null; // ACTIVE and ended, or ACTIVE and never started, contradict themselves
  return { member: seat.gaming_member_id, role: seat.role };
}

/**
 * The member's role on ONE team, from that team's own seats. Only an ACTIVE, well-formed seat counts, and only a role that is unambiguous — held by exactly one active seat
 * of the team — is granted: two seats for the same role contradict the one-holder rule and grant it to nobody. The captain's seat beats the sub-captain's, and either beats
 * being a member. Anything else, whatever the data, is MEMBER: a doubt is never resolved in favour of leadership.
 */
function deriveTeamRole(memberId: string, seats: unknown): TeamRole {
  const active = (Array.isArray(seats) ? seats : []).flatMap((seat) => { const found = activeSeat(seat); return found ? [found] : []; });
  const captains = active.filter((seat) => seat.role === "CAPTAIN");
  const subCaptains = active.filter((seat) => seat.role === "SUB_CAPTAIN");
  if (captains.length === 1 && sameMember(captains[0].member, memberId)) return "CAPTAIN";
  if (subCaptains.length === 1 && sameMember(subCaptains[0].member, memberId)) return "SUB_CAPTAIN";
  return "MEMBER";
}

/** An instant as a whole number of microseconds, so that two offers made within the same millisecond keep the order they were made in (null when it is not an instant). */
function microsecondsOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  return Number.isNaN(seconds) ? null : seconds * 1000 + Number((match[2] ?? "").padEnd(6, "0"));
}

interface OfferCandidate {
  key: string;
  kind: "MEMBERSHIP" | "LEADERSHIP";
  offerId: string;
  direction: "INCOMING" | "OUTGOING";
  team: { lifetimeTeamId: string; publicCode: string; name: string };
  counterpartyId: string | null;
  expiresAt: string;
  created: number;
  seq: number;
}

/** What every pending offer row must state: a well-formed identifier, PENDING, an expiry that is an instant (it may be in the past: that is not this read's to judge), and a creation order. */
function offerFacts(row: Row, idColumn: string): { offerId: string; expiresAt: string; created: number; seq: number } | null {
  const id = row[idColumn];
  if (!isUuidText(id) || row.status !== "PENDING" || !isText(row.expires_at) || Number.isNaN(Date.parse(row.expires_at))) return null;
  const created = microsecondsOf(row.created_at);
  if (created === null || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq)) return null;
  return { offerId: id, expiresAt: row.expires_at, created, seq: row.seq };
}

/** The offer's own team — the embedded record must be THAT team, active, and named — with its seats as they stood in the same statement. */
function offerTeam(row: Row): { team: { lifetimeTeamId: string; publicCode: string; name: string }; seats: unknown } | null {
  const embedded = Array.isArray(row.team) ? row.team[0] : row.team;
  if (typeof embedded !== "object" || embedded === null) return null;
  const team = embedded as Row;
  if (!isUuidText(row.lifetime_team_id) || !sameMember(team.lifetime_team_id, row.lifetime_team_id)) return null;
  if (team.status !== "ACTIVE" || !isText(team.public_code) || !isText(team.name)) return null;
  return { team: { lifetimeTeamId: row.lifetime_team_id, publicCode: team.public_code, name: team.name }, seats: team.leaders };
}

/**
 * Who sees a membership offer. A team INVITATION stands only while the leader who made it still leads (the database ends it otherwise): it is INCOMING for the person invited
 * and OUTGOING for that leader — not for the team's other leader. A person's own join REQUEST is OUTGOING for that person (it names nobody: it is addressed to the team) and
 * INCOMING for the team's current captain and sub-captain. Anybody else sees nothing.
 */
function membershipCandidates(me: string, rows: Row[]): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  for (const row of rows) {
    const facts = offerFacts(row, "lifetime_team_membership_id");
    const where = offerTeam(row);
    if (!facts || !where || !isUuidText(row.gaming_member_id) || !isUuidText(row.initiated_by_gaming_member_id)) continue;
    const subject = row.gaming_member_id;
    const initiator = row.initiated_by_gaming_member_id;
    let direction: "INCOMING" | "OUTGOING";
    let counterpartyId: string | null;
    if (row.initiated_by_side === "TEAM") {
      if (sameMember(subject, initiator) || deriveTeamRole(initiator, where.seats) === "MEMBER") continue;
      if (sameMember(subject, me)) { direction = "INCOMING"; counterpartyId = initiator; }
      else if (sameMember(initiator, me)) { direction = "OUTGOING"; counterpartyId = subject; }
      else continue;
    } else if (row.initiated_by_side === "PERSON") {
      if (!sameMember(subject, initiator)) continue; // a request is the person's own act
      if (sameMember(subject, me)) { direction = "OUTGOING"; counterpartyId = null; }
      else if (deriveTeamRole(me, where.seats) !== "MEMBER") { direction = "INCOMING"; counterpartyId = subject; }
      else continue;
    } else continue;
    out.push({ key: `MEMBERSHIP:${facts.offerId.toLowerCase()}`, kind: "MEMBERSHIP", offerId: facts.offerId, direction, team: where.team, counterpartyId, expiresAt: facts.expiresAt, created: facts.created, seq: facts.seq });
  }
  return out;
}

/** Who sees an offer of the sub-captain seat: INCOMING for the person offered it; OUTGOING for the team's active captain who made it; nobody else. */
function seatOfferCandidates(me: string, rows: Row[]): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  for (const row of rows) {
    const facts = offerFacts(row, "lifetime_team_leadership_id");
    const where = offerTeam(row);
    if (!facts || !where || row.role !== "SUB_CAPTAIN" || !isUuidText(row.gaming_member_id) || !isUuidText(row.offered_by_gaming_member_id)) continue;
    const subject = row.gaming_member_id;
    const offeredBy = row.offered_by_gaming_member_id;
    if (sameMember(subject, offeredBy)) continue;
    let direction: "INCOMING" | "OUTGOING";
    let counterpartyId: string;
    if (sameMember(subject, me)) { direction = "INCOMING"; counterpartyId = offeredBy; }
    else if (sameMember(offeredBy, me) && deriveTeamRole(me, where.seats) === "CAPTAIN") { direction = "OUTGOING"; counterpartyId = subject; }
    else continue;
    out.push({ key: `LEADERSHIP:${facts.offerId.toLowerCase()}`, kind: "LEADERSHIP", offerId: facts.offerId, direction, team: where.team, counterpartyId, expiresAt: facts.expiresAt, created: facts.created, seq: facts.seq });
  }
  return out;
}

/** Creation time across both kinds (their tables keep separate sequences), then each table's own creation sequence, then the kind, then the identifier: a total order. */
const byCreation = (a: OfferCandidate, b: OfferCandidate): number => {
  const rank = (c: OfferCandidate) => (c.kind === "MEMBERSHIP" ? 0 : 1);
  const [x, y] = [a.offerId.toLowerCase(), b.offerId.toLowerCase()];
  return a.created - b.created || rank(a) - rank(b) || a.seq - b.seq || (x < y ? -1 : x > y ? 1 : 0);
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-CFM-014 — the entry reads: what each participant may find of their own, and the two lookups that bind an entry or a proposal to its competition.
//
// The same discipline as the offer inbox above: every statement is filtered by the verified member (the organizer's by the addressed competition as well), but the filter is only
// a convenience — the code that follows decides what may be shown from the rows themselves, and a row that is malformed or contradicts itself is dropped: never shown, never
// repaired. Every result is built field by field; no database row leaves this file, and the only columns of a person's profile ever read are the identifier and the display name.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ENTRY_OF_COMPETITION = "competition_team_id, public_code, name, status, entry_flow, created_at, claims:competition_lifetime_roster_claims(status)";
const ENTRY_OF_TEAM = "competition_team_id, competition_id, lifetime_team_id, public_code, name, status, entry_flow, created_at, claims:competition_lifetime_roster_claims(competition_lifetime_roster_claim_id, gaming_member_id, status, expires_at, seq)";
const CLAIM_OF_MEMBER = "competition_lifetime_roster_claim_id, seq, competition_id, gaming_member_id, status, expires_at, entry:competition_teams(competition_team_id, competition_id, lifetime_team_id, status, entry_flow, team:lifetime_teams(lifetime_team_id, public_code, name, status))";
/** CFM-016A — what the roster picker's one statement reads INSIDE a leader's seat: the addressed entry with its proposals, and the team's active members with their display names. */
const TEAM_FOR_ROSTER = "lifetime_team_id, status, competition_teams!inner(competition_team_id, competition_id, lifetime_team_id, entry_flow, status, competition_lifetime_roster_claims(gaming_member_id, status, expires_at)), lifetime_team_memberships(lifetime_team_id, gaming_member_id, status, gaming_members!lifetime_team_memberships_gaming_member_id_fkey(gaming_member_id, display_name))";

const isLiveEntryStatus = (value: unknown): value is LiveEntryStatus => value === "PENDING_ORGANIZER_APPROVAL" || value === "ACCEPTED";
const isOpenClaimStatus = (value: unknown): value is OpenClaimStatus => value === "PROPOSED" || value === "ACCEPTED";
/** One embedded record, whether the relationship came back as an object or as a list of one. */
const embeddedRow = (value: unknown): Row | null => {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "object" && one !== null && !Array.isArray(one) ? (one as Row) : null;
};
/** A statement that asked for ONE row answers a record or nothing: a list is not an answer. */
const plainRow = (value: unknown): Row | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null);
/** Creation order: the instant to the microsecond, then the identifier — the same two statements always give the same order. */
const byCreatedThenId = (a: { created: number; id: string }, b: { created: number; id: string }) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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

  async disableEntryFlow(competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowDisabled> {
    const r = await this.row("disable_lifetime_entry_flow_atomically", { p_competition_id: requireUuid(competitionId), p_organizer_gaming_member_id: requireUuid(organizerGamingMemberId) });
    return { competitionId: str(r.competition_id), disabledAt: strOrNull(r.disabled_at), alreadyDisabled: r.already_disabled === true };
  }

  async decideEntry(
    competitionId: string, competitionTeamId: string, organizerGamingMemberId: string, decision: EntryDecision, reasonCode: EntryDecisionReason | null, note: string | null,
  ): Promise<EntryDecided> {
    // Validated here too (a caller of the store directly gets the same refusal before any call): the decision, the reason from the bounded list, the normalized note.
    const request = parseEntryDecisionRequest(decision, reasonCode, note);
    const r = await this.row("decide_lifetime_competition_entry_atomically", {
      p_competition_id: requireUuid(competitionId), p_competition_team_id: requireUuid(competitionTeamId), p_organizer_gaming_member_id: requireUuid(organizerGamingMemberId),
      p_decision: request.decision, p_reason_code: request.reasonCode, p_note: request.note,
    });
    return {
      competitionTeamId: str(r.competition_team_id), status: r.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED", decision: request.decision, decidedAt: str(r.decided_at),
      releasedClaims: Number(r.released_claims), decisionId: str(r.decision_id),
    };
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
    // ONE statement: the membership and the team's seats — which decide the member's role — come from the same snapshot.
    const { data, error } = await this.client
      .from("lifetime_team_memberships")
      .select(`lifetime_team_id, joined_at, is_legacy, team:lifetime_teams(public_code, name, status, ${SEATS_OF_TEAM})`)
      .eq("gaming_member_id", id).eq("status", "ACTIVE").order("seq");
    if (error) throw translateLifetimeError(error);
    return ((data ?? []) as unknown as Array<Row & { team: Row | Row[] | null }>).flatMap((m) => {
      const team = Array.isArray(m.team) ? m.team[0] : m.team;
      if (!team) return [];
      return [{
        lifetimeTeamId: str(m.lifetime_team_id), publicCode: str(team.public_code), name: str(team.name), status: team.status === "DISBANDED" ? "DISBANDED" as const : "ACTIVE" as const,
        joinedAt: str(m.joined_at), isLegacy: m.is_legacy === true, role: deriveTeamRole(id, team.leaders),
      }];
    });
  }

  async listPendingOffersOfMember(gamingMemberId: string): Promise<PendingOfferView[]> {
    const me = requireUuid(gamingMemberId);
    // The member's seats (whose join requests they may see), the membership offers they are party to, and the seat offers they are party to — each filtered by the member alone.
    const [seats, party, seatOffers] = await Promise.all([
      this.client.from("lifetime_team_leaderships").select(SEAT_ROWS).eq("gaming_member_id", me).eq("status", "ACTIVE"),
      this.client.from("lifetime_team_memberships").select(MEMBERSHIP_OFFER_ROWS).eq("status", "PENDING").or(`gaming_member_id.eq.${me},initiated_by_gaming_member_id.eq.${me}`).order("seq"),
      this.client.from("lifetime_team_leaderships").select(SEAT_OFFER_ROWS).eq("status", "PENDING").or(`gaming_member_id.eq.${me},offered_by_gaming_member_id.eq.${me}`).order("seq"),
    ]);
    for (const answer of [seats, party, seatOffers]) if (answer.error) throw translateLifetimeError(answer.error);
    // A join request is for the team's CURRENT leaders: ask for those of the teams this member currently leads (and only then).
    const led = [...new Set(asRows(seats.data).flatMap((seat) => (activeSeat(seat) !== null && sameMember(seat.gaming_member_id, me) && isUuidText(seat.lifetime_team_id) ? [seat.lifetime_team_id.toLowerCase()] : [])))];
    const requests = led.length === 0 ? null : await this.client.from("lifetime_team_memberships").select(MEMBERSHIP_OFFER_ROWS).eq("status", "PENDING").eq("initiated_by_side", "PERSON").in("lifetime_team_id", led).order("seq");
    if (requests?.error) throw translateLifetimeError(requests.error);

    const candidates = new Map<string, OfferCandidate>();
    for (const candidate of [...membershipCandidates(me, asRows(party.data)), ...membershipCandidates(me, asRows(requests?.data)), ...seatOfferCandidates(me, asRows(seatOffers.data))]) {
      if (!candidates.has(candidate.key)) candidates.set(candidate.key, candidate);
    }

    // The display names of the people these offers involve — only theirs, and only that column.
    const ids = [...new Set([...candidates.values()].flatMap((c) => (c.counterpartyId === null ? [] : [c.counterpartyId.toLowerCase()])))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const found = await this.client.from("gaming_members").select(COUNTERPARTY_ROWS).in("gaming_member_id", ids);
      if (found.error) throw translateLifetimeError(found.error);
      for (const row of asRows(found.data)) if (isUuidText(row.gaming_member_id) && isText(row.display_name)) names.set(row.gaming_member_id.toLowerCase(), row.display_name);
    }

    return [...candidates.values()].sort(byCreation).flatMap((c): PendingOfferView[] => {
      const base = { kind: c.kind, offerId: c.offerId, direction: c.direction, team: { lifetimeTeamId: c.team.lifetimeTeamId, publicCode: c.team.publicCode, name: c.team.name } };
      if (c.counterpartyId === null) return [{ ...base, counterparty: null, expiresAt: c.expiresAt }];
      const displayName = names.get(c.counterpartyId.toLowerCase());
      return displayName === undefined ? [] : [{ ...base, counterparty: { gamingMemberId: c.counterpartyId, displayName }, expiresAt: c.expiresAt }];
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

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // UG-CR-GATE-CFM-014 — binding an entry or a proposal to its competition, and the three reads of the participants
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async getEntryCompetitionId(competitionTeamId: string): Promise<string | null> {
    const id = requireUuid(competitionTeamId);
    const { data, error } = await this.client.from("competition_teams").select("competition_id").eq("competition_team_id", id).eq("entry_flow", "LIFETIME").maybeSingle();
    if (error) throw translateLifetimeError(error);
    const row = plainRow(data);
    return row !== null && isUuidText(row.competition_id) ? row.competition_id : null;
  }

  async getRosterClaimCompetitionId(claimId: string): Promise<string | null> {
    const id = requireUuid(claimId);
    const { data, error } = await this.client.from("competition_lifetime_roster_claims").select("competition_id").eq("competition_lifetime_roster_claim_id", id).maybeSingle();
    if (error) throw translateLifetimeError(error);
    const row = plainRow(data);
    return row !== null && isUuidText(row.competition_id) ? row.competition_id : null;
  }

  async listLiveEntriesForOrganizer(competitionId: string, organizerGamingMemberId: string): Promise<OrganizerEntryView[]> {
    const id = requireUuid(competitionId);
    const organizer = requireUuid(organizerGamingMemberId);
    // ONE statement: the organizer, any revocation of their hosting access and the entries with their places come from the same snapshot.
    const { data, error } = await this.client.from("competitions")
      .select(`competition_id, organizer_gaming_member_id, hosts:competition_host_capabilities(state), entries:competition_teams(${ENTRY_OF_COMPETITION})`)
      .eq("competition_id", id).eq("organizer_gaming_member_id", organizer).maybeSingle();
    if (error) throw translateLifetimeError(error);
    const competition = plainRow(data);
    // Not the organizer — no such competition, a competition somebody else runs, one whose hosting access has been revoked — is ONE refusal: an unknown competition.
    if (competition === null || !sameMember(competition.competition_id, id) || !sameMember(competition.organizer_gaming_member_id, organizer)) throw new CompetitionNotFoundError();
    // The hosting capability is one record or a list of them, whichever way the relationship is read; anything else is not understood, and a revocation that cannot be ruled out is not ignored.
    const hosts = competition.hosts;
    const capabilities = hosts === null ? [] : Array.isArray(hosts) ? hosts : [hosts];
    if (capabilities.some((capability) => typeof capability !== "object" || capability === null || Array.isArray(capability) || typeof (capability as Row).state !== "string")) throw new LifetimeTeamError("UNAVAILABLE");
    if (capabilities.some((capability) => (capability as Row).state === "REVOKED")) throw new CompetitionNotFoundError();

    const entries = asRows(competition.entries).flatMap((entry) => {
      const created = microsecondsOf(entry.created_at);
      if (entry.entry_flow !== "LIFETIME" || !isLiveEntryStatus(entry.status) || !isUuidText(entry.competition_team_id) || !isText(entry.public_code) || !isText(entry.name)) return [];
      if (created === null || typeof entry.created_at !== "string" || !Array.isArray(entry.claims)) return [];
      const claims = asRows(entry.claims);
      return [{
        created, id: entry.competition_team_id.toLowerCase(),
        view: {
          competitionTeamId: entry.competition_team_id, publicCode: entry.public_code, name: entry.name, status: entry.status, createdAt: entry.created_at,
          acceptedPlayers: claims.filter((claim) => claim.status === "ACCEPTED").length, proposedPlayers: claims.filter((claim) => claim.status === "PROPOSED").length,
        } satisfies OrganizerEntryView,
      }];
    });
    return entries.sort(byCreatedThenId).map((entry) => entry.view);
  }

  async listLiveEntriesOfLedTeams(gamingMemberId: string): Promise<LedEntryView[]> {
    const me = requireUuid(gamingMemberId);
    // ONE statement, and it is its own authority. Its rows are the member's CURRENT seats — ACTIVE, captain or sub-captain: the database's own definition of leading a team — and each seat
    // carries, inside it, the live lifetime entries of ITS team with their proposals. Nothing about an entry or a proposal can come back without the seat that authorizes it, read in the same
    // snapshot: a leadership that ended a moment ago answers with no rows at all. There is no earlier lookup whose answer could go stale between asking who leads and reading what they lead.
    const found = await this.client.from("lifetime_team_leaderships")
      .select(`${SEAT_ROWS}, lifetime_teams(lifetime_team_id, competition_teams(${ENTRY_OF_TEAM}))`)
      .eq("gaming_member_id", me).eq("status", "ACTIVE").in("role", ["CAPTAIN", "SUB_CAPTAIN"])
      .eq("lifetime_teams.competition_teams.entry_flow", "LIFETIME").in("lifetime_teams.competition_teams.status", ["PENDING_ORGANIZER_APPROVAL", "ACCEPTED"]);
    if (found.error) throw translateLifetimeError(found.error);

    // The filters are not taken on trust either: an entry is shown only through a seat that is exactly a current one, the member's own, whose embedded team is that very seat's team.
    const shown = new Set<string>();
    const entries = asRows(found.data).flatMap((seat) => {
      const teamId = seat.lifetime_team_id;
      const team = embeddedRow(seat.lifetime_teams);
      if (activeSeat(seat) === null || !sameMember(seat.gaming_member_id, me) || !isUuidText(teamId) || team === null || !sameMember(team.lifetime_team_id, teamId)) return [];
      return asRows(team.competition_teams).flatMap((entry) => {
        const created = microsecondsOf(entry.created_at);
        if (entry.entry_flow !== "LIFETIME" || !isLiveEntryStatus(entry.status) || !isUuidText(entry.competition_team_id) || !isUuidText(entry.competition_id) || !isUuidText(entry.lifetime_team_id)) return [];
        if (!sameMember(entry.lifetime_team_id, teamId) || !isText(entry.public_code) || !isText(entry.name) || created === null || typeof entry.created_at !== "string" || !Array.isArray(entry.claims)) return [];
        if (shown.has(entry.competition_team_id.toLowerCase())) return [];
        shown.add(entry.competition_team_id.toLowerCase());
        const claims = asRows(entry.claims).flatMap((claim) => {
          if (!isUuidText(claim.competition_lifetime_roster_claim_id) || !isUuidText(claim.gaming_member_id) || !isOpenClaimStatus(claim.status)) return [];
          if (!isText(claim.expires_at) || Number.isNaN(Date.parse(claim.expires_at)) || typeof claim.seq !== "number" || !Number.isSafeInteger(claim.seq)) return [];
          return [{ seq: claim.seq, claimId: claim.competition_lifetime_roster_claim_id, gamingMemberId: claim.gaming_member_id, status: claim.status, expiresAt: claim.expires_at }];
        });
        return [{ created, id: entry.competition_team_id.toLowerCase(), entry, claims }];
      });
    }).sort(byCreatedThenId);

    // The display names of the people those proposals name — only theirs, and only that column.
    const ids = [...new Set(entries.flatMap((candidate) => candidate.claims.map((claim) => claim.gamingMemberId.toLowerCase())))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const people = await this.client.from("gaming_members").select(COUNTERPARTY_ROWS).in("gaming_member_id", ids);
      if (people.error) throw translateLifetimeError(people.error);
      for (const row of asRows(people.data)) if (isUuidText(row.gaming_member_id) && isText(row.display_name)) names.set(row.gaming_member_id.toLowerCase(), row.display_name);
    }

    return entries.map(({ entry, claims }): LedEntryView => ({
      competitionTeamId: entry.competition_team_id as string, competitionId: entry.competition_id as string, lifetimeTeamId: entry.lifetime_team_id as string, publicCode: entry.public_code as string,
      name: entry.name as string, status: entry.status as LiveEntryStatus, createdAt: entry.created_at as string,
      // A person without a display name is not shown half-described: the proposal is left out rather than shown nameless.
      claims: claims.sort((a, b) => a.seq - b.seq || (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0)).flatMap((claim) => {
        const displayName = names.get(claim.gamingMemberId.toLowerCase());
        return displayName === undefined ? [] : [{ claimId: claim.claimId, gamingMemberId: claim.gamingMemberId, displayName, status: claim.status, expiresAt: claim.expiresAt }];
      }),
    }));
  }

  async listOpenClaimsOfMember(gamingMemberId: string): Promise<OwnClaimView[]> {
    const me = requireUuid(gamingMemberId);
    // ONE statement: each proposal with its entry and team, from the same snapshot.
    const { data, error } = await this.client.from("competition_lifetime_roster_claims").select(CLAIM_OF_MEMBER).eq("gaming_member_id", me).in("status", ["PROPOSED", "ACCEPTED"]).order("seq");
    if (error) throw translateLifetimeError(error);
    return asRows(data).flatMap((claim) => {
      if (!isUuidText(claim.competition_lifetime_roster_claim_id) || !sameMember(claim.gaming_member_id, me) || !isOpenClaimStatus(claim.status) || !isUuidText(claim.competition_id)) return [];
      if (!isText(claim.expires_at) || Number.isNaN(Date.parse(claim.expires_at)) || typeof claim.seq !== "number" || !Number.isSafeInteger(claim.seq)) return [];
      // The proposal's own entry — live, a lifetime entry, in the proposal's own competition — and that entry's own team, active and named.
      const entry = embeddedRow(claim.entry);
      if (entry === null || entry.entry_flow !== "LIFETIME" || !isLiveEntryStatus(entry.status) || !sameMember(entry.competition_id, claim.competition_id)) return [];
      const team = embeddedRow(entry.team);
      if (team === null || !isUuidText(team.lifetime_team_id) || !sameMember(team.lifetime_team_id, entry.lifetime_team_id) || team.status !== "ACTIVE" || !isText(team.public_code) || !isText(team.name)) return [];
      return [{
        seq: claim.seq, id: claim.competition_lifetime_roster_claim_id,
        view: { claimId: claim.competition_lifetime_roster_claim_id, competitionId: claim.competition_id, status: claim.status, expiresAt: claim.expires_at, team: { lifetimeTeamId: team.lifetime_team_id, publicCode: team.public_code, name: team.name } } satisfies OwnClaimView,
      }];
    }).sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((candidate) => candidate.view);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // UG-CR-GATE-CFM-016A — the join link's lookup and the roster picker's read
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  async findActiveTeamByPublicCode(publicCode: string): Promise<JoinLinkTeam | null> {
    // One exact code, one ACTIVE team, two fields. Nothing about who is on it, and no other way to find it: no pattern, no name.
    const { data, error } = await this.client.from("lifetime_teams").select("lifetime_team_id, public_code, name, status").eq("public_code", publicCode).eq("status", "ACTIVE").maybeSingle();
    if (error) throw translateLifetimeError(error);
    const row = plainRow(data);
    if (row === null || row.public_code !== publicCode || row.status !== "ACTIVE" || !isUuidText(row.lifetime_team_id) || !isText(row.name)) return null;
    return { lifetimeTeamId: row.lifetime_team_id, name: row.name };
  }

  async listRosterCandidatesForLeader(competitionId: string, competitionTeamId: string, leaderGamingMemberId: string): Promise<RosterCandidate[] | null> {
    const competition = requireUuid(competitionId);
    const addressed = requireUuid(competitionTeamId);
    const me = requireUuid(leaderGamingMemberId);
    // ONE statement, and it is its own authority (the CFM-014A discipline). Its rows are the member's CURRENT captain or sub-captain seat on the team whose live entry this is;
    // that team's active members, their display names and the entry's proposals come back only INSIDE that seat, read in the same snapshot. A leadership that ended a moment ago,
    // another team's entry, another competition's and a withdrawn entry answer with no rows at all.
    const found = await this.client.from("lifetime_team_leaderships")
      .select(`${SEAT_ROWS}, lifetime_teams!inner(${TEAM_FOR_ROSTER})`)
      .eq("gaming_member_id", me).eq("status", "ACTIVE").in("role", ["CAPTAIN", "SUB_CAPTAIN"])
      .eq("lifetime_teams.status", "ACTIVE")
      .eq("lifetime_teams.competition_teams.competition_team_id", addressed).eq("lifetime_teams.competition_teams.competition_id", competition)
      .eq("lifetime_teams.competition_teams.entry_flow", "LIFETIME").in("lifetime_teams.competition_teams.status", ["PENDING_ORGANIZER_APPROVAL", "ACCEPTED"])
      .eq("lifetime_teams.lifetime_team_memberships.status", "ACTIVE");
    if (found.error) throw translateLifetimeError(found.error);

    // The filters are not taken on trust: rows are read only through a seat that is exactly a current one, the member's own, whose embedded team is that seat's team.
    const now = Date.now();
    for (const seat of asRows(found.data)) {
      const team = embeddedRow(seat.lifetime_teams);
      if (activeSeat(seat) === null || !sameMember(seat.gaming_member_id, me) || team === null || team.status !== "ACTIVE" || !sameMember(team.lifetime_team_id, seat.lifetime_team_id)) continue;
      const entry = asRows(team.competition_teams).find((e) => sameMember(e.competition_team_id, addressed) && sameMember(e.competition_id, competition)
        && sameMember(e.lifetime_team_id, team.lifetime_team_id) && e.entry_flow === "LIFETIME" && isLiveEntryStatus(e.status));
      if (!entry || !Array.isArray(entry.competition_lifetime_roster_claims) || !Array.isArray(team.lifetime_team_memberships)) continue;
      // A person with an open proposal or an accepted place on THIS entry cannot be proposed again. Their places elsewhere are not looked at: they are not this team's business.
      const taken = new Set(asRows(entry.competition_lifetime_roster_claims)
        .filter((c) => c.status === "ACCEPTED" || (c.status === "PROPOSED" && !(Date.parse(String(c.expires_at)) <= now)))
        .map((c) => String(c.gaming_member_id).toLowerCase()));
      const people = new Map<string, RosterCandidate>();
      for (const membership of asRows(team.lifetime_team_memberships)) {
        const person = embeddedRow(membership.gaming_members);
        if (membership.status !== "ACTIVE" || !sameMember(membership.lifetime_team_id, team.lifetime_team_id) || !isUuidText(membership.gaming_member_id)) continue;
        // A person without a display name cannot be chosen by name, so they are left out rather than shown nameless.
        if (person === null || !sameMember(person.gaming_member_id, membership.gaming_member_id) || !isText(person.display_name)) continue;
        const key = membership.gaming_member_id.toLowerCase();
        if (!taken.has(key)) people.set(key, { gamingMemberId: membership.gaming_member_id, displayName: person.display_name });
      }
      return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "en") || (a.gamingMemberId.toLowerCase() < b.gamingMemberId.toLowerCase() ? -1 : 1));
    }
    return null;
  }
}
