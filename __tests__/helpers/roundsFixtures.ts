import { createHash, randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { expect } from "vitest";

import { SupabaseSessionRepository } from "../../lib/session/db/supabaseSessionRepository";
import { createSession } from "../../lib/session/createSession";
import { setSessionCapabilities } from "../../lib/session/setSessionCapabilities";
import { lockLobby } from "../../lib/session/lockLobby";
import { GALLERY_CONSENT_SHA256, GALLERY_CONSENT_VERSION } from "../../lib/gaming/communityVoting/rounds/constants";
import { SupabaseRoundsRepository } from "../../lib/gaming/communityVoting/rounds/supabaseRoundsRepository";
import type { OperatorContext, PolicyKey, RoundRole } from "../../lib/gaming/communityVoting/rounds/types";
import { requireLocalSupabase } from "./requireLocalSupabase";

/**
 * Shared fixtures of the two-round pilot's contract suites. Everything runs against the isolated LOOPBACK stack the caller exported
 * (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMMUNITY_VOTING_LOCAL_DB_URL); every identity, photograph, coordinate and time is synthetic.
 * Community Voting rows are intentionally undeletable, so nothing here cleans up — discarding the throwaway database is the reset.
 */

export const supabaseUrl = process.env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
export const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const dbUrl = process.env.COMMUNITY_VOTING_LOCAL_DB_URL ?? "";
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(dbUrl)) {
  throw new Error("COMMUNITY_VOTING_LOCAL_DB_URL must be set to a loopback Postgres URL.");
}

export const sessionRepo = new SupabaseSessionRepository(supabaseUrl as string, serviceKey);
export const repo = new SupabaseRoundsRepository(supabaseUrl as string, serviceKey);
export const pool = new Pool({ connectionString: dbUrl, max: 10 });

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}
export async function rawClient(): Promise<Client> {
  const c = new Client({ connectionString: dbUrl, statement_timeout: 60000 });
  await c.connect();
  return c;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CommunityVotingError", code });
}
/** A refusal by a TABLE GUARD (a trigger) surfaces through the repository as a generic error; the test asserts the raw message at the database. */
export async function expectDbError(sql: string, params: unknown[], text: string) {
  await expect(pool.query(sql, params)).rejects.toThrow(text);
}

// ---------------------------------------------------------------- identities

export type EmailState = "confirmed" | "unconfirmed" | "none";
export async function newPerson(opts: { email?: EmailState; member?: boolean } = {}): Promise<{ authUserId: string; gamingMemberId: string | null }> {
  const id = randomUUID();
  const email = opts.email ?? "confirmed";
  await q(
    "insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values ($1, 'authenticated', 'authenticated', $2, $3, now(), now())",
    [id, email === "none" ? null : `pilot-contract-${id}@example.invalid`, email === "confirmed" ? new Date().toISOString() : null]
  );
  let gamingMemberId: string | null = null;
  if (opts.member !== false) {
    const [row] = await q<{ gaming_member_id: string }>("insert into gaming_members (auth_user_id, display_name) values ($1, 'Synthetic') returning gaming_member_id", [id]);
    gamingMemberId = row.gaming_member_id;
  }
  return { authUserId: id, gamingMemberId };
}
export type Person = Awaited<ReturnType<typeof newPerson>>;

// ---------------------------------------------------------------- photographs

export function jpeg(seed: number, extra = 0): Buffer {
  const body = Buffer.alloc(64 + extra, seed % 251);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 3)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sof, sos, body, Buffer.from([0xff, 0x00, 0xff, 0xd9])]);
}
export const photoArgs = (seed: number) => ({ fullBase64: jpeg(seed, 2000).toString("base64"), thumbBase64: jpeg(seed + 1000, 200).toString("base64"), width: 640, height: 480 });

// ---------------------------------------------------------------- the venue

export const VENUE = { venueLatitude: 15.5, venueLongitude: -88.0, venueRadiusMeters: 100, maxAccuracyMeters: 50, insideMarginFactor: 1, outsideMarginFactor: 1 };
export const INSIDE = { latitude: 15.5, longitude: -88.0, accuracyMeters: 10 };
export const OUTSIDE = { latitude: 15.6, longitude: -88.0, accuracyMeters: 10 };
export type Reading = { latitude: number; longitude: number; accuracyMeters: number };

// ---------------------------------------------------------------- rounds

const HOUR = 3_600_000;
export const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * A registered round. A PRELIMINARY needs a configured deadline before it can open, so by default it gets one four hours out (a test that
 * is about the schedule passes its own). The schedule is configuration: it opens and closes nothing by itself.
 */
export async function newRound(role: RoundRole, opts: { source?: Round; operator?: Person; windowSeconds?: number; closesAt?: string | null } = {}) {
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
    windowSeconds: role === "FINAL" ? (opts.windowSeconds ?? 300) : null,
  });
  const ctx: OperatorContext = { instanceId: instance.instanceId, hostToken: session.hostToken, operatorMemberId: operator.gamingMemberId as string };
  const round = { role, session, operator, instance, ctx, started: null as null | Awaited<ReturnType<typeof repo.startRound>> };
  if (role === "PRELIMINARY" && opts.closesAt !== null) {
    await repo.setRoundSchedule({
      ...ctx,
      schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: opts.closesAt ?? inMs(4 * HOUR), status: "TENTATIVE" },
    });
  }
  return round;
}
export type Round = Awaited<ReturnType<typeof newRound>>;

let seedCounter = 1;
export async function approvedEntry(r: Round) {
  const entry = await repo.createRoundEntry(r.ctx);
  const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(seedCounter++) });
  await repo.recordEntryConsent({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256, ageConfirmed: true });
  await repo.decideEntryPhoto({ ...r.ctx, entryId: entry.entryId, photoId: photo.photoId, decision: "APPROVED" });
  return { entry, photo };
}
/** A complete contestant: approved photo, gallery consent AND a confirmed association with a verified Gaming Member. */
export async function contestant(r: Round) {
  const { entry, photo } = await approvedEntry(r);
  const person = await newPerson();
  await repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: person.authUserId });
  const claimed = await repo.claimRoundEntry({ instanceId: r.ctx.instanceId, authUserId: person.authUserId, claimCode: entry.claimCode });
  await repo.confirmRoundAssociation({ ...r.ctx, entryId: entry.entryId, confirmationCode: claimed.confirmationCode });
  return { entry, photo, person };
}
export async function contestants(r: Round, n: number) {
  const out: Awaited<ReturnType<typeof contestant>>[] = [];
  for (let i = 0; i < n; i++) out.push(await contestant(r));
  return out;
}
export async function lockRound(r: Round) {
  await lockLobby(sessionRepo, r.session.sessionId, r.session.hostToken);
}
export async function openRound(r: Round) {
  await lockRound(r);
  r.started = await repo.startRound({ ...r.ctx, promptText: "Mejor disfraz" });
  return r.started;
}
export async function candidates(r: Round) {
  const rows = await q<{ label: string; candidate_id: string; entry_id: string }>(
    "select label, candidate_id, entry_id from community_voting_entries where instance_id = $1 and candidate_id is not null order by ordinal",
    [r.ctx.instanceId]
  );
  return rows.map((x) => ({ label: x.label, candidateId: x.candidate_id, entryId: x.entry_id }));
}
export async function bind(r: Round, p: Person) {
  return repo.bindVoter({ instanceId: r.ctx.instanceId, authUserId: p.authUserId });
}
export function castInput(r: Round, p: Person, binding: { bindingId: string }, intentNo: number, candidateId: string, location: Reading | null) {
  return {
    instanceId: r.ctx.instanceId,
    authUserId: p.authUserId,
    bindingId: binding.bindingId,
    intentNo,
    interactionInstanceId: (r.started as NonNullable<Round["started"]>).interactionInstanceId,
    candidateId,
    location,
  };
}
export async function voteAs(r: Round, p: Person, candidateId: string, location: Reading | null = null) {
  const binding = await bind(r, p);
  const intent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: p.authUserId });
  const cast = await repo.castRoundVote(castInput(r, p, binding, intent.intentNo, candidateId, location));
  return { binding, intent, cast };
}
export async function castMany(r: Round, candidateId: string, n: number, location: Reading | null = null) {
  for (let i = 0; i < n; i++) await voteAs(r, await newPerson(), candidateId, location);
}
export const votesIn = async (r: Round) =>
  Number((await q<{ n: string }>("select count(*) n from votes where interaction_instance_id = $1", [(r.started as NonNullable<Round["started"]>).interactionInstanceId]))[0].n);

/** Records the Product approval of ONE policy, the way the operator does (with the reference of the decision). */
export async function approve(r: Round, key: PolicyKey, value: string) {
  return repo.recordPolicyApproval({ ...r.ctx, policyKey: key, policyValue: value, approvalReference: "DECISION-TEST-0001" });
}
export const POLICY_VALUES: Record<PolicyKey, string> = {
  ZERO_VALID_VOTES_PRELIMINARY: "ALL_ENTRIES_ADVANCE",
  ZERO_VOTE_ENTRIES_AT_CUTOFF: "TIED_ZERO_VOTE_ENTRIES_ADVANCE",
  FINALIST_WITHDRAWAL_AFTER_SELECTION: "EXCLUDE_WITHOUT_REFILL",
};

/** A closed preliminary with `plan` votes per contestant, ready for the cut. */
export async function closedPreliminary(plan: number[], opts: { operator?: Person } = {}) {
  const p = await newRound("PRELIMINARY", { operator: opts.operator ?? (await newPerson()) });
  const people = await contestants(p, plan.length);
  await openRound(p);
  const cands = await candidates(p);
  for (let i = 0; i < plan.length; i++) await castMany(p, cands[i].candidateId, plan[i]);
  await repo.closeRound(p.ctx);
  return { p, people, cands };
}
