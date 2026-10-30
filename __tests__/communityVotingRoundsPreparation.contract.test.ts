import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HostTokenMismatchError } from "../lib/session/types";
import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import { GALLERY_CONSENT_SHA256, GALLERY_CONSENT_VERSION } from "../lib/gaming/communityVoting/rounds/constants";
import type { OperatorContext } from "../lib/gaming/communityVoting/rounds/types";
import {
  approvedEntry,
  contestant,
  expectCode,
  expectDbError,
  jpeg,
  lockRound,
  newPerson,
  newRound,
  openRound,
  photoArgs,
  pool,
  q,
  rawClient,
  repo,
  serviceKey,
  sessionRepo,
  sleep,
  supabaseUrl,
} from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback. The shared fixtures apply the same guard as soon as they load; this explicit call is what the
// contract-registry inventory (requireLocalSupabase.test.ts) requires of every registered contract file, so no file relies on another to be safe.
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-005 / 005A — the preparation of a round, against REAL local Postgres (isolated loopback stack).
 *
 * These are the assertions of the superseded five-option suite that describe functionality the pilot KEEPS — contestant numbers and claim
 * credentials, photographs, consent, the operator's decision, the contestant's association, the atomic open, operator authority and audit,
 * grants and privacy — carried over to the pilot's own functions. What described the five-option ballot, the telephone steps, the weighted
 * results or a retention clock is NOT carried over: it no longer exists (see the implementation record's disposition table).
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 120_000 });

const anonKey = process.env.SUPABASE_ANON_KEY;
if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required.");
const anon = createClient(supabaseUrl as string, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
void serviceKey;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const consentArgs = { consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256, ageConfirmed: true };

const PILOT_TABLES = [
  "community_voting_closures", "community_voting_entry_consents", "community_voting_entry_photos", "community_voting_finalist_selections",
  "community_voting_finalists", "community_voting_followup_tasks", "community_voting_operator_actions", "community_voting_photo_decisions",
  "community_voting_photo_privacy_actions", "community_voting_policy_approvals", "community_voting_promo_consents", "community_voting_publications",
  "community_voting_published_results", "community_voting_round_reviews", "community_voting_schedules", "community_voting_withdrawals",
];

// ============================================================ schema and grants

describe("the pilot's schema and database grants", () => {
  it("enables RLS with no policies on every pilot table and gives anon and authenticated NO privilege on any of them", async () => {
    for (const table of PILOT_TABLES) {
      const [row] = await q<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [table]);
      expect(row?.relrowsecurity, table).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const [{ ok }] = await q<{ ok: boolean }>("select has_table_privilege($1, $2::regclass, $3) ok", [role, `public.${table}`, privilege]);
          expect(ok, `${role} ${privilege} on ${table}`).toBe(false);
        }
      }
    }
    expect(await q("select 1 from pg_policies where tablename like 'community_voting%'")).toHaveLength(0);
  });

  it("denies service_role every privilege that would rewrite an append-only record (history is changed by nothing)", async () => {
    const appendOnly = PILOT_TABLES.filter((t) => !["community_voting_entry_photos", "community_voting_schedules", "community_voting_followup_tasks"].includes(t));
    for (const table of appendOnly) {
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const [{ ok }] = await q<{ ok: boolean }>("select has_table_privilege('service_role', $1::regclass, $2) ok", [`public.${table}`, privilege]);
        expect(ok, `service_role ${privilege} on ${table}`).toBe(false);
      }
    }
    for (const table of ["community_voting_entry_photos", "community_voting_schedules", "community_voting_followup_tasks"]) {
      for (const privilege of ["DELETE", "TRUNCATE"]) {
        const [{ ok }] = await q<{ ok: boolean }>("select has_table_privilege('service_role', $1::regclass, $2) ok", [`public.${table}`, privilege]);
        expect(ok, `service_role ${privilege} on ${table}`).toBe(false);
      }
    }
  });

  it("makes every Community Voting function executable by service_role ONLY — except the three bare lookups the Session guards need", async () => {
    const rows = await q<{ proname: string; anon: boolean; authed: boolean; svc: boolean; pub: boolean }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authed,
              has_function_privilege('service_role', p.oid, 'execute') svc,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') pub
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like '%community_voting%')
       order by p.proname`
    );
    expect(rows.length).toBeGreaterThan(60);
    const open = rows.filter((r) => r.anon || r.authed || r.pub).map((r) => r.proname).sort();
    expect(open).toEqual(["community_voting_event_session_of_interaction", "community_voting_scope_of_interaction", "community_voting_session_is_event_bound"]);
    for (const r of rows) expect(r.svc, r.proname).toBe(true);
  });

  it("refuses direct calls as anon and authenticated at the database (42501) and over REST with the public key", async () => {
    for (const role of ["anon", "authenticated"]) {
      const c = await rawClient();
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        for (const sql of [
          "select * from read_community_voting_round_gallery($1)",
          "select * from cast_community_voting_round_vote_atomically($1,$1,$1,1,$1,$1,null,null,null)",
          "select * from close_community_voting_round_atomically($1,'x',$1)",
          "select * from read_community_voting_round_public_info($1)",
          "select * from record_community_voting_policy_approval_atomically($1,'x',$1,'a','b','c')",
        ]) {
          await c.query("savepoint s");
          const message = await c.query(sql, [randomUUID()]).then(() => "ALLOWED", (e: Error & { code?: string }) => e.code ?? e.message);
          expect(message, `${role}: ${sql}`).toBe("42501");
          await c.query("rollback to savepoint s");
        }
      } finally {
        await c.query("rollback").catch(() => undefined);
        await c.end();
      }
    }
    const viaRest = await anon.rpc("read_community_voting_round_public_info", { p_instance_id: randomUUID() });
    expect(viaRest.error?.code).toBe("42501");
    for (const table of PILOT_TABLES) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(error?.code, table).toBe("42501");
    }
  });

  it("gives a preliminary NO geofence, and the table itself forbids a mixed, half-configured or unknown-mode Instance", async () => {
    const r = await newRound("PRELIMINARY");
    const [row] = await q<Record<string, unknown>>("select * from community_voting_instances where instance_id = $1", [r.ctx.instanceId]);
    expect(row).toMatchObject({ ballot_mode: "FAVORITE_ROUND", round_role: "PRELIMINARY", venue_latitude: null, venue_longitude: null, venue_radius_meters: null, max_accuracy_meters: null, inside_margin_factor: null, outside_margin_factor: null });
    expect(row.operator_gaming_member_id).toBe(r.operator.gamingMemberId);
    const { createSession } = await import("../lib/session/createSession");
    const session = await createSession(sessionRepo);
    const member = await newPerson();
    expect(await pool.query("insert into community_voting_instances (session_id, rule_version, ballot_mode, operator_gaming_member_id, round_role, finalist_cutoff, venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor) values ($1, 1, 'FAVORITE_ROUND', $2, 'PRELIMINARY', 10, 1, 1, 1, 1, 1, 1)", [session.sessionId, member.gamingMemberId]).then(() => "OK", (e: Error) => e.message)).toMatch(/geofence_by_mode/);
    expect(await pool.query("insert into community_voting_instances (session_id, rule_version, ballot_mode, round_role, finalist_cutoff) values ($1, 1, 'FAVORITE_ROUND', 'PRELIMINARY', 10)", [session.sessionId]).then(() => "OK", (e: Error) => e.message)).toMatch(/operator_by_mode|geofence_by_mode/);
    expect(await pool.query("insert into community_voting_instances (session_id, rule_version) values ($1, 1)", [session.sessionId]).then(() => "OK", (e: Error) => e.message)).toMatch(/geofence_by_mode/);
    expect(await pool.query("insert into community_voting_instances (session_id, rule_version, ballot_mode) values ($1, 1, 'POPULARITY')", [session.sessionId]).then(() => "OK", (e: Error) => e.message)).toMatch(/ballot_mode_values/);
  });
});

// ============================================================ operator authority and audit

describe("operator authority (host token AND the designated Gaming Member)", () => {
  it("rejects every operator operation for a wrong host token, a stranger Gaming Member and a missing member — and changes nothing", async () => {
    const r = await newRound("PRELIMINARY");
    const { entry, photo } = await approvedEntry(r);
    const stranger = await newPerson();
    const bad: Array<[string, OperatorContext]> = [
      ["wrong host token", { ...r.ctx, hostToken: "not-the-host" }],
      ["a different Gaming Member", { ...r.ctx, operatorMemberId: stranger.gamingMemberId as string }],
      ["a missing member", { ...r.ctx, operatorMemberId: null as unknown as string }],
    ];
    const schedule = { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, status: "TENTATIVE" as const };
    const probes: Array<[string, (c: OperatorContext) => Promise<unknown>]> = [
      ["setRoundSchedule", (c) => repo.setRoundSchedule({ ...c, schedule })],
      ["createRoundEntry", (c) => repo.createRoundEntry(c)],
      ["removeRoundEntry", (c) => repo.removeRoundEntry({ ...c, entryId: entry.entryId })],
      ["uploadEntryPhoto", (c) => repo.uploadEntryPhoto({ ...c, entryId: entry.entryId, ...photoArgs(900) })],
      ["recordEntryConsent", (c) => repo.recordEntryConsent({ ...c, entryId: entry.entryId, photoId: photo.photoId, ...consentArgs })],
      ["recordPromoConsent", (c) => repo.recordPromoConsent({ ...c, entryId: entry.entryId, decision: "DECLINED", consentVersion: "v", statementSha256: "a".repeat(64) })],
      ["decideEntryPhoto", (c) => repo.decideEntryPhoto({ ...c, entryId: entry.entryId, photoId: photo.photoId, decision: "REJECTED" })],
      ["confirmRoundAssociation", (c) => repo.confirmRoundAssociation({ ...c, entryId: entry.entryId, confirmationCode: "ABCD1234" })],
      ["hideRoundPhoto", (c) => repo.hideRoundPhoto({ ...c, entryId: entry.entryId, reason: "x" })],
      ["withdrawRoundCandidature", (c) => repo.withdrawRoundCandidature({ ...c, entryId: entry.entryId, reason: "x", hidePhoto: false })],
      ["recordPolicyApproval", (c) => repo.recordPolicyApproval({ ...c, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "DEC-1" })],
      ["startRound", (c) => repo.startRound({ ...c, promptText: "Q" })],
      ["closeRound", (c) => repo.closeRound(c)],
      ["selectFinalists", (c) => repo.selectFinalists(c)],
      ["recordRoundReview", (c) => repo.recordRoundReview(c)],
      ["publishRound", (c) => repo.publishRound(c)],
      ["readRoundResults", (c) => repo.readRoundResults(c)],
      ["readRoundEvidence", (c) => repo.readRoundEvidence(c)],
      ["readRoundOverview", (c) => repo.readRoundOverview(c)],
    ];
    const actionsBefore = (await q("select 1 from community_voting_operator_actions where instance_id = $1", [r.ctx.instanceId])).length;
    for (const [probe, run] of probes) {
      for (const [label, ctx] of bad) {
        const outcome = await run(ctx).then(() => null, (e: unknown) => e);
        if (label === "wrong host token") expect(outcome, `${probe} / ${label}`).toBeInstanceOf(HostTokenMismatchError);
        else {
          expect(outcome, `${probe} / ${label}`).toBeInstanceOf(CommunityVotingError);
          expect((outcome as CommunityVotingError).code, `${probe} / ${label}`).toBe("OPERATOR_REQUIRED");
        }
      }
    }
    expect((await q("select 1 from community_voting_operator_actions where instance_id = $1", [r.ctx.instanceId])).length).toBe(actionsBefore);
    expect((await repo.readRoundOverview(r.ctx)).entries.find((e) => e.entryId === entry.entryId)).toMatchObject({ media: "APPROVED", withdrawn: false });
  });

  it("registers a round only for an EXISTING Gaming Member, once per Session, with exactly the VOTING capability, before any Participant", async () => {
    const { createSession } = await import("../lib/session/createSession");
    const { setSessionCapabilities } = await import("../lib/session/setSessionCapabilities");
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const member = await newPerson();
    const base = { sessionId: session.sessionId, hostToken: session.hostToken, ruleVersion: 1, roundRole: "PRELIMINARY" as const, sourceInstanceId: null, venue: null, windowSeconds: null };
    await expectCode(repo.registerRound({ ...base, operatorMemberId: randomUUID() }), "OPERATOR_REQUIRED");
    await expect(repo.registerRound({ ...base, hostToken: "nope", operatorMemberId: member.gamingMemberId as string })).rejects.toBeInstanceOf(HostTokenMismatchError);
    await expectCode(repo.registerRound({ ...base, ruleVersion: 0, operatorMemberId: member.gamingMemberId as string }), "INVALID_REQUEST");
    const ok = await repo.registerRound({ ...base, operatorMemberId: member.gamingMemberId as string });
    expect(ok).toMatchObject({ roundRole: "PRELIMINARY", ruleVersion: 1, sourceInstanceId: null, windowSeconds: null });
    expect(JSON.stringify(ok)).not.toContain(member.gamingMemberId as string); // the operator's id is never echoed
    await expectCode(repo.registerRound({ ...base, operatorMemberId: member.gamingMemberId as string }), "INSTANCE_ALREADY_REGISTERED");

    const wide = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, wide.sessionId, wide.hostToken, ["VOTING", "OPEN_RESPONSE"] as never);
    await expectCode(repo.registerRound({ ...base, sessionId: wide.sessionId, hostToken: wide.hostToken, operatorMemberId: member.gamingMemberId as string }), "CAPABILITY_SET_NOT_EXACTLY_VOTING");
  });

  it("records every consequential operator act in the audit trail — references only, never free text or a secret", async () => {
    const r = await newRound("PRELIMINARY");
    const cs = [await contestant(r), await contestant(r), await contestant(r)];
    await openRound(r);
    const reasonText = "la persona pidió retirar su foto — texto libre privado 5551234";
    await repo.hideRoundPhoto({ ...r.ctx, entryId: cs[1].entry.entryId, reason: reasonText });
    await repo.withdrawRoundCandidature({ ...r.ctx, entryId: cs[0].entry.entryId, reason: reasonText, hidePhoto: false });
    await repo.closeRound(r.ctx);
    const rows = await q<{ action: string; entry_id: string | null; detail: Record<string, unknown> }>("select action, entry_id, detail from community_voting_operator_actions where instance_id = $1 order by occurred_at, action_id", [r.ctx.instanceId]);
    const actions = rows.map((x) => x.action);
    for (const expected of ["REGISTER_INSTANCE", "SET_SCHEDULE", "CREATE_ENTRY", "UPLOAD_PHOTO", "RECORD_CONSENT", "APPROVE_PHOTO", "CONFIRM_ASSOCIATION", "OPEN_VOTING", "HIDE_PHOTO", "WITHDRAW_CANDIDATURE", "CLOSE_VOTING"]) expect(actions).toContain(expected);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("5551234");
    expect(text).not.toContain(reasonText);
    expect(text).not.toContain(r.ctx.hostToken);
    expect(rows.find((x) => x.action === "WITHDRAW_CANDIDATURE")!.detail).toMatchObject({ duringVoting: true, photoHidden: false });
    await expectDbError("update community_voting_operator_actions set action = 'SET_SCHEDULE'", [], "HISTORY_IMMUTABLE");
    await expectDbError("delete from community_voting_operator_actions", [], "HISTORY_IMMUTABLE");
    await expectDbError("truncate community_voting_operator_actions", [], "HISTORY_IMMUTABLE");
  });
});

// ============================================================ entries, photographs, consent, decision

describe("contestant entries, photographs, consent and the operator's decision", () => {
  it("issues an opaque, non-sequential contestant number and a short claim credential that is stored only as a digest", async () => {
    const r = await newRound("PRELIMINARY");
    const entries = [];
    for (let i = 0; i < 12; i++) entries.push(await repo.createRoundEntry(r.ctx));
    const labels = entries.map((e) => e.label);
    for (const label of labels) expect(label).toMatch(/^#[1-9][0-9]{3}$/);
    expect(new Set(labels).size).toBe(labels.length);
    const numeric = labels.map((l) => Number(l.slice(1)));
    expect(numeric).not.toEqual([...numeric].sort((a, b) => a - b)); // not issued in increasing order
    for (const e of entries) expect(e.claimCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    const rows = await q<Record<string, unknown>>("select * from community_voting_entries where instance_id = $1", [r.ctx.instanceId]);
    const stored = JSON.stringify(rows);
    for (const e of entries) expect(stored).not.toContain(e.claimCode);
    for (const row of rows) expect(row.claim_code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a metadata-free JPEG pair, records digests, and serves the same bytes back by the opaque number only once the contestant is approved AND associated", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const args = photoArgs(7);
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...args });
    expect(photo.fullSha256).toBe(createHash("sha256").update(Buffer.from(args.fullBase64, "base64")).digest("hex"));
    expect(photo.thumbSha256).toBe(createHash("sha256").update(Buffer.from(args.thumbBase64, "base64")).digest("hex"));
    const alias = entry.label.slice(1);
    const read = (variant: "full" | "thumb") => repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias, variant });
    expect(await read("full")).toBeNull(); // not approved yet
    expect(await repo.readRoundGallery(r.ctx.instanceId)).toEqual([]);
    await repo.recordEntryConsent({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, ...consentArgs });
    expect(await read("full")).toBeNull(); // consented but not approved
    await repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" });
    expect(await read("full")).toBeNull(); // approved but the association is not confirmed: nobody is shown before the person behind is confirmed
    const person = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
    const claimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: entry.claimCode });
    await repo.confirmRoundAssociation({ ...r.ctx, entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
    const full = await read("full");
    const thumb = await read("thumb");
    expect(full!.contentType).toBe("image/jpeg");
    expect(full!.bytes.equals(Buffer.from(args.fullBase64, "base64"))).toBe(true);
    expect(thumb!.bytes.equals(Buffer.from(args.thumbBase64, "base64"))).toBe(true);
    expect(full!.bytes.length).toBeGreaterThan(thumb!.bytes.length);
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: "0000", variant: "full" })).toBeNull();
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias, variant: "huge" as never })).toBeNull();
    expect(await repo.readRoundGallery(r.ctx.instanceId)).toEqual([{ alias: entry.label, candidateId: null, ordinal: 1 }]);
  });

  it("rejects a photograph that is not an acceptable metadata-free JPEG, and stores nothing", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const good = photoArgs(8);
    const withExif = Buffer.concat([jpeg(9).subarray(0, 2), Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from("Exif\0\0GPS..."), jpeg(9).subarray(2)]);
    const bad: Array<[string, Partial<typeof good>]> = [
      ["not base64", { fullBase64: "@@@not base64@@@" }],
      ["empty", { fullBase64: "" }],
      ["a PNG", { fullBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]).toString("base64") }],
      ["EXIF still present", { fullBase64: withExif.toString("base64") }],
      ["EXIF in the thumbnail", { thumbBase64: withExif.toString("base64") }],
      ["over 1.5 MB", { fullBase64: jpeg(1, 1_600_000).toString("base64") }],
      ["thumbnail over 150 KB", { thumbBase64: jpeg(1, 160_000).toString("base64") }],
      ["zero width", { width: 0 }],
      ["absurd height", { height: 99999 }],
    ];
    for (const [label, override] of bad) {
      await expectCode(repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...good, ...override }), "PHOTO_INVALID").catch((e: Error) => {
        throw new Error(`${label}: ${e.message}`);
      });
    }
    expect(await q("select 1 from community_voting_entry_photos where entry_id = $1", [entry.entryId])).toHaveLength(0);
  });

  it("makes a new photograph supersede the old: the old bytes are erased and the old consent no longer covers the entry", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const first = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(11) });
    await repo.recordEntryConsent({ ...r.ctx, entryId: entry.entryId, photoId: first.photoId, ...consentArgs });
    await repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: first.photoId, decision: "APPROVED" });
    const second = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(12) });
    const [old] = await q<{ full_bytes: Buffer | null; bytes_deleted_reason: string | null; full_sha256: string }>("select full_bytes, bytes_deleted_reason, full_sha256 from community_voting_entry_photos where photo_id = $1", [first.photoId]);
    expect(old.full_bytes).toBeNull();
    expect(old.bytes_deleted_reason).toBe("SUPERSEDED");
    expect(old.full_sha256).toBe(first.fullSha256); // the evidence of what existed survives
    expect(await repo.readRoundGallery(r.ctx.instanceId)).toEqual([]);
    await expectCode(repo.recordEntryConsent({ ...r.ctx, entryId: entry.entryId, photoId: first.photoId, ...consentArgs }), "PHOTO_REQUIRED");
    await expectCode(repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: second.photoId, decision: "APPROVED" }), "CONSENT_REQUIRED");
  });

  it("requires consent for THAT photograph, once, with the age confirmation — and approval requires consent", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(13) });
    const consent = { ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256 };
    await expectCode(repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" }), "CONSENT_REQUIRED");
    await expectCode(repo.recordEntryConsent({ ...consent, ageConfirmed: false }), "CONSENT_REQUIRED");
    await expectCode(repo.recordEntryConsent({ ...consent, ageConfirmed: true, statementSha256: "nope" }), "INVALID_REQUEST");
    await expectCode(repo.recordEntryConsent({ ...consent, ageConfirmed: true, consentVersion: "bad version!" }), "INVALID_REQUEST");
    await expectCode(repo.recordEntryConsent({ ...consent, ageConfirmed: true, photoId: randomUUID() }), "PHOTO_REQUIRED");
    const recorded = await repo.recordEntryConsent({ ...consent, ageConfirmed: true });
    expect(recorded.consentId).toMatch(/[0-9a-f-]{36}/);
    await expectCode(repo.recordEntryConsent({ ...consent, ageConfirmed: true }), "CONSENT_ALREADY_RECORDED");
    const [row] = await q<Record<string, unknown>>("select * from community_voting_entry_consents where photo_id = $1", [photo.photoId]);
    expect(row).toMatchObject({ consent_version: GALLERY_CONSENT_VERSION, statement_sha256: GALLERY_CONSENT_SHA256, acceptance_method: "OPERATOR_TABLET_CHECKBOX", age_confirmed: true, recorded_by_member_id: r.operator.gamingMemberId });
    await expectDbError("update community_voting_entry_consents set age_confirmed = true", [], "HISTORY_IMMUTABLE");
    await expectDbError("delete from community_voting_entry_consents", [], "HISTORY_IMMUTABLE");
  });

  it("decides a photograph once; a rejection erases its bytes at once and keeps its record", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(14) });
    await expectCode(repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "MAYBE" as never }), "INVALID_REQUEST");
    await repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "REJECTED", reason: "ilegible" });
    await expectCode(repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" }), "DECISION_ALREADY_RECORDED");
    const [row] = await q<{ full_bytes: Buffer | null; bytes_deleted_reason: string; full_sha256: string }>("select full_bytes, bytes_deleted_reason, full_sha256 from community_voting_entry_photos where photo_id = $1", [photo.photoId]);
    expect(row.full_bytes).toBeNull();
    expect(row.bytes_deleted_reason).toBe("REJECTED");
    expect(row.full_sha256).toBe(photo.fullSha256);
    expect((await repo.readRoundOverview(r.ctx)).entries[0].media).toBe("REJECTED");
  });

  it("refuses to remove an entry that has a photograph (it must be withdrawn), and removes one that has none", async () => {
    const r = await newRound("PRELIMINARY");
    const bare = await repo.createRoundEntry(r.ctx);
    const { entry } = await approvedEntry(r);
    await expectCode(repo.removeRoundEntry({ ...r.ctx, entryId: entry.entryId }), "ENTRY_HAS_MEDIA");
    await repo.removeRoundEntry({ ...r.ctx, entryId: bare.entryId });
    await expectCode(repo.removeRoundEntry({ ...r.ctx, entryId: bare.entryId }), "ENTRY_NOT_FOUND");
  });

  it("lets only the round's own operations change its entries — GATE-003's operations and a direct write are refused by the table", async () => {
    const r = await newRound("PRELIMINARY");
    await expectDbError("select * from create_community_voting_entry_atomically($1, $2, 'Sneaky')", [r.ctx.instanceId, r.session.hostToken], "ROUND_PATH_REQUIRED");
    await expectDbError("insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at) values ($1, 1, 'Direct', 60, now() + interval '1 minute')", [r.ctx.instanceId], "ROUND_PATH_REQUIRED");
    expect(await q("select 1 from community_voting_entries where instance_id = $1", [r.ctx.instanceId])).toHaveLength(0);
  });
});

// ============================================================ the contestant's private association

describe("contestant association: short credential, counted failures, operator confirmation", () => {
  it("claims with a credential typed any reasonable way by a bound identity, and the credential is single use", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const person = await newPerson();
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: entry.claimCode }), "NOT_BOUND");
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
    const typed = `${entry.claimCode.slice(0, 4)}-${entry.claimCode.slice(4, 8).toLowerCase()} ${entry.claimCode.slice(8)}`;
    const claimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: typed });
    expect(claimed.label).toBe(entry.label);
    expect(claimed.confirmationCode).toMatch(/^[0-9A-F]{8}$/);
    expect((await repo.readRoundOverview(r.ctx)).entries[0].association).toBe("PENDING_CONFIRMATION");
    const second = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: second.authUserId });
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: second.authUserId, claimCode: entry.claimCode }), "CLAIM_INVALID");
  });

  it("maps the look-alike characters (O to 0, I and L to 1) so a mis-typed credential still works, and never accepts the excluded letter U", async () => {
    const r = await newRound("PRELIMINARY");
    let entry = await repo.createRoundEntry(r.ctx);
    for (let i = 0; i < 40 && !/[01]/.test(entry.claimCode); i++) entry = await repo.createRoundEntry(r.ctx);
    expect(entry.claimCode).toMatch(/[01]/);
    const lookalike = entry.claimCode.replace(/0/g, "O").replace(/1/g, "I");
    const person = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
    await expect(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: lookalike })).resolves.toMatchObject({ label: entry.label });
    const other = await repo.createRoundEntry(r.ctx);
    const p2 = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: p2.authUserId });
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: p2.authUserId, claimCode: other.claimCode.slice(0, 11) + "U" }), "CLAIM_INVALID");
  });

  it("COUNTS failures per identity, persists the count, locks the identity after ten, and resets the count on success", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const guesser = await newPerson();
    const gb = await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: guesser.authUserId });
    for (let i = 0; i < 10; i++) await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: guesser.authUserId, claimCode: `ZZZZZZZZZZZ${i}`.slice(0, 12).padEnd(12, "Z") }), "CLAIM_INVALID");
    const [{ claim_failures }] = await q<{ claim_failures: number }>("select claim_failures from community_voting_voter_bindings where binding_id = $1", [gb.bindingId]);
    expect(claim_failures).toBe(10);
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: guesser.authUserId, claimCode: entry.claimCode }), "CLAIM_RATE_LIMITED"); // even the RIGHT credential
    const honest = await newPerson();
    const hb = await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: honest.authUserId });
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: honest.authUserId, claimCode: "AAAAAAAAAAAA" }), "CLAIM_INVALID");
    await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: honest.authUserId, claimCode: entry.claimCode });
    const [{ claim_failures: after }] = await q<{ claim_failures: number }>("select claim_failures from community_voting_voter_bindings where binding_id = $1", [hb.bindingId]);
    expect(after).toBe(0);
  });

  it("holds an identity to ONE entry, refuses an expired credential, and never matches another event's credential", async () => {
    const r = await newRound("PRELIMINARY");
    const other = await newRound("PRELIMINARY");
    const one = await repo.createRoundEntry(r.ctx);
    const two = await repo.createRoundEntry(r.ctx);
    const foreign = await repo.createRoundEntry(other.ctx);
    const person = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
    await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: one.claimCode });
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: two.claimCode }), "CONTESTANT_ALREADY_HAS_ENTRY");
    const fresh = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: fresh.authUserId });
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: fresh.authUserId, claimCode: foreign.claimCode }), "CLAIM_INVALID");
    const short = await repo.createRoundEntry({ ...r.ctx, claimTtlSeconds: 1 });
    await sleep(1500);
    await expectCode(repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: fresh.authUserId, claimCode: short.claimCode }), "CLAIM_EXPIRED");
  });

  it("confirms only with the matching code, voids the claim after five wrong codes, and never moves the association afterwards", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const person = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
    const claimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: entry.claimCode });
    const wrong = claimed.confirmationCode === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 4; i++) await expectCode(repo.confirmRoundAssociation({ ...r.ctx, entryId: entry.entryId, confirmationCode: wrong }), "CONFIRMATION_REJECTED");
    await expectCode(repo.confirmRoundAssociation({ ...r.ctx, entryId: entry.entryId, confirmationCode: wrong }), "CLAIM_VOIDED");
    await expectCode(repo.confirmRoundAssociation({ ...r.ctx, entryId: entry.entryId, confirmationCode: claimed.confirmationCode }), "CONFIRMATION_NOT_PENDING");
    const again = await repo.createRoundEntry(r.ctx);
    const reclaimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: again.claimCode });
    await expect(repo.confirmRoundAssociation({ ...r.ctx, entryId: again.entryId, confirmationCode: reclaimed.confirmationCode.toLowerCase() })).resolves.toEqual({ entryId: again.entryId, state: "CONFIRMED" });
  });
});

// ============================================================ the atomic open

describe("the atomic open (operator-only, readiness-gated, never implied)", () => {
  const counts = async (sessionId: string) => (await q<{ interactions: string; candidates: string; events: string }>(
    `select (select count(*) from interaction_instances where session_id = $1)::text interactions,
            (select count(*) from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1)::text candidates,
            (select count(*) from session_events where session_id = $1 and event_type = 'INTERACTION_STARTED')::text events`, [sessionId]))[0];

  it("opens in ONE step: attributed candidates for exactly the ready contestants, PROMPT_ACTIVE, one event — and nothing before it", async () => {
    const r = await newRound("PRELIMINARY");
    const cs = [];
    for (let i = 0; i < 4; i++) cs.push(await contestant(r));
    expect(await counts(r.session.sessionId)).toEqual({ interactions: "0", candidates: "0", events: "0" });
    await expectCode(repo.startRound({ ...r.ctx, promptText: "Q" }), "SESSION_NOT_STARTABLE");
    await lockRound(r);
    expect(await counts(r.session.sessionId)).toEqual({ interactions: "0", candidates: "0", events: "0" }); // locking opens nothing
    const started = await repo.startRound({ ...r.ctx, promptText: "  Mejor disfraz  " });
    expect(started).toMatchObject({ state: "PROMPT_ACTIVE", candidateCount: 4, segmentNumber: 1 });
    expect(await counts(r.session.sessionId)).toEqual({ interactions: "1", candidates: "4", events: "1" });
    const rows = await q<{ label: string; participant_id: string }>("select label, participant_id from voting_candidates where interaction_instance_id = $1 order by ordinal", [started.interactionInstanceId]);
    expect(rows.map((x) => x.label)).toEqual(cs.map((c) => c.entry.label));
    expect(rows.every((x) => x.participant_id)).toBe(true);
    await expectCode(repo.startRound({ ...r.ctx, promptText: "Otra" }), "ALREADY_OPENED");
  });

  it("refuses to open — leaving nothing behind — unless EVERY contestant is associated, photographed, consented and approved", async () => {
    const r = await newRound("PRELIMINARY");
    await contestant(r);
    await contestant(r);
    await lockRound(r);
    const nothing = async () => expect((await counts(r.session.sessionId)).interactions).toBe("0");
    const start = () => repo.startRound({ ...r.ctx, promptText: "Mejor disfraz" });
    await expectCode(repo.startRound({ ...r.ctx, promptText: "" }), "INVALID_REQUEST");
    await expectCode(repo.startRound({ ...r.ctx, promptText: "q".repeat(1001) }), "INVALID_REQUEST");

    const unclaimed = await repo.createRoundEntry(r.ctx);
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // no photograph, no association
    await nothing();
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: unclaimed.entryId, ...photoArgs(31) });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // photograph without consent
    await repo.recordEntryConsent({ ...r.ctx, entryId: unclaimed.entryId, photoId: photo.photoId, ...consentArgs });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // consent, not yet approved
    await repo.decideEntryPhoto({ ...r.ctx, entryId: unclaimed.entryId, photoId: photo.photoId, decision: "APPROVED" });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // approved, not yet associated
    const late = await newPerson();
    await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: late.authUserId });
    const claimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: late.authUserId, claimCode: unclaimed.claimCode });
    await expectCode(start(), "PREPARATION_INCOMPLETE"); // pending confirmation
    await nothing();
    await repo.confirmRoundAssociation({ ...r.ctx, entryId: unclaimed.entryId, confirmationCode: claimed.confirmationCode });
    await expect(start()).resolves.toMatchObject({ candidateCount: 3 });
  });

  it("needs at least two contestants, and ignores a contestant who withdrew BEFORE opening", async () => {
    const r = await newRound("PRELIMINARY");
    const a = await contestant(r);
    await lockRound(r);
    await expectCode(repo.startRound({ ...r.ctx, promptText: "Q" }), "PREPARATION_INCOMPLETE");
    const b = await contestant(r);
    const c = await contestant(r);
    await repo.withdrawRoundCandidature({ ...r.ctx, entryId: a.entry.entryId, reason: "se retiró antes", hidePhoto: false });
    const started = await repo.startRound({ ...r.ctx, promptText: "Q" });
    expect(started.candidateCount).toBe(2);
    const labels = (await q<{ label: string }>("select label from voting_candidates where interaction_instance_id = $1 order by ordinal", [started.interactionInstanceId])).map((x) => x.label);
    expect(labels).toEqual([b.entry.label, c.entry.label]);
    expect(labels).not.toContain(a.entry.label);
  });

  it("a contestant whose photograph was hidden at their request still takes part: hiding is not withdrawing", async () => {
    const r = await newRound("PRELIMINARY");
    const a = await contestant(r);
    await contestant(r);
    await repo.hideRoundPhoto({ ...r.ctx, entryId: a.entry.entryId, reason: "Privacidad" });
    await lockRound(r);
    await expect(repo.startRound({ ...r.ctx, promptText: "Q" })).resolves.toMatchObject({ candidateCount: 2 });
  });

  it("refuses GATE-003's start and the ORDINARY start on a round, however they are called", async () => {
    const r = await newRound("PRELIMINARY");
    await contestant(r);
    await contestant(r);
    await lockRound(r);
    await expectDbError("select * from start_community_voting_atomically($1, $2, 'Q')", [r.ctx.instanceId, r.session.hostToken], "ROUND_PATH_REQUIRED");
    await expectDbError("select * from start_session_atomically($1,$2,'Q',null,'HOST_AUTHORED','[\"A\",\"B\"]'::jsonb,null,'NEW_SEGMENT')", [r.session.sessionId, r.session.hostToken], "EVENT_BOUND_SESSION");
    expect((await counts(r.session.sessionId)).interactions).toBe("0");
  });

  it("opens exactly once under concurrent attempts", async () => {
    const r = await newRound("PRELIMINARY");
    for (let i = 0; i < 3; i++) await contestant(r);
    await lockRound(r);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.startRound({ ...r.ctx, promptText: "Q" })));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of results) if (x.status === "rejected") expect((x.reason as CommunityVotingError).code).toBe("ALREADY_OPENED");
    expect((await counts(r.session.sessionId)).interactions).toBe("1");
  });

  it("rolls back EVERYTHING when a late step of the open fails", async () => {
    const r = await newRound("PRELIMINARY");
    for (let i = 0; i < 3; i++) await contestant(r);
    await lockRound(r);
    await q("create or replace function hw_induced_failure() returns trigger language plpgsql as $$ begin raise exception 'HW_INDUCED_FAILURE'; end; $$");
    const state = async () => (await q<{ interactions: string; candidates: string; linked: string }>(
      `select (select count(*) from interaction_instances where session_id = $1)::text interactions,
              (select count(*) from voting_candidates vc join interaction_instances ii on ii.interaction_instance_id = vc.interaction_instance_id where ii.session_id = $1)::text candidates,
              (select count(*) from community_voting_entries where instance_id = $2 and candidate_id is not null)::text linked`, [r.session.sessionId, r.ctx.instanceId]))[0];
    const before = await state();
    await q("create trigger hw_induced_failure_trg after update on voting_candidates for each row execute function hw_induced_failure()");
    try {
      const err = await repo.startRound({ ...r.ctx, promptText: "Q" }).then(() => null, (e: unknown) => e as Error);
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(CommunityVotingError); // a raw database failure is reduced to its SQLSTATE, never passed through
      expect(await state()).toEqual(before);
    } finally {
      await q("drop trigger if exists hw_induced_failure_trg on voting_candidates");
    }
    await expect(repo.startRound({ ...r.ctx, promptText: "Q" })).resolves.toMatchObject({ candidateCount: 3 });
  });

  it("freezes the preparation the moment voting opens — but a withdrawal and a privacy action remain possible", async () => {
    const r = await newRound("PRELIMINARY");
    const cs = [await contestant(r), await contestant(r), await contestant(r)];
    await openRound(r);
    const ctx = r.ctx;
    const first = cs[0];
    await expectCode(repo.createRoundEntry(ctx), "PREPARATION_CLOSED");
    await expectCode(repo.uploadEntryPhoto({ ...ctx, entryId: first.entry.entryId, ...photoArgs(77) }), "PREPARATION_CLOSED");
    await expectCode(repo.recordEntryConsent({ ...ctx, entryId: first.entry.entryId, photoId: first.photo.photoId, ...consentArgs }), "PREPARATION_CLOSED");
    await expectCode(repo.decideEntryPhoto({ ...ctx, entryId: first.entry.entryId, photoId: first.photo.photoId, decision: "REJECTED" }), "PREPARATION_CLOSED");
    await expectCode(repo.removeRoundEntry({ ...ctx, entryId: first.entry.entryId }), "PREPARATION_CLOSED");
    await expectCode(repo.confirmRoundAssociation({ ...ctx, entryId: first.entry.entryId, confirmationCode: "ABCD1234" }), "PREPARATION_CLOSED");
    const stranger = await newPerson();
    await repo.bindVoter({ instanceId: ctx.instanceId, authUserId: stranger.authUserId });
    await expectCode(repo.claimRoundEntry({ instanceId: ctx.instanceId, authUserId: stranger.authUserId, claimCode: "AAAAAAAAAAAA" }), "PREPARATION_CLOSED");
    await expectDbError("update voting_candidates set participant_id = null", [], "BALLOT_FROZEN");
    await expectDbError("insert into community_voting_entry_photos (instance_id, entry_id, width, height, full_bytes, thumb_bytes, full_sha256, thumb_sha256, full_size, thumb_size, uploaded_by_member_id) select instance_id, entry_id, 1, 1, '\\xffd8ffd9', '\\xffd8ffd9', repeat('a',64), repeat('a',64), 4, 4, $2 from community_voting_entries where instance_id = $1 limit 1", [ctx.instanceId, r.operator.gamingMemberId], "PREPARATION_FROZEN");
    await expect(repo.hideRoundPhoto({ ...ctx, entryId: cs[1].entry.entryId, reason: "privacidad" })).resolves.toMatchObject({ entryId: cs[1].entry.entryId });
    await expect(repo.withdrawRoundCandidature({ ...ctx, entryId: first.entry.entryId, reason: "retiro", hidePhoto: false })).resolves.toMatchObject({ duringVoting: true });
  });
});

// ============================================================ operator evidence and public-data privacy

describe("operator evidence and public-data privacy", () => {
  it("returns the evidence by reason and time, with the operator trail — and no secret of any person", async () => {
    const r = await newRound("PRELIMINARY");
    const cs = [await contestant(r), await contestant(r), await contestant(r)];
    await openRound(r);
    await repo.withdrawRoundCandidature({ ...r.ctx, entryId: cs[2].entry.entryId, reason: "Retiro", hidePhoto: true });
    await repo.closeRound(r.ctx);
    const evidence = await repo.readRoundEvidence(r.ctx);
    expect(evidence).toMatchObject({ roundRole: "PRELIMINARY", closed: true, validVotesAtClose: 0 });
    expect(evidence.openedAt).not.toBeNull();
    expect(evidence.closedAt).not.toBeNull();
    expect(evidence.withdrawals).toEqual([expect.objectContaining({ label: cs[2].entry.label, duringVoting: true, afterClose: false })]);
    expect(evidence.privacyActions).toHaveLength(1);
    expect(evidence.operatorActions.map((a) => a.action)).toEqual(expect.arrayContaining(["OPEN_VOTING", "CLOSE_VOTING", "WITHDRAW_CANDIDATURE"]));
    const text = JSON.stringify(evidence);
    for (const secret of [cs[0].person.authUserId, r.ctx.hostToken, r.operator.gamingMemberId as string, r.operator.authUserId]) expect(text).not.toContain(secret);
  });

  it("shows the operator ACTIVITY counters but never a total per contestant", async () => {
    const r = await newRound("PRELIMINARY");
    for (let i = 0; i < 3; i++) await contestant(r);
    await openRound(r);
    const overview = await repo.readRoundOverview(r.ctx);
    expect(overview.counters).toMatchObject({ votes: 0, entries: 3, withdrawn: 0 });
    expect(overview.counters.boundVoters).toBeGreaterThanOrEqual(3);
    expect(overview.opened).toBe(true);
    expect(overview.closed).toBe(false);
    expect(JSON.stringify(overview.entries)).not.toMatch(/points|votes|voteCount|rank/i);
  });

  it("exposes only opaque numbers, bytes and the schedule publicly — no identifier of any person, entry or storage object", async () => {
    const r = await newRound("PRELIMINARY");
    const cs = [await contestant(r), await contestant(r), await contestant(r)];
    const surfaces = JSON.stringify({ info: await repo.readRoundPublicInfo(r.ctx.instanceId), gallery: await repo.readRoundGallery(r.ctx.instanceId) });
    const secrets = [
      r.ctx.hostToken, r.operator.gamingMemberId as string, r.operator.authUserId, r.session.sessionId,
      ...cs.flatMap((c) => [c.person.authUserId, c.entry.entryId, c.photo.photoId, c.photo.fullSha256, c.entry.claimCode]),
    ];
    for (const secret of secrets) expect(surfaces).not.toContain(secret);
    const photo = await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: cs[0].entry.label.slice(1), variant: "thumb" });
    expect(Object.keys(photo!).sort()).toEqual(["bytes", "contentType", "sha256"]);
    expect(await repo.readRoundPublicInfo(randomUUID())).toBeNull();
    const personal = await q<{ data: string }>("select row_to_json(t)::text data from community_voting_voter_bindings t where instance_id = $1", [r.ctx.instanceId]);
    for (const row of personal) expect(row.data).not.toMatch(/@|\+\d{6,}/); // no stored email address or phone number anywhere on a binding
  });

  it("serves a 130-contestant gallery in one small, bounded read", async () => {
    const r = await newRound("PRELIMINARY");
    for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: 13 }, () => contestant(r)));
    const started = Date.now();
    const gallery = await repo.readRoundGallery(r.ctx.instanceId);
    expect(gallery).toHaveLength(130);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(JSON.stringify(gallery).length).toBeLessThan(130 * 90); // aliases and numbers only: a few kilobytes
    expect(new Set(gallery.map((g) => g.alias)).size).toBe(130);
  });
});

void sha256;
