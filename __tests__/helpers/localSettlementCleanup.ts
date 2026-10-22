import { Client } from "pg";

const REJECTION_MESSAGE =
  "Refusing to use a non-loopback Postgres for settlement-evidence cleanup. PREDICTIONS_LOCAL_DB_URL (or COMPETITIONS_LOCAL_DB_URL) must be a postgres:// URL whose host is exactly 127.0.0.1 or localhost.";

/**
 * Fail-closed guard for the direct Postgres connection contract tests use
 * to clean up settlement evidence. Finalized results, their goal events,
 * evaluations and prize entitlements are immutable through every ordinary
 * path (migration 20261020150100), so test teardown cannot delete them
 * through the API. It instead opens a superuser connection to the LOCAL
 * database only, and that connection must never reach anything else.
 * Exact hostname comparison, never substring matching; the fixed message
 * never echoes the rejected value (it may carry credentials).
 */
export function requireLoopbackDatabaseUrl(candidate: unknown): asserts candidate is string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(REJECTION_MESSAGE);
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(REJECTION_MESSAGE);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(REJECTION_MESSAGE);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(REJECTION_MESSAGE);
  }
}

/** The loopback database URL for settlement cleanup, from the environment. */
export function localSettlementDatabaseUrl(): string {
  const candidate = process.env.PREDICTIONS_LOCAL_DB_URL ?? process.env.COMPETITIONS_LOCAL_DB_URL;
  requireLoopbackDatabaseUrl(candidate);
  return candidate;
}

/**
 * Deletes the settlement evidence of the given test matches, children
 * first, in one transaction with triggers bypassed
 * (session_replication_role = replica, local to the transaction). Scoped
 * strictly to the supplied match ids — it never touches other rows.
 */
export async function purgeSettlementEvidence(databaseUrl: string, matchIds: string[]): Promise<void> {
  requireLoopbackDatabaseUrl(databaseUrl);
  if (matchIds.length === 0) return;

  const client = new Client({ connectionString: databaseUrl, statement_timeout: 20000 });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const evaluations = `(select e.evaluation_id from evaluations e join predictions p on p.prediction_id = e.prediction_id where p.match_id = any($1::uuid[]))`;
    await client.query(`delete from gaming_progression_events where evaluation_id in ${evaluations}`, [matchIds]);
    await client.query(`delete from prize_qualifications where evaluation_id in ${evaluations}`, [matchIds]);
    await client.query(
      `delete from evaluations where evaluation_id in ${evaluations}`,
      [matchIds]
    );
    await client.query(
      `delete from official_goal_events where match_result_id in (select match_result_id from match_results where match_id = any($1::uuid[]))`,
      [matchIds]
    );
    await client.query(`delete from match_results where match_id = any($1::uuid[])`, [matchIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
