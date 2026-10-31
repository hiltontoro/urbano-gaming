import { createSession } from "../../lib/session/createSession";
import { setSessionCapabilities } from "../../lib/session/setSessionCapabilities";
import { lockLobby } from "../../lib/session/lockLobby";
import { GALLERY_CONSENT_SHA256, GALLERY_CONSENT_VERSION } from "../../lib/gaming/communityVoting/rounds/constants";
import type { OperatorContext } from "../../lib/gaming/communityVoting/rounds/types";
import { inMs, newPerson, photoArgs, pool, q, repo, sessionRepo, sha256 } from "./roundsFixtures";
import type { Person } from "./roundsFixtures";

/**
 * Shared fixtures of the four-category contest's contract suites (UG-IV-GATE-018). Everything runs against the isolated LOOPBACK stack the caller
 * exported (roundsFixtures applies the local-only guard as soon as it loads); every identity, photograph and time is synthetic. The new operations
 * are called through SQL on purpose: these suites test the database's rules and must not depend on the TypeScript layer that wraps them.
 */

export const CATEGORY_KEYS = ["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export const INDIVIDUAL_KEYS = ["MOST_ELABORATE", "SEXIEST", "FUNNIEST"] as const;

export const consent = { consentVersion: GALLERY_CONSENT_VERSION, statementSha256: GALLERY_CONSENT_SHA256, ageConfirmed: true };
const HOUR = 3_600_000;

export interface CatRound {
  key: CategoryKey;
  contestId: string;
  instanceId: string;
  session: Awaited<ReturnType<typeof createSession>>;
  operator: Person;
  ctx: OperatorContext;
  interactionInstanceId: string | null;
}

export async function registerCategory(
  operator: Person,
  key: CategoryKey,
  contestId: string | null,
  closesAt: string | null = inMs(4 * HOUR),
  cutoffAt: string | null = null,
  registrationOpensAt: string | null = null
): Promise<CatRound> {
  const session = await createSession(sessionRepo);
  await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
  const [row] = await q<{ instance_id: string; contest_id: string }>(
    "select * from register_community_voting_category_round_atomically($1, $2, $3, 1, $4, $5)",
    [session.sessionId, session.hostToken, operator.gamingMemberId, contestId, key]
  );
  const ctx: OperatorContext = { instanceId: row.instance_id, hostToken: session.hostToken, operatorMemberId: operator.gamingMemberId as string };
  if (closesAt !== null || cutoffAt !== null || registrationOpensAt !== null) {
    await repo.setRoundSchedule({
      ...ctx,
      schedule: { registrationOpensAt, contestantCutoffAt: cutoffAt, votingOpensAt: null, votingClosesAt: closesAt, status: "TENTATIVE" },
    });
  }
  return { key, contestId: row.contest_id, instanceId: row.instance_id, session, operator, ctx, interactionInstanceId: null };
}

/** The whole contest: four category rounds of one operator, each with its own Session. */
export async function newContest(opts: { operator?: Person; closesAt?: string | null; cutoffAt?: string | null; registrationOpensAt?: string | null } = {}) {
  const operator = opts.operator ?? (await newPerson());
  const first = await registerCategory(operator, CATEGORY_KEYS[0], null, opts.closesAt, opts.cutoffAt ?? null, opts.registrationOpensAt ?? null);
  const rounds: Record<CategoryKey, CatRound> = { [CATEGORY_KEYS[0]]: first } as Record<CategoryKey, CatRound>;
  for (const key of CATEGORY_KEYS.slice(1)) rounds[key] = await registerCategory(operator, key, first.contestId, opts.closesAt, opts.cutoffAt ?? null, opts.registrationOpensAt ?? null);
  return { contestId: first.contestId, operator, rounds };
}

/** A contest whose registration is OPEN right now (opened an hour ago, ends in two hours; voting closes in four): the window a person registers in. */
export const registrationWindow = () => ({ registrationOpensAt: inMs(-HOUR), cutoffAt: inMs(2 * HOUR), closesAt: inMs(4 * HOUR) });
export async function openRegistrationContest(operator?: Person) {
  return newContest({ operator, ...registrationWindow() });
}
export type Contest = Awaited<ReturnType<typeof newContest>>;

let seed = 5000;
/** A photograph, the representative's (or contestant's) consent for it, and the operator's approval. */
export async function approvedPhoto(r: CatRound, entryId: string) {
  const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId, ...photoArgs(seed++) });
  await repo.recordEntryConsent({ ...r.ctx, entryId, photoId: photo.photoId, ...consent });
  await repo.decideEntryPhoto({ ...r.ctx, entryId, photoId: photo.photoId, decision: "APPROVED" });
  return photo;
}

/** Claim and confirm: the canonical association of a verified, profiled person with an entry — the pilot's own act. */
export async function associate(r: CatRound, entryId: string, claimCode: string, person?: Person) {
  const p = person ?? (await newPerson());
  await repo.bindVoter({ instanceId: r.instanceId, authUserId: p.authUserId });
  const claimed = await repo.claimRoundEntry({ instanceId: r.instanceId, authUserId: p.authUserId, claimCode });
  await repo.confirmRoundAssociation({ ...r.ctx, entryId, confirmationCode: claimed.confirmationCode });
  return p;
}

/** A complete individual candidacy (one of the three individual categories). */
export async function individual(r: CatRound, person?: Person) {
  const entry = await repo.createRoundEntry(r.ctx);
  const photo = await approvedPhoto(r, entry.entryId);
  const who = await associate(r, entry.entryId, entry.claimCode, person);
  return { entry, photo, person: who };
}
export async function individuals(r: CatRound, n: number) {
  const out: Awaited<ReturnType<typeof individual>>[] = [];
  for (let i = 0; i < n; i++) out.push(await individual(r));
  return out;
}

export async function createGroup(r: CatRound) {
  const [row] = await q<{ entry_id: string; label: string; claim_code: string }>(
    "select * from create_community_voting_group_entry_atomically($1, $2, $3, 900)",
    [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId]
  );
  return { entryId: row.entry_id, label: row.label, claimCode: row.claim_code };
}
export async function createMember(r: CatRound, groupEntryId: string) {
  const [row] = await q<{ entry_id: string; label: string; claim_code: string }>(
    "select * from create_community_voting_group_member_atomically($1, $2, $3, $4, 900)",
    [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, groupEntryId]
  );
  return { entryId: row.entry_id, label: row.label, claimCode: row.claim_code };
}
export async function memberConsent(r: CatRound, memberEntryId: string, photoId: string) {
  return q("select * from record_community_voting_member_consent_atomically($1, $2, $3, $4, $5, $6, $7, true)", [
    r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, memberEntryId, photoId, consent.consentVersion, consent.statementSha256,
  ]);
}

/** A complete group candidacy: one photograph, the representative, and `members` attributed members — every one associated and consenting. */
export async function group(r: CatRound, members = 2) {
  const g = await createGroup(r);
  const photo = await approvedPhoto(r, g.entryId);
  const representative = await associate(r, g.entryId, g.claimCode);
  const people: Person[] = [];
  const memberEntries: { entryId: string }[] = [];
  for (let i = 0; i < members; i++) {
    const m = await createMember(r, g.entryId);
    people.push(await associate(r, m.entryId, m.claimCode));
    await memberConsent(r, m.entryId, photo.photoId);
    memberEntries.push(m);
  }
  return { group: g, photo, representative, people, memberEntries };
}

/** Locks the lobby once: a second call (the opening locks too) is a no-op, as a test that locked early then opened needs. */
export async function lock(r: CatRound) {
  const [row] = await q<{ state: string }>("select state from sessions where session_id = $1", [r.session.sessionId]);
  if (row.state === "LOBBY_OPEN") await lockLobby(sessionRepo, r.session.sessionId, r.session.hostToken);
}
export async function openCategory(r: CatRound, prompt = "Mejor disfraz") {
  await lock(r);
  const [row] = await q<{ interaction_instance_id: string; candidate_count: number; deadline_at: string }>(
    "select * from start_community_voting_category_atomically($1, $2, $3, $4)",
    [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, prompt]
  );
  r.interactionInstanceId = row.interaction_instance_id;
  return row;
}
export async function candidatesOf(r: CatRound) {
  const rows = await q<{ label: string; candidate_id: string; entry_id: string; entry_kind: string }>(
    "select label, candidate_id, entry_id, entry_kind from community_voting_entries where instance_id = $1 and candidate_id is not null order by ordinal",
    [r.instanceId]
  );
  return rows.map((x) => ({ label: x.label, candidateId: x.candidate_id, entryId: x.entry_id, kind: x.entry_kind }));
}

export async function castVote(r: CatRound, person: Person, candidateId: string, intentNo?: number) {
  const binding = await repo.bindVoter({ instanceId: r.instanceId, authUserId: person.authUserId });
  const intent = intentNo === undefined ? (await repo.issueIntent({ instanceId: r.instanceId, authUserId: person.authUserId })).intentNo : intentNo;
  const [row] = await q<{ outcome: string; candidate_id: string; intent_no: number }>(
    "select * from cast_community_voting_category_vote_atomically($1, $2, $3, $4, $5, $6)",
    [r.instanceId, person.authUserId, binding.bindingId, intent, r.interactionInstanceId, candidateId]
  );
  return { binding, intentNo: intent, outcome: row.outcome };
}
export async function castMany(r: CatRound, candidateId: string, n: number) {
  for (let i = 0; i < n; i++) await castVote(r, await newPerson(), candidateId);
}
export const votesIn = async (r: CatRound) =>
  Number((await q<{ n: string }>("select count(*) n from votes where interaction_instance_id = $1", [r.interactionInstanceId]))[0].n);

export async function closeCategory(r: CatRound) {
  return repo.closeRound(r.ctx);
}
export async function reviewCategory(r: CatRound, note: string | null = null) {
  const [row] = await q<{ review_id: string; results_digest: string }>("select * from record_community_voting_category_review_atomically($1, $2, $3, $4)", [
    r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, note,
  ]);
  return row;
}
export async function publishCategory(r: CatRound) {
  const [row] = await q<{ published_at: string; winner_count: number }>("select * from publish_community_voting_category_atomically($1, $2, $3)", [
    r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId,
  ]);
  return row;
}
export async function categoryResults(r: CatRound) {
  return q<{ label: string; votes: string; competition_rank: number | null; winner: boolean; withdrawn: boolean; entry_id: string }>(
    "select * from read_community_voting_category_results($1, $2, $3)",
    [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId]
  );
}
export async function publicWinners(r: CatRound) {
  return q<{ alias: string; kind: string }>("select * from read_community_voting_round_public_results($1)", [r.instanceId]);
}

/** An opened and closed category with a given vote plan (votes per candidacy, by ordinal). */
export async function closedCategory(r: CatRound, plan: number[]) {
  await individuals(r, plan.length);
  await openCategory(r);
  const cands = await candidatesOf(r);
  for (let i = 0; i < plan.length; i++) await castMany(r, cands[i].candidateId, plan[i]);
  await closeCategory(r);
  return cands;
}

// ---------------------------------------------------------------- self-registration (the addendum to GATE-018)

export const REQUIREMENTS = { version: "test-requirements-1", sha256: sha256("test requirements text") };
export const DELIVERY = { version: "test-delivery-1", sha256: sha256("test delivery text") };
/** A fresh synthetic WhatsApp number (E.164, Honduras prefix). Distinct per call so a scan for it can only find where it was put. */
export const syntheticWhatsapp = () => `+50499${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

export interface RegisterArgs {
  name: string;
  adult: boolean;
  requirementsVersion: string;
  requirementsSha256: string;
  whatsapp: string;
  whatsappConfirmed: boolean;
  deliveryVersion: string;
  deliverySha256: string;
  deliveryAuthorized: boolean;
}
export const registerArgs = (over: Partial<RegisterArgs> = {}): RegisterArgs => ({
  name: "Drácula de Tegucigalpa",
  adult: true,
  requirementsVersion: REQUIREMENTS.version,
  requirementsSha256: REQUIREMENTS.sha256,
  whatsapp: syntheticWhatsapp(),
  whatsappConfirmed: true,
  deliveryVersion: DELIVERY.version,
  deliverySha256: DELIVERY.sha256,
  deliveryAuthorized: true,
  ...over,
});
const REGISTER_SQL = "select * from register_community_voting_candidacy_atomically($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)";
const registerParams = (instanceId: string, authUserId: string, a: RegisterArgs) => [
  instanceId, authUserId, a.name, a.adult, a.requirementsVersion, a.requirementsSha256, a.whatsapp, a.whatsappConfirmed, a.deliveryVersion, a.deliverySha256, a.deliveryAuthorized,
];

/** The person binds to the category's Instance (a verified, profiled identity) and registers THEMSELVES. */
export async function selfRegister(r: CatRound, person: Person, over: Partial<RegisterArgs> = {}) {
  await repo.bindVoter({ instanceId: r.instanceId, authUserId: person.authUserId });
  const args = registerArgs(over);
  const [row] = await q<{ entry_id: string; category_key: string; public_code: string; public_name: string; entry_kind: string }>(REGISTER_SQL, registerParams(r.instanceId, person.authUserId, args));
  return { ...row, entryId: row.entry_id, publicCode: row.public_code, whatsapp: args.whatsapp, args };
}
/** The raw call, for the refusals (the caller binds first, or not, as the case requires). */
export const registerRaw = (instanceId: string, authUserId: string, over: Partial<RegisterArgs> = {}) =>
  pool.query(REGISTER_SQL, registerParams(instanceId, authUserId, registerArgs(over)));

/** What the operator does at the station for a self-registered candidacy: the photograph, the person's consent to it, the approval, the confirmation. */
export async function completeAtStation(r: CatRound, entryId: string) {
  const photo = await approvedPhoto(r, entryId);
  await q("select * from confirm_community_voting_registration_atomically($1, $2, $3, $4)", [r.instanceId, r.ctx.hostToken, r.ctx.operatorMemberId, entryId]);
  return photo;
}

export async function contestCounts(instanceId: string) {
  const [row] = await q<Record<string, number>>(
    `select (select count(*) from community_voting_entries where instance_id = $1)::int entries,
            (select count(*) from community_voting_candidacies where instance_id = $1)::int candidacies,
            (select count(*) from community_voting_registrations where instance_id = $1)::int registrations,
            (select count(*) from community_voting_contest_identities where instance_id = $1)::int identities`,
    [instanceId]
  );
  return row;
}
