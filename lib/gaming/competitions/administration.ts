import type { CompetitionAdministrationReads } from "./db/competitionsRepository";
import type { CompetitionState } from "./types";

/**
 * UG-CR-GATE-100 — Competition Organizer entry and scoped administration (bounded organizer-access correction).
 *
 * Administration is not member discovery. Member discovery ("Explore Competitions", GET /api/gaming/competitions) answers
 * "which competitions may this member find?" and is deliberately unchanged. Administration answers a different question:
 * "which competitions does this member ACTIVELY ORGANIZE?" This module answers it, on the server, from the member's own
 * relationship to each competition — never by filtering the discovery list, and never from a capability alone.
 *
 * ORGANIZER AUTHORITY is ACTIVE authority over a competition that is not finished:
 *  - the member is the competition's organizer and, if it is a host's private pilot, that host's access has not been revoked; and
 *  - the competition is not terminal (COMPLETE or CANCELLED_WITHOUT_CHAMPION). A finished competition is not an administration target and
 *    never yields Organizer Access; it stays reachable only through ordinary member discovery.
 *
 * It is NOT held by: an approved applicant whose pilot capability is still unused (a capability is permission to create one pilot, not
 * authority over a competition — the application page is where that is used), a scorekeeper, a captain, a registrant, an applicant, or a
 * member who merely holds the internal OPERATIONAL authority (operating is not organizing; OPERATIONAL only controls Create Competition).
 *
 * SCOREKEEPER access is deliberately NOT part of any list here. It is contextual: it starts from ONE addressed competition on the member
 * competition page and is decided by {@link appointedFixtureIds} for exactly that competition. Nothing in this module can enumerate a
 * member's appointments across competitions.
 *
 * Everything here fails closed: an unrecognised or malformed record is not access.
 */

export type AdministrativeAccess = "ORGANIZER";

/** What the organizer page is told about one competition — nothing else (no organizer id, no public code, no counts). */
export interface AdministrableCompetition {
  competitionId: string;
  name: string;
  state: CompetitionState;
  access: AdministrativeAccess;
}

/** The states in which a competition is still being run. An explicit allowlist: an unknown or malformed state is NOT active. */
const ACTIVE_STATES: ReadonlyArray<CompetitionState> = ["DRAFT", "TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED"];

export function isActiveCompetitionState(state: unknown): boolean {
  return typeof state === "string" && (ACTIVE_STATES as ReadonlyArray<string>).includes(state);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface LooseCompetition {
  competitionId?: unknown;
  name?: unknown;
  state?: unknown;
  organizerGamingMemberId?: unknown;
  hostBound?: unknown;
  hostAccessRevoked?: unknown;
}

function asRecord(value: unknown): LooseCompetition | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as LooseCompetition) : null;
}

/**
 * Is `caller` this competition's organizer, with standing? This is the RELATIONSHIP only, regardless of lifecycle:
 *  - They must be its organizer.
 *  - A host's pilot must carry an explicit, un-revoked binding (`hostAccessRevoked === false`). A revoked host, and any host
 *    pilot whose binding state is missing or malformed, is NOT access.
 *  - An internal competition carries no binding; an unexpected binding value is treated as malformed and denied.
 */
export function holdsOrganizerAccess(competition: unknown, callerGamingMemberId: string): boolean {
  const c = asRecord(competition);
  if (!c || !isNonEmptyString(callerGamingMemberId)) return false;
  if (!isNonEmptyString(c.competitionId) || !isNonEmptyString(c.organizerGamingMemberId)) return false;
  if (c.organizerGamingMemberId !== callerGamingMemberId) return false;
  if (c.hostBound !== undefined && typeof c.hostBound !== "boolean") return false;
  if (c.hostBound === true) return c.hostAccessRevoked === false;
  return c.hostAccessRevoked === undefined || c.hostAccessRevoked === false;
}

/** ACTIVE organizer authority: the organizer relationship above, over a competition that is still being run. */
export function holdsActiveOrganizerAuthority(competition: unknown, callerGamingMemberId: string): boolean {
  if (!holdsOrganizerAccess(competition, callerGamingMemberId)) return false;
  return isActiveCompetitionState(asRecord(competition)?.state);
}

/**
 * The organizer-access signal behind the Home entry. True only when the caller holds ACTIVE organizer authority over at least one
 * competition. It reads nothing about application availability, capabilities, appointments or operational authority, so a real organizer
 * is recognized while applications are closed, and none of those alone is ever Organizer Access.
 */
export async function hasOrganizerAccess(repo: Pick<CompetitionAdministrationReads, "listCompetitions">, callerGamingMemberId: string): Promise<boolean> {
  if (!isNonEmptyString(callerGamingMemberId)) return false;
  const competitions = await repo.listCompetitions();
  return Array.isArray(competitions) && competitions.some((competition) => holdsActiveOrganizerAuthority(competition, callerGamingMemberId));
}

/**
 * The competitions the caller actively organizes, newest first (the repository's order). Nothing else: not a discovery competition, not a
 * scorekeeper appointment, not a captaincy or registration, not an application or capability, not a revoked organizer's pilot, and not a
 * terminal competition.
 */
export async function listAdministrableCompetitions(repo: Pick<CompetitionAdministrationReads, "listCompetitions">, callerGamingMemberId: string): Promise<AdministrableCompetition[]> {
  if (!isNonEmptyString(callerGamingMemberId)) return [];
  const competitions = await repo.listCompetitions();
  if (!Array.isArray(competitions)) return [];
  const administrable: AdministrableCompetition[] = [];
  for (const raw of competitions) {
    const c = asRecord(raw);
    if (!c || !isNonEmptyString(c.name)) continue;
    if (!holdsActiveOrganizerAuthority(c, callerGamingMemberId)) continue;
    administrable.push({ competitionId: c.competitionId as string, name: c.name, state: c.state as CompetitionState, access: "ORGANIZER" });
  }
  return administrable;
}

/** What the organizer page may offer THIS caller to create — decided on the server from the one relationship that governs it. */
export interface AdministrativeOperations {
  /** The caller holds the active internal OPERATIONAL authority that create_competition_atomically itself requires. */
  createCompetition: boolean;
}

export const NO_OPERATIONS: AdministrativeOperations = Object.freeze({ createCompetition: false });

export async function getAdministrativeOperations(repo: Pick<CompetitionAdministrationReads, "hasOperationalAuthority">, callerGamingMemberId: string): Promise<AdministrativeOperations> {
  if (!isNonEmptyString(callerGamingMemberId)) return { ...NO_OPERATIONS };
  return { createCompetition: (await repo.hasOperationalAuthority(callerGamingMemberId)) === true };
}

/** Everything the organizer page is told: the competitions the caller actively organizes, and the creation they may start. */
export async function describeAdministration(
  repo: CompetitionAdministrationReads,
  callerGamingMemberId: string
): Promise<{ competitions: AdministrableCompetition[]; operations: AdministrativeOperations }> {
  const [competitions, operations] = await Promise.all([listAdministrableCompetitions(repo, callerGamingMemberId), getAdministrativeOperations(repo, callerGamingMemberId)]);
  return { competitions, operations };
}

/**
 * The fixtures of ONE addressed competition that `caller` is CURRENTLY appointed to score — the single place scorekeeper access is decided.
 *
 * It is given the one competition and its fixtures, never a list of the caller's appointments, so it cannot enumerate across competitions.
 * A fixture counts only when it belongs to that competition and its current scorekeeper is exactly the caller: re-appointing someone else
 * ends the appointment with no extra bookkeeping. A host whose access was revoked gets nothing from having appointed themselves
 * (the same rule the fixture admin-detail read applies); a malformed or unexpected record is not an appointment.
 */
export function appointedFixtureIds(competition: unknown, fixtures: unknown, callerGamingMemberId: string): string[] {
  const c = asRecord(competition);
  if (!c || !isNonEmptyString(callerGamingMemberId) || !isNonEmptyString(c.competitionId)) return [];
  // The competition's own organizer scores only while they still hold standing: a revoked (or malformed) host binding is no route back in.
  if (c.organizerGamingMemberId === callerGamingMemberId && !holdsOrganizerAccess(c, callerGamingMemberId)) return [];
  if (!Array.isArray(fixtures)) return [];
  const ids: string[] = [];
  for (const raw of fixtures) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const f = raw as { competitionFixtureId?: unknown; competitionId?: unknown; scorekeeperGamingMemberId?: unknown };
    if (!isNonEmptyString(f.competitionFixtureId) || f.competitionId !== c.competitionId) continue;
    if (f.scorekeeperGamingMemberId !== callerGamingMemberId) continue;
    if (!ids.includes(f.competitionFixtureId)) ids.push(f.competitionFixtureId);
  }
  return ids;
}
