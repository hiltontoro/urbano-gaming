import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { recordPromoConsent } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/promo-consent — the OPTIONAL promotional decision, separate from the contest consent. Body { consentVersion, decision: ACCEPTED|DECLINED|WITHDRAWN }. Declining never prevents competing. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("RECORD_ROUND_PROMO_CONSENT", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await recordPromoConsent(env.repo, ctx, params.entryId, await readJson(request)), 201);
  });
}
