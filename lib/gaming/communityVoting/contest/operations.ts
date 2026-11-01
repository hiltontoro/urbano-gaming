import { CommunityVotingError, isUuidLike } from "../types";
import { GALLERY_CONSENT_SHA256, GALLERY_CONSENT_TEXT, GALLERY_CONSENT_VERSION } from "../rounds/constants";
import { resolveRoundVoter } from "../rounds/identity";
import { parseOperatorAllowlist } from "../rounds/operatorAuth";
import { deadlineRemainingMs, deriveRoundPhase } from "../rounds/phase";
import type { OperatorContext } from "../rounds/types";
import type { RoundVoterDeps } from "../rounds/voterOperations";
import { CATEGORIES, CATEGORY_KEYS, EVENT_TIME_ZONE, PRIZE_PROMISE, isCategoryKey } from "./categories";
import type { CategoryKey } from "./categories";
import {
  DELIVERY_SHA256,
  DELIVERY_TEXT,
  DELIVERY_VERSION,
  REQUIREMENTS_SHA256,
  REQUIREMENTS_TEXT,
  REQUIREMENTS_VERSION,
  deliveryMessage,
  normalizePublicCode,
  normalizePublicName,
  normalizeWhatsapp,
  whatsappLink,
} from "./registration";
import type { SupabaseContestRepository } from "./supabaseContestRepository";
import type { CategoryRoundRecord } from "./types";

/**
 * Operations of the four-category contest (UG-IV-GATE-018). Thin by design, like the pilot's: each validates the SHAPE of a request,
 * supplies the server-owned constants and hands ONE atomic operation to the repository. The database is the authority for every rule
 * (host token, designated operator, one candidacy per person, the consents of everybody in a photograph, the freeze at opening).
 */

const invalid = (message: string) => new CommunityVotingError("INVALID_REQUEST", message);

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A JSON object body is required.");
  return body as Record<string, unknown>;
}
function requireUuid(value: unknown, what: string): string {
  if (!isUuidLike(value)) throw invalid(`${what} must be an id.`);
  return value;
}
function claimTtl(b: Record<string, unknown>): number | undefined {
  if (b.claimTtlSeconds === undefined) return undefined;
  if (typeof b.claimTtlSeconds !== "number" || !Number.isInteger(b.claimTtlSeconds) || b.claimTtlSeconds < 1 || b.claimTtlSeconds > 86400) {
    throw invalid("The claim window must be between 1 and 86400 seconds.");
  }
  return b.claimTtlSeconds;
}

// ---------------------------------------------------------------- registration

/**
 * Registers ONE category round for a Session, designating the CALLER as its operator, and — with the first one — creating the contest.
 * Only a Gaming Member on the configured allow-list may; with no valid allow-list nobody can (fail closed). The body is
 * { sessionId, categoryKey, contestId?, purpose? }: purpose is immutable LIVE/REHEARSAL grouping, not a Session lifecycle or a venue bypass.
 */
export async function registerCommunityVotingCategoryRound(
  repo: SupabaseContestRepository,
  input: { body: unknown; hostToken: string; operatorMemberId: string; allowlistRaw: string | undefined }
): Promise<CategoryRoundRecord> {
  const allowlist = parseOperatorAllowlist(input.allowlistRaw);
  if (!allowlist) throw new CommunityVotingError("OPERATOR_NOT_CONFIGURED", "The activation operator is not configured.");
  if (!allowlist.has(input.operatorMemberId.toLowerCase())) {
    throw new CommunityVotingError("OPERATOR_REQUIRED", "Only the designated operator may do this.");
  }

  const b = asObject(input.body);
  const sessionId = requireUuid(b.sessionId, "sessionId");
  if (!isCategoryKey(b.categoryKey)) throw invalid(`categoryKey must be one of ${CATEGORY_KEYS.join(", ")}.`);
  const contestId = b.contestId === undefined || b.contestId === null ? null : requireUuid(b.contestId, "contestId");
  const purpose = b.purpose === undefined ? "LIVE" : b.purpose;
  if (purpose !== "LIVE" && purpose !== "REHEARSAL") throw invalid("Unknown contest purpose.");
  const ruleVersion = b.ruleVersion === undefined ? 1 : b.ruleVersion;
  if (typeof ruleVersion !== "number" || !Number.isInteger(ruleVersion) || ruleVersion < 1) throw invalid("ruleVersion must be a positive integer.");
  for (const forbidden of ["roundRole", "sourceInstanceId", "venue", "testMode", "windowSeconds"]) {
    if (b[forbidden] !== undefined) throw invalid(`${forbidden} does not exist in the contest.`);
  }
  return repo.registerCategoryRound({
    sessionId,
    hostToken: input.hostToken,
    operatorMemberId: input.operatorMemberId,
    ruleVersion,
    contestId,
    categoryKey: b.categoryKey,
    purpose,
  });
}

// ---------------------------------------------------------------- group candidacies

/** A group candidacy (the group category only; the database refuses it anywhere else) — the representative is the entry's own association. */
export function createGroupEntry(repo: SupabaseContestRepository, ctx: OperatorContext, body: unknown) {
  const b = body === undefined || body === null ? {} : asObject(body);
  return repo.createGroupEntry({ ...ctx, claimTtlSeconds: claimTtl(b) });
}

/** One attributed member of a group: a claim credential to hand to THAT person, who claims it signed in with their own verified identity. */
export function createGroupMember(repo: SupabaseContestRepository, ctx: OperatorContext, groupEntryId: unknown, body: unknown) {
  const b = body === undefined || body === null ? {} : asObject(body);
  if (!isUuidLike(groupEntryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  return repo.createGroupMember({ ...ctx, groupEntryId, claimTtlSeconds: claimTtl(b) });
}

/**
 * The consent of ONE person in a group photograph, to the group's CURRENT photograph. The statement and its digest are the SERVER's (the same
 * gallery-and-contest statement every contestant accepts): a request cannot choose a different text, and a stale page is refused.
 */
export function recordMemberConsent(repo: SupabaseContestRepository, ctx: OperatorContext, memberEntryId: unknown, body: unknown) {
  const b = asObject(body);
  if (!isUuidLike(memberEntryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  const photoId = requireUuid(b.photoId, "photoId");
  if (b.consentVersion !== GALLERY_CONSENT_VERSION) throw invalid("The consent text has changed; reload the page.");
  if (b.accepted !== true || b.ageConfirmed !== true) {
    throw new CommunityVotingError("CONSENT_REQUIRED", "The person must confirm being of legal age and accept the statement.");
  }
  return repo.recordMemberConsent({
    ...ctx,
    memberEntryId,
    photoId,
    consentVersion: GALLERY_CONSENT_VERSION,
    statementSha256: GALLERY_CONSENT_SHA256,
    ageConfirmed: true,
  });
}

/**
 * Self-registration of a contestant. The identity is the SERVER's (the verified bearer token: a confirmed email and a complete Gaming profile); the
 * person is bound to the category's Instance here, idempotently, and the database re-checks everything — the window, the identity, the shape of the
 * name and the number, the consents, and the rule of ONE candidacy per person. The statements the person accepted are identified by version AND digest,
 * both SERVER constants: a page that shows an older text is refused, so what is stored is always what was shown.
 *
 * The request names no role, no location and no phone verification: none of them exists in this journey.
 */
export async function registerAsContestant(
  repo: SupabaseContestRepository,
  deps: RoundVoterDeps,
  authorizationHeader: string | null | undefined,
  instanceId: string,
  body: unknown
) {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  if (!isUuidLike(instanceId)) throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  const b = asObject(body);
  for (const forbidden of ["location", "latitude", "longitude", "coordinates", "phoneOtp", "otp", "authUserId", "gamingMemberId", "role", "categoryKey"]) {
    if (b[forbidden] !== undefined) throw invalid(`${forbidden} does not exist in the registration.`);
  }
  if (b.requirementsVersion !== REQUIREMENTS_VERSION || b.deliveryVersion !== DELIVERY_VERSION) throw invalid("The texts have changed; reload the page.");
  const publicName = normalizePublicName(b.publicName);
  if (!publicName) throw invalid("The public name must have 2 to 40 characters.");
  if (b.adultConfirmed !== true || b.requirementsAccepted !== true) {
    throw new CommunityVotingError("CONSENT_REQUIRED", "The person must confirm being of legal age and accept the requirements.");
  }
  const whatsapp = normalizeWhatsapp(b.whatsapp);
  if (!whatsapp) throw invalid("The WhatsApp number needs its country code.");
  if (b.whatsappConfirmed !== true) throw new CommunityVotingError("CONSENT_REQUIRED", "The person must confirm that the WhatsApp number is theirs.");
  if (b.deliveryAuthorized !== true) throw new CommunityVotingError("CONSENT_REQUIRED", "The person must authorize the delivery by WhatsApp.");

  await repo.bindVoter({ instanceId, authUserId });
  const registered = await repo.registerCandidacy({
    instanceId,
    authUserId,
    publicName,
    adultConfirmed: true,
    requirementsVersion: REQUIREMENTS_VERSION,
    requirementsSha256: REQUIREMENTS_SHA256,
    whatsapp,
    whatsappConfirmed: true,
    deliveryVersion: DELIVERY_VERSION,
    deliverySha256: DELIVERY_SHA256,
    deliveryAuthorized: true,
  });
  return { candidacy: { ...registered, state: "REGISTERED" as const, deliveryStatus: "PENDING" as const, ficheUrl: candidacyPageUrl(await contestIdOf(repo, instanceId), registered.publicCode) } };
}

async function contestIdOf(repo: SupabaseContestRepository, instanceId: string): Promise<string> {
  const category = await repo.readCategoryOf(instanceId);
  if (!category) throw new CommunityVotingError("NOT_A_CATEGORY_ROUND", "This operation applies to a category of the contest only.");
  return category.contestId;
}

/** The caller's OWN candidacy in the contest (as a contestant, a representative or an attributed member), or null. Never the number. */
export async function getMyCandidacy(repo: SupabaseContestRepository, deps: RoundVoterDeps, authorizationHeader: string | null | undefined, contestId: string) {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  if (!isUuidLike(contestId)) throw new CommunityVotingError("CONTEST_NOT_FOUND", "No contest exists for this id.");
  const mine = await repo.readMyCandidacy(contestId, authUserId);
  if (!mine) return { candidacy: null };

  let share: { code: string; imageUrl: string } | null = null;
  if (mine.state === "PUBLIC") {
    // The public lookup applies the same approval, consent, visibility and withdrawal boundary as the gallery/photo route.
    // Do not derive a URL from the caller's private record: only offer a download when the public projection still exists.
    const published = await repo.readCandidacyByCode(contestId, mine.publicCode);
    if (published) {
      share = {
        code: published.publicCode,
        imageUrl: photoUrl(published.instanceId, published.alias, "full"),
      };
    }
  }

  return {
    candidacy: {
      ...mine,
      categoryName: CATEGORIES[mine.categoryKey].name,
      ficheUrl: candidacyPageUrl(contestId, mine.publicCode),
      share,
    },
  };
}

const photoUrl = (instanceId: string, alias: string, variant: "thumb" | "full") =>
  `/api/gaming/community-voting/rounds/${instanceId}/photos/${alias.replace(/^#/, "")}?v=${variant}`;

/**
 * A candidacy's ficha, by its public code: public, no session needed. It shows only what the gallery shows (the same permission: confirmed,
 * approved and consented, not hidden, not withdrawn) plus where the category stands in time. It casts nothing and bypasses nothing: to vote a
 * person still signs in and goes through the ordinary, authoritative vote. An unknown code and a code whose candidacy is not public answer alike.
 */
export async function getCandidacyFicha(repo: SupabaseContestRepository, contestId: string, rawCode: unknown) {
  if (!isUuidLike(contestId)) throw new CommunityVotingError("CONTEST_NOT_FOUND", "No contest exists for this id.");
  const code = normalizePublicCode(rawCode);
  if (!code) throw new CommunityVotingError("ENTRY_NOT_FOUND", "No candidacy has this code.");
  const found = await repo.readCandidacyByCode(contestId, code);
  if (!found) throw new CommunityVotingError("ENTRY_NOT_FOUND", "No candidacy has this code.");
  const info = await repo.readRoundPublicInfo(found.instanceId);
  if (!info) throw new CommunityVotingError("STATE_INCONSISTENT");
  const phase = deriveRoundPhase({ sessionState: info.sessionState, interactionState: info.interactionState, closed: info.closed, deadlineAt: info.deadlineAt, serverNow: info.serverNow });
  const def = CATEGORIES[found.categoryKey];
  const alias = found.alias.replace(/^#/, "");
  return {
    contestId,
    candidacy: {
      code: found.publicCode,
      name: found.publicName,
      category: { key: found.categoryKey, name: def.name, kind: def.kind, instanceId: found.instanceId },
      thumbUrl: photoUrl(found.instanceId, alias, "thumb"),
      imageUrl: photoUrl(found.instanceId, alias, "full"),
      ficheUrl: candidacyPageUrl(contestId, found.publicCode),
    },
    voting: {
      phase,
      published: info.published,
      votingOpensAt: info.votingOpensAt,
      votingClosesAt: info.votingClosesAt,
      deadlineAt: info.deadlineAt,
      serverNow: info.serverNow,
      deadlineRemainingMs: deadlineRemainingMs(info),
      tentative: info.scheduleStatus !== "CONFIRMED",
      pageUrl: contestPageUrl(contestId),
    },
    prizePromise: PRIZE_PROMISE,
  };
}

// ---------------------------------------------------------------- the station (the operator)

/** The operator's search by public code. The code only LOCATES a candidacy: the answer never claims an identity, edits or authorizes anything. */
export async function findStationCandidacy(repo: SupabaseContestRepository, ctx: OperatorContext, rawCode: unknown) {
  const code = normalizePublicCode(rawCode);
  if (!code) return { valid: false as const, candidacy: null };
  const candidacy = await repo.findCandidacyByCode({ ...ctx, code });
  return { valid: true as const, candidacy: candidacy ? { ...candidacy, categoryName: CATEGORIES[candidacy.categoryKey].name } : null };
}

/** The operator, having verified the name and the category with the person in front of them, confirms the association of the account that registered. */
export function confirmRegistration(repo: SupabaseContestRepository, ctx: OperatorContext, entryId: unknown) {
  if (!isUuidLike(entryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  return repo.confirmRegistration({ ...ctx, entryId });
}

/** The public name, verified (and, if need be, corrected) with the person at the station. */
export function correctCandidacyName(repo: SupabaseContestRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  if (!isUuidLike(entryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  const publicName = normalizePublicName(asObject(body).publicName);
  if (!publicName) throw invalid("The public name must have 2 to 40 characters.");
  return repo.correctCandidacyName({ ...ctx, entryId, publicName });
}

/**
 * The manual delivery's material, for the designated operator ONLY: the number, the status and the message to send. The act is audited by the
 * database (the entry, never the number). Reading it records nothing about delivery — "delivered" exists only by the operator's explicit act.
 * The message never claims a picture is attached: a WhatsApp link cannot attach one.
 */
export async function getDeliveryMaterial(repo: SupabaseContestRepository, ctx: OperatorContext, entryId: unknown, origin: string) {
  if (!isUuidLike(entryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  const [contact, structure, category] = await Promise.all([
    repo.readRegistrationContact({ ...ctx, entryId }),
    repo.readCategoryStructure(ctx),
    repo.readCategoryOf(ctx.instanceId),
  ]);
  const row = structure.find((r) => r.entryId === entryId);
  if (!row || !row.publicCode || !category) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  const ficheUrl = new URL(candidacyPageUrl(category.contestId, row.publicCode), origin).toString();
  const message = deliveryMessage({ publicName: row.publicName, publicCode: row.publicCode, ficheUrl });
  return {
    whatsapp: contact.whatsapp,
    deliveryStatus: contact.deliveryStatus,
    message,
    whatsappUrl: whatsappLink(contact.whatsapp, message),
    ficheUrl,
    publicCode: row.publicCode,
    publicName: row.publicName,
  };
}

/** "Delivered" — only because the operator said so. Idempotent. */
export function markDelivered(repo: SupabaseContestRepository, ctx: OperatorContext, entryId: unknown) {
  if (!isUuidLike(entryId)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  return repo.markRegistrationDelivered({ ...ctx, entryId });
}

/** The operator's explicit act of showing the contest on Home (or taking it down). Nothing else changes. */
export function setContestListing(repo: SupabaseContestRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  if (typeof b.listed !== "boolean") throw invalid("listed must be true or false.");
  return repo.setContestListing({ ...ctx, listed: b.listed });
}

// ---------------------------------------------------------------- what anyone may see

export type ContestPhase = "NOT_OPEN" | "OPEN" | "CLOSED" | "RESULTS";

/**
 * The public face of the contest: the categories that have a round, each with its phase by the SERVER's clock, its plan (the times the
 * operator keeps up to date) and the deadline that binds. No identity, no count, no rank, no total and no venue: there is none.
 */
export async function getContestPublicInfo(repo: SupabaseContestRepository, contestId: string) {
  if (!isUuidLike(contestId)) throw new CommunityVotingError("CONTEST_NOT_FOUND", "No contest exists for this id.");
  const refs = await repo.readContestCategories(contestId);
  if (refs.length === 0) throw new CommunityVotingError("CONTEST_NOT_FOUND", "No contest exists for this id.");
  const infos = await Promise.all(refs.map((r) => repo.readRoundPublicInfo(r.instanceId)));
  const categories = refs.map((r, i) => {
    const info = infos[i];
    if (!info) throw new CommunityVotingError("STATE_INCONSISTENT");
    const phase = deriveRoundPhase({ sessionState: info.sessionState, interactionState: info.interactionState, closed: info.closed, deadlineAt: info.deadlineAt, serverNow: info.serverNow });
    const def = CATEGORIES[r.categoryKey];
    return {
      key: r.categoryKey,
      instanceId: r.instanceId,
      kind: def.kind,
      name: def.name,
      prompt: def.prompt,
      phase,
      published: info.published,
      deadlineAt: info.deadlineAt,
      deadlineRemainingMs: deadlineRemainingMs(info),
      serverNow: info.serverNow,
      registrationOpensAt: info.registrationOpensAt,
      contestantCutoffAt: info.contestantCutoffAt,
      votingOpensAt: info.votingOpensAt,
      votingClosesAt: info.votingClosesAt,
      tentative: info.scheduleStatus !== "CONFIRMED",
      approvedCandidacies: info.approvedContestants,
    };
  });
  return {
    contestId,
    listed: refs[0].listed,
    timeZone: EVENT_TIME_ZONE,
    serverNow: categories[0].serverNow,
    prizePromise: PRIZE_PROMISE,
    phase: summarizePhase(categories),
    mode: refs[0].purpose ?? "LIVE",
    registration: (() => {
      const r = summarizeRegistration(categories);
      return { ...r, phase: r.phase === "OPEN" && refs[0].registrationOpened !== true ? "NOT_OPEN" as const : r.phase, manualOpened: refs[0].registrationOpened === true };
    })(),
    texts: {
      requirements: { version: REQUIREMENTS_VERSION, text: REQUIREMENTS_TEXT },
      whatsappDelivery: { version: DELIVERY_VERSION, text: DELIVERY_TEXT },
      galleryConsent: { version: GALLERY_CONSENT_VERSION, text: GALLERY_CONSENT_TEXT },
    },
    categories,
  };
}

export type RegistrationPhase = "NOT_SCHEDULED" | "NOT_OPEN" | "OPEN" | "CLOSED";

/**
 * Where REGISTRATION stands, by the server's clock: it opens and closes at the configured times (the earliest opening and the latest cutoff of
 * the categories) and ends for good the moment any category opens its voting. Never a client's clock; never a guess when nothing is configured.
 */
export function summarizeRegistration(
  categories: Array<{ phase: "NOT_OPEN" | "OPEN" | "CLOSED" | "ENDED"; registrationOpensAt: string | null; contestantCutoffAt: string | null; serverNow: string }>
): { phase: RegistrationPhase; opensAt: string | null; closesAt: string | null } {
  const opens = categories.map((c) => c.registrationOpensAt).filter((v): v is string => v !== null).sort();
  const closes = categories.map((c) => c.contestantCutoffAt).filter((v): v is string => v !== null).sort();
  const opensAt = opens[0] ?? null;
  const closesAt = closes[closes.length - 1] ?? null;
  if (opensAt === null || closesAt === null) return { phase: "NOT_SCHEDULED", opensAt, closesAt };
  const now = Date.parse(categories[0].serverNow);
  if (categories.some((c) => c.phase !== "NOT_OPEN") || now >= Date.parse(closesAt)) return { phase: "CLOSED", opensAt, closesAt };
  if (now < Date.parse(opensAt)) return { phase: "NOT_OPEN", opensAt, closesAt };
  return { phase: "OPEN", opensAt, closesAt };
}

/** One word for the whole contest, for Home and the display: RESULTS once every opened category is published, OPEN while any is open. */
export function summarizePhase(categories: Array<{ phase: "NOT_OPEN" | "OPEN" | "CLOSED" | "ENDED"; published: boolean }>): ContestPhase {
  if (categories.some((c) => c.phase === "OPEN")) return "OPEN";
  const closed = categories.filter((c) => c.phase === "CLOSED" || c.phase === "ENDED");
  if (closed.length > 0 && closed.every((c) => c.published) && closed.length === categories.filter((c) => c.phase !== "NOT_OPEN").length) return "RESULTS";
  if (closed.length > 0) return "CLOSED";
  return "NOT_OPEN";
}

/**
 * What Home may say: either nothing (the operator has not chosen to show a contest: Home keeps its truthful informational card, with no
 * link and no invented event) or the contest's id, the page's URL and its phase.
 */
export async function getFeaturedContest(repo: SupabaseContestRepository) {
  const contestId = await repo.readFeaturedContest();
  if (contestId === null) return { featured: null };
  const info = await getContestPublicInfo(repo, contestId);
  if (info.mode !== "LIVE") return { featured: null };
  return {
    featured: {
      contestId,
      url: contestPageUrl(contestId),
      phase: info.phase,
      serverNow: info.serverNow,
      voteUrl: contestPageUrl(contestId),
      registerUrl: contestRegisterUrl(contestId),
      registration: info.registration,
      timeZone: info.timeZone,
      categories: info.categories.map((c) => ({ key: c.key, name: c.name, phase: c.phase, votingOpensAt: c.votingOpensAt, votingClosesAt: c.votingClosesAt })),
      prizePromise: PRIZE_PROMISE,
    },
  };
}

/** The ONE address of the contest's voter page. A relative URL: it belongs to the same site as the page that links it. */
export function contestPageUrl(contestId: string): string {
  return `/community-voting-round.html?c=${encodeURIComponent(contestId)}`;
}

/** The same page, opened on the contestant's registration. Anyone can open it; completing the registration needs the approved canonical account. */
export function contestRegisterUrl(contestId: string): string {
  return `${contestPageUrl(contestId)}&participar=1`;
}

/** A candidacy's ficha: the same page, opened on one candidacy by its public code. Opening it casts nothing and bypasses nothing. */
export function candidacyPageUrl(contestId: string, publicCode: string): string {
  return `${contestPageUrl(contestId)}&codigo=${encodeURIComponent(publicCode)}`;
}

export type { CategoryKey };
