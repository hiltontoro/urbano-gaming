import { NextResponse } from "next/server";

import { SupabaseAuthUserVerifier } from "../../auth";
import { SupabaseGamingRepository } from "../../db/supabaseGamingRepository";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "../httpSupport";
import { CommunityVotingError } from "../types";
import { SupabaseEmailIdentityVerifier } from "./identity";
import { resolveOperatorCredentials, toOperatorContext } from "./operatorRequest";
import { SupabaseContestRepository } from "../contest/supabaseContestRepository";
import type { OperatorContext } from "./types";
import type { RoundVoterDeps } from "./voterOperations";

/** Shared glue of the contest's routes (the four-category contest runs on the pilot's rounds). Routes stay thin: header and body extraction, then one domain call. */

export interface RouteEnv {
  repo: SupabaseContestRepository;
  /** The voter-side dependencies: the repository, the email verifier and the Gaming Member repository. */
  voter: RoundVoterDeps;
  url: string;
  serviceKey: string;
  request: Request;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Resolves the server configuration, runs the handler, and turns ANY failure into a typed, payload-free response. */
export async function handle(label: string, request: Request, run: (env: RouteEnv) => Promise<Response>): Promise<Response> {
  const credentials = getSupabaseCredentials();
  if (!credentials) return json({ error: "Server misconfiguration: Supabase credentials not set.", code: "INTERNAL_ERROR" }, 500);
  try {
    const repo = new SupabaseContestRepository(credentials.url, credentials.serviceKey);
    return await run({
      repo,
      voter: {
        repo,
        emailVerifier: new SupabaseEmailIdentityVerifier(credentials.url, credentials.serviceKey),
        gamingRepo: new SupabaseGamingRepository(credentials.url, credentials.serviceKey),
      },
      url: credentials.url,
      serviceKey: credentials.serviceKey,
      request,
    });
  } catch (err) {
    const { status, body } = toHttpErrorResponse(err, label);
    return json(body, status);
  }
}

/** The request body as JSON, or INVALID_REQUEST. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CommunityVotingError("INVALID_REQUEST", "Request body must be valid JSON.");
  }
}

/** The operator context of a request: host token header AND a Gaming Member bearer. The database compares the member with the Instance's operator. */
export async function operatorContext(env: RouteEnv, instanceId: string): Promise<OperatorContext> {
  const credentials = await resolveOperatorCredentials(
    { gamingRepo: env.voter.gamingRepo, verifier: new SupabaseAuthUserVerifier(env.url, env.serviceKey) },
    env.request.headers.get("authorization"),
    env.request.headers.get("x-host-token")
  );
  return toOperatorContext(instanceId, credentials);
}

export { resolveOperatorCredentials };
