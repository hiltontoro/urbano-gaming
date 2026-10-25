import type { PlayerRecord } from "../types";
import type { RosterSnapshot } from "./clasicoRosterSnapshot";
import { describeSource, planRosterLoad, summarizePlan, type ExistingTeam, type RosterPlan } from "./reconcile";

/**
 * THE LOCAL ROSTER LOADER — repeatable, and only ever against a database on this machine.
 *
 * It is the one place that writes the roster columns of `players`. It reads what exists, asks the pure reconciliation what to do, and — only
 * when asked to apply — does exactly that in one transaction: it creates a team or a player that does not exist, and updates in place a
 * player that does. It never deletes, never deactivates, never renames anybody the roster does not mention. A second run finds every
 * player again by name and changes nothing; the id of a player is whatever the database gave it the first time.
 *
 * It refuses a database that is not on loopback, whatever flag it is given. It does not add the roster columns: they are a documented
 * proposal (not a migration), applied by hand to a disposable local database; without them it says so and writes nothing.
 */

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class NotLocalDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotLocalDatabaseError";
  }
}

/** Throws unless the connection string points at this machine. Nothing here is ever allowed to reach a hosted database. */
export function assertLoopbackDatabaseUrl(url: string | undefined | null): void {
  if (!url || url.trim().length === 0) throw new NotLocalDatabaseError("No database URL was given: set ROSTER_LOCAL_DB_URL to a local database.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotLocalDatabaseError("The database URL cannot be read, so it cannot be shown to be local.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new NotLocalDatabaseError("The database URL is not a Postgres URL.");
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new NotLocalDatabaseError(`Refusing "${parsed.hostname}": the roster loader writes only to a database on this machine (localhost, 127.0.0.1 or ::1).`);
  }
}

export const ROSTER_COLUMNS = ["jersey_number", "position", "roster_source", "roster_consulted_on"] as const;

export async function rosterColumnsPresent(client: SqlClient): Promise<boolean> {
  const result = await client.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'players' and column_name = any($1)`,
    [ROSTER_COLUMNS]
  );
  return result.rows.length === ROSTER_COLUMNS.length;
}

function mapRow(row: any): PlayerRecord {
  return {
    playerId: row.player_id,
    teamId: row.team_id,
    name: row.name,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
    jerseyNumber: row.jersey_number ?? null,
    position: row.position ?? null,
    rosterSource: row.roster_source ?? null,
    // a Postgres `date` arrives as a Date at local midnight in some drivers and as text in others: the calendar date is what matters
    rosterConsultedOn: row.roster_consulted_on instanceof Date ? localDate(row.roster_consulted_on) : row.roster_consulted_on ?? null,
  };
}

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

async function readExisting(client: SqlClient, columns: boolean): Promise<{ teams: ExistingTeam[]; players: Map<string, PlayerRecord[]> }> {
  const teamRows = (await client.query("select team_id, name from teams order by created_at, team_id")).rows;
  const teams: ExistingTeam[] = teamRows.map((row) => ({ teamId: row.team_id, name: row.name }));
  const select = columns
    ? "select player_id, team_id, name, active, created_at, jersey_number, position, roster_source, roster_consulted_on from players"
    : "select player_id, team_id, name, active, created_at from players";
  const players = new Map<string, PlayerRecord[]>();
  for (const row of (await client.query(`${select} order by created_at, player_id`)).rows) {
    const record = mapRow(row);
    players.set(record.teamId, [...(players.get(record.teamId) ?? []), record]);
  }
  return { teams, players };
}

export interface RosterLoadResult {
  plan: RosterPlan;
  columnsPresent: boolean;
  applied: boolean;
  /** Why nothing was written, when nothing was. */
  refusal: string | null;
  summary: ReturnType<typeof summarizePlan>;
  /** After applying, the same plan computed again: it must say "unchanged" for every entry. */
  planAfter: ReturnType<typeof summarizePlan> | null;
}

/**
 * Plans (and, with `apply`, performs) the load of `snapshot` on a LOCAL database. The caller has already shown the URL to be loopback; the
 * function never connects by itself.
 */
export async function loadRoster(client: SqlClient, snapshot: RosterSnapshot, options: { apply: boolean }): Promise<RosterLoadResult> {
  const columnsPresent = await rosterColumnsPresent(client);
  const existing = await readExisting(client, columnsPresent);
  const plan = planRosterLoad(snapshot, existing.teams, existing.players);
  const summary = summarizePlan(plan);
  const blocked = plan.problems.length > 0 ? `the snapshot has problems: ${plan.problems.join("; ")}` : plan.teams.flatMap((team) => team.blockers).join("; ");
  const result: RosterLoadResult = { plan, columnsPresent, applied: false, refusal: null, summary, planAfter: null };
  if (!options.apply) return result;
  if (!columnsPresent) return { ...result, refusal: "the roster columns (jersey_number, position, roster_source, roster_consulted_on) do not exist in this database; apply the documented proposal to a disposable local database first" };
  if (blocked) return { ...result, refusal: `a person has to settle this first: ${blocked}` };

  await client.query("begin");
  try {
    // One load at a time; the plan is recomputed under the lock so it is what is applied.
    await client.query("select pg_advisory_xact_lock(hashtext('urbano-roster-load'))");
    const fresh = await readExisting(client, true);
    const lockedPlan = planRosterLoad(snapshot, fresh.teams, fresh.players);
    const lockedBlockers = lockedPlan.teams.flatMap((team) => team.blockers);
    if (lockedBlockers.length > 0) throw new Error(`a person has to settle this first: ${lockedBlockers.join("; ")}`);

    for (const teamPlan of lockedPlan.teams) {
      const source = snapshot.teams.find((team) => team.teamName === teamPlan.teamName)!;
      const sourceText = describeSource(source);
      let teamId: string;
      if (teamPlan.team.action === "reuse") teamId = teamPlan.team.teamId;
      else teamId = (await client.query("insert into teams (name) values ($1) returning team_id", [teamPlan.teamName])).rows[0].team_id;
      for (const action of teamPlan.actions) {
        if (action.kind === "unchanged") continue;
        if (action.kind === "create") {
          await client.query(
            "insert into players (team_id, name, jersey_number, position, roster_source, roster_consulted_on) values ($1, $2, $3, $4, $5, $6)",
            [teamId, action.entry.name, action.entry.jerseyNumber, action.entry.position, sourceText, source.source.consultedOn]
          );
        } else {
          await client.query(
            "update players set name = $1, jersey_number = $2, position = $3, roster_source = $4, roster_consulted_on = $5 where player_id = $6 and team_id = $7",
            [action.entry.name, action.entry.jerseyNumber, action.entry.position, sourceText, source.source.consultedOn, action.playerId, teamId]
          );
        }
      }
    }

    // Self-check inside the same transaction: planning again must find nothing left to do.
    const after = await readExisting(client, true);
    const planAfter = summarizePlan(planRosterLoad(snapshot, after.teams, after.players));
    if (planAfter.creates !== 0 || planAfter.updates !== 0 || planAfter.teamsToCreate !== 0) {
      throw new Error(`the load did not converge (${JSON.stringify(planAfter)}); nothing was kept`);
    }
    await client.query("commit");
    return { ...result, plan: lockedPlan, summary: summarizePlan(lockedPlan), applied: true, planAfter };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
