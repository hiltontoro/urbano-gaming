import type { CastCommunityVoteInput, ClaimedEntry, ConfirmedEntry, IssuedIntent } from "../types";
import type {
  CastCommunityVoteResult,
  FinalistSelection,
  FollowupTask,
  GalleryRow,
  OperatorContext,
  PhotoBytes,
  PhotoDecision,
  PhotoHiddenResult,
  PolicyApproval,
  PolicyKey,
  PromoDecision,
  PublicRoundResult,
  RegisterRoundInput,
  RoundVenue,
  RoundClosure,
  RoundEntryCreated,
  RoundEvidence,
  RoundInstanceRecord,
  RoundOverview,
  RoundPublication,
  RoundPublicInfo,
  RoundResultRow,
  RoundReview,
  RoundStarted,
  RoundVoterStatus,
  RoundWithdrawal,
  Schedule,
  ScheduleInput,
  UploadedPhoto,
  VoterBindingResult,
  GeofenceTestResult,
  SavedVenue,
} from "./types";

/**
 * Persistence boundary of the two-round pilot. Implemented only by the Supabase repository: every operation is one SQL function,
 * atomic and authoritative in the database, and the behavior that matters (the identity policy, one favorite per identity per round,
 * the binding deadlines and the final's geofence, the cut and the Product decisions it waits for, the freeze, the close, the review and
 * the publication) is proven against real Postgres.
 */
export interface RoundsRepository {
  // ---- operator
  registerRound(input: RegisterRoundInput): Promise<RoundInstanceRecord>;
  setRoundSchedule(input: OperatorContext & { schedule: ScheduleInput }): Promise<Schedule>;
  /**
   * Saves the final's venue geofence. The database decides: designated operator, a FINAL, never opened (it serializes with the opening on the
   * Session lock), valid values; it records who, when, old and new.
   */
  configureFinalGeofence(input: OperatorContext & { venue: RoundVenue }): Promise<SavedVenue>;
  /** Evaluates ONE reading with the vote's own evaluator against the stored geofence. Writes nothing and keeps nothing. */
  testFinalGeofence(input: OperatorContext & { location: { latitude: number; longitude: number; accuracyMeters: number } }): Promise<GeofenceTestResult>;
  createRoundEntry(input: OperatorContext & { claimTtlSeconds?: number }): Promise<RoundEntryCreated>;
  removeRoundEntry(input: OperatorContext & { entryId: string }): Promise<void>;
  uploadEntryPhoto(input: OperatorContext & { entryId: string; fullBase64: string; thumbBase64: string; width: number; height: number }): Promise<UploadedPhoto>;
  recordEntryConsent(input: OperatorContext & { entryId: string; photoId: string; consentVersion: string; statementSha256: string; ageConfirmed: boolean }): Promise<{ consentId: string; acceptedAt: string }>;
  recordPromoConsent(input: OperatorContext & { entryId: string; decision: PromoDecision; consentVersion: string; statementSha256: string }): Promise<{ promoConsentId: string; entryId: string; decision: PromoDecision; recordedAt: string }>;
  decideEntryPhoto(input: OperatorContext & { entryId: string; photoId: string; decision: PhotoDecision; reason?: string }): Promise<{ entryId: string; photoId: string; decision: PhotoDecision }>;
  confirmRoundAssociation(input: OperatorContext & { entryId: string; confirmationCode: string }): Promise<ConfirmedEntry>;
  /** Photograph visibility: hides it in every round and erases its bytes. Decides nothing about the competition. */
  hideRoundPhoto(input: OperatorContext & { entryId: string; reason: string }): Promise<PhotoHiddenResult>;
  /** Candidature withdrawal: leaves every ranking and gallery, keeps every vote; erases the photograph only when `hidePhoto` is true. */
  withdrawRoundCandidature(input: OperatorContext & { entryId: string; reason: string; hidePhoto: boolean }): Promise<RoundWithdrawal>;
  recordPolicyApproval(input: OperatorContext & { policyKey: PolicyKey; policyValue: string; approvalReference: string }): Promise<PolicyApproval>;
  resolveFollowupTask(input: OperatorContext & { taskId: string; note: string }): Promise<Pick<FollowupTask, "taskId" | "status" | "resolvedAt">>;
  startRound(input: OperatorContext & { promptText: string }): Promise<RoundStarted>;
  closeRound(input: OperatorContext): Promise<RoundClosure>;
  readRoundResults(input: OperatorContext): Promise<RoundResultRow[]>;
  readRoundEvidence(input: OperatorContext): Promise<RoundEvidence>;
  readRoundOverview(input: OperatorContext): Promise<RoundOverview>;
  selectFinalists(input: OperatorContext): Promise<FinalistSelection>;
  prepareFinal(input: OperatorContext): Promise<{ carriedCount: number; alreadyPrepared: boolean }>;
  recordRoundReview(input: OperatorContext & { note?: string }): Promise<RoundReview>;
  publishRound(input: OperatorContext): Promise<RoundPublication>;

  // ---- public (no identity)
  readRoundPublicInfo(instanceId: string): Promise<RoundPublicInfo | null>;
  readRoundGallery(instanceId: string): Promise<GalleryRow[]>;
  readRoundPhoto(input: { instanceId: string; alias: string; variant: "thumb" | "full" }): Promise<PhotoBytes | null>;
  readRoundPublicResults(instanceId: string): Promise<PublicRoundResult[]>;

  // ---- voter
  bindVoter(input: { instanceId: string; authUserId: string }): Promise<VoterBindingResult>;
  issueIntent(input: { instanceId: string; authUserId: string }): Promise<IssuedIntent>;
  claimRoundEntry(input: { instanceId: string; authUserId: string; claimCode: string }): Promise<ClaimedEntry>;
  castRoundVote(input: CastRoundVoteInput): Promise<CastCommunityVoteResult>;
  readRoundVoterStatus(input: { instanceId: string; authUserId: string }): Promise<RoundVoterStatus | null>;
}

/** A cast carries a location reading ONLY for the final; the preliminary's input has none and the database would ignore one. */
export type CastRoundVoteInput = Omit<CastCommunityVoteInput, "location"> & {
  authUserId: string;
  location: { latitude: number; longitude: number; accuracyMeters: number } | null;
};
