import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { testFinalGeofence } from "@/lib/gaming/communityVoting/rounds/operations";

/**
 * POST .../operator/geofence/test — evaluates ONE location reading { location: { latitude, longitude, accuracyMeters } } with the SAME evaluator the
 * final's vote uses, against the geofence stored for the Instance in the URL. It answers INSIDE, OUTSIDE, AMBIGUOUS or ACCURACY_EXCESSIVE with the
 * distance and the accuracy it saw and the thresholds it used. It casts no vote, takes no intent, binds nobody, and neither stores nor logs nor echoes
 * the reading. Operator only. Browser location is an eligibility signal, not proof against a spoofed position.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("TEST_FINAL_GEOFENCE", request, async (env) =>
    json({ test: await testFinalGeofence(env.repo, await operatorContext(env, params.instanceId), await readJson(request)) })
  );
}
