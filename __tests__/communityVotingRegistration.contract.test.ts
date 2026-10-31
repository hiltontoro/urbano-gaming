import { afterAll, describe, expect, it, vi } from "vitest";

import { expectCode, inMs, newPerson, pool, q, rawClient, repo, serviceKey, supabaseUrl } from "./helpers/roundsFixtures";
import type { Person } from "./helpers/roundsFixtures";
import {
  DELIVERY,
  REQUIREMENTS,
  approvedPhoto,
  associate,
  castVote,
  candidatesOf,
  completeAtStation,
  contestCounts,
  createGroup,
  createMember,
  group,
  memberConsent,
  newContest,
  openCategory,
  openRegistrationContest,
  registerArgs,
  registerRaw,
  selfRegister,
  syntheticWhatsapp,
} from "./helpers/categoryFixtures";
import type { CatRound } from "./helpers/categoryFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { SupabaseContestRepository } from "../lib/gaming/communityVoting/contest/supabaseContestRepository";

// The target is refused unless it is loopback (the shared fixtures apply the same guard; the registry test requires the explicit call).
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-018, addendum "self-registration, public code, manual WhatsApp, simple UI" — against REAL local Postgres (isolated loopback stack).
 *
 * The rules are the database's: these tests call the operations through SQL, so they stand independently of the TypeScript that wraps them. They were
 * written BEFORE the fourth migration (20261031120300) and run against the schema without it first (red), then with it (green): see the
 * implementation record. Every identity, number and time is synthetic; no real WhatsApp number exists in this suite.
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 180_000 });

/** The contest's own repository: it is the one that maps the contest's refusals (ALREADY_CANDIDATE, …) to their codes, as the routes use it. */
const contestRepo = new SupabaseContestRepository(supabaseUrl as string, serviceKey as string);

const HOUR = 3_600_000;
/** A refusal by the database (a function or a table guard): the statement fails and its message matches. `pattern` is a regular expression source. */
async function refused(sql: string, params: unknown[], pattern: string) {
  await expect(pool.query(sql, params)).rejects.toThrow(new RegExp(pattern));
}
const op = (r: CatRound) => [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId];
const gallery = (r: CatRound) => q<Record<string, unknown>>("select * from read_community_voting_category_gallery($1)", [r.instanceId]);
const byCode = (contestId: string, code: string) => q<Record<string, unknown>>("select * from read_community_voting_candidacy_by_code($1, $2)", [contestId, code]);
const find = (r: CatRound, code: string) => q<Record<string, unknown>>("select * from find_community_voting_candidacy_by_code($1, $2, $3, $4)", [...op(r), code]);
const contact = (r: CatRound, entryId: string) => q<Record<string, unknown>>("select * from read_community_voting_registration_contact($1, $2, $3, $4)", [...op(r), entryId]);
const delivered = (r: CatRound, entryId: string) => q<Record<string, unknown>>("select * from mark_community_voting_registration_delivered_atomically($1, $2, $3, $4)", [...op(r), entryId]);
const confirm = (r: CatRound, entryId: string) => q<Record<string, unknown>>("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [...op(r), entryId]);
const rename = (r: CatRound, entryId: string, name: string) => q<Record<string, unknown>>("select * from correct_community_voting_candidacy_name_atomically($1, $2, $3, $4, $5)", [...op(r), entryId, name]);
const structure = (r: CatRound) => q<Record<string, unknown>>("select * from read_community_voting_category_structure($1, $2, $3)", op(r));
const mine = (contestId: string, p: Person) => q<Record<string, unknown>>("select * from read_community_voting_my_candidacy($1, $2)", [contestId, p.authUserId]);
const actionCount = async (instanceId: string, action: string) =>
  Number((await q<{ n: string }>("select count(*) n from community_voting_operator_actions where instance_id = $1 and action = $2", [instanceId, action]))[0].n);

// ============================================================ the public code

describe("the public code of a candidacy: a locator, drawn at birth, never a credential", () => {
  it("is drawn for every candidacy when its entry is made — unique, shaped HAL-XXXXX — and never for an attributed member", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    await repo.createRoundEntry(r.ctx);
    await repo.createRoundEntry(r.ctx);
    await repo.createRoundEntry(r.ctx);
    const rows = await q<{ entry_id: string; public_code: string; public_name: string | null }>("select entry_id, public_code, public_name from community_voting_candidacies where instance_id = $1", [r.instanceId]);
    expect(rows).toHaveLength(3);
    for (const x of rows) {
      expect(x.public_code).toMatch(/^HAL-[2-9A-HJKMNP-TV-Z]{5}$/);
      expect(x.public_name).toBeNull();
    }
    expect(new Set(rows.map((x) => x.public_code)).size).toBe(3);

    const g = c.rounds.BEST_GROUP;
    const grp = await createGroup(g);
    await createMember(g, grp.entryId);
    await createMember(g, grp.entryId);
    const groupRows = await q<{ entry_id: string }>("select entry_id from community_voting_candidacies where instance_id = $1", [g.instanceId]);
    expect(groupRows.map((x) => x.entry_id)).toEqual([grp.entryId]); // the group has a code; its members have none
  });

  it("never repeats inside a contest, whatever number of candidacies it draws", async () => {
    const c = await openRegistrationContest();
    for (const key of ["MOST_ELABORATE", "SEXIEST", "FUNNIEST"] as const) for (let i = 0; i < 6; i++) await repo.createRoundEntry(c.rounds[key].ctx);
    const [row] = await q<{ n: number; d: number }>("select count(*)::int n, count(distinct public_code)::int d from community_voting_candidacies where contest_id = $1", [c.contestId]);
    expect(row).toEqual({ n: 18, d: 18 });
  });

  it("is immutable, deleted only with its entry, and written only with it: no update of the code, no delete, no direct insert, no bad shape, no duplicate", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const a = await repo.createRoundEntry(r.ctx);
    const b = await repo.createRoundEntry(r.ctx);
    const [{ public_code: codeA }] = await q<{ public_code: string }>("select public_code from community_voting_candidacies where entry_id = $1", [a.entryId]);

    await refused("update community_voting_candidacies set public_code = 'HAL-22222' where entry_id = $1", [a.entryId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
    await refused("update community_voting_candidacies set public_name = 'Sneaky' where entry_id = $1", [a.entryId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("delete from community_voting_candidacies where entry_id = $1", [a.entryId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("insert into community_voting_candidacies (entry_id, instance_id, contest_id, public_code) values ($1, $2, $3, 'HAL-33333')", [a.entryId, r.instanceId, c.contestId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("truncate community_voting_candidacies", [], "COMMUNITY_VOTING_HISTORY_IMMUTABLE|cannot be|history|immutable|COMMUNITY_VOTING");

    // the table's own constraints, reached the only way a row can be written: with the entry's marker, in a transaction that is rolled back
    for (const [code, expected] of [
      [codeA, /community_voting_candidacies_code_unique|duplicate key/],
      ["HAL-OOOO1", /community_voting_candidacies_code_shape|check constraint/],
      ["HAL-ABC", /community_voting_candidacies_code_shape|check constraint/],
      ["XYZ-22222", /community_voting_candidacies_code_shape|check constraint/],
    ] as const) {
      const client = await rawClient();
      try {
        await client.query("begin");
        await client.query("select set_config('urbano.community_voting_round_op', $1, true)", [r.instanceId]);
        await client.query("delete from community_voting_candidacies where entry_id = $1", [b.entryId]);
        await expect(client.query("insert into community_voting_candidacies (entry_id, instance_id, contest_id, public_code) values ($1, $2, $3, $4)", [b.entryId, r.instanceId, c.contestId, code])).rejects.toThrow(expected);
      } finally {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    const [{ public_code: still }] = await q<{ public_code: string }>("select public_code from community_voting_candidacies where entry_id = $1", [a.entryId]);
    expect(still).toBe(codeA);
  });

  it("is normalized the way a person types it — any case, hyphen or none, spaces — and never matches a look-alike", async () => {
    const norm = async (v: string | null) => (await q<{ n: string | null }>("select community_voting_normalize_public_code($1) n", [v]))[0].n;
    expect(await norm("hal-k7m2q")).toBe("HAL-K7M2Q");
    expect(await norm("HALK7M2Q")).toBe("HAL-K7M2Q");
    expect(await norm("  hal k7m2q ")).toBe("HAL-K7M2Q");
    expect(await norm("Hal-K7 M2Q")).toBe("HAL-K7M2Q");
    for (const bad of ["HAL-K7M2O", "HAL-K7M2I", "HAL-K7M2L", "HAL-K7M2U", "HAL-K7M2", "HAL-K7M2QQ", "ABC-K7M2Q", "K7M2Q", "", null, "HAL-0OIL1"]) expect(await norm(bad)).toBeNull();
  });

  it("is not the claim credential and claims nothing: presenting it as a claim code is refused and changes nothing", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const e = await repo.createRoundEntry(r.ctx);
    const [{ public_code }] = await q<{ public_code: string }>("select public_code from community_voting_candidacies where entry_id = $1", [e.entryId]);
    const stranger = await newPerson();
    await repo.bindVoter({ instanceId: r.instanceId, authUserId: stranger.authUserId });
    await expect(repo.claimRoundEntry({ instanceId: r.instanceId, authUserId: stranger.authUserId, claimCode: public_code })).rejects.toThrow();
    const [row] = await q<{ pending_binding_id: string | null; confirmed_binding_id: string | null; claim_code_hash: string | null }>(
      "select pending_binding_id, confirmed_binding_id, claim_code_hash from community_voting_entries where entry_id = $1", [e.entryId]);
    expect(row.pending_binding_id).toBeNull();
    expect(row.confirmed_binding_id).toBeNull();
    expect(row.claim_code_hash).not.toBeNull(); // the real credential is still waiting for its person
    // and the real credential is not derivable from the public code (they share nothing)
    expect(e.claimCode.replace(/[^0-9A-Z]/gi, "")).not.toContain(public_code.replace(/[^0-9A-Z]/gi, ""));
    // the only reads that take a code are STABLE: they cannot write
    const vol = await q<{ proname: string; provolatile: string }>(
      "select proname, provolatile from pg_proc where proname in ('read_community_voting_candidacy_by_code', 'find_community_voting_candidacy_by_code', 'community_voting_normalize_public_code') order by proname");
    expect(vol.map((v) => [v.proname, v.provolatile])).toEqual([
      ["community_voting_normalize_public_code", "i"],
      ["find_community_voting_candidacy_by_code", "s"],
      ["read_community_voting_candidacy_by_code", "s"],
    ]);
  });
});

// ============================================================ self-registration

describe("self-registration: a person registers THEMSELVES from their own account", () => {
  it("creates the entry, its public code and name, the private registration and the person's identity — and nothing public", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const person = await newPerson();
    const reg = await selfRegister(r, person, { name: "  Drácula de Tegucigalpa  " });

    expect(reg.public_code).toMatch(/^HAL-[2-9A-HJKMNP-TV-Z]{5}$/);
    expect(reg.public_name).toBe("Drácula de Tegucigalpa");
    expect(reg.entry_kind).toBe("INDIVIDUAL");
    expect(reg.category_key).toBe("MOST_ELABORATE");

    const [entry] = await q<Record<string, unknown>>("select claim_code_hash, pending_binding_id, confirmed_binding_id, candidate_id, entry_kind from community_voting_entries where entry_id = $1", [reg.entryId]);
    expect(entry).toMatchObject({ claim_code_hash: null, pending_binding_id: null, confirmed_binding_id: null, candidate_id: null, entry_kind: "INDIVIDUAL" });

    const [identity] = await q<Record<string, unknown>>("select * from community_voting_contest_identities where contest_id = $1 and gaming_member_id = $2", [c.contestId, person.gamingMemberId]);
    expect(identity).toMatchObject({ entry_id: reg.entryId, role: "INDIVIDUAL", instance_id: r.instanceId });

    const [row] = await q<Record<string, unknown>>("select * from community_voting_registrations where entry_id = $1", [reg.entryId]);
    expect(row).toMatchObject({
      registrant_gaming_member_id: person.gamingMemberId,
      adult_confirmed: true,
      requirements_version: REQUIREMENTS.version,
      requirements_sha256: REQUIREMENTS.sha256,
      whatsapp_e164: reg.whatsapp,
      delivery_version: DELIVERY.version,
      delivery_sha256: DELIVERY.sha256,
      delivery_status: "PENDING",
      delivered_at: null,
      delivered_by_member_id: null,
    });
    // the delivery authorization is its own record: registering creates no photograph consent
    expect((await q("select 1 from community_voting_entry_consents ec join community_voting_entry_photos p on p.photo_id = ec.photo_id where p.entry_id = $1", [reg.entryId]))).toHaveLength(0);

    // not public: not in the gallery, not found by its code, not on any ballot
    expect(await gallery(r)).toHaveLength(0);
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(0);

    // the person sees THEIR OWN candidacy, with the state of its delivery and never a number
    const own = await mine(c.contestId, person);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ category_key: "MOST_ELABORATE", instance_id: r.instanceId, role: "INDIVIDUAL", entry_kind: "INDIVIDUAL", public_code: reg.public_code, public_name: "Drácula de Tegucigalpa", state: "REGISTERED", delivery_status: "PENDING" });
    expect(Object.keys(own[0])).not.toContain("whatsapp_e164");
    expect(await mine(c.contestId, await newPerson())).toHaveLength(0);
  });

  it("registers a GROUP in the group category — the representative's own account — and an individual in the other three", async () => {
    const c = await openRegistrationContest();
    const rep = await newPerson();
    const g = await selfRegister(c.rounds.BEST_GROUP, rep, { name: "Los Monstruos del 31" });
    expect(g.entry_kind).toBe("GROUP");
    const [identity] = await q<{ role: string }>("select role from community_voting_contest_identities where entry_id = $1", [g.entryId]);
    expect(identity.role).toBe("REPRESENTATIVE");
    for (const key of ["MOST_ELABORATE", "SEXIEST", "FUNNIEST"] as const) {
      const reg = await selfRegister(c.rounds[key], await newPerson());
      expect(reg.entry_kind).toBe("INDIVIDUAL");
    }
  });

  it("is possible only inside the configured window: not before it opens, not after the cutoff, never without a schedule, never once Voting has opened", async () => {
    const early = await newContest({ registrationOpensAt: inMs(HOUR), cutoffAt: inMs(3 * HOUR), closesAt: inMs(4 * HOUR) });
    await expect(selfRegister(early.rounds.FUNNIEST, await newPerson())).rejects.toThrow(/CV_REGISTRATION_NOT_OPEN/);

    const late = await newContest({ registrationOpensAt: inMs(-3 * HOUR), cutoffAt: inMs(-1000), closesAt: inMs(HOUR) });
    await expect(selfRegister(late.rounds.FUNNIEST, await newPerson())).rejects.toThrow(/CV_CUTOFF_PASSED/);

    const unscheduled = await newContest({ closesAt: inMs(4 * HOUR) });
    await expect(selfRegister(unscheduled.rounds.FUNNIEST, await newPerson())).rejects.toThrow(/CV_SCHEDULE_REQUIRED/);

    const open = await openRegistrationContest();
    const r = open.rounds.MOST_ELABORATE;
    await selfRegister(r, await newPerson()); // inside the window, it works
    const ready = await newContest({ registrationOpensAt: inMs(-HOUR), cutoffAt: inMs(2 * HOUR), closesAt: inMs(4 * HOUR) });
    const rr = ready.rounds.MOST_ELABORATE;
    for (let i = 0; i < 2; i++) await completeAtStation(rr, (await selfRegister(rr, await newPerson())).entryId);
    await openCategory(rr);
    const afterOpen = await newPerson();
    await expect(selfRegister(rr, afterOpen)).rejects.toThrow(/CV_PREPARATION_CLOSED/);
    expect((await contestCounts(rr.instanceId)).entries).toBe(2);
  });

  it("is refused without a binding, without a verified email, and without a Gaming profile — the identity is the canonical one, never a typed name", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.SEXIEST;
    const unbound = await newPerson();
    await expect(registerRaw(r.instanceId, unbound.authUserId)).rejects.toThrow(/CV_NOT_BOUND/);

    const noProfile = await newPerson({ member: false });
    await expectCode(repo.bindVoter({ instanceId: r.instanceId, authUserId: noProfile.authUserId }), "PROFILE_INCOMPLETE");
    await expect(registerRaw(r.instanceId, noProfile.authUserId)).rejects.toThrow(/CV_NOT_BOUND/);

    const unverified = await newPerson({ email: "unconfirmed" });
    await expectCode(repo.bindVoter({ instanceId: r.instanceId, authUserId: unverified.authUserId }), "VERIFIED_EMAIL_REQUIRED");

    // verification withdrawn after the binding was made: the registration re-checks it
    const later = await newPerson();
    await repo.bindVoter({ instanceId: r.instanceId, authUserId: later.authUserId });
    await q("update auth.users set email_confirmed_at = null where id = $1", [later.authUserId]);
    await expect(registerRaw(r.instanceId, later.authUserId)).rejects.toThrow(/CV_VERIFIED_EMAIL_REQUIRED/);

    expect(await contestCounts(r.instanceId)).toEqual({ entries: 0, candidacies: 0, registrations: 0, identities: 0 });
  });

  it("refuses a bad name, no age confirmation, a malformed or unconfirmed number, no delivery authorization and malformed versions — each leaving NOTHING behind", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.FUNNIEST;
    const person = await newPerson();
    await repo.bindVoter({ instanceId: r.instanceId, authUserId: person.authUserId });
    const attempts: Array<[string, Parameters<typeof registerArgs>[0], string]> = [
      ["a one-character name", { name: "X" }, "CV_INVALID_REQUEST"],
      ["a blank name", { name: "   " }, "CV_INVALID_REQUEST"],
      ["a 41-character name", { name: "x".repeat(41) }, "CV_INVALID_REQUEST"],
      ["a name with a control character", { name: "Drac\u0007ula" }, "CV_INVALID_REQUEST"],
      ["no age confirmation", { adult: false }, "CV_CONSENT_REQUIRED"],
      ["a number without its country code", { whatsapp: "99887766" }, "CV_INVALID_REQUEST"],
      ["a number with letters", { whatsapp: "+504ABCDEFGH" }, "CV_INVALID_REQUEST"],
      ["a number that is too short", { whatsapp: "+5049988" }, "CV_INVALID_REQUEST"],
      ["a number that is too long", { whatsapp: "+5049988776655443" }, "CV_INVALID_REQUEST"],
      ["a number starting with a zero country code", { whatsapp: "+04999887766" }, "CV_INVALID_REQUEST"],
      ["a number the person did not confirm", { whatsappConfirmed: false }, "CV_CONSENT_REQUIRED"],
      ["no authorization of the delivery", { deliveryAuthorized: false }, "CV_CONSENT_REQUIRED"],
      ["a malformed requirements digest", { requirementsSha256: "abc" }, "CV_INVALID_REQUEST"],
      ["a malformed delivery version", { deliveryVersion: "not a version!" }, "CV_INVALID_REQUEST"],
    ];
    for (const [label, over, code] of attempts) {
      await expect(registerRaw(r.instanceId, person.authUserId, over), label).rejects.toThrow(new RegExp(code));
      expect(await contestCounts(r.instanceId), label).toEqual({ entries: 0, candidacies: 0, registrations: 0, identities: 0 });
    }
    const ok = await registerRaw(r.instanceId, person.authUserId);
    expect(ok.rows).toHaveLength(1); // the same person, now with everything right, registers: the refusals held nothing
  });

  it("is ONCE per person in the whole contest — not twice in a category, not in two categories, not as a contestant and as a group member — and a refusal leaves nothing", async () => {
    const c = await openRegistrationContest();
    const p = await newPerson();
    await selfRegister(c.rounds.MOST_ELABORATE, p);
    const before = await contestCounts(c.rounds.MOST_ELABORATE.instanceId);
    await expect(selfRegister(c.rounds.MOST_ELABORATE, p)).rejects.toThrow(/CV_ALREADY_CANDIDATE/);
    expect(await contestCounts(c.rounds.MOST_ELABORATE.instanceId)).toEqual(before);
    await expect(selfRegister(c.rounds.FUNNIEST, p)).rejects.toThrow(/CV_ALREADY_CANDIDATE/);
    expect(await contestCounts(c.rounds.FUNNIEST.instanceId)).toEqual({ entries: 0, candidacies: 0, registrations: 0, identities: 0 });
    await expect(selfRegister(c.rounds.BEST_GROUP, p)).rejects.toThrow(/CV_ALREADY_CANDIDATE/);

    // a person already attributed to a group cannot register as a contestant
    const g = await group(c.rounds.BEST_GROUP, 2);
    await expect(selfRegister(c.rounds.SEXIEST, g.people[0])).rejects.toThrow(/CV_ALREADY_CANDIDATE/);
    await expect(selfRegister(c.rounds.SEXIEST, g.representative)).rejects.toThrow(/CV_ALREADY_CANDIDATE/);

    // and a registered person cannot be associated, at the station's table, with another entry of the contest
    const other = await repo.createRoundEntry(c.rounds.SEXIEST.ctx);
    await repo.bindVoter({ instanceId: c.rounds.SEXIEST.instanceId, authUserId: p.authUserId });
    await expectCode(contestRepo.claimRoundEntry({ instanceId: c.rounds.SEXIEST.instanceId, authUserId: p.authUserId, claimCode: other.claimCode }), "ALREADY_CANDIDATE");
  });

  it("holds under concurrency: the same person registering in two categories at once gets exactly one candidacy", async () => {
    const c = await openRegistrationContest();
    const p = await newPerson();
    await repo.bindVoter({ instanceId: c.rounds.FUNNIEST.instanceId, authUserId: p.authUserId });
    await repo.bindVoter({ instanceId: c.rounds.SEXIEST.instanceId, authUserId: p.authUserId });
    const results = await Promise.allSettled([registerRaw(c.rounds.FUNNIEST.instanceId, p.authUserId), registerRaw(c.rounds.SEXIEST.instanceId, p.authUserId)]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/CV_ALREADY_CANDIDATE/);
    const [row] = await q<{ n: number }>("select count(*)::int n from community_voting_contest_identities where contest_id = $1 and gaming_member_id = $2", [c.contestId, p.gamingMemberId]);
    expect(row.n).toBe(1);
    const [regs] = await q<{ n: number }>("select count(*)::int n from community_voting_registrations where contest_id = $1", [c.contestId]);
    expect(regs.n).toBe(1);
  });

  it("is released with its entry before Voting opens: an operator who removes it frees the person to register again", async () => {
    const c = await openRegistrationContest();
    const p = await newPerson();
    const first = await selfRegister(c.rounds.MOST_ELABORATE, p);
    await repo.removeRoundEntry({ ...c.rounds.MOST_ELABORATE.ctx, entryId: first.entryId });
    expect(await contestCounts(c.rounds.MOST_ELABORATE.instanceId)).toEqual({ entries: 0, candidacies: 0, registrations: 0, identities: 0 });
    const again = await selfRegister(c.rounds.FUNNIEST, p);
    expect(again.entry_kind).toBe("INDIVIDUAL");
    expect(again.public_code).not.toBe(first.public_code);
  });
});

// ============================================================ the station

describe("the operator's station: search the code, verify the person, take the photograph, approve", () => {
  it("finds a candidacy by its code, however typed, before it is public — in any category of the contest, never in another contest — without any number", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const funny = c.rounds.FUNNIEST;
    const reg = await selfRegister(funny, await newPerson(), { name: "Bruja de Comayagüela" });
    for (const typed of [reg.public_code, reg.public_code.toLowerCase(), reg.public_code.replace("-", ""), ` ${reg.public_code.toLowerCase()} `]) {
      const rows = await find(r, typed);
      expect(rows, typed).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entry_id: reg.entryId, instance_id: funny.instanceId, category_key: "FUNNIEST", entry_kind: "INDIVIDUAL",
        public_code: reg.public_code, public_name: "Bruja de Comayagüela", self_registered: true, has_whatsapp: true, delivery_status: "PENDING", withdrawn: false,
      });
      expect(Object.keys(rows[0]).join(",")).not.toMatch(/whatsapp_e164|phone|email|auth_user/i);
    }
    expect(await find(r, "HAL-22222")).toHaveLength(0); // unknown
    expect(await find(r, "not a code")).toHaveLength(0);

    const elsewhere = await openRegistrationContest();
    expect(await find(elsewhere.rounds.MOST_ELABORATE, reg.public_code)).toHaveLength(0); // another contest does not see it
    await refused("select * from find_community_voting_candidacy_by_code($1, 'wrong', $2, $3)", [r.instanceId, r.ctx.operatorMemberId, reg.public_code], "HOST_TOKEN_MISMATCH");
    await refused("select * from find_community_voting_candidacy_by_code($1, $2, $3, $4)", [r.instanceId, r.ctx.hostToken, (await newPerson()).gamingMemberId, reg.public_code], "CV_OPERATOR_REQUIRED|HOST_TOKEN_MISMATCH");
  });

  it("becomes public only after the person is verified, the photograph is approved and consented, and the association is confirmed — and then by gallery and by code", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const person = await newPerson();
    const reg = await selfRegister(r, person, { name: "Frankenstein Honduras" });

    // an approved photograph alone does not make it public: the person has not been confirmed at the station
    const photo = await approvedPhoto(r, reg.entryId);
    expect(await gallery(r)).toHaveLength(0);
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(0);

    const [done] = await confirm(r, reg.entryId);
    expect(done).toMatchObject({ entry_id: reg.entryId, confirmed: true });
    const [entry] = await q<{ auth_user_id: string }>(
      "select b.auth_user_id from community_voting_entries e join community_voting_voter_bindings b on b.binding_id = e.confirmed_binding_id where e.entry_id = $1", [reg.entryId]);
    expect(entry.auth_user_id).toBe(person.authUserId); // the account that registered is the one associated

    const rows = await gallery(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ public_code: reg.public_code, public_name: "Frankenstein Honduras" });
    expect(Object.keys(rows[0]).sort()).toEqual(["alias", "candidate_id", "ordinal", "public_code", "public_name"]);
    const found = await byCode(c.contestId, reg.public_code.toLowerCase());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category_key: "MOST_ELABORATE", instance_id: r.instanceId, public_code: reg.public_code, public_name: "Frankenstein Honduras" });
    expect(Object.keys(found[0]).sort()).toEqual(["alias", "candidate_id", "category_key", "instance_id", "ordinal", "public_code", "public_name"]);
    expect(await byCode((await openRegistrationContest()).contestId, reg.public_code)).toHaveLength(0);

    // confirming twice changes nothing and is audited once
    await confirm(r, reg.entryId);
    expect(await actionCount(r.instanceId, "CONFIRM_REGISTRATION")).toBe(1);
    expect((await mine(c.contestId, person))[0]).toMatchObject({ state: "PUBLIC" });

    // a hidden photograph or a withdrawn candidacy leaves the gallery and the code lookup at once
    await q("select * from withdraw_community_voting_round_candidature_atomically($1, $2, $3, $4, 'prueba', false)", [...op(r), reg.entryId]);
    expect(await gallery(r)).toHaveLength(0);
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(0);
    expect((await find(r, reg.public_code))[0]).toMatchObject({ withdrawn: true });
    expect((await mine(c.contestId, person))[0]).toMatchObject({ state: "WITHDRAWN" });
    expect(photo.photoId).toBeTruthy();
  });

  it("confirms only a self-registered, not-withdrawn candidacy, only by the designated operator, and only while the ballot can still change", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const operatorMade = await repo.createRoundEntry(r.ctx);
    await refused("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [...op(r), operatorMade.entryId], "CV_WRONG_ENTRY_KIND");
    const reg = await selfRegister(r, await newPerson());
    await refused("select * from confirm_community_voting_registration_atomically($1, 'wrong', $2, $3)", [r.instanceId, r.ctx.operatorMemberId, reg.entryId], "HOST_TOKEN_MISMATCH");
    await refused("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [r.instanceId, r.ctx.hostToken, (await newPerson()).gamingMemberId, reg.entryId], "CV_OPERATOR_REQUIRED|HOST_TOKEN_MISMATCH");
    // an entry of another round
    await refused("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [...op(c.rounds.FUNNIEST), reg.entryId], "CV_WRONG_ENTRY_KIND");

    await q("select * from withdraw_community_voting_round_candidature_atomically($1, $2, $3, $4, 'prueba', false)", [...op(r), reg.entryId]);
    await refused("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [...op(r), reg.entryId], "CV_ENTRY_ALREADY_WITHDRAWN");

    // after opening, nothing about the ballot changes
    const ready = await individualReady(c.rounds.FUNNIEST);
    await individualReady(c.rounds.FUNNIEST);
    await openCategory(c.rounds.FUNNIEST);
    const late = await q<{ entry_id: string }>("select entry_id from community_voting_entries where instance_id = $1 limit 1", [c.rounds.FUNNIEST.instanceId]);
    await refused("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [...op(c.rounds.FUNNIEST), late[0].entry_id], "CV_PREPARATION_CLOSED|CV_WRONG_ENTRY_KIND");
    await refused("select * from correct_community_voting_candidacy_name_atomically($1, $2, $3, $4, 'Otro')", [...op(c.rounds.FUNNIEST), ready.entryId], "CV_PREPARATION_CLOSED");
  });

  it("verifies and corrects the public name at the station — before Voting opens only, audited, and never through the table", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.SEXIEST;
    const reg = await selfRegister(r, await newPerson(), { name: "Vampira" });
    const [renamed] = await rename(r, reg.entryId, "  Vampiresa de Olancho ");
    expect(renamed).toMatchObject({ entry_id: reg.entryId, public_name: "Vampiresa de Olancho" });
    expect((await find(r, reg.public_code))[0]).toMatchObject({ public_name: "Vampiresa de Olancho" });
    expect(await actionCount(r.instanceId, "CORRECT_NAME")).toBe(1);
    await refused("select * from correct_community_voting_candidacy_name_atomically($1, $2, $3, $4, 'X')", [...op(r), reg.entryId], "CV_INVALID_REQUEST");
    await refused("select * from correct_community_voting_candidacy_name_atomically($1, 'wrong', $2, $3, 'Valida')", [r.instanceId, r.ctx.operatorMemberId, reg.entryId], "HOST_TOKEN_MISMATCH");
    await refused("select * from correct_community_voting_candidacy_name_atomically($1, $2, $3, $4, 'Valida')", [...op(r), (await repo.createRoundEntry(c.rounds.FUNNIEST.ctx)).entryId], "CV_ENTRY_NOT_FOUND");
    await refused("update community_voting_candidacies set public_name = 'Directo' where entry_id = $1", [reg.entryId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    const [unchanged] = await q<{ public_name: string }>("select public_name from community_voting_candidacies where entry_id = $1", [reg.entryId]);
    expect(unchanged.public_name).toBe("Vampiresa de Olancho");
  });

  it("shows the operator the structure with the code, the name, whether it was self-registered and how its delivery stands — never a number", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const own = await selfRegister(r, await newPerson(), { name: "Zombi" });
    const manual = await repo.createRoundEntry(r.ctx);
    const rows = await structure(r);
    const byEntry = (id: string) => rows.find((x) => x.entry_id === id) as Record<string, unknown>;
    expect(byEntry(own.entryId)).toMatchObject({ public_code: own.public_code, public_name: "Zombi", self_registered: true, has_whatsapp: true, delivery_status: "PENDING", entry_kind: "INDIVIDUAL" });
    expect(byEntry(manual.entryId)).toMatchObject({ public_name: null, self_registered: false, has_whatsapp: false, delivery_status: null });
    expect(byEntry(manual.entryId).public_code).toMatch(/^HAL-/);
    expect(Object.keys(rows[0]).join(",")).not.toMatch(/whatsapp_e164|phone|email|auth_user/i);
  });
});

// ============================================================ groups

describe("a self-registered group: the representative registers, the operator attributes the members, and the group is public only when complete", () => {
  it("is public only when every person in the photograph is associated and has consented — the representative's registration does not shortcut it", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.BEST_GROUP;
    const rep = await newPerson();
    const reg = await selfRegister(r, rep, { name: "Los Intocables" });
    const photo = await completeAtStation(r, reg.entryId);
    // the representative alone: a group needs at least one attributed member
    expect(await gallery(r)).toHaveLength(0);
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(0);

    const m1 = await createMember(r, reg.entryId);
    const m2 = await createMember(r, reg.entryId);
    const p1 = await associate(r, m1.entryId, m1.claimCode);
    const p2 = await associate(r, m2.entryId, m2.claimCode);
    await memberConsent(r, m1.entryId, photo.photoId);
    expect(await gallery(r)).toHaveLength(0); // one member has not consented yet
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(0);
    await memberConsent(r, m2.entryId, photo.photoId);

    const rows = await gallery(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ public_code: reg.public_code, public_name: "Los Intocables" });
    expect(await byCode(c.contestId, reg.public_code)).toHaveLength(1);
    expect((await structure(r)).filter((x) => x.entry_kind === "GROUP_MEMBER").every((m) => m.public_code === null)).toBe(true);

    // each member sees the group they belong to, and their role — never the representative's number
    const seen = await mine(c.contestId, p1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ role: "MEMBER", entry_kind: "GROUP", public_code: reg.public_code, public_name: "Los Intocables", state: "PUBLIC", delivery_status: null });
    expect((await mine(c.contestId, rep))[0]).toMatchObject({ role: "REPRESENTATIVE", delivery_status: "PENDING" });
    expect(p2.authUserId).not.toBe(p1.authUserId);
  });
});

// ============================================================ WhatsApp: private, manual, never an identity

describe("the WhatsApp number: private, delivered by hand, and never an identity", () => {
  async function scanForNumber(whatsapp: string): Promise<string[]> {
    const digits = whatsapp.replace(/\D/g, "");
    const tables = await q<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name");
    const hits: string[] = [];
    for (const t of tables) {
      const [row] = await q<{ n: number }>(`select count(*)::int n from public."${t.table_name}" x where x::text like $1`, [`%${digits}%`]);
      if (row.n > 0) hits.push(t.table_name);
    }
    return hits;
  }

  it("lives in ONE table and appears in no other table of the database — not in the entry, the candidacy, the audit log, the identity, the binding, the Session or the vote", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const person = await newPerson();
    const reg = await selfRegister(r, person);
    await completeAtStation(r, reg.entryId);
    await completeAtStation(r, (await selfRegister(r, await newPerson())).entryId);
    await contact(r, reg.entryId); // the one read that returns it is audited
    await delivered(r, reg.entryId);
    await openCategory(r);
    const cands = await candidatesOf(r);
    await castVote(r, await newPerson(), cands[0].candidateId);
    expect(await scanForNumber(reg.whatsapp)).toEqual(["community_voting_registrations"]);
  });

  it("is returned by exactly one operation — the designated operator's contact read — and by no public, voter, search, structure or listing operation", async () => {
    const fns = await q<{ proname: string; result: string }>(
      `select p.proname, pg_get_function_result(p.oid) result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like '%community_voting%') and pg_get_function_result(p.oid) ~* '(whatsapp_e164|phone|msisdn|contact_number|e164)'`);
    expect(fns.map((f) => f.proname)).toEqual(["read_community_voting_registration_contact"]);

    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const person = await newPerson();
    const reg = await selfRegister(r, person);
    await completeAtStation(r, reg.entryId);
    const digits = reg.whatsapp.replace(/\D/g, "");
    const outputs: unknown[] = [
      await gallery(r),
      await byCode(c.contestId, reg.public_code),
      await find(r, reg.public_code),
      await structure(r),
      await mine(c.contestId, person),
      await q("select * from read_community_voting_contest_categories($1)", [c.contestId]),
      await q("select * from read_community_voting_featured_contest()"),
      await q("select * from read_community_voting_round_public_info($1)", [r.instanceId]),
      await q("select * from read_community_voting_round_public_results($1)", [r.instanceId]),
    ];
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain(digits);

    const [row] = await contact(r, reg.entryId);
    expect(row).toEqual({ whatsapp_e164: reg.whatsapp, delivery_status: "PENDING" });
    // audited — the entry, never the number
    const log = await q<{ detail: unknown }>("select detail from community_voting_operator_actions where instance_id = $1 and action = 'READ_CONTACT'", [r.instanceId]);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(digits);
  });

  it("is read only with the contest's host token and designated operator, and only for a self-registered candidacy", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const reg = await selfRegister(r, await newPerson());
    await refused("select * from read_community_voting_registration_contact($1, 'wrong', $2, $3)", [r.instanceId, r.ctx.operatorMemberId, reg.entryId], "HOST_TOKEN_MISMATCH");
    await refused("select * from read_community_voting_registration_contact($1, $2, $3, $4)", [r.instanceId, r.ctx.hostToken, (await newPerson()).gamingMemberId, reg.entryId], "CV_OPERATOR_REQUIRED|HOST_TOKEN_MISMATCH");
    await refused("select * from read_community_voting_registration_contact($1, $2, $3, $4)", [...op(r), (await repo.createRoundEntry(r.ctx)).entryId], "CV_WRONG_ENTRY_KIND");
    await refused("select * from read_community_voting_registration_contact($1, $2, $3, $4)", [...op(c.rounds.FUNNIEST), reg.entryId], "CV_WRONG_ENTRY_KIND");
    expect(await actionCount(r.instanceId, "READ_CONTACT")).toBe(0); // refusals are not reads
  });

  it("is never a key and never an identity: two people may share a number, in the same category, and neither is refused for it", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.FUNNIEST;
    const shared = syntheticWhatsapp();
    const a = await selfRegister(r, await newPerson(), { whatsapp: shared, name: "Hermana Mayor" });
    const b = await selfRegister(r, await newPerson(), { whatsapp: shared, name: "Hermano Menor" });
    expect(a.entryId).not.toBe(b.entryId);
    const rows = await q("select 1 from community_voting_registrations where whatsapp_e164 = $1", [shared]);
    expect(rows).toHaveLength(2);
    const uniques = await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'community_voting_registrations' and indexdef ilike 'create unique%'");
    expect(uniques.map((u) => u.indexdef).join("\n")).not.toMatch(/whatsapp/);
    // and it takes no part in who may vote: both complete, both on the ballot, a third person's vote counts as any other
    await completeAtStation(r, a.entryId);
    await completeAtStation(r, b.entryId);
    await openCategory(r);
    const cands = await candidatesOf(r);
    expect(cands).toHaveLength(2);
    expect((await castVote(r, await newPerson(), cands[0].candidateId)).outcome).toBe("APPLIED");
  });

  it("is delivered BY HAND: pending until the operator says so, 'delivered' only by that explicit act, idempotent, audited, and never edited", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.SEXIEST;
    const reg = await selfRegister(r, await newPerson());
    expect((await find(r, reg.public_code))[0]).toMatchObject({ delivery_status: "PENDING" });
    await contact(r, reg.entryId); // opening WhatsApp / reading the number records NOTHING about delivery
    expect((await find(r, reg.public_code))[0]).toMatchObject({ delivery_status: "PENDING" });
    const [row] = await q<Record<string, unknown>>("select delivery_status, delivered_at, delivered_by_member_id from community_voting_registrations where entry_id = $1", [reg.entryId]);
    expect(row).toEqual({ delivery_status: "PENDING", delivered_at: null, delivered_by_member_id: null });

    const [done] = await delivered(r, reg.entryId);
    expect(done).toMatchObject({ entry_id: reg.entryId, delivery_status: "DELIVERED" });
    expect(done.delivered_at).toBeTruthy();
    const [after] = await q<Record<string, unknown>>("select delivery_status, delivered_by_member_id from community_voting_registrations where entry_id = $1", [reg.entryId]);
    expect(after).toEqual({ delivery_status: "DELIVERED", delivered_by_member_id: r.ctx.operatorMemberId });
    const [again] = await delivered(r, reg.entryId);
    expect(again.delivered_at).toEqual(done.delivered_at); // idempotent: nothing is rewritten
    expect(await actionCount(r.instanceId, "MARK_DELIVERED")).toBe(1);

    // through the table: no direct "delivered", no edit of the number or of anything else, no delete
    const other = await selfRegister(r, await newPerson());
    await refused("update community_voting_registrations set delivery_status = 'DELIVERED', delivered_at = now(), delivered_by_member_id = $2 where entry_id = $1", [other.entryId, r.ctx.operatorMemberId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("update community_voting_registrations set whatsapp_e164 = '+50411112222' where entry_id = $1", [other.entryId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
    await refused("update community_voting_registrations set delivery_status = 'PENDING', delivered_at = null, delivered_by_member_id = null where entry_id = $1", [reg.entryId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("delete from community_voting_registrations where entry_id = $1", [other.entryId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("truncate community_voting_registrations", [], "COMMUNITY_VOTING");
    await refused("select * from mark_community_voting_registration_delivered_atomically($1, 'wrong', $2, $3)", [r.instanceId, r.ctx.operatorMemberId, other.entryId], "HOST_TOKEN_MISMATCH");
    await refused("select * from mark_community_voting_registration_delivered_atomically($1, $2, $3, $4)", [...op(r), (await repo.createRoundEntry(r.ctx)).entryId], "CV_WRONG_ENTRY_KIND");
  });

  it("blocks neither the candidacy nor the vote: a pending delivery changes nothing about who is on the ballot or who wins", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const regs = [];
    for (let i = 0; i < 3; i++) regs.push(await selfRegister(r, await newPerson(), { name: `Concursante ${i + 1}` }));
    for (const x of regs) await completeAtStation(r, x.entryId);
    expect((await q("select 1 from community_voting_registrations where instance_id = $1 and delivery_status = 'PENDING'", [r.instanceId]))).toHaveLength(3);
    await openCategory(r); // opens with every delivery still pending
    const cands = await candidatesOf(r);
    expect(cands).toHaveLength(3);
    for (let i = 0; i < 4; i++) await castVote(r, await newPerson(), cands[1].candidateId);
    const [{ n }] = await q<{ n: string }>("select count(*) n from votes where interaction_instance_id = $1", [r.interactionInstanceId]);
    expect(Number(n)).toBe(4);
  });

  it("is authorized separately — its own version and digest — from the photograph's consent, and from anything promotional", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const reg = await selfRegister(r, await newPerson(), { requirementsVersion: "req-A", deliveryVersion: "del-B" });
    const [row] = await q<Record<string, unknown>>("select requirements_version, requirements_sha256, delivery_version, delivery_sha256 from community_voting_registrations where entry_id = $1", [reg.entryId]);
    expect(row).toMatchObject({ requirements_version: "req-A", delivery_version: "del-B" });
    expect(row.requirements_sha256).not.toBe(row.delivery_sha256);
    // registering recorded no photograph consent and no promotional consent
    expect(await q("select 1 from community_voting_entry_consents ec join community_voting_entry_photos p on p.photo_id = ec.photo_id where p.entry_id = $1", [reg.entryId])).toHaveLength(0);
    expect(await q("select 1 from community_voting_promo_consents where entry_id = $1", [reg.entryId])).toHaveLength(0);
    // and the photograph's own consent is still what makes the photograph public: the delivery authorization cannot stand in for it
    const photo = await q<{ photo_id: string }>("select photo_id from community_voting_entry_photos where entry_id = $1", [reg.entryId]);
    expect(photo).toHaveLength(0);
  });
});

// ============================================================ self-vote, gallery filters and exposure

describe("a self-registered contestant votes like anyone — except for themselves", () => {
  it("cannot vote for their own candidacy, nor can a self-registered representative or a member vote for their group; a pending delivery is irrelevant", async () => {
    const c = await openRegistrationContest();
    const solo = c.rounds.FUNNIEST;
    const me = await newPerson();
    const mine1 = await selfRegister(solo, me);
    const other = await selfRegister(solo, await newPerson());
    await completeAtStation(solo, mine1.entryId);
    await completeAtStation(solo, other.entryId);
    await openCategory(solo);
    const cands = await candidatesOf(solo);
    const ownCandidate = cands.find((x) => x.entryId === mine1.entryId)!;
    const otherCandidate = cands.find((x) => x.entryId === other.entryId)!;
    await expect(castVote(solo, me, ownCandidate.candidateId)).rejects.toThrow();
    expect((await castVote(solo, me, otherCandidate.candidateId)).outcome).toBe("APPLIED"); // someone else's costume: fine

    const gr = c.rounds.BEST_GROUP;
    const rep = await newPerson();
    const g = await selfRegister(gr, rep, { name: "Grupo Propio" });
    const photo = await completeAtStation(gr, g.entryId);
    const m = await createMember(gr, g.entryId);
    const member = await associate(gr, m.entryId, m.claimCode);
    await memberConsent(gr, m.entryId, photo.photoId);
    await group(gr, 1); // a ballot has at least two candidacies
    await openCategory(gr);
    const groupCandidate = (await candidatesOf(gr)).find((x) => x.entryId === g.entryId)!;
    await expect(castVote(gr, rep, groupCandidate.candidateId)).rejects.toThrow();
    await expect(castVote(gr, member, groupCandidate.candidateId)).rejects.toThrow();
    expect((await castVote(gr, await newPerson(), groupCandidate.candidateId)).outcome).toBe("APPLIED");
  });

  it("keeps the category from opening while a registration is unverified — the operator removes it or completes it; opening never drops anyone silently", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const complete = await selfRegister(r, await newPerson(), { name: "Completa" });
    const alsoComplete = await selfRegister(r, await newPerson(), { name: "Tambien completa" });
    const noShow = await selfRegister(r, await newPerson(), { name: "No llego" });
    await completeAtStation(r, complete.entryId);
    await completeAtStation(r, alsoComplete.entryId);

    await expect(openCategory(r)).rejects.toThrow(/CV_PREPARATION_INCOMPLETE/);
    const [still] = await q<{ n: string }>("select count(*) n from interaction_instances ii join community_voting_instances i on i.session_id = ii.session_id where i.instance_id = $1", [r.instanceId]);
    expect(Number(still.n)).toBe(0); // nothing opened, nothing dropped

    // the operator decides: the person did not come, so the registration is removed (it has no photograph) and the person is free again
    await repo.removeRoundEntry({ ...r.ctx, entryId: noShow.entryId });
    await openCategory(r);
    const cands = await candidatesOf(r);
    expect(cands.map((x) => x.entryId).sort()).toEqual([complete.entryId, alsoComplete.entryId].sort());
  });
});

describe("exposure: only the server's service role reaches these tables and operations", () => {
  const FUNCTIONS = [
    "community_voting_new_public_code()",
    "community_voting_candidacy_create()",
    "community_voting_guard_candidacies()",
    "community_voting_guard_registrations()",
    "community_voting_registration_release()",
    "community_voting_normalize_public_code(text)",
    "register_community_voting_candidacy_atomically(uuid, uuid, text, boolean, text, text, text, boolean, text, text, boolean)",
    "read_community_voting_my_candidacy(uuid, uuid)",
    "read_community_voting_category_gallery(uuid)",
    "read_community_voting_candidacy_by_code(uuid, text)",
    "find_community_voting_candidacy_by_code(uuid, text, uuid, text)",
    "read_community_voting_category_structure(uuid, text, uuid)",
    "confirm_community_voting_registration_atomically(uuid, text, uuid, uuid)",
    "read_community_voting_registration_contact(uuid, text, uuid, uuid)",
    "mark_community_voting_registration_delivered_atomically(uuid, text, uuid, uuid)",
    "correct_community_voting_candidacy_name_atomically(uuid, text, uuid, uuid, text)",
  ];

  it("grants the new operations to no one but the server: anon, authenticated and PUBLIC cannot execute any of them", async () => {
    for (const fn of FUNCTIONS) {
      const [row] = await q<{ anon: boolean; authenticated: boolean; service: boolean }>(
        "select has_function_privilege('anon', $1::regprocedure, 'execute') anon, has_function_privilege('authenticated', $1::regprocedure, 'execute') authenticated, has_function_privilege('service_role', $1::regprocedure, 'execute') service", [fn]);
      expect(row, fn).toEqual({ anon: false, authenticated: false, service: true });
    }
  });

  it("keeps both tables behind row-level security with no privilege for anon or authenticated, and no way for the server to edit a number or a code", async () => {
    for (const t of ["community_voting_candidacies", "community_voting_registrations"]) {
      const [row] = await q<{ rls: boolean; anon: boolean; auth: boolean }>(
        `select c.relrowsecurity rls,
                has_table_privilege('anon', $1, 'select,insert,update,delete') anon,
                has_table_privilege('authenticated', $1, 'select,insert,update,delete') auth
         from pg_class c where c.oid = $1::regclass`, [t]);
      expect(row, t).toEqual({ rls: true, anon: false, auth: false });
      const [anyCol] = await q<{ ok: boolean }>("select (has_table_privilege('anon', $1, 'select') or has_table_privilege('authenticated', $1, 'select')) ok", [t]);
      expect(anyCol.ok).toBe(false);
    }
    const [cols] = await q<{ number_edit: boolean; code_edit: boolean; name_edit: boolean; delivery_edit: boolean }>(
      `select has_column_privilege('service_role', 'community_voting_registrations', 'whatsapp_e164', 'update') number_edit,
              has_column_privilege('service_role', 'community_voting_candidacies', 'public_code', 'update') code_edit,
              has_column_privilege('service_role', 'community_voting_candidacies', 'public_name', 'update') name_edit,
              has_column_privilege('service_role', 'community_voting_registrations', 'delivery_status', 'update') delivery_edit`);
    expect(cols).toEqual({ number_edit: false, code_edit: false, name_edit: true, delivery_edit: true });
  });
});

/** An individual entry made by the operator, with its photograph approved and its person associated — a ready candidate (used to open a round). */
async function individualReady(r: CatRound) {
  const entry = await repo.createRoundEntry(r.ctx);
  await approvedPhoto(r, entry.entryId);
  await associate(r, entry.entryId, entry.claimCode);
  return entry;
}
