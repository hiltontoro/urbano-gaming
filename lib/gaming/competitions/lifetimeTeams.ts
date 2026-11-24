/**
 * UG-CR-GATE-CFM-001 — Lifetime Teams and Competition Entry foundation (application side).
 *
 * The decisions are the database's: a lifetime team, its dated memberships and leadership, an entry into a competition and a person's own acceptance of a roster
 * place are judged inside atomic operations under fixed lock order, and the tables hold the same rules themselves (see the migration of this gate). This module holds
 * only what the application adds: the typed refusals with their stable codes, the parsing of what a caller sends BEFORE a call is made, the records an operation
 * returns, the store interface, and thin operations that validate and call the store. It reads no clock and decides no rule. It is reachable from server code and
 * tests only: no route or page names it — the two bounded HTTP adapters (the team lifecycle one and the membership and leadership one) are the only modules that stand
 * between it and a route.
 *
 * The database's own words are never passed on: every refusal has a bounded message here.
 */

export const LIFETIME_TEAM_NAME_MIN = 2;
export const LIFETIME_TEAM_NAME_MAX = 60;
export const ROSTER_CLAIM_BATCH_MAX = 32;
export const ENTRY_DECISION_NOTE_MAX = 280;
/** The bounded reasons an organizer gives for rejecting or removing an entry (the database holds the same list in a CHECK). An approval carries none. */
export const ENTRY_DECISION_REASON_CODES = [
  "INELIGIBLE_TEAM", "INCOMPLETE_ENTRY", "DUPLICATE_OR_MISTAKEN_ENTRY", "COMPETITION_CAPACITY", "RULE_VIOLATION", "OTHER_ORGANIZER_DECISION",
] as const;
export type EntryDecisionReason = (typeof ENTRY_DECISION_REASON_CODES)[number];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type LifetimeProblem =
  // teams, membership, leadership
  | "NAME_INVALID" | "NAME_TAKEN" | "PERSON_NOT_FOUND" | "TEAM_NOT_FOUND" | "TEAM_NOT_ACTIVE" | "NOT_A_LEADER" | "NOT_THE_CAPTAIN" | "NOT_A_MEMBER" | "ALREADY_MEMBER"
  | "OFFER_NOT_FOUND" | "OFFER_NOT_PENDING" | "OFFER_EXPIRED" | "OFFER_ALREADY_PENDING" | "OFFER_WRONG_PARTY" | "DECISION_INVALID"
  | "MEMBERSHIP_CAP_REACHED" | "LEADER_CANNOT_JOIN_OTHER_TEAM" | "LEADER_MUST_BELONG_TO_ONE_TEAM" | "LEADER_CANNOT_BE_REMOVED" | "CAPTAIN_NEEDS_SUCCESSOR" | "SUCCESSOR_INVALID"
  | "SEAT_TAKEN" | "SEAT_EMPTY" | "SEAT_SUBJECT_INVALID" | "TEAM_HAS_LIVE_ENTRIES" | "INVARIANT_VIOLATION" | "CONCURRENT_CHANGE" | "REQUEST_NOT_ACCEPTABLE"
  | "ADULT_ATTESTATION_REQUIRED"
  // competition entry, roster claims, the freeze, the backfill
  | "FLOW_NOT_ENABLED" | "FLOW_CONFLICT" | "TEAM_DORMANT" | "ENTRY_NOT_FOUND" | "ENTRY_NOT_LIVE" | "ENTRY_ALREADY_EXISTS" | "ENTRIES_FROZEN"
  | "CLAIM_NOT_FOUND" | "CLAIM_NOT_OPEN" | "CLAIM_EXPIRED" | "CLAIM_ALREADY_OPEN" | "CLAIM_WRONG_PARTY" | "CLAIM_SUBJECT_NOT_MEMBER" | "CLAIM_BATCH_INVALID"
  | "PERSON_ALREADY_CLAIMED" | "PERSON_REPRESENTS_ANOTHER_TEAM" | "ROSTER_FULL"
  | "FREEZE_PLAN_INVALID" | "FREEZE_DEADLINE_NOT_REACHED" | "FREEZE_NOT_ENOUGH_ENTRIES" | "FREEZE_ROSTER_BELOW_MINIMUM" | "FREEZE_ROSTER_ABOVE_MAXIMUM"
  | "BACKFILL_SCOPE_INVALID"
  // UG-CR-GATE-CFM-004: the organizer's decision about an entry, the corrected freeze, and the recovery of an accidentally enabled flow
  | "ENTRY_NOT_PENDING" | "ENTRY_NOT_ACCEPTED" | "ENTRY_CAPTAIN_CHANGED" | "REASON_INVALID" | "NOTE_INVALID" | "FREEZE_PENDING_ENTRIES"
  | "FLOW_RECOVERY_BLOCKED" | "FLOW_RECOVERY_UNSAFE_LEGACY_STATE"
  // never from the database: a malformed request caught here, and anything unexpected
  | "INPUT_INVALID" | "UNAVAILABLE";

/** The database's coded refusals (each is the start of a P0001 message, `CODE: ...`), in the order they are documented. Distinct, prefixed, none contained in another. */
export const LIFETIME_DATABASE_CODES: ReadonlyArray<readonly [string, LifetimeProblem]> = [
  ["LIFETIME_NAME_INVALID", "NAME_INVALID"], ["LIFETIME_NAME_TAKEN", "NAME_TAKEN"], ["LIFETIME_PERSON_NOT_FOUND", "PERSON_NOT_FOUND"],
  ["LIFETIME_TEAM_NOT_FOUND", "TEAM_NOT_FOUND"], ["LIFETIME_TEAM_NOT_ACTIVE", "TEAM_NOT_ACTIVE"], ["LIFETIME_NOT_A_LEADER", "NOT_A_LEADER"],
  ["LIFETIME_NOT_THE_CAPTAIN", "NOT_THE_CAPTAIN"], ["LIFETIME_NOT_A_MEMBER", "NOT_A_MEMBER"], ["LIFETIME_ALREADY_MEMBER", "ALREADY_MEMBER"],
  ["LIFETIME_OFFER_NOT_FOUND", "OFFER_NOT_FOUND"], ["LIFETIME_OFFER_NOT_PENDING", "OFFER_NOT_PENDING"], ["LIFETIME_OFFER_EXPIRED", "OFFER_EXPIRED"],
  ["LIFETIME_OFFER_ALREADY_PENDING", "OFFER_ALREADY_PENDING"], ["LIFETIME_OFFER_WRONG_PARTY", "OFFER_WRONG_PARTY"], ["LIFETIME_DECISION_INVALID", "DECISION_INVALID"],
  ["LIFETIME_MEMBERSHIP_CAP_REACHED", "MEMBERSHIP_CAP_REACHED"], ["LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM", "LEADER_CANNOT_JOIN_OTHER_TEAM"],
  ["LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM", "LEADER_MUST_BELONG_TO_ONE_TEAM"], ["LIFETIME_LEADER_CANNOT_BE_REMOVED", "LEADER_CANNOT_BE_REMOVED"],
  ["LIFETIME_CAPTAIN_NEEDS_SUCCESSOR", "CAPTAIN_NEEDS_SUCCESSOR"], ["LIFETIME_SUCCESSOR_INVALID", "SUCCESSOR_INVALID"], ["LIFETIME_SEAT_TAKEN", "SEAT_TAKEN"],
  ["LIFETIME_SEAT_EMPTY", "SEAT_EMPTY"], ["LIFETIME_SEAT_SUBJECT_INVALID", "SEAT_SUBJECT_INVALID"], ["LIFETIME_TEAM_HAS_LIVE_ENTRIES", "TEAM_HAS_LIVE_ENTRIES"],
  ["LIFETIME_INVARIANT_VIOLATION", "INVARIANT_VIOLATION"], ["LIFETIME_CONCURRENT_CHANGE", "CONCURRENT_CHANGE"], ["LIFETIME_REQUEST_NOT_ACCEPTABLE", "REQUEST_NOT_ACCEPTABLE"],
  ["LIFETIME_ADULT_ATTESTATION_REQUIRED", "ADULT_ATTESTATION_REQUIRED"],
  ["LIFETIME_FLOW_NOT_ENABLED", "FLOW_NOT_ENABLED"], ["LIFETIME_FLOW_CONFLICT", "FLOW_CONFLICT"], ["LIFETIME_TEAM_DORMANT", "TEAM_DORMANT"],
  ["LIFETIME_ENTRY_NOT_FOUND", "ENTRY_NOT_FOUND"], ["LIFETIME_ENTRY_NOT_LIVE", "ENTRY_NOT_LIVE"], ["LIFETIME_ENTRY_ALREADY_EXISTS", "ENTRY_ALREADY_EXISTS"],
  ["LIFETIME_ENTRIES_FROZEN", "ENTRIES_FROZEN"], ["LIFETIME_CLAIM_NOT_FOUND", "CLAIM_NOT_FOUND"], ["LIFETIME_CLAIM_NOT_OPEN", "CLAIM_NOT_OPEN"],
  ["LIFETIME_CLAIM_EXPIRED", "CLAIM_EXPIRED"], ["LIFETIME_CLAIM_ALREADY_OPEN", "CLAIM_ALREADY_OPEN"], ["LIFETIME_CLAIM_WRONG_PARTY", "CLAIM_WRONG_PARTY"],
  ["LIFETIME_CLAIM_SUBJECT_NOT_MEMBER", "CLAIM_SUBJECT_NOT_MEMBER"], ["LIFETIME_CLAIM_BATCH_INVALID", "CLAIM_BATCH_INVALID"],
  ["LIFETIME_PERSON_ALREADY_CLAIMED", "PERSON_ALREADY_CLAIMED"], ["LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM", "PERSON_REPRESENTS_ANOTHER_TEAM"], ["LIFETIME_ROSTER_FULL", "ROSTER_FULL"],
  ["LIFETIME_FREEZE_PLAN_INVALID", "FREEZE_PLAN_INVALID"], ["LIFETIME_FREEZE_DEADLINE_NOT_REACHED", "FREEZE_DEADLINE_NOT_REACHED"],
  ["LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES", "FREEZE_NOT_ENOUGH_ENTRIES"], ["LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM", "FREEZE_ROSTER_BELOW_MINIMUM"],
  ["LIFETIME_FREEZE_ROSTER_ABOVE_MAXIMUM", "FREEZE_ROSTER_ABOVE_MAXIMUM"], ["LIFETIME_BACKFILL_SCOPE_INVALID", "BACKFILL_SCOPE_INVALID"],
  ["LIFETIME_ENTRY_NOT_PENDING", "ENTRY_NOT_PENDING"], ["LIFETIME_ENTRY_NOT_ACCEPTED", "ENTRY_NOT_ACCEPTED"], ["LIFETIME_ENTRY_CAPTAIN_CHANGED", "ENTRY_CAPTAIN_CHANGED"],
  ["LIFETIME_REASON_INVALID", "REASON_INVALID"], ["LIFETIME_NOTE_INVALID", "NOTE_INVALID"], ["LIFETIME_FREEZE_PENDING_ENTRIES", "FREEZE_PENDING_ENTRIES"],
  ["LIFETIME_FLOW_RECOVERY_BLOCKED", "FLOW_RECOVERY_BLOCKED"], ["LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE", "FLOW_RECOVERY_UNSAFE_LEGACY_STATE"],
];

interface RefusalDetail { count?: number; limit?: number }

function messageFor(code: LifetimeProblem, detail: RefusalDetail = {}): string {
  const n = detail.count;
  switch (code) {
    case "NAME_INVALID": return `A team name has ${LIFETIME_TEAM_NAME_MIN} to ${LIFETIME_TEAM_NAME_MAX} characters and no control characters.`;
    case "NAME_TAKEN": return "An active team already has this name.";
    case "PERSON_NOT_FOUND": return "No such member exists.";
    case "TEAM_NOT_FOUND": return "No such team exists.";
    case "TEAM_NOT_ACTIVE": return "This team has been disbanded.";
    case "NOT_A_LEADER": return "Only a captain or sub-captain can do this.";
    case "NOT_THE_CAPTAIN": return "Only the captain can do this.";
    case "NOT_A_MEMBER": return "This person does not belong to the team.";
    case "ALREADY_MEMBER": return "This person already belongs to the team.";
    case "OFFER_NOT_FOUND": return "No such offer exists.";
    case "OFFER_NOT_PENDING": return "This offer has already been answered or withdrawn.";
    case "OFFER_EXPIRED": return "This offer has lapsed. Ask for a new one.";
    case "OFFER_ALREADY_PENDING": return "An offer for this person and team is already waiting for an answer.";
    case "OFFER_WRONG_PARTY": return "Only the other side of an offer can answer it, and only its own side can withdraw it.";
    case "DECISION_INVALID": return "That is not a valid answer to this request.";
    case "MEMBERSHIP_CAP_REACHED": return "A person may belong to at most two teams at once. Leave one first.";
    case "LEADER_CANNOT_JOIN_OTHER_TEAM": return "A captain or sub-captain belongs to one team only.";
    case "LEADER_MUST_BELONG_TO_ONE_TEAM": return "A captain or sub-captain belongs to one team only. Leave your other teams first.";
    case "LEADER_CANNOT_BE_REMOVED": return "A captain or sub-captain leaves only by handing over.";
    case "CAPTAIN_NEEDS_SUCCESSOR": return "A captain who leaves must first have a sub-captain to succeed them.";
    case "SUCCESSOR_INVALID": return "The successor must be the sub-captain.";
    case "SEAT_TAKEN": return "The sub-captain seat is taken or already offered.";
    case "SEAT_EMPTY": return "There is no sub-captain.";
    case "SEAT_SUBJECT_INVALID": return "The captain cannot also hold the sub-captain seat.";
    case "TEAM_HAS_LIVE_ENTRIES": return "Withdraw the team from its competitions before disbanding it.";
    case "INVARIANT_VIOLATION": return "That change is not allowed.";
    case "CONCURRENT_CHANGE": return "Something changed while this was being processed. Try again.";
    case "REQUEST_NOT_ACCEPTABLE": return "This request cannot be accepted.";
    case "ADULT_ATTESTATION_REQUIRED": return "This registration lacks the adult self-attestation.";
    case "FLOW_NOT_ENABLED": return "This competition has not enabled team entries.";
    case "FLOW_CONFLICT": return "This competition already uses the legacy team flow.";
    case "TEAM_DORMANT": return "A team needs at least two members to enter a competition.";
    case "ENTRY_NOT_FOUND": return "No such entry exists.";
    case "ENTRY_NOT_LIVE": return "This entry has been withdrawn.";
    case "ENTRY_ALREADY_EXISTS": return "This team already has a live entry in this competition.";
    case "ENTRIES_FROZEN": return "The entries of this competition are frozen and can no longer change.";
    case "CLAIM_NOT_FOUND": return "No such roster proposal exists.";
    case "CLAIM_NOT_OPEN": return "This roster proposal has already been answered or released.";
    case "CLAIM_EXPIRED": return "This roster proposal has lapsed. Ask the team to propose it again.";
    case "CLAIM_ALREADY_OPEN": return "This person already has an open roster proposal on this entry.";
    case "CLAIM_WRONG_PARTY": return "Only the person named by a roster proposal can answer it.";
    case "CLAIM_SUBJECT_NOT_MEMBER": return "Only an active member of the team can be on its roster.";
    case "CLAIM_BATCH_INVALID": return `Propose between 1 and ${ROSTER_CLAIM_BATCH_MAX} different people at a time.`;
    case "PERSON_ALREADY_CLAIMED": return "This person is already on a team's roster in this competition.";
    case "PERSON_REPRESENTS_ANOTHER_TEAM": return "A person represents only one team in a competition.";
    case "ROSTER_FULL": return "This entry already has the maximum number of players.";
    case "FREEZE_PLAN_INVALID": return "This competition has no usable registration plan.";
    case "FREEZE_DEADLINE_NOT_REACHED": return "The registration deadline has not been reached yet.";
    case "FREEZE_NOT_ENOUGH_ENTRIES": return n === undefined ? "At least two accepted entries are needed." : `At least two accepted entries are needed (found ${n}).`;
    case "FREEZE_ROSTER_BELOW_MINIMUM": return n === undefined || detail.limit === undefined ? "An entry has fewer players than the roster minimum." : `An entry has ${n} accepted player${n === 1 ? "" : "s"}, below the roster minimum of ${detail.limit}.`;
    case "FREEZE_ROSTER_ABOVE_MAXIMUM": return n === undefined || detail.limit === undefined ? "An entry has more players than the roster maximum." : `An entry has ${n} accepted player${n === 1 ? "" : "s"}, above the roster maximum of ${detail.limit}.`;
    case "BACKFILL_SCOPE_INVALID": return "Name at least one competition to backfill.";
    case "ENTRY_NOT_PENDING": return "This entry has already been decided or withdrawn.";
    case "ENTRY_NOT_ACCEPTED": return "Only an accepted entry can be removed.";
    case "ENTRY_CAPTAIN_CHANGED": return "The captain this entry names no longer leads the team. Reject it and let the team enter again.";
    case "REASON_INVALID": return "Choose one of the listed reasons for a rejection or removal; an approval carries none.";
    case "NOTE_INVALID": return `A note has 1 to ${ENTRY_DECISION_NOTE_MAX} characters and no control characters; an approval carries none.`;
    case "FREEZE_PENDING_ENTRIES": return "Decide every pending entry before freezing the entries.";
    case "FLOW_RECOVERY_BLOCKED": return "Team entries can only be switched off before publication and before anything has been entered, decided or frozen.";
    case "FLOW_RECOVERY_UNSAFE_LEGACY_STATE": return "Legacy team data exists for this competition, so team entries cannot be switched off from here.";
    case "INPUT_INVALID": return "That request is not well formed.";
    case "UNAVAILABLE": return "This could not be completed right now. Try again.";
  }
}

/** A lifetime-team refusal. The code is stable and bounded; the message says what to do and carries only counts the database stated. */
export class LifetimeTeamError extends Error {
  readonly code: LifetimeProblem;
  constructor(code: LifetimeProblem, detail: RefusalDetail = {}) {
    super(messageFor(code, detail));
    this.name = "LifetimeTeamError";
    this.code = code;
  }
}

/** The whole numbers a refusal states after its code, in order ("an entry has 3 accepted player(s); the minimum is 5" is [3, 5]). */
function statedNumbers(message: string): number[] {
  const after = message.slice(message.indexOf(":") + 1);
  return (after.match(/\d{1,6}/g) ?? []).map(Number).filter(Number.isSafeInteger);
}

/** The typed error for a coded lifetime refusal, or null when the message does not START with one of this gate's codes. Only the leading code counts. */
export function lifetimeErrorFromDatabase(message: string): LifetimeTeamError | null {
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message);
  if (!match) return null;
  const entry = LIFETIME_DATABASE_CODES.find(([code]) => code === match[1]);
  if (!entry) return null;
  const problem = entry[1];
  const numbers = statedNumbers(message);
  if (problem === "FREEZE_ROSTER_BELOW_MINIMUM" || problem === "FREEZE_ROSTER_ABOVE_MAXIMUM") {
    return new LifetimeTeamError(problem, numbers.length >= 2 ? { count: numbers[0], limit: numbers[1] } : {});
  }
  if (problem === "FREEZE_NOT_ENOUGH_ENTRIES") return new LifetimeTeamError(problem, numbers.length >= 1 ? { count: numbers[0] } : {});
  return new LifetimeTeamError(problem);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Parsing what a caller sends, before any call is made
// ---------------------------------------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed identifier (the shape only: whether it names anything is the database's answer). */
export function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new LifetimeTeamError("INPUT_INVALID");
  return value;
}

/** The name the database will store: whitespace collapsed, 2 to 60 CHARACTERS (code points — exactly what the database's char_length counts), no control characters. */
export function normalizeLifetimeTeamName(raw: unknown): string {
  if (typeof raw !== "string") throw new LifetimeTeamError("NAME_INVALID");
  const name = raw.replace(/\s+/g, " ").trim();
  const length = Array.from(name).length; // not name.length: an emoji is two UTF-16 units but one character
  if (length < LIFETIME_TEAM_NAME_MIN || length > LIFETIME_TEAM_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new LifetimeTeamError("NAME_INVALID");
  return name;
}

export type OfferDecision = "ACCEPT" | "DECLINE";
export type ClaimDecision = "ACCEPT" | "REJECT";
export type OfferKind = "MEMBERSHIP" | "LEADERSHIP";

/** A membership or seat offer is answered ACCEPT or DECLINE. */
export function parseOfferDecision(raw: unknown): OfferDecision {
  if (raw === "ACCEPT" || raw === "DECLINE") return raw;
  throw new LifetimeTeamError("DECISION_INVALID");
}

/** A roster proposal is answered ACCEPT or REJECT. */
export function parseClaimDecision(raw: unknown): ClaimDecision {
  if (raw === "ACCEPT" || raw === "REJECT") return raw;
  throw new LifetimeTeamError("DECISION_INVALID");
}

export function parseOfferKind(raw: unknown): OfferKind {
  if (raw === "MEMBERSHIP" || raw === "LEADERSHIP") return raw;
  throw new LifetimeTeamError("DECISION_INVALID");
}

/** A batch of people to propose for a roster: 1 to 32 different, well-formed identifiers. */
export function parseClaimBatch(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new LifetimeTeamError("CLAIM_BATCH_INVALID");
  const ids = raw.map(requireUuid);
  const unique = new Set(ids.map((id) => id.toLowerCase()));
  if (ids.length === 0 || ids.length > ROSTER_CLAIM_BATCH_MAX || unique.size !== ids.length) throw new LifetimeTeamError("CLAIM_BATCH_INVALID");
  return ids;
}

export type EntryDecision = "APPROVE" | "REJECT" | "REMOVE";

/** An organizer's decision about an entry is APPROVE, REJECT or REMOVE. */
export function parseEntryDecision(raw: unknown): EntryDecision {
  if (raw === "APPROVE" || raw === "REJECT" || raw === "REMOVE") return raw;
  throw new LifetimeTeamError("DECISION_INVALID");
}

/** The note the database will store: whitespace collapsed and trimmed, 1 to 280 CHARACTERS (code points, as char_length counts), no control characters. */
export function normalizeEntryDecisionNote(raw: string): string {
  const note = raw.replace(/\s+/g, " ").trim();
  const length = Array.from(note).length;
  if (length < 1 || length > ENTRY_DECISION_NOTE_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(note)) throw new LifetimeTeamError("NOTE_INVALID");
  return note;
}

/**
 * What an organizer sends with a decision, checked BEFORE a call is made. An approval carries no reason and no note; a rejection or removal carries one reason from the
 * bounded list and, optionally, a short note (an absent note is null — an empty or blank one is refused, never silently dropped).
 */
export function parseEntryDecisionRequest(decision: unknown, reasonCode: unknown, note: unknown): { decision: EntryDecision; reasonCode: EntryDecisionReason | null; note: string | null } {
  const parsed = parseEntryDecision(decision);
  const reasonAbsent = reasonCode === undefined || reasonCode === null;
  const noteAbsent = note === undefined || note === null;
  if (parsed === "APPROVE") {
    if (!reasonAbsent) throw new LifetimeTeamError("REASON_INVALID");
    if (!noteAbsent) throw new LifetimeTeamError("NOTE_INVALID");
    return { decision: parsed, reasonCode: null, note: null };
  }
  if (typeof reasonCode !== "string" || !(ENTRY_DECISION_REASON_CODES as readonly string[]).includes(reasonCode)) throw new LifetimeTeamError("REASON_INVALID");
  if (noteAbsent) return { decision: parsed, reasonCode: reasonCode as EntryDecisionReason, note: null };
  if (typeof note !== "string") throw new LifetimeTeamError("NOTE_INVALID");
  return { decision: parsed, reasonCode: reasonCode as EntryDecisionReason, note: normalizeEntryDecisionNote(note) };
}

/** The scope of a legacy backfill: a non-empty list of competitions. There is no "everything": a missing, null or empty scope is refused. */
export function parseBackfillScope(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new LifetimeTeamError("BACKFILL_SCOPE_INVALID");
  return raw.map(requireUuid);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface LifetimeTeamCreated { lifetimeTeamId: string; publicCode: string; createdAt: string }
export interface LifetimeTeamDisbanded { lifetimeTeamId: string; status: "DISBANDED"; disbandedAt: string }
export interface MembershipOffer { lifetimeTeamMembershipId: string; status: "PENDING"; initiatedBySide: "TEAM" | "PERSON"; expiresAt: string }
export interface MembershipDecision { lifetimeTeamMembershipId: string; status: "ACTIVE" | "ENDED"; joinedAt: string | null }
export interface OfferWithdrawn { offerId: string; status: "ENDED" }
export interface MembershipEnded { lifetimeTeamMembershipId: string; endedAt: string; successorLeadershipId: string | null }
export interface LeadershipOffer { lifetimeTeamLeadershipId: string; status: "PENDING"; expiresAt: string }
export interface LeadershipDecision { lifetimeTeamLeadershipId: string; status: "ACTIVE" | "ENDED"; startedAt: string | null }
export interface LeadershipEnded { lifetimeTeamLeadershipId: string; endedAt: string; endReason: "STEPPED_DOWN" | "REMOVED" }
export interface EntryFlowEnabled { competitionId: string; enabledAt: string; alreadyEnabled: boolean }
export interface EntryCreated { competitionTeamId: string; publicCode: string; createdAt: string }
export interface EntryWithdrawn { competitionTeamId: string; status: "REJECTED"; releasedClaims: number }
export interface EntryDecided { competitionTeamId: string; status: "ACCEPTED" | "REJECTED"; decision: EntryDecision; decidedAt: string; releasedClaims: number; decisionId: string }
/** `disabledAt` is null when nothing was enabled (an exact retry): nothing was written. */
export interface EntryFlowDisabled { competitionId: string; disabledAt: string | null; alreadyDisabled: boolean }
export interface RosterClaimProposed { claimId: string; gamingMemberId: string; status: "PROPOSED"; expiresAt: string }
export interface RosterClaimDecision { claimId: string; status: "ACCEPTED" | "REJECTED"; acceptedAt: string | null }
export interface RosterClaimReleased { claimId: string; status: "WITHDRAWN" | "REMOVED"; releaseReason: string }
export interface EntriesFrozen { competitionId: string; frozenAt: string; entryCount: number; claimCount: number; alreadyFrozen: boolean }
export interface LegacyBackfillResult { teamsCreated: number; membershipsCreated: number; leadershipsCreated: number; skippedAlreadyLinked: number; skippedNotAccepted: number }

export interface LifetimeTeamView {
  lifetimeTeamId: string; publicCode: string; name: string; status: "ACTIVE" | "DISBANDED"; origin: "NEW" | "LEGACY_BACKFILL"; createdAt: string; disbandedAt: string | null;
  leaders: Array<{ role: "CAPTAIN" | "SUB_CAPTAIN"; gamingMemberId: string; startedAt: string }>;
  members: Array<{ gamingMemberId: string; joinedAt: string; isLegacy: boolean }>;
}

/** The member's OWN role on a team (UG-CR-GATE-CFM-012): derived on the server from the member's ACTIVE seat on that team alone — never chosen or claimed by a caller. */
export type TeamRole = "CAPTAIN" | "SUB_CAPTAIN" | "MEMBER";

export interface MemberTeamSummary { lifetimeTeamId: string; publicCode: string; name: string; status: "ACTIVE" | "DISBANDED"; joinedAt: string; isLegacy: boolean; role: TeamRole }

export type OfferDirection = "INCOMING" | "OUTGOING";

/**
 * One pending offer as the member it concerns may see it (UG-CR-GATE-CFM-012): a membership invitation or request, or an offer of the sub-captain seat. The counterparty is
 * only the other person already involved in THAT offer — null when there is none (a person's own join request is addressed to the team, not to anybody in it). Nothing
 * here says whether the offer can still be answered: the decision operations remain the authority on expiry, and `expiresAt` is simply what was stored.
 */
export interface PendingOfferView {
  kind: OfferKind;
  offerId: string;
  direction: OfferDirection;
  team: { lifetimeTeamId: string; publicCode: string; name: string };
  counterparty: { gamingMemberId: string; displayName: string } | null;
  expiresAt: string;
}

export interface LifetimeEntryView {
  competitionTeamId: string; competitionId: string; lifetimeTeamId: string; publicCode: string; name: string; captainGamingMemberId: string; subCaptainGamingMemberId: string | null;
  status: string; createdAt: string;
  claims: Array<{ claimId: string; gamingMemberId: string; status: string; acceptedAt: string | null; departedAt: string | null }>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The store: every operation the database offers, and three bounded reads
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface LifetimeTeamsStore {
  createLifetimeTeam(creatorGamingMemberId: string, name: string): Promise<LifetimeTeamCreated>;
  disbandLifetimeTeam(lifetimeTeamId: string, actorGamingMemberId: string): Promise<LifetimeTeamDisbanded>;
  proposeMembership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<MembershipOffer>;
  decideMembership(membershipId: string, actorGamingMemberId: string, decision: OfferDecision): Promise<MembershipDecision>;
  withdrawOffer(kind: OfferKind, offerId: string, actorGamingMemberId: string): Promise<OfferWithdrawn>;
  endMembership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string, successorGamingMemberId?: string | null): Promise<MembershipEnded>;
  offerLeadership(lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<LeadershipOffer>;
  decideLeadership(leadershipId: string, actorGamingMemberId: string, decision: OfferDecision): Promise<LeadershipDecision>;
  endLeadership(lifetimeTeamId: string, actorGamingMemberId: string): Promise<LeadershipEnded>;
  enableEntryFlow(competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowEnabled>;
  disableEntryFlow(competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowDisabled>;
  decideEntry(competitionId: string, competitionTeamId: string, organizerGamingMemberId: string, decision: EntryDecision, reasonCode: EntryDecisionReason | null, note: string | null): Promise<EntryDecided>;
  enterTeam(competitionId: string, lifetimeTeamId: string, actorGamingMemberId: string): Promise<EntryCreated>;
  withdrawEntry(competitionTeamId: string, actorGamingMemberId: string): Promise<EntryWithdrawn>;
  proposeRosterClaims(competitionTeamId: string, actorGamingMemberId: string, gamingMemberIds: string[]): Promise<RosterClaimProposed[]>;
  decideRosterClaim(claimId: string, actorGamingMemberId: string, decision: ClaimDecision): Promise<RosterClaimDecision>;
  releaseRosterClaim(claimId: string, actorGamingMemberId: string): Promise<RosterClaimReleased>;
  freezeEntries(competitionId: string, organizerGamingMemberId: string): Promise<EntriesFrozen>;
  backfillLegacyTeams(competitionIds: string[]): Promise<LegacyBackfillResult>;
  getLifetimeTeam(lifetimeTeamId: string): Promise<LifetimeTeamView | null>;
  listActiveTeamsOfMember(gamingMemberId: string): Promise<MemberTeamSummary[]>;
  listPendingOffersOfMember(gamingMemberId: string): Promise<PendingOfferView[]>;
  getEntry(competitionTeamId: string): Promise<LifetimeEntryView | null>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Operations: validate, then call the store
// ---------------------------------------------------------------------------------------------------------------------------------------------

export async function createLifetimeTeam(store: LifetimeTeamsStore, creatorGamingMemberId: string, name: unknown): Promise<LifetimeTeamCreated> {
  return store.createLifetimeTeam(requireUuid(creatorGamingMemberId), normalizeLifetimeTeamName(name));
}

export async function disbandLifetimeTeam(store: LifetimeTeamsStore, lifetimeTeamId: string, actorGamingMemberId: string): Promise<LifetimeTeamDisbanded> {
  return store.disbandLifetimeTeam(requireUuid(lifetimeTeamId), requireUuid(actorGamingMemberId));
}

export async function proposeLifetimeMembership(store: LifetimeTeamsStore, lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<MembershipOffer> {
  return store.proposeMembership(requireUuid(lifetimeTeamId), requireUuid(actorGamingMemberId), requireUuid(subjectGamingMemberId));
}

export async function decideLifetimeMembership(store: LifetimeTeamsStore, membershipId: string, actorGamingMemberId: string, decision: unknown): Promise<MembershipDecision> {
  const parsed = parseOfferDecision(decision);
  return store.decideMembership(requireUuid(membershipId), requireUuid(actorGamingMemberId), parsed);
}

export async function withdrawLifetimeOffer(store: LifetimeTeamsStore, kind: unknown, offerId: string, actorGamingMemberId: string): Promise<OfferWithdrawn> {
  const parsed = parseOfferKind(kind);
  return store.withdrawOffer(parsed, requireUuid(offerId), requireUuid(actorGamingMemberId));
}

/** A person leaves, or a leader removes an ordinary member. A captain leaves only by being succeeded by the sub-captain (named explicitly or by default). */
export async function endLifetimeMembership(
  store: LifetimeTeamsStore, lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string, successorGamingMemberId?: string | null,
): Promise<MembershipEnded> {
  const team = requireUuid(lifetimeTeamId);
  const actor = requireUuid(actorGamingMemberId);
  const subject = requireUuid(subjectGamingMemberId);
  const successor = successorGamingMemberId === undefined || successorGamingMemberId === null ? null : requireUuid(successorGamingMemberId);
  return store.endMembership(team, actor, subject, successor);
}

export async function offerLifetimeLeadership(store: LifetimeTeamsStore, lifetimeTeamId: string, actorGamingMemberId: string, subjectGamingMemberId: string): Promise<LeadershipOffer> {
  return store.offerLeadership(requireUuid(lifetimeTeamId), requireUuid(actorGamingMemberId), requireUuid(subjectGamingMemberId));
}

export async function decideLifetimeLeadership(store: LifetimeTeamsStore, leadershipId: string, actorGamingMemberId: string, decision: unknown): Promise<LeadershipDecision> {
  const parsed = parseOfferDecision(decision);
  return store.decideLeadership(requireUuid(leadershipId), requireUuid(actorGamingMemberId), parsed);
}

export async function endLifetimeLeadership(store: LifetimeTeamsStore, lifetimeTeamId: string, actorGamingMemberId: string): Promise<LeadershipEnded> {
  return store.endLeadership(requireUuid(lifetimeTeamId), requireUuid(actorGamingMemberId));
}

/**
 * The pending offers that concern the verified member — and nobody else's (UG-CR-GATE-CFM-012). The member is the ONLY input: there is no selector, filter or second
 * identity to give, so nothing a caller sends can name another member, a team or an offer.
 */
export async function listPendingLifetimeOffers(store: LifetimeTeamsStore, gamingMemberId: string): Promise<PendingOfferView[]> {
  return store.listPendingOffersOfMember(requireUuid(gamingMemberId));
}

export async function enableLifetimeEntryFlow(store: LifetimeTeamsStore, competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowEnabled> {
  return store.enableEntryFlow(requireUuid(competitionId), requireUuid(organizerGamingMemberId));
}

/**
 * Switches an accidentally enabled lifetime flow off. The database allows it only when the flow produced nothing (no entry, claim, decision or freeze, nothing legacy, the
 * competition not yet published) and leaves a dated audit event; otherwise it refuses and deletes nothing.
 */
export async function disableLifetimeEntryFlow(store: LifetimeTeamsStore, competitionId: string, organizerGamingMemberId: string): Promise<EntryFlowDisabled> {
  return store.disableEntryFlow(requireUuid(competitionId), requireUuid(organizerGamingMemberId));
}

/** The organizer approves, rejects or removes an entry. Approval never accepts a roster claim; a rejection or removal needs a reason from the bounded list. */
export async function decideLifetimeEntry(
  store: LifetimeTeamsStore, competitionId: string, competitionTeamId: string, organizerGamingMemberId: string, decision: unknown, reasonCode?: unknown, note?: unknown,
): Promise<EntryDecided> {
  const competition = requireUuid(competitionId);
  const entry = requireUuid(competitionTeamId);
  const organizer = requireUuid(organizerGamingMemberId);
  const request = parseEntryDecisionRequest(decision, reasonCode, note);
  return store.decideEntry(competition, entry, organizer, request.decision, request.reasonCode, request.note);
}

export async function enterLifetimeTeam(store: LifetimeTeamsStore, competitionId: string, lifetimeTeamId: string, actorGamingMemberId: string): Promise<EntryCreated> {
  return store.enterTeam(requireUuid(competitionId), requireUuid(lifetimeTeamId), requireUuid(actorGamingMemberId));
}

export async function withdrawLifetimeEntry(store: LifetimeTeamsStore, competitionTeamId: string, actorGamingMemberId: string): Promise<EntryWithdrawn> {
  return store.withdrawEntry(requireUuid(competitionTeamId), requireUuid(actorGamingMemberId));
}

/** A leader proposes people for an entry. A proposal claims nobody: the person's own acceptance does. */
export async function proposeRosterClaims(store: LifetimeTeamsStore, competitionTeamId: string, actorGamingMemberId: string, gamingMemberIds: unknown): Promise<RosterClaimProposed[]> {
  const entry = requireUuid(competitionTeamId);
  const actor = requireUuid(actorGamingMemberId);
  return store.proposeRosterClaims(entry, actor, parseClaimBatch(gamingMemberIds));
}

export async function decideRosterClaim(store: LifetimeTeamsStore, claimId: string, actorGamingMemberId: string, decision: unknown): Promise<RosterClaimDecision> {
  const parsed = parseClaimDecision(decision);
  return store.decideRosterClaim(requireUuid(claimId), requireUuid(actorGamingMemberId), parsed);
}

export async function releaseRosterClaim(store: LifetimeTeamsStore, claimId: string, actorGamingMemberId: string): Promise<RosterClaimReleased> {
  return store.releaseRosterClaim(requireUuid(claimId), requireUuid(actorGamingMemberId));
}

export async function freezeLifetimeEntries(store: LifetimeTeamsStore, competitionId: string, organizerGamingMemberId: string): Promise<EntriesFrozen> {
  return store.freezeEntries(requireUuid(competitionId), requireUuid(organizerGamingMemberId));
}

/** The explicit legacy backfill of the NAMED competitions (there is no "all"). It is never run by a migration or a route. */
export async function backfillLegacyTeams(store: LifetimeTeamsStore, competitionIds: unknown): Promise<LegacyBackfillResult> {
  return store.backfillLegacyTeams(parseBackfillScope(competitionIds));
}
