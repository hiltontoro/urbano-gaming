/// <reference types="vite/client" />
import { createHash, randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { SupabaseLegalAcceptanceRepository } from "../lib/gaming/legal/db/supabaseLegalAcceptanceRepository";
import { LegalAcceptanceHashConflictError } from "../lib/gaming/legal/types";
import { computeLadderOffer } from "../lib/gaming/predictions/prizeLadder";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { fixtureRegistry, fixtureRegistryWithNewVersion } from "./helpers/legalFixtures";

// Only the registry is stood in for (the real one ships empty); the legal repository, the members, the matches and the routes are the real ones.
vi.mock("@/lib/gaming/legal/httpLegal", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/legal/httpLegal")>("../lib/gaming/legal/httpLegal");
  return { ...actual, currentLegalRegistry: vi.fn() };
});
import * as httpLegal from "../lib/gaming/legal/httpLegal";
import { POST as acceptancesPOST, GET as acceptancesGET } from "../app/api/gaming/legal/acceptances/route";
import { POST as predictPOST } from "../app/api/gaming/predictions/matches/[matchId]/predict/route";

/**
 * THE ACCEPTANCE RECORD against a real LOCAL Supabase: the table's own constraints, the single writer function under concurrency, the
 * privileges, and the routes and the admission gate with real Auth tokens. Nothing about the database is stubbed. Everything written
 * here is for invented test members on the disposable local database the guard allows, and is removed afterwards.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const predictions = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, serviceKey);
const legal = new SupabaseLegalAcceptanceRepository(supabaseUrl, serviceKey);

const created = { authUsers: [] as string[], members: [] as string[], teams: [] as string[], venues: [] as string[], matches: [] as string[] };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const NEAR = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 7 };

async function tokenFor(email: string): Promise<string> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  const verified = await createClient(supabaseUrl!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } }).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  if (!verified.data.session) throw new Error("verifyOtp returned no session.");
  return verified.data.session.access_token;
}

async function person(label: string) {
  const email = `legal-${label}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create the test auth user.");
  created.authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `Legal-${label}-${randomUUID().slice(0, 6)}`);
  created.members.push(member.gamingMemberId);
  const token = await tokenFor(email);
  return { memberId: member.gamingMemberId, token, header: { authorization: `Bearer ${token}` } };
}
type Person = Awaited<ReturnType<typeof person>>;

let ana: Person;
let beto: Person;
let carla: Person;
let actorId: string;
let matchId: string;
let otherMatchId: string;
let kickoffAt: string;
let activationId: string;
let offerDigest: string;
let registry: ReturnType<typeof fixtureRegistry>;

const base = (memberId: string, over: Record<string, unknown> = {}) => ({
  gaming_member_id: memberId,
  document_key: "ACCOUNT_TERMS",
  document_version: "v-" + randomUUID().slice(0, 6),
  content_sha256: sha(randomUUID()),
  act_type: "ACCEPTANCE",
  scope_match_id: null,
  age_declared_18: null,
  locale: "es",
  source: "PRE_PARTICIPATION",
  ...over,
});

const postAcceptances = (person: Person, body: unknown) =>
  acceptancesPOST(new Request("http://localhost/api/gaming/legal/acceptances", { method: "POST", headers: { ...person.header, "content-type": "application/json" }, body: JSON.stringify(body) }));
const getAcceptances = (headers: Record<string, string>, query = "") => acceptancesGET(new Request(`http://localhost/api/gaming/legal/acceptances${query}`, { headers }));
const allOf = (reg = registry) =>
  reg.map((e) => ({ documentKey: e.key, documentVersion: e.version, contentSha256: e.sha256, ...(e.key === "EVENT_RULES" ? { ageDeclared18: true } : {}) }));
const sendPrediction = async (person: Person, home = 1) => {
  const res = await predictPOST(
    new Request(`http://localhost/api/gaming/predictions/matches/${matchId}/predict`, {
      method: "POST",
      headers: { ...person.header, "content-type": "application/json" },
      body: JSON.stringify({ venueActivationId: activationId, offerDigest, attemptedLevel: 1, scoreline: { home, away: 0 }, ...NEAR }),
    }),
    { params: { matchId } }
  );
  return { status: res.status, body: (await res.json()) as any };
};
const rowsOf = async (memberId: string) => (await admin.from("legal_acceptances").select("*").eq("gaming_member_id", memberId)).data ?? [];

beforeAll(async () => {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  ana = await person("ana");
  beto = await person("beto");
  carla = await person("carla");
  const actor = await person("finalizer");
  actorId = actor.memberId;
  const { data: governance } = await admin.from("authority_grants").select("gaming_member_id").eq("authority_class", "PRODUCT_GOVERNANCE").is("revoked_at", null).limit(1).maybeSingle();
  let governor = governance?.gaming_member_id as string | undefined;
  if (!governor) {
    await bootstrapGovernanceAuthority(authorityRepo, actorId, "Legal contract: bootstrap.");
    governor = actorId;
  }
  await grantPlatformAuthority(authorityRepo, governor, actorId, "CONSEQUENTIAL_FINALIZER", "Legal contract: classify the match.");

  const home = await predictions.createTeam({ name: `Legal Home ${randomUUID().slice(0, 6)}` });
  const away = await predictions.createTeam({ name: `Legal Away ${randomUUID().slice(0, 6)}` });
  created.teams.push(home.teamId, away.teamId);
  await predictions.createPlayer({ teamId: home.teamId, name: "Legal Scorer" });
  await predictions.createPlayer({ teamId: away.teamId, name: "Legal Rival" });
  const venue = await predictions.createVenue({ name: `Legal Venue ${randomUUID().slice(0, 6)}`, latitude: 10, longitude: 10, radiusMeters: 100 });
  created.venues.push(venue.venueId);
  kickoffAt = new Date(Date.now() + 3600_000).toISOString();
  const match = await predictions.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Legal contract", kickoffAt, predictionContract: "PROGRESSIVE_LADDER_V1" });
  matchId = match.matchId;
  created.matches.push(matchId);
  await predictions.setMatchActivityClassification(matchId, "TRAINING", actorId, "Legal contract.");
  const activation = await predictions.createVenueActivation({ matchId, venueId: venue.venueId });
  activationId = activation.venueActivationId;
  for (const level of [1, 2, 3, 4]) await predictions.createLadderPrizeTier({ venueActivationId: activationId, ladderLevel: level, prizeLabel: `Simulation L${level}` });
  offerDigest = computeLadderOffer(await predictions.listPrizeTiersForActivation(activationId)).digest!;
  // another match starting at the same instant: the rules are accepted per match
  const other = await predictions.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Legal contract (other)", kickoffAt, predictionContract: "PROGRESSIVE_LADDER_V1" });
  otherMatchId = other.matchId;
  created.matches.push(otherMatchId);
  registry = fixtureRegistry(kickoffAt);
  vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
}, 180_000);

afterAll(async () => {
  if (created.members.length > 0) await admin.from("legal_acceptances").delete().in("gaming_member_id", created.members);
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

describe("the table refuses what the domain would never write", () => {
  it("a global document (scope NULL) cannot be recorded twice for the same member and version — the case a plain UNIQUE lets through", async () => {
    const row = base(ana.memberId, { document_key: "PRIVACY_NOTICE", act_type: "READ_ACKNOWLEDGMENT", document_version: "dup-global" });
    expect((await admin.from("legal_acceptances").insert(row)).error).toBeNull();
    const second = await admin.from("legal_acceptances").insert(row);
    expect(second.error?.code).toBe("23505");
    expect(second.error?.message).toContain("legal_acceptances_global_unique");
    // not even with a different hash: the version is the identity
    expect((await admin.from("legal_acceptances").insert({ ...row, content_sha256: sha("other") })).error?.code).toBe("23505");
  });

  it("an event-rules acceptance cannot be recorded twice for the same match, but can for another match or another member", async () => {
    const row = base(ana.memberId, { document_key: "EVENT_RULES", scope_match_id: matchId, age_declared_18: true, document_version: "dup-scoped" });
    expect((await admin.from("legal_acceptances").insert(row)).error).toBeNull();
    const again = await admin.from("legal_acceptances").insert(row);
    expect(again.error?.code).toBe("23505");
    expect(again.error?.message).toContain("legal_acceptances_scoped_unique");
    expect((await admin.from("legal_acceptances").insert({ ...row, scope_match_id: otherMatchId })).error).toBeNull();
    expect((await admin.from("legal_acceptances").insert({ ...row, gaming_member_id: beto.memberId })).error).toBeNull();
  });

  it("refuses every malformed row (23514): unknown document or act, the wrong act for a document, a scope on the wrong document, a missing age declaration, a bad hash, version, language or source", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["unknown document", { document_key: "MARKETING", act_type: "ACCEPTANCE" }],
      ["unknown act", { act_type: "CONSENT" }],
      ["privacy notice recorded as an acceptance", { document_key: "PRIVACY_NOTICE", act_type: "ACCEPTANCE" }],
      ["terms recorded as a read acknowledgment", { document_key: "ACCOUNT_TERMS", act_type: "READ_ACKNOWLEDGMENT" }],
      ["event rules without a match", { document_key: "EVENT_RULES", scope_match_id: null, age_declared_18: true }],
      ["terms with a match", { document_key: "ACCOUNT_TERMS", scope_match_id: matchId }],
      ["event rules without the age declaration", { document_key: "EVENT_RULES", scope_match_id: matchId, age_declared_18: null }],
      ["event rules with the age declaration false", { document_key: "EVENT_RULES", scope_match_id: matchId, age_declared_18: false }],
      ["terms with an age declaration", { document_key: "ACCOUNT_TERMS", age_declared_18: true }],
      ["a hash of the wrong shape", { content_sha256: "ABC" }],
      ["an upper-case hash", { content_sha256: sha("x").toUpperCase() }],
      ["a version with edge spaces", { document_version: " v1" }],
      ["an empty version", { document_version: "" }],
      ["a language that is not offered", { locale: "fr" }],
      ["a source that does not exist", { source: "PROFILE" }],
    ];
    for (const [label, over] of bad) {
      const result = await admin.from("legal_acceptances").insert(base(carla.memberId, over));
      expect(result.error?.code, label).toBe("23514");
    }
    expect(await rowsOf(carla.memberId)).toEqual([]);
  });

  it("belongs to a real member and a real match (23503)", async () => {
    expect((await admin.from("legal_acceptances").insert(base(randomUUID()))).error?.code).toBe("23503");
    expect((await admin.from("legal_acceptances").insert(base(carla.memberId, { document_key: "EVENT_RULES", scope_match_id: randomUUID(), age_declared_18: true }))).error?.code).toBe("23503");
  });

  it("is never updated: any UPDATE is refused, even by the service role", async () => {
    const row = base(carla.memberId, { document_version: "immutable" });
    expect((await admin.from("legal_acceptances").insert(row)).error).toBeNull();
    const update = await admin.from("legal_acceptances").update({ locale: "en" }).eq("gaming_member_id", carla.memberId).eq("document_version", "immutable");
    expect(update.error?.message).toContain("LEGAL_ACCEPTANCE_IMMUTABLE");
    const after = await admin.from("legal_acceptances").select("locale").eq("gaming_member_id", carla.memberId).eq("document_version", "immutable").single();
    expect(after.data!.locale).toBe("es");
  });
});

describe("the single writer, under repeats and concurrency", () => {
  const input = (memberId: string, over: Record<string, unknown> = {}) => ({
    gamingMemberId: memberId,
    documentKey: "ACCOUNT_TERMS" as const,
    documentVersion: "w-" + randomUUID().slice(0, 6),
    contentSha256: sha(randomUUID()),
    actType: "ACCEPTANCE" as const,
    scopeMatchId: null,
    ageDeclared18: null,
    locale: "es" as const,
    source: "PRE_PARTICIPATION" as const,
    ...over,
  });

  it("records once and answers the same row on a repeat, saying which was which", async () => {
    const i = input(beto.memberId);
    const first = await legal.recordAcceptance(i);
    const second = await legal.recordAcceptance(i);
    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.record.legalAcceptanceId).toBe(first.record.legalAcceptanceId);
    expect(second.record.acceptedAt).toBe(first.record.acceptedAt);
    expect((await rowsOf(beto.memberId)).filter((r) => r.document_version === i.documentVersion)).toHaveLength(1);
  });

  it("refuses to record a version again for a different text", async () => {
    const i = input(beto.memberId);
    await legal.recordAcceptance(i);
    await expect(legal.recordAcceptance({ ...i, contentSha256: sha("another text") })).rejects.toBeInstanceOf(LegalAcceptanceHashConflictError);
    expect((await rowsOf(beto.memberId)).filter((r) => r.document_version === i.documentVersion)).toHaveLength(1);
  });

  it("40 requests at the same moment for a GLOBAL document (scope NULL) end in exactly one row, and exactly one of them was the one that recorded", async () => {
    const i = input(carla.memberId);
    const results = await Promise.all(Array.from({ length: 40 }, () => legal.recordAcceptance(i)));
    expect(results.filter((r) => !r.alreadyRecorded)).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.legalAcceptanceId)).size).toBe(1);
    expect((await rowsOf(carla.memberId)).filter((r) => r.document_version === i.documentVersion)).toHaveLength(1);
  });

  it("40 requests at the same moment for an EVENT document (scope = the match) end in exactly one row", async () => {
    const i = input(carla.memberId, { documentKey: "EVENT_RULES", scopeMatchId: matchId, ageDeclared18: true });
    const results = await Promise.all(Array.from({ length: 40 }, () => legal.recordAcceptance(i)));
    expect(results.filter((r) => !r.alreadyRecorded)).toHaveLength(1);
    expect((await rowsOf(carla.memberId)).filter((r) => r.document_version === i.documentVersion)).toHaveLength(1);
  });

  it("a mix of members, documents and scopes at the same moment writes each distinct act once and never crosses them", async () => {
    const version = "mix-" + randomUUID().slice(0, 6);
    const members = [ana, beto, carla];
    const tasks = members.flatMap((m) =>
      Array.from({ length: 12 }, () => legal.recordAcceptance(input(m.memberId, { documentVersion: version, contentSha256: sha(version) })))
    );
    const results = await Promise.all(tasks);
    expect(results.filter((r) => !r.alreadyRecorded)).toHaveLength(3);
    for (const m of members) expect((await rowsOf(m.memberId)).filter((r) => r.document_version === version)).toHaveLength(1);
  });

  it("lists a member's own rows: the global ones and the matching event's, never another match's", async () => {
    const version = "list-" + randomUUID().slice(0, 6);
    await legal.recordAcceptance(input(ana.memberId, { documentVersion: version, contentSha256: sha(version) }));
    await legal.recordAcceptance(input(ana.memberId, { documentKey: "EVENT_RULES", documentVersion: version, contentSha256: sha(version), scopeMatchId: matchId, ageDeclared18: true }));
    await legal.recordAcceptance(input(ana.memberId, { documentKey: "EVENT_RULES", documentVersion: version, contentSha256: sha(version), scopeMatchId: otherMatchId, ageDeclared18: true }));
    const forMatch = (await legal.listForMember(ana.memberId, matchId)).filter((r) => r.documentVersion === version);
    expect(forMatch.map((r) => r.scopeMatchId).sort()).toEqual([null, matchId].sort());
    const all = (await legal.listForMember(ana.memberId)).filter((r) => r.documentVersion === version);
    expect(all).toHaveLength(3);
    expect((await legal.listForMember(beto.memberId)).some((r) => r.documentVersion === version)).toBe(false);
    await expect(legal.listForMember(ana.memberId, "x,scope_match_id.not.is.null")).rejects.toThrow("uuid");
  });
});

describe("privileges: the browser's roles reach nothing", () => {
  it("neither an anonymous visitor nor a signed-in member can read, write or call the writer", async () => {
    const anon = createClient(supabaseUrl!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const member = createClient(supabaseUrl!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${ana.token}` } } });
    for (const [label, client] of [["anonymous", anon], ["signed in", member]] as const) {
      const read = await client.from("legal_acceptances").select("*");
      expect(read.error?.code, `${label} read`).toBe("42501");
      expect(read.data ?? []).toEqual([]);
      expect((await client.from("legal_acceptances").insert(base(ana.memberId))).error?.code, `${label} insert`).toBe("42501");
      const call = await client.rpc("record_legal_acceptance", {
        p_gaming_member_id: ana.memberId, p_document_key: "ACCOUNT_TERMS", p_document_version: "browser", p_content_sha256: sha("browser"),
        p_act_type: "ACCEPTANCE", p_scope_match_id: null, p_age_declared_18: null, p_locale: "es", p_source: "PRE_PARTICIPATION",
      });
      expect(call.error?.code, `${label} rpc`).toBe("42501");
    }
    expect((await rowsOf(ana.memberId)).some((r) => r.document_version === "browser")).toBe(false);
  });
});

describe("the routes, with real tokens", () => {
  it("answer 401 without a session or with a token that is not valid, and write nothing", async () => {
    expect((await getAcceptances({}, `?matchId=${matchId}`)).status).toBe(401);
    expect((await getAcceptances({ authorization: "Bearer not.a.token" }, `?matchId=${matchId}`)).status).toBe(401);
    expect((await acceptancesPOST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(401);
    const before = await rowsOf(ana.memberId);
    expect((await acceptancesPOST(new Request("http://localhost/x", { method: "POST", headers: { authorization: "Bearer not.a.token", "content-type": "application/json" }, body: JSON.stringify({ matchId, acceptances: allOf() }) }))).status).toBe(401);
    expect(await rowsOf(ana.memberId)).toEqual(before);
  });

  it("record the caller's acts only, and what ana did is invisible to beto", async () => {
    const own = registry.map((e) => e.version);
    expect(own).toEqual(["fixture-1", "fixture-1", "fixture-1"]);
    const res = await postAcceptances(ana, { matchId, acceptances: allOf() });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ recorded: 3, satisfied: true });
    const fixtureRows = (await rowsOf(ana.memberId)).filter((r) => r.document_version === "fixture-1");
    expect(fixtureRows.map((r) => r.document_key).sort()).toEqual(["ACCOUNT_TERMS", "EVENT_RULES", "PRIVACY_NOTICE"]);
    expect(fixtureRows.find((r) => r.document_key === "EVENT_RULES")).toMatchObject({ scope_match_id: matchId, age_declared_18: true, act_type: "ACCEPTANCE" });
    expect(fixtureRows.find((r) => r.document_key === "PRIVACY_NOTICE")).toMatchObject({ scope_match_id: null, age_declared_18: null, act_type: "READ_ACKNOWLEDGMENT" });
    const forBeto = await (await getAcceptances(beto.header, `?matchId=${matchId}`)).json();
    expect(forBeto.satisfied).toBe(false);
    expect((await rowsOf(beto.memberId)).filter((r) => r.document_version === "fixture-1")).toEqual([]);
    const forAna = await (await getAcceptances(ana.header, `?matchId=${matchId}`)).json();
    expect(forAna.satisfied).toBe(true);
    // the rules were accepted for this match only; the other match still needs them
    const forOther = await (await getAcceptances(ana.header, `?matchId=${otherMatchId}`)).json();
    expect(forOther.documents.filter((d: any) => d.accepted).map((d: any) => d.key)).toEqual(["ACCOUNT_TERMS", "PRIVACY_NOTICE"]);
  });

  it("25 parallel identical requests from one member write each act once (the HTTP twin of the writer test)", async () => {
    const responses = await Promise.all(Array.from({ length: 25 }, () => postAcceptances(beto, { matchId, acceptances: allOf() })));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(bodies.reduce((n: number, b: any) => n + b.recorded, 0)).toBe(3);
    expect((await rowsOf(beto.memberId)).filter((r) => r.document_version === "fixture-1")).toHaveLength(3);
    // and a retry afterwards changes nothing
    const retry = await postAcceptances(beto, { matchId, acceptances: allOf() });
    expect(retry.status).toBe(200);
    expect((await rowsOf(beto.memberId)).filter((r) => r.document_version === "fixture-1")).toHaveLength(3);
  });

  it("refuse a stale text or a missing age declaration, and with nothing published accept nothing", async () => {
    const stale = await postAcceptances(carla, { matchId, acceptances: allOf().map((a) => (a.documentKey === "ACCOUNT_TERMS" ? { ...a, contentSha256: sha("old") } : a)) });
    expect(stale.status).toBe(409);
    expect((await postAcceptances(carla, { matchId, acceptances: allOf().map(({ ageDeclared18, ...rest }) => rest) })).status).toBe(400);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const none = await postAcceptances(carla, { matchId, acceptances: allOf(registry) });
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("LEGAL_DOCUMENTS_NOT_PUBLISHED");
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
    expect((await rowsOf(carla.memberId)).filter((r) => r.document_version === "fixture-1")).toEqual([]);
  });
});

describe("the whole path, at the door of the real predict route and a real database", () => {
  it("nobody is admitted while the registry is empty; with texts published, a member without the conditions is refused; once accepted, admitted", async () => {
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const unpublished = await sendPrediction(carla);
    expect(unpublished.status).toBe(409);
    expect(unpublished.body.code).toBe("LEGAL_DOCUMENTS_NOT_PUBLISHED");
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
    const required = await sendPrediction(carla);
    expect(required.status).toBe(409);
    expect(required.body.code).toBe("LEGAL_CONDITIONS_REQUIRED");
    expect(await predictions.getPredictionForMember(matchId, carla.memberId)).toBeNull();
    expect((await postAcceptances(carla, { matchId, acceptances: allOf() })).status).toBe(201);
    const admitted = await sendPrediction(carla);
    expect(admitted.status).toBe(201);
    expect((await predictions.getPredictionForMember(matchId, carla.memberId))!.predictedHomeScore).toBe(1);
  });

  it("isolation at the door: ana's acceptance admits ana and nobody else; the other match still needs its own rules", async () => {
    expect((await sendPrediction(ana)).status).toBe(201);
    const outsider = await person("outsider");
    expect((await sendPrediction(outsider)).status).toBe(409);
    expect(await predictions.getPredictionForMember(matchId, outsider.memberId)).toBeNull();
  });

  it("an exact replay of an existing participation passes even when the registry is emptied; a real edit does not until the new version is accepted", async () => {
    const stored = await predictions.getPredictionForMember(matchId, ana.memberId);
    expect(stored).not.toBeNull();
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const replay = await sendPrediction(ana, 1);
    expect(replay.status).toBe(201);
    expect(await predictions.getPredictionForMember(matchId, ana.memberId)).toEqual(stored);

    const v2 = fixtureRegistryWithNewVersion(kickoffAt);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(v2);
    expect((await sendPrediction(ana, 1)).status).toBe(201); // still a replay
    const edit = await sendPrediction(ana, 2);
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("LEGAL_CONDITIONS_REQUIRED");
    expect(edit.body.missing.every((m: any) => m.documentVersion === "fixture-2")).toBe(true);
    expect((await predictions.getPredictionForMember(matchId, ana.memberId))!.predictedHomeScore).toBe(1);

    expect((await postAcceptances(ana, { matchId, acceptances: allOf(v2.filter((e) => e.current)) })).status).toBe(201);
    expect((await sendPrediction(ana, 2)).status).toBe(201);
    expect((await predictions.getPredictionForMember(matchId, ana.memberId))!.predictedHomeScore).toBe(2);
    // v1 evidence is still there beside v2
    const versions = new Set((await rowsOf(ana.memberId)).map((r) => r.document_version));
    expect(versions.has("fixture-1") && versions.has("fixture-2")).toBe(true);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
  });
});
