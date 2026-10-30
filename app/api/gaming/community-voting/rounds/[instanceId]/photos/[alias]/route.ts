import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { PUBLIC_PHOTO_CACHE_SECONDS } from "@/lib/gaming/communityVoting/rounds/constants";
import { getRoundPhoto } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/**
 * GET /api/gaming/community-voting/rounds/[instanceId]/photos/[alias]?v=thumb|full — a contestant's photograph by its OPAQUE number.
 * Public, but only when the contestant's association is confirmed, the photograph is approved and consented, the person has not asked
 * for it to be hidden and the candidature has not been withdrawn. That is a permission to SHOW a photograph; it does not depend on the
 * round being open and it never allows a vote. Anything else is 404. Cached for at most PUBLIC_PHOTO_CACHE_SECONDS: a copy already
 * fetched can outlive a hiding or a withdrawal by up to that long; discovery stops listing the contestant at once.
 */
export async function GET(request: Request, { params }: { params: { instanceId: string; alias: string } }) {
  return handle("READ_ROUND_PHOTO", request, async (env) => {
    const variant = new URL(request.url).searchParams.get("v");
    const photo = await getRoundPhoto(env.repo, params.instanceId, params.alias, variant);
    if (!photo) return json({ error: "No such photograph.", code: "PHOTO_NOT_FOUND" }, 404);
    const etag = `"${photo.sha256}"`;
    const headers = {
      "Content-Type": photo.contentType,
      "Cache-Control": `public, max-age=${PUBLIC_PHOTO_CACHE_SECONDS}, s-maxage=${PUBLIC_PHOTO_CACHE_SECONDS}`,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(photo.bytes), { status: 200, headers });
  });
}
