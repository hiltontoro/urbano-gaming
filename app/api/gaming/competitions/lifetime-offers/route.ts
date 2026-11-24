import { handleListMyOffers } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the signed-in member's own pending offers: the invitations and requests they are party to or lead the team of, and the seat offers made to them or by them.
 * The verified member is the only input: nothing in the query, the headers or a body can choose another one.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request.
 */
export async function GET(request: Request) {
  return handleListMyOffers(request);
}
