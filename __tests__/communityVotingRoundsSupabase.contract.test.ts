import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { lockLobby } from "../lib/session/lockLobby";
import { SelfVoteNotAllowedError } from "../lib/session/types";
import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import { GALLERY_CONSENT_SHA256, GALLERY_CONSENT_VERSION, PROMO_CONSENT_SHA256, PROMO_CONSENT_VERSION } from "../lib/gaming/communityVoting/rounds/constants";
import { finalistSelectionDigest, reviewDigest, roundResultsDigest, selectFinalists, selectWinners } from "../lib/gaming/communityVoting/rounds/finalists";
import type { OperatorContext, RoundResultRow } from "../lib/gaming/communityVoting/rounds/types";
import {
  POLICY_VALUES,
  approve,
  INSIDE,
  OUTSIDE,
  VENUE,
  approvedEntry,
  bind,
  candidates,
  castMany,
  contestant,
  contestants,
  expectCode,
  expectDbError,
  newPerson,
  newRound,
  openRound,
  photoArgs,
  pool,
  q,
  rawClient,
  repo,
  sessionRepo,
  supabaseUrl,
  votesIn,
  voteAs,
  type Person,
  type Round,
} from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback. The shared fixtures apply the same guard as soon as they load; this explicit call is what the
// contract-registry inventory (requireLocalSupabase.test.ts) requires of every registered contract file, so no file relies on another to be safe.
requireLocalSupabase(supabaseUrl);

/**
 * Two-round pilot (UG-IV-GATE-004A, corrected by UG-IV-GATE-005 / 005A) — contract suite against REAL local Postgres (isolated loopback
 * stack). The fixtures are shared with the correction suites (helpers/roundsFixtures.ts).
 *
 * Isolation: the target comes ONLY from shell-exported variables and must be loopback; every identity, photograph, coordinate and time is
 * synthetic; nothing here can reach a hosted project, a provider or a message channel. Each test builds its own Sessions, so tests are
 * independent. Community Voting rows are intentionally undeletable (deletion containment), so this suite never cleans up — discarding the
 * throwaway database is the reset.
 *
 * REQUIRED ENVIRONMENT (shell-exported, all loopback): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 * COMMUNITY_VOTING_LOCAL_DB_URL.
 *
 * WHAT THE EVIDENCE IS: the pilot's SQL, TypeScript rules, repository and routes were written BEFORE this suite, so its tests are not
 * "red before implementation" (the corrections of 005/005A, in communityVotingRoundsCorrection*.test.ts, ARE: they were written and run red
 * first). Their sensitivity is shown by mutating each guarantee (on a scratch database for the SQL, on a scratch copy for the TypeScript) and
 * watching the matching test fail — see the implementation record for the mutation table.
 */

afterAll(async () => {
  await pool.end();
});

vi.setConfig({ testTimeout: 120_000 });

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let seedCounter = 5000;
/** A candidature withdrawal that leaves the photograph alone (hiding it is a separate act, tested on its own). */
const withdraw = (input: OperatorContext & { entryId: string; reason: string }) => repo.withdrawRoundCandidature({ ...input, hidePhoto: false });

/** Completes the profile of a person who had none — what the existing Gaming Member creation does. */
async function completeProfile(p: Person): Promise<void> {
  const [row] = await q<{ gaming_member_id: string }>("insert into gaming_members (auth_user_id, display_name) values ($1, 'Synthetic') returning gaming_member_id", [p.authUserId]);
  p.gamingMemberId = row.gaming_member_id;
}

/**
 * An operation that fails closed until Product's decision is recorded (POLICY_REQUIRED naming the key). Most tests here are about something
 * ELSE — ties, ranks, descent, withdrawal — so they record the decision the operation names and retry; the tests that are about the
 * decision itself are in communityVotingRoundsCorrection.contract.test.ts and assert the refusal.
 */
async function withDecisions<T>(r: Round, run: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 4; i++) {
    try {
      return await run();
    } catch (e) {
      const key = e instanceof CommunityVotingError && e.code === "POLICY_REQUIRED" ? (Object.keys(POLICY_VALUES) as Array<keyof typeof POLICY_VALUES>).find((k) => e.message.includes(k)) : undefined;
      if (!key) throw e;
      await approve(r, key, POLICY_VALUES[key]);
    }
  }
  return run();
}
const cut = (r: Round) => withDecisions(r, () => repo.selectFinalists(r.ctx));
const prepare = (f: Round, p: Round) => withDecisions(p, () => repo.prepareFinal(f.ctx));

/** Closes, then cuts, a preliminary; returns the selection. */
async function closeSelect(r: Round) {
  await repo.closeRound(r.ctx);
  return cut(r);
}
function toTallies(rows: RoundResultRow[]) {
  return rows.map((x) => ({ ordinal: x.ordinal, label: x.label, withdrawn: x.withdrawn, votes: x.votes }));
}

// =====================================================================================================================
// The files this pilot builds upon are exactly the ones preserved
// =====================================================================================================================

describe("preserved base", () => {
  const root = join(__dirname, "..");
  const PINNED: Record<string, string> = {
    "supabase/migrations/20261020190000_create_community_voting_instances.sql": "134f2d3d3bea34b104c175110aec37e937610b34ec332963eef816b451054298",
    "supabase/migrations/20261020190100_create_community_voting_functions.sql": "027ba6a93500d304a27be6d0dca8793cc0adcabc48875d9a8d6cac1a6accc7bb",
    "supabase/migrations/20261020190200_guard_ordinary_join_for_community_voting.sql": "f2d539c21d28c307d8932387325a8b464d4a2713e34d6cef87a77bae8d49c0d5",
    "supabase/migrations/20261020190300_guard_event_bound_opening_and_ballot.sql": "9d3ed552fe6e2cf13930f7232562d43c264e62fe1853b4cf31cb93c3854195f4",
  };

  for (const [file, hash] of Object.entries(PINNED)) {
    it(`${file} is byte-identical to GATE-003's (the pilot edits none of it)`, () => {
      expect(sha256(readFileSync(join(root, file), "utf8"))).toBe(hash);
    });
  }

  // UG-IV-GATE-009: the one deliberate change to a preserved file. verifiedIdentity.ts is GATE-003's file plus the platform's no-store
  // override on its Supabase client (the defect is in communityVotingNextRuntime.contract.test.ts). Taking those two lines away must give
  // back GATE-003's exact bytes, so nothing else about the file moved.
  it("lib/gaming/communityVoting/verifiedIdentity.ts is GATE-003's, plus ONLY the no-store override", () => {
    const OVERRIDE = [
      "      // no-store, like every other repository: who a token belongs to is never answered from Next's data cache\n",
      '        global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },\n',
    ];
    const text = readFileSync(join(root, "lib/gaming/communityVoting/verifiedIdentity.ts"), "utf8");
    for (const line of OVERRIDE) expect(text).toContain(line);
    expect(sha256(OVERRIDE.reduce((t, line) => t.replace(line, ""), text))).toBe("2dbc8065e426bc100cf5677b26fc69ceca9cbc3867330d234114f0ebac18f616");
  });

  it("GATE-003's phone policy is untouched: a SINGLE_CHOICE Instance still binds an Auth user that has no Gaming Member and records none", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const single = await repo.registerInstance({
      sessionId: session.sessionId,
      hostToken: session.hostToken,
      config: VENUE,
      ruleVersion: 1,
    });
    const nobody = await newPerson({ member: false });
    const binding = await repo.bindVoter({ instanceId: single.instanceId, authUserId: nobody.authUserId });
    const [row] = await q<{ gaming_member_id: string | null }>("select gaming_member_id from community_voting_voter_bindings where binding_id = $1", [binding.bindingId]);
    expect(row.gaming_member_id).toBeNull();
  });
});

// =====================================================================================================================
// Identity: a confirmed email AND a Gaming Member profile, nothing else
// =====================================================================================================================

describe("identity policy of a round", () => {
  it("an unverified email cannot be bound (and no participant is left behind)", async () => {
    const r = await newRound("PRELIMINARY");
    const p = await newPerson({ email: "unconfirmed" });
    await expectCode(bind(r, p), "VERIFIED_EMAIL_REQUIRED");
    const rows = await q("select 1 from community_voting_voter_bindings where instance_id = $1 and auth_user_id = $2", [r.ctx.instanceId, p.authUserId]);
    expect(rows).toHaveLength(0);
    expect(await q("select 1 from participants where session_id = $1", [r.session.sessionId])).toHaveLength(0);
  });

  it("a user with no email at all (a telephone-only account) cannot be bound: a phone is not part of the pilot", async () => {
    const r = await newRound("PRELIMINARY");
    const p = await newPerson({ email: "none" });
    await expectCode(bind(r, p), "VERIFIED_EMAIL_REQUIRED");
  });

  it("a confirmed email without a Gaming Member profile cannot be bound; after the profile is completed the same person can", async () => {
    const r = await newRound("PRELIMINARY");
    const p = await newPerson({ member: false });
    await expectCode(bind(r, p), "PROFILE_INCOMPLETE");
    await completeProfile(p);
    const binding = await bind(r, p);
    expect(binding.created).toBe(true);
  });

  it("the binding records the canonical Gaming Member, is idempotent, and the SAME identity gets a binding per round without being duplicated", async () => {
    const p1 = await newRound("PRELIMINARY");
    const person = await newPerson();
    const a = await bind(p1, person);
    const again = await bind(p1, person);
    expect(again.bindingId).toBe(a.bindingId);
    expect(again.created).toBe(false);

    const second = await newRound("PRELIMINARY");
    const b = await bind(second, person);
    expect(b.bindingId).not.toBe(a.bindingId);

    const rows = await q<{ gaming_member_id: string; auth_user_id: string }>(
      "select gaming_member_id, auth_user_id from community_voting_voter_bindings where binding_id = any($1)",
      [[a.bindingId, b.bindingId]]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.gaming_member_id).toBe(person.gamingMemberId);
      expect(row.auth_user_id).toBe(person.authUserId);
    }
    expect(await q("select 1 from gaming_members where auth_user_id = $1", [person.authUserId])).toHaveLength(1);
  });

  it("the database itself refuses an unqualified binding, whoever writes it (no function in between)", async () => {
    const r = await newRound("PRELIMINARY");
    const p = await newPerson({ email: "unconfirmed" });
    const participant = randomUUID();
    await q("insert into participants (participant_id, session_id, display_name, normalized_display_name, participant_token, joined_at) values ($1, $2, $3, $3, $4, now())", [participant, r.session.sessionId, `cv-${participant.slice(0, 8)}`, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")]);
    await expectDbError(
      "insert into community_voting_voter_bindings (instance_id, auth_user_id, participant_id) values ($1, $2, $3)",
      [r.ctx.instanceId, p.authUserId, participant],
      "CV_VERIFIED_EMAIL_REQUIRED"
    );
  });

  it("a binding to anything other than a round never names a Gaming Member, and a round binding carries no telephone fact", async () => {
    const r = await newRound("PRELIMINARY");
    const p = await newPerson();
    const binding = await bind(r, p);
    // a round binding has nowhere to hold a telephone fact: the columns do not exist
    expect(await q("select 1 from information_schema.columns where table_name = 'community_voting_voter_bindings' and column_name like 'phone%'")).toHaveLength(0);
    await expectDbError("update community_voting_voter_bindings set phone_digest = $2 where binding_id = $1", [binding.bindingId, "a".repeat(64)], "does not exist");
    await expectDbError("update community_voting_voter_bindings set gaming_member_id = null where binding_id = $1", [binding.bindingId], "COMMUNITY_VOTING_HISTORY_IMMUTABLE");

    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const single = await repo.registerInstance({ sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 });
    const participant = randomUUID();
    await q("insert into participants (participant_id, session_id, display_name, normalized_display_name, participant_token, joined_at) values ($1, $2, $3, $3, $4, now())", [participant, session.sessionId, `cv-${participant.slice(0, 8)}`, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")]);
    await expectDbError(
      "insert into community_voting_voter_bindings (instance_id, auth_user_id, participant_id, gaming_member_id) values ($1, $2, $3, $4)",
      [single.instanceId, p.authUserId, participant, p.gamingMemberId],
      "only a two-round binding names a Gaming Member"
    );
  });

  it("a vote is refused when the identity no longer qualifies — the email unconfirmed after binding — and so is a replay", async () => {
    const r = await newRound("PRELIMINARY");
    const [a, b] = await contestants(r, 2);
    await openRound(r);
    const [ca] = await candidates(r);
    const voter = await newPerson();
    const first = await voteAs(r, voter, ca.candidateId);
    await q("update auth.users set email_confirmed_at = null where id = $1", [voter.authUserId]);
    const intent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId });
    await expectCode(
      repo.castRoundVote({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId, bindingId: first.binding.bindingId, intentNo: intent.intentNo, interactionInstanceId: r.started!.interactionInstanceId, candidateId: ca.candidateId, location: null }),
      "VERIFIED_EMAIL_REQUIRED"
    );
    await expectCode(
      repo.castRoundVote({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId, bindingId: first.binding.bindingId, intentNo: first.intent.intentNo, interactionInstanceId: r.started!.interactionInstanceId, candidateId: ca.candidateId, location: null }),
      "VERIFIED_EMAIL_REQUIRED"
    );
    expect(a.person.authUserId).not.toBe(b.person.authUserId);
  });

  it("defense in depth: a binding tampered with behind the application's back (its Gaming Member removed) can no longer cast", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const [ca] = await candidates(r);
    const voter = await newPerson();
    const binding = await bind(r, voter);
    const intent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId });
    const c = await rawClient();
    try {
      await c.query("alter table community_voting_voter_bindings disable trigger user");
      await c.query("update community_voting_voter_bindings set gaming_member_id = null where binding_id = $1", [binding.bindingId]);
      await c.query("alter table community_voting_voter_bindings enable trigger user");
    } finally {
      await c.end();
    }
    await expectCode(
      repo.castRoundVote({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId, bindingId: binding.bindingId, intentNo: intent.intentNo, interactionInstanceId: r.started!.interactionInstanceId, candidateId: ca.candidateId, location: null }),
      "PROFILE_INCOMPLETE"
    );
    expect(await votesIn(r)).toBe(0);
  });

  it("the person who cannot bind cannot reach the other operations either: no intent, no vote, no claim", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const [ca] = await candidates(r);
    const stranger = await newPerson({ email: "unconfirmed" });
    await expectCode(repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: stranger.authUserId }), "NOT_BOUND");
    await expectCode(
      repo.castRoundVote({ instanceId: r.ctx.instanceId, authUserId: stranger.authUserId, bindingId: randomUUID(), intentNo: 1, interactionInstanceId: r.started!.interactionInstanceId, candidateId: ca.candidateId, location: null }),
      "NOT_BOUND"
    );
    expect(await votesIn(r)).toBe(0);
  });
});

// =====================================================================================================================
// The preliminary: anywhere, one favorite, revisable until the operator closes
// =====================================================================================================================

describe("preliminary round", () => {
  it("has no venue: it cannot be registered with one, and its Instance stores none", async () => {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const operator = await newPerson();
    await expect(
      repo.registerRound({ sessionId: session.sessionId, hostToken: session.hostToken, operatorMemberId: operator.gamingMemberId!, ruleVersion: 1, roundRole: "PRELIMINARY", sourceInstanceId: null, venue: VENUE, windowSeconds: null })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const r = await newRound("PRELIMINARY");
    const [row] = await q("select venue_latitude, venue_radius_meters, window_seconds, finalist_cutoff, ballot_mode, round_role from community_voting_instances where instance_id = $1", [r.ctx.instanceId]);
    expect(row).toMatchObject({ venue_latitude: null, venue_radius_meters: null, window_seconds: null, finalist_cutoff: 10, ballot_mode: "FAVORITE_ROUND", round_role: "PRELIMINARY" });
  });

  it("accepts a vote with NO location, stores no location evidence, and never reads coordinates it is sent", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const [ca] = await candidates(r);
    const v = await newPerson();
    const { cast, binding } = await voteAs(r, v, ca.candidateId, null);
    expect(cast.outcome).toBe("APPLIED");
    const [row] = await q("select applied_distance_meters, applied_accuracy_meters, applied_intent_no from community_voting_voter_bindings where binding_id = $1", [binding.bindingId]);
    expect(row).toMatchObject({ applied_distance_meters: null, applied_accuracy_meters: null, applied_intent_no: 1 });

    // coordinates that would be far outside any venue are simply ignored, and still not stored
    const w = await newPerson();
    const withCoordinates = await voteAs(r, w, ca.candidateId, OUTSIDE);
    expect(withCoordinates.cast.outcome).toBe("APPLIED");
    const [row2] = await q("select applied_distance_meters from community_voting_voter_bindings where binding_id = $1", [withCoordinates.binding.bindingId]);
    expect(row2.applied_distance_meters).toBeNull();
  });

  it("allows ONE favorite per identity, revisable until close: the vote moves, it is never duplicated, and re-choosing the same one is a no-op", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 3);
    await openRound(r);
    const [c1, c2] = await candidates(r);
    const v = await newPerson();
    const first = await voteAs(r, v, c1.candidateId);
    expect(first.cast.outcome).toBe("APPLIED");
    const revised = await voteAs(r, v, c2.candidateId);
    expect(revised.cast.outcome).toBe("APPLIED");
    expect(revised.cast.candidateId).toBe(c2.candidateId);
    const same = await voteAs(r, v, c2.candidateId);
    expect(same.cast.outcome).toBe("UNCHANGED");

    expect(await votesIn(r)).toBe(1);
    const [vote] = await q<{ candidate_id: string }>("select candidate_id from votes where interaction_instance_id = $1", [r.started!.interactionInstanceId]);
    expect(vote.candidate_id).toBe(c2.candidateId);
    const status = await repo.readRoundVoterStatus({ instanceId: r.ctx.instanceId, authUserId: v.authUserId });
    expect(status?.myCandidateId).toBe(c2.candidateId);
  });

  it("recovers a lost confirmation without fabricating one: the same intent replays, an older one is stale, a different payload is refused", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 3);
    await openRound(r);
    const [c1, c2] = await candidates(r);
    const v = await newPerson();
    const first = await voteAs(r, v, c1.candidateId);
    const base = { instanceId: r.ctx.instanceId, authUserId: v.authUserId, bindingId: first.binding.bindingId, interactionInstanceId: r.started!.interactionInstanceId, location: null };
    const replay = await repo.castRoundVote({ ...base, intentNo: first.intent.intentNo, candidateId: c1.candidateId });
    expect(replay.outcome).toBe("REPLAYED");
    await expectCode(repo.castRoundVote({ ...base, intentNo: first.intent.intentNo, candidateId: c2.candidateId }), "INTENT_PAYLOAD_MISMATCH");
    await voteAs(r, v, c2.candidateId);
    await expectCode(repo.castRoundVote({ ...base, intentNo: first.intent.intentNo, candidateId: c1.candidateId }), "STALE_INTENT");
    expect(await votesIn(r)).toBe(1);
  });

  it("rejects a vote for the voter's own entry (attribution), a withdrawn contestant, an unknown candidate and an old interaction", async () => {
    const r = await newRound("PRELIMINARY");
    const [mine] = await contestants(r, 3);
    await openRound(r);
    const cands = await candidates(r);
    const own = cands.find((c) => c.entryId === mine.entry.entryId)!;
    await expect(voteAs(r, mine.person, own.candidateId)).rejects.toBeInstanceOf(SelfVoteNotAllowedError);

    const v = await newPerson();
    const other = cands.find((c) => c.entryId !== mine.entry.entryId)!;
    await withdraw({ ...r.ctx, entryId: other.entryId, reason: "El participante se retira" });
    await expectCode(voteAs(r, v, other.candidateId), "CANDIDATE_NOT_AVAILABLE");
    await expect(voteAs(r, v, randomUUID())).rejects.toMatchObject({ name: "InvalidCandidateSelectionError" });
    expect(await votesIn(r)).toBe(0);
  });

  it("hides per-contestant totals while it is open — the operator's overview carries counters only, the results are refused — and reveals them only after the close", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 3);
    await openRound(r);
    const [c1] = await candidates(r);
    await castMany(r, c1.candidateId, 2);
    const overview = await repo.readRoundOverview(r.ctx);
    expect(overview.counters.votes).toBe(2);
    // the only vote figure in the whole overview is the aggregate counter; no entry carries a count, a rank or a total
    expect(JSON.stringify(overview.entries)).not.toMatch(/vote|rank|total|count/i);
    expect(Object.keys(overview.counters).sort()).toEqual(["boundVoters", "entries", "votes", "withdrawn"]);
    await expectCode(repo.readRoundResults(r.ctx), "RESULTS_NOT_AVAILABLE");
    await repo.closeRound(r.ctx);
    const rows = await repo.readRoundResults(r.ctx);
    expect(rows.find((x) => x.candidateId === c1.candidateId)?.votes).toBe(2);
  });

  it("votes cannot be written, edited or removed by anything but the round's own vote operation", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const [c1, c2] = await candidates(r);
    const v = await newPerson();
    const first = await voteAs(r, v, c1.candidateId);
    const [participant] = await q<{ participant_id: string }>("select participant_id from community_voting_voter_bindings where binding_id = $1", [first.binding.bindingId]);
    await expectDbError("update votes set candidate_id = $2 where interaction_instance_id = $1", [r.started!.interactionInstanceId, c2.candidateId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await expectDbError("delete from votes where interaction_instance_id = $1", [r.started!.interactionInstanceId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    const other = await q<{ participant_id: string }>("select participant_id from participants where session_id = $1 limit 1", [r.session.sessionId]);
    await expectDbError(
      "insert into votes (interaction_instance_id, participant_id, candidate_id) values ($1, $2, $3)",
      [r.started!.interactionInstanceId, other[0].participant_id === participant.participant_id ? randomUUID() : other[0].participant_id, c2.candidateId],
      "COMMUNITY_VOTING_ROUND_PATH_REQUIRED"
    );
    expect(await votesIn(r)).toBe(1);
  });
});

// =====================================================================================================================
// Close, review, publication: three separate acts
// =====================================================================================================================

describe("close, review and publication", () => {
  it("a round cannot be closed or revealed by the Session's ordinary functions — only by its own operations", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    await expect(sessionRepo.closeSubmissions(r.session.sessionId, r.session.hostToken, { eventType: "SUBMISSIONS_CLOSED", payload: {} } as never)).rejects.toThrow();
    const [s] = await q<{ state: string }>("select state from interaction_instances where interaction_instance_id = $1", [r.started!.interactionInstanceId]);
    expect(s.state).toBe("PROMPT_ACTIVE");
    await expectDbError("update interaction_instances set state = 'SUBMISSIONS_CLOSED' where interaction_instance_id = $1", [r.started!.interactionInstanceId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await expectCode(repo.publishRound(r.ctx), "RESULTS_NOT_AVAILABLE");
  });

  it("only the designated operator, with the host token, can run the operator operations", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const intruder = await newPerson();
    await expectCode(repo.closeRound({ ...r.ctx, operatorMemberId: intruder.gamingMemberId! }), "OPERATOR_REQUIRED");
    await expect(repo.closeRound({ ...r.ctx, hostToken: "x".repeat(32) })).rejects.toMatchObject({ name: "HostTokenMismatchError" });
    await expectCode(repo.readRoundOverview({ ...r.ctx, operatorMemberId: intruder.gamingMemberId! }), "OPERATOR_REQUIRED");
  });

  it("closing stops votes (a new intent is refused), still answers a replay, and records one closure whose digest the TypeScript rules reproduce", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 3);
    await openRound(r);
    const [c1, c2] = await candidates(r);
    const keeper = await newPerson();
    const kept = await voteAs(r, keeper, c1.candidateId);
    await castMany(r, c2.candidateId, 2);
    const late = await newPerson();
    await bind(r, late);
    const closure = await repo.closeRound(r.ctx);
    expect(closure.validVoteCount).toBe(3);
    await expectCode(repo.closeRound(r.ctx), "ALREADY_CLOSED");

    await expectCode(repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: late.authUserId }), "VOTING_NOT_OPEN");
    // nobody new is admitted once the round has closed
    await expectCode(bind(r, await newPerson()), "ADMISSION_CLOSED");
    const replay = await repo.castRoundVote({ instanceId: r.ctx.instanceId, authUserId: keeper.authUserId, bindingId: kept.binding.bindingId, intentNo: kept.intent.intentNo, interactionInstanceId: r.started!.interactionInstanceId, candidateId: c1.candidateId, location: null });
    expect(replay.outcome).toBe("REPLAYED");

    const rows = await repo.readRoundResults(r.ctx);
    expect(roundResultsDigest("PRELIMINARY", 3, toTallies(rows))).toBe(closure.resultsDigest);
    // the closure carries no removal instant: no retention period has been approved, so none is recorded or enforced
    expect(Object.keys(closure).sort()).toEqual(["closedAt", "resultsDigest", "validVoteCount"]);
  });

  it("publication needs a review of the CURRENT result: none -> REVIEW_REQUIRED; a result that changed after the review -> REVIEW_STALE; then it publishes once", async () => {
    const r = await newRound("PRELIMINARY");
    const people = await contestants(r, 3);
    await openRound(r);
    const [c1] = await candidates(r);
    await castMany(r, c1.candidateId, 2);
    await repo.closeRound(r.ctx);
    await cut(r);
    await expectCode(repo.publishRound(r.ctx), "REVIEW_REQUIRED");

    const stale = await repo.recordRoundReview({ ...r.ctx, note: "Revisión operativa" });
    // a contestant withdraws between the review and the publication: the result is no longer the one that was reviewed
    const withdrawn = (await candidates(r)).find((c) => c.entryId === people[2].entry.entryId)!;
    await withdraw({ ...r.ctx, entryId: withdrawn.entryId, reason: "Retiro" });
    await expectCode(repo.publishRound(r.ctx), "REVIEW_STALE");
    // the withdrawn contestant was a finalist: publishing also waits for Product's decision about that (recorded after the stale review)
    await approve(r, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);

    const fresh = await repo.recordRoundReview({ ...r.ctx });
    expect(fresh.resultsDigest).not.toBe(stale.resultsDigest);
    const published = await repo.publishRound(r.ctx);
    expect(published.resultsDigest).toBe(fresh.resultsDigest);
    await expectCode(repo.publishRound(r.ctx), "ALREADY_PUBLISHED");

    const [state] = await q<{ state: string }>("select state from interaction_instances where interaction_instance_id = $1", [r.started!.interactionInstanceId]);
    expect(state.state).toBe("RESULT_REVEAL");
    const actions = (await repo.readRoundEvidence(r.ctx)).operatorActions.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["OPEN_VOTING", "CLOSE_VOTING", "SELECT_FINALISTS", "REVIEW_RESULTS", "PUBLISH_RESULTS"]));
  });

  it("the preliminary cannot be reviewed before its finalists are selected, and the public sees nothing until publication", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    await repo.closeRound(r.ctx);
    await expectCode(repo.recordRoundReview(r.ctx), "FINALISTS_NOT_SELECTED");
    expect(await repo.readRoundPublicResults(r.ctx.instanceId)).toEqual([]);
    await cut(r);
    await repo.recordRoundReview(r.ctx);
    expect(await repo.readRoundPublicResults(r.ctx.instanceId)).toEqual([]);
    await repo.publishRound(r.ctx);
    const announced = await repo.readRoundPublicResults(r.ctx.instanceId);
    expect(announced.map((x) => x.kind)).toEqual(["FINALISTS", "FINALISTS"]);
  });

  it("the review, the publication and the closure cannot be written around the operations", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    await expectDbError("insert into community_voting_round_reviews (instance_id, results_digest, reviewed_by_member_id) values ($1, $2, $3)", [r.ctx.instanceId, "a".repeat(64), r.operator.gamingMemberId], "only a closed round can be reviewed");
    await expectDbError("insert into community_voting_closures (instance_id, interaction_instance_id, closed_by_member_id, valid_vote_count, results_digest) values ($1, $2, $3, 0, $4)", [r.ctx.instanceId, r.started!.interactionInstanceId, r.operator.gamingMemberId, "a".repeat(64)], "a closure is recorded only for an interaction that has closed");
    await repo.closeRound(r.ctx);
    await expectDbError("insert into community_voting_publications (instance_id, review_id, results_digest, published_by_member_id) values ($1, $2, $3, $4)", [r.ctx.instanceId, randomUUID(), "a".repeat(64), r.operator.gamingMemberId], "a publication commits to a review");
    await expectDbError("update community_voting_closures set results_digest = $2 where instance_id = $1", [r.ctx.instanceId, "b".repeat(64)], "cannot be changed");
  });
});

// =====================================================================================================================
// The finalist cut: ten plus every contestant tied with the tenth
// =====================================================================================================================

describe("finalist selection", () => {
  async function scenario(votePlan: number[], opts: { withdraw?: number[] } = {}) {
    const r = await newRound("PRELIMINARY");
    const people = await contestants(r, votePlan.length);
    await openRound(r);
    const cands = await candidates(r);
    // candidate i belongs to people[i] (same creation order and ordinal)
    for (let i = 0; i < votePlan.length; i++) await castMany(r, cands[i].candidateId, votePlan[i]);
    for (const idx of opts.withdraw ?? []) await withdraw({ ...r.ctx, entryId: cands[idx].entryId, reason: "Retiro" });
    const closure = await repo.closeRound(r.ctx);
    const selection = await cut(r);
    const rows = await repo.readRoundResults(r.ctx);
    return { r, people, cands, closure, selection, rows };
  }

  it("advances every contestant tied at the cutoff: thirteen contestants, a rank-5 group straddling position ten, eleven finalists", async () => {
    // votes: 3, 2,2,2, 1x7, 0,0  -> ranks 1, 2,2,2, 5x7, 12,12
    const plan = [3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0];
    const { selection, rows, closure } = await scenario(plan);
    expect(selection.eligibleCount).toBe(13);
    expect(selection.finalistCount).toBe(11);
    const finalists = rows.filter((x) => x.finalist);
    expect(finalists.map((x) => x.competitionRank).sort((a, b) => (a as number) - (b as number))).toEqual([1, 2, 2, 2, 5, 5, 5, 5, 5, 5, 5]);
    expect(rows.filter((x) => x.competitionRank === 12).every((x) => !x.finalist)).toBe(true);

    // the database and the TypeScript rules agree, vector for vector
    const tallies = toTallies(rows);
    expect(selectFinalists(tallies).map((x) => x.ordinal)).toEqual(finalists.map((x) => x.ordinal));
    expect(selection.selectionDigest).toBe(finalistSelectionDigest(tallies));
    expect(closure.resultsDigest).toBe(roundResultsDigest("PRELIMINARY", plan.reduce((a, b) => a + b, 0), tallies));
  });

  it("a tie that BEGINS at position ten pulls its whole group in: twelve contestants, three tied at rank ten, all twelve advance", async () => {
    // votes 2,2, 1x7, 0,0,0 -> ranks 1,1, 3x7, 10,10,10
    const { selection, rows } = await scenario([2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(rows.map((x) => x.competitionRank)).toEqual([1, 1, 3, 3, 3, 3, 3, 3, 3, 10, 10, 10]);
    expect(selection.finalistCount).toBe(12);
    expect(rows.every((x) => x.finalist)).toBe(true);
  });

  it("a tie that begins at position eleven stays out: the contestants at rank eleven do not advance", async () => {
    // votes 3, 2,2, 1x7, 0,0 -> ranks 1, 2,2, 4x7, 11,11
    const { selection, rows } = await scenario([3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(rows.map((x) => x.competitionRank)).toEqual([1, 2, 2, 4, 4, 4, 4, 4, 4, 4, 11, 11]);
    expect(selection.finalistCount).toBe(10);
    expect(rows.filter((x) => x.finalist).every((x) => (x.competitionRank as number) <= 10)).toBe(true);
    expect(rows.filter((x) => x.competitionRank === 11).every((x) => !x.finalist)).toBe(true);
  });

  it("advances everyone when there are ten or fewer contestants", async () => {
    const { selection, rows } = await scenario([2, 1, 0, 0]);
    expect(selection.finalistCount).toBe(4);
    expect(rows.every((x) => x.finalist)).toBe(true);
  });

  it("advances everyone when nobody voted: all tie at rank 1", async () => {
    const { selection, rows } = await scenario([0, 0, 0]);
    expect(selection.finalistCount).toBe(3);
    expect(rows.map((x) => x.competitionRank)).toEqual([1, 1, 1]);
  });

  it("excludes a contestant who withdrew from the total, the rank and the cut, while their votes stay in the store", async () => {
    // contestant 0 would have won with 3 votes; withdrawn, the ranking is computed among the other three
    const { selection, rows, cands } = await scenario([3, 2, 1, 1], { withdraw: [0] });
    expect(selection.eligibleCount).toBe(3);
    const w = rows.find((x) => x.candidateId === cands[0].candidateId)!;
    expect(w).toMatchObject({ withdrawn: true, competitionRank: null, finalist: false });
    expect(rows.filter((x) => !x.withdrawn).map((x) => x.competitionRank)).toEqual([1, 2, 2]);
    const [stored] = await q<{ n: string }>("select count(*) n from votes where candidate_id = $1", [cands[0].candidateId]);
    expect(Number(stored.n)).toBe(3);
  });

  it("is deterministic and free of discretion: the operation takes no list, repeats as a no-op, and needs a closed round", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 3);
    await expectCode(repo.selectFinalists(r.ctx), "RESULTS_NOT_AVAILABLE");
    await openRound(r);
    await expectCode(repo.selectFinalists(r.ctx), "RESULTS_NOT_AVAILABLE");
    await repo.closeRound(r.ctx);
    const first = await cut(r);
    const again = await cut(r);
    expect(first.alreadySelected).toBe(false);
    expect(again.alreadySelected).toBe(true);
    expect(again.selectionDigest).toBe(first.selectionDigest);
    expect(await q("select 1 from community_voting_finalists where preliminary_instance_id = $1", [r.ctx.instanceId])).toHaveLength(3);
  });

  it("the finalist records cannot be written, changed or removed outside the selection", async () => {
    const { r, cands } = await scenario([1, 0]);
    await expectDbError("insert into community_voting_finalists (preliminary_instance_id, entry_id, candidate_id, competition_rank, votes_at_selection) values ($1, $2, $3, 1, 0)", [r.ctx.instanceId, cands[0].entryId, cands[0].candidateId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
    await expectDbError("update community_voting_finalists set competition_rank = 9 where preliminary_instance_id = $1", [r.ctx.instanceId], "cannot be changed");
    await expectDbError("delete from community_voting_finalists where preliminary_instance_id = $1", [r.ctx.instanceId], "cannot be deleted");
  });
});

// =====================================================================================================================
// The final: finalists only, from zero, geofence on every vote and revision, a server window
// =====================================================================================================================

describe("final round", () => {
  /** A closed preliminary with `plan` votes per contestant and its finalist cut, and a registered (not yet prepared) final. */
  async function chain(plan: number[], opts: { windowSeconds?: number } = {}) {
    const p = await newRound("PRELIMINARY", { operator: await newPerson() });
    const people = await contestants(p, plan.length);
    await openRound(p);
    const pc = await candidates(p);
    for (let i = 0; i < plan.length; i++) await castMany(p, pc[i].candidateId, plan[i]);
    await repo.closeRound(p.ctx);
    const selection = await cut(p);
    const f = await newRound("FINAL", { source: p, operator: p.operator, windowSeconds: opts.windowSeconds });
    return { p, f, people, pc, selection };
  }

  it("is registered only as the descendant of a preliminary of the same operator, with the complete geofence and a window", async () => {
    const p = await newRound("PRELIMINARY");
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const base = { sessionId: session.sessionId, hostToken: session.hostToken, operatorMemberId: p.operator.gamingMemberId!, ruleVersion: 1, roundRole: "FINAL" as const };
    await expect(repo.registerRound({ ...base, sourceInstanceId: null, venue: VENUE, windowSeconds: 300 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(repo.registerRound({ ...base, sourceInstanceId: p.ctx.instanceId, venue: null, windowSeconds: 300 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(repo.registerRound({ ...base, sourceInstanceId: p.ctx.instanceId, venue: VENUE, windowSeconds: null })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // another operator's preliminary, or a final as a source, are refused by the database itself
    const other = await newPerson();
    await expect(repo.registerRound({ ...base, operatorMemberId: other.gamingMemberId!, sourceInstanceId: p.ctx.instanceId, venue: VENUE, windowSeconds: 300 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // a window outside the database's bounds is refused
    await expect(repo.registerRound({ ...base, sourceInstanceId: p.ctx.instanceId, venue: VENUE, windowSeconds: 5 })).rejects.toThrow();
    const ok = await repo.registerRound({ ...base, sourceInstanceId: p.ctx.instanceId, venue: VENUE, windowSeconds: 300 });
    expect(ok).toMatchObject({ roundRole: "FINAL", windowSeconds: 300, sourceInstanceId: p.ctx.instanceId });
    // one final per preliminary
    const again = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, again.sessionId, again.hostToken, ["VOTING"] as never);
    await expect(repo.registerRound({ ...base, sessionId: again.sessionId, hostToken: again.hostToken, sourceInstanceId: p.ctx.instanceId, venue: VENUE, windowSeconds: 300 })).rejects.toThrow();
  });

  it("is prepared only from the finalist cut: nothing before it, only the finalists after it, once, with each contestant's own identity — and no vote carried over", async () => {
    const p0 = await newRound("PRELIMINARY");
    const f0 = await newRound("FINAL", { source: p0, operator: p0.operator });
    await expectCode(repo.prepareFinal(f0.ctx), "FINALISTS_NOT_SELECTED");

    // 12 contestants: votes 5,4,3,3,... so that several fall below the cut? with <=10 all advance; use 12 to force a real cut
    const plan = [6, 5, 4, 3, 3, 2, 2, 2, 1, 1, 0, 0]; // ranks 1,2,3,4,4,6,6,6,9,9,11,11 -> cutoff 10 keeps the first ten
    const { p, f, people, pc, selection } = await chain(plan);
    expect(selection.finalistCount).toBe(10);
    const prepared = await repo.prepareFinal(f.ctx);
    expect(prepared).toEqual({ carriedCount: 10, alreadyPrepared: false });
    expect(await repo.prepareFinal(f.ctx)).toEqual({ carriedCount: 10, alreadyPrepared: true });

    const entries = await q<{ label: string; source_entry_id: string; confirmed_binding_id: string }>(
      "select label, source_entry_id, confirmed_binding_id from community_voting_entries where instance_id = $1 order by ordinal",
      [f.ctx.instanceId]
    );
    expect(entries).toHaveLength(10);
    // the final's entries keep the contestant's public number and point at the preliminary entry
    const sourceLabels = await q<{ label: string }>("select label from community_voting_entries where entry_id = any($1) order by ordinal", [entries.map((e) => e.source_entry_id)]);
    expect(entries.map((e) => e.label)).toEqual(sourceLabels.map((s) => s.label));
    // each finalist's binding in the final belongs to the SAME canonical identity as their binding in the preliminary
    const pairs = await q<{ same: boolean }>(
      `select (fb.gaming_member_id = pb.gaming_member_id and fb.auth_user_id = pb.auth_user_id) as same
       from community_voting_entries fe
       join community_voting_entries pe on pe.entry_id = fe.source_entry_id
       join community_voting_voter_bindings fb on fb.binding_id = fe.confirmed_binding_id
       join community_voting_voter_bindings pb on pb.binding_id = pe.confirmed_binding_id
       where fe.instance_id = $1`,
      [f.ctx.instanceId]
    );
    expect(pairs).toHaveLength(10);
    expect(pairs.every((x) => x.same)).toBe(true);
    // the final starts from nothing: no vote, no candidate
    expect(await q("select 1 from community_voting_entries where instance_id = $1 and candidate_id is not null", [f.ctx.instanceId])).toHaveLength(0);
    expect(people).toHaveLength(12);
    expect(pc).toHaveLength(12);
    void p;
  });

  it("a contestant who withdrew before the final is prepared is left out, and a final needs at least two entries", async () => {
    const { p, f, pc } = await chain([2, 1, 0]);
    await withdraw({ ...p.ctx, entryId: pc[2].entryId, reason: "Retiro" });
    expect(await prepare(f, p)).toEqual({ carriedCount: 2, alreadyPrepared: false });

    const solo = await chain([2, 1]);
    await repo.withdrawRoundCandidature({ ...solo.p.ctx, entryId: solo.pc[1].entryId, reason: "Retiro" , hidePhoto: false });
    await prepare(solo.f, solo.p);
    await lockLobby(sessionRepo, solo.f.session.sessionId, solo.f.session.hostToken);
    await expectCode(repo.startRound({ ...solo.f.ctx, promptText: "Final" }), "PREPARATION_INCOMPLETE");
  });

  it("votes start from zero and are separate from the preliminary: the same identity votes in both rounds, once in each, and nothing accumulates", async () => {
    const { p, f, pc } = await chain([3, 2, 1]);
    await repo.prepareFinal(f.ctx);
    const finalStart = await openRound(f);
    expect(finalStart.candidateCount).toBe(3);
    expect(await votesIn(f)).toBe(0);

    const fc = await candidates(f);
    const voter = await newPerson();
    // this person already voted in the preliminary? vote there is closed; use a person who did vote there
    const pVoter = (await q<{ auth_user_id: string }>("select b.auth_user_id from votes v join community_voting_voter_bindings b on b.participant_id = v.participant_id where v.candidate_id = $1 limit 1", [pc[0].candidateId]))[0];
    expect(pVoter).toBeTruthy();
    const shared: Person = { authUserId: pVoter.auth_user_id, gamingMemberId: (await q<{ gaming_member_id: string }>("select gaming_member_id from gaming_members where auth_user_id = $1", [pVoter.auth_user_id]))[0].gaming_member_id };

    const finalVote = await voteAs(f, shared, fc[1].candidateId, INSIDE);
    expect(finalVote.cast.outcome).toBe("APPLIED");
    await voteAs(f, voter, fc[1].candidateId, INSIDE);

    // one vote row per round for the shared identity, in two different interactions and with two different bindings
    const rowsFor = await q<{ interaction_instance_id: string }>(
      "select v.interaction_instance_id from votes v join participants pa on pa.participant_id = v.participant_id join community_voting_voter_bindings b on b.participant_id = pa.participant_id where b.auth_user_id = $1",
      [shared.authUserId]
    );
    expect(new Set(rowsFor.map((x) => x.interaction_instance_id)).size).toBe(2);
    expect(rowsFor).toHaveLength(2);

    // the final's tally counts only final votes: candidate 1 has 2 votes here, however many it had in the preliminary
    await repo.closeRound(f.ctx);
    const results = await repo.readRoundResults(f.ctx);
    expect(results.find((x) => x.candidateId === fc[1].candidateId)?.votes).toBe(2);
    expect(results.reduce((a, x) => a + x.votes, 0)).toBe(2);
    const preliminary = await repo.readRoundResults(p.ctx);
    expect(preliminary.reduce((a, x) => a + x.votes, 0)).toBe(6);
  });

  it("asks for a location with EVERY vote and EVERY revision, and only an INSIDE reading is accepted", async () => {
    const { f } = await chain([2, 1]);
    await repo.prepareFinal(f.ctx);
    await openRound(f);
    const [c1, c2] = await candidates(f);
    const v = await newPerson();
    await expectCode(voteAs(f, v, c1.candidateId, null), "INVALID_LOCATION_READING");
    await expectCode(voteAs(f, v, c1.candidateId, OUTSIDE), "LOCATION_OUTSIDE");
    await expectCode(voteAs(f, v, c1.candidateId, { ...INSIDE, accuracyMeters: 500 }), "LOCATION_ACCURACY_EXCESSIVE");
    expect(await votesIn(f)).toBe(0);

    const ok = await voteAs(f, v, c1.candidateId, INSIDE);
    expect(ok.cast.outcome).toBe("APPLIED");
    // a revision is a new vote: it needs a location too, and a refused revision leaves the standing vote untouched
    await expectCode(voteAs(f, v, c2.candidateId, null), "INVALID_LOCATION_READING");
    await expectCode(voteAs(f, v, c2.candidateId, OUTSIDE), "LOCATION_OUTSIDE");
    expect((await repo.readRoundVoterStatus({ instanceId: f.ctx.instanceId, authUserId: v.authUserId }))?.myCandidateId).toBe(c1.candidateId);
    const revised = await voteAs(f, v, c2.candidateId, INSIDE);
    expect(revised.cast.outcome).toBe("APPLIED");
    expect(await votesIn(f)).toBe(1);
    // the stored evidence is derived (distance and accuracy), never a coordinate
    const [ev] = await q("select applied_distance_meters, applied_accuracy_meters from community_voting_voter_bindings where binding_id = $1", [revised.binding.bindingId]);
    expect(Number(ev.applied_distance_meters)).toBeLessThan(5);
  });

  it("enforces the five-minute window on the DATABASE clock: a new intent after it is refused, a replay is still answered, the status carries the server's deadline", async () => {
    const { f } = await chain([2, 1]);
    await repo.prepareFinal(f.ctx);
    const started = await openRound(f);
    expect(new Date(started.deadlineAt!).getTime() - new Date(started.openedAt).getTime()).toBe(300_000);
    const [c1, c2] = await candidates(f);
    const v = await newPerson();
    const first = await voteAs(f, v, c1.candidateId, INSIDE);

    const status = await repo.readRoundVoterStatus({ instanceId: f.ctx.instanceId, authUserId: v.authUserId });
    expect(status?.deadlineAt).toBe(started.deadlineAt);
    expect(new Date(status!.serverNow).getTime()).toBeLessThan(new Date(status!.deadlineAt!).getTime());

    // time travel: the final opened 301 seconds ago
    await q("update interaction_instances set created_at = created_at - interval '301 seconds' where interaction_instance_id = $1", [started.interactionInstanceId]);
    const late = await newPerson();
    await bind(f, late);
    const intent = await repo.issueIntent({ instanceId: f.ctx.instanceId, authUserId: late.authUserId });
    await expectCode(
      repo.castRoundVote({ instanceId: f.ctx.instanceId, authUserId: late.authUserId, bindingId: (await bind(f, late)).bindingId, intentNo: intent.intentNo, interactionInstanceId: started.interactionInstanceId, candidateId: c1.candidateId, location: INSIDE }),
      "VOTING_WINDOW_ELAPSED"
    );
    // a revision is refused too ...
    await expectCode(voteAs(f, v, c2.candidateId, INSIDE), "VOTING_WINDOW_ELAPSED");
    // ... but the confirmation of the vote that was accepted can still be recovered
    const replay = await repo.castRoundVote({ instanceId: f.ctx.instanceId, authUserId: v.authUserId, bindingId: first.binding.bindingId, intentNo: first.intent.intentNo, interactionInstanceId: started.interactionInstanceId, candidateId: c1.candidateId, location: INSIDE });
    expect(replay.outcome).toBe("REPLAYED");
    expect(await votesIn(f)).toBe(1);
  });

  it("a final's tie is shared: both contestants are winners, in the operator's view and in the public announcement after publication", async () => {
    const { f } = await chain([2, 1, 1]);
    await repo.prepareFinal(f.ctx);
    await openRound(f);
    const cands = await candidates(f);
    await castMany(f, cands[0].candidateId, 2, INSIDE);
    await castMany(f, cands[1].candidateId, 2, INSIDE);
    await castMany(f, cands[2].candidateId, 1, INSIDE);
    const closure = await repo.closeRound(f.ctx);
    const rows = await repo.readRoundResults(f.ctx);
    expect(rows.filter((x) => x.winner)).toHaveLength(2);
    expect(rows.map((x) => x.competitionRank)).toEqual([1, 1, 3]);
    expect(selectWinners(toTallies(rows)).map((x) => x.ordinal)).toEqual(rows.filter((x) => x.winner).map((x) => x.ordinal));
    expect(closure.resultsDigest).toBe(roundResultsDigest("FINAL", 5, toTallies(rows)));

    const review = await repo.recordRoundReview(f.ctx);
    expect(review.resultsDigest).toBe(reviewDigest(closure.resultsDigest, null, [], []));
    expect(await repo.readRoundPublicResults(f.ctx.instanceId)).toEqual([]);
    await repo.publishRound(f.ctx);
    const winners = await repo.readRoundPublicResults(f.ctx.instanceId);
    expect(winners.map((w) => w.kind)).toEqual(["WINNERS", "WINNERS"]);
    expect(winners).toHaveLength(2);
  });

  it("entries of a final exist only as descendants of the preliminary's; a final owns no photograph", async () => {
    const { f, p, pc } = await chain([1, 0]);
    // the operator cannot create an entry in a final, and the guard refuses a descendant-less row
    await expectCode(repo.createRoundEntry(f.ctx), "WRONG_ROUND");
    expect(await q("select 1 from community_voting_entries where instance_id = $1", [f.ctx.instanceId])).toHaveLength(0);
    await prepare(f, p);
    const [fe] = await q<{ entry_id: string }>("select entry_id from community_voting_entries where instance_id = $1 limit 1", [f.ctx.instanceId]);
    await expectCode(repo.uploadEntryPhoto({ ...f.ctx, entryId: fe.entry_id, ...photoArgs(seedCounter++) }), "WRONG_ROUND");
    // and not even by a direct write
    await expectDbError(
      "insert into community_voting_entry_photos (instance_id, entry_id, width, height, full_bytes, thumb_bytes, full_sha256, thumb_sha256, full_size, thumb_size, uploaded_by_member_id) values ($1, $2, 1, 1, '\\xffd8ffd9', '\\xffd8ffd9', repeat('a',64), repeat('a',64), 4, 4, $3)",
      [f.ctx.instanceId, fe.entry_id, f.operator.gamingMemberId],
      "COMMUNITY_VOTING_FINAL_ENTRY_SOURCE"
    );
    expect(p.ctx.instanceId).not.toBe(f.ctx.instanceId);
    expect(pc).toHaveLength(2);
  });
});

// =====================================================================================================================
// Withdrawal: one act, honored in both rounds
// =====================================================================================================================

describe("withdrawal across both rounds", () => {
  it("withdrawing a finalist in the FINAL withdraws the person from the preliminary too, erases the photograph now, and stops new votes", async () => {
    const p = await newRound("PRELIMINARY");
    const people = await contestants(p, 3);
    await openRound(p);
    const pc = await candidates(p);
    await castMany(p, pc[0].candidateId, 2);
    await repo.closeRound(p.ctx);
    await cut(p);
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await prepare(f, p);
    await openRound(f);
    const fc = await candidates(f);
    const target = fc[0];

    const w = await repo.withdrawRoundCandidature({ ...f.ctx, entryId: target.entryId, reason: "El participante se retira", hidePhoto: true });
    expect(w.cascaded).toBe(1);
    expect(w.duringVoting).toBe(true);
    expect(w.photoHidden).toBe(true);

    const withdrawals = await q("select instance_id from community_voting_withdrawals where entry_id in (select entry_id from community_voting_entries where label = $1)", [target.label]);
    expect(new Set(withdrawals.map((x) => x.instance_id))).toEqual(new Set([p.ctx.instanceId, f.ctx.instanceId]));
    const [photo] = await q("select bytes_deleted_at, bytes_deleted_reason, full_bytes from community_voting_entry_photos where entry_id = $1", [people[0].entry.entryId]);
    expect(photo).toMatchObject({ bytes_deleted_reason: "PRIVACY_REQUEST", full_bytes: null });
    expect(photo.bytes_deleted_at).toBeTruthy();

    await expectCode(voteAs(f, await newPerson(), target.candidateId, INSIDE), "CANDIDATE_NOT_AVAILABLE");
    const gallery = await repo.readRoundGallery(f.ctx.instanceId);
    expect(gallery.map((g) => g.alias)).not.toContain(target.label);
    expect(await repo.readRoundPhoto({ instanceId: f.ctx.instanceId, alias: target.label.slice(1), variant: "thumb" })).toBeNull();
    expect(await repo.readRoundPhoto({ instanceId: p.ctx.instanceId, alias: target.label.slice(1), variant: "thumb" })).toBeNull();
    await expectCode(withdraw({ ...f.ctx, entryId: target.entryId, reason: "otra vez" }), "ENTRY_ALREADY_WITHDRAWN");
    // the votes already cast for them are still in the store (evidence), and the selection of finalists was not touched
    expect(Number((await q<{ n: string }>("select count(*) n from votes where candidate_id = $1", [pc[0].candidateId]))[0].n)).toBe(2);
  });

  it("a withdrawal is possible after the close, leaves the totals, and cannot be written around the operation", async () => {
    const p = await newRound("PRELIMINARY");
    await contestants(p, 3);
    await openRound(p);
    const pc = await candidates(p);
    await castMany(p, pc[0].candidateId, 2);
    await castMany(p, pc[1].candidateId, 1);
    await repo.closeRound(p.ctx);
    const w = await withdraw({ ...p.ctx, entryId: pc[0].entryId, reason: "Retiro posterior al cierre" });
    expect(w.duringVoting).toBe(false);
    const rows = await repo.readRoundResults(p.ctx);
    expect(rows.find((x) => x.candidateId === pc[0].candidateId)).toMatchObject({ withdrawn: true, competitionRank: null });
    expect(rows.find((x) => x.candidateId === pc[1].candidateId)?.competitionRank).toBe(1);
    await expectDbError("insert into community_voting_withdrawals (instance_id, entry_id, candidate_id, reason, recorded_by_member_id) values ($1, $2, $3, 'x', $4)", [p.ctx.instanceId, pc[2].entryId, pc[2].candidateId, p.operator.gamingMemberId], "COMMUNITY_VOTING_ROUND_PATH_REQUIRED");
  });
});

// =====================================================================================================================
// Photographs, consents and what the public may see
// =====================================================================================================================

describe("photographs and consents", () => {
  it("a photograph cannot be approved without the gallery/contest consent, and the promotional decision is a separate, optional record", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(seedCounter++) });
    await expectCode(repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" }), "CONSENT_REQUIRED");
    expect((await repo.readRoundOverview(r.ctx)).entries[0].promotional).toBe("NOT_ASKED");

    // declining the promotional use never prevents competing
    await repo.recordPromoConsent({ ...r.ctx, entryId: entry.entryId, decision: "DECLINED", consentVersion: PROMO_CONSENT_VERSION, statementSha256: PROMO_CONSENT_SHA256 });
    await repo.recordEntryConsent({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256, ageConfirmed: true });
    await repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" });
    const overview = await repo.readRoundOverview(r.ctx);
    expect(overview.entries[0]).toMatchObject({ media: "APPROVED", promotional: "DECLINED" });

    const consents = await q("select consent_version, statement_sha256 from community_voting_entry_consents where entry_id = $1", [entry.entryId]);
    expect(consents).toEqual([{ consent_version: GALLERY_CONSENT_VERSION, statement_sha256: GALLERY_CONSENT_SHA256 }]);
    const promo = await q("select decision, consent_version, statement_sha256 from community_voting_promo_consents where entry_id = $1", [entry.entryId]);
    expect(promo).toEqual([{ decision: "DECLINED", consent_version: PROMO_CONSENT_VERSION, statement_sha256: PROMO_CONSENT_SHA256 }]);
    expect(PROMO_CONSENT_SHA256).not.toBe(GALLERY_CONSENT_SHA256);
  });

  it("the promotional decision can change (declined -> accepted -> withdrawn), only a standing acceptance can be withdrawn, and it is the person's: a final's entry stores it on the preliminary's", async () => {
    const p = await newRound("PRELIMINARY");
    const people = await contestants(p, 2);
    const e = people[0].entry.entryId;
    const call = (decision: "ACCEPTED" | "DECLINED" | "WITHDRAWN") =>
      repo.recordPromoConsent({ ...p.ctx, entryId: e, decision, consentVersion: PROMO_CONSENT_VERSION, statementSha256: PROMO_CONSENT_SHA256 });
    await expectCode(call("WITHDRAWN"), "INVALID_REQUEST");
    await call("DECLINED");
    await expectCode(call("DECLINED"), "CONSENT_ALREADY_RECORDED");
    await call("ACCEPTED");
    await call("WITHDRAWN");
    const overview = await repo.readRoundOverview(p.ctx);
    expect(overview.entries.find((x) => x.entryId === e)?.promotional).toBe("WITHDRAWN");
    expect(await q("select decision from community_voting_promo_consents where entry_id = $1 order by recorded_at", [e])).toHaveLength(3);
    await expectDbError("update community_voting_promo_consents set decision = 'ACCEPTED' where entry_id = $1", [e], "cannot be changed");
  });

  it("the public sees a contestant once the association is confirmed and the photograph approved — before or after the round opens — and nobody whose association is unconfirmed", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    const approvedNotConfirmed = await approvedEntry(r);
    // photographs may be shown before voting opens (a permission to SHOW), but never for an entry whose person is not confirmed
    expect(await repo.readRoundGallery(r.ctx.instanceId)).toHaveLength(2);
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: approvedNotConfirmed.entry.label.slice(1), variant: "thumb" })).toBeNull();

    // an unconfirmed entry blocks the opening: readiness requires every contestant to be confirmed
    await lockLobby(sessionRepo, r.session.sessionId, r.session.hostToken);
    await expectCode(repo.startRound({ ...r.ctx, promptText: "Mejor disfraz" }), "PREPARATION_INCOMPLETE");
    // the entry has media, so it cannot be removed; withdrawing it is the way out
    await expectCode(repo.removeRoundEntry({ ...r.ctx, entryId: approvedNotConfirmed.entry.entryId }), "ENTRY_HAS_MEDIA");
    await withdraw({ ...r.ctx, entryId: approvedNotConfirmed.entry.entryId, reason: "Sin confirmar" });
    r.started = await repo.startRound({ ...r.ctx, promptText: "Mejor disfraz" });

    const gallery = await repo.readRoundGallery(r.ctx.instanceId);
    expect(gallery).toHaveLength(2);
    const alias = gallery[0].alias.slice(1);
    const photo = await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias, variant: "thumb" });
    expect(photo?.contentType).toBe("image/jpeg");
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: "0000", variant: "thumb" })).toBeNull();
    const info = await repo.readRoundPublicInfo(r.ctx.instanceId);
    expect(info).toMatchObject({ roundRole: "PRELIMINARY", locationRequired: false, interactionState: "PROMPT_ACTIVE", approvedContestants: 2 });
    expect(typeof info?.deadlineAt).toBe("string"); // the preliminary's deadline is the configured closing
  });

});

// =====================================================================================================================
// Table guards: the pilot's invariants hold for every writer
// =====================================================================================================================

describe("table guards", () => {
  it("entries of a round change only through the operations", async () => {
    const r = await newRound("PRELIMINARY");
    await expectDbError(
      "insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at) values ($1, 1, '#1234', 60, now() + interval '1 minute')",
      [r.ctx.instanceId],
      "COMMUNITY_VOTING_ROUND_PATH_REQUIRED"
    );
  });

  it("a final's entry without a source, and a preliminary's entry with one, are refused by the database", async () => {
    const p = await newRound("PRELIMINARY");
    await contestants(p, 2);
    await openRound(p);
    await repo.closeRound(p.ctx);
    await cut(p);
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    const unopened = await newRound("PRELIMINARY");
    const [src] = await q<{ entry_id: string }>("select entry_id from community_voting_entries where instance_id = $1 limit 1", [p.ctx.instanceId]);
    const c = await rawClient();
    try {
      await c.query("select set_config('urbano.community_voting_round_op', $1, false)", [f.ctx.instanceId]);
      await expect(
        c.query("insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at) values ($1, 1, '#9999', 1, now())", [f.ctx.instanceId])
      ).rejects.toThrow("COMMUNITY_VOTING_FINAL_ENTRY_SOURCE");
      // a source that belongs to some other event than the final's own preliminary is refused as well
      const other = await newRound("PRELIMINARY");
      await contestants(other, 1);
      const [foreign] = await q<{ entry_id: string }>("select entry_id from community_voting_entries where instance_id = $1 limit 1", [other.ctx.instanceId]);
      await expect(
        c.query("insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at, source_entry_id) values ($1, 2, '#9998', 1, now(), $2)", [f.ctx.instanceId, foreign.entry_id])
      ).rejects.toThrow("COMMUNITY_VOTING_FINAL_ENTRY_SOURCE");
      await c.query("select set_config('urbano.community_voting_round_op', $1, false)", [unopened.ctx.instanceId]);
      await expect(
        c.query("insert into community_voting_entries (instance_id, ordinal, label, claim_window_seconds, claim_expires_at, source_entry_id) values ($1, 77, '#7777', 1, now(), $2)", [unopened.ctx.instanceId, src.entry_id])
      ).rejects.toThrow("COMMUNITY_VOTING_FINAL_ENTRY_SOURCE");
    } finally {
      await c.end();
    }
  });

  it("each cast belongs to its own mode: the pilot's cast refuses a SINGLE_CHOICE Instance, and GATE-003's cast cannot write a round's votes", async () => {
    // the pilot's cast on a GATE-003 Instance
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const single = await repo.registerInstance({ sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 });
    const person = await newPerson();
    const binding = await repo.bindVoter({ instanceId: single.instanceId, authUserId: person.authUserId });
    await expectCode(
      repo.castRoundVote({ instanceId: single.instanceId, authUserId: person.authUserId, bindingId: binding.bindingId, intentNo: 1, interactionInstanceId: randomUUID(), candidateId: randomUUID(), location: INSIDE }),
      "NOT_A_ROUND"
    );
    // GATE-003's cast on a round: the votes guard refuses the write, so nothing is stored
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const [ca] = await candidates(r);
    const voter = await newPerson();
    const rb = await bind(r, voter);
    const intent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId });
    await expect(
      repo.castVote({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId, bindingId: rb.bindingId, intentNo: intent.intentNo, interactionInstanceId: r.started!.interactionInstanceId, candidateId: ca.candidateId, location: INSIDE })
    ).rejects.toThrow();
    expect(await votesIn(r)).toBe(0);
  });

  it("the new tables are service_role only and the new functions are not callable by browser roles", async () => {
    const tables = ["community_voting_finalist_selections", "community_voting_finalists", "community_voting_round_reviews", "community_voting_publications", "community_voting_promo_consents"];
    const rls = await q<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname = any($1)", [tables]);
    expect(rls).toHaveLength(tables.length);
    expect(rls.every((x) => x.relrowsecurity)).toBe(true);
    const grants = await q("select table_name, grantee, privilege_type from information_schema.role_table_grants where table_name = any($1) and grantee in ('anon', 'authenticated', 'public')", [tables]);
    expect(grants).toEqual([]);
    const fns = [
      "register_community_voting_round_atomically", "cast_community_voting_round_vote_atomically", "start_community_voting_round_atomically",
      "close_community_voting_round_atomically", "select_community_voting_finalists_atomically", "prepare_community_voting_final_atomically",
      "withdraw_community_voting_round_candidature_atomically", "record_community_voting_round_review_atomically", "publish_community_voting_round_atomically",
      "read_community_voting_round_results", "read_community_voting_round_public_info", "read_community_voting_round_gallery",
      "read_community_voting_round_photo", "read_community_voting_round_voter_status", "community_voting_email_confirmed",
    ];
    for (const fn of fns) {
      const rows = await q<{ anon: boolean; authenticated: boolean; pub: boolean }>(
        "select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authenticated, has_function_privilege('public', p.oid, 'execute') pub from pg_proc p where p.proname = $1",
        [fn]
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect({ fn, ...row }).toEqual({ fn, anon: false, authenticated: false, pub: false });
    }
  });

  it("a CommunityVotingError carries the pilot's typed codes", async () => {
    expect(new CommunityVotingError("PROFILE_INCOMPLETE").code).toBe("PROFILE_INCOMPLETE");
  });
});
