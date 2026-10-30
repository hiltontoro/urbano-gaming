import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { recordGalleryConsent } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/consent — the GALLERY-AND-CONTEST consent (what a contestant needs to compete). Body { photoId, consentVersion, accepted, ageConfirmed }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("RECORD_ROUND_CONSENT", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await recordGalleryConsent(env.repo, ctx, params.entryId, await readJson(request)), 201);
  });
}
