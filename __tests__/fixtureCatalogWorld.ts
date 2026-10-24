import { TEMPORARY_FIXTURE_EXCLUSION } from "@/lib/gaming/predictions/fixtureExclusionManifest";
import type {
  MatchRecord,
  MatchResultRecord,
  PlayerRecord,
  PrizeTierRecord,
  TeamRecord,
  VenueActivationRecord,
  VenueRecord,
} from "@/lib/gaming/predictions/types";

/**
 * An in-memory Score catalog shaped like the Production one at the time of the inventory (36 matches, 82 teams, 122 players, 30 venues,
 * 24 activations, 2 prize tiers, results on some matches), plus a few LEGITIMATE rows that must never be treated as fixtures, and a
 * repository double that records every call. The fixture rows carry the exact ids of the manifest, so the real exclusion applies to them.
 *
 * It is a test double: no network, no credentials. The same shape is used by the behavioral tests and, against a real local database, by
 * fixtureExclusionSupabase.contract.test.ts.
 */

export type RepoCall = [method: string, argument: string | null];

const pad = (n: number, width = 12) => String(n).padStart(width, "0");
const LEGIT_PREFIX = { team: "e1000000", player: "e2000000", match: "e3000000", venue: "e4000000", act: "e5000000", tier: "e6000000", result: "e7000000" } as const;
export const legitId = (kind: keyof typeof LEGIT_PREFIX, n: number) => `${LEGIT_PREFIX[kind]}-0000-4000-8000-${pad(n)}`;

const CREATED_FIXTURE = "2026-08-25T16:55:00.000Z";
const CREATED_LEGIT = "2026-10-24T20:00:00.000Z";

export interface LegitCatalog {
  /** A legitimate match from long ago (kick-off in 2020): it must not be hidden because it is old. */
  oldMatchId: string;
  /** A match created today with the SAME competition, classification and kick-off day as the fixtures, but a new id. */
  lookAlikeMatchId: string;
  /** A match created today for the rehearsal: nothing marks it as a rehearsal. */
  newMatchId: string;
  /** A match created today and cancelled. */
  cancelledMatchId: string;
  teamIds: string[];
  venueIds: string[];
  activationIds: string[];
}

export interface CatalogWorld {
  matches: MatchRecord[];
  teams: TeamRecord[];
  players: PlayerRecord[];
  venues: VenueRecord[];
  activations: VenueActivationRecord[];
  tiers: PrizeTierRecord[];
  results: MatchResultRecord[];
  legit: LegitCatalog;
  calls: RepoCall[];
  repo: Record<string, (...args: any[]) => Promise<any>>;
  /** Ids of the rows that belong to the fixture set (by the manifest) for each kind. */
  fixtureIds: { matches: Set<string>; teams: Set<string>; venues: Set<string>; activations: Set<string> };
}

interface Options {
  /** Give the fixture rows ids that are NOT in the manifest (same names, same dates, same everything): the catalog as it is without the exclusion. */
  unlistedFixtures?: boolean;
  /** Leave the legitimate rows out. */
  withoutLegit?: boolean;
  /** Leave the fixture rows out entirely: a catalog that never had them. */
  withoutFixtures?: boolean;
}

function unlisted(id: string): string {
  // flips the first hex digit group so the id is a different, valid uuid that is not in the manifest
  return "ffffffff" + id.slice(8);
}

export function buildCatalogWorld(options: Options = {}): CatalogWorld {
  const M = TEMPORARY_FIXTURE_EXCLUSION;
  const fid = (id: string) => (options.unlistedFixtures ? unlisted(id) : id);
  const teams: TeamRecord[] = [];
  const players: PlayerRecord[] = [];
  const matches: MatchRecord[] = [];
  const venues: VenueRecord[] = [];
  const activations: VenueActivationRecord[] = [];
  const tiers: PrizeTierRecord[] = [];
  const results: MatchResultRecord[] = [];

  M.teams.forEach((id, i) => teams.push({ teamId: fid(id), name: `${i % 2 === 0 ? "Real Madrid" : "Barcelona"} ${pad(i, 4)}`, createdAt: CREATED_FIXTURE }));
  teams.forEach((team, i) => {
    const count = i < 40 ? 2 : 1; // 122 players over 82 teams
    for (let k = 0; k < count; k += 1) {
      players.push({ playerId: `d${pad(players.length + 1, 7)}-0000-4000-8000-${pad(players.length + 1)}`, teamId: team.teamId, name: ["Mbappe", "Vini", "Lewandowski", "Pedri"][(i + k) % 4]!, active: true, createdAt: CREATED_FIXTURE });
    }
  });
  M.venues.forEach((id, i) => venues.push({ venueId: fid(id), name: `Fixture Venue ${i}`, latitude: 10, longitude: 10, radiusMeters: 100, active: true, createdAt: CREATED_FIXTURE }));
  M.matches.forEach((id, i) => {
    matches.push({
      matchId: fid(id),
      homeTeamId: teams[(i * 2) % teams.length]!.teamId,
      awayTeamId: teams[(i * 2 + 1) % teams.length]!.teamId,
      competition: i % 3 === 0 ? "Contract Test" : i % 3 === 1 ? "Contract Test — A0" : "Contract Test — A1",
      kickoffAt: "2026-08-25T18:00:00.000Z",
      cancelledAt: i === 5 || i === 17 ? "2026-08-25T18:30:00.000Z" : null, // two were cancelled, as in Production
      activityClassification: i % 2 === 0 ? "RANKED" : null,
      xpEligible: i % 4 === 0 ? true : null,
      predictionContract: "COMPLETE_COUNT_V1",
      createdAt: CREATED_FIXTURE,
    });
  });
  M.activations.forEach((id, i) => {
    activations.push({ venueActivationId: fid(id), matchId: matches[i]!.matchId, venueId: venues[i % venues.length]!.venueId, enabled: true, createdAt: CREATED_FIXTURE });
  });
  [0, 1].forEach((i) => tiers.push({ prizeTierId: `c${pad(i + 1, 7)}-0000-4000-8000-${pad(i + 1)}`, venueActivationId: activations[i]!.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey", ladderLevel: null, createdAt: CREATED_FIXTURE }));
  matches.slice(0, 16).forEach((match, i) => {
    results.push({ matchResultId: `b${pad(i + 1, 7)}-0000-4000-8000-${pad(i + 1)}`, matchId: match.matchId, homeScore: i % 3, awayScore: i % 2, finalizedAt: "2026-08-25T19:00:00.000Z", supersedesMatchResultId: null, enteredByGamingMemberId: "synthetic", finalizedByGamingMemberId: "synthetic" } as MatchResultRecord);
  });

  if (options.withoutFixtures) {
    // a catalog that never had the fixtures: their rows (and everything hanging from them) simply do not exist
    const drop = new Set<string>([...matches.map((m) => m.matchId)].filter((id) => !id.startsWith("e3000000")));
    const dropActs = new Set(activations.filter((a) => drop.has(a.matchId)).map((a) => a.venueActivationId));
    const keep = <T,>(rows: T[], gone: (row: T) => boolean) => { const kept = rows.filter((row) => !gone(row)); rows.length = 0; rows.push(...kept); };
    keep(results, (r) => drop.has(r.matchId));
    keep(tiers, (t) => dropActs.has(t.venueActivationId));
    keep(activations, (a) => dropActs.has(a.venueActivationId));
    keep(matches, (m) => drop.has(m.matchId));
    keep(players, (p) => !p.teamId.startsWith("e1000000"));
    keep(teams, (t) => !t.teamId.startsWith("e1000000"));
    keep(venues, (v) => !v.venueId.startsWith("e4000000"));
  }

  const fixtureIds = {
    matches: new Set(matches.map((m) => m.matchId)),
    teams: new Set(teams.map((t) => t.teamId)),
    venues: new Set(venues.map((v) => v.venueId)),
    activations: new Set(activations.map((a) => a.venueActivationId)),
  };

  const legit: LegitCatalog = { oldMatchId: legitId("match", 1), lookAlikeMatchId: legitId("match", 2), newMatchId: legitId("match", 3), cancelledMatchId: legitId("match", 4), teamIds: [], venueIds: [], activationIds: [] };
  if (!options.withoutLegit) {
    for (let n = 1; n <= 6; n += 1) {
      const teamId = legitId("team", n);
      legit.teamIds.push(teamId);
      teams.push({ teamId, name: `Equipo ${n} (ensayo)`, createdAt: CREATED_LEGIT });
      for (let k = 1; k <= 2; k += 1) players.push({ playerId: legitId("player", n * 10 + k), teamId, name: `Jugador ${n}${k} (ensayo)`, active: true, createdAt: CREATED_LEGIT });
    }
    legit.venueIds.push(legitId("venue", 1), legitId("venue", 2));
    venues.push({ venueId: legit.venueIds[0]!, name: "Sede de ensayo privado", latitude: 1, longitude: 1, radiusMeters: 100, active: true, createdAt: CREATED_LEGIT });
    venues.push({ venueId: legit.venueIds[1]!, name: "Legit Venue", latitude: 2, longitude: 2, radiusMeters: 150, active: true, createdAt: CREATED_LEGIT });
    const base = { cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1" as const, createdAt: CREATED_LEGIT };
    matches.push({ ...base, matchId: legit.oldMatchId, homeTeamId: legit.teamIds[0]!, awayTeamId: legit.teamIds[1]!, competition: "Liga Nacional", kickoffAt: "2020-01-01T20:00:00.000Z", predictionContract: "COMPLETE_COUNT_V1", createdAt: "2020-01-01T10:00:00.000Z" });
    matches.push({ ...base, matchId: legit.lookAlikeMatchId, homeTeamId: legit.teamIds[2]!, awayTeamId: legit.teamIds[3]!, competition: "Contract Test", kickoffAt: "2026-08-25T18:00:00.000Z", activityClassification: "RANKED" });
    matches.push({ ...base, matchId: legit.newMatchId, homeTeamId: legit.teamIds[4]!, awayTeamId: legit.teamIds[5]!, competition: "Ensayo de ubicación — sin valor", kickoffAt: "2099-01-01T20:00:00.000Z", activityClassification: "TRAINING" });
    matches.push({ ...base, matchId: legit.cancelledMatchId, homeTeamId: legit.teamIds[0]!, awayTeamId: legit.teamIds[2]!, competition: "Liga Nacional", kickoffAt: "2099-02-01T20:00:00.000Z", cancelledAt: "2026-10-24T21:00:00.000Z" });
    legit.activationIds.push(legitId("act", 1), legitId("act", 2), legitId("act", 3));
    activations.push({ venueActivationId: legit.activationIds[0]!, matchId: legit.oldMatchId, venueId: legit.venueIds[1]!, enabled: true, createdAt: CREATED_LEGIT });
    activations.push({ venueActivationId: legit.activationIds[1]!, matchId: legit.newMatchId, venueId: legit.venueIds[0]!, enabled: false, createdAt: CREATED_LEGIT });
    activations.push({ venueActivationId: legit.activationIds[2]!, matchId: legit.lookAlikeMatchId, venueId: legit.venueIds[1]!, enabled: true, createdAt: CREATED_LEGIT });
    [1, 2, 3, 4].forEach((level) => tiers.push({ prizeTierId: legitId("tier", level), venueActivationId: legit.activationIds[1]!, correctDimensionCount: 0, prizeLabel: "Simulación", ladderLevel: level, createdAt: CREATED_LEGIT } as PrizeTierRecord));
    results.push({ matchResultId: legitId("result", 1), matchId: legit.oldMatchId, homeScore: 2, awayScore: 1, finalizedAt: "2020-01-01T22:00:00.000Z", supersedesMatchResultId: null, enteredByGamingMemberId: "real", finalizedByGamingMemberId: "real" } as MatchResultRecord);
  }

  const calls: RepoCall[] = [];
  const log = (method: string, arg: string | null) => { calls.push([method, arg]); };
  const repo: CatalogWorld["repo"] = {
    listMatches: async () => { log("listMatches", null); return matches.map((m) => ({ ...m })); },
    listTeams: async () => { log("listTeams", null); return teams.map((t) => ({ ...t })); },
    listVenues: async () => { log("listVenues", null); return venues.map((v) => ({ ...v })); },
    getTeamById: async (id: string) => { log("getTeamById", id); return teams.find((t) => t.teamId === id) ?? null; },
    listPlayersForTeam: async (id: string) => { log("listPlayersForTeam", id); return players.filter((p) => p.teamId === id); },
    listVenueActivationsForMatch: async (id: string) => { log("listVenueActivationsForMatch", id); return activations.filter((a) => a.matchId === id); },
    getVenueById: async (id: string) => { log("getVenueById", id); return venues.find((v) => v.venueId === id) ?? null; },
    listPrizeTiersForActivation: async (id: string) => { log("listPrizeTiersForActivation", id); return tiers.filter((t) => t.venueActivationId === id); },
    getCurrentFinalizedMatchResult: async (id: string) => { log("getCurrentFinalizedMatchResult", id); return results.find((r) => r.matchId === id) ?? null; },
  };

  return { matches, teams, players, venues, activations, tiers, results, legit, calls, repo, fixtureIds };
}

/** The calls grouped by method and sorted, so two runs can be compared whatever order the concurrent queries finished in. */
export function callSignature(calls: RepoCall[]): string[] {
  return calls.map(([method, arg]) => `${method}:${arg ?? ""}`).sort();
}

export function callCount(calls: RepoCall[], method?: string): number {
  return method ? calls.filter(([m]) => m === method).length : calls.length;
}

/** Every id a call was made with that belongs to the given set. */
export function callsTouching(calls: RepoCall[], ids: Set<string>): RepoCall[] {
  return calls.filter(([, arg]) => arg !== null && ids.has(arg));
}
