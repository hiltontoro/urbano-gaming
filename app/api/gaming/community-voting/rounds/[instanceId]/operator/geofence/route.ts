import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { configureFinalGeofence } from "@/lib/gaming/communityVoting/rounds/operations";

/**
 * PUT .../operator/geofence — saves the FINAL's venue geofence. Body { venue: { venueLatitude, venueLongitude, venueRadiusMeters, maxAccuracyMeters,
 * insideMarginFactor, outsideMarginFactor } }; nothing else of the body is read. Operator only (bearer AND host token), applied to the Instance in
 * the URL only, to a final only, and only until the final has ever opened: the database serializes the save with the opening and refuses it
 * afterwards (409 GEOFENCE_FROZEN). The save is recorded in the operator's audit trail with the old and the new values.
 */
export async function PUT(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CONFIGURE_FINAL_GEOFENCE", request, async (env) =>
    json({ geofence: await configureFinalGeofence(env.repo, await operatorContext(env, params.instanceId), await readJson(request)) })
  );
}
