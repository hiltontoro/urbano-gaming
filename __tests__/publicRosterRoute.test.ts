import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { CLASICO_ROSTER_SNAPSHOT } from "../lib/gaming/predictions/rosters/clasicoRosterSnapshot";

/**
 * THE PUBLIC ROSTER (GET /api/gaming/predictions/matches), with the Clásico rosters loaded as the local loader leaves them: each team's
 * own players, each as its stable id, its name and its squad number — and nothing else about the person. The roster is not a call-up:
 * nothing here switches a player off, and the order of the two teams is the order of the match (home first), never re-sorted.
 */

const world = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("@/lib/gaming/predictions/httpAuth", () => ({
  getSupabaseCredentials: () => ({ url: "http://localhost:1", serviceKey: "stand-in" }),
  buildPredictionsRepo: () => world.repo,
}));
import { GET as publicMatches } from "@/app/api/gaming/predictions/matches/route";

async function loadedClasico() {
  const repo = new InMemoryPredictionsRepository();
  const ids: Record<string, string> = {};
  const teamIds: string[] = [];
  for (const squad of CLASICO_ROSTER_SNAPSHOT.teams) {
    const team = await repo.createTeam({ name: squad.teamName });
    teamIds.push(team.teamId);
    for (const entry of squad.players) {
      const player = await repo.createPlayer({ teamId: team.teamId, name: entry.name });
      repo.setRosterFields(player.playerId, { jerseyNumber: entry.jerseyNumber, position: entry.position, rosterSource: `${squad.source.label} — ${squad.source.url}`, rosterConsultedOn: squad.source.consultedOn });
      ids[`${squad.teamName}/${entry.jerseyNumber}`] = player.playerId;
    }
  }
  // FC Barcelona is the home team: it is the first team of the match
  const match = await repo.createMatch({ homeTeamId: teamIds[0], awayTeamId: teamIds[1], competition: "LaLiga", kickoffAt: new Date(Date.now() + 86_400_000).toISOString() });
  world.repo = repo;
  return { repo, ids, teamIds, match };
}

const ask = async () => ((await (await publicMatches()).json()) as { matches: any[] }).matches;

describe("the public roster of El Clásico", () => {
  beforeEach(() => { world.repo = null; });

  it("lists the home team first with its own 27 players and the away team second with its own 26, each player as id, name and squad number", async () => {
    await loadedClasico();
    const [match] = await ask();
    expect(match.homeTeam.name).toBe("FC Barcelona");
    expect(match.awayTeam.name).toBe("Real Madrid CF");
    expect(match.homeTeam.players).toHaveLength(27);
    expect(match.awayTeam.players).toHaveLength(26);
    for (const player of [...match.homeTeam.players, ...match.awayTeam.players]) expect(Object.keys(player).sort()).toEqual(["jerseyNumber", "name", "playerId"]);
    const yamal = match.homeTeam.players.find((p: any) => p.name === "Lamine Yamal");
    expect(yamal.jerseyNumber).toBe(10);
    expect(match.awayTeam.players.find((p: any) => p.name === "Mbappé").jerseyNumber).toBe(10);
    expect(match.awayTeam.players.find((p: any) => p.name === "Hamza Mohamed Abdelkarim Elsayed Selim")).toBeUndefined(); // he is Barcelona's
    expect(match.homeTeam.players.find((p: any) => p.name === "Hamza Mohamed Abdelkarim Elsayed Selim").jerseyNumber).toBe(29);
  });

  it("exposes nothing else about a player: no position, no source, no date of consultation", async () => {
    await loadedClasico();
    const raw = JSON.stringify(await ask());
    expect(raw).not.toMatch(/"position"|rosterSource|rosterConsultedOn|roster_|fcbarcelona\.es|realmadrid\.com|consultedOn|2026-10-24/);
    expect(raw).not.toMatch(/"(POR|DEF|MED|DEL)"/);
  });

  it("keeps a player's id when the roster is read again, and a player added by hand beside the roster has no squad number", async () => {
    const { repo, teamIds } = await loadedClasico();
    const first = (await ask())[0];
    const hand = await repo.createPlayer({ teamId: teamIds[0], name: "Jugador de prueba" });
    const second = (await ask())[0];
    expect(second.homeTeam.players.filter((p: any) => p.name !== "Jugador de prueba").map((p: any) => p.playerId).sort()).toEqual(first.homeTeam.players.map((p: any) => p.playerId).sort());
    expect(second.homeTeam.players.find((p: any) => p.playerId === hand.playerId).jerseyNumber).toBeNull();
  });

  it("a roster does not switch anybody off: only a deliberate deactivation hides a player, and loading never does it", async () => {
    const { repo, ids } = await loadedClasico();
    expect((await ask())[0].homeTeam.players).toHaveLength(27);
    await repo.setPlayerActive(ids["FC Barcelona/10"], false); // a person's decision, not the roster's
    const homePlayers = (await ask())[0].homeTeam.players;
    expect(homePlayers).toHaveLength(26);
    expect(homePlayers.find((p: any) => p.name === "Lamine Yamal")).toBeUndefined();
  });
});
