import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { assessLocationEligibility } from "../lib/gaming/communityVoting/eligibility";
import type { OperatorContext, RoundRole, RoundVenue } from "../lib/gaming/communityVoting/rounds/types";
import {
  VENUE,
  candidates,
  castMany,
  contestants,
  expectCode,
  inMs,
  lockRound,
  newPerson,
  openRound,
  pool,
  q,
  rawClient,
  repo,
  serviceKey,
  sessionRepo,
  sleep,
  supabaseUrl,
  voteAs,
  type Person,
  type Reading,
  type Round,
} from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback. The shared fixtures apply the same guard as soon as they load; this explicit call is what the
// contract-registry inventory (requireLocalSupabase.test.ts) requires of every registered contract file, so no file relies on another to be safe.
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-010 — the OPERATOR'S GEOFENCE SETUP and the TEST EVENT. Against REAL local Postgres (isolated loopback stack) and, for the HTTP
 * edge, a REAL local Auth service.
 *
 * THESE TESTS WERE WRITTEN BEFORE THE CHANGE THEY COVER and run first against GATE-009's candidate (their failures are recorded in the
 * implementation record and in the durable evidence folder). What they pin:
 *   - saving the final's venue geofence needs the designated operator AND the Session's host token, applies only to the Instance in the
 *     URL, only to a FINAL, only before the Session has ever opened voting, and leaves attributable evidence (actor, time, old and new);
 *   - a save and the opening serialize on the Session lock: either the save lands before the opening or it is refused after it;
 *   - the Instance stays immutable except for those six columns, by the authorized operation, before opening (privilege AND guard);
 *   - "test my location" runs the SAME evaluator the vote runs, writes nothing and keeps nothing;
 *   - a test event is a separate, fixed-at-creation kind of Instance; no operation turns a real one into a test one or the reverse.
 * Community Voting rows are intentionally undeletable, so nothing here cleans up — discarding the throwaway database is the reset.
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 180_000 });

// =====================================================================================================================
// Fixtures
// =====================================================================================================================

/** Fingerprints (md5 of pg_proc.prosrc) of the functions this change must NOT touch, taken from the clean GATE-009 install. */
const UNTOUCHED_PROSRC_MD5 = {
  cast_community_voting_round_vote_atomically: "893dc0eef8a458ec09b4b35c4d80f318",
  start_community_voting_round_atomically: "33560b85506d9e10fd500b9050e44004",
  community_voting_assess_location: "e1d56106765dbfa3e81f391e2bc1dad8",
  community_voting_authorize_operator: "2f4b0d20923b965eca303e309b2fc212",
  community_voting_log_operator_action: "5463b4c2e5ef40df3e76f4b086a4a31b",
} as const;

const GEOFENCE_COLUMNS = ["venue_latitude", "venue_longitude", "venue_radius_meters", "max_accuracy_meters", "inside_margin_factor", "outside_margin_factor"] as const;
const NEW_VENUE: RoundVenue = { venueLatitude: 14.0987, venueLongitude: -87.2012, venueRadiusMeters: 75, maxAccuracyMeters: 30, insideMarginFactor: 0.5, outsideMarginFactor: 1.5 };
const asColumns = (v: RoundVenue) => ({
  venue_latitude: v.venueLatitude, venue_longitude: v.venueLongitude, venue_radius_meters: v.venueRadiusMeters,
  max_accuracy_meters: v.maxAccuracyMeters, inside_margin_factor: v.insideMarginFactor, outside_margin_factor: v.outsideMarginFactor,
});
const asDetail = (v: RoundVenue) => ({ ...v });

type Registered = Round & { testMode: boolean };

/** A registered round whose test mode is chosen AT REGISTRATION (the only moment it can be). */
async function registerRound(role: RoundRole, opts: { source?: Round; operator?: Person; testMode?: boolean } = {}): Promise<Registered> {
  const session = await createSession(sessionRepo);
  await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
  const operator = opts.operator ?? (await newPerson());
  const instance = await repo.registerRound({
    sessionId: session.sessionId,
    hostToken: session.hostToken,
    operatorMemberId: operator.gamingMemberId as string,
    ruleVersion: 1,
    roundRole: role,
    sourceInstanceId: opts.source ? opts.source.ctx.instanceId : null,
    venue: role === "FINAL" ? VENUE : null,
    windowSeconds: role === "FINAL" ? 300 : null,
    testMode: opts.testMode,
  } as never);
  const ctx: OperatorContext = { instanceId: instance.instanceId, hostToken: session.hostToken, operatorMemberId: operator.gamingMemberId as string };
  const round = { role, session, operator, instance, ctx, started: null as null | Awaited<ReturnType<typeof repo.startRound>>, testMode: opts.testMode === true };
  if (role === "PRELIMINARY") {
    await repo.setRoundSchedule({ ...ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(4 * 3_600_000), status: "TENTATIVE" } });
  }
  return round;
}

/** A closed, cut preliminary and a PREPARED final that descends from it (the lobby is not locked and the final has not opened). */
async function preparedFinal(opts: { testMode?: boolean; operator?: Person } = {}) {
  const operator = opts.operator ?? (await newPerson());
  const p = await registerRound("PRELIMINARY", { operator, testMode: opts.testMode });
  await contestants(p, 3);
  await openRound(p);
  const cands = await candidates(p);
  await castMany(p, cands[0].candidateId, 3);
  await castMany(p, cands[1].candidateId, 2);
  await castMany(p, cands[2].candidateId, 1);
  await repo.closeRound(p.ctx);
  await repo.selectFinalists(p.ctx);
  const f = await registerRound("FINAL", { source: p, operator, testMode: opts.testMode });
  await repo.prepareFinal(f.ctx);
  return { operator, p, f };
}

/** A registered final that has not been prepared: enough for everything about authority, validation, audit and the guard. */
async function bareFinal(opts: { testMode?: boolean; operator?: Person } = {}) {
  const operator = opts.operator ?? (await newPerson());
  const p = await registerRound("PRELIMINARY", { operator, testMode: opts.testMode });
  const f = await registerRound("FINAL", { source: p, operator, testMode: opts.testMode });
  return { operator, p, f };
}

const geofenceRow = async (r: { ctx: OperatorContext }) =>
  (await q(`select ${GEOFENCE_COLUMNS.join(", ")} from community_voting_instances where instance_id = $1`, [r.ctx.instanceId]))[0];
const auditRows = (r: { ctx: OperatorContext }) =>
  q<{ operator_member_id: string; entry_id: string | null; detail: { old: RoundVenue; new: RoundVenue }; occurred_at: string }>(
    "select operator_member_id, entry_id, detail, occurred_at from community_voting_operator_actions where instance_id = $1 and action = 'CONFIGURE_GEOFENCE' order by occurred_at",
    [r.ctx.instanceId]
  );
const configure = (r: { ctx: OperatorContext }, venue: RoundVenue = NEW_VENUE) => (repo as never as { configureFinalGeofence: (i: unknown) => Promise<Record<string, unknown>> }).configureFinalGeofence({ ...r.ctx, venue });
const testReading = (r: { ctx: OperatorContext }, location: Reading) => (repo as never as { testFinalGeofence: (i: unknown) => Promise<Record<string, unknown>> }).testFinalGeofence({ ...r.ctx, location });

const configureSql = (r: { ctx: OperatorContext }, v: unknown[]) => ({
  text: "select * from configure_community_voting_final_geofence_atomically($1, $2, $3, $4::float8, $5::float8, $6::float8, $7::float8, $8::float8, $9::float8)",
  values: [r.ctx.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, ...v],
});

/** Runs ONE statement inside a transaction that is always rolled back, with an optional transaction-local marker; resolves to the error text or null. */
async function attempt(sql: string, params: unknown[], marker?: string): Promise<string | null> {
  const c = await rawClient();
  try {
    await c.query("begin");
    if (marker !== undefined) await c.query("select set_config('urbano.community_voting_geofence', $1, true)", [marker]);
    await c.query(sql, params);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query("rollback").catch(() => undefined);
    await c.end();
  }
}

/**
 * Waits until some backend running a statement that mentions `fragment` is WAITING FOR A LOCK (pg_stat_activity), and says so. A sleep and a promise that has not
 * settled only suggest that a call is blocked behind another; this observes it in the database.
 */
async function waitUntilBlocked(fragment: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const [{ n }] = await q<{ n: string }>(
      "select count(*) n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid() and query ilike $1",
      [`%${fragment}%`]
    );
    if (Number(n) > 0) return;
    if (Date.now() - started > timeoutMs) throw new Error(`no backend running ${fragment} is waiting for a lock after ${timeoutMs} ms`);
    await sleep(50);
  }
}

// =====================================================================================================================
// What this change does not touch
// =====================================================================================================================

describe("untouched protected functions", () => {
  it("the vote, the opening, the evaluator and the operator helpers are byte-for-byte the GATE-009 definitions", async () => {
    for (const [fn, md5] of Object.entries(UNTOUCHED_PROSRC_MD5)) {
      const rows = await q<{ h: string }>("select md5(prosrc) h from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [fn]);
      expect(rows, fn).toHaveLength(1);
      expect(rows[0].h, fn).toBe(md5);
    }
  });
});

// =====================================================================================================================
// A. Who may save the geofence, and for which Instance
// =====================================================================================================================

describe("saving the final's geofence: authority and target", () => {
  it("the designated operator with the Session's host token saves a valid geofence; the stored values are the saved ones and ONE attributable audit row records who, when, old and new", async () => {
    const { f } = await bareFinal();
    const before = Date.now();
    const saved = await configure(f);
    expect(saved).toMatchObject(NEW_VENUE);
    expect(typeof saved.configuredAt).toBe("string");
    expect(await geofenceRow(f)).toEqual(asColumns(NEW_VENUE));
    const audit = await auditRows(f);
    expect(audit).toHaveLength(1);
    expect(audit[0].operator_member_id).toBe(f.operator.gamingMemberId);
    expect(audit[0].detail).toEqual({ old: asDetail(VENUE), new: asDetail(NEW_VENUE) });
    expect(Date.parse(audit[0].occurred_at)).toBeGreaterThan(before - 5_000);
    expect(Date.parse(audit[0].occurred_at)).toBeLessThan(Date.now() + 5_000);
  });

  it("a wrong host token is refused: nothing changes and nothing is recorded", async () => {
    const { f } = await bareFinal();
    await expect(configure({ ctx: { ...f.ctx, hostToken: "x".repeat(32) } })).rejects.toMatchObject({ name: "HostTokenMismatchError" });
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
    expect(await auditRows(f)).toHaveLength(0);
  });

  it("a Gaming Member who is not the designated operator is refused even with the right host token", async () => {
    const { f } = await bareFinal();
    const stranger = await newPerson();
    await expectCode(configure({ ctx: { ...f.ctx, operatorMemberId: stranger.gamingMemberId as string } }), "OPERATOR_REQUIRED");
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
    expect(await auditRows(f)).toHaveLength(0);
  });

  it("the operator of ANOTHER round cannot configure this one, and saving one final never moves a sibling round", async () => {
    const a = await bareFinal();
    const b = await bareFinal();
    await expectCode(configure({ ctx: { ...a.f.ctx, operatorMemberId: b.operator.gamingMemberId as string } }), "OPERATOR_REQUIRED");
    // b's own host token cannot be used on a's Instance
    await expect(configure({ ctx: { ...a.f.ctx, hostToken: b.f.ctx.hostToken } })).rejects.toMatchObject({ name: "HostTokenMismatchError" });
    const untouched = [await geofenceRow(b.f), await geofenceRow(a.p)];
    await configure(a.f);
    expect(await geofenceRow(a.f)).toEqual(asColumns(NEW_VENUE));
    expect([await geofenceRow(b.f), await geofenceRow(a.p)]).toEqual(untouched);
    expect(await auditRows(b.f)).toHaveLength(0);
  });

  it("the PRELIMINARY has no geofence and gets none: the save is refused and it stays free of any venue", async () => {
    const { p } = await bareFinal();
    await expectCode(configure(p), "NOT_A_FINAL");
    const row = await geofenceRow(p);
    expect(Object.values(row)).toEqual([null, null, null, null, null, null]);
    expect(await auditRows(p)).toHaveLength(0);
  });

  it("an unknown Instance id is refused as not found", async () => {
    const { f } = await bareFinal();
    await expectCode(configure({ ctx: { ...f.ctx, instanceId: randomUUID() } }), "INSTANCE_NOT_FOUND");
  });
});

// =====================================================================================================================
// B. Invalid values fail closed
// =====================================================================================================================

describe("saving the final's geofence: invalid values fail closed", () => {
  const BAD: Array<[string, Partial<RoundVenue> | null]> = [
    ["latitude above 90", { venueLatitude: 90.0001 }],
    ["latitude below -90", { venueLatitude: -90.0001 }],
    ["longitude above 180", { venueLongitude: 180.0001 }],
    ["longitude below -180", { venueLongitude: -180.0001 }],
    ["radius zero", { venueRadiusMeters: 0 }],
    ["negative radius", { venueRadiusMeters: -5 }],
    ["radius above the ceiling", { venueRadiusMeters: 100001 }],
    ["accuracy limit zero", { maxAccuracyMeters: 0 }],
    ["accuracy limit above the ceiling", { maxAccuracyMeters: 100001 }],
    ["negative inside margin", { insideMarginFactor: -0.1 }],
    ["inside margin above the ceiling", { insideMarginFactor: 1001 }],
    ["negative outside margin", { outsideMarginFactor: -0.1 }],
    ["outside margin above the ceiling", { outsideMarginFactor: 1001 }],
  ];

  it("each out-of-range value is refused with INVALID_GEOFENCE_CONFIG and changes nothing", async () => {
    const { f } = await bareFinal();
    for (const [label, patch] of BAD) {
      await expectCode(configure(f, { ...NEW_VENUE, ...(patch as object) }), "INVALID_GEOFENCE_CONFIG");
      expect(await geofenceRow(f), label).toEqual(asColumns(VENUE));
    }
    expect(await auditRows(f)).toHaveLength(0);
  });

  it("NaN, Infinity and missing values are refused by the DATABASE itself (not only by the TypeScript layer)", async () => {
    const { f } = await bareFinal();
    const good = [NEW_VENUE.venueLatitude, NEW_VENUE.venueLongitude, NEW_VENUE.venueRadiusMeters, NEW_VENUE.maxAccuracyMeters, NEW_VENUE.insideMarginFactor, NEW_VENUE.outsideMarginFactor];
    const poisons: unknown[] = ["NaN", "Infinity", "-Infinity", null];
    for (let position = 0; position < good.length; position++) {
      for (const poison of poisons) {
        const values = good.slice();
        values[position] = poison as never;
        const query = configureSql(f, values);
        await expect(pool.query(query.text, query.values), `column ${position} = ${String(poison)}`).rejects.toThrow(/CV_INVALID_GEOFENCE_CONFIG/);
      }
    }
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
    expect(await auditRows(f)).toHaveLength(0);
  });
});

// =====================================================================================================================
// C. The freeze: before the final has ever opened, never afterwards
// =====================================================================================================================

describe("the geofence freezes when the final opens and stays frozen", () => {
  it("editable while prepared (any number of times), frozen the moment it opens, and still frozen once closed and published", async () => {
    const { f } = await preparedFinal();
    await configure(f, { ...NEW_VENUE, venueRadiusMeters: 90 });
    await configure(f, { ...NEW_VENUE, venueRadiusMeters: 80 });
    expect((await auditRows(f)).map((a) => a.detail.new.venueRadiusMeters)).toEqual(expect.arrayContaining([90, 80]));

    await openRound(f);
    const [first] = await candidates(f);
    // the vote is judged against the geofence that was SAVED (the new centre), not the one the round was registered with
    await expectCode(voteAs(f, await newPerson(), first.candidateId, { latitude: VENUE.venueLatitude, longitude: VENUE.venueLongitude, accuracyMeters: 10 }), "LOCATION_OUTSIDE");
    await voteAs(f, await newPerson(), first.candidateId, { latitude: NEW_VENUE.venueLatitude, longitude: NEW_VENUE.venueLongitude, accuracyMeters: 10 });
    const atOpening = await geofenceRow(f);
    const auditAtOpening = (await auditRows(f)).length;
    await expectCode(configure(f, { ...NEW_VENUE, venueRadiusMeters: 60 }), "GEOFENCE_FROZEN");
    expect(await geofenceRow(f)).toEqual(atOpening);

    await repo.closeRound(f.ctx);
    await expectCode(configure(f, { ...NEW_VENUE, venueRadiusMeters: 61 }), "GEOFENCE_FROZEN");
    await repo.recordRoundReview(f.ctx);
    await repo.publishRound(f.ctx);
    await expectCode(configure(f, { ...NEW_VENUE, venueRadiusMeters: 62 }), "GEOFENCE_FROZEN");
    expect(await geofenceRow(f)).toEqual(atOpening);
    expect(await auditRows(f)).toHaveLength(auditAtOpening);
  });

  it("the overview tells the operator whether the geofence can still be edited, with the stored values and when they were last saved", async () => {
    const { f } = await preparedFinal();
    const before = (await repo.readRoundOverview(f.ctx)) as never as { geofence: Record<string, unknown> | null };
    expect(before.geofence).toMatchObject({ ...VENUE, editable: true, savedAt: null });
    await configure(f);
    const saved = (await repo.readRoundOverview(f.ctx)) as never as { geofence: Record<string, unknown> };
    expect(saved.geofence).toMatchObject({ ...NEW_VENUE, editable: true });
    expect(typeof saved.geofence.savedAt).toBe("string");
    await openRound(f);
    const opened = (await repo.readRoundOverview(f.ctx)) as never as { geofence: Record<string, unknown> };
    expect(opened.geofence).toMatchObject({ ...NEW_VENUE, editable: false });
  });

  it("the preliminary's overview has no geofence at all", async () => {
    const { p } = await bareFinal();
    expect(((await repo.readRoundOverview(p.ctx)) as never as { geofence: unknown }).geofence).toBeNull();
  });
});

// =====================================================================================================================
// D. A save and the opening serialize on the Session lock
// =====================================================================================================================

describe("a save and the opening serialize", () => {
  const OPEN_SQL = "select * from start_community_voting_round_atomically($1, $2, $3, $4)";

  it("OPENING FIRST: a save that arrives while the opening holds the Session lock waits, then is refused as frozen — the geofence is the one the opening saw", async () => {
    const { f } = await preparedFinal();
    await lockRound(f);
    const a = await rawClient();
    const b = await rawClient();
    try {
      await a.query("begin");
      await a.query(OPEN_SQL, [f.ctx.instanceId, f.ctx.hostToken, f.ctx.operatorMemberId, "Mejor disfraz"]);
      let settled = false;
      const query = configureSql(f, [NEW_VENUE.venueLatitude, NEW_VENUE.venueLongitude, NEW_VENUE.venueRadiusMeters, NEW_VENUE.maxAccuracyMeters, NEW_VENUE.insideMarginFactor, NEW_VENUE.outsideMarginFactor]);
      const save = b.query(query.text, query.values).then(() => "saved", (e: Error) => e.message).finally(() => { settled = true; });
      await waitUntilBlocked("configure_community_voting_final_geofence_atomically");
      expect(settled, "the save must be waiting behind the opening").toBe(false);
      await a.query("commit");
      expect(await save).toContain("CV_GEOFENCE_FROZEN");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
    expect(await auditRows(f)).toHaveLength(0);
    const [{ n }] = await q<{ n: string }>("select count(*) n from interaction_instances where session_id = $1", [f.session.sessionId]);
    expect(Number(n)).toBe(1);
  });

  it("SAVE FIRST: an opening that arrives while a save holds the Session lock waits, then opens with the SAVED geofence — and the geofence is frozen afterwards", async () => {
    const { f } = await preparedFinal();
    await lockRound(f);
    const a = await rawClient();
    const b = await rawClient();
    try {
      await b.query("begin");
      const query = configureSql(f, [NEW_VENUE.venueLatitude, NEW_VENUE.venueLongitude, NEW_VENUE.venueRadiusMeters, NEW_VENUE.maxAccuracyMeters, NEW_VENUE.insideMarginFactor, NEW_VENUE.outsideMarginFactor]);
      await b.query(query.text, query.values);
      let settled = false;
      const opening = a.query(OPEN_SQL, [f.ctx.instanceId, f.ctx.hostToken, f.ctx.operatorMemberId, "Mejor disfraz"]).then(() => "opened", (e: Error) => e.message).finally(() => { settled = true; });
      await waitUntilBlocked("start_community_voting_round_atomically");
      expect(settled, "the opening must be waiting behind the save").toBe(false);
      await b.query("commit");
      expect(await opening).toBe("opened");
    } finally {
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
    expect(await geofenceRow(f)).toEqual(asColumns(NEW_VENUE));
    await expectCode(configure(f, { ...NEW_VENUE, venueRadiusMeters: 55 }), "GEOFENCE_FROZEN");
    expect(await geofenceRow(f)).toEqual(asColumns(NEW_VENUE));
  });

  it("CONCURRENT SAVES serialize: every save is recorded once and the audit rows chain (each old is the previous new) — no lost update", async () => {
    const { f } = await bareFinal();
    const radii = [101, 102, 103, 104, 105, 106];
    const outcomes = await Promise.all(radii.map((radius) => configure(f, { ...NEW_VENUE, venueRadiusMeters: radius }).then(() => "ok", (e: Error) => e.message)));
    expect(outcomes).toEqual(radii.map(() => "ok"));
    const audit = await auditRows(f);
    expect(audit).toHaveLength(radii.length);
    // follow the chain from the registration values to the last save
    const remaining = audit.slice();
    let cursor = VENUE.venueRadiusMeters;
    const order: number[] = [];
    while (remaining.length > 0) {
      const index = remaining.findIndex((a) => a.detail.old.venueRadiusMeters === cursor);
      expect(index, `no audit row continues from radius ${cursor}`).toBeGreaterThanOrEqual(0);
      const [next] = remaining.splice(index, 1);
      cursor = next.detail.new.venueRadiusMeters;
      order.push(cursor);
    }
    expect([...order].sort()).toEqual([...radii].sort());
    expect((await geofenceRow(f)).venue_radius_meters).toBe(cursor);
  });
});

// =====================================================================================================================
// E. The Instance stays immutable except for the six columns, by the authorized operation, before opening
// =====================================================================================================================

describe("the narrow exception in the Instance guard", () => {
  it("service_role may update ONLY the six geofence columns (column privilege), anon and authenticated none; the table-level UPDATE stays revoked", async () => {
    const columns = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'community_voting_instances' order by ordinal_position")).map((c) => c.column_name);
    expect(columns.length).toBeGreaterThan(GEOFENCE_COLUMNS.length);
    const [{ t }] = await q<{ t: boolean }>("select has_table_privilege('service_role', 'community_voting_instances', 'update') t");
    expect(t).toBe(false);
    for (const column of columns) {
      const [{ ok }] = await q<{ ok: boolean }>("select has_column_privilege('service_role', 'community_voting_instances', $1, 'update') ok", [column]);
      expect(ok, `service_role UPDATE on ${column}`).toBe((GEOFENCE_COLUMNS as readonly string[]).includes(column));
      for (const role of ["anon", "authenticated"]) {
        const [{ ok: other }] = await q<{ ok: boolean }>("select has_column_privilege($1, 'community_voting_instances', $2, 'update') ok", [role, column]);
        expect(other, `${role} UPDATE on ${column}`).toBe(false);
      }
    }
  });

  it("without the operation's marker the geofence columns are immutable (even for the database owner); with the marker of ANOTHER Instance they still are", async () => {
    const { f, p } = await bareFinal();
    const sql = "update community_voting_instances set venue_radius_meters = 55 where instance_id = $1";
    expect(await attempt(sql, [f.ctx.instanceId])).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    expect(await attempt(sql, [f.ctx.instanceId], p.ctx.instanceId)).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    expect(await attempt(sql, [f.ctx.instanceId], "")).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    // the sanctioned shape — this Instance's marker, a geofence column, a final that has never opened — is the one thing allowed
    expect(await attempt(sql, [f.ctx.instanceId], f.ctx.instanceId)).toBeNull();
    expect((await geofenceRow(f)).venue_radius_meters).toBe(VENUE.venueRadiusMeters);
  });

  it("with the marker, anything OTHER than the six columns is still refused: identity, Session linkage, round role, source, window, cutoff, creation time and the test flag", async () => {
    const { f, p } = await bareFinal();
    const id = f.ctx.instanceId;
    const cases: Array<[string, string, unknown[]]> = [
      ["rule version", "update community_voting_instances set rule_version = 2 where instance_id = $1", [id]],
      ["session", "update community_voting_instances set session_id = $2 where instance_id = $1", [id, p.session.sessionId]],
      ["operator", "update community_voting_instances set operator_gaming_member_id = $2 where instance_id = $1", [id, (await newPerson()).gamingMemberId]],
      ["source instance", "update community_voting_instances set source_instance_id = null where instance_id = $1", [id]],
      ["window", "update community_voting_instances set window_seconds = 600 where instance_id = $1", [id]],
      ["round role", "update community_voting_instances set round_role = 'PRELIMINARY' where instance_id = $1", [id]],
      ["ballot mode", "update community_voting_instances set ballot_mode = 'SINGLE_CHOICE' where instance_id = $1", [id]],
      ["created at", "update community_voting_instances set created_at = now() where instance_id = $1", [id]],
      ["instance id", "update community_voting_instances set instance_id = $2 where instance_id = $1", [id, randomUUID()]],
      ["test flag (real -> test)", "update community_voting_instances set is_test = true where instance_id = $1", [id]],
      ["a geofence column AND another column together", "update community_voting_instances set venue_radius_meters = 55, rule_version = 2 where instance_id = $1", [id]],
    ];
    for (const [label, sql, params] of cases) {
      expect(await attempt(sql, params, id), label).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE|P0001/);
    }
  });

  it("a PRELIMINARY cannot be given a venue, even with the marker", async () => {
    const { p } = await bareFinal();
    const message = await attempt("update community_voting_instances set venue_latitude = 14, venue_longitude = -87, venue_radius_meters = 50, max_accuracy_meters = 30, inside_margin_factor = 1, outside_margin_factor = 1 where instance_id = $1", [p.ctx.instanceId], p.ctx.instanceId);
    expect(message).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
  });

  it("once the Session has opened, the marker no longer helps: the freeze is structural, not only a check inside the operation", async () => {
    const { f } = await preparedFinal();
    await openRound(f);
    const message = await attempt("update community_voting_instances set venue_radius_meters = 55 where instance_id = $1", [f.ctx.instanceId], f.ctx.instanceId);
    expect(message).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    expect((await geofenceRow(f)).venue_radius_meters).toBe(VENUE.venueRadiusMeters);
  });

  it("a GATE-003 SINGLE_CHOICE Instance (the ordinary one) keeps its absolute immutability, marker or not", async () => {
    const ordinary = await q<{ instance_id: string }>("select instance_id from community_voting_instances where ballot_mode = 'SINGLE_CHOICE' limit 1");
    if (ordinary.length === 0) return; // the clean install of the contract stack has none until the GATE-003 suite ran; that suite owns this guarantee too
    const id = ordinary[0].instance_id;
    expect(await attempt("update community_voting_instances set venue_radius_meters = 55 where instance_id = $1", [id], id)).toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
  });

  it("deleting or truncating Instances and rewriting the audit trail are still refused", async () => {
    const { f } = await bareFinal();
    await configure(f);
    expect(await attempt("delete from community_voting_instances where instance_id = $1", [f.ctx.instanceId])).toMatch(/HISTORY_IMMUTABLE|permission/i);
    expect(await attempt("truncate community_voting_instances cascade", [])).toMatch(/HISTORY_IMMUTABLE|cannot truncate/i);
    expect(await attempt("update community_voting_operator_actions set action = 'SET_SCHEDULE' where instance_id = $1", [f.ctx.instanceId])).toMatch(/HISTORY_IMMUTABLE/);
    expect(await attempt("delete from community_voting_operator_actions where instance_id = $1", [f.ctx.instanceId])).toMatch(/HISTORY_IMMUTABLE/);
  });

  it("through the REST surface with the service key: another column is refused by privilege (42501) and a geofence column by the guard — neither changes", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const service = createClient(supabaseUrl as string, serviceKey as string, { auth: { persistSession: false, autoRefreshToken: false } });
    const { f } = await bareFinal();
    const other = await service.from("community_voting_instances").update({ rule_version: 2 }).eq("instance_id", f.ctx.instanceId);
    expect(other.error?.code).toBe("42501");
    const direct = await service.from("community_voting_instances").update({ venue_radius_meters: 5 }).eq("instance_id", f.ctx.instanceId);
    expect(direct.error?.message ?? "").toMatch(/COMMUNITY_VOTING_HISTORY_IMMUTABLE/);
    const both = await service.from("community_voting_instances").update({ venue_radius_meters: 5, is_test: true }).eq("instance_id", f.ctx.instanceId);
    expect(both.error?.code).toBe("42501");
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
  });
});

describe("privileges of the new functions", () => {
  const NEW_FUNCTIONS = ["configure_community_voting_final_geofence_atomically", "test_community_voting_round_geofence"];

  it("only service_role can execute them; they run with the caller's rights (not security definer); the test one cannot write (STABLE)", async () => {
    for (const fn of NEW_FUNCTIONS) {
      const rows = await q<{ anon: boolean; authed: boolean; svc: boolean; pub: boolean; definer: boolean; volatility: string }>(
        `select has_function_privilege('anon', p.oid, 'execute') anon,
                has_function_privilege('authenticated', p.oid, 'execute') authed,
                has_function_privilege('service_role', p.oid, 'execute') svc,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub,
                p.prosecdef definer, p.provolatile volatility
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
        [fn]
      );
      expect(rows, fn).toHaveLength(1);
      expect(rows[0], fn).toMatchObject({ anon: false, authed: false, svc: true, pub: false, definer: false });
      if (fn.startsWith("test_")) expect(rows[0].volatility).toBe("s");
    }
  });

  it("the audit table accepts the new action and still refuses an unknown one", async () => {
    const [{ def }] = await q<{ def: string }>("select pg_get_constraintdef(oid) def from pg_constraint where conname = 'community_voting_operator_actions_values'");
    expect(def).toContain("CONFIGURE_GEOFENCE");
    expect(def).toContain("OPEN_VOTING");
  });

  it("the set of security-definer functions Community Voting owns did not grow", async () => {
    const definers = await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and proname like '%community_voting%' order by proname");
    expect(definers.map((r) => r.proname)).toEqual([
      "community_voting_email_confirmed",
      "community_voting_event_session_of_interaction",
      "community_voting_scope_of_interaction",
      "community_voting_session_is_event_bound",
    ]);
  });
});

// =====================================================================================================================
// F. "Test my location" is the vote's evaluator, and it stores nothing
// =====================================================================================================================

describe("the eligibility test", () => {
  const READINGS: Array<[string, Reading, "INSIDE" | "OUTSIDE" | "AMBIGUOUS" | "ACCURACY_EXCESSIVE"]> = [
    ["at the centre, precise", { latitude: VENUE.venueLatitude, longitude: VENUE.venueLongitude, accuracyMeters: 10 }, "INSIDE"],
    ["eleven kilometres away", { latitude: 15.6, longitude: VENUE.venueLongitude, accuracyMeters: 10 }, "OUTSIDE"],
    ["on the edge with a wide circle", { latitude: VENUE.venueLatitude + 100 / 111_194.9, longitude: VENUE.venueLongitude, accuracyMeters: 20 }, "AMBIGUOUS"],
    ["too imprecise to decide", { latitude: VENUE.venueLatitude, longitude: VENUE.venueLongitude, accuracyMeters: 80 }, "ACCURACY_EXCESSIVE"],
  ];
  const VOTE_CODE: Record<string, string | null> = { INSIDE: null, OUTSIDE: "LOCATION_OUTSIDE", AMBIGUOUS: "LOCATION_AMBIGUOUS", ACCURACY_EXCESSIVE: "LOCATION_ACCURACY_EXCESSIVE" };

  it("gives the SAME decision the vote gives for the same reading, on the same stored geofence", async () => {
    const { f } = await preparedFinal();
    await openRound(f);
    const [first] = await candidates(f);
    for (const [label, reading, expected] of READINGS) {
      const tested = await testReading(f, reading);
      expect(tested.decision, label).toBe(expected);
      const attemptVote = voteAs(f, await newPerson(), first.candidateId, reading);
      if (VOTE_CODE[expected] === null) await expect(attemptVote, label).resolves.toBeDefined();
      else await expectCode(attemptVote, VOTE_CODE[expected] as string);
    }
  });

  it("agrees with the evaluator called directly on the Instance's own columns, and with the TypeScript twin, across a grid of readings and two configurations", async () => {
    const { f } = await bareFinal();
    for (const venue of [VENUE, NEW_VENUE]) {
      if (venue === NEW_VENUE) await configure(f, NEW_VENUE);
      for (let dLat = -6; dLat <= 6; dLat++) {
        for (const accuracyMeters of [5, 25, 60]) {
          const reading = { latitude: venue.venueLatitude + (dLat * 18) / 111_194.9, longitude: venue.venueLongitude, accuracyMeters };
          const tested = await testReading(f, reading);
          const [direct] = await q<{ decision: string; distance_meters: number }>(
            "select * from community_voting_assess_location($1::float8, $2::float8, $3::float8, $4::float8, $5::float8, $6::float8, $7::float8, $8::float8, $9::float8)",
            [venue.venueLatitude, venue.venueLongitude, venue.venueRadiusMeters, venue.maxAccuracyMeters, venue.insideMarginFactor, venue.outsideMarginFactor, reading.latitude, reading.longitude, reading.accuracyMeters]
          );
          const twin = assessLocationEligibility(reading, venue);
          expect(tested.decision).toBe(direct.decision);
          expect(tested.decision).toBe(twin.decision);
          expect(Math.abs(Number(tested.distanceMeters) - direct.distance_meters)).toBeLessThan(0.06);
        }
      }
    }
  });

  it("returns the thresholds it used, and answers before AND after the final opens (it never depends on the lifecycle)", async () => {
    const { f } = await preparedFinal();
    const reading = { latitude: VENUE.venueLatitude, longitude: VENUE.venueLongitude, accuracyMeters: 12.34 };
    const before = await testReading(f, reading);
    expect(before).toMatchObject({ decision: "INSIDE", radiusMeters: VENUE.venueRadiusMeters, maxAccuracyMeters: VENUE.maxAccuracyMeters, accuracyMeters: 12.3 });
    await openRound(f);
    expect((await testReading(f, reading)).decision).toBe("INSIDE");
  });

  it("an invalid reading is refused exactly as a vote would refuse it (never a decision)", async () => {
    const { f } = await bareFinal();
    const bad: Array<[string, unknown[]]> = [
      ["no accuracy", [VENUE.venueLatitude, VENUE.venueLongitude, null]],
      ["zero accuracy", [VENUE.venueLatitude, VENUE.venueLongitude, 0]],
      ["negative accuracy", [VENUE.venueLatitude, VENUE.venueLongitude, -3]],
      ["latitude out of range", [91, VENUE.venueLongitude, 10]],
      ["NaN latitude", ["NaN", VENUE.venueLongitude, 10]],
      ["infinite accuracy", [VENUE.venueLatitude, VENUE.venueLongitude, "Infinity"]],
      ["the null island reading", [0, 0, 10]],
    ];
    for (const [label, values] of bad) {
      await expect(
        pool.query("select * from test_community_voting_round_geofence($1, $2, $3, $4::float8, $5::float8, $6::float8)", [f.ctx.instanceId, f.ctx.hostToken, f.ctx.operatorMemberId, ...values]),
        label
      ).rejects.toThrow(/CV_INVALID_LOCATION_READING/);
    }
  });

  it("needs the designated operator and the host token, and applies to a final only", async () => {
    const { f, p } = await bareFinal();
    const reading = { latitude: VENUE.venueLatitude, longitude: VENUE.venueLongitude, accuracyMeters: 10 };
    await expect(testReading({ ctx: { ...f.ctx, hostToken: "x".repeat(32) } }, reading)).rejects.toMatchObject({ name: "HostTokenMismatchError" });
    await expectCode(testReading({ ctx: { ...f.ctx, operatorMemberId: (await newPerson()).gamingMemberId as string } }, reading), "OPERATOR_REQUIRED");
    await expectCode(testReading(p, reading), "NOT_A_FINAL");
  });

  it("creates NOTHING: no vote, no intent, no binding, no audit row, no event, no row in any Community Voting table — and keeps no trace of the reading", async () => {
    const { f } = await preparedFinal();
    await openRound(f);
    const tables = (
      await q<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
           and (table_name like 'community_voting\\_%' or table_name in ('votes', 'participants', 'session_events', 'interaction_instances', 'sessions', 'voting_candidates'))
         order by 1`
      )
    ).map((t) => t.table_name);
    const snapshot = async () => {
      const out: Record<string, number> = {};
      for (const table of tables) out[table] = Number((await q<{ n: string }>(`select count(*) n from ${table}`))[0].n);
      return out;
    };
    const before = await snapshot();
    const reading = { latitude: 15.123456789, longitude: -88.987654321, accuracyMeters: 7.65432109 };
    for (let i = 0; i < 5; i++) await testReading(f, reading);
    expect(await snapshot()).toEqual(before);
    for (const table of tables) {
      const [{ n }] = await q<{ n: string }>(`select count(*) n from ${table} where ${table}::text like any (array['%123456789%', '%987654321%', '%65432109%'])`);
      expect(Number(n), `${table} must not contain the reading`).toBe(0);
    }
  });

  it("is implemented on the vote's own evaluator (the source calls community_voting_assess_location, as the cast does)", async () => {
    const rows = await q<{ proname: string; src: string }>(
      "select proname, prosrc src from pg_proc where pronamespace = 'public'::regnamespace and proname in ('test_community_voting_round_geofence', 'cast_community_voting_round_vote_atomically')"
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.src, row.proname).toMatch(/community_voting_assess_location\s*\(/);
  });
});

// =====================================================================================================================
// G. Test events
// =====================================================================================================================

describe("test events", () => {
  it("a round is a TEST round only if it was registered as one; the default is a real round", async () => {
    const real = await bareFinal();
    const test = await bareFinal({ testMode: true });
    expect(real.f.instance).toMatchObject({ isTest: false });
    expect(test.f.instance).toMatchObject({ isTest: true });
    expect(test.p.instance).toMatchObject({ isTest: true });
    const rows = await q<{ instance_id: string; is_test: boolean }>("select instance_id, is_test from community_voting_instances where instance_id = any($1)", [[real.f.ctx.instanceId, real.p.ctx.instanceId, test.f.ctx.instanceId, test.p.ctx.instanceId]]);
    expect(Object.fromEntries(rows.map((r) => [r.instance_id, r.is_test]))).toEqual({
      [real.f.ctx.instanceId]: false, [real.p.ctx.instanceId]: false, [test.f.ctx.instanceId]: true, [test.p.ctx.instanceId]: true,
    });
  });

  it("the flag is public (so the voter and display pages can label the event) and operator-visible, and nothing else about the venue becomes public", async () => {
    const test = await bareFinal({ testMode: true });
    const real = await bareFinal();
    expect(await repo.readRoundPublicInfo(test.f.ctx.instanceId)).toMatchObject({ isTest: true });
    expect(await repo.readRoundPublicInfo(real.f.ctx.instanceId)).toMatchObject({ isTest: false });
    expect(await repo.readRoundOverview(test.f.ctx)).toMatchObject({ isTest: true });
    expect(await repo.readRoundOverview(real.p.ctx)).toMatchObject({ isTest: false });
    expect(JSON.stringify(await repo.readRoundPublicInfo(test.f.ctx.instanceId))).not.toMatch(/venue|latitude|longitude/i);
  });

  it("the flag is fixed at creation: no operation, direct update or marker turns a real round into a test round or the reverse", async () => {
    const real = await bareFinal();
    const test = await bareFinal({ testMode: true });
    expect(await attempt("update community_voting_instances set is_test = true where instance_id = $1", [real.f.ctx.instanceId])).toMatch(/HISTORY_IMMUTABLE/);
    expect(await attempt("update community_voting_instances set is_test = false where instance_id = $1", [test.f.ctx.instanceId])).toMatch(/HISTORY_IMMUTABLE/);
    expect(await attempt("update community_voting_instances set is_test = true where instance_id = $1", [real.f.ctx.instanceId], real.f.ctx.instanceId)).toMatch(/HISTORY_IMMUTABLE/);
    expect(await attempt("update community_voting_instances set is_test = false where instance_id = $1", [test.f.ctx.instanceId], test.f.ctx.instanceId)).toMatch(/HISTORY_IMMUTABLE/);
    // saving a geofence on a test round leaves it a test round
    await configure(test.f);
    expect(await repo.readRoundPublicInfo(test.f.ctx.instanceId)).toMatchObject({ isTest: true });
  });

  it("only the registration function ever writes the flag: no other function's source mentions it, apart from the two readers and the pairing guard (the update guard protects it without naming it)", async () => {
    const rows = await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'is_test' order by proname");
    expect(rows.map((r) => r.proname)).toEqual([
      "community_voting_guard_instance_insert",
      "read_community_voting_round_overview",
      "read_community_voting_round_public_info",
      "register_community_voting_round_atomically",
    ]);
  });

  it("a test final can only descend from a test preliminary, and a real final from a real one (the pairing is a table guard)", async () => {
    const operator = await newPerson();
    const realPre = await registerRound("PRELIMINARY", { operator });
    const testPre = await registerRound("PRELIMINARY", { operator, testMode: true });
    await expectCode(registerRound("FINAL", { source: realPre, operator, testMode: true }), "TEST_MODE_MISMATCH");
    await expectCode(registerRound("FINAL", { source: testPre, operator }), "TEST_MODE_MISMATCH");
    const okTest = await registerRound("FINAL", { source: testPre, operator, testMode: true });
    const okReal = await registerRound("FINAL", { source: realPre, operator });
    expect([okTest.instance.isTest, okReal.instance.isTest]).toEqual([true, false]);
  });

  it("a test event has its own Session and Instance, and one Session never holds two Instances (so a test and a real round never share an identifier)", async () => {
    const test = await bareFinal({ testMode: true });
    const real = await bareFinal();
    expect(new Set([test.f.ctx.instanceId, real.f.ctx.instanceId, test.f.session.sessionId, real.f.session.sessionId]).size).toBe(4);
    await expectCode(
      repo.registerRound({
        sessionId: test.f.session.sessionId, hostToken: test.f.session.hostToken, operatorMemberId: test.operator.gamingMemberId as string,
        ruleVersion: 1, roundRole: "PRELIMINARY", sourceInstanceId: null, venue: null, windowSeconds: null,
      } as never),
      "INSTANCE_ALREADY_REGISTERED"
    );
  });

  it("a test round never opens or publishes by itself, and its registration is audited as a test", async () => {
    const test = await bareFinal({ testMode: true });
    const [{ n }] = await q<{ n: string }>("select count(*) n from interaction_instances where session_id = $1", [test.f.session.sessionId]);
    expect(Number(n)).toBe(0);
    const [{ detail }] = await q<{ detail: Record<string, unknown> }>("select detail from community_voting_operator_actions where instance_id = $1 and action = 'REGISTER_INSTANCE'", [test.f.ctx.instanceId]);
    expect(detail).toMatchObject({ isTest: true });
  });

  it("no test round shares anything with the real event: two separate rehearsals of the same kind cannot see each other's records", async () => {
    const a = await bareFinal({ testMode: true });
    const b = await bareFinal({ testMode: true });
    await configure(a.f);
    expect(await geofenceRow(b.f)).toEqual(asColumns(VENUE));
    expect(await auditRows(b.f)).toHaveLength(0);
  });
});

// =====================================================================================================================
// H. The HTTP edge (real Auth tokens, the real route handlers)
// =====================================================================================================================

describe("HTTP edge", () => {
  const ROUTES = "../app/api/gaming/community-voting/rounds";
  // loaded lazily so a missing route file fails ITS tests instead of the whole file
  const route = async (path: string) => import(/* @vite-ignore */ `${ROUTES}/${path}`);
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    if (saved.ops === undefined) delete process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
    else process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = saved.ops;
    vi.restoreAllMocks();
  });

  type Handler = (req: Request, ctx: never) => Promise<Response>;
  async function call(handler: Handler, params: Record<string, string>, init: { method: string; headers?: Record<string, string>; body?: unknown }) {
    const request = new Request("http://localhost/api/test", {
      method: init.method,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const response = await handler(request, { params } as never);
    const text = await response.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text || "{}"); } catch { json = {}; }
    return { status: response.status, headers: response.headers, json, text };
  }

  async function realOperator() {
    const { createClient } = await import("@supabase/supabase-js");
    const anonKey = process.env.SUPABASE_ANON_KEY as string;
    const service = createClient(supabaseUrl as string, serviceKey as string, { auth: { persistSession: false, autoRefreshToken: false } });
    const anon = createClient(supabaseUrl as string, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const password = `Pw-${randomUUID()}`;
    const email = `geofence-route-${randomUUID()}@example.invalid`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user not created");
    const signedIn = await anon.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
    const [member] = await q<{ gaming_member_id: string }>("insert into gaming_members (auth_user_id, display_name) values ($1, 'Synthetic') returning gaming_member_id", [created.data.user.id]);
    return { authUserId: created.data.user.id, gamingMemberId: member.gaming_member_id, bearer: `Bearer ${signedIn.data.session.access_token}` } as Person & { bearer: string };
  }

  const headers = (r: Registered, bearer: string, host: string = r.ctx.hostToken) => ({ authorization: bearer, "x-host-token": host });

  it("PUT .../operator/geofence: the operator saves; the response is no-store, carries the saved values and no token or identity", async () => {
    const op = await realOperator();
    const { f } = await bareFinal({ operator: op });
    const { PUT } = await route("[instanceId]/operator/geofence/route");
    const res = await call(PUT, { instanceId: f.ctx.instanceId }, { method: "PUT", headers: headers(f, op.bearer), body: { venue: NEW_VENUE } });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.geofence).toMatchObject(NEW_VENUE);
    expect(res.text).not.toContain(f.ctx.hostToken);
    expect(res.text).not.toContain(op.authUserId);
    expect(await geofenceRow(f)).toEqual(asColumns(NEW_VENUE));
  });

  it("PUT refuses: no bearer 401, no host token 401, a member who is not the operator 403, a bad host token 403, invalid values 400, an opened final 409 — each leaving the geofence alone", async () => {
    const op = await realOperator();
    const stranger = await realOperator();
    const { f } = await preparedFinal({ operator: op });
    const { PUT } = await route("[instanceId]/operator/geofence/route");
    const url = { instanceId: f.ctx.instanceId };
    expect((await call(PUT, url, { method: "PUT", headers: { "x-host-token": f.ctx.hostToken }, body: { venue: NEW_VENUE } })).status).toBe(401);
    expect((await call(PUT, url, { method: "PUT", headers: { authorization: op.bearer }, body: { venue: NEW_VENUE } })).status).toBe(401);
    expect((await call(PUT, url, { method: "PUT", headers: headers(f, stranger.bearer), body: { venue: NEW_VENUE } })).status).toBe(403);
    expect((await call(PUT, url, { method: "PUT", headers: headers(f, op.bearer, "x".repeat(32)), body: { venue: NEW_VENUE } })).status).toBe(403);
    for (const venue of [{ ...NEW_VENUE, venueRadiusMeters: 0 }, { ...NEW_VENUE, venueLatitude: "14.1" }, { ...NEW_VENUE, maxAccuracyMeters: null }, {}, null]) {
      const res = await call(PUT, url, { method: "PUT", headers: headers(f, op.bearer), body: { venue } });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("INVALID_GEOFENCE_CONFIG");
    }
    expect((await call(PUT, url, { method: "PUT", headers: headers(f, op.bearer), body: "not json" as never })).status).toBe(400);
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
    await openRound(f);
    const frozen = await call(PUT, url, { method: "PUT", headers: headers(f, op.bearer), body: { venue: NEW_VENUE } });
    expect(frozen.status).toBe(409);
    expect(frozen.json.code).toBe("GEOFENCE_FROZEN");
    expect(await geofenceRow(f)).toEqual(asColumns(VENUE));
  });

  it("PUT applies to the Instance in the URL only: an instance id, a session id or a test flag in the body is ignored", async () => {
    const op = await realOperator();
    const a = await bareFinal({ operator: op });
    const b = await bareFinal({ operator: op });
    const { PUT } = await route("[instanceId]/operator/geofence/route");
    const res = await call(PUT, { instanceId: a.f.ctx.instanceId }, {
      method: "PUT", headers: headers(a.f, op.bearer),
      body: { venue: NEW_VENUE, instanceId: b.f.ctx.instanceId, sessionId: b.f.session.sessionId, isTest: true, testMode: true, operatorMemberId: randomUUID() },
    });
    expect(res.status, res.text).toBe(200);
    expect(await geofenceRow(a.f)).toEqual(asColumns(NEW_VENUE));
    expect(await geofenceRow(b.f)).toEqual(asColumns(VENUE));
    expect(await repo.readRoundPublicInfo(a.f.ctx.instanceId)).toMatchObject({ isTest: false });
  });

  it("POST .../operator/geofence/test: answers with the decision and the distance, is no-store, writes nothing, echoes no coordinate and logs nothing", async () => {
    const op = await realOperator();
    const { f } = await bareFinal({ operator: op });
    const { POST } = await route("[instanceId]/operator/geofence/test/route");
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const before = (await q<{ n: string }>("select count(*) n from community_voting_operator_actions"))[0].n;
    const res = await call(POST, { instanceId: f.ctx.instanceId }, {
      method: "POST", headers: headers(f, op.bearer), body: { location: { latitude: 15.123456789, longitude: -88.987654321, accuracyMeters: 7.654321 } },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.test).toMatchObject({ decision: "OUTSIDE", radiusMeters: VENUE.venueRadiusMeters, maxAccuracyMeters: VENUE.maxAccuracyMeters });
    expect(typeof res.json.test.distanceMeters).toBe("number");
    expect(res.text).not.toMatch(/123456789|987654321/);
    expect((await q<{ n: string }>("select count(*) n from community_voting_operator_actions"))[0].n).toBe(before);
    for (const spy of spies) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(/123456789|987654321/);
  });

  it("POST test refuses what a vote would refuse: invalid readings 400 INVALID_LOCATION_READING (never a decision), no credentials 401, a stranger 403", async () => {
    const op = await realOperator();
    const stranger = await realOperator();
    const { f } = await bareFinal({ operator: op });
    const { POST } = await route("[instanceId]/operator/geofence/test/route");
    const url = { instanceId: f.ctx.instanceId };
    for (const location of [null, {}, { latitude: 15.5 }, { latitude: 91, longitude: 0.5, accuracyMeters: 5 }, { latitude: 15.5, longitude: -88, accuracyMeters: 0 }, { latitude: 0, longitude: 0, accuracyMeters: 5 }, { latitude: "15.5", longitude: -88, accuracyMeters: 5 }]) {
      const res = await call(POST, url, { method: "POST", headers: headers(f, op.bearer), body: { location } });
      expect(res.status, JSON.stringify(location)).toBe(400);
      expect(res.json.code).toBe("INVALID_LOCATION_READING");
    }
    expect((await call(POST, url, { method: "POST", headers: { "x-host-token": f.ctx.hostToken }, body: { location: { latitude: 15.5, longitude: -88, accuracyMeters: 5 } } })).status).toBe(401);
    expect((await call(POST, url, { method: "POST", headers: headers(f, stranger.bearer), body: { location: { latitude: 15.5, longitude: -88, accuracyMeters: 5 } } })).status).toBe(403);
  });

  it("registration through the route accepts testMode (only a boolean), reports it, and the public info route labels the event", async () => {
    const op = await realOperator();
    process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = op.gamingMemberId as string;
    saved.ops = undefined;
    const { POST: register } = await route("route");
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const bad = await call(register, {}, { method: "POST", headers: { authorization: op.bearer, "x-host-token": session.hostToken }, body: { sessionId: session.sessionId, roundRole: "PRELIMINARY", testMode: "yes" } });
    expect(bad.status).toBe(400);
    const ok = await call(register, {}, { method: "POST", headers: { authorization: op.bearer, "x-host-token": session.hostToken }, body: { sessionId: session.sessionId, roundRole: "PRELIMINARY", testMode: true } });
    expect(ok.status).toBe(201);
    expect(ok.json.instance.isTest).toBe(true);
    const { GET: info } = await route("[instanceId]/info/route");
    const publicInfo = await call(info, { instanceId: ok.json.instance.instanceId }, { method: "GET" });
    expect(publicInfo.status).toBe(200);
    expect(publicInfo.json.info.isTest).toBe(true);
    const { GET: overview } = await route("[instanceId]/operator/overview/route");
    const ov = await call(overview, { instanceId: ok.json.instance.instanceId }, { method: "GET", headers: { authorization: op.bearer, "x-host-token": session.hostToken } });
    expect(ov.status).toBe(200);
    expect(ov.json.isTest).toBe(true);
  });
});
