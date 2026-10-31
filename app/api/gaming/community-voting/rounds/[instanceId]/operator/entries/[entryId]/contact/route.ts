import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { getDeliveryMaterial } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/**
 * POST .../operator/entries/[entryId]/contact — the designated operator's read of the delivery number, for the MANUAL delivery from their own WhatsApp.
 * The only response of the contest that carries a number; audited by the database (the entry, never the number); never cached. Reading it records
 * nothing about the delivery. No body.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("READ_DELIVERY_CONTACT", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await getDeliveryMaterial(env.repo, ctx, params.entryId, new URL(request.url).origin));
  });
}
