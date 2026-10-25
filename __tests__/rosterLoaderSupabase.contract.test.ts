/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { loadEnv } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { CLASICO_ROSTER_SNAPSHOT, type RosterSnapshot } from "../lib/gaming/predictions/rosters/clasicoRosterSnapshot";
import { assertLoopbackDatabaseUrl, loadRoster } from "../lib/gaming/predictions/rosters/localRosterLoader";
import { GET as publicMatches } from "../app/api/gaming/predictions/matches/route";
import { ROSTER_COLUMNS_PROPOSAL_SQL } from "./helpers/rosterColumnsProposal";
import { localSettlementDatabaseUrl } from "./helpers/localSettlementCleanup";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * THE LOCAL ROSTER LOADER against a real LOCAL Postgres, with the documented roster columns applied to that disposable database (the
 * proposal is test-only text; no migration exists). It proves what the pure tests cannot: that the whole Clásico snapshot (53 players) lands
 * correctly under the database's own constraints, that a second run changes nothing and keeps every id, that an existing player is updated
 * in place rather than duplicated, that nothing is deleted or deactivated, that a failed load leaves nothing behind, and that the
 * repository and the public route read the result. The team names carry a random suffix so a real "FC Barcelona" in the database is never
 * touched; everything this file creates is removed.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
const dbUrl = localSettlementDatabaseUrl();
assertLoopbackDatabaseUrl(dbUrl);

const repo = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const suffix = randomUUID().slice(0, 8);
const teamNames = [`Contract Roster FC Barcelona ${suffix}`, `Contract Roster Real Madrid CF ${suffix}`];
const snapshot: RosterSnapshot = { id: `contract-${suffix}`, teams: CLASICO_ROSTER_SNAPSHOT.teams.map((team, i) => ({ ...team, teamName: teamNames[i] })) };

let db: Client;
const createdMatches: string[] = [];

const teamIdsByName = async () => {
  const rows = (await db.query("select team_id, name from teams where name = any($1)", [teamNames])).rows;
  return Object.fromEntries(rows.map((row) => [row.name as string, row.team_id as string]));
};
const playersOf = async (teamName: string) => {
  const teamId = (await teamIdsByName())[teamName];
  return (await db.query("select * from players where team_id = $1 order by jersey_number nulls last, name", [teamId])).rows;
};
const countRows = async () => ({
  teams: Number((await db.query("select count(*) from teams where name = any($1)", [teamNames])).rows[0].count),
  players: Number((await db.query("select count(*) from players where team_id in (select team_id from teams where name = any($1))", [teamNames])).rows[0].count),
});

beforeAll(async () => {
  db = new Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(ROSTER_COLUMNS_PROPOSAL_SQL);
});

afterAll(async () => {
  try {
    const teamIds = Object.values(await teamIdsByName());
    if (createdMatches.length > 0) await db.query("delete from matches where match_id = any($1)", [createdMatches]);
    if (teamIds.length > 0) {
      await db.query("delete from players where team_id = any($1)", [teamIds]);
      await db.query("delete from teams where team_id = any($1)", [teamIds]);
    }
  } finally {
    await db.end();
  }
});

describe("planning writes nothing", () => {
  it("shows what would be created and leaves the database exactly as it was", async () => {
    const before = await countRows();
    const result = await loadRoster(db, snapshot, { apply: false });
    expect(result.applied).toBe(false);
    expect(result.columnsPresent).toBe(true);
    expect(result.summary).toMatchObject({ creates: 53, updates: 0, unchanged: 0, teamsToCreate: 2 });
    expect(await countRows()).toEqual(before);
    expect(before).toEqual({ teams: 0, players: 0 });
  });
});

describe("applying the Clásico snapshot", () => {
  it("creates both teams and all 53 players under the database's own constraints, with provenance on every row", async () => {
    const result = await loadRoster(db, snapshot, { apply: true });
    expect(result.refusal).toBeNull();
    expect(result.applied).toBe(true);
    expect(result.summary).toMatchObject({ creates: 53, teamsToCreate: 2 });
    expect(result.planAfter).toMatchObject({ creates: 0, updates: 0, teamsToCreate: 0, unchanged: 53 });
    const barcelona = await playersOf(teamNames[0]);
    const madrid = await playersOf(teamNames[1]);
    expect([barcelona.length, madrid.length]).toEqual([27, 26]);
    const byPosition = (rows: any[]) => Object.fromEntries(["POR", "DEF", "MED", "DEL"].map((p) => [p, rows.filter((r) => r.position === p).length]));
    expect(byPosition(barcelona)).toEqual({ POR: 3, DEF: 8, MED: 8, DEL: 8 });
    expect(byPosition(madrid)).toEqual({ POR: 2, DEF: 10, MED: 7, DEL: 7 });
    for (const row of [...barcelona, ...madrid]) {
      expect(row.active).toBe(true); // a roster switches nobody off
      expect(row.roster_source).toMatch(/^(fcbarcelona\.es|realmadrid\.com) · .* — https:\/\//);
      expect(String(row.roster_consulted_on instanceof Date ? row.roster_consulted_on.toISOString().slice(0, 10) : row.roster_consulted_on)).toMatch(/^2026-10-2[45]/);
    }
    const hamza = barcelona.find((row) => row.jersey_number === 29)!;
    expect(hamza.name).toBe("Hamza Mohamed Abdelkarim Elsayed Selim");
    expect(madrid.map((row) => row.name)).toContain("E. Militão"); // as published, not expanded
  });

  it("a second run changes nothing and every id is exactly the one the database gave the first time", async () => {
    const idsBefore = [...(await playersOf(teamNames[0])), ...(await playersOf(teamNames[1]))].map((row) => row.player_id).sort();
    const rowsBefore = await db.query("select player_id, name, jersey_number, position, roster_source, roster_consulted_on, active, created_at from players where player_id = any($1) order by player_id", [idsBefore]);
    const again = await loadRoster(db, snapshot, { apply: true });
    expect(again.applied).toBe(true);
    expect(again.summary).toMatchObject({ creates: 0, updates: 0, unchanged: 53, teamsToCreate: 0 });
    const idsAfter = [...(await playersOf(teamNames[0])), ...(await playersOf(teamNames[1]))].map((row) => row.player_id).sort();
    expect(idsAfter).toEqual(idsBefore);
    const rowsAfter = await db.query("select player_id, name, jersey_number, position, roster_source, roster_consulted_on, active, created_at from players where player_id = any($1) order by player_id", [idsBefore]);
    expect(rowsAfter.rows).toEqual(rowsBefore.rows);
  });

  it("is the same snapshot on a third run even after the loader is called twice in a row (no growth)", async () => {
    await loadRoster(db, snapshot, { apply: true });
    expect(await countRows()).toEqual({ teams: 2, players: 53 });
  });
});

describe("nothing a person did is undone", () => {
  it("never deactivates, deletes or renames a player the roster does not mention, and a player a person switched off stays switched off", async () => {
    const teamId = (await teamIdsByName())[teamNames[0]];
    const hand = (await db.query("insert into players (team_id, name) values ($1, $2) returning player_id", [teamId, "Jugador de prueba"])).rows[0].player_id as string;
    const yamal = (await playersOf(teamNames[0])).find((row) => row.jersey_number === 10)!;
    await db.query("update players set active = false where player_id = $1", [yamal.player_id]); // a person's decision
    const result = await loadRoster(db, snapshot, { apply: true });
    expect(result.summary.untouched).toBe(1);
    const handRow = (await db.query("select name, active, jersey_number from players where player_id = $1", [hand])).rows[0];
    expect(handRow).toEqual({ name: "Jugador de prueba", active: true, jersey_number: null });
    const yamalRow = (await db.query("select active, jersey_number, name from players where player_id = $1", [yamal.player_id])).rows[0];
    expect(yamalRow).toEqual({ active: false, jersey_number: 10, name: "Lamine Yamal" }); // found again by name; still off
    await db.query("update players set active = true where player_id = $1", [yamal.player_id]);
    await db.query("delete from players where player_id = $1", [hand]);
  });
});

describe("reconciling with players that already exist", () => {
  it("updates an existing player in place (same id, no duplicate) and reports a near match without merging it", async () => {
    const suffix2 = randomUUID().slice(0, 8);
    const names = [`Contract Reconcile FC Barcelona ${suffix2}`];
    const small: RosterSnapshot = { id: "small", teams: [{ ...CLASICO_ROSTER_SNAPSHOT.teams[0], teamName: names[0], players: CLASICO_ROSTER_SNAPSHOT.teams[0].players.filter((p) => ["Pedri", "João Cancelo", "Lamine Yamal"].includes(p.name)) }] };
    const team = (await db.query("insert into teams (name) values ($1) returning team_id", [names[0]])).rows[0].team_id as string;
    try {
      const pedri = (await db.query("insert into players (team_id, name) values ($1, $2) returning player_id", [team, "pedri "])).rows[0].player_id as string;
      const cancelo = (await db.query("insert into players (team_id, name) values ($1, $2) returning player_id", [team, "Cancelo"])).rows[0].player_id as string;
      const planOnly = await loadRoster(db, small, { apply: false });
      expect(planOnly.plan.teams[0].team).toMatchObject({ action: "reuse", teamId: team });
      expect(planOnly.plan.teams[0].playersToReview.map((r) => [r.existing.name, r.possibleEntries.map((e) => e.name)])).toEqual([["Cancelo", ["João Cancelo"]]]);
      const applied = await loadRoster(db, small, { apply: true });
      expect(applied.summary).toMatchObject({ creates: 2, updates: 1, unchanged: 0, untouched: 1 });
      const rows = (await db.query("select player_id, name, jersey_number, position from players where team_id = $1 order by name", [team])).rows;
      expect(rows).toHaveLength(4); // pedri updated in place, "Cancelo" untouched, João Cancelo and Lamine Yamal created
      expect(rows.find((r) => r.player_id === pedri)).toMatchObject({ name: "Pedri", jersey_number: 8, position: "MED" });
      expect(rows.find((r) => r.player_id === cancelo)).toMatchObject({ name: "Cancelo", jersey_number: null });
    } finally {
      await db.query("delete from players where team_id = $1", [team]);
      await db.query("delete from teams where team_id = $1", [team]);
    }
  });

  it("a load that fails midway leaves nothing behind", async () => {
    const suffix3 = randomUUID().slice(0, 8);
    const name = `Contract Atomic FC Barcelona ${suffix3}`;
    const team = (await db.query("insert into teams (name) values ($1) returning team_id", [name])).rows[0].team_id as string;
    try {
      // a person already gave an ACTIVE player squad number 10: the roster's number 10 for somebody else cannot be placed beside it
      await db.query("insert into players (team_id, name, jersey_number, position, roster_source, roster_consulted_on) values ($1, 'Otro Diez', 10, 'DEL', 'by hand', '2026-10-24')", [team]);
      const twoEntries: RosterSnapshot = { id: "atomic", teams: [{ ...CLASICO_ROSTER_SNAPSHOT.teams[0], teamName: name, players: CLASICO_ROSTER_SNAPSHOT.teams[0].players.filter((p) => ["Pedri", "Lamine Yamal"].includes(p.name)) }] };
      await expect(loadRoster(db, twoEntries, { apply: true })).rejects.toThrow(/players_team_active_jersey_uidx|duplicate key/);
      const rows = (await db.query("select name from players where team_id = $1", [team])).rows;
      expect(rows.map((r) => r.name)).toEqual(["Otro Diez"]); // Pedri, created before the conflict, was rolled back with it
    } finally {
      await db.query("delete from players where team_id = $1", [team]);
      await db.query("delete from teams where team_id = $1", [team]);
    }
  });
});

describe("the documented constraints, at the database", () => {
  const insert = (team: string, name: string, extra: Record<string, unknown>) =>
    db.query("insert into players (team_id, name, jersey_number, position, roster_source, roster_consulted_on) values ($1, $2, $3, $4, $5, $6)", [team, name, extra.n ?? null, extra.pos ?? null, "src" in extra ? extra.src : "source", "date" in extra ? extra.date : "2026-10-24"]);
  it("refuses a repeated active squad number in a team, a number outside 0-99, an unknown position and a number with no provenance", async () => {
    const team = (await db.query("insert into teams (name) values ($1) returning team_id", [`Contract Constraints ${randomUUID().slice(0, 8)}`])).rows[0].team_id as string;
    try {
      await insert(team, "Uno", { n: 7, pos: "DEL" });
      await expect(insert(team, "Dos", { n: 7, pos: "MED" })).rejects.toMatchObject({ code: "23505" });
      await expect(insert(team, "Tres", { n: 100, pos: "MED" })).rejects.toMatchObject({ code: "23514" });
      await expect(insert(team, "Cuatro", { n: 5, pos: "GK" })).rejects.toMatchObject({ code: "23514" });
      await expect(insert(team, "Cinco", { n: 6, pos: "DEF", src: null })).rejects.toMatchObject({ code: "23514" });
      await expect(insert(team, "Seis", { n: 8, pos: "DEF", date: null })).rejects.toMatchObject({ code: "23514" });
      await db.query("update players set active = false where name = 'Uno' and team_id = $1", [team]);
      await insert(team, "Siete", { n: 7, pos: "MED" }); // the number of a player who is no longer active can be given again
      await insert(team, "Sin numero", {}); // a player added by hand has no number, no position, and needs no provenance
    } finally {
      await db.query("delete from players where team_id = $1", [team]);
      await db.query("delete from teams where team_id = $1", [team]);
    }
  });
});

describe("what the application reads", () => {
  it("the repository maps the roster fields, and the public route exposes the id, the name and the squad number — home team first — and nothing else", async () => {
    const ids = await teamIdsByName();
    const match = await repo.createMatch({ homeTeamId: ids[teamNames[0]], awayTeamId: ids[teamNames[1]], competition: `Contract roster ${suffix}`, kickoffAt: new Date(Date.now() + 86_400_000).toISOString() });
    createdMatches.push(match.matchId);
    const players = await repo.listPlayersForTeam(ids[teamNames[0]]);
    const yamal = players.find((p) => p.name === "Lamine Yamal")!;
    expect(yamal).toMatchObject({ jerseyNumber: 10, position: "DEL" });
    expect(yamal.rosterSource).toMatch(/fcbarcelona\.es/);
    expect((await repo.getPlayersByIds([yamal.playerId]))[0].jerseyNumber).toBe(10);

    const body = (await (await publicMatches()).json()) as { matches: any[] };
    const ours = body.matches.find((m) => m.matchId === match.matchId)!;
    expect(ours.homeTeam.name).toBe(teamNames[0]);
    expect(ours.awayTeam.name).toBe(teamNames[1]);
    expect(ours.homeTeam.players).toHaveLength(27);
    expect(ours.awayTeam.players).toHaveLength(26);
    for (const player of [...ours.homeTeam.players, ...ours.awayTeam.players]) expect(Object.keys(player).sort()).toEqual(["jerseyNumber", "name", "playerId"]);
    expect(JSON.stringify(ours)).not.toMatch(/"position"|roster_|rosterSource|rosterConsultedOn|fcbarcelona\.es|realmadrid\.com/);
    expect(ours.homeTeam.players.find((p: any) => p.name === "Lamine Yamal")).toMatchObject({ playerId: yamal.playerId, jerseyNumber: 10 });
  });
});
