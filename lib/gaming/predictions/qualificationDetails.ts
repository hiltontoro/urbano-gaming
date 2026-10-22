import type { PrizeQualificationDetailRecord, PrizeQualificationRecord } from "./types";

/**
 * What a Gaming Member may see of their own entitlement. Staff-only
 * detail — who delivered it, the internal hold and release reasons, the
 * links between entitlements — stays behind the admin gate; a member
 * only learns whether the prize was delivered, is superseded, was
 * already delivered under an earlier result, or is being reviewed.
 */
export interface MemberQualificationView {
  prizeQualificationId: string;
  evaluationId: string;
  venueActivationId: string;
  prizeTierId: string;
  redeemedAt: string | null;
  supersededAt: string | null;
  /** An earlier delivery already satisfies this prize. */
  alreadyDelivered: boolean;
  /** The prize is being reviewed by the venue and cannot be collected yet. */
  underReview: boolean;
  createdAt: string;
}

export function toMemberQualificationView(
  qualification: PrizeQualificationRecord
): MemberQualificationView {
  return {
    prizeQualificationId: qualification.prizeQualificationId,
    evaluationId: qualification.evaluationId,
    venueActivationId: qualification.venueActivationId,
    prizeTierId: qualification.prizeTierId,
    redeemedAt: qualification.redeemedAt,
    supersededAt: qualification.supersededAt,
    alreadyDelivered: qualification.fulfilledByPrizeQualificationId !== null,
    underReview: qualification.heldAt !== null && qualification.releasedAt === null,
    createdAt: qualification.createdAt,
  };
}

export function attachQualificationDetails(
  qualifications: PrizeQualificationRecord[],
  memberDisplayNames: ReadonlyMap<string, string>,
  prizeLabels: ReadonlyMap<string, string>
): PrizeQualificationDetailRecord[] {
  return qualifications.map((qualification) => ({
    ...qualification,
    memberDisplayName: memberDisplayNames.get(qualification.gamingMemberId) ?? null,
    prizeLabel: prizeLabels.get(qualification.prizeTierId) ?? null,
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
