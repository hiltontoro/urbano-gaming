import { NextResponse } from "next/server";

import { getSupabaseCredentials, requireCompetitionsSchemaReady, requireGamingMember } from "./httpAuth";
import { SupabaseLifetimeTeamsRepository } from "./db/supabaseLifetimeTeamsRepository";
import {
  LifetimeTeamError, decideLifetimeLeadership, decideLifetimeMembership, endLifetimeLeadership, endLifetimeMembership, offerLifetimeLeadership, parseOfferDecision, parseOfferKind,
  proposeLifetimeMembership, requireUuid, withdrawLifetimeOffer, type LifetimeProblem,
} from "./lifetimeTeams";

/**
 * UG-CR-GATE-CFM-010 — the ONE bounded HTTP adapter between the lifetime-team membership and leadership operations and a route.
 *
 * Seven operations and nothing else: propose a membership (an invitation, or a person's own request), decide one, withdraw an offer, end a membership, offer the
 * sub-captain seat, decide that offer, end the seat. (The team's own lifecycle — create, list, disband — has an adapter of its own; competition entry, roster claims, the
 * organizer's decisions, the freeze and the backfill have none, and no lookup of a team, an offer or a person exists here.) Each handler runs the same sequence, in this
 * order and no other:
 *
 *   1. the Competitions availability guard (before credentials, authentication, parsing or any repository);
 *   2. the server credentials;
 *   3. the verified Gaming Member — the ONLY source of the actor: no body, query, header or path value ever names one;
 *   4. the addressed id, then the body (exactly the fields the route names, and valid ones) — a body is never read for an id that cannot name anything;
 *   5. only then the lifetime repository, built once, for this request;
 *   6. the existing domain operation, with the session member as the actor.
 *
 * What a caller may name is the SUBJECT of an invitation, a request, a removal or a seat offer (and, for a captain who leaves, the successor). Never the actor, an
 * authority, a status, a timestamp or the role that results: the database decides who may do what, and these routes only carry its answer.
 *
 * Every response — success, refusal, failure, the guard's 503 and authentication's 401 — carries `Cache-Control: no-store, max-age=0`. Every body is a copy of explicitly
 * named fields or `{ "error": <one bounded sentence> }`: no database text, no internal code, no stack, no identifier the caller did not already hold.
 *
 * Statuses: 400 the request itself is wrong (not JSON, not exactly the named fields, a malformed id, an unknown decision or kind) · 401 not signed in · 404 the addressed
 * team or offer is unknown OR the caller has no standing to it — one and the same answer, so that nothing says whether it exists · 409 the state of the world conflicts
 * with the request · 500 anything unmapped or unexpected · 503 the availability guard. A refusal that belongs to another operation is not classified here (that would
 * be inventing policy): it fails closed as the generic 500.
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
// The centralized mapping: a typed refusal → a status and one bounded sentence
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** What an addressed route says when the thing is unknown or is not the caller's to know about: the same words whichever of the two it was. */
const TEAM_NOT_FOUND = "That team could not be found.";
const OFFER_NOT_FOUND = "That offer could not be found.";

interface Target {
  /** The one sentence of this route's 404. */
  notFound: string;
  /** Refusals that are ALSO this route's 404, because here a caller without standing can reach them (so a distinct answer would reveal that a membership exists). */
  alsoNotFound?: ReadonlySet<LifetimeProblem>;
}
const TEAM: Target = { notFound: TEAM_NOT_FOUND };
const OFFER: Target = { notFound: OFFER_NOT_FOUND };
/**
 * Ending a membership: anyone may name themselves ("I leave"), and for a person who does not belong "this person does not belong to the team" would say whether a
 * membership exists — so it is the same 404 as an unknown team. (Where only a captain or a member can reach that refusal — the seat offer and its answer — it stays a
 * bounded 409: the caller has standing and is entitled to know.)
 */
const END_MEMBERSHIP: Target = { notFound: TEAM_NOT_FOUND, alsoNotFound: new Set<LifetimeProblem>(["NOT_A_MEMBER"]) };

/** The request itself is wrong. */
const BAD_REQUEST = new Set<LifetimeProblem>(["INPUT_INVALID", "DECISION_INVALID"]);

/**
 * "Does this exist?" and "who are you to this?" — each is answered by the same 404, on every route, so an unknown team or offer and a team or offer the caller has no
 * standing to cannot be told apart. (There is no 403: a refusal of authority is a not-found.)
 */
const UNIFORM_NOT_FOUND = new Set<LifetimeProblem>(["TEAM_NOT_FOUND", "OFFER_NOT_FOUND", "NOT_A_LEADER", "NOT_THE_CAPTAIN", "OFFER_WRONG_PARTY"]);

/**
 * The state of the world conflicts with the request: an offer already answered, withdrawn or lapsed; a person who already belongs, a duplicate offer, the two-team cap;
 * a seat that is taken, empty or not for this person; a captain who needs a successor, or a successor that is not the sub-captain; a team with a live entry; a change
 * that raced another. Each keeps the foundation's own bounded sentence.
 */
const CONFLICT = new Set<LifetimeProblem>([
  "TEAM_NOT_ACTIVE", "PERSON_NOT_FOUND", "NOT_A_MEMBER", "ALREADY_MEMBER", "OFFER_NOT_PENDING", "OFFER_EXPIRED", "OFFER_ALREADY_PENDING", "MEMBERSHIP_CAP_REACHED", "REQUEST_NOT_ACCEPTABLE",
  "LEADER_CANNOT_JOIN_OTHER_TEAM", "LEADER_MUST_BELONG_TO_ONE_TEAM", "LEADER_CANNOT_BE_REMOVED", "CAPTAIN_NEEDS_SUCCESSOR", "SUCCESSOR_INVALID", "SEAT_TAKEN", "SEAT_EMPTY", "SEAT_SUBJECT_INVALID",
  "TEAM_HAS_LIVE_ENTRIES", "INVARIANT_VIOLATION", "CONCURRENT_CHANGE",
]);

const GENERIC_FAILURE = new LifetimeTeamError("UNAVAILABLE").message;
/** The sentence of a refusal, built from its code alone: nothing the refusal itself carries can reach a caller. */
const bounded = (code: LifetimeProblem) => new LifetimeTeamError(code).message;

/** A bounded word for the server log: a refusal's code or an error's class name — never a message, a code a database wrote, or anything a caller controls. */
function logToken(err: unknown): string {
  const word = err instanceof LifetimeTeamError ? err.code : (err as { name?: unknown } | null | undefined)?.name;
  return typeof word === "string" && /^[A-Za-z0-9_]{1,40}$/.test(word) ? word : "unknown";
}

function unavailable(operation: string, err: unknown): Response {
  console.error(`GAMING_TEAM_MEMBERSHIP_HTTP ${operation} failed:`, logToken(err));
  return respond({ error: GENERIC_FAILURE }, 500);
}

/** A typed refusal becomes its mapped status; everything else — an unmapped problem, a shared Competitions error, a raw failure, a non-error — is the generic 500. */
function refused(operation: string, err: unknown, target: Target): Response {
  if (err instanceof LifetimeTeamError) {
    if (UNIFORM_NOT_FOUND.has(err.code) || target.alsoNotFound?.has(err.code)) return respond({ error: target.notFound }, 404);
    if (BAD_REQUEST.has(err.code)) return respond({ error: bounded(err.code) }, 400);
    if (CONFLICT.has(err.code)) return respond({ error: bounded(err.code) }, 409);
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
    console.error("GAMING_TEAM_MEMBERSHIP_HTTP configuration failed: server credentials are not set");
    return { response: respond({ error: GENERIC_FAILURE }, 500) };
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return { response: uncached(auth.errorResponse) };
  return { credentials, gamingMemberId: auth.gamingMemberId };
}

const repositoryFor = (credentials: Credentials) => new SupabaseLifetimeTeamsRepository(credentials.url, credentials.serviceKey);

const INVALID_JSON = "Request body must be valid JSON.";
const SUBJECT_BODY = { shapes: [["gamingMemberId"]], sentence: "Request body must be exactly one field, gamingMemberId, holding the member's id." } as const;
const DECISION_BODY = { shapes: [["decision"]], sentence: "Request body must be exactly one field, decision, holding ACCEPT or DECLINE." } as const;
const KIND_BODY = { shapes: [["kind"]], sentence: "Request body must be exactly one field, kind, holding MEMBERSHIP or LEADERSHIP." } as const;
const END_MEMBERSHIP_BODY = { shapes: [["gamingMemberId"], ["gamingMemberId", "successorGamingMemberId"]], sentence: "Request body must be gamingMemberId, and optionally successorGamingMemberId." } as const;

/**
 * The body is a JSON object whose keys are EXACTLY one of the shapes the route names: a missing field, a second field of any kind, an array, a primitive — all refused
 * before a repository exists. The values are checked by the caller of this function (an identifier, a decision, a kind), one by one.
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** POST — invite a member to the addressed team, or (naming oneself) ask to join it. The database decides which it is and who may. */
export async function handleProposeMembership(request: Request, lifetimeTeamId: unknown): Promise<Response> {
  return run("propose-membership", TEAM, request, async (credentials, actor) => {
    const team = requireUuid(lifetimeTeamId);
    const read = await readBody(request, SUBJECT_BODY);
    if ("response" in read) return read.response;
    const subject = requireUuid(read.body.gamingMemberId);
    const offer = await proposeLifetimeMembership(repositoryFor(credentials), team, actor, subject);
    return respond({ membership: { lifetimeTeamMembershipId: offer.lifetimeTeamMembershipId, status: offer.status, initiatedBySide: offer.initiatedBySide, expiresAt: offer.expiresAt } }, 201);
  });
}

/** POST — answer a membership offer: the other side of it accepts or declines. */
export async function handleDecideMembership(request: Request, membershipId: unknown): Promise<Response> {
  return run("decide-membership", OFFER, request, async (credentials, actor) => {
    const offer = requireUuid(membershipId);
    const read = await readBody(request, DECISION_BODY);
    if ("response" in read) return read.response;
    const decision = parseOfferDecision(read.body.decision);
    const answered = await decideLifetimeMembership(repositoryFor(credentials), offer, actor, decision);
    return respond({ membership: { lifetimeTeamMembershipId: answered.lifetimeTeamMembershipId, status: answered.status, joinedAt: answered.joinedAt } }, 200);
  });
}

/** POST — withdraw a pending offer (a membership or a seat) the caller's side made. */
export async function handleWithdrawOffer(request: Request, offerId: unknown): Promise<Response> {
  return run("withdraw-offer", OFFER, request, async (credentials, actor) => {
    const offer = requireUuid(offerId);
    const read = await readBody(request, KIND_BODY);
    if ("response" in read) return read.response;
    const kind = parseOfferKind(read.body.kind);
    const withdrawn = await withdrawLifetimeOffer(repositoryFor(credentials), kind, offer, actor);
    return respond({ offer: { offerId: withdrawn.offerId, status: withdrawn.status } }, 200);
  });
}

/** POST — a person leaves, or a leader removes an ordinary member. A captain leaves by handing over to the sub-captain (named, or by default). */
export async function handleEndMembership(request: Request, lifetimeTeamId: unknown): Promise<Response> {
  return run("end-membership", END_MEMBERSHIP, request, async (credentials, actor) => {
    const team = requireUuid(lifetimeTeamId);
    const read = await readBody(request, END_MEMBERSHIP_BODY);
    if ("response" in read) return read.response;
    const subject = requireUuid(read.body.gamingMemberId);
    const successor = Object.keys(read.body).includes("successorGamingMemberId") ? requireUuid(read.body.successorGamingMemberId) : undefined;
    const ended = await endLifetimeMembership(repositoryFor(credentials), team, actor, subject, successor);
    return respond({ membership: { lifetimeTeamMembershipId: ended.lifetimeTeamMembershipId, endedAt: ended.endedAt, successorLeadershipId: ended.successorLeadershipId } }, 200);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Leadership
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** POST — the captain offers the sub-captain seat to a member of the addressed team. */
export async function handleOfferLeadership(request: Request, lifetimeTeamId: unknown): Promise<Response> {
  return run("offer-leadership", TEAM, request, async (credentials, actor) => {
    const team = requireUuid(lifetimeTeamId);
    const read = await readBody(request, SUBJECT_BODY);
    if ("response" in read) return read.response;
    const subject = requireUuid(read.body.gamingMemberId);
    const offer = await offerLifetimeLeadership(repositoryFor(credentials), team, actor, subject);
    return respond({ leadership: { lifetimeTeamLeadershipId: offer.lifetimeTeamLeadershipId, status: offer.status, expiresAt: offer.expiresAt } }, 201);
  });
}

/** POST — the member who was offered the seat accepts or declines it. */
export async function handleDecideLeadership(request: Request, leadershipId: unknown): Promise<Response> {
  return run("decide-leadership", OFFER, request, async (credentials, actor) => {
    const offer = requireUuid(leadershipId);
    const read = await readBody(request, DECISION_BODY);
    if ("response" in read) return read.response;
    const decision = parseOfferDecision(read.body.decision);
    const answered = await decideLifetimeLeadership(repositoryFor(credentials), offer, actor, decision);
    return respond({ leadership: { lifetimeTeamLeadershipId: answered.lifetimeTeamLeadershipId, status: answered.status, startedAt: answered.startedAt } }, 200);
  });
}

/** POST — the sub-captain steps down, or the captain removes the sub-captain. No request body is read: there is nothing to name. */
export async function handleEndLeadership(request: Request, lifetimeTeamId: unknown): Promise<Response> {
  return run("end-leadership", TEAM, request, async (credentials, actor) => {
    const team = requireUuid(lifetimeTeamId);
    const ended = await endLifetimeLeadership(repositoryFor(credentials), team, actor);
    return respond({ leadership: { lifetimeTeamLeadershipId: ended.lifetimeTeamLeadershipId, endedAt: ended.endedAt, endReason: ended.endReason } }, 200);
  });
}
