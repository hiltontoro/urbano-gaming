import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { GeoNotEligibleError } from "../lib/gaming/predictions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { localSettlementDatabaseUrl, purgeSettlementEvidence } from "./helpers/localSettlementCleanup";

/**
 * Score Predictions — the Predictions-owned database objects belong to the
 * server (migration 20261021120000).
 *
 * Until that migration three functions and six tables created for Soccer
 * Predictions could be reached by any browser through the public API:
 * reclassifying a match, flipping its XP eligibility, submitting a
 * prediction with a SELF-REPORTED "inside the venue" flag, and reading or
 * rewriting matches, predictions, players, teams, venues and venue
 * activations. This suite proves the boundary with real database roles:
 * the real anon key, and a real signed-in member's token (role
 * authenticated), each refused on every object — while the server path
 * (service_role, through the repository the application routes use) still
 * works, including a prediction submission with its geolocation check.
 *
 * Shared authority, identity, audit and Metagame tables belong to other
 * lanes; nothing here changes them.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey || !anonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
const databaseUrl = localSettlementDatabaseUrl();

const repo = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const admin: SupabaseClient = createClient(supabaseUrl, serviceKey);
const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];
const createdMatchIds: string[] = [];
const createdVenueIds: string[] = [];
const createdTeamIds: string[] = [];

afterAll(async () => {
  await purgeSettlementEvidence(databaseUrl, createdMatchIds);
  for (const matchId of createdMatchIds) {
    await admin.from("gaming_progression_events").delete().eq("match_id", matchId);
    await admin.from("predictions").delete().eq("match_id", matchId);
    const { data: activations } = await admin.from("venue_activations").select("venue_activation_id").eq("match_id", matchId);
    const activationIds = (activations ?? []).map((a) => a.venue_activation_id);
    if (activationIds.length > 0) await admin.from("prize_tiers").delete().in("venue_activation_id", activationIds);
    await admin.from("venue_activations").delete().eq("match_id", matchId);
    await admin.from("matches").delete().eq("match_id", matchId);
  }
  for (const venueId of createdVenueIds) await admin.from("venues").delete().eq("venue_id", venueId);
  for (const teamId of createdTeamIds) {
    await admin.from("players").delete().eq("team_id", teamId);
    await admin.from("teams").delete().eq("team_id", teamId);
  }
  if (createdGamingMemberIds.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", createdGamingMemberIds);
    await admin.from("authority_grants").delete().in("gaming_member_id", createdGamingMemberIds);
    await admin.from("gaming_xp_events").delete().in("gaming_member_id", createdGamingMemberIds);
    await admin.from("experience_summaries").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  for (const authUserId of createdAuthUserIds) await admin.auth.admin.deleteUser(authUserId);
}, 60000);

const FUNCTIONS = [
  "set_match_activity_classification_atomically",
  "set_match_xp_eligibility_atomically",
  "upsert_prediction_atomically",
];
const TABLES = ["matches", "predictions", "players", "teams", "venues", "venue_activations"];

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 30000 });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function realMember(displayName: string, password?: string) {
  const email = `boundary-contract-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, ...(password ? { password } : {}) });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { gamingMemberId: member.gamingMemberId, email };
}

async function world() {
  const finalizer = await realMember("BoundaryFinalizer");
  const { error } = await admin.from("authority_grants").insert({ gaming_member_id: finalizer.gamingMemberId, authority_class: "CONSEQUENTIAL_FINALIZER" });
  if (error) throw error;

  const home = await repo.createTeam({ name: `Madrid ${randomUUID().slice(0, 8)}` });
  const away = await repo.createTeam({ name: `Barca ${randomUUID().slice(0, 8)}` });
  createdTeamIds.push(home.teamId, away.teamId);
  const mbappe = await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" });
  const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Boundary Contract", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
  createdMatchIds.push(match.matchId);
  await repo.setMatchActivityClassification(match.matchId, "TRAINING", finalizer.gamingMemberId, null);
  const venue = await repo.createVenue({ name: "Boundary Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  createdVenueIds.push(venue.venueId);
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
  return { finalizer, home, away, mbappe, match, venue, activation };
}

type World = Awaited<ReturnType<typeof world>>;

/** Arguments that satisfy each function's REAL signature, so a refusal can only be about privilege. */
function functionArgs(w: World, name: string, memberId: string): Record<string, unknown> {
  if (name === "set_match_activity_classification_atomically") {
    return { p_match_id: w.match.matchId, p_activity_classification: "RANKED", p_actor_gaming_member_id: w.finalizer.gamingMemberId, p_reason: "client attempt" };
  }
  if (name === "set_match_xp_eligibility_atomically") {
    return { p_match_id: w.match.matchId, p_xp_eligible: true, p_actor_gaming_member_id: w.finalizer.gamingMemberId, p_reason: "client attempt" };
  }
  return {
    p_match_id: w.match.matchId, p_gaming_member_id: memberId, p_venue_activation_id: w.activation.venueActivationId,
    p_predicted_home_score: 9, p_predicted_away_score: 9, p_predicted_goalscorer_player_id: w.mbappe.playerId,
    p_predicted_goal_minute_regulation: 10, p_predicted_goal_minute_stoppage: null, p_predicted_first_team_to_score: "HOME",
    p_geo_verified_at: new Date().toISOString(), p_measured_distance_meters: 1, p_reported_accuracy_meters: 1, p_geo_eligible: true,
  };
}

const PERMISSION_DENIED = "42501";
function expectDenied(label: string, result: { error: { code?: string; message?: string } | null; data?: unknown }) {
  expect(result.error, `${label}: must be refused`).not.toBeNull();
  expect(result.error!.code, `${label}: ${result.error!.message}`).toBe(PERMISSION_DENIED);
}

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------

describe("Predictions-owned objects — database catalog", () => {
  it("each function has exactly one signature, executable by service_role and by no client role (including PUBLIC)", async () => {
    const functions = await withDb(async (client) => {
      const { rows } = await client.query(
        `select p.proname, p.oid::regprocedure::text as signature,
                has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
                has_function_privilege('service_role', p.oid, 'execute') as service_exec,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])
          order by 1, 2`,
        [FUNCTIONS]
      );
      return rows;
    });
    expect(functions.map((f) => f.proname).sort()).toEqual([...FUNCTIONS].sort()); // one signature each: no overload left behind
    for (const f of functions) {
      expect(f, f.signature).toMatchObject({ anon_exec: false, auth_exec: false, public_exec: false, service_exec: true });
    }
  });

  it("each table has row level security on and no privilege of any kind for anon, authenticated or PUBLIC; service_role keeps full access", async () => {
    const tables = await withDb(async (client) => {
      const { rows } = await client.query(
        `select c.relname, c.relrowsecurity,
                bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger') ) filter (where r.rolname in ('anon','authenticated')) as client_any,
                has_table_privilege('service_role', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'insert')
                  and has_table_privilege('service_role', c.oid, 'update') and has_table_privilege('service_role', c.oid, 'delete') as service_full,
                exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_any,
                (select count(*) from pg_attribute a2 where a2.attrelid = c.oid and a2.attnum > 0 and not a2.attisdropped and a2.attacl is not null) as column_acls
           from pg_class c, pg_roles r
          where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[]) and r.rolname in ('anon','authenticated')
          group by c.oid, c.relname, c.relrowsecurity
          order by 1`,
        [TABLES]
      );
      return rows;
    });
    expect(tables.map((t) => t.relname).sort()).toEqual([...TABLES].sort());
    for (const t of tables) {
      expect(t, t.relname).toMatchObject({ relrowsecurity: true, client_any: false, service_full: true, public_any: false });
      expect(Number(t.column_acls), `${t.relname} column-level grants`).toBe(0);
    }
  });

  it("no function a client role can execute reads or writes these tables (a new one would need a decision)", async () => {
    const offenders = await withDb(async (client) => {
      const { rows } = await client.query(
        `select p.oid::regprocedure::text as signature
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
            and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
            and p.prosrc ~* '\\m(from|join|into|update)\\s+(public\\.)?(matches|predictions|players|teams|venues|venue_activations)\\M'`
      );
      return rows;
    });
    expect(offenders).toEqual([]);
  });

  it("no view or materialized view in public re-exposes them", async () => {
    const views = await withDb(async (client) => {
      const { rows } = await client.query(
        `select c.relname from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
            and pg_get_viewdef(c.oid) ~* '\\m(matches|predictions|players|teams|venues|venue_activations)\\M'`
      );
      return rows;
    });
    expect(views).toEqual([]);
  });

  it("re-applying the migration changes nothing (idempotent) and leaves the same privileges", async () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261021120000_restrict_predictions_server_objects_to_service_role.sql"), "utf8");
    const snapshot = (client: Client) =>
      client.query(
        `select 'f' as kind, p.oid::regprocedure::text as name, coalesce(p.proacl::text, '') as acl
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])
         union all
         select 't', c.relname::text, coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($2::text[])
         order by 1, 2`,
        [FUNCTIONS, TABLES]
      );
    await withDb(async (client) => {
      await client.query("begin");
      try {
        const before = (await snapshot(client)).rows;
        await client.query(sql);
        const after = (await snapshot(client)).rows;
        expect(after).toEqual(before);
      } finally {
        await client.query("rollback");
      }
    });
  });
});

// ---------------------------------------------------------------------
// Real client roles
// ---------------------------------------------------------------------

async function signedInClient(): Promise<{ client: SupabaseClient; memberId: string }> {
  const password = `Pw-${randomUUID()}`;
  const member = await realMember("BoundaryMember", password);
  const client = createClient(supabaseUrl as string, anonKey as string, authOptions);
  const signedIn = await client.auth.signInWithPassword({ email: member.email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
  const authed = createClient(supabaseUrl as string, anonKey as string, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` } },
  });
  return { client: authed, memberId: member.gamingMemberId };
}

describe("Predictions-owned objects — refused to real client roles", () => {
  const roles: Array<{ name: string; make: () => Promise<{ client: SupabaseClient; memberId: string }> }> = [
    { name: "anon (the public key)", make: async () => ({ client: createClient(supabaseUrl as string, anonKey as string, authOptions), memberId: randomUUID() }) },
    { name: "authenticated (a real signed-in member)", make: signedInClient },
  ];

  for (const role of roles) {
    it(`${role.name}: every function is refused for privilege, and the attack has no effect`, async () => {
      const w = await world();
      const { client, memberId } = await role.make();

      for (const name of FUNCTIONS) {
        expectDenied(`${role.name} rpc ${name}`, await client.rpc(name, functionArgs(w, name, memberId)));
      }

      // Nothing changed: still TRAINING, not XP eligible, and no forged prediction exists.
      const match = await repo.getMatchById(w.match.matchId);
      expect(match).toMatchObject({ activityClassification: "TRAINING" });
      expect(match!.xpEligible ?? false).toBe(false);
      expect(await repo.getPredictionForMember(w.match.matchId, memberId)).toBeNull();
    }, 60000);

    it(`${role.name}: every table is refused for select, insert, update and delete, and nothing is read or written`, async () => {
      const w = await world();
      const { client, memberId } = await role.make();

      for (const table of TABLES) {
        expectDenied(`${role.name} select ${table}`, await client.from(table).select("*").limit(1));
        expectDenied(`${role.name} insert ${table}`, await client.from(table).insert({}));
        expectDenied(`${role.name} update ${table}`, await client.from(table).update({}).not("created_at", "is", null));
        expectDenied(`${role.name} delete ${table}`, await client.from(table).delete().not("created_at", "is", null));
      }

      // Concrete attacks: read others' predictions, move the kickoff, shrink the geofence, plant a prediction directly.
      expectDenied("read predictions", await client.from("predictions").select("predicted_home_score").eq("match_id", w.match.matchId));
      expectDenied("move kickoff", await client.from("matches").update({ kickoff_at: new Date(Date.now() + 86400_000).toISOString() }).eq("match_id", w.match.matchId));
      expectDenied("widen the geofence", await client.from("venues").update({ radius_meters: 100000 }).eq("venue_id", w.venue.venueId));
      expectDenied("plant a prediction", await client.from("predictions").insert({
        match_id: w.match.matchId, gaming_member_id: memberId, venue_activation_id: w.activation.venueActivationId,
        predicted_home_score: 1, predicted_away_score: 0, geo_eligible: true,
      }));

      const match = await repo.getMatchById(w.match.matchId);
      expect(new Date(match!.kickoffAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(match!.kickoffAt).getTime()).toBeLessThan(Date.now() + 2 * 3600_000);
      expect((await repo.listVenues()).find((v) => v.venueId === w.venue.venueId)!.radiusMeters).toBe(100);
      expect(await repo.getPredictionForMember(w.match.matchId, memberId)).toBeNull();
    }, 90000);
  }

  it("the self-reported-eligibility bypass in particular: an out-of-radius prediction cannot be planted with geo_eligible = true", async () => {
    const w = await world();
    const { client, memberId } = await signedInClient();
    const forged = await client.rpc("upsert_prediction_atomically", functionArgs(w, "upsert_prediction_atomically", memberId));
    expectDenied("forged eligible prediction", forged);
    const { count } = await admin.from("predictions").select("*", { count: "exact", head: true }).eq("match_id", w.match.matchId);
    expect(count).toBe(0);
  }, 60000);
});

// ---------------------------------------------------------------------
// The server path still works
// ---------------------------------------------------------------------

describe("Predictions-owned objects — the server path (service_role) still works", () => {
  it("admin classification and XP eligibility succeed through the repository (the functions the routes call)", async () => {
    const w = await world();
    await repo.setMatchActivityClassification(w.match.matchId, "RANKED", w.finalizer.gamingMemberId, "Official match");
    await repo.setMatchXpEligibility(w.match.matchId, true, w.finalizer.gamingMemberId, "Official match");
    expect(await repo.getMatchById(w.match.matchId)).toMatchObject({ activityClassification: "RANKED", xpEligible: true });
  }, 60000);

  it("a prediction inside the venue is accepted; the geolocation check still refuses one outside — in the server, not by a client flag", async () => {
    const w = await world();
    const ana = await realMember("BoundaryAna");
    const prediction = {
      matchId: w.match.matchId, venueActivationId: w.activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: w.mbappe.playerId,
      predictedGoalMinuteRegulation: 20, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME" as const,
    };
    const accepted = await submitPrediction(repo, { ...prediction, gamingMemberId: ana.gamingMemberId, geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 } });
    expect(accepted).toBeTruthy();
    expect(await repo.getPredictionForMember(w.match.matchId, ana.gamingMemberId)).toMatchObject({ predictedHomeScore: 1, predictedAwayScore: 0 });

    const bob = await realMember("BoundaryBob");
    await expect(
      submitPrediction(repo, { ...prediction, gamingMemberId: bob.gamingMemberId, geo: { latitude: 11, longitude: 11, accuracyMeters: 5 } })
    ).rejects.toBeInstanceOf(GeoNotEligibleError);
    expect(await repo.getPredictionForMember(w.match.matchId, bob.gamingMemberId)).toBeNull();
  }, 60000);

  it("the public match list and a member's own prediction are still served (the routes read these tables as the server)", async () => {
    const w = await world();
    const ana = await realMember("BoundaryReader");
    await submitPrediction(repo, {
      matchId: w.match.matchId, gamingMemberId: ana.gamingMemberId, venueActivationId: w.activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    expect((await repo.listMatches()).some((m) => m.matchId === w.match.matchId)).toBe(true);
    expect((await repo.listVenues()).some((v) => v.venueId === w.venue.venueId)).toBe(true);
    expect((await repo.listPlayersForTeam(w.home.teamId)).some((p) => p.playerId === w.mbappe.playerId)).toBe(true);
    expect(await repo.getPredictionForMember(w.match.matchId, ana.gamingMemberId)).not.toBeNull();
  }, 60000);
});
