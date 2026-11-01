import type { CategoryKey } from "./categories";
import type { RoundOverview, RoundOverviewEntry, RoundPublication, RoundPublicInfo } from "../rounds/types";

/** Types of the four-category contest (UG-IV-GATE-018). Nothing here carries an email, an Auth id, a token, a coordinate or a person's name. */

export type EntryKind = "INDIVIDUAL" | "GROUP" | "GROUP_MEMBER";

/** A category round as registered: one Session, one Instance, one category of one contest. */
export interface CategoryRoundRecord {
  instanceId: string;
  sessionId: string;
  contestId: string;
  categoryKey: CategoryKey;
  ruleVersion: number;
  createdAt: string;
}

/** What the operator needs of the group structure: no identity, no binding — the attribution of a member stays private. */
export interface CategoryStructureRow {
  entryId: string;
  kind: EntryKind;
  /** The group a member belongs to; null for every other entry. */
  groupEntryId: string | null;
  /** For a member: has this person consented to the group's CURRENT photograph? Null for any other entry. */
  memberConsent: boolean | null;
  /** For a group: is its photograph backed by every person in it (at least one member, every member associated and consenting)? */
  groupComplete: boolean | null;
  /** For an individual or a group: is the entry's OWN consent to its current photograph recorded (a group's: the representative's)? Null for a member. */
  entryConsent: boolean | null;
  /** The operator's decision on the current photograph, when there is one. Null for a member. */
  photoDecision: "APPROVED" | "REJECTED" | null;
  /** The candidacy's public code and name (null for a member, who has none). */
  publicCode: string | null;
  publicName: string | null;
  /** Did the person register THEMSELVES? Whether a delivery number is on file and how the delivery stands — never the number. */
  selfRegistered: boolean;
  hasWhatsapp: boolean;
  deliveryStatus: DeliveryStatus | null;
}

export type DeliveryStatus = "PENDING" | "DELIVERED";

export interface ContestCategoryRef {
  purpose?: "LIVE" | "REHEARSAL";
  registrationOpened?: boolean;
  categoryKey: CategoryKey;
  instanceId: string;
  /** Has the operator chosen to show the contest on Home? */
  listed: boolean;
}

export interface CategoryOf {
  contestId: string;
  categoryKey: CategoryKey;
}

/** The operator's overview of one category: the pilot's overview plus the kind and the group structure of every entry. */
export type CategoryOverviewEntry = RoundOverviewEntry & {
  kind: EntryKind;
  groupEntryId: string | null;
  memberConsent: boolean | null;
  groupComplete: boolean | null;
  entryConsent: boolean | null;
  photoDecision: "APPROVED" | "REJECTED" | null;
  publicCode: string | null;
  publicName: string | null;
  selfRegistered: boolean;
  hasWhatsapp: boolean;
  deliveryStatus: DeliveryStatus | null;
};
export interface CategoryOverview extends Omit<RoundOverview, "entries"> {
  contestId: string;
  categoryKey: CategoryKey;
  entries: CategoryOverviewEntry[];
}

/** A published category: the winners announced (none when no valid vote was cast). */
export interface CategoryPublication extends RoundPublication {
  winnerCount: number;
}

export type CategoryPublicInfo = RoundPublicInfo & { contestId: string; categoryKey: CategoryKey };

// ---------------------------------------------------------------- self-registration (the addendum)

/** What a person gets back from registering themselves: the code, the name and the kind of candidacy. Never the number. */
export interface CandidacyRegistered {
  entryId: string;
  categoryKey: CategoryKey;
  publicCode: string;
  publicName: string;
  kind: "INDIVIDUAL" | "GROUP";
}

export type CandidacyRole = "INDIVIDUAL" | "REPRESENTATIVE" | "MEMBER";
export type MyCandidacyState = "REGISTERED" | "PUBLIC" | "WITHDRAWN";

/** A person's OWN candidacy (as a contestant, a group's representative or an attributed member of a group). */
export interface MyCandidacy {
  categoryKey: CategoryKey;
  instanceId: string;
  role: CandidacyRole;
  kind: "INDIVIDUAL" | "GROUP";
  publicCode: string;
  publicName: string | null;
  state: MyCandidacyState;
  /** Only for the person who registered: how the delivery of their photograph stands. Null for a member. */
  deliveryStatus: DeliveryStatus | null;
}

/** A candidacy as the public sees it — the same permission as the gallery: confirmed, approved and consented, not hidden, not withdrawn. */
export interface PublicCandidacy {
  categoryKey: CategoryKey;
  instanceId: string;
  /** The opaque ballot number, which also names the picture (`/photos/<alias>`). */
  alias: string;
  candidateId: string | null;
  ordinal: number;
  publicCode: string;
  publicName: string | null;
}

/** A candidacy as the operator finds it by its code — before it is public. */
export interface StationCandidacy {
  entryId: string;
  instanceId: string;
  categoryKey: CategoryKey;
  kind: EntryKind;
  publicCode: string;
  publicName: string | null;
  selfRegistered: boolean;
  hasWhatsapp: boolean;
  deliveryStatus: DeliveryStatus | null;
  withdrawn: boolean;
  createdAt: string;
}

/** The ONE thing that carries a number: the designated operator's own read, for the manual delivery. */
export interface RegistrationContact {
  whatsapp: string;
  deliveryStatus: DeliveryStatus;
}

export interface RegisterCandidacyInput {
  instanceId: string;
  authUserId: string;
  publicName: string;
  adultConfirmed: boolean;
  requirementsVersion: string;
  requirementsSha256: string;
  whatsapp: string;
  whatsappConfirmed: boolean;
  deliveryVersion: string;
  deliverySha256: string;
  deliveryAuthorized: boolean;
}
