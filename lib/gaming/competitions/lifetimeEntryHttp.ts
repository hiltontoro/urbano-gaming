import { NextResponse } from "next/server";

import { getSupabaseCredentials, requireCompetitionsSchemaReady, requireGamingMember } from "./httpAuth";
import { SupabaseLifetimeTeamsRepository } from "./db/supabaseLifetimeTeamsRepository";
import {
  LifetimeTeamError, decideLifetimeEntry, decideRosterClaimIn, disableLifetimeEntryFlow, enableLifetimeEntryFlow, enterLifetimeTeam, freezeLifetimeEntries,
  listLifetimeEntriesForOrganizer, listLifetimeEntriesOfMyTeams, listMyOpenRosterClaims, parseClaimBatch, parseClaimDecision, parseEntryDecisionRequest,
  proposeRosterClaimsIn, releaseRosterClaimIn, requireUuid, withdrawLifetimeEntryIn, type LifetimeProblem,
} from "./lifetimeTeams";
import {
  AlreadyCaptainOrMemberError, CompetitionAccessDeniedError, CompetitionCancelledError, CompetitionNotFoundError, CompetitionRegistrationRequiredError, DuplicateTeamNameError,
  HostAccessRevokedError, TeamRegistrationNotOpenError,
} from "./types";

/**
 * UG-CR-GATE-CFM-014 — the ONE bounded HTTP adapter between a competition's lifetime-team entry operations and a route.
 *
 * Nine operations and three reads, and nothing else. The organizer of a competition enables its team-entry flow (or, while nothing has come of it, switches it off again),
 * decides an entry (approve, reject or remove) and freezes the entries; a leader of a team enters it, withdraws its entry and proposes people for the entry's roster; a person
 * answers a proposal that names them, and the person or a leader releases one. The reads are the organizer's live entries of the competition they run, a leader's live entries of
 * the team they lead, and a person's own open proposals — each derived from the verified Gaming Member, so that nobody has to be handed an identifier by somebody else. (The
 * teams themselves, their members and their seats have adapters of their own; the legacy backfill has none and no route; no lookup of an entry, a proposal or a person by
 * identifier exists here.) Each handler runs the same sequence, in this order and no other:
 *
 *   1. the Competitions availability guard (before credentials, authentication, parsing or any repository);
 *   2. the server credentials;
 *   3. the verified Gaming Member — the ONLY source of the actor: no body, query, header or path value ever names one;
 *   4. the addressed ids, then the body (exactly the fields the route names, and valid ones) — a body is never read for an id that cannot name anything;
 *   5. only then the lifetime repository, built once, for this request;
 *   6. the existing domain operation, with the session member as the actor. An operation that addresses an entry or a proposal through a competition first makes sure the
 *      competition named is the one the entry or proposal belongs to; the organizer's operations name the competition to the database itself.
 *
 * What a caller may name is the team to enter, the people to propose, an answer, a decision with its reason, and — in the path — the competition, the entry and the proposal
 * they address. Never the actor, an authority, a status, a timestamp or the role that results: the database decides who may do what, and these routes only carry its answer. An
 * organizer's approval never accepts a roster place: only the person a proposal names can.
 *
 * Every response — success, refusal, failure, the guard's 503 and authentication's 401 — carries `Cache-Control: no-store, max-age=0`. Every body is a copy of explicitly named
 * fields or `{ "error": <one bounded sentence> }`: no database text, no internal code, no stack, no identifier the caller did not already hold, no contact detail.
 *
 * Statuses: 400 the request itself is wrong (not JSON, not exactly the named fields, a malformed id, an unknown decision, reason or batch) · 401 not signed in · 404 the addressed
 * competition, team, entry or proposal is unknown OR the caller has no standing to it — one and the same answer per route, so that nothing says whether it exists, whose it is or
 * whether an organizer's access was revoked · 409 the state of the world conflicts with the request · 500 anything unmapped or unexpected · 503 the availability guard. A refusal
 * that belongs to another operation is not classified here (that would be inventing policy): it fails closed as the generic 500.
 */

const NO_STORE = "no-store, max-age=0";

function respond(body: unknown, status: number): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/** The two responses another helper builds (the availability 503 and authentication's 401) get the same header the rest carry. */
function uncached<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE);
  return response;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The centralized mapping: a refusal → a status and one bounded sentence
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** What an addressed route says when the thing is unknown or is not the caller's to know about: the same words whichever of the two it was. */
const COMPETITION_NOT_FOUND = "That competition could not be found.";
const TEAM_NOT_FOUND = "That team could not be found.";
const ENTRY_NOT_FOUND = "That entry could not be found.";
const CLAIM_NOT_FOUND = "That roster proposal could not be found.";
/** A person who names their own PROPOSAL to release it has standing — it is a conflict, not a stranger: a proposal is answered, and only an accepted place is withdrawn. */
const PROPOSAL_IS_ANSWERED = "A roster proposal is answered with a decision; only an accepted place is withdrawn.";

interface Target {
  /** The sentence of this route's 404 for the competition it addresses: unknown, somebody else's, or an organizer whose hosting access was revoked — one and the same. */
  competition?: string;
  /** … for the team the body names. */
  team?: string;
  /** … for the entry the path addresses. */
  entry?: string;
  /** … for the proposal the path addresses. */
  claim?: string;
  /** … for a caller who does not lead the team the operation acts on ("who are you to this?"): the sentence of the thing addressed. Only where the operation can raise it. */
  leader?: string;
  /** … for a caller who is not the person the proposal names. Only where the operation can raise it. */
  wrongParty?: string;
  /** On this route the person a proposal names is the caller: their own PROPOSAL is a conflict they have standing for (they answer it), not a refusal of standing. */
  wrongPartyConflicts?: boolean;
}

const OF_COMPETITION: Target = { competition: COMPETITION_NOT_FOUND };
const OF_COMPETITION_AND_ENTRY: Target = { competition: COMPETITION_NOT_FOUND, entry: ENTRY_NOT_FOUND };
const ENTER: Target = { competition: COMPETITION_NOT_FOUND, team: TEAM_NOT_FOUND, leader: TEAM_NOT_FOUND };
const OF_ENTRY: Target = { entry: ENTRY_NOT_FOUND, leader: ENTRY_NOT_FOUND };
const ANSWER_PROPOSAL: Target = { claim: CLAIM_NOT_FOUND, wrongParty: CLAIM_NOT_FOUND };
const RELEASE_PROPOSAL: Target = { claim: CLAIM_NOT_FOUND, leader: CLAIM_NOT_FOUND, wrongPartyConflicts: true };
const NOTHING_ADDRESSED: Target = {};

/** The request itself is wrong. */
const BAD_REQUEST = new Set<LifetimeProblem>(["INPUT_INVALID", "DECISION_INVALID", "CLAIM_BATCH_INVALID", "REASON_INVALID", "NOTE_INVALID"]);

/**
 * The state of the world conflicts with the request: the flow is off, on, or blocked from being switched off; the team is dormant, disbanded or already entered; an entry
 * that was decided, withdrawn or frozen; a proposal answered, lapsed or already open; a person already placed or on another team's roster; a full roster; every refusal of the
 * freeze; a change that raced another. Each keeps the foundation's own bounded sentence.
 */
const CONFLICT = new Set<LifetimeProblem>([
  "TEAM_NOT_ACTIVE", "TEAM_DORMANT", "FLOW_NOT_ENABLED", "FLOW_CONFLICT", "FLOW_RECOVERY_BLOCKED", "FLOW_RECOVERY_UNSAFE_LEGACY_STATE", "ENTRY_NOT_LIVE", "ENTRY_ALREADY_EXISTS",
  "ENTRIES_FROZEN", "ENTRY_NOT_PENDING", "ENTRY_NOT_ACCEPTED", "ENTRY_CAPTAIN_CHANGED", "CLAIM_NOT_OPEN", "CLAIM_EXPIRED", "CLAIM_ALREADY_OPEN", "CLAIM_SUBJECT_NOT_MEMBER",
  "PERSON_ALREADY_CLAIMED", "PERSON_REPRESENTS_ANOTHER_TEAM", "ROSTER_FULL", "ADULT_ATTESTATION_REQUIRED", "FREEZE_PLAN_INVALID", "FREEZE_DEADLINE_NOT_REACHED", "FREEZE_PENDING_ENTRIES",
  "FREEZE_NOT_ENOUGH_ENTRIES", "FREEZE_ROSTER_BELOW_MINIMUM", "FREEZE_ROSTER_ABOVE_MAXIMUM", "INVARIANT_VIOLATION", "CONCURRENT_CHANGE",
]);
/** The three refusals of the freeze that state a count the organizer needs ("found 1", "has 3 players, below 5"): the foundation's own sentence carries those whole numbers and nothing else. */
const STATES_A_COUNT = new Set<LifetimeProblem>(["FREEZE_NOT_ENOUGH_ENTRIES", "FREEZE_ROSTER_BELOW_MINIMUM", "FREEZE_ROSTER_ABOVE_MAXIMUM"]);

/** The refusals the competitions repository already knows that these operations can raise, each with this adapter's own sentence (the database's words are never passed on). */
function sharedConflict(err: unknown): string | null {
  if (err instanceof CompetitionCancelledError) return "This competition has been cancelled.";
  if (err instanceof TeamRegistrationNotOpenError) return "Team registration is not open for this competition.";
  if (err instanceof CompetitionRegistrationRequiredError) return "Register for this competition first.";
  if (err instanceof DuplicateTeamNameError) return "A team with this name has already entered this competition.";
  if (err instanceof AlreadyCaptainOrMemberError) return "This person already holds a team role in this competition.";
  return null;
}

const GENERIC_FAILURE = new LifetimeTeamError("UNAVAILABLE").message;
/** The sentence of a refusal, built from its code alone: nothing the refusal itself carries can reach a caller. */
const bounded = (code: LifetimeProblem) => new LifetimeTeamError(code).message;

/** A bounded word for the server log: a refusal's code or an error's class name — never a message, a code a database wrote, or anything a caller controls. */
function logToken(err: unknown): string {
  const word = err instanceof LifetimeTeamError ? err.code : (err as { name?: unknown } | null | undefined)?.name;
  return typeof word === "string" && /^[A-Za-z0-9_]{1,40}$/.test(word) ? word : "unknown";
}

function unavailable(operation: string, err: unknown): Response {
  console.error(`GAMING_TEAM_ENTRY_HTTP ${operation} failed:`, logToken(err));
  return respond({ error: GENERIC_FAILURE }, 500);
}

/** The sentence of a "not found" refusal on this route, or null when the refusal is not one of them here (it then fails closed). */
function notFoundSentence(code: LifetimeProblem, target: Target): string | null {
  switch (code) {
    case "TEAM_NOT_FOUND": return target.team ?? null;
    case "ENTRY_NOT_FOUND": return target.entry ?? null;
    case "CLAIM_NOT_FOUND": return target.claim ?? null;
    case "NOT_A_LEADER": return target.leader ?? null;
    case "CLAIM_WRONG_PARTY": return target.wrongParty ?? null;
    default: return null;
  }
}

/** A refusal becomes its mapped status; everything else — an unmapped problem, a refusal of another operation, a raw failure, a non-error — is the generic 500. */
function refused(operation: string, err: unknown, target: Target): Response {
  // An unknown competition, somebody else's, and an organizer whose hosting access was revoked: the same 404 — nothing says which, and nothing says that access was revoked.
  if (err instanceof CompetitionNotFoundError || err instanceof CompetitionAccessDeniedError || err instanceof HostAccessRevokedError) {
    return target.competition === undefined ? unavailable(operation, err) : respond({ error: target.competition }, 404);
  }
  const shared = sharedConflict(err);
  if (shared !== null) return respond({ error: shared }, 409);
  if (err instanceof LifetimeTeamError) {
    const code = err.code;
    const missing = notFoundSentence(code, target);
    if (missing !== null) return respond({ error: missing }, 404);
    if (BAD_REQUEST.has(code)) return respond({ error: bounded(code) }, 400);
    if (code === "CLAIM_WRONG_PARTY" && target.wrongPartyConflicts) return respond({ error: PROPOSAL_IS_ANSWERED }, 409);
    if (CONFLICT.has(code)) return respond({ error: STATES_A_COUNT.has(code) ? err.message : bounded(code) }, 409);
  }
  return unavailable(operation, err);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The shared start of every request, and the exact body
// ---------------------------------------------------------------------------------------------------------------------------------------------

type Credentials = { url: string; serviceKey: string };
type Opened = { response: Response } | { credentials: Credentials; gamingMemberId: string };

async function open(request: Request): Promise<Opened> {
  const closed = requireCompetitionsSchemaReady();
  if (closed) return { response: uncached(closed) };
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    console.error("GAMING_TEAM_ENTRY_HTTP configuration failed: server credentials are not set");
    return { response: respond({ error: GENERIC_FAILURE }, 500) };
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return { response: uncached(auth.errorResponse) };
  return { credentials, gamingMemberId: auth.gamingMemberId };
}

const repositoryFor = (credentials: Credentials) => new SupabaseLifetimeTeamsRepository(credentials.url, credentials.serviceKey);

const INVALID_JSON = "Request body must be valid JSON.";
const ENTER_BODY = { shapes: [["lifetimeTeamId"]], sentence: "Request body must be exactly one field, lifetimeTeamId, holding the team's id." } as const;
const ENTRY_DECISION_BODY = { shapes: [["decision"], ["decision", "reasonCode"], ["decision", "reasonCode", "note"]], sentence: "Request body must be decision, with reasonCode (and optionally note) for a rejection or removal." } as const;
const PROPOSE_BODY = { shapes: [["gamingMemberIds"]], sentence: "Request body must be exactly one field, gamingMemberIds, holding the ids of the people to propose." } as const;
const CLAIM_DECISION_BODY = { shapes: [["decision"]], sentence: "Request body must be exactly one field, decision, holding ACCEPT or REJECT." } as const;

/**
 * The body is a JSON object whose keys are EXACTLY one of the shapes the route names: a missing field, a second field of any kind, an array, a primitive — all refused
 * before a repository exists. The values are checked by the caller of this function (an identifier, a decision, a batch), one by one.
 */
async function readBody(request: Request, rule: { shapes: ReadonlyArray<readonly string[]>; sentence: string }): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { response: respond({ error: INVALID_JSON }, 400) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { response: respond({ error: rule.sentence }, 400) };
  const keys = Object.keys(parsed).sort();
  const exact = rule.shapes.some((shape) => shape.length === keys.length && [...shape].sort().every((key, index) => key === keys[index]));
  if (!exact) return { response: respond({ error: rule.sentence }, 400) };
  return { body: parsed as Record<string, unknown> };
}

/** The one sequence every handler runs: the availability guard, credentials and authentication (`open`), then the operation, with every refusal and failure mapped once. */
async function run(operation: string, target: Target, request: Request, act: (credentials: Credentials, actor: string) => Promise<Response>): Promise<Response> {
  try {
    const opened = await open(request);
    if ("response" in opened) return opened.response;
    return await act(opened.credentials, opened.gamingMemberId);
  } catch (err) {
    return refused(operation, err, target);
  }
}

/**
 * A read has no refusal of its own beyond a malformed id and — for the organizer's — a competition that is unknown to the caller: every other failure of it, whatever its class, is
 * the one generic 500. (A read is never a conflict.)
 */
function failedRead(operation: string, err: unknown, target: Target): Response {
  if (err instanceof LifetimeTeamError && err.code === "INPUT_INVALID") return respond({ error: bounded("INPUT_INVALID") }, 400);
  if (target.competition !== undefined && (err instanceof CompetitionNotFoundError || err instanceof CompetitionAccessDeniedError || err instanceof HostAccessRevokedError)) {
    return respond({ error: target.competition }, 404);
  }
  return unavailable(operation, err);
}

/** The sequence of a read: the same start as every other handler, then the read, with its failures mapped by `failedRead`. */
async function readRun(operation: string, target: Target, request: Request, act: (credentials: Credentials, actor: string) => Promise<Response>): Promise<Response> {
  try {
    const opened = await open(request);
    if ("response" in opened) return opened.response;
    return await act(opened.credentials, opened.gamingMemberId);
  } catch (err) {
    return failedRead(operation, err, target);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The organizer: the flow, the entries, the freeze
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** POST — the competition's organizer enables team entries for the addressed competition. An exact retry answers the enablement that exists. No request body is read. */
export async function handleEnableEntryFlow(request: Request, competitionId: unknown): Promise<Response> {
  return run("enable-entry-flow", OF_COMPETITION, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const enabled = await enableLifetimeEntryFlow(repositoryFor(credentials), competition, actor);
    return respond({ flow: { competitionId: enabled.competitionId, enabledAt: enabled.enabledAt, alreadyEnabled: enabled.alreadyEnabled } }, 200);
  });
}

/** POST — the organizer switches team entries off again. The database allows it only while the flow has produced nothing; otherwise it refuses and deletes nothing. No request body is read. */
export async function handleDisableEntryFlow(request: Request, competitionId: unknown): Promise<Response> {
  return run("disable-entry-flow", OF_COMPETITION, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const disabled = await disableLifetimeEntryFlow(repositoryFor(credentials), competition, actor);
    return respond({ flow: { competitionId: disabled.competitionId, disabledAt: disabled.disabledAt, alreadyDisabled: disabled.alreadyDisabled } }, 200);
  });
}

/** POST — the organizer approves, rejects or removes the addressed entry of the addressed competition. An approval accepts no roster place. */
export async function handleDecideEntry(request: Request, competitionId: unknown, competitionTeamId: unknown): Promise<Response> {
  return run("decide-entry", OF_COMPETITION_AND_ENTRY, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const entry = requireUuid(competitionTeamId);
    const read = await readBody(request, ENTRY_DECISION_BODY);
    if ("response" in read) return read.response;
    const { decision, reasonCode, note } = parseEntryDecisionRequest(read.body.decision, read.body.reasonCode, read.body.note);
    const decided = await decideLifetimeEntry(repositoryFor(credentials), competition, entry, actor, decision, reasonCode, note);
    return respond({ entry: { competitionTeamId: decided.competitionTeamId, status: decided.status, decision: decided.decision, decidedAt: decided.decidedAt, releasedClaims: decided.releasedClaims } }, 200);
  });
}

/** POST — the organizer freezes the entries of the addressed competition: a checkpoint that changes no competition state. An exact retry answers the freeze that exists. No request body is read. */
export async function handleFreezeEntries(request: Request, competitionId: unknown): Promise<Response> {
  return run("freeze-entries", OF_COMPETITION, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const frozen = await freezeLifetimeEntries(repositoryFor(credentials), competition, actor);
    return respond({ freeze: { competitionId: frozen.competitionId, frozenAt: frozen.frozenAt, entryCount: frozen.entryCount, claimCount: frozen.claimCount, alreadyFrozen: frozen.alreadyFrozen } }, 200);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A leader: the entry and its roster proposals
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** POST — a leader enters their team in the addressed competition. The body is exactly {"lifetimeTeamId": "..."}; the actor is always the verified caller. */
export async function handleEnterTeam(request: Request, competitionId: unknown): Promise<Response> {
  return run("enter-team", ENTER, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const read = await readBody(request, ENTER_BODY);
    if ("response" in read) return read.response;
    const team = requireUuid(read.body.lifetimeTeamId);
    const entry = await enterLifetimeTeam(repositoryFor(credentials), competition, team, actor);
    return respond({ entry: { competitionTeamId: entry.competitionTeamId, publicCode: entry.publicCode, createdAt: entry.createdAt } }, 201);
  });
}

/** POST — a leader withdraws their team's entry — the entry addressed, in the competition addressed. No request body is read. */
export async function handleWithdrawEntry(request: Request, competitionId: unknown, competitionTeamId: unknown): Promise<Response> {
  return run("withdraw-entry", OF_ENTRY, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const entry = requireUuid(competitionTeamId);
    const withdrawn = await withdrawLifetimeEntryIn(repositoryFor(credentials), competition, entry, actor);
    return respond({ entry: { competitionTeamId: withdrawn.competitionTeamId, status: withdrawn.status, releasedClaims: withdrawn.releasedClaims } }, 200);
  });
}

/** POST — a leader proposes 1 to 32 different members of their team for the addressed entry. A proposal claims nobody: the person's own acceptance does. */
export async function handleProposeRosterClaims(request: Request, competitionId: unknown, competitionTeamId: unknown): Promise<Response> {
  return run("propose-roster-claims", OF_ENTRY, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const entry = requireUuid(competitionTeamId);
    const read = await readBody(request, PROPOSE_BODY);
    if ("response" in read) return read.response;
    const people = parseClaimBatch(read.body.gamingMemberIds);
    const proposed = await proposeRosterClaimsIn(repositoryFor(credentials), competition, entry, actor, people);
    return respond({ claims: proposed.map((claim) => ({ claimId: claim.claimId, gamingMemberId: claim.gamingMemberId, status: claim.status, expiresAt: claim.expiresAt })) }, 201);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A person: the answer to a proposal, and its release
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** POST — the person a proposal names accepts or rejects it. Nobody else can: neither the proposing team nor the organizer. */
export async function handleDecideRosterClaim(request: Request, competitionId: unknown, claimId: unknown): Promise<Response> {
  return run("decide-roster-claim", ANSWER_PROPOSAL, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const claim = requireUuid(claimId);
    const read = await readBody(request, CLAIM_DECISION_BODY);
    if ("response" in read) return read.response;
    const decision = parseClaimDecision(read.body.decision);
    const answered = await decideRosterClaimIn(repositoryFor(credentials), competition, claim, actor, decision);
    return respond({ claim: { claimId: answered.claimId, status: answered.status, acceptedAt: answered.acceptedAt } }, 200);
  });
}

/** POST — the person withdraws their accepted place, or a leader of the team withdraws a proposal or removes a place. No request body is read. */
export async function handleReleaseRosterClaim(request: Request, competitionId: unknown, claimId: unknown): Promise<Response> {
  return run("release-roster-claim", RELEASE_PROPOSAL, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const claim = requireUuid(claimId);
    const released = await releaseRosterClaimIn(repositoryFor(credentials), competition, claim, actor);
    return respond({ claim: { claimId: released.claimId, status: released.status } }, 200);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The reads: what each participant may find of their own
// ---------------------------------------------------------------------------------------------------------------------------------------------

const isUuid = (value: unknown): value is string => {
  try { requireUuid(value); return true; } catch { return false; }
};
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isLiveStatus = (value: unknown): value is "PENDING_ORGANIZER_APPROVAL" | "ACCEPTED" => value === "PENDING_ORGANIZER_APPROVAL" || value === "ACCEPTED";
const isOpenStatus = (value: unknown): value is "PROPOSED" | "ACCEPTED" => value === "PROPOSED" || value === "ACCEPTED";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The organizer's entries, copied field by field in the repository's order. An entry that is malformed in any field is dropped: never shown, never repaired. */
function organizerEntries(rows: unknown) {
  if (!Array.isArray(rows)) throw new LifetimeTeamError("UNAVAILABLE");
  const entries: Array<{ competitionTeamId: string; publicCode: string; name: string; status: "PENDING_ORGANIZER_APPROVAL" | "ACCEPTED"; createdAt: string; acceptedPlayers: number; proposedPlayers: number }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { competitionTeamId, publicCode, name, status, createdAt, acceptedPlayers, proposedPlayers } = row;
    if (!isUuid(competitionTeamId) || !isText(publicCode) || !isText(name) || !isLiveStatus(status) || !isTimestamp(createdAt) || !isCount(acceptedPlayers) || !isCount(proposedPlayers)) continue;
    entries.push({ competitionTeamId, publicCode, name, status, createdAt, acceptedPlayers, proposedPlayers });
  }
  return entries;
}

/** A leader's entries with the proposals on them. An entry or a proposal that is malformed in any field is dropped; a person is never shown without a name. */
function ledEntries(rows: unknown) {
  if (!Array.isArray(rows)) throw new LifetimeTeamError("UNAVAILABLE");
  const entries: Array<{
    competitionTeamId: string; competitionId: string; lifetimeTeamId: string; publicCode: string; name: string; status: "PENDING_ORGANIZER_APPROVAL" | "ACCEPTED"; createdAt: string;
    claims: Array<{ claimId: string; gamingMemberId: string; displayName: string; status: "PROPOSED" | "ACCEPTED"; expiresAt: string }>;
  }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { competitionTeamId, competitionId, lifetimeTeamId, publicCode, name, status, createdAt, claims } = row;
    if (!isUuid(competitionTeamId) || !isUuid(competitionId) || !isUuid(lifetimeTeamId) || !isText(publicCode) || !isText(name) || !isLiveStatus(status) || !isTimestamp(createdAt) || !Array.isArray(claims)) continue;
    const kept: Array<{ claimId: string; gamingMemberId: string; displayName: string; status: "PROPOSED" | "ACCEPTED"; expiresAt: string }> = [];
    for (const claim of claims) {
      if (!isRecord(claim)) continue;
      const { claimId, gamingMemberId, displayName, status: claimStatus, expiresAt } = claim;
      if (!isUuid(claimId) || !isUuid(gamingMemberId) || !isText(displayName) || !isOpenStatus(claimStatus) || !isTimestamp(expiresAt)) continue;
      kept.push({ claimId, gamingMemberId, displayName, status: claimStatus, expiresAt });
    }
    entries.push({ competitionTeamId, competitionId, lifetimeTeamId, publicCode, name, status, createdAt, claims: kept });
  }
  return entries;
}

/** A person's own proposals, copied field by field. One that is malformed in any field is dropped. */
function ownClaims(rows: unknown) {
  if (!Array.isArray(rows)) throw new LifetimeTeamError("UNAVAILABLE");
  const claims: Array<{ claimId: string; competitionId: string; status: "PROPOSED" | "ACCEPTED"; expiresAt: string; team: { lifetimeTeamId: string; publicCode: string; name: string } }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { claimId, competitionId, status, expiresAt, team } = row;
    if (!isUuid(claimId) || !isUuid(competitionId) || !isOpenStatus(status) || !isTimestamp(expiresAt) || !isRecord(team)) continue;
    const { lifetimeTeamId, publicCode, name } = team;
    if (!isUuid(lifetimeTeamId) || !isText(publicCode) || !isText(name)) continue;
    claims.push({ claimId, competitionId, status, expiresAt, team: { lifetimeTeamId, publicCode, name } });
  }
  return claims;
}

/** GET — the live entries of the addressed competition, for its organizer. Anybody else — and an organizer whose hosting access was revoked — is told the competition is unknown. */
export async function handleListCompetitionEntries(request: Request, competitionId: unknown): Promise<Response> {
  return readRun("list-competition-entries", OF_COMPETITION, request, async (credentials, actor) => {
    const competition = requireUuid(competitionId);
    const rows = await listLifetimeEntriesForOrganizer(repositoryFor(credentials), competition, actor);
    return respond({ entries: organizerEntries(rows) }, 200);
  });
}

/** GET — the live entries of the team the signed-in member leads, with the proposals on them. No query, header or body can choose the member: there is none to read. */
export async function handleListMyTeamEntries(request: Request): Promise<Response> {
  return readRun("list-my-team-entries", NOTHING_ADDRESSED, request, async (credentials, actor) => {
    const rows = await listLifetimeEntriesOfMyTeams(repositoryFor(credentials), actor);
    return respond({ entries: ledEntries(rows) }, 200);
  });
}

/** GET — the signed-in member's own open proposals and accepted places. No query, header or body can choose the member: there is none to read. */
export async function handleListMyRosterClaims(request: Request): Promise<Response> {
  return readRun("list-my-roster-claims", NOTHING_ADDRESSED, request, async (credentials, actor) => {
    const rows = await listMyOpenRosterClaims(repositoryFor(credentials), actor);
    return respond({ claims: ownClaims(rows) }, 200);
  });
}
