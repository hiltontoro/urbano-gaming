import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { createClient } from "@supabase/supabase-js";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { completeSession } from "../lib/session/completeSession";
import { castVote } from "../lib/session/castVote";
import { getSession } from "../lib/session/getSession";
import { vi } from "vitest";
import { POST as registerRoute } from "../app/api/gaming/community-voting/instances/route";
import { POST as bindRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/binding/route";
import { POST as intentRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/intents/route";
import { POST as voteRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/votes/route";
import { GET as statusRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/status/route";
import { POST as entriesPostRoute, GET as entriesGetRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/entries/route";
import { DELETE as entryDeleteRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/entries/[entryId]/route";
import { POST as confirmRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/entries/[entryId]/confirmation/route";
import { POST as claimRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/claims/route";
import { POST as startRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/start/route";
import { POST as memberRoute } from "../app/api/gaming/member/route";
import { SupabaseVoterIdentityVerifier } from "../lib/gaming/communityVoting/verifiedIdentity";
import { LobbyNotOpenError, DisplayNameTakenError, SelfVoteNotAllowedError, HostTokenMismatchError } from "../lib/session/types";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";

import { CommunityVotingError, type GeofenceConfig, type LocationClaim } from "../lib/gaming/communityVoting/types";
import { assessLocationEligibility } from "../lib/gaming/communityVoting/eligibility";
import { payloadDigest } from "../lib/gaming/communityVoting/payloadCommitment";
import { SupabaseCommunityVotingRepository } from "../lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-IV-GATE-002 / UG-IV-GATE-003 — Community Voting local foundation: contract suite against REAL local Postgres.
 *
 * GATE-003 contract: PROMPT_ACTIVE means Voting is actually open. All preparation (a complete ballot with a verified,
 * host-confirmed contestant for every entry) happens BEFORE it, and one explicit, atomic, host-authorized start
 * materializes the attributed candidates and opens the Session. Ordinary start and ordinary join are closed to an
 * event-bound Session at the database, and the ballot is frozen from the moment it opens.
 *
 * Isolation: the target comes ONLY from shell-exported variables (never a dotenv file) and must be loopback.
 * No remote project, hosted Auth, mail, SMS or provider is reachable from here. All identities, venues and
 * coordinates are synthetic. Each test builds its own Session, so tests are independent and a database reset
 * (or discarding the throwaway container) restores a clean state — Community Voting rows are intentionally
 * undeletable (deletion containment), so this suite never tries to clean them up.
 *
 * Proves what the in-memory suite cannot: Session-first locking and real blocking, atomic rollback, grants and
 * direct-call denial, foreign-key containment, the authoritative ordinary-join guard, and delegation to the
 * UNCHANGED cast_vote_atomically.
 *
 * REQUIRED ENVIRONMENT (shell-exported, all loopback):
 *   SUPABASE_URL                    REST + Auth gateway exposing /rest/v1 and /auth/v1 (the supabase-js convention)
 *   SUPABASE_SERVICE_ROLE_KEY       service_role key for that stack
 *   SUPABASE_ANON_KEY               anon key for that stack
 *   COMMUNITY_VOTING_LOCAL_DB_URL   postgres:// URL of the same database, for raw lock/concurrency/rollback tests
 * The database must have the committed migration history applied through 20261020190300. The "End to end with a
 * real local Auth service" block additionally needs a LOCAL Auth service with phone and email autoconfirm and no
 * mail/SMS provider, so that no code, email or SMS can ever be sent. This file is NOT registered in package.json;
 * run it by path: `npx vitest run --no-file-parallelism __tests__/communityVotingSupabase.contract.test.ts`.
 */

const supabaseUrl = process.env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.COMMUNITY_VOTING_LOCAL_DB_URL ?? "";
if (!serviceKey || !anonKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for the Community Voting contract suite.");
}
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(dbUrl)) {
  throw new Error("COMMUNITY_VOTING_LOCAL_DB_URL must be set to a loopback Postgres URL.");
}

const sessionRepo = new SupabaseSessionRepository(supabaseUrl, serviceKey);
const repo = new SupabaseCommunityVotingRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const pool = new Pool({ connectionString: dbUrl, max: 10 });

const VENUE: GeofenceConfig = {
  venueLatitude: 14.1,
  venueLongitude: -87.2,
  venueRadiusMeters: 100,
  maxAccuracyMeters: 50,
  insideMarginFactor: 1,
  outsideMarginFactor: 1,
};
const METERS_PER_DEGREE_LAT = 111_195;
function northOfVenue(meters: number, accuracyMeters: number, lonJitter = 0.000_013): LocationClaim {
  return { latitude: VENUE.venueLatitude + meters / METERS_PER_DEGREE_LAT, longitude: VENUE.venueLongitude + lonJitter, accuracyMeters };
}
const INSIDE = northOfVenue(10, 5);
const OUTSIDE = northOfVenue(300, 5);
const AMBIGUOUS = northOfVenue(100, 20);

// Protected-function fingerprints, taken from the COMMITTED migration history applied to a clean database
// (md5 of pg_proc.prosrc). A deliberate future change to any of these must update the fingerprint here.
const BASELINE_PROSRC_MD5 = {
  cast_vote_atomically: "85fc9cfdc90133c5ccc022878b15dc85",
  start_session_atomically: "8b2ee0dfc8beaf37aff5a2f684df54c3",
  close_submissions_atomically: "61eb05f382e9de13dfaf079edd99c784",
  join_participant_atomically: "456ffa6b8c13ec7e3ebcb16efa2edd81",
} as const;

const NEW_FUNCTIONS = [
  "register_community_voting_instance_atomically",
  "bind_community_voting_voter_atomically",
  "issue_community_voting_intent_atomically",
  "create_community_voting_entry_atomically",
  "remove_community_voting_entry_atomically",
  "read_community_voting_preparation",
  "claim_community_voting_entry_atomically",
  "confirm_community_voting_entry_atomically",
  "start_community_voting_atomically",
  "cast_community_voting_vote_atomically",
  "read_community_voting_voter_status",
  "community_voting_assess_location",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

async function rawClient(): Promise<Client> {
  const c = new Client({ connectionString: dbUrl, statement_timeout: 30000 });
  await c.connect();
  return c;
}
async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}
async function newAuthUser(): Promise<string> {
  const id = randomUUID();
  await q("insert into auth.users (id, aud, role, email, created_at, updated_at) values ($1, 'authenticated', 'authenticated', $2, now(), now())", [
    id,
    `cv-contract-${id}@example.invalid`,
  ]);
  return id;
}

async function newEvent(opts: { register?: boolean; capabilities?: string[] } = {}) {
  const session = await createSession(sessionRepo);
  await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, (opts.capabilities ?? ["VOTING"]) as never);
  const instance = opts.register === false ? null : await repo.registerInstance({ sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 });
  return { session, instance: instance as NonNullable<typeof instance> };
}
type Event = Awaited<ReturnType<typeof newEvent>>;

async function bindNew(ev: Event) {
  const authUserId = await newAuthUser();
  const binding = await repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId });
  return { authUserId, ...binding };
}
type Voter = Awaited<ReturnType<typeof bindNew>>;

async function participantIdOf(bindingId: string): Promise<string> {
  return (await q<{ participant_id: string }>("select participant_id from community_voting_voter_bindings where binding_id = $1", [bindingId]))[0].participant_id;
}
async function participantTokenOf(bindingId: string): Promise<string> {
  return (
    await q<{ participant_token: string }>(
      "select p.participant_token from participants p join community_voting_voter_bindings b on b.participant_id = p.participant_id where b.binding_id = $1",
      [bindingId]
    )
  )[0].participant_token;
}

const hostArgs = (ev: Event) => ({ instanceId: ev.instance.instanceId, hostToken: ev.session.hostToken });

/** Full private preparation for each label: bind a contestant, host creates the entry, contestant claims it, host confirms it. */
async function prepareContestants(ev: Event, labels: string[]): Promise<Voter[]> {
  const contestants: Voter[] = [];
  for (const label of labels) {
    const contestant = await bindNew(ev);
    const entry = await repo.createEntry({ ...hostArgs(ev), label });
    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: contestant.authUserId, claimCode: entry.claimCode });
    await repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    contestants.push(contestant);
  }
  return contestants;
}

/** The explicit start: lock the lobby if the host has not, then the Community Voting start. Preparation never calls it. */
async function startBallot(ev: Event, promptText = "Mejor disfraz") {
  const state = (await sessionRepo.getSessionById(ev.session.sessionId))!.state;
  if (state === "LOBBY_OPEN") await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
  const started = await repo.startVoting({ ...hostArgs(ev), promptText });
  const rows = await sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
  return { interactionInstanceId: started.interactionInstanceId, candidates: rows, started };
}

async function openVoting(ev: Event, labels = ["Vampiro", "Bruja", "Fantasma"]) {
  const contestants = await prepareContestants(ev, labels);
  return { ...(await startBallot(ev)), contestants };
}
type Voting = Awaited<ReturnType<typeof openVoting>>;

/** A fully prepared, opened event: 3 confirmed contestants, then a plain voter who arrives while voting is open. */
async function preparedEvent() {
  const ev = await newEvent();
  const voting = await openVoting(ev);
  const voter = await bindNew(ev);
  return { ev, voting, contestants: voting.contestants, voter };
}

/** Everything a start or an opening would create or change, counted — for before/after rollback and no-trace assertions. */
async function ballotCounts(ev: Event) {
  const n = async (sql: string) => Number((await q<{ n: string }>(sql, [ev.session.sessionId]))[0].n);
  return {
    interactions: await n("select count(*)::text n from interaction_instances where session_id = $1"),
    segments: await n("select count(*)::text n from segments where session_id = $1"),
    candidates: await n("select count(*)::text n from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1"),
    startedEvents: await n("select count(*)::text n from session_events where session_id = $1 and event_type = 'INTERACTION_STARTED'"),
    linkedEntries: await n("select count(*)::text n from community_voting_entries e join community_voting_instances i on i.instance_id = e.instance_id where i.session_id = $1 and e.candidate_id is not null"),
    prompts: Number((await q<{ n: string }>("select count(*)::text n from prompts"))[0].n),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function issue(ev: Event, v: Voter) {
  return repo.issueIntent({ instanceId: ev.instance.instanceId, authUserId: v.authUserId });
}
async function cast(ev: Event, v: Voter, voting: { interactionInstanceId: string }, candidateId: string, intentNo: number, location: LocationClaim = INSIDE) {
  return repo.castVote({
    instanceId: ev.instance.instanceId,
    authUserId: v.authUserId,
    bindingId: v.bindingId,
    intentNo,
    interactionInstanceId: voting.interactionInstanceId,
    candidateId,
    location,
  });
}
async function voteEvents(sessionId: string): Promise<number> {
  return Number((await q<{ n: string }>("select count(*)::text as n from session_events where session_id = $1 and event_type = 'VOTE_CAST'", [sessionId]))[0].n);
}
async function votesFor(interactionInstanceId: string) {
  return q<{ participant_id: string; candidate_id: string; updated_at: Date }>("select participant_id, candidate_id, updated_at from votes where interaction_instance_id = $1", [interactionInstanceId]);
}
async function bindingRow(bindingId: string) {
  return (await q<Record<string, unknown>>("select * from community_voting_voter_bindings where binding_id = $1", [bindingId]))[0];
}
async function expectCode(promise: Promise<unknown>, code: string): Promise<CommunityVotingError> {
  const outcome = await promise.then(() => null, (e: unknown) => e);
  expect(outcome, `expected CommunityVotingError ${code}`).toBeInstanceOf(CommunityVotingError);
  expect((outcome as CommunityVotingError).code).toBe(code);
  return outcome as CommunityVotingError;
}
async function rawError(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, sql: string, params: unknown[] = []): Promise<{ message: string; code?: string }> {
  const err = await client.query(sql, params).then(() => null, (e: unknown) => e as { message: string; code?: string });
  expect(err, `expected the statement to fail: ${sql.slice(0, 60)}`).not.toBeNull();
  return err as { message: string; code?: string };
}

afterAll(async () => {
  await pool.end();
});

// ============================================================ structure, grants, protected functions

describe("Schema containment and database grants", () => {
  it("creates exactly the Community Voting tables — the three of the single-choice foundation and the sixteen of the two-round pilot (20261029100000) — with RLS enabled and no policies", async () => {
    const tables = await q<{ tablename: string; rowsecurity: boolean }>(
      "select c.relname as tablename, c.relrowsecurity as rowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'community_voting%' order by 1"
    );
    expect(tables).toEqual(
      [
        // the single-choice foundation
        "community_voting_entries",
        "community_voting_instances",
        "community_voting_voter_bindings",
        // the two-round pilot: preparation, schedule, the six separate things (photograph visibility, candidature withdrawal, the finalist
        // selection, the reviewed result, the published result and its snapshot), the Product decisions, the follow-up tasks and the audit trail
        "community_voting_closures",
        "community_voting_entry_consents",
        "community_voting_entry_photos",
        "community_voting_finalist_selections",
        "community_voting_finalists",
        "community_voting_followup_tasks",
        "community_voting_operator_actions",
        "community_voting_photo_decisions",
        "community_voting_photo_privacy_actions",
        "community_voting_policy_approvals",
        "community_voting_promo_consents",
        "community_voting_publications",
        "community_voting_published_results",
        "community_voting_round_reviews",
        "community_voting_schedules",
        "community_voting_withdrawals",
      ]
        .sort()
        .map((tablename) => ({ tablename, rowsecurity: true }))
    );
    const policies = await q("select 1 from pg_policies where tablename like 'community_voting%'");
    expect(policies).toHaveLength(0);
  });

  it("the SINGLE_CHOICE foundation creates no vote store, tally, ownership map or lifecycle column of its own (the pilot's rounds, a different mode, keep their own records in their own tables)", async () => {
    const all = await q<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v','m','p') and relname ilike any (array['%vote%','%ballot%','%tally%','%contestant%','%owner%','%candidate%']) order by 1");
    // Outside the two Instance tables, only the pre-existing Voting tables match: nothing new owns votes, tallies or contestants.
    expect(all.map((r) => r.relname).filter((n) => !n.startsWith("community_voting_")).sort()).toEqual(["votes", "voting_candidates"]);
    const instanceColumns = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'community_voting_instances'")).map((r) => r.column_name);
    expect(instanceColumns.some((c) => /state|status|phase|lifecycle|closed|open/.test(c))).toBe(false);
  });

  it("denies anon and authenticated every privilege on all three tables; service_role cannot delete, truncate or (for Instances) update", async () => {
    for (const table of ["community_voting_instances", "community_voting_voter_bindings", "community_voting_entries"]) {
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
          const [{ ok }] = await q<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, priv]);
          expect(ok, `${role} must not have ${priv} on ${table}`).toBe(false);
        }
      }
    }
    const privs = async (table: string, priv: string) => (await q<{ ok: boolean }>("select has_table_privilege('service_role', $1, $2) as ok", [table, priv]))[0].ok;
    expect(await privs("community_voting_instances", "select")).toBe(true);
    expect(await privs("community_voting_instances", "insert")).toBe(true);
    expect(await privs("community_voting_instances", "update")).toBe(false);
    expect(await privs("community_voting_instances", "delete")).toBe(false);
    expect(await privs("community_voting_voter_bindings", "select")).toBe(true);
    expect(await privs("community_voting_voter_bindings", "insert")).toBe(true);
    expect(await privs("community_voting_voter_bindings", "update")).toBe(true);
    expect(await privs("community_voting_voter_bindings", "delete")).toBe(false);
    expect(await privs("community_voting_voter_bindings", "truncate")).toBe(false);
    // preparation entries are working data until the ballot opens: removable and updatable (by the functions), never truncatable
    expect(await privs("community_voting_entries", "select")).toBe(true);
    expect(await privs("community_voting_entries", "insert")).toBe(true);
    expect(await privs("community_voting_entries", "update")).toBe(true);
    expect(await privs("community_voting_entries", "delete")).toBe(true);
    expect(await privs("community_voting_entries", "truncate")).toBe(false);
  });

  it("every new function is executable by service_role only — not PUBLIC, anon or authenticated", async () => {
    for (const fn of NEW_FUNCTIONS) {
      const rows = await q<{ oid: string }>("select p.oid::text as oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1", [fn]);
      expect(rows, `${fn} must exist exactly once`).toHaveLength(1);
      const acl = (await q<{ grantee: string }>("select coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') as grantee from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::oid and a.privilege_type = 'EXECUTE'", [rows[0].oid])).map((r) => r.grantee);
      expect(acl, fn).toContain("service_role");
      for (const denied of ["PUBLIC", "anon", "authenticated"]) expect(acl, `${fn} must not grant EXECUTE to ${denied}`).not.toContain(denied);
    }
  });

  it("direct calls as anon and authenticated are denied at the database (42501), never reaching domain logic", async () => {
    const dummy = [randomUUID(), randomUUID()];
    const calls: Array<[string, string, unknown[]]> = [
      ["register_community_voting_instance_atomically", "select * from register_community_voting_instance_atomically($1,'x',14.1,-87.2,100,50,1,1,1)", [dummy[0]]],
      ["bind_community_voting_voter_atomically", "select * from bind_community_voting_voter_atomically($1,$2)", dummy],
      ["issue_community_voting_intent_atomically", "select * from issue_community_voting_intent_atomically($1,$2)", dummy],
      ["create_community_voting_entry_atomically", "select * from create_community_voting_entry_atomically($1,'x','Uno',900)", [dummy[0]]],
      ["remove_community_voting_entry_atomically", "select * from remove_community_voting_entry_atomically($1,'x',$2)", dummy],
      ["read_community_voting_preparation", "select * from read_community_voting_preparation($1,'x')", [dummy[0]]],
      ["claim_community_voting_entry_atomically", "select * from claim_community_voting_entry_atomically($1,$2,'abc')", dummy],
      ["confirm_community_voting_entry_atomically", "select * from confirm_community_voting_entry_atomically($1,'x',$2,'ABCDEF12')", dummy],
      ["start_community_voting_atomically", "select * from start_community_voting_atomically($1,'x','Q')", [dummy[0]]],
      ["cast_community_voting_vote_atomically", "select * from cast_community_voting_vote_atomically($1,$2,$2,1,$2,$2,14.1,-87.2,5)", dummy],
      ["read_community_voting_voter_status", "select * from read_community_voting_voter_status($1,$2)", dummy],
      ["community_voting_assess_location", "select * from community_voting_assess_location(14.1,-87.2,100,50,1,1,14.1,-87.2,5)", []],
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const [fn, sql, params] of calls) {
        const c = await rawClient();
        try {
          await c.query("begin");
          await c.query(`set local role ${role}`);
          const err = await rawError(c, sql, params);
          expect(err.code, `${role} -> ${fn}`).toBe("42501");
        } finally {
          await c.query("rollback").catch(() => {});
          await c.end();
        }
      }
    }
  });

  it("direct calls through the REST surface with the PUBLIC anon key are denied", async () => {
    const attempts = await Promise.all([
      anon.rpc("bind_community_voting_voter_atomically", { p_instance_id: randomUUID(), p_auth_user_id: randomUUID() }),
      anon.rpc("cast_community_voting_vote_atomically", {
        p_instance_id: randomUUID(), p_auth_user_id: randomUUID(), p_binding_id: randomUUID(), p_intent_no: 1,
        p_interaction_instance_id: randomUUID(), p_candidate_id: randomUUID(), p_latitude: 14.1, p_longitude: -87.2, p_accuracy_meters: 5,
      }),
      anon.rpc("start_community_voting_atomically", { p_instance_id: randomUUID(), p_host_token: "x", p_prompt_text: "Q" }),
      anon.rpc("claim_community_voting_entry_atomically", { p_instance_id: randomUUID(), p_auth_user_id: randomUUID(), p_claim_code: "a".repeat(32) }),
      anon.rpc("confirm_community_voting_entry_atomically", { p_instance_id: randomUUID(), p_host_token: "x", p_entry_id: randomUUID(), p_confirmation_code: "ABCDEF12" }),
      anon.rpc("create_community_voting_entry_atomically", { p_instance_id: randomUUID(), p_host_token: "x", p_label: "Uno" }),
    ]);
    for (const { error } of attempts) {
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    }
    for (const t of ["community_voting_voter_bindings", "community_voting_entries", "community_voting_instances"]) {
      const table = await anon.from(t).select("*").limit(1);
      expect(table.error?.code, t).toBe("42501");
    }
  });

  it("service_role cannot delete bindings or instances through the REST surface (42501)", async () => {
    const ev = await newEvent();
    const voter = await bindNew(ev);
    const del = await service.from("community_voting_voter_bindings").delete().eq("binding_id", voter.bindingId);
    expect(del.error?.code).toBe("42501");
    const delInstance = await service.from("community_voting_instances").delete().eq("instance_id", ev.instance.instanceId);
    expect(delInstance.error?.code).toBe("42501");
    const upd = await service.from("community_voting_instances").update({ rule_version: 2 }).eq("instance_id", ev.instance.instanceId);
    expect(upd.error?.code).toBe("42501");
  });
});

describe("Protected Session/Voting functions", () => {
  it("cast_vote_atomically, start_session_atomically and close_submissions_atomically are byte-for-byte the committed definitions", async () => {
    for (const fn of ["cast_vote_atomically", "start_session_atomically", "close_submissions_atomically"] as const) {
      const rows = await q<{ src: string; acl: string | null }>("select prosrc as src, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [fn]);
      expect(rows, fn).toHaveLength(1);
      expect(md5(rows[0].src), `${fn} definition must be untouched`).toBe(BASELINE_PROSRC_MD5[fn]);
    }
  });

  it("cast_vote_atomically keeps its committed signature and ACL", async () => {
    const rows = await q<{ sig: string; acl: string }>("select p.oid::regprocedure::text as sig, p.proacl::text as acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cast_vote_atomically'");
    expect(rows).toHaveLength(1);
    expect(rows[0].sig).toBe("cast_vote_atomically(uuid,uuid,text,uuid)");
    expect(rows[0].acl).toBe("{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}");
  });

  it("join_participant_atomically keeps its signature and ACL and differs from the committed body ONLY by the guard block", async () => {
    const rows = await q<{ sig: string; acl: string; src: string }>("select p.oid::regprocedure::text as sig, p.proacl::text as acl, p.prosrc as src from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'join_participant_atomically'");
    expect(rows).toHaveLength(1);
    expect(rows[0].sig).toBe("join_participant_atomically(uuid,uuid,text,text,text,timestamp with time zone,text,jsonb,uuid)");
    expect(rows[0].acl).toBe("{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}");
    const guard = /\n  -- BEGIN community-voting guard[\s\S]*?-- END community-voting guard\n/;
    expect(guard.test(rows[0].src)).toBe(true);
    // Removing the single delimited block must restore the committed body exactly.
    expect(rows[0].src.match(new RegExp(guard.source, "g"))).toHaveLength(1);
    expect(md5(rows[0].src.replace(guard, ""))).toBe(BASELINE_PROSRC_MD5.join_participant_atomically);
  });

  it("the ONLY SQL functions that insert into participants are the ordinary join and the Community Voting bind", async () => {
    const writers = (await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'insert\\s+into\\s+(public\\.)?participants\\y' order by 1")).map((r) => r.proname);
    expect(writers).toEqual(["bind_community_voting_voter_atomically", "join_participant_atomically"]);
    const other = await q("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* '(update|delete\\s+from)\\s+(public\\.)?participants\\y'");
    expect(other).toHaveLength(0);
  });
});

// ============================================================ registration + ordinary join guard

describe("Instance registration", () => {
  it("registers one Instance per Session with explicit rule version and no lifecycle state", async () => {
    const ev = await newEvent();
    expect(ev.instance).toMatchObject({ ...VENUE, sessionId: ev.session.sessionId, ruleVersion: 1 });
    const rows = await q("select * from community_voting_instances where session_id = $1", [ev.session.sessionId]);
    expect(rows).toHaveLength(1);
    await expectCode(repo.registerInstance({ sessionId: ev.session.sessionId, hostToken: ev.session.hostToken, config: VENUE, ruleVersion: 1 }), "INSTANCE_ALREADY_REGISTERED");
    const state = (await sessionRepo.getSessionById(ev.session.sessionId))!.state;
    expect(state).toBe("LOBBY_OPEN");
  });

  it("requires host authority — including null-safe handling of a missing token", async () => {
    const ev = await newEvent({ register: false });
    await expect(repo.registerInstance({ sessionId: ev.session.sessionId, hostToken: "wrong", config: VENUE, ruleVersion: 1 })).rejects.toThrow(/./);
    const viaSql = await rawError(pool, "select * from register_community_voting_instance_atomically($1, null, 14.1, -87.2, 100, 50, 1, 1, 1)", [ev.session.sessionId]);
    expect(viaSql.message).toMatch(/HOST_TOKEN_MISMATCH/);
    const unknown = await rawError(pool, "select * from register_community_voting_instance_atomically($1, 'x', 14.1, -87.2, 100, 50, 1, 1, 1)", [randomUUID()]);
    expect(unknown.message).toMatch(/SESSION_NOT_FOUND/);
    expect(await q("select 1 from community_voting_instances where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });

  it.each([
    ["no capability declared", [] as string[]],
    ["VOTING plus another capability", ["VOTING", "TRIVIA"]],
    ["a different capability", ["OPEN_RESPONSE"]],
  ])("requires the capability set to be exactly VOTING (%s)", async (_label, caps) => {
    const session = await createSession(sessionRepo);
    if (caps.length) await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, caps as never);
    await expectCode(repo.registerInstance({ sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
  });

  it("treats a legacy Session with NULL capabilities as not exactly VOTING", async () => {
    const session = await createSession(sessionRepo);
    await q("update sessions set declared_capabilities = null where session_id = $1", [session.sessionId]);
    await expectCode(repo.registerInstance({ sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
  });

  it("must precede any Participant, and only registers a Session in a registrable state", async () => {
    const withGuest = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, withGuest.sessionId, withGuest.hostToken, ["VOTING"]);
    await joinSession(sessionRepo, withGuest.roomCode, "Ordinary Guest");
    await expectCode(repo.registerInstance({ sessionId: withGuest.sessionId, hostToken: withGuest.hostToken, config: VENUE, ruleVersion: 1 }), "PARTICIPANTS_ALREADY_EXIST");

    for (const state of ["SESSION_COMPLETE", "SESSION_PAUSED", "SESSION_INTRO", "PROMPT_ACTIVE", "SUBMISSIONS_CLOSED", "RESULT_REVEAL", "SOCIAL_PAUSE"]) {
      const s = await createSession(sessionRepo);
      await setSessionCapabilities(sessionRepo, s.sessionId, s.hostToken, ["VOTING"]);
      await q("update sessions set state = $2 where session_id = $1", [s.sessionId, state]);
      await expectCode(repo.registerInstance({ sessionId: s.sessionId, hostToken: s.hostToken, config: VENUE, ruleVersion: 1 }), "SESSION_NOT_REGISTRABLE");
    }
    // a locked Session with no Participant yet is registrable
    const locked = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, locked.sessionId, locked.hostToken, ["VOTING"]);
    await lockLobby(sessionRepo, locked.sessionId, locked.hostToken);
    await expect(repo.registerInstance({ sessionId: locked.sessionId, hostToken: locked.hostToken, config: VENUE, ruleVersion: 3 })).resolves.toMatchObject({ ruleVersion: 3 });
  });

  it("validates the geofence configuration in the function and, as a backstop, with table constraints", async () => {
    const ev = await newEvent({ register: false });
    const bad: Array<[string, GeofenceConfig]> = [
      ["radius zero", { ...VENUE, venueRadiusMeters: 0 }],
      ["latitude 91", { ...VENUE, venueLatitude: 91 }],
      ["negative margin", { ...VENUE, insideMarginFactor: -1 }],
      ["zero max accuracy", { ...VENUE, maxAccuracyMeters: 0 }],
    ];
    for (const [label, config] of bad) {
      await expectCode(repo.registerInstance({ sessionId: ev.session.sessionId, hostToken: ev.session.hostToken, config, ruleVersion: 1 }), "INVALID_GEOFENCE_CONFIG").catch((e) => {
        throw new Error(`${label}: ${(e as Error).message}`);
      });
    }
    // table-level backstop, bypassing the function (NaN is greater than every number in Postgres; the constraints must still refuse it)
    const nan = await rawError(pool, "insert into community_voting_instances (session_id, venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor, rule_version) values ($1, 14.1, -87.2, 'NaN'::float8, 50, 1, 1, 1)", [ev.session.sessionId]);
    expect(nan.code).toBe("23514");
    const ruleVersion = await rawError(pool, "insert into community_voting_instances (session_id, venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor, rule_version) values ($1, 14.1, -87.2, 100, 50, 1, 1, 0)", [ev.session.sessionId]);
    expect(ruleVersion.code).toBe("23514");
  });
});

describe("Authoritative ordinary-join guard and registration serialization", () => {
  it("refuses Guest and Gaming Member ordinary joins into an event-bound Session, in every Session state", async () => {
    const ev = await newEvent();
    await expect(joinSession(sessionRepo, ev.session.roomCode, "Sneaky Guest")).rejects.toThrow(/EVENT_BOUND|community-voting|event-bound/i);
    const memberAuth = await newAuthUser();
    const member = await gamingRepo.createGamingMember(memberAuth, "Member Name");
    await expect(joinSession(sessionRepo, ev.session.roomCode, "Member Name", member.gamingMemberId)).rejects.toThrow(/EVENT_BOUND|event-bound/i);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await expect(joinSession(sessionRepo, ev.session.roomCode, "Late Guest")).rejects.toThrow();
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });

  it("refuses a direct RPC to the ordinary join function too (the guard is inside the function, not the route)", async () => {
    const ev = await newEvent();
    const err = await rawError(
      pool,
      "select join_participant_atomically($1,$2,'Direct','direct',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)",
      [randomUUID(), ev.session.sessionId, `direct-token-${randomUUID()}`]
    );
    expect(err.message).toMatch(/EVENT_BOUND/);
    const viaRest = await anon.rpc("join_participant_atomically", {
      p_participant_id: randomUUID(), p_session_id: ev.session.sessionId, p_display_name: "Anon", p_normalized_display_name: "anon",
      p_participant_token: `anon-token-${randomUUID()}`, p_joined_at: new Date().toISOString(), p_event_type: "PARTICIPANT_JOINED", p_event_payload: {}, p_gaming_member_id: null,
    });
    expect(viaRest.error?.message ?? "").toMatch(/EVENT_BOUND/);
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });

  it("the two guard lookups are the only security-definer functions: fixed search_path, bare answers, reading only what they must", async () => {
    const [fn] = await q<{ prosecdef: boolean; result: string; config: string[]; src: string; volatility: string }>(
      "select prosecdef, pg_get_function_result(oid) as result, proconfig as config, prosrc as src, provolatile as volatility from pg_proc where pronamespace = 'public'::regnamespace and proname = 'community_voting_session_is_event_bound'"
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.result).toBe("boolean");
    expect(fn.config).toContain("search_path=public");
    expect(fn.volatility).toBe("s");
    expect(fn.src).toMatch(/public\.community_voting_instances/);
    expect(fn.src).not.toMatch(/participants|votes|sessions|auth\./);
    // The second lookup: which event-bound Session (if any) owns an interaction. Needed because the candidate guard
    // fires for whoever calls the ordinary start, and a browser role can see none of the Community Voting tables.
    const [lookup] = await q<{ prosecdef: boolean; result: string; config: string[]; src: string; volatility: string }>(
      "select prosecdef, pg_get_function_result(oid) as result, proconfig as config, prosrc as src, provolatile as volatility from pg_proc where pronamespace = 'public'::regnamespace and proname = 'community_voting_event_session_of_interaction'"
    );
    expect(lookup.prosecdef).toBe(true);
    expect(lookup.result).toBe("uuid");
    expect(lookup.config).toContain("search_path=public");
    expect(lookup.volatility).toBe("s");
    expect(lookup.src).toMatch(/public\.interaction_instances/);
    expect(lookup.src).toMatch(/public\.community_voting_instances/);
    expect(lookup.src).not.toMatch(/participants|votes|sessions|auth\.|host_token|entries|bindings/);
    // The only security-definer functions Community Voting adds: these two, plus the two-round pilot's two (20261029100200): the
    // Session lookup that serves the votes and interaction guards for a round (needed for the same reason as the first two), and the
    // one-boolean "is this Auth user's email confirmed" (auth.users is unreadable by the calling roles; EXECUTE is revoked from every
    // browser role). Nothing else.
    const definers = await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and proname like '%community_voting%' order by proname");
    expect(definers.map((r) => r.proname)).toEqual([
      "community_voting_email_confirmed",
      "community_voting_event_session_of_interaction",
      "community_voting_scope_of_interaction",
      "community_voting_session_is_event_bound",
    ]);
    const ev = await newEvent();
    const ordinary = await createSession(sessionRepo);
    const asAnon = async (id: string) => (await anon.rpc("community_voting_session_is_event_bound", { p_session_id: id })).data;
    expect(await asAnon(ev.session.sessionId)).toBe(true);
    expect(await asAnon(ordinary.sessionId)).toBe(false);
    expect(await asAnon(randomUUID())).toBe(false);
    // The interaction lookup answers only for an event-bound interaction, and only with its Session id.
    const asAnonInteraction = async (id: string) => (await anon.rpc("community_voting_event_session_of_interaction", { p_interaction_instance_id: id })).data;
    expect(await asAnonInteraction(randomUUID())).toBeNull();
  });

  it("the guard answers identically for every caller: an anon or authenticated direct join into an ordinary Session raises no NEW error", async () => {
    const ordinary = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, ordinary.sessionId, ordinary.hostToken, ["VOTING"]);
    const viaRest = await anon.rpc("join_participant_atomically", {
      p_participant_id: randomUUID(), p_session_id: ordinary.sessionId, p_display_name: "Anon Ordinary", p_normalized_display_name: "anon ordinary",
      p_participant_token: `anon-token-${randomUUID()}`, p_joined_at: new Date().toISOString(), p_event_type: "PARTICIPANT_JOINED", p_event_payload: {}, p_gaming_member_id: null,
    });
    // Whatever this role could do before the guard it can still do (locally: join), and the guard introduces no
    // permission error on the new table.
    expect(viaRest.error?.message ?? "").not.toMatch(/community_voting|EVENT_BOUND/);
    for (const role of ["anon", "authenticated"]) {
      const c = await rawClient();
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        const s = await createSession(sessionRepo);
        await setSessionCapabilities(sessionRepo, s.sessionId, s.hostToken, ["VOTING"]);
        const outcome = await c.query("select join_participant_atomically($1,$2,'Role Check','role check',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)", [randomUUID(), s.sessionId, `role-${randomUUID()}`]).then(() => "ok", (e: Error) => e.message);
        expect(String(outcome)).not.toMatch(/community_voting|EVENT_BOUND/);
        // ... and the same role IS refused for an event-bound Session, by the guard, not by a privilege error.
        const ev = await newEvent();
        await c.query("rollback");
        await c.query("begin");
        await c.query(`set local role ${role}`);
        const refused = await c.query("select join_participant_atomically($1,$2,'Role Check','role check',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)", [randomUUID(), ev.session.sessionId, `role-${randomUUID()}`]).then(() => "ok", (e: Error) => e.message);
        expect(String(refused)).toMatch(/EVENT_BOUND/);
      } finally {
        await c.query("rollback").catch(() => {});
        await c.end();
      }
    }
  });

  it("ordinary joining into a NON-event Session is unchanged (success and the existing errors)", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    const a = await joinSession(sessionRepo, session.roomCode, "Alex");
    expect(a.gamingMemberId).toBeNull();
    await expect(joinSession(sessionRepo, session.roomCode, "alex")).rejects.toBeInstanceOf(DisplayNameTakenError);
    const memberAuth = await newAuthUser();
    const member = await gamingRepo.createGamingMember(memberAuth, "Sam Member");
    const m = await joinSession(sessionRepo, session.roomCode, "Sam Member", member.gamingMemberId);
    expect(m.gamingMemberId).toBe(member.gamingMemberId);
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    await expect(joinSession(sessionRepo, session.roomCode, "Late")).rejects.toBeInstanceOf(LobbyNotOpenError);
  });

  it("an ordinary join that commits first makes registration fail; a registration that commits first makes the ordinary join fail — never both", async () => {
    // ---- order 1: ordinary join holds the Session lock, registration must wait, then be refused
    const s1 = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, s1.sessionId, s1.hostToken, ["VOTING"]);
    const a = await rawClient();
    try {
      await a.query("begin");
      await a.query("select join_participant_atomically($1,$2,'Guest One','guest one',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)", [randomUUID(), s1.sessionId, `tok-${randomUUID()}`]);
      let settled = false;
      const registration = repo.registerInstance({ sessionId: s1.sessionId, hostToken: s1.hostToken, config: VENUE, ruleVersion: 1 }).finally(() => { settled = true; });
      registration.catch(() => {});
      await sleep(600);
      expect(settled, "registration must be blocked behind the join's Session lock").toBe(false);
      await a.query("commit");
      await expectCode(registration, "PARTICIPANTS_ALREADY_EXIST");
    } finally {
      await a.query("rollback").catch(() => {});
      await a.end();
    }
    expect(await q("select 1 from community_voting_instances where session_id = $1", [s1.sessionId])).toHaveLength(0);

    // ---- order 2: registration holds the Session lock, the ordinary join must wait, then be refused
    const s2 = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, s2.sessionId, s2.hostToken, ["VOTING"]);
    const c = await rawClient();
    const d = await rawClient();
    try {
      await c.query("begin");
      await c.query("select * from register_community_voting_instance_atomically($1,$2,14.1,-87.2,100,50,1,1,1)", [s2.sessionId, s2.hostToken]);
      let joined: { ok: boolean; message?: string } | null = null;
      const join = d
        .query("select join_participant_atomically($1,$2,'Guest Two','guest two',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)", [randomUUID(), s2.sessionId, `tok-${randomUUID()}`])
        .then(() => { joined = { ok: true }; }, (e: Error) => { joined = { ok: false, message: e.message }; });
      await sleep(600);
      expect(joined, "the ordinary join must be blocked behind the registration's Session lock").toBeNull();
      await c.query("commit");
      await join;
      expect(joined).toMatchObject({ ok: false });
      expect(joined!.message).toMatch(/EVENT_BOUND/);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
      await d.end();
    }
    expect(await q("select 1 from participants where session_id = $1", [s2.sessionId])).toHaveLength(0);
    expect(await q("select 1 from community_voting_instances where session_id = $1", [s2.sessionId])).toHaveLength(1);
  });

  it("many concurrent ordinary joins racing one registration end in exactly one consistent world", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await createSession(sessionRepo);
      await setSessionCapabilities(sessionRepo, s.sessionId, s.hostToken, ["VOTING"]);
      const joins = Array.from({ length: 4 }, (_, i) => joinSession(sessionRepo, s.roomCode, `Racer ${round}-${i}`).then(() => "joined", () => "refused"));
      const registration = repo.registerInstance({ sessionId: s.sessionId, hostToken: s.hostToken, config: VENUE, ruleVersion: 1 }).then(() => "registered", () => "refused");
      const outcomes = await Promise.all([registration, ...joins]);
      const instances = (await q("select 1 from community_voting_instances where session_id = $1", [s.sessionId])).length;
      const participants = (await q("select 1 from participants where session_id = $1", [s.sessionId])).length;
      expect(instances === 1 && participants > 0, `round ${round}: an event-bound Session must never hold an ordinary participant (${outcomes.join(",")})`).toBe(false);
      if (instances === 1) expect(participants).toBe(0);
      if (participants > 0) expect(instances).toBe(0);
    }
  });
});

// ============================================================ binding

describe("Verified voter binding (database)", () => {
  it("creates the binding, an opaque Participant and a PARTICIPANT_JOINED event atomically — with no profile and no token in the result", async () => {
    const ev = await newEvent();
    const authUserId = await newAuthUser();
    const membersBefore = Number((await q<{ n: string }>("select count(*)::text n from gaming_members"))[0].n);
    const raw = await q("select * from bind_community_voting_voter_atomically($1,$2)", [ev.instance.instanceId, authUserId]);
    expect(Object.keys(raw[0]).sort()).toEqual(["binding_id", "created", "instance_id"]);
    expect(raw[0].created).toBe(true);
    const participants = await q<{ display_name: string; normalized_display_name: string; participant_token: string; gaming_member_id: string | null }>("select display_name, normalized_display_name, participant_token, gaming_member_id from participants where session_id = $1", [ev.session.sessionId]);
    expect(participants).toHaveLength(1);
    expect(participants[0].display_name).toMatch(/^cv-[0-9a-f]{16}$/);
    expect(participants[0].normalized_display_name).toBe(participants[0].display_name);
    expect(participants[0].participant_token).toMatch(/^[0-9a-f]{64}$/);
    expect(participants[0].gaming_member_id).toBeNull();
    expect(participants[0].display_name).not.toContain(authUserId.slice(0, 8));
    const membersAfter = Number((await q<{ n: string }>("select count(*)::text n from gaming_members"))[0].n);
    expect(membersAfter).toBe(membersBefore);
    const events = await q<{ payload: unknown }>("select payload from session_events where session_id = $1 and event_type = 'PARTICIPANT_JOINED'", [ev.session.sessionId]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].payload)).not.toContain(participants[0].participant_token);
    expect(JSON.stringify(events[0].payload)).not.toContain(authUserId);
  });

  it("is idempotent and concurrency-safe: one binding and one Participant per Instance and Auth user", async () => {
    const ev = await newEvent();
    const authUserId = await newAuthUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId })));
    expect(new Set(results.map((r) => r.bindingId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(1);
    expect(await q("select 1 from community_voting_voter_bindings where instance_id = $1", [ev.instance.instanceId])).toHaveLength(1);
  });

  it("rejects an unknown Instance and an unknown Auth user (foreign-key backstop)", async () => {
    const ev = await newEvent();
    await expectCode(repo.bindVoter({ instanceId: randomUUID(), authUserId: await newAuthUser() }), "INSTANCE_NOT_FOUND");
    const unknownUser = await rawError(pool, "select * from bind_community_voting_voter_atomically($1,$2)", [ev.instance.instanceId, randomUUID()]);
    expect(unknownUser.code).toBe("23503");
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });

  it("re-checks the capability set at bind time", async () => {
    const ev = await newEvent();
    await setSessionCapabilities(sessionRepo, ev.session.sessionId, ev.session.hostToken, ["VOTING", "TRIVIA"]);
    await expectCode(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() }), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });

  describe("bounded admission states", () => {
    it("admits: lobby open; locked with no interaction; locked while the event Voting interaction is open", async () => {
      const ev = await newEvent();
      await bindNew(ev);
      await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      await bindNew(ev);
      await openVoting(ev, ["Uno", "Dos"]); // binds two contestants, prepares them, and opens through the explicit start
      await bindNew(ev); // late arrival while voting is open
      expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(5);
    });

    it("rejects: closed, revealed, completed — and every unsupported Session state", async () => {
      const ev = await newEvent();
      const early = await bindNew(ev);
      await openVoting(ev);
      await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      await expectCode(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() }), "ADMISSION_CLOSED");
      await revealResults(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      await expectCode(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() }), "ADMISSION_CLOSED");
      await completeSession(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      await expectCode(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() }), "ADMISSION_CLOSED");
      // an EXISTING binding is still recovered in a closed state
      await expect(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: early.authUserId })).resolves.toMatchObject({ bindingId: early.bindingId, created: false });

      for (const state of ["SESSION_PAUSED", "SESSION_INTRO", "PROMPT_ACTIVE", "SUBMISSIONS_CLOSED", "RESULT_REVEAL", "SOCIAL_PAUSE", "SESSION_COMPLETE"]) {
        const e2 = await newEvent();
        await q("update sessions set state = $2 where session_id = $1", [e2.session.sessionId, state]);
        await expectCode(repo.bindVoter({ instanceId: e2.instance.instanceId, authUserId: await newAuthUser() }), "ADMISSION_CLOSED");
        expect(await q("select 1 from participants where session_id = $1", [e2.session.sessionId])).toHaveLength(0);
      }
    });
  });

  it("takes the Session lock first: a bind waits for an in-flight lifecycle transition and then sees the new state", async () => {
    const ev = await newEvent();
    const a = await rawClient();
    try {
      await a.query("begin");
      await a.query("select 1 from sessions where session_id = $1 for update", [ev.session.sessionId]);
      await a.query("update sessions set state = 'SESSION_COMPLETE' where session_id = $1", [ev.session.sessionId]);
      let settled = false;
      const bind = repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() }).finally(() => { settled = true; });
      bind.catch(() => {});
      await sleep(600);
      expect(settled, "the bind must wait for the Session lock").toBe(false);
      await a.query("commit");
      await expectCode(bind, "ADMISSION_CLOSED");
    } finally {
      await a.query("rollback").catch(() => {});
      await a.end();
    }
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
  });
});

// ============================================================ attribution + preparation

// ============================================================ preparation, claims, confirmation (all before opening)

/** A transaction held open on its own connection, so a concurrent call must wait behind its Session lock. */
async function holdTx() {
  const client = await rawClient();
  await client.query("begin");
  return {
    client,
    commit: async () => {
      await client.query("commit");
      await client.end();
    },
    rollback: async () => {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    },
  };
}
/** Tracks whether a promise has settled, without letting a rejection go unhandled. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; }
  );
  return { state, promise };
}

describe("Private preparation (database)", () => {
  it("builds a complete ballot WITHOUT opening Voting: no interaction, candidate, segment, started-event or link appears", async () => {
    const ev = await newEvent();
    const before = await ballotCounts(ev);
    await prepareContestants(ev, ["Uno", "Dos", "Tres"]);
    expect(await ballotCounts(ev)).toEqual(before);
    expect(before).toMatchObject({ interactions: 0, segments: 0, candidates: 0, startedEvents: 0, linkedEntries: 0 });
    expect((await sessionRepo.getSessionById(ev.session.sessionId))!.state).toBe("LOBBY_OPEN");
    const view = await repo.readPreparation(hostArgs(ev));
    expect(view.map((e) => [e.label, e.state])).toEqual([["Uno", "CONFIRMED"], ["Dos", "CONFIRMED"], ["Tres", "CONFIRMED"]]);
    const watcher = await bindNew(ev);
    const status = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: watcher.authUserId });
    expect(status).toMatchObject({ interactionInstanceId: null, interactionState: null });
    await expectCode(issue(ev, watcher), "VOTING_NOT_OPEN");
  });

  it("stores DIGESTS, never the secrets: the claim credential and the confirmation code exist in the clear only in the responses", async () => {
    const ev = await newEvent();
    const contestant = await bindNew(ev);
    const dumpOf = async () =>
      JSON.stringify({
        entries: await q("select * from community_voting_entries where instance_id = $1", [ev.instance.instanceId]),
        events: await q("select payload from session_events where session_id = $1", [ev.session.sessionId]),
        bindings: await q("select * from community_voting_voter_bindings where instance_id = $1", [ev.instance.instanceId]),
      });
    const entryRow = async () => (await q<Record<string, unknown>>("select * from community_voting_entries where instance_id = $1", [ev.instance.instanceId]))[0];

    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
    expect(entry.claimCode).toMatch(/^[0-9a-f]{32}$/);
    let row = await entryRow();
    expect(row.claim_code_hash).toBe(sha256(entry.claimCode));
    expect(row.pending_binding_id).toBeNull();
    expect(await dumpOf()).not.toContain(entry.claimCode);

    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: contestant.authUserId, claimCode: entry.claimCode });
    expect(claimed.confirmationCode).toMatch(/^[0-9A-F]{8}$/);
    row = await entryRow();
    expect(row.claim_code_hash).toBeNull(); // single use: consumed
    expect(row.confirmation_code_hash).toBe(sha256(claimed.confirmationCode));
    expect(row.pending_binding_id).toBe(contestant.bindingId);
    const pendingDump = await dumpOf();
    expect(pendingDump).not.toContain(entry.claimCode);
    expect(pendingDump).not.toContain(claimed.confirmationCode);

    await repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    row = await entryRow();
    expect(row).toMatchObject({ claim_code_hash: null, confirmation_code_hash: null, pending_binding_id: null, confirmed_binding_id: contestant.bindingId, confirmation_failures: 0 });
    expect(row.confirmed_at).toBeInstanceOf(Date);
    expect(await dumpOf()).not.toContain(claimed.confirmationCode);
  });

  it("the host's preparation read exposes only entry id, label, state and claim availability — no identity, no secret", async () => {
    const ev = await newEvent();
    const contestant = await bindNew(ev);
    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: contestant.authUserId, claimCode: entry.claimCode });
    const raw = await q("select * from read_community_voting_preparation($1,$2)", [ev.instance.instanceId, ev.session.hostToken]);
    expect(Object.keys(raw[0]).sort()).toEqual(["claim_expires_at", "claimable", "entry_id", "label", "state"]);
    const participant = (await q<{ display_name: string; participant_id: string; participant_token: string }>("select display_name, participant_id, participant_token from participants where session_id = $1", [ev.session.sessionId]))[0];
    const text = JSON.stringify(raw);
    for (const secret of [entry.claimCode, claimed.confirmationCode, contestant.authUserId, contestant.bindingId, participant.display_name, participant.participant_id, participant.participant_token]) {
      expect(text).not.toContain(secret);
    }
    expect((await rawError(pool, "select * from read_community_voting_preparation($1,null)", [ev.instance.instanceId])).message).toMatch(/HOST_TOKEN_MISMATCH/);
    expect((await rawError(pool, "select * from read_community_voting_preparation($1,'wrong')", [ev.instance.instanceId])).message).toMatch(/HOST_TOKEN_MISMATCH/);
    expect((await rawError(pool, "select * from read_community_voting_preparation($1,$2)", [randomUUID(), ev.session.hostToken])).message).toMatch(/INSTANCE_NOT_FOUND/);
  });

  it("every host operation requires host authority — including a NULL token — and leaves nothing behind", async () => {
    const ev = await newEvent();
    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
    const wrong = { instanceId: ev.instance.instanceId, hostToken: "wrong" };
    await expect(repo.createEntry({ ...wrong, label: "Dos" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(repo.removeEntry({ ...wrong, entryId: entry.entryId })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(repo.confirmEntry({ ...wrong, entryId: entry.entryId, confirmationCode: "ABCDEF12" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(repo.readPreparation(wrong)).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expect(repo.startVoting({ ...wrong, promptText: "Q" })).rejects.toBeInstanceOf(HostTokenMismatchError);
    for (const sql of [
      "select * from create_community_voting_entry_atomically($1,null,'Dos',900)",
      "select * from remove_community_voting_entry_atomically($1,null,$2)",
      "select * from confirm_community_voting_entry_atomically($1,null,$2,'ABCDEF12')",
      "select * from start_community_voting_atomically($1,null,'Q')",
    ]) {
      const params = sql.includes("$2") ? [ev.instance.instanceId, entry.entryId] : [ev.instance.instanceId];
      expect((await rawError(pool, sql, params)).message, sql).toMatch(/HOST_TOKEN_MISMATCH/);
    }
    expect(await repo.readPreparation(hostArgs(ev))).toHaveLength(1);
  });

  it("validates labels in the database: trimmed, 1..60 characters, unique ignoring case; and bounds the claim window", async () => {
    const ev = await newEvent();
    const call = (label: string, ttl = 900) => rawError(pool, "select * from create_community_voting_entry_atomically($1,$2,$3,$4)", [ev.instance.instanceId, ev.session.hostToken, label, ttl]);
    for (const bad of ["", "   ", "x".repeat(61)]) expect((await call(bad)).message, JSON.stringify(bad)).toMatch(/CV_ENTRY_LABEL_INVALID/);
    const ok = await repo.createEntry({ ...hostArgs(ev), label: "  Drácula  " });
    expect(ok.label).toBe("Drácula");
    expect((await call("DRÁCULA")).message).toMatch(/CV_ENTRY_LABEL_DUPLICATE/);
    expect((await call("Ok", 0)).message).toMatch(/CV_INVALID_REQUEST/);
    expect((await call("Ok", 86401)).message).toMatch(/CV_INVALID_REQUEST/);
    expect(await repo.readPreparation(hostArgs(ev))).toHaveLength(1);
  });

  it("enforces its association invariants in the table itself, whatever calls it: one entry per contestant, never cross-event, never pending AND confirmed", async () => {
    const a = await newEvent();
    const b = await newEvent();
    const aOne = await bindNew(a);
    const bOne = await bindNew(b);
    const e1 = await repo.createEntry({ ...hostArgs(a), label: "Uno" });
    const e2 = await repo.createEntry({ ...hostArgs(a), label: "Dos" });
    const confirmSql = "update community_voting_entries set claim_code_hash = null, confirmed_binding_id = $2, confirmed_at = now() where entry_id = $1";

    // a binding of ANOTHER event can never be associated (composite foreign key)
    const cross = await rawError(pool, confirmSql, [e1.entryId, bOne.bindingId]);
    expect(cross.code).toBe("23503");
    // one binding on two entries (duplicate association)
    await pool.query(confirmSql, [e1.entryId, aOne.bindingId]);
    const dup = await rawError(pool, confirmSql, [e2.entryId, aOne.bindingId]);
    expect(["23505", "P0001"]).toContain(dup.code);
    // a binding both pending on one entry and confirmed on another
    const mixed = await rawError(
      pool,
      "update community_voting_entries set claim_code_hash = null, pending_binding_id = $2, confirmation_code_hash = $3, confirmation_expires_at = now() + interval '1 hour' where entry_id = $1",
      [e2.entryId, aOne.bindingId, "a".repeat(64)]
    );
    expect(["23505", "P0001"]).toContain(mixed.code);
    // an entry that is both pending and confirmed
    const both = await rawError(pool, "update community_voting_entries set pending_binding_id = confirmed_binding_id, confirmation_code_hash = $2, confirmation_expires_at = now() + interval '1 hour' where entry_id = $1", [e1.entryId, "b".repeat(64)]);
    expect(["23514", "P0001"]).toContain(both.code);
    // a label cannot collide ignoring case
    const label = await rawError(pool, "update community_voting_entries set label = 'UNO' where entry_id = $1", [e2.entryId]);
    expect(["23505", "P0001"]).toContain(label.code);
    // the entry's own identity never changes
    const reassign = await rawError(pool, "update community_voting_entries set instance_id = $2 where entry_id = $1", [e1.entryId, b.instance.instanceId]);
    expect(reassign.code).toBe("P0001");
  });

  describe("the claim", () => {
    it("requires a binding to THIS Instance and consumes the credential: reuse, by anyone, fails closed", async () => {
      const ev = await newEvent();
      const a = await bindNew(ev);
      const b = await bindNew(ev);
      const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const id = ev.instance.instanceId;
      await expectCode(repo.claimEntry({ instanceId: id, authUserId: await newAuthUser(), claimCode: entry.claimCode }), "NOT_BOUND");
      await repo.claimEntry({ instanceId: id, authUserId: a.authUserId, claimCode: entry.claimCode });
      await expectCode(repo.claimEntry({ instanceId: id, authUserId: b.authUserId, claimCode: entry.claimCode }), "CLAIM_INVALID");
      await expectCode(repo.claimEntry({ instanceId: id, authUserId: a.authUserId, claimCode: entry.claimCode }), "CLAIM_INVALID");
      const [row] = await repo.readPreparation(hostArgs(ev));
      expect(row.state).toBe("PENDING_CONFIRMATION");
    });

    it("fails closed on a wrong, malformed or foreign-event credential and changes nothing", async () => {
      const a = await newEvent();
      const b = await newEvent();
      const inA = await bindNew(a);
      const inB = await bindNew(b);
      const aEntry = await repo.createEntry({ ...hostArgs(a), label: "Uno" });
      const bEntry = await repo.createEntry({ ...hostArgs(b), label: "Uno" });
      for (const wrong of ["0".repeat(32), "z".repeat(32), "short", "", aEntry.claimCode.slice(0, 31), `${aEntry.claimCode}0`, aEntry.claimCode.toUpperCase().replace(/[0-9]/g, "g")]) {
        await expectCode(repo.claimEntry({ instanceId: a.instance.instanceId, authUserId: inA.authUserId, claimCode: wrong }), "CLAIM_INVALID");
      }
      await expectCode(repo.claimEntry({ instanceId: a.instance.instanceId, authUserId: inA.authUserId, claimCode: bEntry.claimCode }), "CLAIM_INVALID"); // event B's credential in event A
      await expectCode(repo.claimEntry({ instanceId: b.instance.instanceId, authUserId: inB.authUserId, claimCode: aEntry.claimCode }), "CLAIM_INVALID"); // event A's credential in event B
      await expectCode(repo.claimEntry({ instanceId: a.instance.instanceId, authUserId: inB.authUserId, claimCode: aEntry.claimCode }), "NOT_BOUND"); // bound only to B
      expect((await repo.readPreparation(hostArgs(a)))[0].state).toBe("UNCLAIMED");
      expect((await repo.readPreparation(hostArgs(b)))[0].state).toBe("UNCLAIMED");
    });

    it("fails closed once the credential has expired (database clock)", async () => {
      const ev = await newEvent();
      const voter = await bindNew(ev);
      const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno", claimTtlSeconds: 1 });
      await sleep(1400);
      expect((await repo.readPreparation(hostArgs(ev)))[0].claimable).toBe(false);
      await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: entry.claimCode }), "CLAIM_EXPIRED");
      expect((await repo.readPreparation(hostArgs(ev)))[0].state).toBe("UNCLAIMED");
    });

    it("a contestant identity holds exactly ONE entry — pending or confirmed", async () => {
      const ev = await newEvent();
      const voter = await bindNew(ev);
      const one = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const two = await repo.createEntry({ ...hostArgs(ev), label: "Dos" });
      const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: one.claimCode });
      await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: two.claimCode }), "CONTESTANT_ALREADY_HAS_ENTRY");
      await repo.confirmEntry({ ...hostArgs(ev), entryId: one.entryId, confirmationCode: claimed.confirmationCode });
      await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: two.claimCode }), "CONTESTANT_ALREADY_HAS_ENTRY");
    });

    it("two voters racing for one credential: exactly one claims it", async () => {
      const ev = await newEvent();
      const a = await bindNew(ev);
      const b = await bindNew(ev);
      const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const attempt = (who: Voter) => repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: who.authUserId, claimCode: entry.claimCode }).then(() => "claimed", (e: CommunityVotingError) => e.code);
      const outcomes = await Promise.all([attempt(a), attempt(b), attempt(a), attempt(b)]);
      expect(outcomes.filter((o) => o === "claimed")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "CLAIM_INVALID")).toHaveLength(3);
      const pending = (await q<{ pending_binding_id: string }>("select pending_binding_id from community_voting_entries where entry_id = $1", [entry.entryId]))[0].pending_binding_id;
      expect([a.bindingId, b.bindingId]).toContain(pending);
    });
  });

  describe("the confirmation", () => {
    it("persists failed attempts (they are not rolled back), voids the claim on the 5th, and refuses everything afterwards", async () => {
      const ev = await newEvent();
      const voter = await bindNew(ev);
      const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: entry.claimCode });
      const wrong = claimed.confirmationCode === "00000000" ? "11111111" : "00000000";
      const failures = async () => Number((await q<{ f: number }>("select confirmation_failures as f from community_voting_entries where entry_id = $1", [entry.entryId]))[0].f);
      for (let i = 1; i <= 4; i++) {
        await expectCode(repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: wrong }), "CONFIRMATION_REJECTED");
        expect(await failures(), `failure ${i} must be committed`).toBe(i);
      }
      await expectCode(repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: wrong }), "CLAIM_VOIDED");
      const [row] = await q<Record<string, unknown>>("select * from community_voting_entries where entry_id = $1", [entry.entryId]);
      expect(row).toMatchObject({ pending_binding_id: null, confirmation_code_hash: null, confirmed_binding_id: null, claim_code_hash: null, confirmation_failures: 0 });
      await expectCode(repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: claimed.confirmationCode }), "CONFIRMATION_NOT_PENDING");
      await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: entry.claimCode }), "CLAIM_INVALID");
      expect((await repo.readPreparation(hostArgs(ev)))[0]).toMatchObject({ state: "UNCLAIMED", claimable: false });
    });

    it("accepts the code case-insensitively and with separators, and the confirmation window expires", async () => {
      const ev = await newEvent();
      const a = await bindNew(ev);
      const b = await bindNew(ev);
      const e1 = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const c1 = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: a.authUserId, claimCode: e1.claimCode });
      const loose = `${c1.confirmationCode.slice(0, 4)}-${c1.confirmationCode.slice(4)}`.toLowerCase();
      await expect(repo.confirmEntry({ ...hostArgs(ev), entryId: e1.entryId, confirmationCode: loose })).resolves.toMatchObject({ state: "CONFIRMED" });

      const e2 = await repo.createEntry({ ...hostArgs(ev), label: "Dos", claimTtlSeconds: 1 });
      const c2 = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: b.authUserId, claimCode: e2.claimCode });
      await sleep(1400);
      await expectCode(repo.confirmEntry({ ...hostArgs(ev), entryId: e2.entryId, confirmationCode: c2.confirmationCode }), "CLAIM_EXPIRED");
      expect((await repo.readPreparation(hostArgs(ev)))[1].state).toBe("PENDING_CONFIRMATION");
    });

    it("an entry of another event is not found, and nothing there is touched", async () => {
      const a = await newEvent();
      const b = await newEvent();
      const foreign = await repo.createEntry({ ...hostArgs(b), label: "Uno" });
      await expectCode(repo.confirmEntry({ ...hostArgs(a), entryId: foreign.entryId, confirmationCode: "ABCDEF12" }), "ENTRY_NOT_FOUND");
      await expectCode(repo.removeEntry({ ...hostArgs(a), entryId: foreign.entryId }), "ENTRY_NOT_FOUND");
      await expectCode(repo.confirmEntry({ ...hostArgs(a), entryId: randomUUID(), confirmationCode: "ABCDEF12" }), "ENTRY_NOT_FOUND");
      expect((await repo.readPreparation(hostArgs(b)))[0].state).toBe("UNCLAIMED");
    });

    it("a voter who obtains the claim code first cannot take the entry: the host does not confirm, recreates it, and the intended contestant ends up owning it", async () => {
      const ev = await newEvent();
      const intended = await bindNew(ev);
      const thief = await bindNew(ev);
      const first = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: thief.authUserId, claimCode: first.claimCode });
      await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: intended.authUserId, claimCode: first.claimCode }), "CLAIM_INVALID");
      await repo.removeEntry({ ...hostArgs(ev), entryId: first.entryId });
      const second = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
      const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: intended.authUserId, claimCode: second.claimCode });
      await repo.confirmEntry({ ...hostArgs(ev), entryId: second.entryId, confirmationCode: claimed.confirmationCode });
      await prepareContestants(ev, ["Dos"]);
      const ballot = await startBallot(ev);
      expect(ballot.candidates.find((c) => c.label === "Uno")!.participantId).toBe(await participantIdOf(intended.bindingId));
      expect(ballot.candidates.map((c) => c.participantId)).not.toContain(await participantIdOf(thief.bindingId));
    });
  });

  it("the host can remove an entry while preparing, which frees its contestant", async () => {
    const ev = await newEvent();
    const voter = await bindNew(ev);
    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
    await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: entry.claimCode });
    await repo.removeEntry({ ...hostArgs(ev), entryId: entry.entryId });
    expect(await repo.readPreparation(hostArgs(ev))).toHaveLength(0);
    const again = await repo.createEntry({ ...hostArgs(ev), label: "Uno" });
    await expect(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, claimCode: again.claimCode })).resolves.toBeDefined();
  });

  it("a voter's status shows only their OWN entry (label and state), never a secret", async () => {
    const ev = await newEvent();
    const mine = await bindNew(ev);
    const other = await bindNew(ev);
    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Vampiro" });
    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: mine.authUserId, claimCode: entry.claimCode });
    const read = (who: Voter) => repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: who.authUserId });
    expect((await read(mine))!.myEntry).toEqual({ label: "Vampiro", state: "PENDING_CONFIRMATION" });
    expect((await read(other))!.myEntry).toBeNull();
    await repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    expect((await read(mine))!.myEntry).toEqual({ label: "Vampiro", state: "CONFIRMED" });
    const text = JSON.stringify(await q("select * from read_community_voting_voter_status($1,$2)", [ev.instance.instanceId, mine.authUserId]));
    expect(text).not.toContain(entry.claimCode);
    expect(text).not.toContain(claimed.confirmationCode);
  });
});

// ============================================================ the explicit, atomic start

describe("Atomic Community Voting start (database)", () => {
  it("opens Voting in ONE transaction: attributed candidates, PROMPT_ACTIVE, one INTERACTION_STARTED — preserving the Session's own shape", async () => {
    const ev = await newEvent();
    const contestants = await prepareContestants(ev, ["Uno", "Dos", "Tres"]);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const before = await ballotCounts(ev);
    const sessionBefore = (await q<Record<string, unknown>>("select state, state_version, updated_at from sessions where session_id = $1", [ev.session.sessionId]))[0];
    expect(before).toMatchObject({ interactions: 0, segments: 0, candidates: 0, startedEvents: 0, linkedEntries: 0 });

    const started = await repo.startVoting({ ...hostArgs(ev), promptText: "  Mejor disfraz  " });
    expect(started).toMatchObject({ state: "PROMPT_ACTIVE", candidateCount: 3, segmentNumber: 1 });

    const after = await ballotCounts(ev);
    expect(after).toMatchObject({ interactions: 1, segments: 1, candidates: 3, startedEvents: 1, linkedEntries: 3, prompts: before.prompts + 1 });
    // The Session row is exactly what the ordinary start leaves it: opening is an interaction, not a Session-row change.
    expect((await q<Record<string, unknown>>("select state, state_version, updated_at from sessions where session_id = $1", [ev.session.sessionId]))[0]).toEqual(sessionBefore);

    const [interaction] = await q<{ state: string; engine_type: string; prompt_id: string }>("select state, engine_type, prompt_id from interaction_instances where session_id = $1", [ev.session.sessionId]);
    expect(interaction).toMatchObject({ state: "PROMPT_ACTIVE", engine_type: "VOTING" });
    expect((await q<{ text: string }>("select text from prompts where prompt_id = $1", [interaction.prompt_id]))[0].text).toBe("Mejor disfraz");

    const candidates = await q<{ ordinal: number; label: string; participant_id: string; candidate_id: string }>("select ordinal, label, participant_id, candidate_id from voting_candidates where interaction_instance_id = $1 order by ordinal", [started.interactionInstanceId]);
    expect(candidates.map((c) => [c.ordinal, c.label])).toEqual([[0, "Uno"], [1, "Dos"], [2, "Tres"]]);
    expect(candidates.map((c) => c.participant_id)).toEqual(await Promise.all(contestants.map((c) => participantIdOf(c.bindingId))));
    // each preparation entry now REFERENCES its authoritative candidate (a link, not a copy)
    const links = await q<{ label: string; candidate_id: string }>("select label, candidate_id from community_voting_entries where instance_id = $1 order by ordinal", [ev.instance.instanceId]);
    expect(links.map((l) => l.candidate_id)).toEqual(candidates.map((c) => c.candidate_id));

    const [event] = await q<{ payload: Record<string, unknown> }>("select payload from session_events where session_id = $1 and event_type = 'INTERACTION_STARTED'", [ev.session.sessionId]);
    expect(event.payload).toMatchObject({ interactionInstanceId: started.interactionInstanceId, engineType: "VOTING", segmentTarget: "NEW_SEGMENT", votingCandidateSourceType: "HOST_AUTHORED", votingSourceInteractionInstanceId: null });
  });

  it("refuses to start — leaving NOTHING behind — unless every precondition holds", async () => {
    const ev = await newEvent();
    const start = (promptText = "Q") => repo.startVoting({ ...hostArgs(ev), promptText });
    const untouched = async (label: string) => {
      const c = await ballotCounts(ev);
      expect(c, label).toMatchObject({ interactions: 0, segments: 0, candidates: 0, startedEvents: 0, linkedEntries: 0 });
    };
    const promptsBefore = (await ballotCounts(ev)).prompts;

    await expectCode(start(), "SESSION_NOT_STARTABLE"); // lobby still open
    await untouched("lobby open");
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // no entries
    await prepareContestants(ev, ["Uno"]);
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // one entry
    const unclaimed = await repo.createEntry({ ...hostArgs(ev), label: "Dos" });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // unclaimed
    const late = await bindNew(ev);
    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: late.authUserId, claimCode: unclaimed.claimCode });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // pending
    for (const bad of ["", "   "]) {
      expect((await rawError(pool, "select * from start_community_voting_atomically($1,$2,$3)", [ev.instance.instanceId, ev.session.hostToken, bad])).message).toMatch(/CV_INVALID_REQUEST/);
    }
    await untouched("incomplete preparation");
    expect((await ballotCounts(ev)).prompts).toBe(promptsBefore);

    // a Session no longer exactly VOTING, and Sessions in states that cannot start
    await q("update sessions set declared_capabilities = array['OPEN_RESPONSE','VOTING'] where session_id = $1", [ev.session.sessionId]);
    await expectCode(start(), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
    await q("update sessions set declared_capabilities = array['VOTING'] where session_id = $1", [ev.session.sessionId]);
    for (const state of ["SESSION_COMPLETE", "SESSION_PAUSED", "SESSION_INTRO", "PROMPT_ACTIVE", "SUBMISSIONS_CLOSED", "RESULT_REVEAL", "SOCIAL_PAUSE"]) {
      await q("update sessions set state = $2 where session_id = $1", [ev.session.sessionId, state]);
      await expectCode(start(), "SESSION_NOT_STARTABLE");
    }
    await q("update sessions set state = 'LOBBY_LOCKED' where session_id = $1", [ev.session.sessionId]);
    await untouched("unstartable states");
    expect((await ballotCounts(ev)).prompts).toBe(promptsBefore);

    // ... and with nothing left to fix, the very same ballot starts
    await repo.confirmEntry({ ...hostArgs(ev), entryId: unclaimed.entryId, confirmationCode: claimed.confirmationCode });
    await expect(start()).resolves.toMatchObject({ candidateCount: 2, state: "PROMPT_ACTIVE" });
  });

  describe("a failed start rolls back EVERY part of the opening", () => {
    const failingTriggers: Array<{ label: string; install: string; drop: string[] }> = [
      {
        label: "a failure while attributing the candidates (after the Session's own opening has been written)",
        install: "create or replace function cv_contract_fail_candidates() returns trigger language plpgsql as $$ begin raise exception 'CV_CONTRACT_INDUCED_FAILURE'; end; $$; create trigger zz_cv_contract_fail after update on voting_candidates for each row execute function cv_contract_fail_candidates();",
        drop: ["drop trigger if exists zz_cv_contract_fail on voting_candidates", "drop function if exists cv_contract_fail_candidates()"],
      },
      {
        label: "a failure while linking the entries to their candidates (the very last step)",
        install: "create or replace function cv_contract_fail_entries() returns trigger language plpgsql as $$ begin if new.candidate_id is not null then raise exception 'CV_CONTRACT_INDUCED_FAILURE'; end if; return new; end; $$; create trigger zz_cv_contract_fail before update on community_voting_entries for each row execute function cv_contract_fail_entries();",
        drop: ["drop trigger if exists zz_cv_contract_fail on community_voting_entries", "drop function if exists cv_contract_fail_entries()"],
      },
    ];
    it.each(failingTriggers)("$label", async ({ install, drop }) => {
      const ev = await newEvent();
      await prepareContestants(ev, ["Uno", "Dos", "Tres"]);
      await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      const before = await ballotCounts(ev);
      for (const stmt of install.split(/;\s*(?=create)/)) await q(stmt.endsWith(";") ? stmt : `${stmt};`);
      try {
        const raw = await rawError(pool, "select * from start_community_voting_atomically($1,$2,'Q')", [ev.instance.instanceId, ev.session.hostToken]);
        expect(raw.message).toMatch(/CV_CONTRACT_INDUCED_FAILURE/);
        const viaRepo = await repo.startVoting({ ...hostArgs(ev), promptText: "Q" }).then(() => null, (e: unknown) => e as Error);
        expect(viaRepo).not.toBeNull();
        expect(viaRepo).not.toBeInstanceOf(CommunityVotingError); // an unknown database failure is reduced to its SQLSTATE, never passed through
      } finally {
        for (const stmt of drop) await q(stmt);
      }
      // no interaction, no prompt, no segment, no candidate, no INTERACTION_STARTED event, no link — no partial opening
      expect(await ballotCounts(ev)).toEqual(before);
      expect(await q("select 1 from community_voting_entries where instance_id = $1 and candidate_id is not null", [ev.instance.instanceId])).toHaveLength(0);
      // ... and with the fault gone the very same start succeeds exactly once
      await expect(repo.startVoting({ ...hostArgs(ev), promptText: "Q" })).resolves.toMatchObject({ candidateCount: 3 });
      expect(await ballotCounts(ev)).toMatchObject({ interactions: 1, candidates: 3, startedEvents: 1, linkedEntries: 3 });
    });
  });

  it("concurrent starts create exactly ONE interaction and ONE ballot; the rest are refused", async () => {
    const ev = await newEvent();
    await prepareContestants(ev, ["Uno", "Dos", "Tres"]);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => repo.startVoting({ ...hostArgs(ev), promptText: "Q" }).then(() => "started", (e: CommunityVotingError) => e.code)));
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_OPENED")).toHaveLength(5);
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 1, segments: 1, candidates: 3, startedEvents: 1, linkedEntries: 3 });
  });

  it("a second start is refused and the first ballot is untouched", async () => {
    const { ev, voting } = await preparedEvent();
    const before = JSON.stringify(await q("select candidate_id, label, participant_id, ordinal from voting_candidates where interaction_instance_id = $1 order by ordinal", [voting.interactionInstanceId]));
    await expectCode(repo.startVoting({ ...hostArgs(ev), promptText: "Otra" }), "ALREADY_OPENED");
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 1, candidates: 3, startedEvents: 1 });
    expect(JSON.stringify(await q("select candidate_id, label, participant_id, ordinal from voting_candidates where interaction_instance_id = $1 order by ordinal", [voting.interactionInstanceId]))).toBe(before);
  });

  it("voting works immediately after the start, with no further step, and the status derives OPEN from the Session", async () => {
    const { ev, voting, voter } = await preparedEvent();
    const snapshot = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId });
    expect(snapshot).toMatchObject({ sessionState: "LOBBY_LOCKED", interactionState: "PROMPT_ACTIVE", engineType: "VOTING" });
    expect(Object.keys(snapshot!).sort()).toEqual(["appliedIntentNo", "bindingId", "engineType", "instanceId", "interactionInstanceId", "interactionState", "issuedIntentNo", "myCandidateId", "myEntry", "sessionState"]);
    const { intentNo } = await issue(ev, voter);
    await expect(cast(ev, voter, voting, voting.candidates[0].candidateId, intentNo)).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  it("an open ballot is never partly attributed — and an INVARIANT CORRUPTION fails closed instead of being normalized", async () => {
    const { ev, voting, voter } = await preparedEvent();
    const nulls = await q("select 1 from voting_candidates where interaction_instance_id = $1 and participant_id is null", [voting.interactionInstanceId]);
    expect(nulls).toHaveLength(0);
    await issue(ev, voter);
    // Corrupt the ballot the only way possible — switching the freeze off as the table owner, inside a transaction that is rolled back.
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query("alter table voting_candidates disable trigger user");
      await c.query("update voting_candidates set participant_id = null where candidate_id = $1", [voting.candidates[0].candidateId]);
      const err = await rawError(c, "select * from cast_community_voting_vote_atomically($1,$2,$3,1,$4,$5,$6,$7,$8)", [
        ev.instance.instanceId, voter.authUserId, voter.bindingId, voting.interactionInstanceId, voting.candidates[1].candidateId, INSIDE.latitude, INSIDE.longitude, INSIDE.accuracyMeters,
      ]);
      expect(err.message).toMatch(/CV_STATE_INCONSISTENT/);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
  });
});

// ============================================================ the general start path cannot bypass preparation

describe("Ordinary start cannot open an event-bound Session", () => {
  async function eventReadyToStart() {
    const ev = await newEvent();
    await prepareContestants(ev, ["Uno", "Dos"]);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    return ev;
  }

  it("rejects the ordinary start in every shape — HOST_AUTHORED, PARTICIPANTS, before and after preparation — and leaves no prompt, segment, interaction or candidate", async () => {
    const unprepared = await newEvent();
    await bindNew(unprepared);
    await bindNew(unprepared);
    await lockLobby(sessionRepo, unprepared.session.sessionId, unprepared.session.hostToken);
    const prepared = await eventReadyToStart();
    for (const [label, ev] of [["unprepared", unprepared], ["prepared", prepared]] as const) {
      const before = await ballotCounts(ev);
      for (const candidateSource of [
        { type: "HOST_AUTHORED" as const, candidates: ["Uno", "Dos"] },
        { type: "PARTICIPANTS" as const },
      ]) {
        const err = await startSession(sessionRepo, ev.session.sessionId, ev.session.hostToken, { engineType: "VOTING", promptText: "Q", candidateSource }).then(() => null, (e: unknown) => e as Error);
        expect(err, `${label}/${candidateSource.type}`).not.toBeNull();
        expect(String(err!.message), `${label}/${candidateSource.type}`).toMatch(/EVENT_BOUND/);
      }
      expect(await ballotCounts(ev), `${label}: the ordinary start's partial writes (prompt, segment) must have rolled back`).toEqual(before);
    }
  });

  it("rejects the raw RPC too — as the database owner and as the PUBLIC anon role — with the guard, not a privilege error", async () => {
    const ev = await eventReadyToStart();
    const before = await ballotCounts(ev);
    const asOwner = await rawError(pool, "select * from start_session_atomically($1,$2,'Q',null,'HOST_AUTHORED','[\"Uno\",\"Dos\"]'::jsonb,null,'NEW_SEGMENT')", [ev.session.sessionId, ev.session.hostToken]);
    expect(asOwner.message).toMatch(/EVENT_BOUND/);
    const asAnon = await anon.rpc("start_session_atomically", {
      p_session_id: ev.session.sessionId, p_host_token: ev.session.hostToken, p_prompt_text: "Q", p_voting_source_type: "HOST_AUTHORED", p_voting_candidates: ["Uno", "Dos"],
    });
    expect(asAnon.error?.message ?? "").toMatch(/EVENT_BOUND/);
    expect(await ballotCounts(ev)).toEqual(before);
  });

  it("rejects a direct insert of an interaction, and the 'marker' that authorizes the one sanctioned opening cannot be set through the REST surface", async () => {
    const ev = await eventReadyToStart();
    const before = await ballotCounts(ev);
    const [segment] = await q<{ segment_id: string }>("select segment_id from segments where session_id = $1 limit 1", [ev.session.sessionId]);
    expect(segment).toBeUndefined(); // nothing was ever created for this Session
    const prompt = await q<{ prompt_id: string }>("insert into prompts (text) values ('direct') returning prompt_id");
    const seg = await q<{ segment_id: string }>("insert into segments (session_id, segment_ordinal) values ($1, 1) returning segment_id", [ev.session.sessionId]);
    const direct = await rawError(pool, "insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type) values ($1,$2,$3,'PROMPT_ACTIVE','VOTING')", [ev.session.sessionId, seg[0].segment_id, prompt[0].prompt_id]);
    expect(direct.message).toMatch(/EVENT_BOUND/);
    await q("delete from segments where segment_id = $1", [seg[0].segment_id]);
    await q("delete from prompts where prompt_id = $1", [prompt[0].prompt_id]);
    // set_config lives in pg_catalog, which PostgREST does not expose: a REST caller cannot forge the marker
    const forged = await service.rpc("set_config", { setting_name: "urbano.community_voting_start", new_value: ev.session.sessionId, is_local: true });
    expect(forged.error).not.toBeNull();
    expect(await ballotCounts(ev)).toMatchObject({ interactions: before.interactions, candidates: before.candidates, startedEvents: before.startedEvents });
  });

  it("is INERT for ordinary Sessions: the same ordinary start, candidate writes and interactions behave exactly as before", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    await joinSession(sessionRepo, session.roomCode, "Alex");
    await joinSession(sessionRepo, session.roomCode, "Sam");
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    const started = await startSession(sessionRepo, session.sessionId, session.hostToken, { engineType: "VOTING", promptText: "Q", candidateSource: { type: "PARTICIPANTS" } });
    const candidates = await sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
    expect(candidates).toHaveLength(2);
    const c = await rawClient();
    try {
      await c.query("begin");
      // an ordinary Session's candidate rows remain writable at the table level, exactly as before this work
      await c.query("update voting_candidates set label = 'renamed' where candidate_id = $1", [candidates[0].candidateId]);
      await c.query("delete from voting_candidates where candidate_id = $1", [candidates[1].candidateId]).catch(() => {});
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect((await sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId))).toHaveLength(2);
  });

  it("the only SQL functions that write the ballot are the ordinary start (guarded for event-bound Sessions) and the Community Voting starts (single-choice and the pilot's round)", async () => {
    const inserters = (await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'insert\\s+into\\s+(public\\.)?voting_candidates\\y' order by 1")).map((r) => r.proname);
    expect(inserters).toEqual(["start_session_atomically"]);
    const updaters = (await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'update\\s+(public\\.)?voting_candidates\\y' order by 1")).map((r) => r.proname);
    expect(updaters).toEqual(["start_community_voting_atomically", "start_community_voting_round_atomically"]);
    const deleters = await q("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'delete\\s+from\\s+(public\\.)?voting_candidates\\y'");
    expect(deleters).toHaveLength(0);
    const interactionInserters = (await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'insert\\s+into\\s+(public\\.)?interaction_instances\\y' order by 1")).map((r) => r.proname);
    expect(interactionInserters).toContain("start_session_atomically");
    expect(interactionInserters).not.toContain("start_community_voting_atomically"); // it opens THROUGH the Session's own transition
    const [{ src }] = await q<{ src: string }>("select prosrc as src from pg_proc where proname = 'start_community_voting_atomically'");
    expect(src).toMatch(/start_session_atomically\s*\(/);
    expect(src.search(/for\s+update/i)).toBeLessThan(src.search(/start_session_atomically\s*\(/));
    expect(await q("select 1 from pg_proc where proname = 'attribute_community_voting_contestant_atomically'")).toHaveLength(0);
  });
});

// ============================================================ the ballot is frozen the moment it opens

describe("Freeze after opening (database)", () => {
  it("rejects every candidate and attribution mutation once PROMPT_ACTIVE exists — even for the database owner", async () => {
    const { ev, voting, contestants } = await preparedEvent();
    const [first] = voting.candidates;
    const before = JSON.stringify(await q("select candidate_id, label, participant_id, ordinal from voting_candidates where interaction_instance_id = $1 order by ordinal", [voting.interactionInstanceId]));
    const stranger = await participantIdOf((await bindNew(ev)).bindingId);
    const mutations: Array<[string, string, unknown[]]> = [
      ["clear an attribution", "update voting_candidates set participant_id = null where candidate_id = $1", [first.candidateId]],
      ["re-attribute a candidate", "update voting_candidates set participant_id = $2 where candidate_id = $1", [first.candidateId, stranger]],
      ["swap a label", "update voting_candidates set label = 'Otro' where candidate_id = $1", [first.candidateId]],
      ["renumber a candidate", "update voting_candidates set ordinal = 99 where candidate_id = $1", [first.candidateId]],
      ["delete a candidate", "delete from voting_candidates where candidate_id = $1", [first.candidateId]],
      ["add a candidate", "insert into voting_candidates (interaction_instance_id, ordinal, label, participant_id) values ($1, 50, 'Tarde', $2)", [voting.interactionInstanceId, stranger]],
    ];
    for (const [label, sql, params] of mutations) {
      const err = await rawError(pool, sql, params);
      expect(err.message, label).toMatch(/COMMUNITY_VOTING_BALLOT_FROZEN|violates|constraint/);
    }
    // the same through the REST surface as the server's own role
    const viaRest = await service.from("voting_candidates").update({ participant_id: stranger }).eq("candidate_id", first.candidateId);
    expect(viaRest.error?.message ?? "").toMatch(/COMMUNITY_VOTING_BALLOT_FROZEN/);
    const viaRestDelete = await service.from("voting_candidates").delete().eq("candidate_id", first.candidateId);
    expect(viaRestDelete.error?.message ?? "").toMatch(/COMMUNITY_VOTING_BALLOT_FROZEN/);
    expect(JSON.stringify(await q("select candidate_id, label, participant_id, ordinal from voting_candidates where interaction_instance_id = $1 order by ordinal", [voting.interactionInstanceId]))).toBe(before);
    expect(contestants).toHaveLength(3);
  });

  it("freezes the preparation entries too, at the table, and every preparation function fails closed", async () => {
    const { ev, voting } = await preparedEvent();
    const [entry] = await repo.readPreparation(hostArgs(ev));
    const stranger = await bindNew(ev);
    const tableWrites: Array<[string, string, unknown[]]> = [
      ["update an entry", "update community_voting_entries set confirmed_at = now() where entry_id = $1", [entry.entryId]],
      ["delete an entry", "delete from community_voting_entries where entry_id = $1", [entry.entryId]],
      ["insert an entry", "insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at) values ($1, 99, 'Tarde', 60, now() + interval '1 hour')", [ev.instance.instanceId]],
    ];
    for (const [label, sql, params] of tableWrites) expect((await rawError(pool, sql, params)).message, label).toMatch(/COMMUNITY_VOTING_PREPARATION_FROZEN/);
    const viaRest = await service.from("community_voting_entries").delete().eq("entry_id", entry.entryId);
    expect(viaRest.error?.message ?? "").toMatch(/COMMUNITY_VOTING_PREPARATION_FROZEN/);

    await expectCode(repo.createEntry({ ...hostArgs(ev), label: "Tarde" }), "PREPARATION_CLOSED");
    await expectCode(repo.removeEntry({ ...hostArgs(ev), entryId: entry.entryId }), "PREPARATION_CLOSED");
    await expectCode(repo.confirmEntry({ ...hostArgs(ev), entryId: entry.entryId, confirmationCode: "ABCDEF12" }), "PREPARATION_CLOSED");
    await expectCode(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: stranger.authUserId, claimCode: "a".repeat(32) }), "PREPARATION_CLOSED");
    expect((await repo.readPreparation(hostArgs(ev))).every((e) => e.state === "CONFIRMED")).toBe(true);

    // closing and revealing do not thaw it
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await revealResults(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await expectCode(repo.createEntry({ ...hostArgs(ev), label: "Tarde" }), "PREPARATION_CLOSED");
    expect((await rawError(pool, "update voting_candidates set participant_id = null where interaction_instance_id = $1", [voting.interactionInstanceId])).message).toMatch(/COMMUNITY_VOTING_BALLOT_FROZEN/);
  });

  it("the existing Voting self-vote enforcement uses the FINAL participant_id", async () => {
    const { ev, voting, contestants } = await preparedEvent();
    const owner = contestants[0];
    await issue(ev, owner);
    await expect(cast(ev, owner, voting, voting.candidates[0].candidateId, 1)).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
    expect(await bindingRow(owner.bindingId)).toMatchObject({ issued_intent_no: 1, applied_intent_no: 0, applied_payload_digest: null });
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
    expect(await voteEvents(ev.session.sessionId)).toBe(0);
    await expect(cast(ev, owner, voting, voting.candidates[1].candidateId, 1)).resolves.toMatchObject({ outcome: "APPLIED" });
  });
});

// ============================================================ races: preparation, association, start, vote, close

describe("Races around the start (real blocking, Session-first)", () => {
  async function eventWith(labels: string[]) {
    const ev = await newEvent();
    await prepareContestants(ev, labels);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    return ev;
  }

  it("preparation first, start second: the start waits, then SEES the new unconfirmed entry and refuses", async () => {
    const ev = await eventWith(["Uno", "Dos"]);
    const tx = await holdTx();
    try {
      await tx.client.query("select * from create_community_voting_entry_atomically($1,$2,'Tres',900)", [ev.instance.instanceId, ev.session.hostToken]);
      const start = track(repo.startVoting({ ...hostArgs(ev), promptText: "Q" }));
      await sleep(600);
      expect(start.state.settled, "the start must wait behind the preparation's Session lock").toBe(false);
      await tx.commit();
      await expectCode(start.promise, "PREPARATION_INCOMPLETE");
    } finally {
      await tx.rollback();
    }
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 0, candidates: 0, startedEvents: 0 });
  });

  it("start first, preparation second: the entry is refused and the opened ballot is unchanged", async () => {
    const ev = await eventWith(["Uno", "Dos"]);
    const tx = await holdTx();
    try {
      await tx.client.query("select * from start_community_voting_atomically($1,$2,'Q')", [ev.instance.instanceId, ev.session.hostToken]);
      const create = track(repo.createEntry({ ...hostArgs(ev), label: "Tres" }));
      await sleep(600);
      expect(create.state.settled, "the preparation must wait behind the start's Session lock").toBe(false);
      await tx.commit();
      await expectCode(create.promise, "PREPARATION_CLOSED");
    } finally {
      await tx.rollback();
    }
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 1, candidates: 2, startedEvents: 1, linkedEntries: 2 });
    expect(await repo.readPreparation(hostArgs(ev))).toHaveLength(2);
  });

  it("association first, start second: the last confirmation is INCLUDED in the ballot", async () => {
    const ev = await newEvent();
    await prepareContestants(ev, ["Uno"]);
    const late = await bindNew(ev);
    const entry = await repo.createEntry({ ...hostArgs(ev), label: "Dos" });
    const claimed = await repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: late.authUserId, claimCode: entry.claimCode });
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const tx = await holdTx();
    try {
      const confirmed = await tx.client.query("select * from confirm_community_voting_entry_atomically($1,$2,$3,$4)", [ev.instance.instanceId, ev.session.hostToken, entry.entryId, claimed.confirmationCode]);
      expect(confirmed.rows[0].outcome).toBe("CONFIRMED");
      const start = track(repo.startVoting({ ...hostArgs(ev), promptText: "Q" }));
      await sleep(600);
      expect(start.state.settled).toBe(false);
      await tx.commit();
      await expect(start.promise).resolves.toMatchObject({ candidateCount: 2 });
    } finally {
      await tx.rollback();
    }
    const owners = (await q<{ participant_id: string }>("select vc.participant_id from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1 order by vc.ordinal", [ev.session.sessionId])).map((r) => r.participant_id);
    expect(owners[1]).toBe(await participantIdOf(late.bindingId));
  });

  it("start first, association second: the claim is refused as closed and the ballot is unchanged", async () => {
    const ev = await eventWith(["Uno", "Dos"]);
    const bystander = await bindNew(ev);
    const tx = await holdTx();
    try {
      await tx.client.query("select * from start_community_voting_atomically($1,$2,'Q')", [ev.instance.instanceId, ev.session.hostToken]);
      const claim = track(repo.claimEntry({ instanceId: ev.instance.instanceId, authUserId: bystander.authUserId, claimCode: "a".repeat(32) }));
      await sleep(600);
      expect(claim.state.settled).toBe(false);
      await tx.commit();
      await expectCode(claim.promise, "PREPARATION_CLOSED");
    } finally {
      await tx.rollback();
    }
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 1, candidates: 2 });
  });

  it("removal first, start second: the ballot is built from the entries that remain", async () => {
    const ev = await eventWith(["Uno", "Dos", "Tres"]);
    const [, , third] = await repo.readPreparation(hostArgs(ev));
    const tx = await holdTx();
    try {
      await tx.client.query("select * from remove_community_voting_entry_atomically($1,$2,$3)", [ev.instance.instanceId, ev.session.hostToken, third.entryId]);
      const start = track(repo.startVoting({ ...hostArgs(ev), promptText: "Q" }));
      await sleep(600);
      expect(start.state.settled).toBe(false);
      await tx.commit();
      await expect(start.promise).resolves.toMatchObject({ candidateCount: 2 });
    } finally {
      await tx.rollback();
    }
    expect((await q<{ label: string }>("select vc.label from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1 order by vc.ordinal", [ev.session.sessionId])).map((r) => r.label)).toEqual(["Uno", "Dos"]);
  });

  it("a vote racing the start waits for it and then succeeds; before the start there is nothing to vote on", async () => {
    const ev = await eventWith(["Uno", "Dos"]);
    const voter = await bindNew(ev);
    await expectCode(issue(ev, voter), "VOTING_NOT_OPEN"); // not open: preparation does not open it
    const tx = await holdTx();
    let intentNo = 0;
    try {
      await tx.client.query("select * from start_community_voting_atomically($1,$2,'Q')", [ev.instance.instanceId, ev.session.hostToken]);
      const racing = track(issue(ev, voter));
      await sleep(600);
      expect(racing.state.settled, "the intent request must wait behind the start's Session lock").toBe(false);
      await tx.commit();
      intentNo = (await racing.promise).intentNo;
    } finally {
      await tx.rollback();
    }
    expect(intentNo).toBe(1);
    const candidates = await sessionRepo.getVotingCandidatesForInteraction((await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId }))!.interactionInstanceId!);
    await expect(cast(ev, voter, { interactionInstanceId: candidates[0].interactionInstanceId }, candidates[0].candidateId, 1)).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  it("start, vote and close all racing: one ballot, every vote accounted for, nothing attributed halfway (randomized, 3 rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const ev = await eventWith(["Uno", "Dos", "Tres"]);
      const voters = await Promise.all(Array.from({ length: 8 }, () => bindNew(ev)));
      let interactionId: string | null = null;
      const attempts = voters.map((v, i) => async () => {
        try {
          const status = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: v.authUserId });
          const { intentNo } = await issue(ev, v);
          const live = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: v.authUserId });
          const candidates = await sessionRepo.getVotingCandidatesForInteraction(live!.interactionInstanceId!);
          const r = await cast(ev, v, { interactionInstanceId: live!.interactionInstanceId! }, candidates[i % 3].candidateId, intentNo);
          void status;
          return r.outcome === "APPLIED" ? "counted" : r.outcome;
        } catch (e) {
          return e instanceof CommunityVotingError ? e.code : `UNEXPECTED:${(e as Error).message}`;
        }
      });
      const racers: Array<() => Promise<unknown>> = [
        async () => { await sleep(Math.random() * 40); try { const r = await repo.startVoting({ ...hostArgs(ev), promptText: "Q" }); interactionId = r.interactionInstanceId; return "started"; } catch (e) { return (e as CommunityVotingError).code; } },
        async () => { await sleep(Math.random() * 80); try { await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken); return "closed"; } catch { return "close-refused"; } },
        ...attempts.map((a) => async () => { await sleep(Math.random() * 80); return a(); }),
      ];
      const results = await Promise.all(racers.map((r) => r()));
      const voterResults = results.slice(2) as string[];
      expect(voterResults.filter((r) => String(r).startsWith("UNEXPECTED")), JSON.stringify(results)).toEqual([]);
      for (const r of voterResults) expect(["counted", "VOTING_NOT_OPEN"]).toContain(r);
      const counts = await ballotCounts(ev);
      expect(counts.interactions).toBeLessThanOrEqual(1);
      if (counts.interactions === 1) {
        expect(await q("select 1 from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1 and vc.participant_id is null", [ev.session.sessionId])).toHaveLength(0);
        expect(counts.candidates).toBe(3);
        expect(counts.startedEvents).toBe(1);
      }
      expect((await votesFor(interactionId ?? "00000000-0000-0000-0000-000000000000")).length).toBe(voterResults.filter((r) => r === "counted").length);
    }
  });
});

// ============================================================ intent recovery truth table (database)

describe("Intent recovery truth table (database)", () => {
  it("answers every presented intent with exactly one of: not issued / replayed / payload conflict / stale / a new attempt — and never invents history", async () => {
    const { ev, voting, voter } = await preparedEvent();
    const [A, B, C] = voting.candidates.map((c) => c.candidateId);
    for (let i = 0; i < 6; i++) await issue(ev, voter);

    await expectCode(cast(ev, voter, voting, A, 7), "INTENT_UNISSUED");
    expect(await cast(ev, voter, voting, A, 2)).toMatchObject({ outcome: "APPLIED", intentNo: 2, candidateId: A });
    expect(await cast(ev, voter, voting, A, 2)).toMatchObject({ outcome: "REPLAYED", intentNo: 2, candidateId: A });
    const clash = await expectCode(cast(ev, voter, voting, B, 2), "INTENT_PAYLOAD_MISMATCH");
    expect(clash.intentOutcome).toBe("APPLIED_WITH_DIFFERENT_PAYLOAD");
    expect(clash.current).toMatchObject({ myCandidateId: A, appliedIntentNo: 2 });

    expect(await cast(ev, voter, voting, C, 5)).toMatchObject({ outcome: "APPLIED", intentNo: 5, candidateId: C });
    const oldApplied = await expectCode(cast(ev, voter, voting, A, 2), "STALE_INTENT");
    const oldUnapplied = await expectCode(cast(ev, voter, voting, A, 1), "STALE_INTENT");
    const oldUnappliedNamingCurrent = await expectCode(cast(ev, voter, voting, C, 3), "STALE_INTENT");
    for (const e of [oldApplied, oldUnapplied, oldUnappliedNamingCurrent]) {
      expect(e.intentOutcome).toBe("HISTORICAL_OUTCOME_UNAVAILABLE");
      expect(e.current).toMatchObject({ myCandidateId: C, appliedIntentNo: 5, issuedIntentNo: 6 });
    }
    // the applied-then-superseded intent and the never-applied one are indistinguishable BY DESIGN
    expect(JSON.stringify([oldApplied.code, oldApplied.intentOutcome, oldApplied.current])).toBe(JSON.stringify([oldUnapplied.code, oldUnapplied.intentOutcome, oldUnapplied.current]));
    expect((await votesFor(voting.interactionInstanceId))[0].candidate_id).toBe(C);
    expect(await voteEvents(ev.session.sessionId)).toBe(2);
  });

  it("replay after close confirms only a genuinely committed, matching intent", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter); await issue(ev, voter);
    const committed = await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    expect(await cast(ev, voter, voting, voting.candidates[0].candidateId, 1)).toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: committed.voteUpdatedAt });
    await expectCode(cast(ev, voter, voting, voting.candidates[1].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
    await expectCode(cast(ev, voter, voting, voting.candidates[0].candidateId, 2), "VOTING_NOT_OPEN"); // issued, never applied: not confirmed
    expect(await bindingRow(voter.bindingId)).toMatchObject({ issued_intent_no: 2, applied_intent_no: 1 });
  });

  it("a lost response is retried as a REPLAY of the committed intent; a failed attempt is retried as a NEW attempt", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await expectCode(cast(ev, voter, voting, voting.candidates[0].candidateId, 1, OUTSIDE), "LOCATION_OUTSIDE");
    const first = await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    expect(first.outcome).toBe("APPLIED");
    expect(await cast(ev, voter, voting, voting.candidates[0].candidateId, 1)).toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: first.voteUpdatedAt });
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });
});


describe("Intent ordering and payload-bound idempotency (database)", () => {
  it("applies through the UNCHANGED cast_vote_atomically and records only counters, a payload commitment and derived evidence", async () => {
    const { ev, voting, voter } = await preparedEvent();
    expect((await issue(ev, voter)).intentNo).toBe(1);
    const result = await cast(ev, voter, voting, voting.candidates[1].candidateId, 1);
    expect(result).toMatchObject({ outcome: "APPLIED", bindingId: voter.bindingId, intentNo: 1, candidateId: voting.candidates[1].candidateId });
    const votes = await votesFor(voting.interactionInstanceId);
    expect(votes).toHaveLength(1);
    expect(votes[0].candidate_id).toBe(voting.candidates[1].candidateId);
    expect(new Date(result.voteUpdatedAt).getTime()).toBe(votes[0].updated_at.getTime());
    expect(await voteEvents(ev.session.sessionId)).toBe(1);

    const row = await bindingRow(voter.bindingId);
    expect(row.applied_intent_no).toBe(1);
    expect(row.applied_payload_digest).toBe(payloadDigest(ev.instance.instanceId, voting.interactionInstanceId, voting.candidates[1].candidateId));
    expect(Number(row.applied_distance_meters)).toBeGreaterThan(5);
    expect(Number(row.applied_distance_meters)).toBeLessThan(15);
    expect(Number(row.applied_accuracy_meters)).toBe(5);
    expect(row.applied_at).toBeInstanceOf(Date);
    // The binding holds NO candidate id and NO coordinate.
    const text = JSON.stringify(row);
    expect(text).not.toContain(voting.candidates[1].candidateId);
    expect(text).not.toContain(String(INSIDE.latitude).slice(0, 9));
    expect(text).not.toContain(String(INSIDE.longitude).slice(0, 8));
  });

  it("rejects unissued, malformed and cross-binding intents without writing anything", async () => {
    const { ev, voting, voter, contestants } = await preparedEvent();
    await issue(ev, voter);
    await issue(ev, contestants[0]);
    await expectCode(cast(ev, voter, voting, voting.candidates[0].candidateId, 2), "INTENT_UNISSUED");
    for (const bad of [0, -3]) {
      const err = await rawError(pool, "select * from cast_community_voting_vote_atomically($1,$2,$3,$4,$5,$6,14.1,-87.2,5)", [ev.instance.instanceId, voter.authUserId, voter.bindingId, bad, voting.interactionInstanceId, voting.candidates[0].candidateId]);
      expect(err.message).toMatch(/CV_INTENT_UNISSUED/);
    }
    await expectCode(
      repo.castVote({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId, bindingId: contestants[0].bindingId, intentNo: 1, interactionInstanceId: voting.interactionInstanceId, candidateId: voting.candidates[1].candidateId, location: INSIDE }),
      "INTENT_BINDING_MISMATCH"
    );
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
    expect(await voteEvents(ev.session.sessionId)).toBe(0);
  });

  it("an unbound caller cannot cast", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await expectCode(
      repo.castVote({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser(), bindingId: voter.bindingId, intentNo: 1, interactionInstanceId: voting.interactionInstanceId, candidateId: voting.candidates[0].candidateId, location: INSIDE }),
      "NOT_BOUND"
    );
  });

  it("replays the same committed intent with no new Voting transition, even from a different location and after close", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const first = await cast(ev, voter, voting, voting.candidates[2].candidateId, 1);
    const replay = await cast(ev, voter, voting, voting.candidates[2].candidateId, 1, OUTSIDE);
    expect(replay).toMatchObject({ outcome: "REPLAYED", intentNo: 1, candidateId: first.candidateId, voteUpdatedAt: first.voteUpdatedAt });
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await expect(cast(ev, voter, voting, voting.candidates[2].candidateId, 1, OUTSIDE)).resolves.toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: first.voteUpdatedAt });
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("an applied intent reused with another payload (candidate or interaction) is a conflict carrying only the caller's own state", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    const e1 = await expectCode(cast(ev, voter, voting, voting.candidates[1].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
    expect(e1.current).toMatchObject({ myCandidateId: voting.candidates[0].candidateId, appliedIntentNo: 1, issuedIntentNo: 1 });
    const e2 = await expectCode(cast(ev, voter, { interactionInstanceId: randomUUID() }, voting.candidates[0].candidateId, 1), "INTENT_PAYLOAD_MISMATCH");
    expect(e2.current?.appliedIntentNo).toBe(1);
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("a revision with a newer intent replaces the single authoritative vote; an older intent can never overwrite it", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter); await issue(ev, voter); await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    const revised = await cast(ev, voter, voting, voting.candidates[1].candidateId, 3);
    expect(revised).toMatchObject({ outcome: "APPLIED", intentNo: 3 });
    const stale = await expectCode(cast(ev, voter, voting, voting.candidates[2].candidateId, 2), "STALE_INTENT");
    expect(stale.current).toMatchObject({ myCandidateId: voting.candidates[1].candidateId, appliedIntentNo: 3 });
    const votes = await votesFor(voting.interactionInstanceId);
    expect(votes).toHaveLength(1);
    expect(votes[0].candidate_id).toBe(voting.candidates[1].candidateId);
    expect(await voteEvents(ev.session.sessionId)).toBe(2);
  });

  it("a failed attempt (outside / ambiguous / excessive accuracy / invalid) is not consumed and can be retried", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const target = voting.candidates[0].candidateId;
    await expectCode(cast(ev, voter, voting, target, 1, OUTSIDE), "LOCATION_OUTSIDE");
    await expectCode(cast(ev, voter, voting, target, 1, AMBIGUOUS), "LOCATION_AMBIGUOUS");
    await expectCode(cast(ev, voter, voting, target, 1, northOfVenue(1, 51)), "LOCATION_ACCURACY_EXCESSIVE");
    expect(await bindingRow(voter.bindingId)).toMatchObject({ issued_intent_no: 1, applied_intent_no: 0, applied_payload_digest: null });
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
    await expect(cast(ev, voter, voting, target, 1, INSIDE)).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  describe("no-op reselection", () => {
    it("consumes the intent, supersedes older intents, and performs NO Voting transition", async () => {
      const { ev, voting, voter } = await preparedEvent();
      await issue(ev, voter); await issue(ev, voter); await issue(ev, voter);
      const first = await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
      const noop = await cast(ev, voter, voting, voting.candidates[0].candidateId, 3);
      expect(noop).toMatchObject({ outcome: "UNCHANGED", intentNo: 3, voteUpdatedAt: first.voteUpdatedAt });
      expect(await voteEvents(ev.session.sessionId)).toBe(1);
      const votes = await votesFor(voting.interactionInstanceId);
      expect(votes).toHaveLength(1);
      expect(votes[0].updated_at.getTime()).toBe(new Date(first.voteUpdatedAt).getTime());
      await expectCode(cast(ev, voter, voting, voting.candidates[2].candidateId, 2), "STALE_INTENT");
      expect(await bindingRow(voter.bindingId)).toMatchObject({ applied_intent_no: 3 });
      await expect(cast(ev, voter, voting, voting.candidates[0].candidateId, 3)).resolves.toMatchObject({ outcome: "REPLAYED" });
    });

    it("still requires an acceptable location", async () => {
      const { ev, voting, voter } = await preparedEvent();
      await issue(ev, voter); await issue(ev, voter);
      await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
      await expectCode(cast(ev, voter, voting, voting.candidates[0].candidateId, 2, OUTSIDE), "LOCATION_OUTSIDE");
      expect(await bindingRow(voter.bindingId)).toMatchObject({ applied_intent_no: 1 });
    });
  });

  it("concurrent identical intents: exactly one applies, the rest are coherent replays", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => cast(ev, voter, voting, voting.candidates[0].candidateId, 1).then((r) => r.outcome, (e: CommunityVotingError) => e.code)));
    expect(outcomes.filter((o) => o === "APPLIED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "REPLAYED")).toHaveLength(5);
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("concurrent casts of one intent with different payloads: one applies, the other is a payload conflict", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const outcomes = await Promise.all([
      cast(ev, voter, voting, voting.candidates[0].candidateId, 1).then((r) => r.outcome, (e: CommunityVotingError) => e.code),
      cast(ev, voter, voting, voting.candidates[1].candidateId, 1).then((r) => r.outcome, (e: CommunityVotingError) => e.code),
    ]);
    expect(outcomes.sort()).toEqual(["APPLIED", "INTENT_PAYLOAD_MISMATCH"]);
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("concurrent casts of different intents: the committed vote always matches the highest applied intent, whatever the arrival order", async () => {
    for (let round = 0; round < 3; round++) {
      const { ev, voting, voter } = await preparedEvent();
      for (let i = 0; i < 3; i++) await issue(ev, voter);
      const order = [1, 2, 3].sort(() => Math.random() - 0.5);
      const settled = await Promise.allSettled(order.map((n) => cast(ev, voter, voting, voting.candidates[n - 1].candidateId, n)));
      const row = await bindingRow(voter.bindingId);
      const applied = Number(row.applied_intent_no);
      const votes = await votesFor(voting.interactionInstanceId);
      expect(votes).toHaveLength(1);
      expect(votes[0].candidate_id).toBe(voting.candidates[applied - 1].candidateId);
      const fulfilled = settled.filter((s) => s.status === "fulfilled") as Array<PromiseFulfilledResult<{ intentNo: number; outcome: string }>>;
      expect(fulfilled.every((f) => f.value.intentNo <= applied)).toBe(true);
      for (const s of settled) if (s.status === "rejected") expect(((s.reason as CommunityVotingError).code)).toBe("STALE_INTENT");
      expect(await voteEvents(ev.session.sessionId)).toBe(fulfilled.filter((f) => f.value.outcome === "APPLIED").length);
    }
  });

  it("two different voters casting concurrently do not interfere", async () => {
    const { ev, voting, voter, contestants } = await preparedEvent();
    await issue(ev, voter); await issue(ev, contestants[0]);
    await Promise.all([
      cast(ev, voter, voting, voting.candidates[1].candidateId, 1),
      cast(ev, contestants[0], voting, voting.candidates[2].candidateId, 1),
    ]);
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(2);
  });

  it("rejects a stated interaction that is not current, and a candidate that does not belong to it", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await expectCode(cast(ev, voter, { interactionInstanceId: randomUUID() }, voting.candidates[0].candidateId, 1), "INTERACTION_MISMATCH");
    const err = await cast(ev, voter, voting, randomUUID(), 1).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/candidate/i);
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
  });

  it("delegates with the Participant token read INSIDE the database: the token is never returned and never appears in any event or result", async () => {
    const { ev, voting, voter } = await preparedEvent();
    const token = await participantTokenOf(voter.bindingId);
    await issue(ev, voter);
    const raw = await q("select * from cast_community_voting_vote_atomically($1,$2,$3,1,$4,$5,$6,$7,$8)", [
      ev.instance.instanceId, voter.authUserId, voter.bindingId, voting.interactionInstanceId, voting.candidates[0].candidateId, INSIDE.latitude, INSIDE.longitude, INSIDE.accuracyMeters,
    ]);
    expect(Object.keys(raw[0]).sort()).toEqual(["binding_id", "candidate_id", "intent_no", "interaction_instance_id", "outcome", "vote_updated_at"]);
    expect(JSON.stringify(raw)).not.toContain(token);
    const events = JSON.stringify(await q("select payload from session_events where session_id = $1", [ev.session.sessionId]));
    expect(events).not.toContain(token);
    expect(events).not.toContain(voter.authUserId);
    expect(events).not.toContain(String(INSIDE.latitude).slice(0, 9));
    // the existing Voting path still rejects a wrong token (behaviour of the unchanged function)
    await expect(castVote(sessionRepo, ev.session.sessionId, "wrong-token", voting.candidates[0].candidateId)).rejects.toThrow();
  });
});

// ============================================================ geolocation (database)

describe("Geolocation in the database", () => {
  const assess = async (lat: unknown, lon: unknown, acc: unknown) =>
    q<{ decision: string; distance_meters: number }>(
      "select * from community_voting_assess_location(14.1,-87.2,100,50,1,1,$1,$2,$3)",
      [lat, lon, acc]
    );

  it("rejects missing, malformed, non-finite and (0,0) readings", async () => {
    for (const [lat, lon, acc] of [
      [null, -87.2, 5], [14.1, null, 5], [14.1, -87.2, null],
      ["NaN", -87.2, 5], [14.1, "Infinity", 5], [91, -87.2, 5], [-91, -87.2, 5], [14.1, 181, 5], [14.1, -181, 5],
      [14.1, -87.2, 0], [14.1, -87.2, -1], [14.1, -87.2, "NaN"], [14.1, -87.2, "Infinity"], [0, 0, 5],
    ]) {
      const err = await rawError(pool, "select * from community_voting_assess_location(14.1,-87.2,100,50,1,1,$1::float8,$2::float8,$3::float8)", [lat, lon, acc]);
      expect(err.message, `${lat},${lon},${acc}`).toMatch(/CV_INVALID_LOCATION_READING/);
      // the error never repeats the submitted values
      expect(err.message).not.toMatch(/87\.2|14\.1/);
    }
    await expect(assess(0, 10, 5)).resolves.toHaveLength(1);
    await expect(assess(10, 0, 5)).resolves.toHaveLength(1);
  });

  it("agrees with the TypeScript assessment on inside/outside/ambiguous/excessive vectors and on distance", async () => {
    const vectors: LocationClaim[] = [
      northOfVenue(0, 1, 0), northOfVenue(10, 5), northOfVenue(50, 10), northOfVenue(79, 20, 0), northOfVenue(101, 5, 0), northOfVenue(125, 20, 0),
      northOfVenue(150, 40), northOfVenue(300, 5), northOfVenue(300, 49), northOfVenue(1, 51), northOfVenue(60, 20, 0), northOfVenue(500, 50), northOfVenue(100, 1, 0), northOfVenue(95, 4, 0),
    ];
    for (const v of vectors) {
      const ts = assessLocationEligibility(v, VENUE);
      const [sql] = await assess(v.latitude, v.longitude, v.accuracyMeters);
      expect(sql.decision, JSON.stringify({ d: Math.round(ts.distanceMeters), a: v.accuracyMeters })).toBe(ts.decision);
      expect(Math.abs(sql.distance_meters - ts.distanceMeters)).toBeLessThan(0.01);
    }
  });

  it("a rejected reading through the cast path leaves no trace of the coordinates anywhere in the database", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const secret = { latitude: 14.123987, longitude: -87.456123, accuracyMeters: 7 };
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1, secret).catch(() => {});
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1, { ...INSIDE, latitude: 14.100321, longitude: -87.199987 });
    const dump = JSON.stringify({
      events: await q("select * from session_events where session_id = $1", [ev.session.sessionId]),
      binding: await bindingRow(voter.bindingId),
      votes: await votesFor(voting.interactionInstanceId),
      instances: await q("select * from community_voting_instances where session_id = $1", [ev.session.sessionId]),
    });
    for (const needle of ["14.123987", "87.456123", "14.100321", "87.199987", "14.12398", "87.45612"]) expect(dump).not.toContain(needle);
  });
});

// ============================================================ close, recovery, rollback

describe("Close, publication, recovery and rollback (database)", () => {
  it("never permits a vote or revision after close, but recovers the committed confirmation", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    const committed = await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    await issue(ev, voter);
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await expectCode(cast(ev, voter, voting, voting.candidates[1].candidateId, 2), "VOTING_NOT_OPEN");
    await expectCode(issue(ev, voter), "VOTING_NOT_OPEN");
    await expect(cast(ev, voter, voting, voting.candidates[0].candidateId, 1)).resolves.toMatchObject({ outcome: "REPLAYED", voteUpdatedAt: committed.voteUpdatedAt });
    const status = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId });
    expect(status).toMatchObject({ bindingId: voter.bindingId, interactionState: "SUBMISSIONS_CLOSED", myCandidateId: voting.candidates[0].candidateId, issuedIntentNo: 2, appliedIntentNo: 1, myEntry: null });
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("status is bounded to the caller, recoverable for the same Auth user, and null for an unbound caller", async () => {
    const { ev, voting, voter, contestants } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[1].candidateId, 1);
    const raw = await q("select * from read_community_voting_voter_status($1,$2)", [ev.instance.instanceId, voter.authUserId]);
    expect(Object.keys(raw[0]).sort()).toEqual(
      ["applied_intent_no", "binding_id", "engine_type", "instance_id", "interaction_instance_id", "interaction_state", "issued_intent_no", "my_candidate_id", "my_entry_label", "my_entry_state", "session_state"].sort()
    );
    const mine = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId });
    expect(mine!.myCandidateId).toBe(voting.candidates[1].candidateId);
    const other = await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: contestants[0].authUserId });
    expect(other!.myCandidateId).toBeNull();
    expect(await repo.readVoterStatus({ instanceId: ev.instance.instanceId, authUserId: await newAuthUser() })).toBeNull();
    expect(await repo.readVoterStatus({ instanceId: randomUUID(), authUserId: voter.authUserId })).toBeNull();
  });

  it("cast versus close, both orders: close wins -> the cast is refused; the cast wins -> the vote is counted and the close then completes", async () => {
    // ---- close commits first
    const a = await preparedEvent();
    await issue(a.ev, a.voter);
    const closer = await rawClient();
    try {
      await closer.query("begin");
      await closer.query("select * from close_submissions_atomically($1,$2,'SUBMISSIONS_CLOSED','{}'::jsonb)", [a.ev.session.sessionId, a.ev.session.hostToken]);
      let done = false;
      const castP = cast(a.ev, a.voter, a.voting, a.voting.candidates[0].candidateId, 1).finally(() => { done = true; });
      castP.catch(() => {});
      await sleep(600);
      expect(done, "the cast must wait for the close's Session lock").toBe(false);
      await closer.query("commit");
      await expectCode(castP, "VOTING_NOT_OPEN");
    } finally {
      await closer.query("rollback").catch(() => {});
      await closer.end();
    }
    expect(await votesFor(a.voting.interactionInstanceId)).toHaveLength(0);
    expect(await bindingRow(a.voter.bindingId)).toMatchObject({ applied_intent_no: 0 });

    // ---- cast commits first
    const b = await preparedEvent();
    await issue(b.ev, b.voter);
    const caster = await rawClient();
    try {
      await caster.query("begin");
      await caster.query("select * from cast_community_voting_vote_atomically($1,$2,$3,1,$4,$5,$6,$7,$8)", [
        b.ev.instance.instanceId, b.voter.authUserId, b.voter.bindingId, b.voting.interactionInstanceId, b.voting.candidates[0].candidateId, INSIDE.latitude, INSIDE.longitude, INSIDE.accuracyMeters,
      ]);
      let closed = false;
      const closeP = closeSubmissions(sessionRepo, b.ev.session.sessionId, b.ev.session.hostToken).finally(() => { closed = true; });
      closeP.catch(() => {});
      await sleep(600);
      expect(closed, "the close must wait for the cast's Session lock").toBe(false);
      await caster.query("commit");
      await closeP;
    } finally {
      await caster.query("rollback").catch(() => {});
      await caster.end();
    }
    expect(await votesFor(b.voting.interactionInstanceId)).toHaveLength(1);
    expect(await bindingRow(b.voter.bindingId)).toMatchObject({ applied_intent_no: 1 });
    await expect(cast(b.ev, b.voter, b.voting, b.voting.candidates[0].candidateId, 1)).resolves.toMatchObject({ outcome: "REPLAYED" });
  });

  it("rolls back EVERYTHING when a failure occurs after the Voting write (negative control with a temporary failing trigger)", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await q("create or replace function cv_contract_fail_binding_update() returns trigger language plpgsql as $$ begin raise exception 'CV_CONTRACT_INDUCED_FAILURE'; end; $$");
    await q("create trigger zz_cv_contract_fail before update on community_voting_voter_bindings for each row execute function cv_contract_fail_binding_update()");
    try {
      // (a) over a raw connection the induced failure is visible verbatim — proving the failure really is the injected one ...
      const raw = await rawError(pool, "select * from cast_community_voting_vote_atomically($1,$2,$3,1,$4,$5,$6,$7,$8)", [
        ev.instance.instanceId, voter.authUserId, voter.bindingId, voting.interactionInstanceId, voting.candidates[0].candidateId,
        INSIDE.latitude, INSIDE.longitude, INSIDE.accuracyMeters,
      ]);
      expect(raw.message).toMatch(/CV_CONTRACT_INDUCED_FAILURE/);
      // (b) ... and through the repository an unknown database failure is reduced to its SQLSTATE: no parameters, no message text.
      const err = await cast(ev, voter, voting, voting.candidates[0].candidateId, 1).then(() => null, (e: unknown) => e as Error);
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(CommunityVotingError);
      expect(String(err!.message)).toBe("Community Voting database error (P0001).");
    } finally {
      await q("drop trigger if exists zz_cv_contract_fail on community_voting_voter_bindings");
      await q("drop function if exists cv_contract_fail_binding_update()");
    }
    // the delegated Voting write, its event and the recovery metadata were all rolled back together
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(0);
    expect(await voteEvents(ev.session.sessionId)).toBe(0);
    expect(await bindingRow(voter.bindingId)).toMatchObject({ issued_intent_no: 1, applied_intent_no: 0, applied_payload_digest: null, applied_at: null });
    // and, with the trigger gone, the very same intent now succeeds exactly once
    await expect(cast(ev, voter, voting, voting.candidates[0].candidateId, 1)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("publication stays with the Session: the tally comes from the existing Voting store and only after reveal", async () => {
    const { ev, voting, voter, contestants } = await preparedEvent();
    await issue(ev, voter); await issue(ev, contestants[1]);
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    await cast(ev, contestants[1], voting, voting.candidates[0].candidateId, 1);
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    await revealResults(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const results = await sessionRepo.getVotingResultsForInteractionInstance(voting.interactionInstanceId);
    expect(results.find((r) => r.candidateId === voting.candidates[0].candidateId)).toMatchObject({ voteCount: 2, rank: 1 });
  });
});

// ============================================================ deletion containment

describe("Deletion containment (provisional technical containment — not a retention policy)", () => {
  async function counts(ev: Event) {
    return {
      participants: (await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).length,
      bindings: (await q("select 1 from community_voting_voter_bindings where instance_id = $1", [ev.instance.instanceId])).length,
      instances: (await q("select 1 from community_voting_instances where instance_id = $1", [ev.instance.instanceId])).length,
      sessions: (await q("select 1 from sessions where session_id = $1", [ev.session.sessionId])).length,
    };
  }

  it("refuses to delete a Session, a bound Participant, a bound Auth user or an Instance — and silently destroys no counted vote", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[1].candidateId, 1);
    const before = await counts(ev);
    const participantId = await participantIdOf(voter.bindingId);

    const attempts: Array<[string, string, unknown[]]> = [
      ["delete the event Session", "delete from sessions where session_id = $1", [ev.session.sessionId]],
      ["delete the bound Participant", "delete from participants where participant_id = $1", [participantId]],
      ["delete the bound Auth user", "delete from auth.users where id = $1", [voter.authUserId]],
      ["delete the Instance", "delete from community_voting_instances where instance_id = $1", [ev.instance.instanceId]],
    ];
    for (const [label, sql, params] of attempts) {
      const c = await rawClient();
      try {
        const err = await rawError(c, sql, params);
        expect(["23001", "23503", "P0001"], `${label}: ${err.message}`).toContain(err.code);
      } finally {
        await c.end();
      }
    }
    expect(await counts(ev)).toEqual(before);
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(1);
    expect(await voteEvents(ev.session.sessionId)).toBe(1);
  });

  it("refuses to delete or truncate bindings even for the database owner, so a binding cannot be deleted and recreated to gain a second vote", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[1].candidateId, 1);
    const del = await rawError(pool, "delete from community_voting_voter_bindings where binding_id = $1", [voter.bindingId]);
    expect(del.message).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    const tr = await rawError(pool, "truncate community_voting_voter_bindings");
    expect(tr.message).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE|cannot truncate/);
    const delI = await rawError(pool, "delete from community_voting_instances where instance_id = $1", [ev.instance.instanceId]);
    expect(delI.code).toBeDefined();
    // re-binding returns the SAME binding and never grants a second vote
    await expect(repo.bindVoter({ instanceId: ev.instance.instanceId, authUserId: voter.authUserId })).resolves.toMatchObject({ bindingId: voter.bindingId, created: false });
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(1);
  });

  it("keeps binding history immutable: identity fields never change and intent counters never move backwards", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter); await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[1].candidateId, 2);
    const other = await bindNew(ev);
    const cases: Array<[string, string, unknown[]]> = [
      ["re-assign the Auth user", "update community_voting_voter_bindings set auth_user_id = $2 where binding_id = $1", [voter.bindingId, other.authUserId]],
      ["re-assign the Participant", "update community_voting_voter_bindings set participant_id = $2 where binding_id = $1", [voter.bindingId, await participantIdOf(other.bindingId)]],
      ["move to another Instance", "update community_voting_voter_bindings set instance_id = $2 where binding_id = $1", [voter.bindingId, randomUUID()]],
      ["lower the applied intent", "update community_voting_voter_bindings set applied_intent_no = 1 where binding_id = $1", [voter.bindingId]],
      ["lower the issued intent", "update community_voting_voter_bindings set issued_intent_no = 1 where binding_id = $1", [voter.bindingId]],
      ["apply beyond what was issued", "update community_voting_voter_bindings set applied_intent_no = 9 where binding_id = $1", [voter.bindingId]],
    ];
    for (const [label, sql, params] of cases) {
      const err = await rawError(pool, sql, params);
      expect(["P0001", "23514", "23503", "23505"], `${label}: ${err.message}`).toContain(err.code);
    }
    expect(await bindingRow(voter.bindingId)).toMatchObject({ issued_intent_no: 2, applied_intent_no: 2 });
    const inst = await rawError(pool, "update community_voting_instances set venue_radius_meters = 99999 where instance_id = $1", [ev.instance.instanceId]);
    expect(inst.message).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
  });

  it("a TRUNCATE ... CASCADE from a parent table cannot sweep the Instance tables away either", async () => {
    const { ev } = await preparedEvent();
    const before = await counts(ev);
    for (const parent of ["sessions", "participants", "community_voting_instances"]) {
      const c = await rawClient();
      try {
        await c.query("begin");
        const err = await rawError(c, `truncate ${parent} cascade`);
        expect(err.message, parent).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE|cannot truncate/);
      } finally {
        await c.query("rollback").catch(() => {});
        await c.end();
      }
    }
    expect(await counts(ev)).toEqual(before);
  });

  it("containment is targeted: an Auth user with no binding can still be deleted", async () => {
    const id = await newAuthUser();
    await q("delete from auth.users where id = $1", [id]);
    expect(await q("select 1 from auth.users where id = $1", [id])).toHaveLength(0);
  });

  it("creates exactly the intended constraints: no cascade anywhere in the Community Voting foreign keys", async () => {
    const fks = await q<{ conname: string; confdeltype: string }>(
      "select c.conname, c.confdeltype from pg_constraint c where c.contype = 'f' and c.conrelid::regclass::text like 'community_voting%' order by 1"
    );
    expect(fks.length).toBeGreaterThanOrEqual(4);
    for (const fk of fks) expect(fk.confdeltype, `${fk.conname} must be RESTRICT (r)`).toBe("r");
  });
});

// ============================================================ regression through the real stack

describe("Existing Session/Voting behaviour through the real stack is unchanged", () => {
  it("a complete ordinary voting round (guest join, lock, start, vote, revise, close, reveal, complete) still works", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    const alex = await joinSession(sessionRepo, session.roomCode, "Alex");
    const sam = await joinSession(sessionRepo, session.roomCode, "Sam");
    await lockLobby(sessionRepo, session.sessionId, session.hostToken);
    const started = await startSession(sessionRepo, session.sessionId, session.hostToken, { engineType: "VOTING", promptText: "Q", candidateSource: { type: "PARTICIPANTS" } });
    const candidates = await sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
    const samCandidate = candidates.find((c) => c.participantId === sam.participantId)!;
    const alexCandidate = candidates.find((c) => c.participantId === alex.participantId)!;
    await castVote(sessionRepo, session.sessionId, alex.participantToken, samCandidate.candidateId);
    await castVote(sessionRepo, session.sessionId, alex.participantToken, samCandidate.candidateId);
    await expect(castVote(sessionRepo, session.sessionId, alex.participantToken, alexCandidate.candidateId)).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
    await closeSubmissions(sessionRepo, session.sessionId, session.hostToken);
    await revealResults(sessionRepo, session.sessionId, session.hostToken);
    await completeSession(sessionRepo, session.sessionId, session.hostToken);
    expect((await sessionRepo.getSessionById(session.sessionId))!.state).toBe("SESSION_COMPLETE");
  });
});

// ============================================================ privacy audit of the existing projections (real stack)

describe("Existing Session projections never expose identity-to-selection", () => {
  it("the host's GET_SESSION view of an event Session contains opaque labels only — no Auth id, no token, no per-voter selection, no early tally", async () => {
    const { ev, voting, voter, contestants } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    const tokens = (await q<{ participant_token: string }>("select participant_token from participants where session_id = $1", [ev.session.sessionId])).map((r) => r.participant_token);
    const host = await getSession(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const text = JSON.stringify(host);
    for (const who of [voter, ...contestants]) expect(text).not.toContain(who.authUserId);
    for (const t of tokens) expect(text).not.toContain(t);
    expect(host.participants).toHaveLength(4);
    for (const p of host.participants) expect(p.displayName).toMatch(/^cv-[0-9a-f]{16}$/);
    expect(host.votingResults).toBeNull();
    expect(host.myVoteCandidateId).toBeNull();
    // An event voter holds no usable token: GET_SESSION and the ordinary cast path are unreachable for them.
    await expect(getSession(sessionRepo, ev.session.sessionId, "guess")).rejects.toThrow();
  });
});

// ============================================================ routes (thin) — real database behind them

describe("Routes", () => {
  const call = async (handler: (req: Request, ctx: never) => Promise<Response>, instanceId: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; extraParams?: Record<string, string> } = {}) => {
    const request = new Request(`http://localhost/api/test`, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
    const response = await handler(request, { params: { instanceId, ...(init.extraParams ?? {}) } } as never);
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, any> };
  };

  it("registration: bearer required, JSON required, host token checked, then registered once — and no-store", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"]);
    const body = { sessionId: session.sessionId, config: VENUE, ruleVersion: 1 };

    expect((await call(registerRoute as never, "", { body })).status).toBe(401);
    expect((await call(registerRoute as never, "", { headers: { authorization: `Bearer ${session.hostToken}` }, body: "{not json" })).status).toBe(400);
    const wrong = await call(registerRoute as never, "", { headers: { authorization: "Bearer wrong" }, body });
    expect(wrong.status).toBe(403);
    expect(wrong.json.code).toBe("HOST_TOKEN_MISMATCH");

    const ok = await call(registerRoute as never, "", { headers: { authorization: `Bearer ${session.hostToken}` }, body });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((ok.json.instance as { sessionId: string }).sessionId).toBe(session.sessionId);
    expect(JSON.stringify(ok.json)).not.toContain(session.hostToken);

    const again = await call(registerRoute as never, "", { headers: { authorization: `Bearer ${session.hostToken}` }, body });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("INSTANCE_ALREADY_REGISTERED");

    const bad = await call(registerRoute as never, "", { headers: { authorization: `Bearer ${session.hostToken}` }, body: { ...body, config: { ...VENUE, venueRadiusMeters: -1 } } });
    expect([400, 409]).toContain(bad.status);
  });

  it("host preparation routes: bearer required; entries are created, listed and removed over HTTP, the claim credential travels only in the response body, and the start is explicit", async () => {
    const ev = await newEvent();
    const id = ev.instance.instanceId;
    const host = { authorization: `Bearer ${ev.session.hostToken}` };

    expect((await call(entriesPostRoute as never, id, { body: { label: "Uno" } })).status).toBe(401);
    expect((await call(entriesPostRoute as never, id, { headers: { authorization: "Bearer wrong" }, body: { label: "Uno" } })).status).toBe(403);
    expect((await call(entriesGetRoute as never, id, { method: "GET" })).status).toBe(401);
    expect((await call(startRoute as never, id, { body: { promptText: "Q" } })).status).toBe(401);
    expect((await call(entriesPostRoute as never, id, { headers: host, body: "{not json" })).status).toBe(400);

    const created = await call(entriesPostRoute as never, id, { headers: host, body: { label: "Uno" } });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.json.claimCode).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(created.json).sort()).toEqual(["claimCode", "claimExpiresAt", "entryId", "label"]);
    expect((await call(entriesPostRoute as never, id, { headers: host, body: { label: "uno" } })).json.code).toBe("ENTRY_LABEL_DUPLICATE");
    expect((await call(entriesPostRoute as never, id, { headers: host, body: { label: "  " } })).json.code).toBe("ENTRY_LABEL_INVALID");

    const listed = await call(entriesGetRoute as never, id, { method: "GET", headers: host });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).not.toContain(created.json.claimCode);
    expect(listed.json.readiness).toEqual({ entryCount: 1, confirmedCount: 0, ready: false });
    expect(listed.json.entries[0]).toMatchObject({ label: "Uno", state: "UNCLAIMED", claimable: true });

    const removed = await call(entryDeleteRoute as never, id, { method: "DELETE", headers: host, extraParams: { entryId: created.json.entryId } });
    expect(removed.status).toBe(200);
    const again = await call(entryDeleteRoute as never, id, { method: "DELETE", headers: host, extraParams: { entryId: created.json.entryId } });
    expect(again.status).toBe(404);
    expect(again.json.code).toBe("ENTRY_NOT_FOUND");

    // an explicit start before the ballot is complete is refused over HTTP and leaves nothing behind
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const early = await call(startRoute as never, id, { headers: host, body: { promptText: "Q" } });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe("PREPARATION_INCOMPLETE");
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 0, candidates: 0, startedEvents: 0 });
    expect((await call(startRoute as never, id, { headers: host, body: { promptText: 5 } })).json.code).toBe("INVALID_REQUEST");
  });

  it("voter routes fail CLOSED: no header, a forged bearer, and an unreachable Auth service all yield 401 and bind nothing", async () => {
    const ev = await newEvent();
    const handlers: Array<[string, (req: Request, ctx: never) => Promise<Response>, string]> = [
      ["binding", bindRoute as never, "POST"], ["claims", claimRoute as never, "POST"], ["intents", intentRoute as never, "POST"], ["votes", voteRoute as never, "POST"], ["status", statusRoute as never, "GET"],
    ];
    for (const [name, handler, method] of handlers) {
      const none = await call(handler, ev.instance.instanceId, { method, body: method === "POST" ? {} : undefined });
      expect(none.status, `${name} without a header`).toBe(401);
      expect(none.json.code).toBe("AUTHENTICATION_REQUIRED");
      const forged = await call(handler, ev.instance.instanceId, { method, headers: { authorization: `Bearer ${randomUUID()}` }, body: method === "POST" ? {} : undefined });
      expect(forged.status, `${name} with a forged bearer`).toBe(401);
      expect(forged.headers.get("cache-control")).toBe("no-store");
    }
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0);
    expect(await q("select 1 from community_voting_voter_bindings where instance_id = $1", [ev.instance.instanceId])).toHaveLength(0);
  });

  it("a request body full of coordinates never reaches a log line, even when the request is refused", async () => {
    const ev = await newEvent();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await call(voteRoute as never, ev.instance.instanceId, {
        headers: { authorization: `Bearer ${randomUUID()}` },
        body: { bindingId: randomUUID(), intentNo: 1, interactionInstanceId: randomUUID(), candidateId: randomUUID(), location: { latitude: 14.123987, longitude: -87.456123, accuracyMeters: 7 } },
      });
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain("14.123987");
      expect(logged).not.toContain("87.456123");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("misconfiguration answers 500 without echoing anything", async () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const ev = await newEvent();
      const r = await call(bindRoute as never, ev.instance.instanceId, { headers: { authorization: "Bearer x" }, body: {} });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.json)).not.toMatch(/key|secret|token/i);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    }
  });
});

// ============================================================ end to end with a REAL local Auth service

/**
 * The isolated stack includes a local GoTrue configured with phone and email AUTOCONFIRM and NO mail or SMS provider:
 * no OTP, email or SMS can be delivered or requested here. Users are created through the real sign-up / admin paths,
 * so the access tokens below are real, and the verifier's assumptions about what Auth returns are tested against the
 * service itself rather than against hand-built objects. (The local GoTrue version may differ from the hosted one.)
 */
describe("End to end with a real local Auth service", () => {
  const tag = () => String(Math.floor(Math.random() * 1e7)).padStart(7, "0");

  async function phoneVoter() {
    const password = `Pw-${randomUUID()}`;
    const phone = `+1555${tag()}`;
    const { data, error } = await anon.auth.signUp({ phone, password });
    if (error || !data.session || !data.user) throw error ?? new Error("phone sign-up did not return a session");
    return { authUserId: data.user.id, token: data.session.access_token, header: `Bearer ${data.session.access_token}`, phone };
  }
  async function emailOnlyUser() {
    const password = `Pw-${randomUUID()}`;
    const email = `cv-e2e-${randomUUID()}@example.invalid`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("email user not created");
    const signedIn = await anon.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("email sign-in failed");
    return { authUserId: created.data.user.id, header: `Bearer ${signedIn.data.session.access_token}`, token: signedIn.data.session.access_token };
  }
  const call = async (handler: (req: Request, ctx: never) => Promise<Response>, instanceId: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; extraParams?: Record<string, string> } = {}) => {
    const response = await handler(
      new Request("http://localhost/api/test", {
        method: init.method ?? "POST",
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      { params: { instanceId, ...(init.extraParams ?? {}) } } as never
    );
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };

  it("derives phoneVerified from the user details the real Auth service returns", async () => {
    const verifier = new SupabaseVoterIdentityVerifier(supabaseUrl as string, serviceKey as string);
    const phone = await phoneVoter();
    expect(await verifier.verifyAccessToken(phone.token)).toEqual({ authUserId: phone.authUserId, phoneVerified: true });
    const email = await emailOnlyUser();
    expect(await verifier.verifyAccessToken(email.token)).toEqual({ authUserId: email.authUserId, phoneVerified: false });
    expect(await verifier.verifyAccessToken("not.a.token")).toBeNull();
    expect(await verifier.verifyAccessToken("")).toBeNull();
    // fail-closed when the Auth service cannot be reached at all
    // (a genuinely closed loopback port: bind an ephemeral one, release it, and point the verifier there)
    const closedPort = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const unreachable = new SupabaseVoterIdentityVerifier(`http://127.0.0.1:${closedPort}`, serviceKey as string);
    expect(await unreachable.verifyAccessToken(phone.token)).toBeNull();
  });

  it("full voter journey over the HTTP handlers — and optional profile completion leaves the confirmed vote untouched", async () => {
    const ev = await newEvent();
    const host = { authorization: `Bearer ${ev.session.hostToken}` };
    const id = ev.instance.instanceId;

    const c1 = await phoneVoter();
    const c2 = await phoneVoter();
    const voter = await phoneVoter();
    const emailOnly = await emailOnlyUser();

    for (const who of [c1, c2, voter]) expect((await call(bindRoute as never, id, { headers: { authorization: who.header } })).status).toBe(201);
    const refused = await call(bindRoute as never, id, { headers: { authorization: emailOnly.header } });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("VERIFIED_PHONE_REQUIRED");
    expect((await call(bindRoute as never, id, { headers: { authorization: voter.header } })).status).toBe(200); // idempotent recovery

    const gamingBefore = Number((await q<{ n: string }>("select count(*)::text n from gaming_members"))[0].n);
    expect((await q("select 1 from gaming_members where auth_user_id = any($1)", [[c1.authUserId, c2.authUserId, voter.authUserId, emailOnly.authUserId]]))).toHaveLength(0);

    // ---- private preparation over HTTP: the host creates each entry, the contestant claims it with their OWN verified
    // identity, and the host confirms against the code shown on the contestant's screen. Nothing here opens Voting.
    const hostFacing: unknown[] = [];
    for (const [label, who] of [["Uno", c1], ["Dos", c2]] as const) {
      const created = await call(entriesPostRoute as never, id, { headers: host, body: { label } });
      expect(created.status).toBe(201);
      const claimed = await call(claimRoute as never, id, { headers: { authorization: who.header }, body: { claimCode: created.json.claimCode } });
      expect(claimed.status).toBe(200);
      expect(Object.keys(claimed.json).sort()).toEqual(["confirmExpiresAt", "confirmationCode", "label"]);
      const reused = await call(claimRoute as never, id, { headers: { authorization: voter.header }, body: { claimCode: created.json.claimCode } });
      expect(reused.status).toBe(403);
      expect(reused.json.code).toBe("CLAIM_INVALID");
      const confirmed = await call(confirmRoute as never, id, { headers: host, extraParams: { entryId: created.json.entryId }, body: { confirmationCode: claimed.json.confirmationCode } });
      expect(confirmed.status).toBe(200);
      expect(confirmed.json).toEqual({ entryId: created.json.entryId, state: "CONFIRMED" });
      hostFacing.push(confirmed.json);
    }
    const prepared = await call(entriesGetRoute as never, id, { method: "GET", headers: host });
    expect(prepared.json.readiness).toEqual({ entryCount: 2, confirmedCount: 2, ready: true });
    hostFacing.push(prepared.json);
    const beforeStart = await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } });
    expect(beforeStart.json.phase).toBe("NOT_OPEN"); // a complete, confirmed ballot is still NOT open
    expect(await ballotCounts(ev)).toMatchObject({ interactions: 0, candidates: 0, startedEvents: 0 });

    // ---- the explicit, host-authorized, atomic start
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const startedResponse = await call(startRoute as never, id, { headers: host, body: { promptText: "Mejor disfraz" } });
    expect(startedResponse.status).toBe(201);
    expect(startedResponse.json).toMatchObject({ state: "PROMPT_ACTIVE", candidateCount: 2, segmentNumber: 1 });
    hostFacing.push(startedResponse.json);
    const voting = {
      interactionInstanceId: startedResponse.json.interactionInstanceId as string,
      candidates: await sessionRepo.getVotingCandidatesForInteraction(startedResponse.json.interactionInstanceId),
    };
    expect(voting.candidates.map((c) => c.label)).toEqual(["Uno", "Dos"]);
    expect((await call(startRoute as never, id, { headers: host, body: { promptText: "Otra" } })).json.code).toBe("ALREADY_OPENED");

    // nothing host-facing ever carried a phone, an Auth id, an access token or a Participant token
    const hostText = JSON.stringify(hostFacing);
    const tokens = (await q<{ participant_token: string }>("select participant_token from participants where session_id = $1", [ev.session.sessionId])).map((r) => r.participant_token);
    for (const who of [c1, c2, voter]) for (const secret of [who.phone, who.authUserId, who.token]) expect(hostText).not.toContain(secret);
    for (const token of tokens) expect(hostText).not.toContain(token);

    const open = await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } });
    expect(open.json.phase).toBe("OPEN");
    const intent = await call(intentRoute as never, id, { headers: { authorization: voter.header } });
    expect(intent.status).toBe(201);
    const cast1 = await call(voteRoute as never, id, {
      headers: { authorization: voter.header },
      body: { bindingId: intent.json.bindingId, intentNo: intent.json.intentNo, interactionInstanceId: voting.interactionInstanceId, candidateId: voting.candidates[1].candidateId, location: INSIDE },
    });
    expect(cast1.status).toBe(200);
    expect(cast1.json.outcome).toBe("APPLIED");
    expect(JSON.stringify(cast1.json)).not.toContain(String(INSIDE.latitude).slice(0, 9));

    // a contestant cannot vote for their own entry (existing Voting rule), and the response is still not a leak
    const ci = await call(intentRoute as never, id, { headers: { authorization: c1.header } });
    const self = await call(voteRoute as never, id, {
      headers: { authorization: c1.header },
      body: { bindingId: ci.json.bindingId, intentNo: ci.json.intentNo, interactionInstanceId: voting.interactionInstanceId, candidateId: voting.candidates[0].candidateId, location: INSIDE },
    });
    expect(self.status).toBe(400);
    expect(self.json.code).toBe("SELF_VOTE_NOT_ALLOWED");

    // ---- optional, later profile completion through the EXISTING member route, with the same identity
    const statusBefore = (await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } })).json;
    const member = await memberRoute(
      new Request("http://localhost/api/gaming/member", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: voter.header },
        body: JSON.stringify({ displayName: "Votante Real" }),
      })
    );
    expect(member.status).toBe(201);
    const memberRow = await q<{ auth_user_id: string; display_name: string }>("select auth_user_id, display_name from gaming_members where auth_user_id = $1", [voter.authUserId]);
    expect(memberRow).toHaveLength(1);
    expect(memberRow[0].display_name).toBe("Votante Real");
    expect(Number((await q<{ n: string }>("select count(*)::text n from gaming_members"))[0].n)).toBe(gamingBefore + 1); // exactly the one the voter chose to create
    const statusAfter = (await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } })).json;
    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.myCandidateId).toBe(voting.candidates[1].candidateId);
    // The profile created a membership; it granted no Community Voting authority and changed no participant label.
    expect((await q<{ display_name: string }>("select p.display_name from participants p join community_voting_voter_bindings b on b.participant_id = p.participant_id where b.auth_user_id = $1", [voter.authUserId]))[0].display_name).toMatch(/^cv-[0-9a-f]{16}$/);

    // ---- close, recovery, publication
    await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const replay = await call(voteRoute as never, id, {
      headers: { authorization: voter.header },
      body: { bindingId: intent.json.bindingId, intentNo: intent.json.intentNo, interactionInstanceId: voting.interactionInstanceId, candidateId: voting.candidates[1].candidateId, location: OUTSIDE },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.outcome).toBe("REPLAYED");
    expect((await call(intentRoute as never, id, { headers: { authorization: voter.header } })).status).toBe(409);
    const closed = (await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } })).json;
    expect(closed.phase).toBe("CLOSED");
    expect(closed.results).toBeNull();
    await revealResults(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const published = (await call(statusRoute as never, id, { method: "GET", headers: { authorization: voter.header } })).json;
    expect(published.phase).toBe("PUBLISHED");
    expect(published.results.find((r: any) => r.candidateId === voting.candidates[1].candidateId)).toMatchObject({ voteCount: 1, rank: 1 });
    // a stranger with a valid phone identity sees only their own (empty) state
    const stranger = await phoneVoter();
    expect((await call(statusRoute as never, id, { method: "GET", headers: { authorization: stranger.header } })).json).toMatchObject({ bound: false, myCandidateId: null, results: null });
  });
});

// ============================================================ negative controls (each rolled back) + structure + mixed concurrency

describe("Negative controls: these tests would notice if the protection were removed", () => {
  it("without the guard an ordinary join WOULD enter an event-bound Session (so the guard is what prevents it)", async () => {
    const ev = await newEvent();
    const [{ src }] = await q<{ src: string }>("select prosrc as src from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_participant_atomically'");
    const unguarded = src.replace(/\n  -- BEGIN community-voting guard[\s\S]*?-- END community-voting guard\n/, "");
    expect(unguarded).not.toBe(src);
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query(`create or replace function join_participant_atomically(p_participant_id uuid, p_session_id uuid, p_display_name text, p_normalized_display_name text, p_participant_token text, p_joined_at timestamptz, p_event_type text, p_event_payload jsonb, p_gaming_member_id uuid default null) returns void language plpgsql security invoker set search_path = public as $cv$${unguarded}$cv$`);
      await c.query("select join_participant_atomically($1,$2,'Sneaky','sneaky',$3,now(),'PARTICIPANT_JOINED','{}'::jsonb,null)", [randomUUID(), ev.session.sessionId, `neg-${randomUUID()}`]);
      const inside = await c.query("select count(*)::int n from participants where session_id = $1", [ev.session.sessionId]);
      expect(inside.rows[0].n).toBe(1); // the ordinary participant got in
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect(await q("select 1 from participants where session_id = $1", [ev.session.sessionId])).toHaveLength(0); // and the control left no trace
  });

  it("with cascading foreign keys a participant deletion WOULD silently destroy a counted vote (so RESTRICT is what protects it)", async () => {
    const { ev, voting, voter } = await preparedEvent();
    await issue(ev, voter);
    await cast(ev, voter, voting, voting.candidates[0].candidateId, 1);
    const participantId = await participantIdOf(voter.bindingId);
    const [fk] = await q<{ conname: string }>("select conname from pg_constraint where conrelid = 'community_voting_voter_bindings'::regclass and confrelid = 'participants'::regclass");
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query(`alter table community_voting_voter_bindings drop constraint ${fk.conname}`);
      await c.query("alter table community_voting_voter_bindings disable trigger user");
      await c.query("delete from participants where participant_id = $1", [participantId]);
      const gone = await c.query("select count(*)::int n from votes where interaction_instance_id = $1", [voting.interactionInstanceId]);
      expect(gone.rows[0].n).toBe(0); // the vote vanished with the participant
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect(await votesFor(voting.interactionInstanceId)).toHaveLength(1); // ... and in the real schema it does not
  });

  it("without BOTH guards an ordinary start WOULD open an event-bound Session with unattributed candidates", async () => {
    const ev = await newEvent();
    await prepareContestants(ev, ["Uno", "Dos"]);
    await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query("alter table interaction_instances disable trigger user");
      await c.query("alter table voting_candidates disable trigger user");
      await c.query("select * from start_session_atomically($1,$2,'Q',null,'HOST_AUTHORED','[\"Uno\",\"Dos\"]'::jsonb,null,'NEW_SEGMENT')", [ev.session.sessionId, ev.session.hostToken]);
      const open = await c.query("select count(*)::int as total, count(*) filter (where vc.participant_id is null)::int as unattributed from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1", [ev.session.sessionId]);
      expect(open.rows[0]).toEqual({ total: 2, unattributed: 2 }); // OPEN, with no one attributed — exactly what the guards prevent
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect((await ballotCounts(ev)).interactions).toBe(0);
  });

  it("EACH guard alone still stops the ordinary start: the interaction guard and the candidate guard are independent", async () => {
    for (const [disable, expected] of [
      ["voting_candidates", /EVENT_BOUND_SESSION/], // only the interaction guard is left standing
      ["interaction_instances", /COMMUNITY_VOTING_BALLOT_FROZEN/], // only the candidate guard is left standing
    ] as const) {
      const ev = await newEvent();
      await prepareContestants(ev, ["Uno", "Dos"]);
      await lockLobby(sessionRepo, ev.session.sessionId, ev.session.hostToken);
      const c = await rawClient();
      try {
        await c.query("begin");
        await c.query(`alter table ${disable} disable trigger user`);
        const err = await c
          .query("select * from start_session_atomically($1,$2,'Q',null,'HOST_AUTHORED','[\"Uno\",\"Dos\"]'::jsonb,null,'NEW_SEGMENT')", [ev.session.sessionId, ev.session.hostToken])
          .then(() => null, (e: Error) => e);
        expect(err, `with only the ${disable === "voting_candidates" ? "interaction" : "candidate"} guard standing`).not.toBeNull();
        expect(err!.message).toMatch(expected);
      } finally {
        await c.query("rollback").catch(() => {});
        await c.end();
      }
      expect(await ballotCounts(ev)).toMatchObject({ interactions: 0, candidates: 0, startedEvents: 0 });
    }
  });

  it("without the ballot freeze an opened ballot's attribution WOULD be rewritable", async () => {
    const { voting } = await preparedEvent();
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query("alter table voting_candidates disable trigger user");
      await c.query("update voting_candidates set participant_id = null where candidate_id = $1", [voting.candidates[0].candidateId]);
      const changed = await c.query("select count(*)::int as n from voting_candidates where candidate_id = $1 and participant_id is null", [voting.candidates[0].candidateId]);
      expect(changed.rows[0].n).toBe(1);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    expect((await q("select 1 from voting_candidates where candidate_id = $1 and participant_id is not null", [voting.candidates[0].candidateId]))).toHaveLength(1);
  });

  it("granting EXECUTE to anon would be visible to the ACL check", async () => {
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query("grant execute on function bind_community_voting_voter_atomically(uuid, uuid) to anon");
      const acl = await c.query("select coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') as grantee from pg_proc p, aclexplode(p.proacl) a where p.proname = 'bind_community_voting_voter_atomically' and a.privilege_type = 'EXECUTE'");
      expect(acl.rows.map((r: { grantee: string }) => r.grantee)).toContain("anon");
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    const [{ ok }] = await q<{ ok: boolean }>("select has_function_privilege('anon', 'bind_community_voting_voter_atomically(uuid, uuid)', 'execute') as ok");
    expect(ok).toBe(false);
  });
});

describe("Lock order and structure", () => {
  it("every writing function takes the Session row lock FIRST — before any other lock or write", async () => {
    for (const fn of [
      "register_community_voting_instance_atomically",
      "bind_community_voting_voter_atomically",
      "issue_community_voting_intent_atomically",
      "create_community_voting_entry_atomically",
      "remove_community_voting_entry_atomically",
      "claim_community_voting_entry_atomically",
      "confirm_community_voting_entry_atomically",
      "start_community_voting_atomically",
      "cast_community_voting_vote_atomically",
    ]) {
      const [{ src }] = await q<{ src: string }>("select prosrc as src from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [fn]);
      const firstLock = src.search(/for\s+update/i);
      expect(firstLock, `${fn} must lock something`).toBeGreaterThan(-1);
      // the statement holding the first FOR UPDATE reads from sessions
      const statementStart = src.lastIndexOf("select", firstLock);
      expect(src.slice(statementStart, firstLock), `${fn}: the first lock must be on sessions`).toMatch(/from\s+sessions/i);
      const firstWrite = src.search(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
      if (firstWrite !== -1) expect(firstLock, `${fn}: no write may precede the Session lock`).toBeLessThan(firstWrite);
    }
  });
});

describe("Mixed concurrency: binds, intents, casts and a close racing one another", () => {
  it("no deadlock, no lost vote and no phantom vote: every outcome is accounted for", async () => {
    const ev = await newEvent();
    const voting = await openVoting(ev);

    const N = 36;
    const voters = await Promise.all(Array.from({ length: N }, () => bindNew(ev)));
    expect(new Set(voters.map((v) => v.bindingId)).size).toBe(N);

    const voteOnce = async (v: (typeof voters)[number], i: number) => {
      try {
        const { intentNo } = await issue(ev, v);
        const r = await cast(ev, v, voting, voting.candidates[i % 3].candidateId, intentNo);
        return r.outcome === "APPLIED" ? "counted" : r.outcome;
      } catch (e) {
        if (e instanceof CommunityVotingError) return e.code;
        return `UNEXPECTED:${(e as Error).message}`;
      }
    };

    // A deterministic head start: the first twelve vote while nothing is closing, so "some votes were counted" is a
    // fact of the run rather than of scheduling. The remaining voters then race the close.
    const HEAD = 12;
    const early = await Promise.all(voters.slice(0, HEAD).map((v, i) => voteOnce(v, i)));
    expect(early).toEqual(Array(HEAD).fill("counted"));

    const closeAt = 12;
    const racing = await Promise.all(
      voters.slice(HEAD).map(async (v, i) => {
        if (i === closeAt) await closeSubmissions(sessionRepo, ev.session.sessionId, ev.session.hostToken).catch(() => {});
        return voteOnce(v, HEAD + i);
      })
    );
    const outcomes = [...early, ...racing];
    expect(outcomes.filter((o) => String(o).startsWith("UNEXPECTED")), JSON.stringify(outcomes)).toEqual([]);
    for (const o of outcomes) expect(["counted", "VOTING_NOT_OPEN"]).toContain(o);
    expect(outcomes.filter((o) => o === "counted").length).toBeGreaterThanOrEqual(HEAD);
    // The committed votes are exactly the ones reported as counted — nothing lost, nothing phantom.
    expect((await votesFor(voting.interactionInstanceId)).length).toBe(outcomes.filter((o) => o === "counted").length);
    expect(await voteEvents(ev.session.sessionId)).toBe(outcomes.filter((o) => o === "counted").length);
  });
});

beforeAll(async () => {
  // Fail fast and legibly if the isolated database is not the migrated target this suite expects.
  const [{ n }] = await q<{ n: string }>("select count(*)::text as n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'cast_vote_atomically'");
  if (n !== "1") throw new Error("The target database does not carry the committed Session/Voting migrations.");
});
