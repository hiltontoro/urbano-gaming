import { afterAll, describe, expect, it, vi } from "vitest";

import { inMs, newPerson, photoArgs, pool, q, repo, sessionRepo, sleep, supabaseUrl } from "./helpers/roundsFixtures";
import {
  CATEGORY_KEYS,
  INDIVIDUAL_KEYS,
  approvedPhoto,
  associate,
  candidatesOf,
  castMany,
  castVote,
  categoryResults,
  closeCategory,
  closedCategory,
  consent,
  createGroup,
  createMember,
  group,
  individual,
  individuals,
  lock,
  memberConsent,
  newContest,
  openCategory,
  publicWinners,
  publishCategory,
  registerCategory,
  reviewCategory,
  votesIn,
} from "./helpers/categoryFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback (the shared fixtures apply the same guard; the registry test requires the explicit call).
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-018 — the four-category, single-round contest, against REAL local Postgres (isolated loopback stack).
 *
 * The contest's rules are the database's: these tests call the new operations through SQL, so they stand independently of the TypeScript layer.
 * Written BEFORE the TypeScript that wraps the operations; they were run against the schema WITHOUT the three contest migrations first (red) and
 * then with them (green): see the implementation record.
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 180_000 });

const sqlOp = (text: string, ...params: unknown[]) => q(text, params);
/** A refusal by the database (a function or a table guard): the statement fails and its message matches. `pattern` is a regular expression source. */
async function refused(sql: string, params: unknown[], pattern: string) {
  await expect(pool.query(sql, params)).rejects.toThrow(new RegExp(pattern));
}

// ============================================================ registration, isolation, kinds

describe("the contest: four category rounds, each its own Session", () => {
  it("registers the four categories of ONE contest, each with its own Session and no venue, no test flag and no second round", async () => {
    const c = await newContest();
    const rows = await q<{ category_key: string; instance_id: string; listed: boolean }>("select * from read_community_voting_contest_categories($1)", [c.contestId]);
    expect(rows.map((r) => r.category_key)).toEqual([...CATEGORY_KEYS]);
    expect(rows.every((r) => r.listed === false)).toBe(true);
    const [sessions] = await q<{ n: number }>(
      "select count(distinct i.session_id)::int n from community_voting_instances i join community_voting_category_rounds cr on cr.instance_id = i.instance_id where cr.contest_id = $1",
      [c.contestId]
    );
    expect(sessions.n).toBe(4);
    for (const r of Object.values(c.rounds)) {
      const [i] = await q<Record<string, unknown>>("select ballot_mode, round_role, venue_latitude, venue_longitude, venue_radius_meters, window_seconds, source_instance_id, is_test from community_voting_instances where instance_id = $1", [r.instanceId]);
      expect(i).toMatchObject({ ballot_mode: "FAVORITE_ROUND", round_role: "PRELIMINARY", venue_latitude: null, venue_longitude: null, venue_radius_meters: null, window_seconds: null, source_instance_id: null, is_test: false });
    }
  });

  it("refuses a category twice, an unknown category, another operator, a wrong host token and a direct write of a category row", async () => {
    const c = await newContest();
    await expect(registerCategory(c.operator, "FUNNIEST", c.contestId)).rejects.toThrow(/CV_CATEGORY_ALREADY_REGISTERED/);
    await expect(registerCategory(c.operator, "BEST_COUPLE" as never, c.contestId)).rejects.toThrow(/CV_INVALID_REQUEST/);
    await expect(registerCategory(await newPerson(), "SEXIEST", c.contestId)).rejects.toThrow(/CV_OPERATOR_REQUIRED|CV_CATEGORY_ALREADY_REGISTERED/);
    await expect(sqlOp("select * from register_community_voting_category_round_atomically($1, 'x', $2, 1, $3, 'FUNNIEST')", c.rounds.FUNNIEST.session.sessionId, c.operator.gamingMemberId, randomContest())).rejects.toThrow(/CV_CONTEST_NOT_FOUND/);
    const solo = await registerCategory(c.operator, "FUNNIEST", null);
    expect(solo.contestId).not.toBe(c.contestId);
    await refused(
      "insert into community_voting_category_rounds (instance_id, contest_id, category_key) values ($1, $2, 'FUNNIEST')",
      [solo.instanceId, c.contestId],
      "COMMUNITY_VOTING_ROUND_PATH_REQUIRED"
    );
    await refused("update community_voting_category_rounds set category_key = 'SEXIEST' where instance_id = $1", [solo.instanceId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
    await refused("delete from community_voting_category_rounds where instance_id = $1", [solo.instanceId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
  });

  it("refuses a registration with a stranger's host token, and a contest whose operator differs from the round's", async () => {
    const c = await newContest();
    const other = await newPerson();
    // a round registered by another operator can never be attached to this contest
    await expect(registerCategory(other, "SEXIEST", c.contestId)).rejects.toThrow(/CV_OPERATOR_REQUIRED|CV_CATEGORY_ALREADY_REGISTERED/);
    const lonely = await registerCategory(other, "SEXIEST", null);
    await refused(
      "update community_voting_contests set operator_gaming_member_id = $1 where contest_id = $2",
      [c.operator.gamingMemberId, lonely.contestId],
      "COMMUNITY_VOTING_HISTORY_IMMUTABLE"
    );
  });

  it("keeps each category's entries, candidates, votes and tally to itself", async () => {
    const c = await newContest();
    const a = c.rounds.MOST_ELABORATE;
    const b = c.rounds.SEXIEST;
    await individuals(a, 2);
    await individuals(b, 2);
    await openCategory(a);
    await openCategory(b);
    const ca = await candidatesOf(a);
    const cb = await candidatesOf(b);
    expect(new Set([...ca, ...cb].map((x) => x.candidateId)).size).toBe(4);
    const voter = await newPerson();
    await castVote(a, voter, ca[0].candidateId);
    expect(await votesIn(a)).toBe(1);
    expect(await votesIn(b)).toBe(0);
    // a candidate of one category cannot be chosen in another
    await expect(castVote(b, voter, ca[0].candidateId)).rejects.toThrow(/INVALID_CANDIDATE_SELECTION/);
    // closing one category leaves the others open
    const late = await newPerson();
    await repo.bindVoter({ instanceId: a.instanceId, authUserId: late.authUserId });
    await closeCategory(a);
    await castVote(b, voter, cb[1].candidateId);
    expect(await votesIn(b)).toBe(1);
    await expect(castVote(a, late, ca[1].candidateId)).rejects.toThrow(/Voting is not open|CV_VOTING_NOT_OPEN/);
  });
});

describe("candidacy kinds: individuals in three categories, groups in the group category", () => {
  it("takes a group only in BEST_GROUP and an individual only outside it — in the function and in the table", async () => {
    const c = await newContest();
    const grp = c.rounds.BEST_GROUP;
    await refused("select * from create_community_voting_round_entry_atomically($1, $2, $3, 900)", [grp.instanceId, grp.ctx.hostToken, grp.ctx.operatorMemberId], "CV_WRONG_CATEGORY");
    for (const k of INDIVIDUAL_KEYS) {
      const r = c.rounds[k];
      await refused("select * from create_community_voting_group_entry_atomically($1, $2, $3, 900)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_WRONG_CATEGORY");
      await refused(
        "insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at, entry_kind) values ($1, 99, '#9999', 900, now() + interval '1 hour', 'GROUP')",
        [r.instanceId],
        "CV_WRONG_CATEGORY|COMMUNITY_VOTING_ROUND_PATH_REQUIRED"
      );
    }
  });

  it("takes a member only under a GROUP entry of the same Instance, and at most thirty of them", async () => {
    const c = await newContest();
    const grp = c.rounds.BEST_GROUP;
    const ind = c.rounds.SEXIEST;
    const entry = await repo.createRoundEntry(ind.ctx);
    await refused("select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)", [ind.instanceId, ind.ctx.hostToken, ind.ctx.operatorMemberId, entry.entryId], "CV_WRONG_ENTRY_KIND");
    const g = await createGroup(grp);
    await refused("select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)", [grp.instanceId, grp.ctx.hostToken, grp.ctx.operatorMemberId, entry.entryId], "CV_ENTRY_NOT_FOUND");
    for (let i = 0; i < 30; i++) await createMember(grp, g.entryId);
    await refused("select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)", [grp.instanceId, grp.ctx.hostToken, grp.ctx.operatorMemberId, g.entryId], "CV_GROUP_FULL");
  });

  it("never lets an entry change its kind or its group", async () => {
    const c = await newContest();
    const grp = c.rounds.BEST_GROUP;
    const g = await createGroup(grp);
    const m = await createMember(grp, g.entryId);
    await refused("update community_voting_entries set entry_kind = 'GROUP' where entry_id = $1", [m.entryId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE|COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("update community_voting_entries set group_entry_id = null where entry_id = $1", [m.entryId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE|COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
  });
});

// ============================================================ one candidacy per person

describe("one candidacy per person, in one category (the database's own rule)", () => {
  it("refuses a second claim by a person who already belongs to a candidacy, and leaves the credential intact", async () => {
    const c = await newContest();
    const p = await newPerson();
    await individual(c.rounds.MOST_ELABORATE, p);
    const other = await repo.createRoundEntry(c.rounds.SEXIEST.ctx);
    await repo.bindVoter({ instanceId: c.rounds.SEXIEST.instanceId, authUserId: p.authUserId });
    await refused("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [c.rounds.SEXIEST.instanceId, p.authUserId, other.claimCode], "CV_ALREADY_CANDIDATE");
    const [row] = await q<{ claim_code_hash: string | null; pending_binding_id: string | null }>("select claim_code_hash, pending_binding_id from community_voting_entries where entry_id = $1", [other.entryId]);
    expect(row.claim_code_hash).not.toBeNull();
    expect(row.pending_binding_id).toBeNull();
    const ids = await q("select role from community_voting_contest_identities where contest_id = $1 and gaming_member_id = $2", [c.contestId, p.gamingMemberId]);
    expect(ids).toEqual([{ role: "INDIVIDUAL" }]);
  });

  it("holds the rule across ROLES: an individual cannot be a group's member or representative, and a member cannot be anything else", async () => {
    const c = await newContest();
    const grp = c.rounds.BEST_GROUP;
    const asIndividual = await newPerson();
    await individual(c.rounds.FUNNIEST, asIndividual);
    const g = await createGroup(grp);
    const m = await createMember(grp, g.entryId);
    await repo.bindVoter({ instanceId: grp.instanceId, authUserId: asIndividual.authUserId });
    await refused("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [grp.instanceId, asIndividual.authUserId, m.claimCode], "CV_ALREADY_CANDIDATE");
    await refused("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [grp.instanceId, asIndividual.authUserId, g.claimCode], "CV_ALREADY_CANDIDATE");
    // a person who is a member of one group cannot be the representative of another group, nor a member of it
    const memberPerson = await associate(grp, m.entryId, m.claimCode);
    const g2 = await createGroup(grp);
    const m2 = await createMember(grp, g2.entryId);
    // inside ONE Instance the pilot's own rule answers (an identity holds at most one entry per ballot): an outcome, not an exception
    for (const code of [g2.claimCode, m2.claimCode]) {
      const [claim] = await q<{ outcome: string }>("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [grp.instanceId, memberPerson.authUserId, code]);
      expect(claim.outcome).toBe("CONTESTANT_ALREADY_HAS_ENTRY");
    }
    const roles = await q<{ role: string }>("select role from community_voting_contest_identities where contest_id = $1 order by role", [c.contestId]);
    expect(roles.map((r) => r.role)).toEqual(["INDIVIDUAL", "MEMBER"]);
  });

  it("settles a race between two confirmations of the same person: exactly one candidacy", async () => {
    const c = await newContest();
    const p = await newPerson();
    const e1 = await repo.createRoundEntry(c.rounds.MOST_ELABORATE.ctx);
    const e2 = await repo.createRoundEntry(c.rounds.SEXIEST.ctx);
    const claimed: Record<string, { confirmationCode: string }> = {};
    for (const [r, e] of [[c.rounds.MOST_ELABORATE, e1], [c.rounds.SEXIEST, e2]] as const) {
      await repo.bindVoter({ instanceId: r.instanceId, authUserId: p.authUserId });
      claimed[e.entryId] = await repo.claimRoundEntry({ instanceId: r.instanceId, authUserId: p.authUserId, claimCode: e.claimCode });
    }
    const confirm = (r: typeof c.rounds.SEXIEST, e: typeof e1) =>
      q("select * from confirm_community_voting_round_entry_atomically($1, $2, $3, $4, $5)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, e.entryId, claimed[e.entryId].confirmationCode]);
    const outcomes = await Promise.allSettled([confirm(c.rounds.MOST_ELABORATE, e1), confirm(c.rounds.SEXIEST, e2)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/CV_ALREADY_CANDIDATE/);
    const [n] = await q<{ n: number }>("select count(*)::int n from community_voting_contest_identities where contest_id = $1 and gaming_member_id = $2", [c.contestId, p.gamingMemberId]);
    expect(n.n).toBe(1);
    const [confirmed] = await q<{ n: number }>("select count(*)::int n from community_voting_entries where entry_id in ($1, $2) and confirmed_binding_id is not null", [e1.entryId, e2.entryId]);
    expect(confirmed.n).toBe(1);
  });

  it("frees a person when an unphotographed entry is removed, but not when the candidacy is withdrawn", async () => {
    const c = await newContest();
    const a = c.rounds.MOST_ELABORATE;
    const b = c.rounds.SEXIEST;
    const p = await newPerson();
    const e = await repo.createRoundEntry(a.ctx);
    await associate(a, e.entryId, e.claimCode, p);
    await repo.bindVoter({ instanceId: b.instanceId, authUserId: p.authUserId });
    await refused("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [b.instanceId, p.authUserId, (await repo.createRoundEntry(b.ctx)).claimCode], "CV_ALREADY_CANDIDATE");
    await sqlOp("select * from remove_community_voting_round_entry_atomically($1, $2, $3, $4)", a.instanceId, a.ctx.hostToken, a.ctx.operatorMemberId, e.entryId);
    const free = await repo.createRoundEntry(b.ctx);
    await associate(b, free.entryId, free.claimCode, p);
    expect((await q("select 1 from community_voting_contest_identities where contest_id = $1 and gaming_member_id = $2", [c.contestId, p.gamingMemberId])).length).toBe(1);
    // a withdrawal keeps the identity: the person does not get another candidacy
    await approvedPhoto(b, free.entryId);
    await sqlOp("select * from withdraw_community_voting_round_candidature_atomically($1, $2, $3, $4, 'left', false)", b.instanceId, b.ctx.hostToken, b.ctx.operatorMemberId, free.entryId);
    const third = await repo.createRoundEntry(c.rounds.FUNNIEST.ctx);
    await repo.bindVoter({ instanceId: c.rounds.FUNNIEST.instanceId, authUserId: p.authUserId });
    await refused("select * from claim_community_voting_round_entry_atomically($1, $2, $3)", [c.rounds.FUNNIEST.instanceId, p.authUserId, third.claimCode], "CV_ALREADY_CANDIDATE");
  });

  it("writes and removes identities only with their entries (a direct write or edit is refused, for every writer)", async () => {
    const c = await newContest();
    const { person, entry } = await individual(c.rounds.MOST_ELABORATE);
    await refused(
      "insert into community_voting_contest_identities (contest_id, gaming_member_id, instance_id, entry_id, role) values ($1, $2, $3, $4, 'INDIVIDUAL')",
      [c.contestId, (await newPerson()).gamingMemberId, c.rounds.MOST_ELABORATE.instanceId, entry.entryId],
      "COMMUNITY_VOTING_ROUND_PATH_REQUIRED"
    );
    await refused("delete from community_voting_contest_identities where gaming_member_id = $1", [person.gamingMemberId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await refused("update community_voting_contest_identities set role = 'MEMBER' where gaming_member_id = $1", [person.gamingMemberId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
  });
});

// ============================================================ groups

describe("a group candidacy: one photograph, a representative, privately attributed members", () => {
  it("is APPROVED only when every attributed member is associated AND has consented to THAT photograph", async () => {
    const c = await newContest();
    const r = c.rounds.BEST_GROUP;
    const state = async (entryId: string) => (await q<{ m_state: string }>("select m_state from community_voting_entry_media($1)", [entryId]))[0].m_state;
    const complete = async (entryId: string, photoId: string) => (await q<{ ok: boolean }>("select community_voting_group_complete($1, $2) ok", [entryId, photoId]))[0].ok;
    const g = await createGroup(r);
    const photo = await approvedPhoto(r, g.entryId);
    // a group of one is not a group: there must be at least one attributed member
    expect(await complete(g.entryId, photo.photoId)).toBe(false);
    expect(await state(g.entryId)).toBe("PENDING_CONSENT");
    const m1 = await createMember(r, g.entryId);
    const m2 = await createMember(r, g.entryId);
    expect(await complete(g.entryId, photo.photoId)).toBe(false);
    await memberConsent(r, m1.entryId, photo.photoId);
    await memberConsent(r, m2.entryId, photo.photoId);
    expect(await complete(g.entryId, photo.photoId)).toBe(false); // consent without association is not enough
    await associate(r, m1.entryId, m1.claimCode);
    expect(await complete(g.entryId, photo.photoId)).toBe(false);
    await associate(r, m2.entryId, m2.claimCode);
    expect(await complete(g.entryId, photo.photoId)).toBe(true);
    expect(await state(g.entryId)).toBe("APPROVED");
    // a new photograph voids every consent, the representative's and the members'
    const newer = await repo.uploadEntryPhoto({ ...r.ctx, entryId: g.entryId, ...photoArgs(777) });
    expect(await state(g.entryId)).toBe("PENDING_CONSENT");
    expect(await complete(g.entryId, newer.photoId)).toBe(false);
    // and a new member added to a complete group makes it incomplete again until that person consents
    const m3 = await createMember(r, g.entryId);
    await expect(memberConsent(r, m3.entryId, photo.photoId)).rejects.toThrow(/CV_PHOTO_REQUIRED/);
  });

  it("records a member's consent against the current photograph only, once, with the age confirmation, and only before opening", async () => {
    const c = await newContest();
    const r = c.rounds.BEST_GROUP;
    const g = await createGroup(r);
    const photo = await approvedPhoto(r, g.entryId);
    const m = await createMember(r, g.entryId);
    const call = (photoId: string, age: boolean, entry = m.entryId, sha = consent.statementSha256) =>
      q("select * from record_community_voting_member_consent_atomically($1, $2, $3, $4, $5, $6, $7, $8)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, entry, photoId, consent.consentVersion, sha, age]);
    await expect(call(photo.photoId, false)).rejects.toThrow(/CV_CONSENT_REQUIRED/);
    await expect(call(photo.photoId, true, m.entryId, "xyz")).rejects.toThrow(/CV_INVALID_REQUEST/);
    await expect(call("00000000-0000-4000-8000-000000000000", true)).rejects.toThrow(/CV_PHOTO_REQUIRED/);
    await expect(call(photo.photoId, true, g.entryId)).rejects.toThrow(/CV_WRONG_ENTRY_KIND/);
    await call(photo.photoId, true);
    await expect(call(photo.photoId, true)).rejects.toThrow(/CV_CONSENT_ALREADY_RECORDED/);
    await refused("update community_voting_member_consents set age_confirmed = true", [], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
    await refused("delete from community_voting_member_consents", [], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
    // stranger host token and stranger operator are refused like every operator act
    await refused("select * from record_community_voting_member_consent_atomically($1, 'wrong', $2, $3, $4, $5, $6, true)", [r.instanceId, r.ctx.operatorMemberId, m.entryId, photo.photoId, consent.consentVersion, consent.statementSha256], "HOST_TOKEN_MISMATCH");
    await refused("select * from record_community_voting_member_consent_atomically($1, $2, $3, $4, $5, $6, $7, true)", [r.instanceId, r.ctx.hostToken, (await newPerson()).gamingMemberId, m.entryId, photo.photoId, consent.consentVersion, consent.statementSha256], "CV_OPERATOR_REQUIRED");
  });

  it("opens with the groups that are complete, keeps members OFF the ballot, and refuses to open with a member left out", async () => {
    const c = await newContest();
    const r = c.rounds.BEST_GROUP;
    const g1 = await group(r, 2);
    // a second group with an unassociated member keeps the whole category from opening
    const g2 = await createGroup(r);
    const photo2 = await approvedPhoto(r, g2.entryId);
    await associate(r, g2.entryId, g2.claimCode);
    const lonely = await createMember(r, g2.entryId);
    const lonelyPerson = await newPerson();
    await repo.bindVoter({ instanceId: r.instanceId, authUserId: lonelyPerson.authUserId });
    await memberConsent(r, lonely.entryId, photo2.photoId);
    await lock(r);
    await refused("select * from start_community_voting_category_atomically($1, $2, $3, 'p')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_PREPARATION_INCOMPLETE");
    expect((await q("select 1 from interaction_instances where session_id = $1", [r.session.sessionId])).length).toBe(0);
    // the lobby is locked now: the person was bound before it, and claiming and confirming need no new participant
    const claimed = await repo.claimRoundEntry({ instanceId: r.instanceId, authUserId: lonelyPerson.authUserId, claimCode: lonely.claimCode });
    await repo.confirmRoundAssociation({ ...r.ctx, entryId: lonely.entryId, confirmationCode: claimed.confirmationCode });
    const opened = await openCategory(r);
    expect(opened.candidate_count).toBe(2);
    const cands = await candidatesOf(r);
    expect(cands.map((x) => x.kind)).toEqual(["GROUP", "GROUP"]);
    expect(cands.map((x) => x.entryId)).toContain(g1.group.entryId);
    const members = await q<{ candidate_id: string | null }>("select candidate_id from community_voting_entries where instance_id = $1 and entry_kind = 'GROUP_MEMBER'", [r.instanceId]);
    expect(members.length).toBe(3);
    expect(members.every((m) => m.candidate_id === null)).toBe(true);
    // the preparation is frozen: no member, no consent, no association after opening
    await refused("select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, g1.group.entryId], "CV_PREPARATION_CLOSED");
    await refused("select * from record_community_voting_member_consent_atomically($1, $2, $3, $4, $5, $6, $7, true)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, lonely.entryId, photo2.photoId, consent.consentVersion, consent.statementSha256], "CV_PREPARATION_CLOSED");
  });

  it("shows the operator the structure of a group — kinds, consents, completeness — and never an identity", async () => {
    const c = await newContest();
    const r = c.rounds.BEST_GROUP;
    const g = await group(r, 2);
    const rows = await q<Record<string, unknown>>("select * from read_community_voting_category_structure($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId]);
    const byKind = (k: string) => rows.filter((x) => x.entry_kind === k);
    // the structure names the code, the public name, whether the entry was self-registered and how a delivery stands — never a number, never an identity
    expect(Object.keys(rows[0]).sort()).toEqual([
      "delivery_status", "entry_consent", "entry_id", "entry_kind", "group_complete", "group_entry_id", "has_whatsapp", "member_consent", "photo_decision", "public_code", "public_name", "self_registered",
    ]);
    expect(byKind("GROUP")[0]).toMatchObject({ entry_consent: true, photo_decision: "APPROVED" });
    expect(byKind("GROUP_MEMBER").every((m) => m.entry_consent === null && m.photo_decision === null)).toBe(true);
    expect(byKind("GROUP")).toHaveLength(1);
    expect(byKind("GROUP")[0]).toMatchObject({ entry_id: g.group.entryId, group_complete: true });
    expect(byKind("GROUP_MEMBER").every((m) => m.member_consent === true && m.group_entry_id === g.group.entryId)).toBe(true);
    await refused("select * from read_community_voting_category_structure($1, 'wrong', $2)", [r.instanceId, r.ctx.operatorMemberId], "HOST_TOKEN_MISMATCH");
  });
});

// ============================================================ opening: explicit, never implied

describe("the opening of a category is the operator's explicit act", () => {
  it("never opens by the clock or because registration is complete, and needs a configured closing time in the future", async () => {
    const c = await newContest({ closesAt: null });
    const r = c.rounds.MOST_ELABORATE;
    await individuals(r, 3);
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: inMs(-7_200_000), contestantCutoffAt: inMs(-3_600_000), votingOpensAt: inMs(-60_000), votingClosesAt: null, status: "CONFIRMED" } });
    await sleep(500);
    expect((await q("select 1 from interaction_instances where session_id = $1", [r.session.sessionId])).length).toBe(0);
    await lock(r);
    await refused("select * from start_community_voting_category_atomically($1, $2, $3, 'p')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_SCHEDULE_REQUIRED");
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(-1000), status: "TENTATIVE" } }).catch(() => undefined);
    await refused("select * from start_community_voting_category_atomically($1, $2, $3, 'p')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_SCHEDULE_REQUIRED");
  });

  it("opens with at least two complete candidacies, exactly once under concurrent attempts, and a late opening never moves the closing time", async () => {
    const c = await newContest();
    const r = c.rounds.SEXIEST;
    await individual(r);
    await lock(r);
    await refused("select * from start_community_voting_category_atomically($1, $2, $3, 'p')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_PREPARATION_INCOMPLETE");
    await individual(r);
    const [sched] = await q<{ voting_closes_at: string }>("select voting_closes_at from community_voting_schedules where instance_id = $1", [r.instanceId]);
    const opens = await Promise.allSettled(
      [0, 1, 2, 3].map(() => q<{ deadline_at: string; candidate_count: number }>("select * from start_community_voting_category_atomically($1, $2, $3, 'Mejor disfraz')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId]))
    );
    const ok = opens.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<{ deadline_at: string; candidate_count: number }[]>[];
    expect(ok).toHaveLength(1);
    expect(new Date(ok[0].value[0].deadline_at).getTime()).toBe(new Date(sched.voting_closes_at).getTime());
    expect(ok[0].value[0].candidate_count).toBe(2);
    await refused("select * from start_community_voting_category_atomically($1, $2, $3, 'p')", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_ALREADY_OPENED");
  });

  it("takes entries and photographs only before the registration cutoff, by the database clock", async () => {
    const c = await newContest({ cutoffAt: inMs(7000) });
    const r = c.rounds.FUNNIEST;
    const before = await repo.createRoundEntry(r.ctx);
    await sleep(7500);
    await refused("select * from create_community_voting_round_entry_atomically($1, $2, $3, 900)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_CUTOFF_PASSED");
    await expect(approvedPhoto(r, before.entryId)).rejects.toThrow();
    const g = await newContest({ cutoffAt: inMs(7000) });
    const grp = g.rounds.BEST_GROUP;
    const gEntry = await createGroup(grp);
    await sleep(7500);
    await refused("select * from create_community_voting_group_entry_atomically($1, $2, $3, 900)", [grp.instanceId, grp.ctx.hostToken, grp.ctx.operatorMemberId], "CV_CUTOFF_PASSED");
    await refused("select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)", [grp.instanceId, grp.ctx.hostToken, grp.ctx.operatorMemberId, gEntry.entryId], "CV_CUTOFF_PASSED");
  });
});

// ============================================================ voting

describe("one current vote per account and category; no self-vote, a group's members included", () => {
  it("keeps ONE vote per account in a category, revisable until the close, and the same account votes in all four", async () => {
    const c = await newContest();
    const voter = await newPerson();
    const cands: Record<string, Awaited<ReturnType<typeof candidatesOf>>> = {};
    for (const k of INDIVIDUAL_KEYS) {
      await individuals(c.rounds[k], 2);
      await openCategory(c.rounds[k]);
      cands[k] = await candidatesOf(c.rounds[k]);
    }
    await group(c.rounds.BEST_GROUP, 1);
    await group(c.rounds.BEST_GROUP, 1);
    await openCategory(c.rounds.BEST_GROUP);
    cands.BEST_GROUP = await candidatesOf(c.rounds.BEST_GROUP);
    const first = await castVote(c.rounds.MOST_ELABORATE, voter, cands.MOST_ELABORATE[0].candidateId);
    expect(first.outcome).toBe("APPLIED");
    const revised = await castVote(c.rounds.MOST_ELABORATE, voter, cands.MOST_ELABORATE[1].candidateId);
    expect(revised.outcome).toBe("APPLIED");
    expect((await castVote(c.rounds.MOST_ELABORATE, voter, cands.MOST_ELABORATE[1].candidateId)).outcome).toBe("UNCHANGED");
    expect(await votesIn(c.rounds.MOST_ELABORATE)).toBe(1);
    for (const k of CATEGORY_KEYS.slice(1)) await castVote(c.rounds[k], voter, cands[k][0].candidateId);
    const total = await q<{ n: number }>("select count(*)::int n from votes v join community_voting_instances i on i.session_id = (select session_id from interaction_instances where interaction_instance_id = v.interaction_instance_id) join community_voting_category_rounds cr on cr.instance_id = i.instance_id where cr.contest_id = $1", [c.contestId]);
    expect(total[0].n).toBe(4);
    const mine = await q<{ candidate_id: string }>("select v.candidate_id from votes v join participants p on p.participant_id = v.participant_id join community_voting_voter_bindings b on b.participant_id = p.participant_id where b.auth_user_id = $1 and b.instance_id = $2", [voter.authUserId, c.rounds.MOST_ELABORATE.instanceId]);
    expect(mine.map((m) => m.candidate_id)).toEqual([cands.MOST_ELABORATE[1].candidateId]);
    await closeCategory(c.rounds.MOST_ELABORATE);
    await expect(castVote(c.rounds.MOST_ELABORATE, voter, cands.MOST_ELABORATE[0].candidateId)).rejects.toThrow(/Voting is not open|CV_VOTING_NOT_OPEN/);
  });

  it("refuses a contestant's vote for their own candidacy, a representative's and EVERY member's, and lets them vote for anyone else", async () => {
    const c = await newContest();
    const ind = c.rounds.MOST_ELABORATE;
    const people = await individuals(ind, 2);
    const grp = c.rounds.BEST_GROUP;
    const g1 = await group(grp, 2);
    const g2 = await group(grp, 1);
    await openCategory(ind);
    await openCategory(grp);
    const indC = await candidatesOf(ind);
    const grpC = await candidatesOf(grp);
    const own = indC.find((x) => x.entryId === people[0].entry.entryId)!;
    const other = indC.find((x) => x.entryId === people[1].entry.entryId)!;
    await expect(castVote(ind, people[0].person, own.candidateId)).rejects.toThrow(/SELF_VOTE_NOT_ALLOWED/);
    await castVote(ind, people[0].person, other.candidateId);
    const g1c = grpC.find((x) => x.entryId === g1.group.entryId)!;
    const g2c = grpC.find((x) => x.entryId === g2.group.entryId)!;
    await expect(castVote(grp, g1.representative, g1c.candidateId)).rejects.toThrow(/SELF_VOTE_NOT_ALLOWED/);
    for (const member of g1.people) await expect(castVote(grp, member, g1c.candidateId)).rejects.toThrow(/SELF_VOTE_NOT_ALLOWED/);
    for (const member of g1.people) expect((await castVote(grp, member, g2c.candidateId)).outcome).toBe("APPLIED");
    expect((await castVote(grp, g1.representative, g2c.candidateId)).outcome).toBe("APPLIED");
    // a member of a group may vote for anybody in the other categories
    expect((await castVote(ind, g1.people[0], own.candidateId)).outcome).toBe("APPLIED");
  });

  it("recovers an uncertain submission without a duplicate: replay answers, a stale or unissued intent is refused, a different payload is refused", async () => {
    const c = await newContest();
    const r = c.rounds.MOST_ELABORATE;
    await individuals(r, 2);
    await openCategory(r);
    const [a, b] = await candidatesOf(r);
    const voter = await newPerson();
    const first = await castVote(r, voter, a.candidateId);
    const replay = await castVote(r, voter, a.candidateId, first.intentNo);
    expect(replay.outcome).toBe("REPLAYED");
    expect(await votesIn(r)).toBe(1);
    await expect(castVote(r, voter, b.candidateId, first.intentNo)).rejects.toThrow(/CV_INTENT_PAYLOAD_MISMATCH/);
    await expect(castVote(r, voter, b.candidateId, first.intentNo + 5)).rejects.toThrow(/CV_INTENT_UNISSUED/);
    const second = await castVote(r, voter, b.candidateId);
    await expect(castVote(r, voter, a.candidateId, first.intentNo)).rejects.toThrow(/CV_STALE_INTENT|CV_INTENT_PAYLOAD_MISMATCH/);
    expect(second.intentNo).toBeGreaterThan(first.intentNo);
    expect(await votesIn(r)).toBe(1);
    // after the close the applied intent is still answered, so a lost confirmation can be recovered; a new one is refused
    await closeCategory(r);
    expect((await castVote(r, voter, b.candidateId, second.intentNo)).outcome).toBe("REPLAYED");
    await expect(castVote(r, voter, a.candidateId)).rejects.toThrow(/Voting is not open|CV_VOTING_NOT_OPEN/);
  });

  it("leaves ONE vote when one account fires many casts at once, and counts every distinct account exactly once", async () => {
    const c = await newContest();
    const r = c.rounds.SEXIEST;
    await individuals(r, 3);
    await openCategory(r);
    const cands = await candidatesOf(r);
    const voter = await newPerson();
    const binding = await repo.bindVoter({ instanceId: r.instanceId, authUserId: voter.authUserId });
    const intents: number[] = [];
    for (let i = 0; i < 6; i++) intents.push((await repo.issueIntent({ instanceId: r.instanceId, authUserId: voter.authUserId })).intentNo);
    const results = await Promise.allSettled(
      intents.map((n, i) =>
        q("select * from cast_community_voting_category_vote_atomically($1, $2, $3, $4, $5, $6)", [r.instanceId, voter.authUserId, binding.bindingId, n, r.interactionInstanceId, cands[i % 3].candidateId])
      )
    );
    expect(results.some((x) => x.status === "fulfilled")).toBe(true);
    expect(await votesIn(r)).toBe(1);
    await Promise.all(Array.from({ length: 20 }, async () => castVote(r, await newPerson(), cands[0].candidateId)));
    expect(await votesIn(r)).toBe(21);
  });

  it("never counts a vote that lost a race with the close: every accepted vote is in the closure, and none is accepted after it", async () => {
    const c = await newContest();
    const r = c.rounds.FUNNIEST;
    await individuals(r, 2);
    await openCategory(r);
    const [a] = await candidatesOf(r);
    const people = await Promise.all(Array.from({ length: 10 }, () => newPerson()));
    for (const p of people) await repo.bindVoter({ instanceId: r.instanceId, authUserId: p.authUserId });
    const votes = people.map((p) => castVote(r, p, a.candidateId));
    const closing = closeCategory(r);
    const settled = await Promise.allSettled([...votes, closing]);
    const accepted = settled.slice(0, 10).filter((s) => s.status === "fulfilled").length;
    const [closure] = await q<{ valid_vote_count: number }>("select valid_vote_count from community_voting_closures where instance_id = $1", [r.instanceId]);
    expect(await votesIn(r)).toBe(closure.valid_vote_count);
    expect(accepted).toBe(closure.valid_vote_count);
  });

  it("refuses a vote at the closing time by the database clock, and still answers the replay of an applied vote", async () => {
    const c = await newContest({ closesAt: null });
    const r = c.rounds.MOST_ELABORATE;
    await individuals(r, 2);
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(6000), status: "TENTATIVE" } });
    await openCategory(r);
    const [a, b] = await candidatesOf(r);
    const voter = await newPerson();
    const first = await castVote(r, voter, a.candidateId);
    await sleep(6500);
    await expect(castVote(r, voter, b.candidateId)).rejects.toThrow(/CV_VOTING_WINDOW_ELAPSED/);
    expect((await castVote(r, voter, a.candidateId, first.intentNo)).outcome).toBe("REPLAYED");
    expect(await votesIn(r)).toBe(1);
    const [edge] = await q<{ at_deadline: boolean; before: boolean }>("select community_voting_deadline_open(t, t) at_deadline, community_voting_deadline_open(t, t - interval '1 microsecond') before from (select now() t) x");
    expect(edge).toEqual({ at_deadline: false, before: true });
  });
});

// ============================================================ results, ties, zero votes, publication

describe("results: the most votes wins, ties are shared, no valid vote means no winner, and nothing is public until published", () => {
  it("keeps totals hidden while voting, and gives the operator totals only after the close", async () => {
    const c = await newContest();
    const r = c.rounds.MOST_ELABORATE;
    await individuals(r, 2);
    await openCategory(r);
    const [a] = await candidatesOf(r);
    await castMany(r, a.candidateId, 2);
    await refused("select * from read_community_voting_category_results($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_RESULTS_NOT_AVAILABLE");
    const voter = await newPerson();
    const binding = await repo.bindVoter({ instanceId: r.instanceId, authUserId: voter.authUserId });
    const publicReads = JSON.stringify([
      await q("select * from read_community_voting_round_public_info($1)", [r.instanceId]),
      await q("select * from read_community_voting_round_gallery($1)", [r.instanceId]),
      await q("select * from read_community_voting_round_voter_status($1, $2)", [r.instanceId, voter.authUserId]),
      await publicWinners(r),
    ]);
    expect(publicReads).not.toMatch(/"(votes|vote_count|total|rank|tally)[a-z_]*"/i);
    expect(binding.bindingId).toBeTruthy();
    await closeCategory(r);
    expect((await categoryResults(r)).map((x) => Number(x.votes))).toEqual([2, 0]);
  });

  it("names ONE winner for the most votes, SHARES a tie, and announces nobody for zero valid votes — each publishable", async () => {
    const c = await newContest();
    const one = c.rounds.MOST_ELABORATE;
    const tie = c.rounds.SEXIEST;
    const none = c.rounds.FUNNIEST;
    await closedCategory(one, [3, 1]);
    await closedCategory(tie, [2, 2, 1]);
    await closedCategory(none, [0, 0]);
    expect((await categoryResults(one)).filter((x) => x.winner)).toHaveLength(1);
    expect((await categoryResults(tie)).filter((x) => x.winner)).toHaveLength(2);
    expect((await categoryResults(none)).filter((x) => x.winner)).toHaveLength(0);
    for (const r of [one, tie, none]) {
      expect(await publicWinners(r)).toEqual([]);
      await reviewCategory(r);
    }
    expect((await publishCategory(one)).winner_count).toBe(1);
    expect((await publishCategory(tie)).winner_count).toBe(2);
    expect((await publishCategory(none)).winner_count).toBe(0);
    expect((await publicWinners(one)).map((x) => x.kind)).toEqual(["WINNERS"]);
    expect(await publicWinners(tie)).toHaveLength(2);
    expect(await publicWinners(none)).toEqual([]);
    const [info] = await q<{ published: boolean; closed: boolean }>("select * from read_community_voting_round_public_info($1)", [none.instanceId]);
    expect(info).toMatchObject({ published: true, closed: true });
    const [state] = await q<{ state: string }>("select state from interaction_instances where session_id = $1", [none.session.sessionId]);
    expect(state.state).toBe("RESULT_REVEAL");
    // no total is ever written next to what is announced
    const announced = await q<Record<string, unknown>>("select * from community_voting_published_results where instance_id = $1", [tie.instanceId]);
    expect(Object.keys(announced[0]).sort()).toEqual(["alias", "entry_id", "instance_id", "kind", "ordinal"]);
  });

  it("publishes a category with an unvoted candidacy without any Product policy of the retired cut", async () => {
    const c = await newContest();
    const r = c.rounds.MOST_ELABORATE;
    await closedCategory(r, [3, 0]);
    expect((await q("select * from community_voting_pending_policies($1)", [r.instanceId])).length).toBe(0);
    await reviewCategory(r);
    expect((await publishCategory(r)).winner_count).toBe(1);
  });

  it("requires the close, then a review of the CURRENT result, and publishes once; a withdrawal after the review makes it stale", async () => {
    const c = await newContest();
    const r = c.rounds.MOST_ELABORATE;
    const people = await individuals(r, 2);
    await openCategory(r);
    const cands = await candidatesOf(r);
    await castMany(r, cands[0].candidateId, 2);
    await castMany(r, cands[1].candidateId, 1);
    await refused("select * from record_community_voting_category_review_atomically($1, $2, $3, null)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_RESULTS_NOT_AVAILABLE");
    await refused("select * from publish_community_voting_category_atomically($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_RESULTS_NOT_AVAILABLE");
    await closeCategory(r);
    await refused("select * from publish_community_voting_category_atomically($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_REVIEW_REQUIRED");
    await reviewCategory(r, "ok");
    await sqlOp("select * from withdraw_community_voting_round_candidature_atomically($1, $2, $3, $4, 'left', false)", r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, people[0].entry.entryId);
    await refused("select * from publish_community_voting_category_atomically($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_REVIEW_STALE");
    await reviewCategory(r);
    const published = await publishCategory(r);
    expect(published.winner_count).toBe(1);
    expect((await publicWinners(r))[0].alias).toBe(cands[1].label);
    await refused("select * from publish_community_voting_category_atomically($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_ALREADY_PUBLISHED");
  });

  it("can name a GROUP as a category winner, by its public number", async () => {
    const c = await newContest();
    const r = c.rounds.BEST_GROUP;
    await group(r, 1);
    const winner = await group(r, 2);
    await openCategory(r);
    const cands = await candidatesOf(r);
    const w = cands.find((x) => x.entryId === winner.group.entryId)!;
    await castMany(r, w.candidateId, 2);
    await closeCategory(r);
    await reviewCategory(r);
    await publishCategory(r);
    expect((await publicWinners(r)).map((x) => [x.alias, x.kind])).toEqual([[w.label, "WINNERS"]]);
  });
});

// ============================================================ privacy, privileges, no location, retired operations

describe("privacy and privileges of the new surface", () => {
  it("enables RLS with no policies on the four new tables and gives anon and authenticated no privilege on them", async () => {
    for (const t of ["community_voting_contests", "community_voting_category_rounds", "community_voting_contest_identities", "community_voting_member_consents"]) {
      const [row] = await q<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [t]);
      expect(row.relrowsecurity).toBe(true);
      expect((await q("select 1 from pg_policies where schemaname = 'public' and tablename = $1", [t])).length).toBe(0);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["select", "insert", "update", "delete", "truncate"]) {
          const [p] = await q<{ ok: boolean }>("select has_table_privilege($1, $2, $3) ok", [role, `public.${t}`, priv]);
          expect(p.ok, `${role} ${priv} ${t}`).toBe(false);
        }
      }
    }
  });

  it("denies service_role every privilege that would rewrite an append-only record of the contest", async () => {
    const denied: Array<[string, string[]]> = [
      ["community_voting_category_rounds", ["update", "delete", "truncate"]],
      ["community_voting_member_consents", ["update", "delete", "truncate"]],
      ["community_voting_contest_identities", ["update", "truncate"]],
      ["community_voting_contests", ["delete", "truncate"]],
    ];
    for (const [t, privs] of denied) for (const priv of privs) expect((await q<{ ok: boolean }>("select has_table_privilege('service_role', $1, $2) ok", [`public.${t}`, priv]))[0].ok, `${t} ${priv}`).toBe(false);
  });

  it("makes every new function executable by service_role only", async () => {
    const names = (await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%category%' or proname like '%contest%' or proname in ('community_voting_group_complete', 'community_voting_create_entry_row', 'create_community_voting_group_entry_atomically', 'create_community_voting_group_member_atomically', 'record_community_voting_member_consent_atomically', 'community_voting_candidacy_claim_guard', 'community_voting_candidacy_record', 'community_voting_candidacy_release', 'community_voting_guard_entry_kind', 'community_voting_guard_entry_kind_update'))")).map((x) => x.proname);
    expect(names.length).toBeGreaterThanOrEqual(24);
    for (const n of names) {
      // anon and authenticated inherit PUBLIC's privileges, so a PUBLIC grant would show here as true
      const [row] = await q<{ anon: boolean; auth: boolean; svc: boolean }>(
        "select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace limit 1",
        [n]
      );
      expect(row, n).toMatchObject({ anon: false, auth: false, svc: true });
    }
  });

  it("exposes no identity through the operator's reads and no counts through the public ones", async () => {
    const c = await newContest();
    const r = c.rounds.FUNNIEST;
    await closedCategory(r, [2, 1]);
    const results = await categoryResults(r);
    expect(Object.keys(results[0]).sort()).toEqual(["candidate_id", "competition_rank", "entry_id", "label", "ordinal", "votes", "winner", "withdrawn"]);
    const [info] = await q<Record<string, unknown>>("select * from read_community_voting_round_public_info($1)", [r.instanceId]);
    expect(Object.keys(info).join(",")).not.toMatch(/auth|member|email|binding|participant|token/i);
    const [of] = await q<Record<string, unknown>>("select * from read_community_voting_category_of($1)", [r.instanceId]);
    expect(Object.keys(of).sort()).toEqual(["category_key", "contest_id"]);
  });
});

describe("no location anywhere in the contest", () => {
  it("has a cast with no coordinate parameter at all, and rounds without a venue", async () => {
    const [cast] = await q<{ proargnames: string[]; pronargs: number }>("select proargnames, pronargs from pg_proc where proname = 'cast_community_voting_category_vote_atomically' and pronamespace = 'public'::regnamespace");
    expect(cast.pronargs).toBe(6);
    expect(cast.proargnames.join(",")).not.toMatch(/latitude|longitude|accuracy|location|lat|lon|geo/i);
    const c = await newContest();
    const rows = await q<{ n: number }>("select count(*)::int n from community_voting_instances i join community_voting_category_rounds cr on cr.instance_id = i.instance_id where cr.contest_id = $1 and (i.venue_latitude is not null or i.venue_longitude is not null or i.venue_radius_meters is not null or i.max_accuracy_meters is not null)", [c.contestId]);
    expect(rows[0].n).toBe(0);
    const r = c.rounds.MOST_ELABORATE;
    const [info] = await q<Record<string, unknown>>("select * from read_community_voting_round_public_info($1)", [r.instanceId]);
    for (const [k, v] of Object.entries(info)) if (/location|venue|geofence/i.test(k)) expect(v, k).toBe(false);
    // the pilot's cast, handed coordinates for a category round, ignores them: they are never stored (no venue to judge them against)
    await individuals(r, 2);
    await openCategory(r);
    const [a] = await candidatesOf(r);
    const voter = await newPerson();
    const binding = await repo.bindVoter({ instanceId: r.instanceId, authUserId: voter.authUserId });
    const intent = await repo.issueIntent({ instanceId: r.instanceId, authUserId: voter.authUserId });
    await q("select * from cast_community_voting_round_vote_atomically($1, $2, $3, $4, $5, $6, 15.5, -88.0, 10)", [r.instanceId, voter.authUserId, binding.bindingId, intent.intentNo, r.interactionInstanceId, a.candidateId]);
    const [stored] = await q<{ applied_distance_meters: string | null; applied_accuracy_meters: string | null }>("select applied_distance_meters, applied_accuracy_meters from community_voting_voter_bindings where binding_id = $1", [binding.bindingId]);
    expect(stored).toEqual({ applied_distance_meters: null, applied_accuracy_meters: null });
  });
});

describe("what the contest retires cannot happen on a category round", () => {
  it("refuses the finalist cut, a Product policy of the cut and a final that descends from a category round", async () => {
    const c = await newContest();
    const r = c.rounds.MOST_ELABORATE;
    await closedCategory(r, [2, 1]);
    await refused("select * from select_community_voting_finalists_atomically($1, $2, $3)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId], "CV_OBSOLETE_FOR_CATEGORY");
    await refused(
      "select * from record_community_voting_policy_approval_atomically($1, $2, $3, 'ZERO_VALID_VOTES_PRELIMINARY', 'ALL_ENTRIES_ADVANCE', 'DECISION-X-0001')",
      [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId],
      "CV_OBSOLETE_FOR_CATEGORY"
    );
    const { createSession } = await import("../lib/session/createSession");
    const { setSessionCapabilities } = await import("../lib/session/setSessionCapabilities");
    const s = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, s.sessionId, s.hostToken, ["VOTING"] as never);
    await refused(
      "select * from register_community_voting_round_atomically($1, $2, $3, 1, 'FINAL', $4, 15.5, -88.0, 100, 50, 1, 1, 300, false)",
      [s.sessionId, s.hostToken, r.ctx.operatorMemberId, r.instanceId],
      "CV_OBSOLETE_FOR_CATEGORY"
    );
  });
});

describe("the contest on Home: the operator's explicit listing, and nothing invented", () => {
  it("lists nothing until the operator chooses, lists the contest on request and takes it down again", async () => {
    const c = await newContest();
    const before = await q<{ contest_id: string }>("select * from read_community_voting_featured_contest()");
    expect(before.some((x) => x.contest_id === c.contestId)).toBe(false);
    const r = c.rounds.MOST_ELABORATE;
    await refused("select * from set_community_voting_contest_listing_atomically($1, 'wrong', $2, true)", [r.instanceId, r.ctx.operatorMemberId], "HOST_TOKEN_MISMATCH");
    await refused("select * from set_community_voting_contest_listing_atomically($1, $2, $3, true)", [r.instanceId, r.ctx.hostToken, (await newPerson()).gamingMemberId], "CV_OPERATOR_REQUIRED");
    await sqlOp("select * from set_community_voting_contest_listing_atomically($1, $2, $3, true)", r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId);
    const [featured] = await q<{ contest_id: string }>("select * from read_community_voting_featured_contest()");
    expect(featured.contest_id).toBe(c.contestId);
    expect((await q<{ listed: boolean }>("select listed from read_community_voting_contest_categories($1)", [c.contestId])).every((x) => x.listed)).toBe(true);
    await sqlOp("select * from set_community_voting_contest_listing_atomically($1, $2, $3, false)", r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId);
    const after = await q<{ contest_id: string }>("select * from read_community_voting_featured_contest()");
    expect(after.some((x) => x.contest_id === c.contestId)).toBe(false);
    await refused("update community_voting_contests set created_at = now() where contest_id = $1", [c.contestId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");
  });
});

function randomContest() {
  return "00000000-0000-4000-8000-0000000000aa";
}
