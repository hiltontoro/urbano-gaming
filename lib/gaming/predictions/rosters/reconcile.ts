import type { PlayerPosition, PlayerRecord } from "../types";
import { PLAYER_POSITIONS } from "../types";
import type { RosterEntry, RosterSnapshot, RosterTeamSnapshot } from "./clasicoRosterSnapshot";

/**
 * ROSTER RECONCILIATION — pure, no database, no clock, no randomness. It decides what loading a roster would do and nothing else.
 *
 * The rules (the Founder's, for the Clásico rosters):
 *  - Existing players come first. A roster entry whose name, normalised (accents, case, spaces and punctuation ignored), equals the name of
 *    a player already on the same team IS that player: it is updated in place and keeps its `playerId`. Nothing is ever inserted next to it.
 *  - The id of a player is generated once, by the database, when the player is first inserted. It is never derived from the squad number
 *    or the name and never regenerated, so a second load changes nothing (the reconciliation finds the player again and finds nothing to
 *    change).
 *  - Near matches are NOT merged. An existing player that no entry matches exactly but whose name shares a word with an entry is reported
 *    for a person to decide; it is left exactly as it is. The same goes for an existing team whose name merely resembles a club's.
 *  - An existing player that the roster does not mention is left untouched: not deactivated, not renamed. A roster says who is in the
 *    squad list, never who may or may not play, so it never switches anybody off ("roster independent from call-up").
 *  - Teams are matched by their exact normalised name only. A team called "Real Madrid 3232428e" is a contract-test fixture, not the club.
 *  - The snapshot is validated first: no repeated name and no repeated squad number inside a team, numbers are whole and 0–99, positions
 *    are one of the four, and every name is non-empty and already trimmed. A snapshot with a problem produces no plan.
 */

/** Accents, case, runs of spaces and punctuation do not distinguish two names; the letters and digits do. */
export function normalizeRosterName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const nameTokens = (name: string): string[] => normalizeRosterName(name).split(" ").filter((token) => token.length >= 3);

export function validateRosterTeam(team: RosterTeamSnapshot): string[] {
  const problems: string[] = [];
  if (team.teamName.trim() !== team.teamName || team.teamName.length === 0) problems.push(`team "${team.teamName}": the name is empty or has stray spaces`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(team.source.consultedOn)) problems.push(`team "${team.teamName}": consultedOn is not a date (YYYY-MM-DD)`);
  if (!team.source.url.startsWith("https://")) problems.push(`team "${team.teamName}": the source is not an https address`);
  const names = new Map<string, string>();
  const numbers = new Map<number, string>();
  for (const entry of team.players) {
    const label = `team "${team.teamName}", "${entry.name}"`;
    if (entry.name.length === 0 || entry.name.trim() !== entry.name) problems.push(`${label}: the name is empty or has stray spaces`);
    if (!Number.isInteger(entry.jerseyNumber) || entry.jerseyNumber < 0 || entry.jerseyNumber > 99) problems.push(`${label}: the squad number ${entry.jerseyNumber} is not a whole number from 0 to 99`);
    if (!PLAYER_POSITIONS.includes(entry.position as PlayerPosition)) problems.push(`${label}: the position "${entry.position}" is not one of ${PLAYER_POSITIONS.join(", ")}`);
    const key = normalizeRosterName(entry.name);
    if (names.has(key)) problems.push(`${label}: the name repeats "${names.get(key)}"`);
    else names.set(key, entry.name);
    if (numbers.has(entry.jerseyNumber)) problems.push(`${label}: the squad number ${entry.jerseyNumber} repeats "${numbers.get(entry.jerseyNumber)}"`);
    else numbers.set(entry.jerseyNumber, entry.name);
  }
  return problems;
}

export function validateRosterSnapshot(snapshot: RosterSnapshot): string[] {
  const problems = snapshot.teams.flatMap(validateRosterTeam);
  const teamNames = new Set<string>();
  for (const team of snapshot.teams) {
    const key = normalizeRosterName(team.teamName);
    if (teamNames.has(key)) problems.push(`team "${team.teamName}" appears twice`);
    teamNames.add(key);
  }
  return problems;
}

export interface ExistingTeam {
  teamId: string;
  name: string;
}

export type RosterAction =
  | { kind: "create"; entry: RosterEntry }
  /** Same player (same id), a roster field or the published spelling of the name differs. */
  | { kind: "update"; playerId: string; entry: RosterEntry; changes: string[] }
  | { kind: "unchanged"; playerId: string; entry: RosterEntry };

export interface RosterTeamPlan {
  teamName: string;
  /** "reuse" keeps the existing team's id; "create" means no team with exactly this name exists. */
  team: { action: "reuse"; teamId: string } | { action: "create" };
  /** Existing teams whose name resembles the club's but is not exactly it: reported, never reused. */
  teamsToReview: ExistingTeam[];
  actions: RosterAction[];
  /** Existing players that no entry matches: left exactly as they are. */
  untouched: PlayerRecord[];
  /** Untouched players whose name shares a word with an entry: for a person to decide, never merged. */
  playersToReview: { existing: PlayerRecord; possibleEntries: RosterEntry[] }[];
  /** What a person must settle before anything is applied: an ambiguity is never resolved by guessing. Empty means the plan can be applied. */
  blockers: string[];
}

export interface RosterPlan {
  problems: string[];
  teams: RosterTeamPlan[];
}

export function describeSource(team: RosterTeamSnapshot): string {
  return `${team.source.label} — ${team.source.url}`;
}

function fieldChanges(existing: PlayerRecord, entry: RosterEntry, team: RosterTeamSnapshot): string[] {
  const changes: string[] = [];
  if (existing.name !== entry.name) changes.push(`name "${existing.name}" → "${entry.name}"`);
  if ((existing.jerseyNumber ?? null) !== entry.jerseyNumber) changes.push(`jersey ${existing.jerseyNumber ?? "none"} → ${entry.jerseyNumber}`);
  if ((existing.position ?? null) !== entry.position) changes.push(`position ${existing.position ?? "none"} → ${entry.position}`);
  if ((existing.rosterSource ?? null) !== describeSource(team)) changes.push("source");
  if ((existing.rosterConsultedOn ?? null) !== team.source.consultedOn) changes.push("consultedOn");
  return changes;
}

/**
 * What loading `snapshot` would do given the teams and players that exist. `playersByTeamId` holds every existing player of each team
 * (active or not). Pure: the same inputs always give the same plan, and applying the plan and planning again gives only "unchanged".
 */
export function planRosterLoad(snapshot: RosterSnapshot, existingTeams: ExistingTeam[], playersByTeamId: Map<string, PlayerRecord[]>): RosterPlan {
  const problems = validateRosterSnapshot(snapshot);
  if (problems.length > 0) return { problems, teams: [] };

  const teams: RosterTeamPlan[] = snapshot.teams.map((team) => {
    const wanted = normalizeRosterName(team.teamName);
    const exact = existingTeams.filter((existing) => normalizeRosterName(existing.name) === wanted);
    const clubWords = nameTokens(team.teamName).filter((token) => token !== "real" && token !== "club");
    const teamsToReview = existingTeams.filter(
      (existing) => !exact.includes(existing) && clubWords.some((word) => nameTokens(existing.name).includes(word))
    );
    // Two teams with exactly the same name would be ambiguous: nothing is chosen for the person.
    if (exact.length > 1) {
      return {
        teamName: team.teamName,
        team: { action: "create" as const },
        teamsToReview: [...exact, ...teamsToReview],
        actions: [],
        untouched: [],
        playersToReview: [],
        blockers: [`${exact.length} existing teams are called exactly "${team.teamName}": which one is the club is not guessed`],
      };
    }
    const existingTeam = exact[0] ?? null;
    const existingPlayers = existingTeam ? playersByTeamId.get(existingTeam.teamId) ?? [] : [];
    const byName = new Map<string, PlayerRecord[]>();
    for (const player of existingPlayers) {
      const key = normalizeRosterName(player.name);
      byName.set(key, [...(byName.get(key) ?? []), player]);
    }

    const matched = new Set<string>();
    const actions: RosterAction[] = [];
    const blockers: string[] = [];
    for (const entry of team.players) {
      const candidates = byName.get(normalizeRosterName(entry.name)) ?? [];
      if (candidates.length === 0) {
        actions.push({ kind: "create", entry });
        continue;
      }
      // Two existing players with the same normalised name: not guessed, not created next to them, not merged.
      if (candidates.length > 1) {
        for (const candidate of candidates) matched.add(candidate.playerId);
        blockers.push(`"${entry.name}" matches ${candidates.length} existing players of the team (${candidates.map((candidate) => candidate.playerId).join(", ")})`);
        continue;
      }
      const existing = candidates[0];
      matched.add(existing.playerId);
      const changes = fieldChanges(existing, entry, team);
      actions.push(changes.length === 0 ? { kind: "unchanged", playerId: existing.playerId, entry } : { kind: "update", playerId: existing.playerId, entry, changes });
    }

    const untouched = existingPlayers.filter((player) => !matched.has(player.playerId));
    const playersToReview = untouched
      .map((existing) => {
        const words = nameTokens(existing.name);
        const possibleEntries = team.players.filter((entry) => nameTokens(entry.name).some((word) => words.includes(word)));
        return { existing, possibleEntries };
      })
      .filter((item) => item.possibleEntries.length > 0);

    return {
      teamName: team.teamName,
      team: existingTeam ? { action: "reuse" as const, teamId: existingTeam.teamId } : { action: "create" as const },
      teamsToReview,
      actions,
      untouched,
      playersToReview,
      blockers,
    };
  });
  return { problems: [], teams };
}

export function summarizePlan(plan: RosterPlan): { creates: number; updates: number; unchanged: number; untouched: number; teamsToCreate: number } {
  const all = plan.teams.flatMap((team) => team.actions);
  return {
    creates: all.filter((action) => action.kind === "create").length,
    updates: all.filter((action) => action.kind === "update").length,
    unchanged: all.filter((action) => action.kind === "unchanged").length,
    untouched: plan.teams.reduce((sum, team) => sum + team.untouched.length, 0),
    teamsToCreate: plan.teams.filter((team) => team.team.action === "create").length,
  };
}
