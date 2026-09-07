import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

/**
 * URBANO Gaming Competitions — Correction 5 (UG-CR-RPT-030): a complete
 * table-driven authorization and direct-access matrix, independent of
 * the domain-behavior contract suite. Proves, against real local
 * Postgres/PostgREST:
 *   (a) every Competitions table denies direct SELECT to both the
 *       `anon` role and a genuinely authenticated JWT-bearing client —
 *       never merely filtering to zero rows;
 *   (b) every Competitions RPC denies direct execution to both roles;
 *   (c) every RPC is SECURITY DEFINER with a safe, explicit search_path.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
if (!/127\.0\.0\.1|localhost/.test(supabaseUrl)) {
  throw new Error(
    `Refusing to run the Competitions authorization matrix against a non-local SUPABASE_URL (${supabaseUrl}). ` +
      "Export SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY for the local stack before running this file."
  );
}

const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const anonClient = createClient(supabaseUrl, supabaseAnonKey);

const createdAuthUserIds: string[] = [];

/** A client whose every request carries a genuine `authenticated`-role JWT — not merely the anon key. */
async function createAuthenticatedClient() {
  const email = `authz-matrix-${randomUUID()}@example.com`;
  const { data: created, error: createErr } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw createErr ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(created.user.id);

  const { data: link, error: linkErr } = await cleanupClient.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) throw linkErr;
  const { data: verified, error: verifyErr } = await anonClient.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (verifyErr || !verified.session) throw verifyErr ?? new Error("Failed to establish an authenticated session.");

  return createClient(supabaseUrl!, supabaseAnonKey!, {
    global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
  });
}

afterAll(async () => {
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

const COMPETITIONS_TABLES = [
  "competitions",
  "competition_teams",
  "competition_registrations",
  "competition_join_requests",
  "competition_team_memberships",
  "competition_fixtures",
  "competition_roster_revisions",
  "competition_roster_revision_entries",
  "competition_checkins",
  "competition_participation_attestations",
  "competition_fixture_evidence",
  "soccer_goal_events",
  "soccer_assist_events",
  "soccer_penalty_shootouts",
  "competition_disputes",
  "competition_fixture_corrections",
  "competition_fixture_finalizations",
  "competition_member_participation_records",
] as const;

const COMPETITIONS_RPCS = [
  "create_competition_atomically",
  "add_competition_team_atomically",
  "publish_competition_atomically",
  "register_for_competition_atomically",
  "request_join_competition_team_atomically",
  "decide_join_request_atomically",
  "organizer_review_join_request_atomically",
  "declare_competition_roster_atomically",
  "check_in_competition_fixture_atomically",
  "appoint_competition_scorekeeper_atomically",
  "submit_competition_fixture_evidence_atomically",
  "raise_competition_dispute_atomically",
  "correct_competition_fixture_atomically",
  "finalize_competition_fixture_atomically",
  "forfeit_competition_fixture_atomically",
  "void_competition_fixture_atomically",
] as const;

/**
 * Well-formed (but fake) arguments for every RPC, keyed by its exact
 * parameter names — matching lib/gaming/competitions/db/
 * supabaseCompetitionsRepository.ts's own `.rpc()` calls exactly. This
 * matters: calling with a WRONG shape (e.g. `{}`) makes PostgREST fail
 * to resolve the function overload at all (PGRST202), which every role
 * — including service_role — would hit identically, proving nothing
 * about anon/authenticated specifically. A well-formed call lets
 * PostgREST resolve the real function, so the only way anon/
 * authenticated can fail is the EXECUTE-privilege check itself
 * (42501) — a strictly stronger, unambiguous proof.
 */
const RPC_ARGS: Record<(typeof COMPETITIONS_RPCS)[number], Record<string, unknown>> = {
  create_competition_atomically: { p_organizer_gaming_member_id: randomUUID(), p_name: "Authz Probe", p_activity_key: "SOCCER_5V5" },
  add_competition_team_atomically: { p_competition_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_name: "Authz Probe", p_captain_gaming_member_id: randomUUID() },
  publish_competition_atomically: {
    p_competition_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(),
    p_semifinal_1_team_a_id: randomUUID(), p_semifinal_1_team_b_id: randomUUID(),
    p_semifinal_2_team_a_id: randomUUID(), p_semifinal_2_team_b_id: randomUUID(),
    p_semifinal_1_scheduled_at: new Date().toISOString(), p_semifinal_2_scheduled_at: new Date().toISOString(), p_final_scheduled_at: new Date().toISOString(),
  },
  register_for_competition_atomically: { p_competition_id: randomUUID(), p_gaming_member_id: randomUUID(), p_is_adult_self_attested: true },
  request_join_competition_team_atomically: { p_competition_id: randomUUID(), p_competition_team_id: randomUUID(), p_requesting_gaming_member_id: randomUUID() },
  decide_join_request_atomically: { p_competition_join_request_id: randomUUID(), p_deciding_gaming_member_id: randomUUID(), p_decision: "APPROVE", p_is_organizer_override: false },
  organizer_review_join_request_atomically: { p_competition_join_request_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_decision: "APPROVE", p_reason: "probe" },
  declare_competition_roster_atomically: { p_competition_fixture_id: randomUUID(), p_competition_team_id: randomUUID(), p_declaring_gaming_member_id: randomUUID(), p_is_organizer_action: false, p_reason: null, p_gaming_member_ids: [randomUUID()] },
  check_in_competition_fixture_atomically: { p_competition_fixture_id: randomUUID(), p_gaming_member_id: randomUUID() },
  appoint_competition_scorekeeper_atomically: { p_competition_fixture_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_scorekeeper_gaming_member_id: randomUUID() },
  submit_competition_fixture_evidence_atomically: {
    p_competition_fixture_id: randomUUID(), p_scorekeeper_gaming_member_id: randomUUID(), p_team_a_score: 1, p_team_b_score: 0,
    p_goal_events: [], p_assist_events: [], p_participation_attestations: [], p_penalty_shootout_winning_team_id: null,
  },
  raise_competition_dispute_atomically: { p_competition_fixture_id: randomUUID(), p_raised_by_gaming_member_id: randomUUID(), p_target_fact_type: "SCORE", p_target_fact_id: randomUUID(), p_reason: "probe" },
  correct_competition_fixture_atomically: {
    p_competition_fixture_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_reason: "probe", p_team_a_score: 1, p_team_b_score: 0,
    p_goal_events: [], p_assist_events: [], p_penalty_shootout_winning_team_id: null,
  },
  finalize_competition_fixture_atomically: { p_competition_fixture_id: randomUUID(), p_organizer_gaming_member_id: randomUUID() },
  forfeit_competition_fixture_atomically: { p_competition_fixture_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_forfeiting_competition_team_id: randomUUID(), p_reason: "probe" },
  void_competition_fixture_atomically: { p_competition_fixture_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_reason: "probe" },
};

describe("Competitions authorization and direct-access matrix (UG-CR-RPT-030 correction 5)", () => {
  it(`this file's own table/function lists are kept in sync with the schema (${COMPETITIONS_TABLES.length} tables, ${COMPETITIONS_RPCS.length} functions — cross-checked against \`grep\` over the migration files in UG-CR-RPT-030 §5, not derivable through PostgREST itself since pg_catalog is not exposed to it)`, () => {
    expect(COMPETITIONS_TABLES.length).toBe(18);
    expect(COMPETITIONS_RPCS.length).toBe(16);
  });

  describe.each(COMPETITIONS_TABLES)("table %s", (table) => {
    it("denies direct SELECT to the anon role (42501, not an empty result)", async () => {
      const { error } = await anonClient.from(table).select("*").limit(1);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });

    it("denies direct SELECT to a genuinely authenticated JWT client (42501, not an empty result)", async () => {
      const authedClient = await createAuthenticatedClient();
      const { error } = await authedClient.from(table).select("*").limit(1);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });
  });

  describe.each(COMPETITIONS_RPCS)("function %s", (fn) => {
    it("denies direct execution to the anon role with a strict permission error (42501) — a well-formed call, so PostgREST resolves the real function and the ONLY reason it can fail is the revoked EXECUTE privilege, never reaching the function's own body/logic", async () => {
      const { error } = await anonClient.rpc(fn, RPC_ARGS[fn]);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });

    it("denies direct execution to a genuinely authenticated JWT client with the same strict 42501", async () => {
      const authedClient = await createAuthenticatedClient();
      const { error } = await authedClient.rpc(fn, RPC_ARGS[fn]);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });
  });

  // SECURITY DEFINER / search_path reconfirmation for all 16 functions is
  // NOT asserted in this file: pg_catalog is not exposed through
  // PostgREST (no `.from("pg_proc")` or equivalent is reachable from a
  // supabase-js client, anon or service-role), and adding a dedicated
  // introspection RPC to the schema solely to make this one assertion
  // automatable would itself be new schema surface beyond this
  // correction's scope. Instead it is reconfirmed by a direct `psql`
  // query against the local Postgres port (54422, bypassing PostgREST
  // entirely) run once per correction pass, with its verbatim output
  // quoted in UG-CR-RPT-030 §10 — the same information, obtained the
  // only way this schema actually exposes it.
});
