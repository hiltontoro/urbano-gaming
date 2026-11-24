import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { SupabaseCompetitionsRepository } from "../../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseGamingRepository } from "../../lib/gaming/db/supabaseGamingRepository";
import { createCompetition } from "../../lib/gaming/competitions/createCompetition";
import { openTeamRegistration } from "../../lib/gaming/competitions/openTeamRegistration";
import { registerForCompetition } from "../../lib/gaming/competitions/registerForCompetition";
import { parsePlanningPlan } from "../../lib/gaming/competitions/planning";
import { requireLocalSupabase } from "./requireLocalSupabase";

/**
 * UG-CR-GATE-CFM-001 — shared harness for the Lifetime Teams and Competition Entry contract suites. Everything here runs against a real, disposable,
 * LOOPBACK-ONLY Supabase (the target is refused unless its parsed host is exactly localhost or 127.0.0.1, and the raw Postgres URL must be loopback too).
 * Nothing in this file is production code: the people, competitions and rows are synthetic, and every id is removed again by `cleanup()`.
 *
 * It follows the conventions of the SSS contract suites on purpose: people are real auth users with a real Gaming Member each; a competition is created,
 * planned and opened through the real domain functions; the registration deadline is passed by recording a later planning revision as the database owner
 * (the plan history is append-only for everyone else) rather than by waiting; the database clock is moved only inside transactions that are ALWAYS rolled back.
 */

export const DAY = 24 * 3600_000;
const CR_OFFSET_MS = -6 * 3600_000; // America/Costa_Rica has no daylight saving: always UTC-06:00
const localMinute = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 16);
const localDate = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 10);

export interface Person { authUserId: string; gamingMemberId: string; email: string; label: string; displayName: string }

/** A refusal raised by one of the database operations: `refusal` is the stable `CODE` the database wrote before the colon (null for anything that is not a coded refusal). */
export class RpcError extends Error {
  readonly refusal: string | null;
  readonly sqlstate: string | undefined;
  constructor(readonly operation: string, error: { code?: string; message?: string }) {
    super(error.message ?? "unknown database error");
    this.name = "RpcError";
    this.sqlstate = error.code;
    const match = /^([A-Z][A-Z0-9_]*):/.exec(error.message ?? "");
    this.refusal = error.code === "P0001" && match ? match[1] : null;
  }
}

export interface LifetimeTestCompetition { competitionId: string; organizer: Person; deadlineMs: number }
export interface BuiltTeam { teamId: string; name: string; captain: Person; subCaptain: Person | null; members: Person[]; everyone: Person[] }

export type Outcome = { ok: true; rows: Record<string, any>[] } | { ok: false; message: string; code?: string; refusal: string | null };

export function createHarness(tag: string) {
  const env = loadEnv("development", process.cwd(), "");
  const supabaseUrl = env.SUPABASE_URL;
  requireLocalSupabase(supabaseUrl);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
  // Raw pg runs fixtures, rolled-back probes and catalog checks. The URL is supplied explicitly, never read from .env.local, and must be loopback.
  const dbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
  if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(dbUrl)) {
    throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the lifetime-team contract tests.");
  }

  const RUN = `${tag}${randomUUID().slice(0, 6)}`;
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, serviceKey);
  const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);

  const authUsers: string[] = [];
  const operators: string[] = [];
  const competitionIds: string[] = [];
  const teamIds: string[] = [];
  const personIds: string[] = [];
  let counter = 0;

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Raw database access (the database owner)
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async function rawQuery<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = new Client({ connectionString: dbUrl, statement_timeout: 60000 });
    await db.connect();
    try {
      return (await db.query(sql, params)).rows as T[];
    } finally {
      await db.end().catch(() => {});
    }
  }

  /** Runs `fn` in a transaction that is ALWAYS rolled back; nothing it does is ever visible to another session. */
  async function rawTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: dbUrl, statement_timeout: 60000 });
    await db.connect();
    try {
      await db.query("begin");
      return await fn(db);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end().catch(() => {});
    }
  }

  /** One statement in a transaction that is always rolled back; returns the database error it raised (or null). */
  async function violation(statement: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; message: string } | null> {
    return rawTransaction(async (db) => {
      try {
        await db.query(statement, params);
        return null;
      } catch (err) {
        const e = err as { code?: string; constraint?: string; message?: string };
        return { code: e.code, constraint: e.constraint, message: e.message ?? "" };
      }
    });
  }

  /**
   * Calls one operation as the database owner with the lifetime clock put on an exact instant, in a transaction that is ALWAYS rolled back. Only the database
   * owner can redefine the internal clock; nothing is committed, so no other test ever sees the changed clock.
   */
  async function atInstant(instant: string, statement: string, params: unknown[] = []): Promise<Outcome> {
    return rawTransaction(async (db) => {
      await db.query(`create or replace function public.lifetime_clock() returns timestamptz language sql volatile set search_path to 'public' as $clock$ select '${instant}'::timestamptz $clock$`);
      try {
        return { ok: true, rows: (await db.query(statement, params)).rows };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        const match = /^([A-Z][A-Z0-9_]*):/.exec(e.message ?? "");
        return { ok: false, message: e.message ?? "", code: e.code, refusal: e.code === "P0001" && match ? match[1] : null };
      }
    });
  }

  /** Runs several statements in ONE transaction under the moved lifetime clock; the transaction is ALWAYS rolled back. */
  async function withClock<T>(instant: string, fn: (db: Client) => Promise<T>): Promise<T> {
    return rawTransaction(async (db) => {
      await db.query(`create or replace function public.lifetime_clock() returns timestamptz language sql volatile set search_path to 'public' as $clock$ select '${instant}'::timestamptz $clock$`);
      return fn(db);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Operations through the real PostgREST (a genuine request, a genuine transaction per call — so concurrent calls genuinely race)
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async function rpc<T extends Record<string, any> = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T[]> {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new RpcError(name, error);
    return (data ?? []) as T[];
  }

  /** The call must succeed; returns its first row. */
  async function one<T extends Record<string, any> = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> {
    const rows = await rpc<T>(name, args);
    if (rows.length === 0) throw new Error(`${name} returned no row`);
    return rows[0];
  }

  /** The call must be refused with exactly this coded refusal (never a raw database failure). */
  async function refused(name: string, args: Record<string, unknown>, code: string): Promise<RpcError> {
    let caught: unknown = null;
    try {
      await rpc(name, args);
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof RpcError)) throw new Error(`${name} was expected to be refused with ${code} but resolved`);
    if (caught.refusal !== code) throw new Error(`${name} was expected to be refused with ${code} but failed with ${caught.sqlstate}: ${caught.message}`);
    return caught;
  }

  /** Settles a call into an outcome; a failure keeps its SQLSTATE, so a test can prove nothing ever failed as a raw database error. */
  async function settle(name: string, args: Record<string, unknown>): Promise<Outcome> {
    try {
      return { ok: true, rows: await rpc(name, args) };
    } catch (err) {
      if (err instanceof RpcError) return { ok: false, message: err.message, code: err.sqlstate, refusal: err.refusal };
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // People and teams
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async function newPerson(label: string): Promise<Person> {
    const email = `cfm-${RUN}-${counter++}@example.com`;
    const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
    authUsers.push(data.user.id);
    const member = await gamingRepo.createGamingMember(data.user.id, `${label.slice(0, 24)} ${RUN}-${counter}`);
    personIds.push(member.gamingMemberId);
    return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId, email, label, displayName: member.displayName };
  }

  async function newPeople(count: number, label: string): Promise<Person[]> {
    const out: Person[] = [];
    for (let i = 0; i < count; i += 6) {
      out.push(...(await Promise.all(Array.from({ length: Math.min(6, count - i) }, (_, k) => newPerson(`${label} ${i + k}`)))));
    }
    return out;
  }

  async function makeOperator(label: string): Promise<Person> {
    const person = await newPerson(label);
    const { error } = await service.from("authority_grants").insert({ gaming_member_id: person.gamingMemberId, authority_class: "OPERATIONAL" });
    if (error) throw error;
    operators.push(person.gamingMemberId);
    return person;
  }

  let teamCounter = 0;
  const uniqueName = (label: string) => `${label} ${RUN} ${teamCounter++}`;

  /** A lifetime team with `creator` as its captain. */
  async function createTeam(creator: Person, name = uniqueName("Team")): Promise<{ teamId: string; publicCode: string; name: string }> {
    const row = await one("create_lifetime_team_atomically", { p_creator_gaming_member_id: creator.gamingMemberId, p_name: name });
    teamIds.push(row.lifetime_team_id);
    return { teamId: row.lifetime_team_id, publicCode: row.public_code, name };
  }

  /**
   * Fixture (UG-CR-GATE-CFM-010): lets ONE pending offer lapse without waiting seven days. The row's own guard forbids any change to `expires_at`, so — like cleanup — this
   * runs as the database owner with row triggers off, for exactly one pending row, and proves that it touched exactly one. Nothing else about the offer changes: the lapse
   * itself is then judged by the real operations against the real clock.
   */
  async function lapseOffer(kind: "MEMBERSHIP" | "LEADERSHIP", offerId: string): Promise<void> {
    const [table, idColumn] = kind === "MEMBERSHIP" ? ["lifetime_team_memberships", "lifetime_team_membership_id"] : ["lifetime_team_leaderships", "lifetime_team_leadership_id"];
    const db = new Client({ connectionString: dbUrl, statement_timeout: 60000 });
    await db.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      const done = await db.query(`update ${table} set expires_at = now() - interval '1 minute' where ${idColumn} = $1 and status = 'PENDING'`, [offerId]);
      if (done.rowCount !== 1) throw new Error(`lapseOffer: expected exactly one pending ${kind} offer, found ${done.rowCount}`);
      await db.query("commit");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end().catch(() => {});
    }
  }

  /** The captain invites `person`; the person accepts. Returns the membership id. */
  async function addMember(teamId: string, leader: Person, person: Person): Promise<string> {
    const offer = await one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: leader.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
    await one("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: offer.lifetime_team_membership_id, p_actor_gaming_member_id: person.gamingMemberId, p_decision: "ACCEPT" });
    return offer.lifetime_team_membership_id;
  }

  /** The captain offers the sub-captain seat to an existing member; the member accepts. */
  async function makeSubCaptain(teamId: string, captain: Person, member: Person): Promise<string> {
    const offer = await one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: member.gamingMemberId });
    await one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: offer.lifetime_team_leadership_id, p_actor_gaming_member_id: member.gamingMemberId, p_decision: "ACCEPT" });
    return offer.lifetime_team_leadership_id;
  }

  /** A team of `size` people in total: the captain, optionally a sub-captain, and ordinary members. */
  async function buildTeam(label: string, size = 6, opts: { subCaptain?: boolean } = {}): Promise<BuiltTeam> {
    const people = await newPeople(size, label);
    const captain = people[0];
    const team = await createTeam(captain, uniqueName(label));
    const members: Person[] = [];
    for (const p of people.slice(1)) {
      await addMember(team.teamId, captain, p);
      members.push(p);
    }
    let subCaptain: Person | null = null;
    if (opts.subCaptain !== false && members.length > 0) {
      subCaptain = members[0];
      await makeSubCaptain(team.teamId, captain, subCaptain);
    }
    return { teamId: team.teamId, name: team.name, captain, subCaptain, members: subCaptain ? members.slice(1) : members, everyone: people };
  }

  /** A genuine access token for the person (the real sign-in path), for calling the real route handlers. */
  async function tokenFor(person: Person): Promise<string> {
    const link = await service.auth.admin.generateLink({ type: "magiclink", email: person.email });
    if (!link.data.properties) throw new Error("No link properties for the test member.");
    const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
    const token = verified.data.session?.access_token;
    if (!token) throw new Error("No session for the test member.");
    return token;
  }

  /** A client whose every request carries a genuine `authenticated`-role JWT — not merely the anon key. */
  async function authenticatedClient() {
    const person = await newPerson("Authenticated");
    const token = await tokenFor(person);
    return createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Competitions
  // -------------------------------------------------------------------------------------------------------------------------------------------

  function rawPlan(deadlineMs: number, minimum = 5, maximum = 8) {
    return {
      venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "No metal cleats." },
      pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
      dates: [{ date: localDate(deadlineMs + 3 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
      roster: { minimum, maximum },
      registrationDeadline: { local: localMinute(deadlineMs), timeZone: "America/Costa_Rica" },
      rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
    };
  }

  /** A five-a-side competition with a saved plan and registration open. The lifetime flow is enabled only when asked for. */
  async function setUpCompetition(label: string, opts: { deadlineMs?: number; minimum?: number; maximum?: number; lifetimeFlow?: boolean; open?: boolean } = {}): Promise<LifetimeTestCompetition> {
    const deadlineMs = opts.deadlineMs ?? Date.now() + 2 * DAY;
    const organizer = await makeOperator(`${label} Organizer`);
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `CFM ${label} ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    const plan = parsePlanningPlan(rawPlan(deadlineMs, opts.minimum, opts.maximum), "SOCCER_5V5" as never);
    await compRepo.savePlanningRevision(created.competitionId, organizer.gamingMemberId, randomUUID(), plan);
    if (opts.open !== false) await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
    const competition: LifetimeTestCompetition = { competitionId: created.competitionId, organizer, deadlineMs };
    if (opts.lifetimeFlow !== false) await enableFlow(competition);
    return competition;
  }

  async function enableFlow(competition: LifetimeTestCompetition) {
    return one("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId });
  }

  /**
   * The competition's organizer (or `actor`) decides an entry through the real operation: APPROVE, REJECT (with a reason code) or REMOVE (an accepted entry, with a
   * reason code). UG-CR-GATE-CFM-004.
   */
  async function decideEntry(competition: { competitionId: string; organizer: Person }, entryId: string, decision: "APPROVE" | "REJECT" | "REMOVE", opts: { reason?: string | null; note?: string | null; actor?: Person } = {}) {
    return one("decide_lifetime_competition_entry_atomically", {
      p_competition_id: competition.competitionId, p_competition_team_id: entryId, p_organizer_gaming_member_id: (opts.actor ?? competition.organizer).gamingMemberId,
      p_decision: decision, p_reason_code: opts.reason ?? null, p_note: opts.note ?? null });
  }

  /** The organizer approves each of these entries (it must happen while registration is open, so before the deadline passes). */
  async function approveEntries(competition: { competitionId: string; organizer: Person }, ...entryIds: string[]) {
    for (const entryId of entryIds) await decideEntry(competition, entryId, "APPROVE");
  }

  /** The person registers for the competition with the adult self-attestation (the real, existing operation). */
  async function register(competition: LifetimeTestCompetition, ...people: Person[]) {
    for (const person of people) await registerForCompetition(compRepo, competition.competitionId, person.gamingMemberId, true);
  }

  /** A leader enters the team in the competition. The leader registers first (as V1 requires of whoever proposes a team). */
  async function enterTeam(competition: LifetimeTestCompetition, team: BuiltTeam, leader: Person = team.captain): Promise<{ entryId: string; publicCode: string }> {
    await register(competition, leader);
    const row = await one("enter_lifetime_team_into_competition_atomically", { p_competition_id: competition.competitionId, p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: leader.gamingMemberId });
    return { entryId: row.competition_team_id, publicCode: row.public_code };
  }

  /** The leader proposes `people`; each person registers and affirms. Returns the claim ids by member id. */
  async function rosterUp(entryId: string, leader: Person, competition: LifetimeTestCompetition, people: Person[]): Promise<Record<string, string>> {
    const proposed = await rpc("propose_lifetime_entry_roster_claims_atomically", { p_competition_team_id: entryId, p_actor_gaming_member_id: leader.gamingMemberId, p_gaming_member_ids: people.map((p) => p.gamingMemberId) });
    const claims: Record<string, string> = {};
    for (const row of proposed) claims[row.gaming_member_id] = row.competition_lifetime_roster_claim_id;
    for (const person of people) {
      await register(competition, person);
      await one("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: claims[person.gamingMemberId], p_actor_gaming_member_id: person.gamingMemberId, p_decision: "ACCEPT" });
    }
    return claims;
  }

  /**
   * Service-side fixture: records a later planning revision (as the database owner) whose deadline is the given instant (and, when given, whose roster bounds are those
   * — otherwise they are the previous revision's); the revision chain and every constraint are the real ones.
   */
  async function supersedePlan(competitionId: string, deadlineIso: string, bounds: { minimum?: number; maximum?: number } = {}): Promise<void> {
    await rawTransaction(async (db) => {
      const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
      const next = (await db.query(
        `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
           venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
           registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
         values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $15), $15, $16, $14::timestamptz, $17,$18,$19) returning planning_revision_id`,
        [competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
          cur.venue_time_zone, cur.simultaneous_match_capacity, cur.venue_restriction_notes, bounds.minimum ?? cur.roster_minimum, bounds.maximum ?? cur.roster_maximum, deadlineIso, cur.registration_deadline_time_zone,
          cur.registration_deadline_utc_offset_minutes, cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest])).rows[0].planning_revision_id;
      await db.query("insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes) select $2::uuid, position, label, is_usable, restriction_notes from competition_planning_pitches where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
      await db.query(
        `insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
         select np.planning_pitch_id, f.format_key from competition_planning_pitches op join competition_planning_pitch_formats f on f.planning_pitch_id = op.planning_pitch_id
           join competition_planning_pitches np on np.planning_revision_id = $2::uuid and np.position = op.position where op.planning_revision_id = $1::uuid`, [cur.planning_revision_id, next]);
      await db.query("insert into competition_planning_dates (planning_revision_id, plan_date, position) select $2::uuid, plan_date, position from competition_planning_dates where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
      await db.query("insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time) select $2::uuid, plan_date, window_index, start_time, end_time from competition_planning_windows where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
      await db.query("commit");
    });
  }

  /**
   * Lets the registration deadline pass WITHOUT waiting for it: records a later revision whose deadline is the first whole second after everything the competition
   * has recorded (its registrations, entries and plan revisions, and now), then waits out that second. Every row already written is therefore stamped before it.
   */
  async function passDeadline(competitionId: string): Promise<string> {
    const [{ latest }] = await rawQuery<{ latest: Date }>(
      `select greatest(
         coalesce((select max(registered_at) from competition_registrations where competition_id = $1), 'epoch'),
         coalesce((select max(created_at) from competition_teams where competition_id = $1), 'epoch'),
         coalesce((select max(approved_at) from competition_team_memberships where competition_id = $1), 'epoch'),
         coalesce((select max(created_at) from competition_planning_revisions where competition_id = $1), 'epoch'),
         now()) as latest`, [competitionId]);
    // The lifetime claims (when the schema has them) are stamped before the deadline too.
    const claims = await rawQuery<{ latest: Date | null }>("select max(proposed_at) as latest from competition_lifetime_roster_claims where competition_id = $1", [competitionId]).catch(() => [{ latest: null }]);
    const newest = Math.max(latest.getTime(), claims[0]?.latest ? claims[0].latest.getTime() : 0);
    const deadline = new Date((Math.floor(newest / 1000) + 1) * 1000);
    const wait = deadline.getTime() - Date.now() + 80;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await supersedePlan(competitionId, deadline.toISOString());
    return deadline.toISOString();
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Cleanup: evidence rows are append-only, so the owner removes them with row triggers off (replica role). Every statement is bound to exactly the parameters it
  // mentions, every failure is COLLECTED (never swallowed), and cleanup ends by proving that nothing of this run is left behind: no competition, no auth user.
  // -------------------------------------------------------------------------------------------------------------------------------------------

  async function cleanup() {
    const failures: string[] = [];
    const db = new Client({ connectionString: dbUrl, statement_timeout: 60000 });
    try {
      await db.connect();
      await db.query("set session_replication_role = replica");
      const run = async (sql: string, params: unknown[]) => {
        try {
          await db.query(sql, params);
        } catch (err) {
          failures.push(`${sql.slice(0, 80)} -> ${(err as Error).message}`);
        }
      };
      const revs = "(select planning_revision_id from competition_planning_revisions where competition_id = any($1))";
      // The audit tables of the organizer-decision gate (UG-CR-GATE-CFM-004) reference entries and competitions: they go first, and only when the schema has them.
      const decisionTables = (await db.query("select to_regclass('public.competition_lifetime_entry_decisions') is not null as decisions, to_regclass('public.competition_lifetime_flow_events') is not null as flow_events")).rows[0];
      if (decisionTables.decisions) await run("delete from competition_lifetime_entry_decisions where competition_id = any($1)", [competitionIds]);
      if (decisionTables.flow_events) await run("delete from competition_lifetime_flow_events where competition_id = any($1)", [competitionIds]);
      // $1 = the competitions of this run
      for (const sql of [
        "delete from competition_lifetime_roster_claims where competition_id = any($1)",
        "delete from competition_lifetime_freezes where competition_id = any($1)",
        "delete from competition_lifetime_flows where competition_id = any($1)",
        "delete from competition_draw_entries where competition_id = any($1)",
        "delete from competition_draws where competition_id = any($1)",
        "delete from competition_registration_freeze_members where competition_id = any($1)",
        "delete from competition_registration_freeze_teams where competition_id = any($1)",
        "delete from competition_registration_freezes where competition_id = any($1)",
        `delete from competition_planning_windows where planning_revision_id in ${revs}`,
        `delete from competition_planning_dates where planning_revision_id in ${revs}`,
        `delete from competition_planning_pitch_formats where planning_pitch_id in (select planning_pitch_id from competition_planning_pitches where planning_revision_id in ${revs})`,
        `delete from competition_planning_pitches where planning_revision_id in ${revs}`,
        "delete from competition_planning_revisions where competition_id = any($1)",
        "delete from competition_team_memberships where competition_id = any($1)",
        "delete from competition_join_requests where competition_id = any($1)",
        "delete from competition_registrations where competition_id = any($1)",
        "delete from lifetime_team_legacy_sources where competition_id = any($1)",
        "delete from competition_teams where competition_id = any($1)",
        "delete from competition_host_capabilities where competition_id = any($1)",
        "delete from competitions where competition_id = any($1)",
      ]) await run(sql, [competitionIds]);
      // $1 = the lifetime teams this run tracked, $2 = the people it made (a team created by any of them is this run's too)
      const teams = "(select lifetime_team_id from lifetime_teams where lifetime_team_id = any($1) or created_by_gaming_member_id = any($2))";
      for (const sql of [
        `delete from lifetime_team_events where lifetime_team_id in ${teams} or actor_gaming_member_id = any($2) or subject_gaming_member_id = any($2)`,
        `delete from lifetime_team_leaderships where lifetime_team_id in ${teams}`,
        `delete from lifetime_team_memberships where lifetime_team_id in ${teams}`,
        `delete from lifetime_teams where lifetime_team_id in ${teams}`,
      ]) await run(sql, [teamIds, personIds]);
    } catch (err) {
      failures.push(`connection: ${(err as Error).message}`);
    } finally {
      await db.end().catch(() => {});
    }
    if (operators.length > 0) {
      const { error } = await service.from("authority_grants").delete().in("gaming_member_id", operators);
      if (error) failures.push(`authority_grants: ${error.message}`);
    }
    for (const id of authUsers) {
      const { error } = await service.auth.admin.deleteUser(id);
      if (error) failures.push(`deleteUser ${id}: ${error.message}`);
    }
    const left = await rawQuery<{ competitions: number; users: number }>(
      "select (select count(*)::int from competitions where name like '%' || $1) as competitions, (select count(*)::int from auth.users where email like 'cfm-' || $1 || '-%') as users", [RUN]).catch(() => []);
    if (left[0] && (left[0].competitions > 0 || left[0].users > 0)) failures.push(`left behind: ${left[0].competitions} competition(s), ${left[0].users} auth user(s)`);
    if (failures.length > 0) throw new Error(`lifetime contract cleanup was incomplete (${failures.length}):\n${failures.slice(0, 12).join("\n")}`);
  }

  return {
    RUN, env, supabaseUrl, serviceKey, anonKey, dbUrl, service, anon, compRepo, gamingRepo,
    rawQuery, rawTransaction, violation, atInstant, withClock, rpc, one, refused, settle,
    newPerson, newPeople, makeOperator, tokenFor, authenticatedClient, uniqueName, createTeam, addMember, makeSubCaptain, buildTeam, lapseOffer,
    setUpCompetition, enableFlow, register, enterTeam, rosterUp, passDeadline, supersedePlan, decideEntry, approveEntries,
    trackTeam: (id: string) => { teamIds.push(id); },
    trackCompetition: (id: string) => { competitionIds.push(id); },
    cleanup,
  };
}

export type Harness = ReturnType<typeof createHarness>;
