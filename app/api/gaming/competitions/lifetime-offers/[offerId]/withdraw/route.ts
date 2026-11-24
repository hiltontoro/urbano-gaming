import { handleWithdrawOffer } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — withdraw a pending offer the caller's side made. The body is exactly {"kind": "MEMBERSHIP" | "LEADERSHIP"} and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { offerId: string } }) {
  return handleWithdrawOffer(request, context?.params?.offerId);
}
