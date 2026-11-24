import { NextResponse } from "next/server";

import { getSupabaseCredentials, requireCompetitionsSchemaReady, requireGamingMember } from "./httpAuth";
import { SupabaseLifetimeTeamsRepository } from "./db/supabaseLifetimeTeamsRepository";
import { LifetimeTeamError, createLifetimeTeam, disbandLifetimeTeam, normalizeLifetimeTeamName, requireUuid, type LifetimeProblem } from "./lifetimeTeams";

/**
 * UG-CR-GATE-CFM-007 / CFM-007A — the ONE bounded HTTP adapter between the lifetime-team foundation and a route.
 *
 * Three operations and nothing else: a member creates a team, lists their own active teams, and disbands a team they captain. Each runs the same sequence, in this
 * order and no other:
 *
 *   1. the Competitions availability guard (before credentials, authentication, parsing or any repository);
 *   2. the server credentials;
 *   3. the verified Gaming Member (the ONLY source of the actor — no body, query, header or path value ever names one);
 *   4. parsing what the caller sent (create: a body of exactly {"name": ...}; disband: the addressed id, no body at all);
 *   5. only then the lifetime repository, built once, for this request.
 *
 * Every response — success, refusal, failure, the guard's 503 and authentication's 401 — carries `Cache-Control: no-store, max-age=0`. Every body is either a copy of
 * explicitly named fields or `{ "error": <one bounded sentence> }`: no database text, no internal code, no stack, no identifier the caller did not already hold.
 *
 * What is NOT here, on purpose: invitations and membership offers, leadership changes, entries into a competition, roster claims, organizer decisions, the freeze, the
 * backfill, and any lookup of a team by identifier or public code. The database stays authoritative for captaincy, team state and live-entry protection; this file maps
 * its typed refusals to a status and never decides one.
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

interface Refusal { status: 400 | 403 | 404 | 409; message: string }

/** What the caller reads for every refusal that says "this team is not yours to see": the same words whichever of them it was. */
const NOT_FOUND: Refusal = { status: 404, message: "That team could not be found." };

const bounded = (status: Refusal["status"], code: LifetimeProblem): Refusal => ({ status, message: new LifetimeTeamError(code).message });

/**
 * The refusals this gate owns. A problem that belongs to ANOTHER operation (an offer, a seat, an entry, a roster claim, the freeze) is deliberately absent: mapping it
 * would invent a policy this gate does not hold, so it fails closed as the generic 500 below. The messages are the typed refusal's own bounded sentences.
 */
const REFUSALS: Partial<Record<LifetimeProblem, Refusal>> = {
  // 400 — the request itself is wrong
  NAME_INVALID: bounded(400, "NAME_INVALID"),
  INPUT_INVALID: bounded(400, "INPUT_INVALID"),
  // 403 — the caller lacks the authority (the addressed disband collapses these into NOT_FOUND, below)
  NOT_THE_CAPTAIN: bounded(403, "NOT_THE_CAPTAIN"),
  NOT_A_LEADER: bounded(403, "NOT_A_LEADER"),
  // 404
  TEAM_NOT_FOUND: NOT_FOUND,
  // 409 — the state of the world conflicts with the request
  NAME_TAKEN: bounded(409, "NAME_TAKEN"),
  PERSON_NOT_FOUND: bounded(409, "PERSON_NOT_FOUND"),
  TEAM_NOT_ACTIVE: bounded(409, "TEAM_NOT_ACTIVE"),
  TEAM_HAS_LIVE_ENTRIES: bounded(409, "TEAM_HAS_LIVE_ENTRIES"),
  LEADER_MUST_BELONG_TO_ONE_TEAM: bounded(409, "LEADER_MUST_BELONG_TO_ONE_TEAM"),
  LEADER_CANNOT_JOIN_OTHER_TEAM: bounded(409, "LEADER_CANNOT_JOIN_OTHER_TEAM"),
  MEMBERSHIP_CAP_REACHED: bounded(409, "MEMBERSHIP_CAP_REACHED"),
  INVARIANT_VIOLATION: bounded(409, "INVARIANT_VIOLATION"),
  CONCURRENT_CHANGE: bounded(409, "CONCURRENT_CHANGE"),
};

/** On the addressed disband route these answers reveal whether the team exists or which authority check failed, so they are all NOT_FOUND (CFM-007A §4). */
const COLLAPSED_WHEN_ADDRESSED = new Set<LifetimeProblem>(["TEAM_NOT_FOUND", "NOT_THE_CAPTAIN", "NOT_A_LEADER", "INPUT_INVALID"]);

const GENERIC_FAILURE = new LifetimeTeamError("UNAVAILABLE").message;

/** A bounded word for the server log: a refusal's code or an error's class name — never a message, a code a database wrote, or anything a caller controls. */
function logToken(err: unknown): string {
  const word = err instanceof LifetimeTeamError ? err.code : (err as { name?: unknown } | null | undefined)?.name;
  return typeof word === "string" && /^[A-Za-z0-9_]{1,40}$/.test(word) ? word : "unknown";
}

function unavailable(operation: string, err: unknown): Response {
  console.error(`GAMING_TEAMS_HTTP ${operation} failed:`, logToken(err));
  return respond({ error: GENERIC_FAILURE }, 500);
}

/** A typed refusal becomes its mapped status; everything else — an unmapped problem, a shared Competitions error, a raw failure, a non-error — is the generic 500. */
function refused(operation: string, err: unknown, addressed = false): Response {
  if (err instanceof LifetimeTeamError) {
    const refusal = addressed && COLLAPSED_WHEN_ADDRESSED.has(err.code) ? NOT_FOUND : REFUSALS[err.code];
    if (refusal) return respond({ error: refusal.message }, refusal.status);
  }
  return unavailable(operation, err);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The shared start of every request
// ---------------------------------------------------------------------------------------------------------------------------------------------

type Opened = { response: Response } | { credentials: { url: string; serviceKey: string }; gamingMemberId: string };

async function open(request: Request): Promise<Opened> {
  const closed = requireCompetitionsSchemaReady();
  if (closed) return { response: uncached(closed) };
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    console.error("GAMING_TEAMS_HTTP configuration failed: server credentials are not set");
    return { response: respond({ error: GENERIC_FAILURE }, 500) };
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return { response: uncached(auth.errorResponse) };
  return { credentials, gamingMemberId: auth.gamingMemberId };
}

const repositoryFor = (credentials: { url: string; serviceKey: string }) => new SupabaseLifetimeTeamsRepository(credentials.url, credentials.serviceKey);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// GET — the signed-in member's own active teams, each with the member's own role on it
// ---------------------------------------------------------------------------------------------------------------------------------------------

const isUuid = (value: unknown): value is string => {
  try { requireUuid(value); return true; } catch { return false; }
};
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
/** The caller's own role on a team (UG-CR-GATE-CFM-012): exactly one of three words, derived by the repository from the caller's ACTIVE seat — never from the request. */
const isRole = (value: unknown): value is "CAPTAIN" | "SUB_CAPTAIN" | "MEMBER" => value === "CAPTAIN" || value === "SUB_CAPTAIN" || value === "MEMBER";

/**
 * The summary the caller may see, copied field by field from rows the repository returned — the caller's OWN role on the team last. A row that is not exactly ACTIVE
 * (a disbanded team, anything unexpected) or that is malformed in any field, the role included, is dropped — it never appears as an active team, and a role that is
 * not one of the three is never defaulted into anything. The repository's order is kept.
 */
function activeSummaries(rows: unknown) {
  if (!Array.isArray(rows)) throw new LifetimeTeamError("UNAVAILABLE");
  const teams: Array<{ lifetimeTeamId: string; publicCode: string; name: string; status: "ACTIVE"; joinedAt: string; isLegacy: boolean; role: "CAPTAIN" | "SUB_CAPTAIN" | "MEMBER" }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const { lifetimeTeamId, publicCode, name, status, joinedAt, isLegacy, role } = row as Record<string, unknown>;
    if (status !== "ACTIVE" || !isUuid(lifetimeTeamId) || !isText(publicCode) || !isText(name) || !isTimestamp(joinedAt) || typeof isLegacy !== "boolean" || !isRole(role)) continue;
    teams.push({ lifetimeTeamId, publicCode, name, status: "ACTIVE", joinedAt, isLegacy, role });
  }
  return teams;
}

export async function handleListMyTeams(request: Request): Promise<Response> {
  try {
    const opened = await open(request);
    if ("response" in opened) return opened.response;
    const rows = await repositoryFor(opened.credentials).listActiveTeamsOfMember(opened.gamingMemberId);
    return respond({ teams: activeSummaries(rows) }, 200);
  } catch (err) {
    // A read has no refusal of its own: whatever went wrong, the list is unavailable.
    return unavailable("list", err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// POST — create one team
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The body is exactly one field, `name`. Anything else — a missing name, a second field of any kind — is refused before a repository exists. */
async function readCreateBody(request: Request): Promise<{ name: unknown } | { response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: respond({ error: "Request body must be valid JSON." }, 400) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { response: respond({ error: "Request body must be exactly one field, name, holding the team name." }, 400) };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "name") return { response: respond({ error: "Request body must be exactly one field, name, holding the team name." }, 400) };
  return { name: (body as { name: unknown }).name };
}

export async function handleCreateTeam(request: Request): Promise<Response> {
  try {
    const opened = await open(request);
    if ("response" in opened) return opened.response;
    const parsed = await readCreateBody(request);
    if ("response" in parsed) return parsed.response;
    const name = normalizeLifetimeTeamName(parsed.name); // an invalid name is refused here, before any repository exists
    const created = await createLifetimeTeam(repositoryFor(opened.credentials), opened.gamingMemberId, name);
    return respond({ team: { lifetimeTeamId: created.lifetimeTeamId, publicCode: created.publicCode, createdAt: created.createdAt } }, 201);
  } catch (err) {
    return refused("create", err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// POST — disband the addressed team
// ---------------------------------------------------------------------------------------------------------------------------------------------

export async function handleDisbandTeam(request: Request, addressedId: unknown): Promise<Response> {
  try {
    const opened = await open(request);
    if ("response" in opened) return opened.response;
    // The request body is never read. A malformed id is the same answer as an unknown team or a team the caller does not captain.
    if (!isUuid(addressedId)) return respond({ error: NOT_FOUND.message }, NOT_FOUND.status);
    const disbanded = await disbandLifetimeTeam(repositoryFor(opened.credentials), addressedId, opened.gamingMemberId);
    return respond({ team: { lifetimeTeamId: disbanded.lifetimeTeamId, status: "DISBANDED", disbandedAt: disbanded.disbandedAt } }, 200);
  } catch (err) {
    return refused("disband", err, true);
  }
}
