import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { InMemorySessionRepository } from "../../../session/db/inMemorySessionRepository";
import type {
  ParticipantRecord,
  SessionEventRecord,
  VoteRecord,
  VotingCandidateRecord,
} from "../../../session/db/sessionRepository";
import {
  HostTokenMismatchError,
  InvalidCandidateSelectionError,
  SessionNotFoundError,
  type SessionRecord,
} from "../../../session/types";
import { assessLocationEligibility, validateGeofenceConfig, validateLocationClaim } from "../eligibility";
import { payloadDigest } from "../payloadCommitment";
import type {
  CastCommunityVoteInput,
  CastCommunityVoteResult,
  CastOutcome,
  ClaimedEntry,
  CommunityVotingInstanceRecord,
  ConfirmedEntry,
  CreatedEntry,
  EntryState,
  IssuedIntent,
  PreparationEntry,
  RegisterInstanceInput,
  StartedVoting,
  VoterBindingResult,
  VoterStatusSnapshot,
} from "../types";
import { CommunityVotingError } from "../types";
import type { CommunityVotingRepository } from "./communityVotingRepository";

interface BindingRow {
  bindingId: string;
  instanceId: string;
  authUserId: string;
  participantId: string;
  issuedIntentNo: number;
  appliedIntentNo: number;
  appliedPayloadDigest: string | null;
  appliedDistanceMeters: number | null;
  appliedAccuracyMeters: number | null;
  appliedAt: string | null;
  createdAt: string;
}

/** A preparation entry: readiness data only. Secrets are held as digests; there is no candidate and no vote here. */
interface EntryRow {
  entryId: string;
  instanceId: string;
  ordinal: number;
  label: string;
  claimCodeHash: string | null;
  claimWindowSeconds: number;
  claimExpiresAt: number;
  pendingBindingId: string | null;
  confirmationCodeHash: string | null;
  confirmationExpiresAt: number | null;
  confirmationFailures: number;
  confirmedBindingId: string | null;
  candidateId: string | null;
  createdAt: string;
}

const MAX_CONFIRMATION_FAILURES = 5;

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The parts of InMemorySessionRepository this double has to write to directly, because the Session
 * layer has (deliberately) no public operation for them: admitting a Participant outside LOBBY_OPEN
 * (the Instance's own admission rule) and attributing the candidate rows its own start just created. Reads and
 * the vote itself go through the double's PUBLIC methods, so castVote below really does delegate to the
 * Session/Voting implementation, and startVoting really does open Voting through the Session's own start. This
 * coupling to private fields is confined to one accessor and is asserted at construction, so a rename in the
 * Session double fails loudly instead of silently.
 */
interface SessionInternals {
  sessions: Map<string, SessionRecord>;
  participants: Map<string, ParticipantRecord>;
  votingCandidates: Map<string, VotingCandidateRecord>;
  events: SessionEventRecord[];
}

/**
 * In-memory test double for the Community Voting Instance.
 *
 * Every operation runs inside one serialized critical section (the double's stand-in for taking the
 * Session row lock first), re-validates every precondition itself, and changes nothing until every
 * check has passed. It mirrors the SQL functions' CHECK ORDER and error codes; the contract suite is
 * what proves the real database agrees (including the rollback of a failed start and the guards that make
 * the ordinary start and ordinary join unable to bypass this module — neither exists in this double).
 *
 * It keeps three collections — Instances, bindings and preparation entries — and no ballot, vote, tally,
 * ownership map or lifecycle state. Whether Voting is "opened" is DERIVED from the Session double: an
 * interaction exists. `options.now` makes claim and confirmation windows deterministic in tests.
 */
export class InMemoryCommunityVotingRepository implements CommunityVotingRepository {
  private instances = new Map<string, CommunityVotingInstanceRecord>();
  private bindings = new Map<string, BindingRow>();
  private entries = new Map<string, EntryRow>();
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private sessionRepo: InMemorySessionRepository,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    const internals = this.internals();
    if (
      !(internals.sessions instanceof Map) ||
      !(internals.participants instanceof Map) ||
      !(internals.votingCandidates instanceof Map) ||
      !Array.isArray(internals.events)
    ) {
      throw new Error("InMemorySessionRepository internals changed: update InMemoryCommunityVotingRepository.");
    }
  }

  private internals(): SessionInternals {
    return this.sessionRepo as unknown as SessionInternals;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  // ------------------------------------------------------------ test-only inspection (never used by production code)

  testParticipantIdForBinding(bindingId: string): string {
    const binding = this.bindings.get(bindingId);
    if (!binding) throw new Error("Unknown binding.");
    return binding.participantId;
  }

  testSnapshot(): { instances: CommunityVotingInstanceRecord[]; bindings: BindingRow[]; entries: EntryRow[] } {
    return {
      instances: [...this.instances.values()].map((i) => ({ ...i })),
      bindings: [...this.bindings.values()].map((b) => ({ ...b })),
      entries: [...this.entries.values()].map((e) => ({ ...e })),
    };
  }

  // ------------------------------------------------------------ helpers

  private async currentInteraction(sessionId: string) {
    const instances = await this.sessionRepo.getInteractionInstancesForSession(sessionId);
    return instances.length > 0 ? instances[instances.length - 1] : null;
  }

  /** DERIVED, not stored: Voting has opened exactly when the Session has any interaction. */
  private async hasOpened(sessionId: string): Promise<boolean> {
    return (await this.sessionRepo.getInteractionInstancesForSession(sessionId)).length > 0;
  }

  private findBinding(instanceId: string, authUserId: string): BindingRow | null {
    return (
      [...this.bindings.values()].find((b) => b.instanceId === instanceId && b.authUserId === authUserId) ?? null
    );
  }

  private entriesOf(instanceId: string): EntryRow[] {
    return [...this.entries.values()]
      .filter((e) => e.instanceId === instanceId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  private requireInstance(instanceId: string): CommunityVotingInstanceRecord {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
    }
    return instance;
  }

  /** Instance, then host authority, then (for writes) the freeze — the same order every SQL host function uses. */
  private async requireHostOfPreparation(
    instanceId: string,
    hostToken: string,
    opts: { writing: boolean }
  ): Promise<CommunityVotingInstanceRecord> {
    const instance = this.requireInstance(instanceId);
    const session = this.internals().sessions.get(instance.sessionId)!;
    if (session.hostToken !== hostToken) throw new HostTokenMismatchError();
    if (opts.writing && (await this.hasOpened(instance.sessionId))) {
      throw new CommunityVotingError("PREPARATION_CLOSED", "Voting has opened; the ballot can no longer change.");
    }
    return instance;
  }

  private entryState(e: EntryRow): EntryState {
    if (e.confirmedBindingId !== null) return "CONFIRMED";
    if (e.pendingBindingId !== null) return "PENDING_CONFIRMATION";
    return "UNCLAIMED";
  }

  private async snapshotFor(binding: BindingRow, instance: CommunityVotingInstanceRecord): Promise<VoterStatusSnapshot> {
    const session = this.internals().sessions.get(instance.sessionId)!;
    const current = await this.currentInteraction(instance.sessionId);

    let myCandidateId: string | null = null;
    if (current && current.engineType === "VOTING") {
      const votes = await this.sessionRepo.getVotesForInteractionInstance(current.interactionInstanceId);
      myCandidateId = votes.find((v) => v.participantId === binding.participantId)?.candidateId ?? null;
    }

    const mine = this.entriesOf(instance.instanceId).find(
      (e) => e.pendingBindingId === binding.bindingId || e.confirmedBindingId === binding.bindingId
    );
    const mineState = mine ? this.entryState(mine) : null;

    return {
      instanceId: instance.instanceId,
      bindingId: binding.bindingId,
      sessionState: session.state,
      interactionInstanceId: current?.interactionInstanceId ?? null,
      interactionState: current?.state ?? null,
      engineType: current?.engineType ?? null,
      issuedIntentNo: binding.issuedIntentNo,
      appliedIntentNo: binding.appliedIntentNo,
      myCandidateId,
      myEntry:
        mine && (mineState === "PENDING_CONFIRMATION" || mineState === "CONFIRMED")
          ? { label: mine.label, state: mineState }
          : null,
    };
  }

  // ------------------------------------------------------------ operations

  registerInstance(input: RegisterInstanceInput): Promise<CommunityVotingInstanceRecord> {
    return this.exclusive(async () => {
      const internals = this.internals();
      const session = internals.sessions.get(input.sessionId);
      if (!session) throw new SessionNotFoundError();
      if (session.hostToken !== input.hostToken) throw new HostTokenMismatchError();

      if ([...this.instances.values()].some((i) => i.sessionId === input.sessionId)) {
        throw new CommunityVotingError("INSTANCE_ALREADY_REGISTERED", "This session already has a Community Voting Instance.");
      }
      if (session.state !== "LOBBY_OPEN" && session.state !== "LOBBY_LOCKED") {
        throw new CommunityVotingError("SESSION_NOT_REGISTRABLE", `Session is in ${session.state} state.`);
      }
      const caps = session.declaredCapabilities;
      if (!Array.isArray(caps) || caps.length !== 1 || caps[0] !== "VOTING") {
        throw new CommunityVotingError(
          "CAPABILITY_SET_NOT_EXACTLY_VOTING",
          "The declared capability set must be exactly VOTING."
        );
      }
      if ([...internals.participants.values()].some((p) => p.sessionId === input.sessionId)) {
        throw new CommunityVotingError(
          "PARTICIPANTS_ALREADY_EXIST",
          "An Instance must be registered before any Participant exists."
        );
      }
      if (!Number.isInteger(input.ruleVersion) || input.ruleVersion < 1) {
        throw new CommunityVotingError("INVALID_REQUEST", "ruleVersion must be a positive integer.");
      }
      const config = validateGeofenceConfig(input.config);

      const record: CommunityVotingInstanceRecord = {
        instanceId: randomUUID(),
        sessionId: input.sessionId,
        ...config,
        ruleVersion: input.ruleVersion,
        createdAt: new Date().toISOString(),
      };
      this.instances.set(record.instanceId, record);
      return { ...record };
    });
  }

  bindVoter(input: { instanceId: string; authUserId: string }): Promise<VoterBindingResult> {
    return this.exclusive(async () => {
      const instance = this.requireInstance(input.instanceId);
      const internals = this.internals();
      const session = internals.sessions.get(instance.sessionId)!;

      const existing = this.findBinding(input.instanceId, input.authUserId);
      if (existing) {
        return { bindingId: existing.bindingId, instanceId: input.instanceId, created: false };
      }

      const caps = session.declaredCapabilities;
      if (!Array.isArray(caps) || caps.length !== 1 || caps[0] !== "VOTING") {
        throw new CommunityVotingError(
          "CAPABILITY_SET_NOT_EXACTLY_VOTING",
          "The declared capability set must be exactly VOTING."
        );
      }

      // The explicit admission states (mirrors bind_community_voting_voter_atomically).
      const current = await this.currentInteraction(instance.sessionId);
      const admitted =
        session.state === "LOBBY_OPEN" ||
        (session.state === "LOBBY_LOCKED" &&
          (current === null || (current.engineType === "VOTING" && current.state === "PROMPT_ACTIVE")));
      if (!admitted) {
        throw new CommunityVotingError("ADMISSION_CLOSED", "New voters are not admitted in this state.");
      }

      // An opaque Participant: random label unrelated to the Auth user, no Gaming Member, token born here.
      const taken = new Set(
        [...internals.participants.values()]
          .filter((p) => p.sessionId === instance.sessionId)
          .map((p) => p.normalizedDisplayName)
      );
      let label = "";
      do {
        label = `cv-${randomBytes(8).toString("hex")}`;
      } while (taken.has(label));

      const participant: ParticipantRecord = {
        participantId: randomUUID(),
        sessionId: instance.sessionId,
        displayName: label,
        normalizedDisplayName: label,
        participantToken: randomBytes(32).toString("hex"),
        joinedAt: new Date().toISOString(),
        gamingMemberId: null,
      };
      internals.participants.set(participant.participantId, participant);
      internals.events.push({
        sessionId: instance.sessionId,
        eventType: "PARTICIPANT_JOINED",
        payload: { participantId: participant.participantId, displayName: label },
      } as SessionEventRecord);

      const binding: BindingRow = {
        bindingId: randomUUID(),
        instanceId: input.instanceId,
        authUserId: input.authUserId,
        participantId: participant.participantId,
        issuedIntentNo: 0,
        appliedIntentNo: 0,
        appliedPayloadDigest: null,
        appliedDistanceMeters: null,
        appliedAccuracyMeters: null,
        appliedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.bindings.set(binding.bindingId, binding);
      return { bindingId: binding.bindingId, instanceId: input.instanceId, created: true };
    });
  }

  issueIntent(input: { instanceId: string; authUserId: string }): Promise<IssuedIntent> {
    return this.exclusive(async () => {
      const instance = this.requireInstance(input.instanceId);
      const session = this.internals().sessions.get(instance.sessionId)!;
      const binding = this.findBinding(input.instanceId, input.authUserId);
      if (!binding) {
        throw new CommunityVotingError("NOT_BOUND", "This identity is not bound to the Instance.");
      }
      const current = await this.currentInteraction(instance.sessionId);
      if (
        session.state !== "LOBBY_LOCKED" ||
        !current ||
        current.engineType !== "VOTING" ||
        current.state !== "PROMPT_ACTIVE"
      ) {
        throw new CommunityVotingError("VOTING_NOT_OPEN", "Voting is not open.");
      }
      binding.issuedIntentNo += 1;
      return { bindingId: binding.bindingId, intentNo: binding.issuedIntentNo };
    });
  }

  // ------------------------------------------------------------ preparation

  createEntry(input: {
    instanceId: string;
    hostToken: string;
    label: string;
    claimTtlSeconds?: number;
  }): Promise<CreatedEntry> {
    return this.exclusive(async () => {
      const instance = await this.requireHostOfPreparation(input.instanceId, input.hostToken, { writing: true });

      const ttl = input.claimTtlSeconds ?? 900;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
        throw new CommunityVotingError("INVALID_REQUEST", "The claim window must be between 1 and 86400 seconds.");
      }
      // btrim() trims spaces; char_length() counts characters
      const label = typeof input.label === "string" ? input.label.replace(/^ +| +$/g, "") : "";
      if ([...label].length < 1 || [...label].length > 60) {
        throw new CommunityVotingError("ENTRY_LABEL_INVALID", "An entry label must be 1 to 60 characters.");
      }
      const existing = this.entriesOf(instance.instanceId);
      if (existing.some((e) => e.label.toLowerCase() === label.toLowerCase())) {
        throw new CommunityVotingError("ENTRY_LABEL_DUPLICATE", "This ballot already has an entry with that label.");
      }

      const claimCode = randomBytes(16).toString("hex");
      const expires = this.now() + ttl * 1000;
      const row: EntryRow = {
        entryId: randomUUID(),
        instanceId: instance.instanceId,
        ordinal: existing.reduce((max, e) => Math.max(max, e.ordinal), 0) + 1,
        label,
        claimCodeHash: sha256Hex(claimCode),
        claimWindowSeconds: ttl,
        claimExpiresAt: expires,
        pendingBindingId: null,
        confirmationCodeHash: null,
        confirmationExpiresAt: null,
        confirmationFailures: 0,
        confirmedBindingId: null,
        candidateId: null,
        createdAt: new Date(this.now()).toISOString(),
      };
      this.entries.set(row.entryId, row);
      return { entryId: row.entryId, label, claimCode, claimExpiresAt: new Date(expires).toISOString() };
    });
  }

  removeEntry(input: { instanceId: string; hostToken: string; entryId: string }): Promise<void> {
    return this.exclusive(async () => {
      const instance = await this.requireHostOfPreparation(input.instanceId, input.hostToken, { writing: true });
      const row = this.entries.get(input.entryId);
      if (!row || row.instanceId !== instance.instanceId) {
        throw new CommunityVotingError("ENTRY_NOT_FOUND", "This ballot has no such entry.");
      }
      this.entries.delete(input.entryId);
    });
  }

  readPreparation(input: { instanceId: string; hostToken: string }): Promise<PreparationEntry[]> {
    return this.exclusive(async () => {
      const instance = await this.requireHostOfPreparation(input.instanceId, input.hostToken, { writing: false });
      return this.entriesOf(instance.instanceId).map((e) => {
        const claimable =
          e.pendingBindingId === null &&
          e.confirmedBindingId === null &&
          e.claimCodeHash !== null &&
          e.claimExpiresAt > this.now();
        return {
          entryId: e.entryId,
          label: e.label,
          state: this.entryState(e),
          claimable,
          claimExpiresAt: claimable ? new Date(e.claimExpiresAt).toISOString() : null,
        };
      });
    });
  }

  claimEntry(input: { instanceId: string; authUserId: string; claimCode: string }): Promise<ClaimedEntry> {
    return this.exclusive(async () => {
      const instance = this.requireInstance(input.instanceId);

      const binding = this.findBinding(input.instanceId, input.authUserId);
      if (!binding) {
        throw new CommunityVotingError("NOT_BOUND", "This identity is not bound to the Instance.");
      }
      if (await this.hasOpened(instance.sessionId)) {
        throw new CommunityVotingError("PREPARATION_CLOSED", "Voting has opened; the ballot can no longer change.");
      }

      const code = typeof input.claimCode === "string" ? input.claimCode.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{32}$/.test(code)) {
        throw new CommunityVotingError("CLAIM_INVALID", "This claim is not valid.");
      }
      // Looked up only within THIS Instance: a credential from another event can never match.
      const digest = sha256Hex(code);
      const entry = this.entriesOf(instance.instanceId).find((e) => e.claimCodeHash === digest);
      if (!entry) {
        throw new CommunityVotingError("CLAIM_INVALID", "This claim is not valid.");
      }
      if (entry.claimExpiresAt <= this.now()) {
        throw new CommunityVotingError("CLAIM_EXPIRED", "This claim has expired.");
      }
      if (
        this.entriesOf(instance.instanceId).some(
          (e) => e.pendingBindingId === binding.bindingId || e.confirmedBindingId === binding.bindingId
        )
      ) {
        throw new CommunityVotingError(
          "CONTESTANT_ALREADY_HAS_ENTRY",
          "This identity already holds an entry in this ballot."
        );
      }

      const confirmationCode = randomBytes(4).toString("hex").toUpperCase();
      const confirmExpires = this.now() + entry.claimWindowSeconds * 1000;
      entry.claimCodeHash = null; // single use
      entry.pendingBindingId = binding.bindingId;
      entry.confirmationCodeHash = sha256Hex(confirmationCode);
      entry.confirmationExpiresAt = confirmExpires;
      entry.confirmationFailures = 0;
      return { label: entry.label, confirmationCode, confirmExpiresAt: new Date(confirmExpires).toISOString() };
    });
  }

  confirmEntry(input: {
    instanceId: string;
    hostToken: string;
    entryId: string;
    confirmationCode: string;
  }): Promise<ConfirmedEntry> {
    return this.exclusive(async () => {
      const instance = await this.requireHostOfPreparation(input.instanceId, input.hostToken, { writing: true });

      const entry = this.entries.get(input.entryId);
      if (!entry || entry.instanceId !== instance.instanceId) {
        throw new CommunityVotingError("ENTRY_NOT_FOUND", "This ballot has no such entry.");
      }
      if (entry.pendingBindingId === null) {
        throw new CommunityVotingError("CONFIRMATION_NOT_PENDING", "This entry has no claim waiting for confirmation.");
      }
      if (entry.confirmationExpiresAt !== null && entry.confirmationExpiresAt <= this.now()) {
        throw new CommunityVotingError("CLAIM_EXPIRED", "This claim has expired.");
      }
      const normalized =
        typeof input.confirmationCode === "string"
          ? input.confirmationCode.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
          : "";
      if (normalized === "") {
        throw new CommunityVotingError("INVALID_REQUEST", "A confirmation code is required.");
      }

      if (entry.confirmationCodeHash === sha256Hex(normalized)) {
        entry.confirmedBindingId = entry.pendingBindingId;
        entry.pendingBindingId = null;
        entry.confirmationCodeHash = null;
        entry.confirmationExpiresAt = null;
        entry.confirmationFailures = 0;
        return { entryId: entry.entryId, state: "CONFIRMED" };
      }

      // A wrong code COUNTS (the mutation below persists; the error is thrown after it). The fifth voids the claim.
      if (entry.confirmationFailures + 1 >= MAX_CONFIRMATION_FAILURES) {
        entry.pendingBindingId = null;
        entry.confirmationCodeHash = null;
        entry.confirmationExpiresAt = null;
        entry.confirmationFailures = 0;
        throw new CommunityVotingError(
          "CLAIM_VOIDED",
          "Too many wrong confirmation codes: this claim is void. Remove the entry and create it again."
        );
      }
      entry.confirmationFailures += 1;
      throw new CommunityVotingError("CONFIRMATION_REJECTED", "The confirmation code does not match.");
    });
  }

  // ------------------------------------------------------------ the explicit start

  startVoting(input: { instanceId: string; hostToken: string; promptText: string }): Promise<StartedVoting> {
    return this.exclusive(async () => {
      const instance = this.requireInstance(input.instanceId);
      const internals = this.internals();
      const session = internals.sessions.get(instance.sessionId)!;
      if (session.hostToken !== input.hostToken) throw new HostTokenMismatchError();

      const caps = session.declaredCapabilities;
      if (!Array.isArray(caps) || caps.length !== 1 || caps[0] !== "VOTING") {
        throw new CommunityVotingError(
          "CAPABILITY_SET_NOT_EXACTLY_VOTING",
          "The declared capability set must be exactly VOTING."
        );
      }
      if (await this.hasOpened(instance.sessionId)) {
        throw new CommunityVotingError("ALREADY_OPENED", "Voting has already opened for this event.");
      }
      if (session.state !== "LOBBY_LOCKED") {
        throw new CommunityVotingError("SESSION_NOT_STARTABLE", "The Session must be locked before Voting can start.");
      }
      const prompt = typeof input.promptText === "string" ? input.promptText.replace(/^ +| +$/g, "") : "";
      if (prompt === "" || [...prompt].length > 1000) {
        throw new CommunityVotingError("INVALID_REQUEST", "The prompt must be 1 to 1000 characters.");
      }

      const entries = this.entriesOf(instance.instanceId);
      if (entries.length < 2 || entries.some((e) => e.confirmedBindingId === null)) {
        throw new CommunityVotingError(
          "PREPARATION_INCOMPLETE",
          "The ballot needs at least two entries and every entry must have a confirmed contestant."
        );
      }

      // Resolve every attribution BEFORE the Session writes anything, so the step after the Session's own start
      // cannot fail in this double (the database proves the rollback of a late failure; see the contract suite).
      const participantByLabel = new Map<string, string>();
      for (const e of entries) {
        const binding = this.bindings.get(e.confirmedBindingId!);
        if (!binding || binding.instanceId !== instance.instanceId) {
          throw new CommunityVotingError("STATE_INCONSISTENT", "The event's stored state is inconsistent; the operation was refused.");
        }
        participantByLabel.set(e.label, binding.participantId);
      }

      // The Session-owned opening transition: the Session's own start, with the entries' labels as a HOST_AUTHORED
      // ballot — prompt, segment, interaction (PROMPT_ACTIVE), candidates and the single INTERACTION_STARTED event.
      const started = await this.sessionRepo.startSession(
        instance.sessionId,
        input.hostToken,
        {
          engineType: "VOTING",
          promptText: prompt,
          candidateSource: { type: "HOST_AUTHORED", candidates: entries.map((e) => e.label) },
        },
        "NEW_SEGMENT"
      );

      const candidates = await this.sessionRepo.getVotingCandidatesForInteraction(started.interactionInstanceId);
      for (const candidate of candidates) {
        const participantId = participantByLabel.get(candidate.label);
        if (!participantId) {
          throw new CommunityVotingError("STATE_INCONSISTENT", "The event's stored state is inconsistent; the operation was refused.");
        }
        internals.votingCandidates.set(candidate.candidateId, { ...candidate, participantId });
        const entry = entries.find((e) => e.label === candidate.label);
        if (entry) entry.candidateId = candidate.candidateId;
      }

      return {
        interactionInstanceId: started.interactionInstanceId,
        promptId: started.promptId,
        state: "PROMPT_ACTIVE",
        segmentNumber: started.segmentNumber,
        candidateCount: entries.length,
      };
    });
  }

  castVote(input: CastCommunityVoteInput & { authUserId: string }): Promise<CastCommunityVoteResult> {
    return this.exclusive(async () => {
      const instance = this.requireInstance(input.instanceId);
      const internals = this.internals();
      const session = internals.sessions.get(instance.sessionId)!;

      const binding = this.findBinding(input.instanceId, input.authUserId);
      if (!binding) {
        throw new CommunityVotingError("NOT_BOUND", "This identity is not bound to the Instance.");
      }
      if (input.bindingId !== binding.bindingId) {
        throw new CommunityVotingError("INTENT_BINDING_MISMATCH", "The intent does not belong to this voter binding.");
      }
      if (!Number.isInteger(input.intentNo) || input.intentNo < 1 || input.intentNo > binding.issuedIntentNo) {
        throw new CommunityVotingError("INTENT_UNISSUED", "This intent was not issued to this binding.");
      }

      const digest = payloadDigest(input.instanceId, input.interactionInstanceId, input.candidateId);

      // REPLAY
      if (input.intentNo === binding.appliedIntentNo) {
        if (binding.appliedPayloadDigest !== digest) {
          throw new CommunityVotingError(
            "INTENT_PAYLOAD_MISMATCH",
            "This intent was already applied with a different payload.",
            await this.snapshotFor(binding, instance),
            "APPLIED_WITH_DIFFERENT_PAYLOAD"
          );
        }
        const votes = await this.sessionRepo.getVotesForInteractionInstance(input.interactionInstanceId);
        const vote = votes.find((v) => v.participantId === binding.participantId);
        if (!vote) throw new Error("An applied intent has no authoritative vote.");
        return {
          outcome: "REPLAYED",
          bindingId: binding.bindingId,
          intentNo: input.intentNo,
          interactionInstanceId: input.interactionInstanceId,
          candidateId: vote.candidateId,
          voteUpdatedAt: vote.updatedAt,
        };
      }

      // STALE
      if (input.intentNo < binding.appliedIntentNo) {
        throw new CommunityVotingError(
          "STALE_INTENT",
          "A newer intent has already been applied.",
          await this.snapshotFor(binding, instance),
          "HISTORICAL_OUTCOME_UNAVAILABLE"
        );
      }

      // A NEW intent
      const current = await this.currentInteraction(instance.sessionId);
      if (
        session.state !== "LOBBY_LOCKED" ||
        !current ||
        current.engineType !== "VOTING" ||
        current.state !== "PROMPT_ACTIVE"
      ) {
        throw new CommunityVotingError("VOTING_NOT_OPEN", "Voting is not open.");
      }
      if (input.interactionInstanceId !== current.interactionInstanceId) {
        throw new CommunityVotingError(
          "INTERACTION_MISMATCH",
          "The stated interaction is not the current Voting interaction."
        );
      }
      const candidates = await this.sessionRepo.getVotingCandidatesForInteraction(current.interactionInstanceId);
      if (!candidates.some((c) => c.candidateId === input.candidateId)) {
        throw new InvalidCandidateSelectionError();
      }
      // INVARIANT: an open event ballot is attributed by construction (the explicit start attributes every candidate in
      // the transaction that creates them, and nothing can change them afterwards). Reaching this is corruption, so
      // it fails closed — it is never a normal condition and never accepts a vote.
      if (candidates.some((c) => c.participantId === null)) {
        throw new CommunityVotingError(
          "STATE_INCONSISTENT",
          "The event's stored state is inconsistent; the operation was refused."
        );
      }

      // Location: evaluated here, from the Instance's stored facts. Only INSIDE passes.
      const claim = validateLocationClaim(input.location);
      const assessment = assessLocationEligibility(claim, instance);
      if (assessment.decision === "ACCURACY_EXCESSIVE") {
        throw new CommunityVotingError("LOCATION_ACCURACY_EXCESSIVE", "The reading is too imprecise to be accepted.");
      }
      if (assessment.decision === "OUTSIDE") {
        throw new CommunityVotingError("LOCATION_OUTSIDE", "The reading is outside the event area.");
      }
      if (assessment.decision === "AMBIGUOUS") {
        throw new CommunityVotingError(
          "LOCATION_AMBIGUOUS",
          "The reading cannot be confirmed inside or outside the event area."
        );
      }

      // No-op reselection, or delegation to the Session/Voting writer
      const votes = await this.sessionRepo.getVotesForInteractionInstance(current.interactionInstanceId);
      const existing: VoteRecord | undefined = votes.find((v) => v.participantId === binding.participantId);

      let outcome: CastOutcome;
      let voteUpdatedAt: string;
      if (existing && existing.candidateId === input.candidateId) {
        outcome = "UNCHANGED";
        voteUpdatedAt = existing.updatedAt;
      } else {
        const participant = internals.participants.get(binding.participantId)!;
        // The token is read here, inside the critical section, and never leaves this method.
        const delegated = await this.sessionRepo.castVote(
          instance.sessionId,
          binding.participantId,
          participant.participantToken,
          input.candidateId
        );
        outcome = "APPLIED";
        voteUpdatedAt = delegated.updatedAt;
      }

      // Only now — after every check and the delegated write succeeded — record the recovery metadata.
      binding.appliedIntentNo = input.intentNo;
      binding.appliedPayloadDigest = digest;
      binding.appliedDistanceMeters = Math.round(assessment.distanceMeters * 10) / 10;
      binding.appliedAccuracyMeters = Math.round(claim.accuracyMeters * 10) / 10;
      binding.appliedAt = new Date().toISOString();

      return {
        outcome,
        bindingId: binding.bindingId,
        intentNo: input.intentNo,
        interactionInstanceId: current.interactionInstanceId,
        candidateId: input.candidateId,
        voteUpdatedAt,
      };
    });
  }

  readVoterStatus(input: { instanceId: string; authUserId: string }): Promise<VoterStatusSnapshot | null> {
    return this.exclusive(async () => {
      const instance = this.instances.get(input.instanceId);
      if (!instance) return null;
      const binding = this.findBinding(input.instanceId, input.authUserId);
      if (!binding) return null;
      return this.snapshotFor(binding, instance);
    });
  }
}
