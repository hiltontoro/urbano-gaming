import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { uploadEntryPhoto } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/photo — body { fullImage, thumbImage } as base64 JPEG. The server re-parses both and rebuilds them WITHOUT any EXIF/GPS/comment data before storing. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("UPLOAD_ROUND_PHOTO", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await uploadEntryPhoto(env.repo, ctx, params.entryId, await readJson(request)), 201);
  });
}
