import { Client } from "pg";

import { CLASICO_ROSTER_SNAPSHOT } from "../lib/gaming/predictions/rosters/clasicoRosterSnapshot";
import { assertLoopbackDatabaseUrl, loadRoster } from "../lib/gaming/predictions/rosters/localRosterLoader";

/**
 * Loads the Clásico rosters into a database ON THIS MACHINE. By default it only shows what it would do; `--apply` does it.
 *
 *   ROSTER_LOCAL_DB_URL=postgresql://postgres:…@127.0.0.1:54322/postgres npx tsx scripts/loadClasicoRoster.ts [--apply]
 *
 * It refuses any database that is not on loopback, creates and updates but never deletes or deactivates, and is safe to repeat. It does not
 * add the roster columns (they are a documented proposal, not a migration). See lib/gaming/predictions/rosters/localRosterLoader.ts.
 */
async function main() {
  const url = process.env.ROSTER_LOCAL_DB_URL;
  assertLoopbackDatabaseUrl(url);
  const apply = process.argv.includes("--apply");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await loadRoster(client, CLASICO_ROSTER_SNAPSHOT, { apply });
    const report = {
      mode: apply ? "apply" : "plan only (nothing written)",
      columnsPresent: result.columnsPresent,
      applied: result.applied,
      refusal: result.refusal,
      problems: result.plan.problems,
      summary: result.summary,
      planAfter: result.planAfter,
      teams: result.plan.teams.map((team) => ({
        team: team.teamName,
        team_action: team.team.action,
        teamsToReview: team.teamsToReview.map((existing) => existing.name),
        playersToReview: team.playersToReview.map((item) => ({ existing: item.existing.name, possibleEntries: item.possibleEntries.map((entry) => entry.name) })),
        blockers: team.blockers,
        untouched: team.untouched.length,
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    if (result.refusal || result.plan.problems.length > 0) process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
