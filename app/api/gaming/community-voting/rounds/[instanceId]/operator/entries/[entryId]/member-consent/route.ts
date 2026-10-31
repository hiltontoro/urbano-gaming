import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { recordMemberConsent } from "@/lib/gaming/communityVoting/contest/operations";

/**
 * POST .../operator/entries/[entryId]/member-consent — the consent of ONE attributed member of a group to the group's CURRENT photograph.
 * Body { photoId, consentVersion, accepted: true, ageConfirmed: true }. The statement and its digest are the server's.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("RECORD_MEMBER_CONSENT", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json({ consent: await recordMemberConsent(env.repo, ctx, params.entryId, await readJson(request)) }, 201);
  });
}
