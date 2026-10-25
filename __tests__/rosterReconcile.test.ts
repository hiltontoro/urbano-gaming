import { describe, expect, it } from "vitest";

import { CLASICO_ROSTER_SNAPSHOT, type RosterSnapshot, type RosterTeamSnapshot } from "../lib/gaming/predictions/rosters/clasicoRosterSnapshot";
import { NotLocalDatabaseError, assertLoopbackDatabaseUrl, loadRoster, type SqlClient } from "../lib/gaming/predictions/rosters/localRosterLoader";
import { normalizeRosterName, planRosterLoad, summarizePlan, validateRosterSnapshot } from "../lib/gaming/predictions/rosters/reconcile";
import type { PlayerRecord } from "../lib/gaming/predictions/types";

/**
 * ROSTER RECONCILIATION — what loading the Clásico rosters would do, and what it must never do. Pure logic, no database: the same logic
 * runs under the local loader, whose contract against a real Postgres is in rosterLoaderSupabase.contract.test.ts.
 */

const team = (name: string, players: RosterTeamSnapshot["players"]): RosterTeamSnapshot => ({
  teamName: name,
  source: { label: "Club page", url: "https://example.com/squad", consultedOn: "2026-10-24", consultedAtUtc: "2026-10-25T05:13:40Z" },
  players,
});
const snapshot = (...teams: RosterTeamSnapshot[]): RosterSnapshot => ({ id: "test", teams });
const existingPlayer = (over: Partial<PlayerRecord> & { name: string; teamId: string }): PlayerRecord => ({
  playerId: over.playerId ?? `player-${over.name}`,
  teamId: over.teamId,
  name: over.name,
  active: over.active ?? true,
  createdAt: "2026-08-25T00:00:00.000Z",
  jerseyNumber: over.jerseyNumber ?? null,
  position: over.position ?? null,
  rosterSource: over.rosterSource ?? null,
  rosterConsultedOn: over.rosterConsultedOn ?? null,
});

describe("the Clásico roster snapshot", () => {
  const barcelona = CLASICO_ROSTER_SNAPSHOT.teams[0];
  const madrid = CLASICO_ROSTER_SNAPSHOT.teams[1];

  it("is valid: no repeated name, no repeated squad number, whole numbers 0–99, four positions", () => {
    expect(validateRosterSnapshot(CLASICO_ROSTER_SNAPSHOT)).toEqual([]);
  });

  it("is exactly the two squads that were read, home first: 27 for FC Barcelona and 26 for Real Madrid CF, 53 entries", () => {
    expect(CLASICO_ROSTER_SNAPSHOT.teams.map((t) => t.teamName)).toEqual(["FC Barcelona", "Real Madrid CF"]);
    expect(barcelona.players).toHaveLength(27);
    expect(madrid.players).toHaveLength(26);
  });

  it("keeps names as the clubs publish them (abbreviations are not expanded) and the long one whole", () => {
    const names = madrid.players.map((p) => p.name);
    for (const published of ["E. Militão", "Á. Carreras", "F. Mendy", "C. Espí", "Vini Jr.", "Rüdiger", "Endrick"]) expect(names).toContain(published);
    expect(names).not.toContain("Éder Militão");
    expect(barcelona.players.map((p) => p.name)).toContain("Hamza Mohamed Abdelkarim Elsayed Selim");
  });

  it("has both Real Madrid goalkeepers, confirmed on the club's own page, and the positions it was told", () => {
    const goalkeepers = madrid.players.filter((p) => p.position === "POR").map((p) => `${p.jerseyNumber} ${p.name}`);
    expect(goalkeepers).toEqual(["1 Courtois", "13 Lunin"]);
    expect(madrid.players.find((p) => p.name === "Brahim")?.position).toBe("DEL"); // the profile label, not the heading it is listed under
    expect(madrid.players.find((p) => p.name === "Thiago")?.position).toBe("MED"); // the label is published in Spanish
    expect(barcelona.players.filter((p) => p.position === "POR")).toHaveLength(3);
  });

  it("carries provenance for every team and stores nothing beyond name, squad number and position per player", () => {
    for (const t of CLASICO_ROSTER_SNAPSHOT.teams) {
      expect(t.source.consultedOn).toBe("2026-10-24");
      expect(t.source.url).toMatch(/^https:\/\/www\.(fcbarcelona\.es|realmadrid\.com)\//);
      for (const p of t.players) expect(Object.keys(p).sort()).toEqual(["jerseyNumber", "name", "position"]);
    }
  });
});

describe("validation of a snapshot", () => {
  const bad = (players: RosterTeamSnapshot["players"]) => validateRosterSnapshot(snapshot(team("Club", players)));

  it("rejects a repeated name even when only accents, case or spacing differ", () => {
    expect(bad([{ name: "José Pérez", jerseyNumber: 1, position: "POR" }, { name: "jose  perez", jerseyNumber: 2, position: "DEF" }]).join("|")).toMatch(/name repeats/);
  });
  it("rejects a repeated squad number inside a team, but allows it across teams", () => {
    expect(bad([{ name: "A One", jerseyNumber: 7, position: "DEL" }, { name: "B Two", jerseyNumber: 7, position: "MED" }]).join("|")).toMatch(/squad number 7 repeats/);
    expect(validateRosterSnapshot(snapshot(team("Club A", [{ name: "A One", jerseyNumber: 7, position: "DEL" }]), team("Club B", [{ name: "B Two", jerseyNumber: 7, position: "DEL" }])))).toEqual([]);
  });
  it("rejects a number that is not a whole number from 0 to 99, an unknown position, and stray spaces in a name", () => {
    expect(bad([{ name: "A One", jerseyNumber: 100, position: "DEL" }]).join("|")).toMatch(/not a whole number/);
    expect(bad([{ name: "A One", jerseyNumber: 1.5, position: "DEL" }]).join("|")).toMatch(/not a whole number/);
    expect(bad([{ name: "A One", jerseyNumber: 3, position: "GK" as never }]).join("|")).toMatch(/position "GK"/);
    expect(bad([{ name: " A One", jerseyNumber: 3, position: "DEL" }]).join("|")).toMatch(/stray spaces/);
  });
  it("a snapshot with a problem yields no plan at all", () => {
    const plan = planRosterLoad(snapshot(team("Club", [{ name: "A One", jerseyNumber: 7, position: "DEL" }, { name: "B Two", jerseyNumber: 7, position: "MED" }])), [], new Map());
    expect(plan.problems.length).toBeGreaterThan(0);
    expect(plan.teams).toEqual([]);
  });
});

describe("normalisation of names", () => {
  it.each([
    ["Á. Carreras", "a carreras"],
    ["Vini Jr.", "vini jr"],
    ["  João   Cancelo ", "joao cancelo"],
    ["Tchouaméni", "tchouameni"],
  ])("%s → %s", (input, expected) => expect(normalizeRosterName(input)).toBe(expected));
});

describe("reconciling with what exists", () => {
  const snap = snapshot(
    team("FC Barcelona", [
      { name: "Lamine Yamal", jerseyNumber: 10, position: "DEL" },
      { name: "Pedri", jerseyNumber: 8, position: "MED" },
      { name: "João Cancelo", jerseyNumber: 2, position: "DEF" },
    ])
  );

  it("creates the team and every player when nothing exists, and never reuses a contract-test fixture team that merely resembles the club", () => {
    const fixture = { teamId: "t-fixture", name: "Barcelona c54ae13a" };
    const plan = planRosterLoad(snap, [fixture, { teamId: "t-real-madrid", name: "Real Madrid 3232428e" }], new Map([[fixture.teamId, [existingPlayer({ teamId: fixture.teamId, name: "Pedri" })]]]));
    const only = plan.teams[0];
    expect(only.team).toEqual({ action: "create" });
    expect(only.actions.map((a) => a.kind)).toEqual(["create", "create", "create"]);
    expect(only.teamsToReview.map((t) => t.name)).toEqual(["Barcelona c54ae13a"]); // reported for a person, never reused
    expect(only.untouched).toEqual([]);
  });

  it("an existing player is the SAME player: updated in place with its own id, never inserted next to it", () => {
    const teamId = "t1";
    const pedri = existingPlayer({ teamId, name: "pedri ", playerId: "id-pedri" });
    const plan = planRosterLoad(snap, [{ teamId, name: "FC Barcelona" }], new Map([[teamId, [pedri]]]));
    const pedriAction = plan.teams[0].actions.find((a) => a.entry.name === "Pedri")!;
    expect(pedriAction).toMatchObject({ kind: "update", playerId: "id-pedri" });
    expect((pedriAction as { changes: string[] }).changes.join("|")).toMatch(/name "pedri " → "Pedri"/);
    expect(plan.teams[0].team).toEqual({ action: "reuse", teamId });
    expect(plan.teams[0].actions.filter((a) => a.kind === "create").map((a) => a.entry.name).sort()).toEqual(["João Cancelo", "Lamine Yamal"]);
  });

  it("matches ignoring accents, case and punctuation: 'joao cancelo' is João Cancelo", () => {
    const teamId = "t1";
    const plan = planRosterLoad(snap, [{ teamId, name: "fc barcelona" }], new Map([[teamId, [existingPlayer({ teamId, name: "joao cancelo", playerId: "id-cancelo" })]]]));
    expect(plan.teams[0].actions.find((a) => a.entry.name === "João Cancelo")).toMatchObject({ kind: "update", playerId: "id-cancelo" });
  });

  it("is idempotent: once loaded, planning again finds every player unchanged and creates nothing", () => {
    const teamId = "t1";
    const source = snap.teams[0];
    const loaded = source.players.map((entry) =>
      existingPlayer({ teamId, name: entry.name, jerseyNumber: entry.jerseyNumber, position: entry.position, rosterSource: `${source.source.label} — ${source.source.url}`, rosterConsultedOn: source.source.consultedOn })
    );
    const again = planRosterLoad(snap, [{ teamId, name: "FC Barcelona" }], new Map([[teamId, loaded]]));
    expect(summarizePlan(again)).toEqual({ creates: 0, updates: 0, unchanged: 3, untouched: 0, teamsToCreate: 0 });
    expect(again.teams[0].actions.map((a) => (a.kind === "unchanged" ? a.playerId : null)).sort()).toEqual(loaded.map((p) => p.playerId).sort());
  });

  it("a squad number change is an update of the same player, not a new player: the number is not the identity", () => {
    const teamId = "t1";
    const source = snap.teams[0];
    const pedri = existingPlayer({ teamId, name: "Pedri", playerId: "id-pedri", jerseyNumber: 26, position: "MED", rosterSource: `${source.source.label} — ${source.source.url}`, rosterConsultedOn: source.source.consultedOn });
    const action = planRosterLoad(snap, [{ teamId, name: "FC Barcelona" }], new Map([[teamId, [pedri]]])).teams[0].actions.find((a) => a.entry.name === "Pedri")!;
    expect(action).toMatchObject({ kind: "update", playerId: "id-pedri" });
    expect((action as { changes: string[] }).changes).toEqual(["jersey 26 → 8"]);
  });

  it("leaves an existing player the roster does not mention exactly as it is — not deactivated, not renamed — and reports a near match without merging", () => {
    const teamId = "t1";
    const hand = [existingPlayer({ teamId, name: "Cancelo", playerId: "id-cancelo-by-hand" }), existingPlayer({ teamId, name: "Someone Else", playerId: "id-else", active: false })];
    const plan = planRosterLoad(snap, [{ teamId, name: "FC Barcelona" }], new Map([[teamId, hand]]));
    expect(plan.teams[0].untouched.map((p) => p.playerId).sort()).toEqual(["id-cancelo-by-hand", "id-else"]);
    expect(plan.teams[0].actions.find((a) => a.entry.name === "João Cancelo")!.kind).toBe("create"); // not merged
    expect(plan.teams[0].playersToReview.map((r) => ({ existing: r.existing.name, entries: r.possibleEntries.map((e) => e.name) }))).toEqual([{ existing: "Cancelo", entries: ["João Cancelo"] }]);
    expect(plan.teams[0].blockers).toEqual([]);
  });

  it("two existing players with the same normalised name are NOT guessed: nothing is created next to them and a person must decide", () => {
    const teamId = "t1";
    const pair = [existingPlayer({ teamId, name: "Pedri", playerId: "a" }), existingPlayer({ teamId, name: "PEDRI", playerId: "b" })];
    const plan = planRosterLoad(snap, [{ teamId, name: "FC Barcelona" }], new Map([[teamId, pair]]));
    expect(plan.teams[0].actions.map((a) => a.entry.name)).not.toContain("Pedri");
    expect(plan.teams[0].blockers.join("|")).toMatch(/"Pedri" matches 2 existing players/);
  });

  it("two teams with exactly the club's name are not guessed either", () => {
    const plan = planRosterLoad(snap, [{ teamId: "x", name: "FC Barcelona" }, { teamId: "y", name: "fc  barcelona" }], new Map());
    expect(plan.teams[0].actions).toEqual([]);
    expect(plan.teams[0].blockers.join("|")).toMatch(/2 existing teams are called exactly/);
  });
});

describe("the loader only ever talks to a database on this machine", () => {
  it.each(["postgresql://postgres:pw@127.0.0.1:54322/postgres", "postgres://u:p@localhost:5432/db", "postgresql://u:p@[::1]:5432/db"])("accepts %s", (url) => {
    expect(() => assertLoopbackDatabaseUrl(url)).not.toThrow();
  });
  it.each([
    undefined,
    "",
    "not a url",
    "https://127.0.0.1",
    "postgresql://postgres:pw@db.xxxxxxxxxxxxxxxxxxxx.supabase.co:5432/postgres",
    "postgresql://u:p@10.0.0.5:5432/db",
    "postgresql://u:p@localhost.evil.example:5432/db",
    "postgresql://u:p@127.0.0.1.evil.example:5432/db",
  ])("refuses %s", (url) => {
    expect(() => assertLoopbackDatabaseUrl(url as string | undefined)).toThrow(NotLocalDatabaseError);
  });
});

describe("the loader without the roster columns writes nothing", () => {
  it("plans, says why it did not apply, and never issues a write", async () => {
    const statements: string[] = [];
    const client: SqlClient = {
      async query(text) {
        statements.push(text.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase());
        if (text.includes("information_schema.columns")) return { rows: [] };
        return { rows: [] };
      },
    };
    const result = await loadRoster(client, CLASICO_ROSTER_SNAPSHOT, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.refusal).toMatch(/roster columns .* do not exist/);
    expect(statements.some((s) => /^(insert|update|delete|begin|alter)/.test(s))).toBe(false);
    expect(result.summary).toMatchObject({ creates: 53, teamsToCreate: 2 });
  });
});
