import { randomInt } from "node:crypto";

import type { ClaimedEntry, IssuedIntent } from "../types";
import { CommunityVotingError, isUuidLike } from "../types";
import { validateLocationClaim } from "../eligibility";
import { ORDERING_ALGORITHM, orderCandidatesForVoter } from "./ordering";
import {
  FINAL_PROMPT,
  GALLERY_CONSENT_TEXT,
  GALLERY_CONSENT_VERSION,
  PRELIMINARY_PROMPT,
  PROMO_CONSENT_TEXT,
  PROMO_CONSENT_VERSION,
} from "./constants";
import { resolveRoundVoter, type RoundIdentityDeps } from "./identity";
import { deadlineRemainingMs, deriveRoundPhase } from "./phase";
import type { RoundsRepository } from "./repository";
import type { CastCommunityVoteResult, PhotoBytes, PublicRoundResult, RoundPublicInfo, VoterBindingResult } from "./types";

/**
 * Voter-side and public operations of the two-round pilot. Each takes the identity the Auth boundary derived from the bearer token
 * (never from a request body), validates the shape of what it was given, and hands ONE atomic operation to the repository. The
 * database re-validates everything, including the identity itself.
 */

export interface RoundVoterDeps extends RoundIdentityDeps {
  repo: RoundsRepository;
}

const invalid = (message: string) => new CommunityVotingError("INVALID_REQUEST", message);

function requireInstanceId(value: string): string {
  if (!isUuidLike(value)) throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  return value;
}

async function requireRound(repo: RoundsRepository, instanceId: string): Promise<RoundPublicInfo> {
  const info = await repo.readRoundPublicInfo(requireInstanceId(instanceId));
  if (!info) throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  return info;
}

export const PUBLIC_TEXTS = {
  galleryConsent: { version: GALLERY_CONSENT_VERSION, text: GALLERY_CONSENT_TEXT },
  promoConsent: { version: PROMO_CONSENT_VERSION, text: PROMO_CONSENT_TEXT },
  prompts: { PRELIMINARY: PRELIMINARY_PROMPT, FINAL: FINAL_PROMPT },
} as const;

const photoUrl = (instanceId: string, alias: string, variant: "thumb" | "full") =>
  `/api/gaming/community-voting/rounds/${instanceId}/photos/${alias}?v=${variant}`;

function phaseOf(info: RoundPublicInfo) {
  return deriveRoundPhase({
    sessionState: info.sessionState,
    interactionState: info.interactionState,
    closed: info.closed,
    deadlineAt: info.deadlineAt,
    serverNow: info.serverNow,
  });
}

// ---------------------------------------------------------------- public

/**
 * What anyone may see: the round's phase, its schedule (the plan, and the DEADLINE that binds), whether a location is needed, the server
 * clock and the texts. A round that is scheduled but not yet opened is NOT_OPEN: opening is the operator's explicit act.
 */
export async function getRoundPublicInfo(repo: RoundsRepository, instanceId: string) {
  const info = await requireRound(repo, instanceId);
  return {
    info: {
      roundRole: info.roundRole,
      phase: phaseOf(info),
      locationRequired: info.locationRequired,
      windowSeconds: info.windowSeconds,
      deadlineAt: info.deadlineAt,
      serverNow: info.serverNow,
      deadlineRemainingMs: deadlineRemainingMs(info),
      registrationOpensAt: info.registrationOpensAt,
      contestantCutoffAt: info.contestantCutoffAt,
      votingOpensAt: info.votingOpensAt,
      votingClosesAt: info.votingClosesAt,
      // The opening time is a plan the operator keeps up to date; only the operator's explicit act opens a round. The page says so.
      tentative: info.scheduleStatus !== "CONFIRMED",
      approvedContestants: info.approvedContestants,
      published: info.published,
      // A rehearsal says so on every public page, so it can never be read as the real event.
      isTest: info.isTest,
    },
    texts: PUBLIC_TEXTS,
  };
}

/**
 * The public display: every shown contestant exactly once per response, in a freshly shuffled order, with nothing but the opaque
 * number and where to fetch the picture. It carries no count, rank, total, leader or "trending" signal of any kind.
 */
export async function getRoundSlideshow(repo: RoundsRepository, instanceId: string) {
  const info = await requireRound(repo, instanceId);
  const gallery = await repo.readRoundGallery(instanceId);
  // a category of the contest shows each candidacy by name and by its public code; the slideshow carries no standing of any kind
  const items = gallery.map((g) => ({ alias: g.alias.slice(1), imageUrl: photoUrl(instanceId, g.alias.slice(1), "full"), name: g.publicName ?? null, code: g.publicCode ?? null }));
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { roundRole: info.roundRole, prompt: PUBLIC_TEXTS.prompts[info.roundRole], rotationSeconds: 8, generatedAt: new Date().toISOString(), items };
}

export async function getRoundPhoto(repo: RoundsRepository, instanceId: string, alias: string, variant: string | null): Promise<PhotoBytes | null> {
  if (!isUuidLike(instanceId) || !/^[0-9]{4}$/.test(alias) || (variant !== "thumb" && variant !== "full")) return null;
  return repo.readRoundPhoto({ instanceId, alias, variant });
}

/** What a PUBLISHED round announced: its winners (none when nobody cast a valid vote). Nothing before publication, and never a count. */
export async function getRoundPublicResults(
  repo: RoundsRepository,
  instanceId: string
): Promise<{ published: boolean; kind: PublicRoundResult["kind"] | null; items: Array<{ alias: string; name: string | null; code: string | null }> }> {
  const info = await requireRound(repo, instanceId);
  if (!info.published) return { published: false, kind: null, items: [] };
  const [rows, gallery] = await Promise.all([repo.readRoundPublicResults(instanceId), repo.readRoundGallery(instanceId)]);
  // The announcement names a winner by the public name and code its person chose. A winner whose photograph was hidden since is no longer in
  // the gallery: it is announced by its published number alone, exactly as before.
  const byAlias = new Map(gallery.map((g) => [g.alias, g]));
  return {
    published: true,
    kind: rows[0]?.kind ?? "WINNERS",
    items: rows.map((r) => {
      const g = byAlias.get(r.alias);
      return { alias: r.alias.slice(1), name: g?.publicName ?? null, code: g?.publicCode ?? null };
    }),
  };
}

// ---------------------------------------------------------------- identity: bind

/**
 * Binds the caller to the round. Idempotent. The identity is checked here AND by the database (a confirmed email and an existing Gaming
 * Member are conditions of the binding row itself); no identity and no profile is created, and nothing is linked or merged.
 */
export async function bindRoundVoter(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string): Promise<VoterBindingResult> {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  await requireRound(deps.repo, instanceId);
  return deps.repo.bindVoter({ instanceId, authUserId });
}

export async function claimRoundEntryAsVoter(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string, body: unknown): Promise<ClaimedEntry> {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A JSON object body is required.");
  const claimCode = (body as Record<string, unknown>).claimCode;
  if (typeof claimCode !== "string") throw invalid("A claim code is required.");
  requireInstanceId(instanceId);
  return deps.repo.claimRoundEntry({ instanceId, authUserId, claimCode });
}

// ---------------------------------------------------------------- status and discovery

export async function getRoundVoterStatus(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string) {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  const info = await requireRound(deps.repo, instanceId);
  const status = await deps.repo.readRoundVoterStatus({ instanceId, authUserId });
  return {
    bound: status !== null,
    instanceId,
    roundRole: info.roundRole,
    phase: phaseOf(info),
    locationRequired: info.locationRequired,
    deadlineAt: info.deadlineAt,
    serverNow: info.serverNow,
    deadlineRemainingMs: deadlineRemainingMs(info),
    tentative: info.scheduleStatus !== "CONFIRMED",
    schedule: {
      registrationOpensAt: info.registrationOpensAt,
      contestantCutoffAt: info.contestantCutoffAt,
      votingOpensAt: info.votingOpensAt,
      votingClosesAt: info.votingClosesAt,
    },
    interactionInstanceId: status?.interactionInstanceId ?? null,
    bindingId: status?.bindingId ?? null,
    issuedIntentNo: status?.issuedIntentNo ?? 0,
    appliedIntentNo: status?.appliedIntentNo ?? 0,
    myCandidateId: status?.myCandidateId ?? null,
    myEntry: status?.myEntry ?? null,
    published: info.published,
  };
}

/**
 * The gallery as THIS voter sees it: every shown contestant, in the voter's own reproducible order (see ordering.ts). The order depends
 * on the event and the voter's binding only — never on arrival, votes or anything else — and is computed here, on the server.
 */
export async function getRoundGallery(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string) {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  const info = await requireRound(deps.repo, instanceId);
  const status = await deps.repo.readRoundVoterStatus({ instanceId, authUserId });
  if (!status) throw new CommunityVotingError("NOT_BOUND", "This identity is not bound to the Instance.");
  const rows = await deps.repo.readRoundGallery(instanceId);
  const keyed = rows.map((r) => ({ ...r, candidateId: r.candidateId ?? `alias:${r.alias}` }));
  const ordered = orderCandidatesForVoter(keyed, instanceId, status.bindingId);
  const mine = status.myEntry?.label ?? null;
  return {
    phase: phaseOf(info),
    roundRole: info.roundRole,
    interactionInstanceId: status.interactionInstanceId,
    algorithm: ORDERING_ALGORITHM,
    prompt: PUBLIC_TEXTS.prompts[info.roundRole],
    items: ordered.map((r) => {
      const alias = r.alias.slice(1);
      return {
        alias,
        candidateId: r.candidateId.startsWith("alias:") ? null : r.candidateId,
        thumbUrl: photoUrl(instanceId, alias, "thumb"),
        fullUrl: photoUrl(instanceId, alias, "full"),
        mine: mine === r.alias,
        // a category of the contest shows each candidacy by name and by its public code (the code only locates)
        code: r.publicCode ?? null,
        name: r.publicName ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------- intents and votes

/** Hands the caller's own binding its next server-issued, strictly increasing intent number (the unchanged GATE-003 mechanism). */
export async function issueRoundIntent(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string): Promise<IssuedIntent> {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  await requireRound(deps.repo, instanceId);
  return deps.repo.issueIntent({ instanceId, authUserId });
}

/**
 * Casts (or revises) the caller's ONE favorite in this round.
 *
 * The round decides whether a location is part of the request, never the browser: the FINAL needs a well-formed reading with EVERY
 * vote and EVERY revision (the database evaluates it against the stored venue), the PRELIMINARY needs none and any reading sent to it
 * is dropped here, before the database, and is never stored. Validation failures are raised BEFORE the repository is touched, so a
 * malformed request can never consume an intent, and no error here repeats a coordinate.
 */
export async function castRoundVote(deps: RoundVoterDeps, authorizationHeader: string | null | undefined, instanceId: string, body: unknown): Promise<CastCommunityVoteResult> {
  const { authUserId } = await resolveRoundVoter(deps, authorizationHeader);
  const info = await requireRound(deps.repo, instanceId);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The request body must be a JSON object.");
  const { bindingId, intentNo, interactionInstanceId, candidateId, location } = body as Record<string, unknown>;
  if (!isUuidLike(bindingId) || !isUuidLike(interactionInstanceId) || !isUuidLike(candidateId)) {
    throw invalid("bindingId, interactionInstanceId and candidateId must be valid ids.");
  }
  if (typeof intentNo !== "number" || !Number.isInteger(intentNo) || intentNo < 1) throw invalid("intentNo must be a positive integer.");
  const claim = info.locationRequired ? validateLocationClaim(location) : null;
  return deps.repo.castRoundVote({ instanceId, authUserId, bindingId, intentNo, interactionInstanceId, candidateId, location: claim });
}
