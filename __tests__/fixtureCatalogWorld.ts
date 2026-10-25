import { REHEARSAL_FIXTURE_EXCLUSION, TEMPORARY_FIXTURE_EXCLUSION } from "@/lib/gaming/predictions/fixtureExclusionManifest";
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
  /** Present with `withRehearsal`: the rows of our own rehearsals (exact ids of the second batch) and the rows that must stay visible beside them. */
  rehearsal: RehearsalCatalog | null;
}

export interface RehearsalCatalog {
  /** The exact rehearsal rows (second batch): hidden by default, listed with ?includeFixtures=1. */
  ids: { matches: Set<string>; teams: Set<string>; activations: Set<string>; players: Set<string>; tiers: Set<string> };
  /** The REAL El Clasico as the preparation script created it: new ids, disabled activation, at the real venue. Never hidden. */
  clasico: { matchId: string; homeTeamId: string; awayTeamId: string; activationId: string; venueId: string };
  /** Real venues of Production that the real flow uses, plus the 15 m copy a rehearsal made: none of them is a fixture. */
  venueIds: { thePub: string; fincaOcho: string; fincaOcho15m: string };
  /** A team and a match that carry EXACTLY the names of the rehearsal rows but were created later, with new ids. Never hidden. */
  sameNameNewIds: { teamId: string; matchId: string };
}

interface Options {
  /** Give the fixture rows ids that are NOT in the manifest (same names, same dates, same everything): the catalog as it is without the exclusion. */
  unlistedFixtures?: boolean;
  /** Leave the legitimate rows out. */
  withoutLegit?: boolean;
  /** Leave the fixture rows out entirely: a catalog that never had them. */
  withoutFixtures?: boolean;
  /** Add the rows of our own rehearsals (exact ids of the second batch) and the real rows that must stay visible beside them. */
  withRehearsal?: boolean;
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

  let rehearsal: RehearsalCatalog | null = null;
  if (options.withRehearsal) {
    const R = REHEARSAL_FIXTURE_EXCLUSION;
    const CREATED_REHEARSAL = "2026-10-25T00:10:13.926831+00:00";
    const [teamA, teamB] = [R.teams[1]!, R.teams[0]!]; // eab01687 = "Equipo A (ensayo)", 9bd7171b = "Equipo B (ensayo)"
    teams.push({ teamId: teamA, name: "Equipo A (ensayo)", createdAt: CREATED_REHEARSAL }, { teamId: teamB, name: "Equipo B (ensayo)", createdAt: CREATED_REHEARSAL });
    const rehearsalPlayers = R.playersReachedThroughTheirTeam.map((playerId, i) => ({ playerId, teamId: i < 2 ? teamA : teamB, name: `Jugador ${i < 2 ? "A" : "B"}${(i % 2) + 1} (ensayo)`, active: true, createdAt: CREATED_REHEARSAL }));
    players.push(...rehearsalPlayers);
    const competitions = ["ENSAYO — sin premios reales · The Pub", "ENSAYO — sin premios reales · Finca Ocho", "ENSAYO — sin premios reales · Finca Ocho (15 m)"];
    const finca = "2105dd59-3131-4735-8ea3-e98fef64e557", finca15 = "1ab69d0b-aa72-4e64-bdba-d0d29d9d359d", thePub = "703657cc-2f77-4c96-bf33-c22aa8bd8247";
    venues.push(
      { venueId: thePub, name: "The Pub by Beer Box", latitude: 14.099309, longitude: -87.180864, radiusMeters: 30.48, active: true, createdAt: CREATED_REHEARSAL },
      { venueId: finca, name: "Finca Ocho • Plaza San Rafael", latitude: 14.086665, longitude: -87.187477, radiusMeters: 30.48, active: true, createdAt: CREATED_REHEARSAL },
      { venueId: finca15, name: "Finca Ocho • Plaza San Rafael · 15 m", latitude: 14.086665, longitude: -87.187477, radiusMeters: 15, active: true, createdAt: CREATED_REHEARSAL }
    );
    const rehearsalVenues = [thePub, finca, finca15];
    const tierIds = new Set<string>();
    R.matches.forEach((matchId, i) => {
      matches.push({ matchId, homeTeamId: teamA, awayTeamId: teamB, competition: competitions[i]!, kickoffAt: "2026-10-25T01:10:47.472559+00:00", cancelledAt: "2026-10-25T00:36:20.695495+00:00", activityClassification: "TRAINING", xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1", createdAt: CREATED_REHEARSAL });
      const venueActivationId = R.activations[i]!;
      activations.push({ venueActivationId, matchId, venueId: rehearsalVenues[i]!, enabled: false, createdAt: CREATED_REHEARSAL });
      [1, 2, 3, 4].forEach((level) => {
        const prizeTierId = `f${pad(i * 10 + level, 7)}-0000-4000-8000-${pad(i * 10 + level)}`;
        tierIds.add(prizeTierId);
        tiers.push({ prizeTierId, venueActivationId, correctDimensionCount: null, ladderLevel: level, prizeLabel: "Simulación, sin valor ni entrega", createdAt: CREATED_REHEARSAL });
      });
    });
    // the REAL Clasico: new ids, FC Barcelona home, the disabled activation at The Pub
    const clasico = { matchId: "ad72e2e2-dad0-48ef-8e7a-7d8369d37af6", homeTeamId: "e6a1db23-c8d2-4bdf-9b03-af1815ab94fd", awayTeamId: "e6a1db23-0000-4000-8000-000000000002", activationId: "5f9ea3d1-9892-4d72-a1d0-c5c1d458d93a", venueId: thePub };
    teams.push({ teamId: clasico.homeTeamId, name: "FC Barcelona", createdAt: "2026-10-25T17:24:00.000Z" }, { teamId: clasico.awayTeamId, name: "Real Madrid CF", createdAt: "2026-10-25T17:24:00.000Z" });
    players.push({ playerId: "e6a1db23-0000-4000-8000-000000000011", teamId: clasico.homeTeamId, name: "Pedri", active: true, createdAt: "2026-10-25T17:24:00.000Z" }, { playerId: "e6a1db23-0000-4000-8000-000000000012", teamId: clasico.awayTeamId, name: "Vinícius Júnior", active: true, createdAt: "2026-10-25T17:24:00.000Z" });
    matches.push({ matchId: clasico.matchId, homeTeamId: clasico.homeTeamId, awayTeamId: clasico.awayTeamId, competition: "El Clásico", kickoffAt: "2026-10-25T20:00:00+00:00", cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1", createdAt: "2026-10-25T17:24:00.000Z" });
    activations.push({ venueActivationId: clasico.activationId, matchId: clasico.matchId, venueId: thePub, enabled: false, createdAt: "2026-10-25T17:24:00.000Z" });
    // a row made later with EXACTLY the same names as a rehearsal row, and a new id: nothing about the name may hide it
    const sameNameNewIds = { teamId: "a1a1a1a1-0000-4000-8000-00000000a001", matchId: "a1a1a1a1-0000-4000-8000-00000000a002" };
    teams.push({ teamId: sameNameNewIds.teamId, name: "Equipo A (ensayo)", createdAt: "2026-10-25T18:00:00.000Z" });
    matches.push({ matchId: sameNameNewIds.matchId, homeTeamId: sameNameNewIds.teamId, awayTeamId: clasico.awayTeamId, competition: "ENSAYO — sin premios reales · The Pub", kickoffAt: "2099-03-01T20:00:00.000Z", cancelledAt: null, activityClassification: "TRAINING", xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1", createdAt: "2026-10-25T18:00:00.000Z" });
    rehearsal = {
      ids: { matches: new Set<string>(R.matches), teams: new Set<string>(R.teams), activations: new Set<string>(R.activations), players: new Set(rehearsalPlayers.map((p) => p.playerId)), tiers: tierIds },
      clasico,
      venueIds: { thePub, fincaOcho: finca, fincaOcho15m: finca15 },
      sameNameNewIds,
    };
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

  return { matches, teams, players, venues, activations, tiers, results, legit, calls, repo, fixtureIds, rehearsal };
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
