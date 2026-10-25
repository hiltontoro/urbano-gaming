/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { submitProgressivePrediction } from "../lib/gaming/predictions/submitPrediction";
import { computeLadderOffer } from "../lib/gaming/predictions/prizeLadder";
import { buildMemberParticipations } from "../lib/gaming/predictions/participations";
import { VenueActivationDisabledError } from "../lib/gaming/predictions/types";
import { GET as participationsGET } from "../app/api/gaming/predictions/participations/route";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * MY PARTICIPATIONS against a real LOCAL Supabase: real Auth tokens, real Postgres, the real route and the real atomic functions that
 * wrote the participations. Nothing is stubbed. It proves what the in-memory suite cannot: that a genuine token resolves to the right
 * member and that the database query itself is filtered to that member, that a session-less or profile-less caller gets nothing, and that
 * no geolocation evidence or identifier leaves in the answer. Writes go only to the local database the guard allows; everything is removed.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const repo = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, serviceKey);

const created = { authUsers: [] as string[], members: [] as string[], teams: [] as string[], venues: [] as string[], matches: [] as string[] };

async function tokenFor(email: string): Promise<string> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  // a client that verifies a code becomes that person: never the one that writes with the service key
  const verified = await createClient(supabaseUrl!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } }).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  if (!verified.data.session) throw new Error("verifyOtp returned no session.");
  return verified.data.session.access_token;
}

async function person(label: string, options: { member: boolean } = { member: true }) {
  const email = `participations-${label}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create the test auth user.");
  created.authUsers.push(data.user.id);
  let memberId: string | null = null;
  if (options.member) {
    const member = await gamingRepo.createGamingMember(data.user.id, `Participations-${label}-${randomUUID().slice(0, 6)}`);
    memberId = member.gamingMemberId;
    created.members.push(memberId);
  }
  return { memberId, header: { authorization: `Bearer ${await tokenFor(email)}` } };
}

const ask = (headers: Record<string, string> = {}, query = "") => participationsGET(new Request(`http://localhost/api/gaming/predictions/participations${query}`, { headers }));

let ana: Awaited<ReturnType<typeof person>>;
let beto: Awaited<ReturnType<typeof person>>;
let carla: Awaited<ReturnType<typeof person>>;
let matchId: string;
let venueName: string;
let activationId: string;
let offerDigest: string;
let actorId: string;
let homeTeamId: string;
let awayTeamId: string;
let venueId: string;
let scorerId: string;
const NEAR = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 7 };

/** A further match with its own activation and the full ladder, so one member can have several participations. */
async function addMatch(label: string) {
  const match = await repo.createMatch({ homeTeamId, awayTeamId, competition: `Participations contract ${label}`, kickoffAt: new Date(Date.now() + 3600_000).toISOString(), predictionContract: "PROGRESSIVE_LADDER_V1" });
  created.matches.push(match.matchId);
  await repo.setMatchActivityClassification(match.matchId, "TRAINING", actorId, "Participations contract.");
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId });
  for (const level of [1, 2, 3, 4]) await repo.createLadderPrizeTier({ venueActivationId: activation.venueActivationId, ladderLevel: level, prizeLabel: `Simulation L${level}` });
  const digest = computeLadderOffer(await repo.listPrizeTiersForActivation(activation.venueActivationId)).digest!;
  return { matchId: match.matchId, activationId: activation.venueActivationId, digest };
}

beforeAll(async () => {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;

  ana = await person("ana");
  beto = await person("beto");
  carla = await person("carla");

  // an actor who may declare the classification (the function requires a CONSEQUENTIAL_FINALIZER)
  const actor = await person("finalizer");
  actorId = actor.memberId!;
  const { data: governance } = await admin.from("authority_grants").select("gaming_member_id").eq("authority_class", "PRODUCT_GOVERNANCE").is("revoked_at", null).limit(1).maybeSingle();
  let governor = governance?.gaming_member_id as string | undefined;
  if (!governor) {
    await bootstrapGovernanceAuthority(authorityRepo, actor.memberId!, "Participations contract: bootstrap.");
    governor = actor.memberId!;
  }
  await grantPlatformAuthority(authorityRepo, governor, actor.memberId!, "CONSEQUENTIAL_FINALIZER", "Participations contract: classify the match.");

  const home = await repo.createTeam({ name: `Part Home ${randomUUID().slice(0, 6)}` });
  const away = await repo.createTeam({ name: `Part Away ${randomUUID().slice(0, 6)}` });
  created.teams.push(home.teamId, away.teamId);
  homeTeamId = home.teamId;
  awayTeamId = away.teamId;
  const player = await repo.createPlayer({ teamId: home.teamId, name: "Part Scorer" });
  scorerId = player.playerId;
  await repo.createPlayer({ teamId: away.teamId, name: "Part Rival" });
  venueName = `Part Venue ${randomUUID().slice(0, 6)}`;
  const venue = await repo.createVenue({ name: venueName, latitude: 10, longitude: 10, radiusMeters: 100 });
  created.venues.push(venue.venueId);
  venueId = venue.venueId;
  const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Participations contract", kickoffAt: new Date(Date.now() + 3600_000).toISOString(), predictionContract: "PROGRESSIVE_LADDER_V1" });
  matchId = match.matchId;
  created.matches.push(matchId);
  await repo.setMatchActivityClassification(matchId, "TRAINING", actor.memberId!, "Participations contract.");
  const activation = await repo.createVenueActivation({ matchId, venueId: venue.venueId });
  for (const level of [1, 2, 3, 4]) await repo.createLadderPrizeTier({ venueActivationId: activation.venueActivationId, ladderLevel: level, prizeLabel: `Simulation L${level}` });
  const digest = computeLadderOffer(await repo.listPrizeTiersForActivation(activation.venueActivationId)).digest;
  const geo = NEAR;
  activationId = activation.venueActivationId;
  offerDigest = digest!;

  await submitProgressivePrediction(repo, {
    matchId, gamingMemberId: ana.memberId!, venueActivationId: activation.venueActivationId, offerDigest: digest, geo,
    answers: { attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: player.playerId } },
  });
  await submitProgressivePrediction(repo, {
    matchId, gamingMemberId: beto.memberId!, venueActivationId: activation.venueActivationId, offerDigest: digest, geo,
    answers: { attemptedLevel: 1, scoreline: { home: 5, away: 5 } },
  });
  // Carla: five participations, in five matches
  for (let i = 0; i < 5; i += 1) {
    const extra = await addMatch(`carla ${i}`);
    await submitProgressivePrediction(repo, {
      matchId: extra.matchId, gamingMemberId: carla.memberId!, venueActivationId: extra.activationId, offerDigest: extra.digest, geo,
      answers: { attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: scorerId } },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}, 180_000);

afterAll(async () => {
  for (const id of created.matches) {
    await admin.from("predictions").delete().eq("match_id", id);
    const { data: activations } = await admin.from("venue_activations").select("venue_activation_id").eq("match_id", id);
    const ids = (activations ?? []).map((a) => a.venue_activation_id);
    if (ids.length > 0) await admin.from("prize_tiers").delete().in("venue_activation_id", ids);
    await admin.from("venue_activations").delete().eq("match_id", id);
    await admin.from("matches").delete().eq("match_id", id);
  }
  for (const id of created.venues) await admin.from("venues").delete().eq("venue_id", id);
  for (const id of created.teams) {
    await admin.from("players").delete().eq("team_id", id);
    await admin.from("teams").delete().eq("team_id", id);
  }
  if (created.members.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", created.members);
    await admin.from("authority_grants").delete().in("gaming_member_id", created.members);
    await admin.from("gaming_members").delete().in("gaming_member_id", created.members);
  }
  for (const id of created.authUsers) await admin.auth.admin.deleteUser(id);
}, 120_000);

describe("real tokens, real database", () => {
  it("each member sees only their own participation, with its own level and answers", async () => {
    const forAna = (await (await ask(ana.header)).json()) as { participations: any[] };
    const forBeto = (await (await ask(beto.header)).json()) as { participations: any[] };
    expect(forAna.participations).toHaveLength(1);
    expect(forAna.participations[0]).toMatchObject({ attemptedLevel: 3, venueName, state: "OPEN", editable: true, evaluation: { evaluated: false } });
    expect(forAna.participations[0].answers.scoreline).toEqual({ home: 2, away: 1 });
    expect(forAna.participations[0].answers.goalscorer).toEqual({ kind: "PICKED", playerName: "Part Scorer", jerseyNumber: null }); // added by hand: no squad number, with or without the roster columns
    expect(forBeto.participations).toHaveLength(1);
    expect(forBeto.participations[0].attemptedLevel).toBe(1);
    expect(forBeto.participations[0].answers.scoreline).toEqual({ home: 5, away: 5 });
  });

  it("the database query itself is filtered to the member: the repository never hands back another member's row, whatever the layer above does", async () => {
    const rows = await repo.listPredictionsForMember(ana.memberId!);
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.gamingMemberId === ana.memberId)).toBe(true);
    const betoRows = await repo.listPredictionsForMember(beto.memberId!);
    expect(betoRows).toHaveLength(1);
    expect(betoRows[0].gamingMemberId).toBe(beto.memberId);
    expect(await repo.listPredictionsForMember(randomUUID())).toEqual([]);
  });

  it("an identifier in the request is not an identity: the signed-in member's own history comes back whatever is asked for", async () => {
    const spoofed = (await (await ask(ana.header, `?gamingMemberId=${beto.memberId}&memberId=${beto.memberId}`)).json()) as { participations: any[] };
    expect(spoofed.participations).toHaveLength(1);
    expect(spoofed.participations[0].attemptedLevel).toBe(3);
  });

  it("no session, an unknown token, and a verified identity with no finished profile all get 401 and nothing", async () => {
    const unfinished = await person("unfinished", { member: false });
    for (const headers of [{}, { authorization: "Bearer not-a-real-token" }, { authorization: "Basic abc" }, unfinished.header]) {
      const response = await ask(headers);
      expect(response.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(await response.json()).toEqual({ error: "A valid Authorization header for an authenticated Gaming Member is required." });
    }
  });

  it("the answer carries no coordinates, distance, accuracy, fingerprint or identifier, and is not cacheable", async () => {
    const response = await ask(ana.header);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    for (const forbidden of ["latitude", "longitude", "measuredDistance", "reportedAccuracy", "geoVerifiedAt", "geoEligible", "acceptedOffer", "predictionId", "gamingMemberId", "venueActivationId", "digest"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toContain(ana.memberId!);
    expect(text).not.toContain(beto.memberId!);
  });

  it("a member with no participation gets an empty list", async () => {
    const empty = await person("empty");
    expect(await (await ask(empty.header)).json()).toEqual({ participations: [], limit: 50, truncated: false });
  });
});

describe("batch reads, constant cost, the limit and the admission restrictions — against the real database", () => {
  /** Counts every request the repository makes to PostgREST while `run` executes (a fresh client is built so the counter sees it). */
  async function countingRequests<T>(run: (counted: SupabasePredictionsRepository) => Promise<T>): Promise<{ result: T; requests: number; tables: string[] }> {
    const real = globalThis.fetch;
    const tables: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const address = String(typeof input === "string" ? input : input.url);
      const match = address.match(/\/rest\/v1\/(?:rpc\/)?([a-z_]+)/);
      if (match) tables.push(match[1]!);
      return real(input, init);
    }) as typeof fetch;
    try {
      const result = await run(new SupabasePredictionsRepository(supabaseUrl!, serviceKey!));
      return { result, requests: tables.length, tables };
    } finally {
      globalThis.fetch = real;
    }
  }

  it("each batch read returns exactly what the single reads return, and nothing for ids that do not exist", async () => {
    const [prediction] = await repo.listPredictionsForMember(ana.memberId!);
    const match = (await repo.getMatchById(prediction!.matchId))!;
    const activation = (await repo.getVenueActivationById(prediction!.venueActivationId))!;
    expect(await repo.getMatchesByIds([match.matchId, match.matchId, randomUUID()])).toEqual([match]);
    expect(await repo.getTeamsByIds([match.homeTeamId, match.awayTeamId])).toHaveLength(2);
    expect(await repo.getTeamsByIds([match.homeTeamId])).toEqual([(await repo.getTeamById(match.homeTeamId))!]);
    expect(await repo.getVenueActivationsByIds([activation.venueActivationId])).toEqual([activation]);
    expect(await repo.getVenuesByIds([activation.venueId])).toEqual([(await repo.getVenueById(activation.venueId))!]);
    expect(await repo.getPlayersByIds([scorerId])).toEqual([(await repo.getPlayerById(scorerId))!]);
    const tiers = await repo.listPrizeTiersForActivations([activation.venueActivationId]);
    expect(tiers.map((tier) => tier.ladderLevel).sort()).toEqual([1, 2, 3, 4]);
    expect(await repo.getCurrentEvaluationsForPredictions([prediction!.predictionId])).toEqual([]); // nothing evaluated here
    for (const empty of [() => repo.getMatchesByIds([]), () => repo.getTeamsByIds([]), () => repo.getPlayersByIds([]), () => repo.getVenueActivationsByIds([]), () => repo.getVenuesByIds([]), () => repo.listPrizeTiersForActivations([]), () => repo.getCurrentEvaluationsForPredictions([])]) {
      expect(await empty()).toEqual([]);
    }
  });

  it("1 participation and 5 cost the same number of requests (one per kind), and a long list of ids is split, not refused", async () => {
    // Ana and Carla both picked a goalscorer, so both need the same eight kinds of request; Beto picked none and so does not ask for players.
    const one = await countingRequests((counted) => buildMemberParticipations(counted, ana.memberId!));
    const five = await countingRequests((counted) => buildMemberParticipations(counted, carla.memberId!));
    const noScorer = await countingRequests((counted) => buildMemberParticipations(counted, beto.memberId!));
    expect(one.result.participations).toHaveLength(1);
    expect(five.result.participations).toHaveLength(5);
    expect(five.requests).toBe(one.requests);
    expect(one.requests).toBeLessThanOrEqual(8);
    expect(noScorer.tables).not.toContain("players");
    expect(noScorer.requests).toBe(one.requests - 1);
    expect(new Set(five.tables).size).toBe(five.tables.length); // one request per table, never one per record
    // 230 ids (more than one request's worth): still answered, in a few requests, with the records that exist
    const many = await countingRequests((counted) => counted.getMatchesByIds([...Array.from({ length: 229 }, () => randomUUID()), matchId]));
    expect(many.result.map((record) => record.matchId)).toEqual([matchId]);
    expect(many.requests).toBe(3);
  });

  it("the history says whether there are older participations: 5 stored, shown 3, 4 and 5", async () => {
    const at = async (limit: number) => buildMemberParticipations(repo, carla.memberId!, new Date(), limit);
    expect(await at(3)).toMatchObject({ limit: 3, truncated: true });
    expect((await at(3)).participations).toHaveLength(3);
    expect(await at(4)).toMatchObject({ limit: 4, truncated: true });
    expect(await at(5)).toMatchObject({ limit: 5, truncated: false });
    expect((await at(5)).participations).toHaveLength(5);
    expect(await buildMemberParticipations(repo, carla.memberId!)).toMatchObject({ limit: 50, truncated: false });
  });

  it("a DISABLED venue activation: not editable, with its reason; an identical resend is still answered with the stored row; a changed answer is refused", async () => {
    const answers = { attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED" as const, team: "HOME" as const }, goalscorer: { kind: "PICKED" as const, playerId: scorerId } };
    const request = (over: Record<string, unknown> = {}) => ({ matchId, gamingMemberId: ana.memberId!, venueActivationId: activationId, offerDigest, geo: NEAR, answers, ...over });
    const [before] = await repo.listPredictionsForMember(ana.memberId!);
    const wasEnabled = (await buildMemberParticipations(repo, ana.memberId!)).participations[0]!;
    expect(wasEnabled).toMatchObject({ editable: true, editBlockedReason: null });
    await repo.setVenueActivationEnabled(activationId, false);
    try {
      const view = (await buildMemberParticipations(repo, ana.memberId!)).participations[0]!;
      expect(view).toMatchObject({ state: "OPEN", editable: false, editBlockedReason: "ACTIVATION_DISABLED" });
      const replay = await submitProgressivePrediction(repo, request());
      expect(replay.predictionId).toBe(before!.predictionId);
      expect(replay.updatedAt).toBe(before!.updatedAt); // nothing was written
      await expect(submitProgressivePrediction(repo, request({ answers: { ...answers, scoreline: { home: 3, away: 1 } } }))).rejects.toBeInstanceOf(VenueActivationDisabledError);
      expect((await repo.listPredictionsForMember(ana.memberId!))[0]!.updatedAt).toBe(before!.updatedAt);
      // and over HTTP's own route function the history says the same
      const body = (await (await ask(ana.header)).json()) as { participations: any[]; limit: number; truncated: boolean };
      expect(body).toMatchObject({ limit: 50, truncated: false });
      expect(body.participations[0]).toMatchObject({ editable: false, editBlockedReason: "ACTIVATION_DISABLED" });
    } finally {
      await repo.setVenueActivationEnabled(activationId, true);
    }
    expect((await buildMemberParticipations(repo, ana.memberId!)).participations[0]).toMatchObject({ editable: true, editBlockedReason: null });
  });
});
