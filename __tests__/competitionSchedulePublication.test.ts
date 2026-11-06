import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks the ONE module boundary between a route and the outside world (credentials, repository construction, caller identity), exactly as
// competitions.test.ts, competitionDraw.test.ts and competitionScheduleProposal.test.ts do; statusForCompetitionsError and the schema-ready guard keep their REAL implementation.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

import * as httpAuth from "../lib/gaming/competitions/httpAuth";
import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SOCCER_FORMAT_KEYS } from "../lib/gaming/competitions/formats";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "../lib/gaming/competitions/types";
import type { SchedulePublicationFixtureRecord, SchedulePublicationRecord } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-025 — the atomic schedule publication, application side.
 *
 * Every DECISION (who may publish, the replay, the lifecycle, the freeze, the permanent draw, a pending plan change, the latest and CURRENT proposal, the reproduction of the
 * proposal's evidence, every scheduling rule again at the publication instant, the three fixtures, the publication resolution and the single state transition) is made inside the
 * one atomic database operation and is proved against a real database in competitionSchedulePublicationSupabase.contract.test.ts. This file proves what the application adds on
 * top and that it adds nothing it should not: the strict request allowlist (exactly one field, or exactly the seven legacy fields, never both and never anything else), the
 * digest of a publication — against an INDEPENDENT oracle (oracle_publication.py: Python hashlib, written from the gate's text, not this code) — and the reproduction of a
 * publication from its own evidence, the typed refusals with their stable codes, the bounded shapes a browser is shown, the route for both request shapes, the repository
 * adapter, and the static facts about the surface (no clock, no randomness, one append-only migration, the legacy guard in the database).
 *
 * The modules under test are loaded lazily so that, before they exist, every test here fails for the behavior it is missing and not because the file could not be collected.
 */

const loadSp = () => import("../lib/gaming/competitions/schedulePublication");
const ROUTE = "../app/api/gaming/competitions/[competitionId]/publish/route";
type Ctx = { params: { competitionId: string } };
type Handler = (request: Request, context: Ctx) => Promise<Response>;
const loadRoute = () => import(/* @vite-ignore */ ROUTE) as Promise<Record<string, Handler | undefined>>;

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The independent known answers (oracle_publication.py)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CID = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const DRAW = "55555555-5555-4555-8555-555555555555";
const ORGANIZER = "66666666-6666-4666-8666-666666666666";
const STRANGER = "77777777-7777-4777-8777-777777777777";
const PROPOSAL_DIGEST = sha("proposal-two"); // 96ed3d0a9a7889ee20ee0e5fd144be67c68b880ffe701e8e8547f7a9c72b334a
const DRAW_DIGEST = sha("draw"); // 50f7becde477bb509c7704de62c349247fb3499c03a95e4bce20151cd552dea5
const F = { sf1: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a101", sf2: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a202", fin: "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a303" };
const T = { t1: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b101", t2: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b202", t3: "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b303", t4: "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b404" };
const KAT = {
  publication1: "ee51d34128c55cdc4ba91108c8f58fb9437503c1e0a1f681bc33556e7b244cec",
  publication2: "f13d58cdc1bd8354fd01ac7dabda22bdb8ac0cfe4cda7b189449a934310e2faf",
};

const fixtures1 = (): SchedulePublicationFixtureRecord[] => [
  { fixtureRole: "SEMIFINAL_1", competitionFixtureId: F.sf1, startsAt: "2026-11-14T15:00:00.000Z", teamAId: T.t1, teamBId: T.t2, sourceFixtureAId: null, sourceFixtureBId: null },
  { fixtureRole: "SEMIFINAL_2", competitionFixtureId: F.sf2, startsAt: "2026-11-14T15:48:00.000Z", teamAId: T.t3, teamBId: T.t4, sourceFixtureAId: null, sourceFixtureBId: null },
  { fixtureRole: "FINAL", competitionFixtureId: F.fin, startsAt: "2026-11-14T16:56:00.000Z", teamAId: null, teamBId: null, sourceFixtureAId: F.sf1, sourceFixtureBId: F.sf2 },
];
const record1 = (over: Record<string, unknown> = {}): SchedulePublicationRecord => ({
  scheduleProposalSequence: 2, scheduleProposalDigest: PROPOSAL_DIGEST, planningRevisionId: REVISION, drawId: DRAW, drawDigest: DRAW_DIGEST,
  publishedByGamingMemberId: ORGANIZER, publishedAt: "2026-11-12T15:30:45.123456Z", publicationDigest: KAT.publication1, fixtures: fixtures1(), ...over,
}) as SchedulePublicationRecord;
const record2 = (): SchedulePublicationRecord => record1({
  scheduleProposalSequence: 1, publishedAt: "2026-11-12T15:30:45.000001Z", publicationDigest: KAT.publication2,
  fixtures: [
    { ...fixtures1()[0], startsAt: "2026-11-14T15:00:00.000Z" }, { ...fixtures1()[1], startsAt: "2026-11-14T15:00:00.000Z" }, { ...fixtures1()[2], startsAt: "2026-11-14T16:08:00.000Z" },
  ],
});
/** What the database returns for a publication (snake_case, its own words). */
const rawPublication = (over: Record<string, unknown> = {}) => ({
  schedule_proposal_sequence: 2, schedule_proposal_digest: PROPOSAL_DIGEST, planning_revision_id: REVISION, draw_id: DRAW, draw_digest: DRAW_DIGEST,
  published_by: ORGANIZER, published_at: "2026-11-12T15:30:45.123456Z", publication_digest: KAT.publication1,
  fixtures: [
    { fixture_role: "SEMIFINAL_1", fixture_id: F.sf1, start_utc: "2026-11-14T15:00:00.000Z", team_a_id: T.t1, team_b_id: T.t2, source_fixture_a_id: null, source_fixture_b_id: null },
    { fixture_role: "SEMIFINAL_2", fixture_id: F.sf2, start_utc: "2026-11-14T15:48:00.000Z", team_a_id: T.t3, team_b_id: T.t4, source_fixture_a_id: null, source_fixture_b_id: null },
    { fixture_role: "FINAL", fixture_id: F.fin, start_utc: "2026-11-14T16:56:00.000Z", team_a_id: null, team_b_id: null, source_fixture_a_id: F.sf1, source_fixture_b_id: F.sf2 },
  ], ...over,
});
const digestInput = (r = record1()) => { const { publicationDigest: _ignored, ...rest } = r; return rest; };

const LEGACY_FIELDS = ["semifinal1TeamAId", "semifinal1TeamBId", "semifinal2TeamAId", "semifinal2TeamBId", "semifinal1ScheduledAt", "semifinal2ScheduledAt", "finalScheduledAt"] as const;
const LEGACY_BODY = () => ({
  semifinal1TeamAId: "ta1", semifinal1TeamBId: "tb1", semifinal2TeamAId: "ta2", semifinal2TeamBId: "tb2",
  semifinal1ScheduledAt: "2026-11-14T15:00:00.000Z", semifinal2ScheduledAt: "2026-11-14T16:00:00.000Z", finalScheduledAt: "2026-11-14T17:00:00.000Z",
});
const SSS_BODY = () => ({ scheduleProposalDigest: PROPOSAL_DIGEST });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [1] [2] the request
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[1] the publish request is exactly { scheduleProposalDigest } — 64 lowercase hexadecimal digits — or exactly the seven legacy manual fields", () => {
  it("accepts exactly the digest and nothing else, and returns it as given", async () => {
    const { parsePublishRequest } = await loadSp();
    expect(parsePublishRequest(SSS_BODY())).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: PROPOSAL_DIGEST });
    expect(parsePublishRequest({ scheduleProposalDigest: "0".repeat(64) })).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: "0".repeat(64) });
    expect(parsePublishRequest({ scheduleProposalDigest: "f".repeat(64) })).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: "f".repeat(64) });
  });

  it("refuses a digest that is not 64 lowercase hexadecimal digits — uppercase, short, long, padded, non-hex, empty, or not text — with the code DIGEST_INVALID and the field", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    for (const bad of [PROPOSAL_DIGEST.toUpperCase(), PROPOSAL_DIGEST.slice(1), PROPOSAL_DIGEST + "0", ` ${PROPOSAL_DIGEST}`, `${PROPOSAL_DIGEST}\n`, "g".repeat(64), "", "x", 0, 1, null, undefined, true, [], {}, [PROPOSAL_DIGEST]]) {
      let caught: unknown = null;
      try { parsePublishRequest({ scheduleProposalDigest: bad }); } catch (err) { caught = err; }
      expect(caught, String(bad)).toBeInstanceOf(SchedulePublicationRequestError);
      expect((caught as { violations: unknown[] }).violations, String(bad)).toEqual([expect.objectContaining({ field: "scheduleProposalDigest", code: "DIGEST_INVALID" })]);
    }
  });

  it("accepts the seven legacy manual fields exactly — each a string — and returns them as given", async () => {
    const { parsePublishRequest } = await loadSp();
    expect(parsePublishRequest(LEGACY_BODY())).toEqual({ kind: "LEGACY", ...LEGACY_BODY() });
  });

  it("refuses a legacy body with a field missing, a field that is not text, or a field more — and an empty body", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    for (const field of LEGACY_FIELDS) {
      const missing: Record<string, unknown> = LEGACY_BODY();
      delete missing[field];
      expect(() => parsePublishRequest(missing), `missing ${field}`).toThrow(SchedulePublicationRequestError);
      for (const value of [1, null, true, {}, []]) expect(() => parsePublishRequest({ ...LEGACY_BODY(), [field]: value }), `${field}=${JSON.stringify(value)}`).toThrow(SchedulePublicationRequestError);
    }
    expect(() => parsePublishRequest({ ...LEGACY_BODY(), anything: "else" })).toThrow(SchedulePublicationRequestError);
    expect(() => parsePublishRequest({})).toThrow(SchedulePublicationRequestError);
  });

  it("refuses a body that is not an object — null, a list, text, a number — with REQUEST_NOT_OBJECT", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    for (const body of [null, undefined, [], [SSS_BODY()], "x", 1, true]) {
      let caught: unknown = null;
      try { parsePublishRequest(body); } catch (err) { caught = err; }
      expect(caught, String(body)).toBeInstanceOf(SchedulePublicationRequestError);
      expect((caught as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual(["REQUEST_NOT_OBJECT"]);
    }
  });
});

describe("[2] unknown, extra, mixed and legacy fields are refused for a schedule publication — and what the server derives can never be sent", () => {
  /** Every fact the server derives or owns (the gate's own list), under the names a client might try. */
  const DERIVED = [
    "teams", "team", "teamIds", "teamAId", "teamBId", "pairing", "pairings", "drawOrder", "drawPosition", "bracket", "semifinals", "semifinal1", "semifinal2", "final",
    "kickoff", "kickoffs", "kickoffTimes", "scheduledAt", "startsAt", "startUtc", "endsAt", "startTime", "planDate", "date", "dates", "time",
    "pitch", "pitches", "pitchId", "planningPitchId", "venue", "venueName", "location",
    "timeZone", "timezone", "tz", "utcOffset", "duration", "durationMinutes", "occupancy", "capacity", "simultaneousMatchCapacity",
    "format", "formatKey", "activityKey", "timing", "rules",
    "draw", "drawId", "drawDigest", "planningRevision", "planningRevisionId", "planningRevisionNumber", "proposal", "proposalId", "scheduleProposalId", "scheduleProposalSequence",
    "fixtureId", "fixtureIds", "semifinal1FixtureId", "semifinal2FixtureId", "finalFixtureId", "competitionFixtureId",
    "competitionId", "organizerGamingMemberId", "gamingMemberId", "actor", "actorId", "authority", "role", "publishedBy", "publishedAt", "state", "status", "publicationDigest", "intentId",
  ];

  it("every derived or owned field is refused by name, alone or beside the digest, with the code FORBIDDEN_FIELD", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    for (const field of DERIVED) {
      let caught: unknown = null;
      try { parsePublishRequest({ ...SSS_BODY(), [field]: "x" }); } catch (err) { caught = err; }
      expect(caught, field).toBeInstanceOf(SchedulePublicationRequestError);
      expect((caught as { violations: unknown[] }).violations, field).toEqual([expect.objectContaining({ field, code: "FORBIDDEN_FIELD" })]);
    }
  });

  it("a field that is neither the digest nor a known derived or legacy name is UNKNOWN_FIELD; every problem is listed, not just the first", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    let caught: unknown = null;
    try { parsePublishRequest({ ...SSS_BODY(), whatever: 1, "constructor": 2, extra: [] }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SchedulePublicationRequestError);
    const found = (caught as { violations: Array<{ field: string; code: string }> }).violations;
    expect(found.map((v) => v.field).sort()).toEqual(["constructor", "extra", "whatever"]);
    expect(new Set(found.map((v) => v.code))).toEqual(new Set(["UNKNOWN_FIELD"]));
  });

  it("a MIXED body — the digest beside any legacy manual field, or a legacy body beside the digest — is refused with MIXED_SHAPES, so the manual path can never carry a proposal and the schedule path never carries a manual field", async () => {
    const { parsePublishRequest, SchedulePublicationRequestError } = await loadSp();
    for (const field of LEGACY_FIELDS) {
      let caught: unknown = null;
      try { parsePublishRequest({ ...SSS_BODY(), [field]: "x" }); } catch (err) { caught = err; }
      expect(caught, field).toBeInstanceOf(SchedulePublicationRequestError);
      expect((caught as { violations: unknown[] }).violations, field).toEqual([expect.objectContaining({ field, code: "MIXED_SHAPES" })]);
    }
    let caught: unknown = null;
    try { parsePublishRequest({ ...LEGACY_BODY(), ...SSS_BODY() }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SchedulePublicationRequestError);
    expect((caught as { violations: Array<{ code: string }> }).violations.every((v) => v.code === "MIXED_SHAPES")).toBe(true);
    expect((caught as { violations: unknown[] }).violations).toHaveLength(LEGACY_FIELDS.length);
  });

  it("the parser reads no clock, no environment and no randomness (it is a pure function of the body)", async () => {
    const { parsePublishRequest } = await loadSp();
    const frozen = JSON.parse(JSON.stringify(SSS_BODY()));
    const before = JSON.stringify(frozen);
    parsePublishRequest(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [22] the digest and the reproduction of a publication from its own evidence
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[22] the publication digest: one canonical text, pinned by independent known answers", () => {
  it("equals the oracle's digest for both published vectors (the oracle is Python's hashlib over the gate's canonical text; nothing is shared with this code)", async () => {
    const { computeSchedulePublicationDigest } = await loadSp();
    expect(computeSchedulePublicationDigest(CID, digestInput(record1()))).toBe(KAT.publication1);
    expect(computeSchedulePublicationDigest(CID, digestInput(record2() as never))).toBe(KAT.publication2);
  });

  it("the canonical text is exactly the documented lines (version, competition, proposal, plan revision, draw, actor, instant, three fixtures) with no final newline", async () => {
    const { schedulePublicationCanonicalText } = await loadSp();
    expect(schedulePublicationCanonicalText(CID, digestInput(record1()))).toBe([
      "URBANO-COMPETITION-SCHEDULE-PUBLICATION-V1",
      `competition:${CID}`,
      `proposal:2,${PROPOSAL_DIGEST}`,
      `planning-revision:${REVISION}`,
      `draw:${DRAW},${DRAW_DIGEST}`,
      `published-by:${ORGANIZER}`,
      "published-at:2026-11-12T15:30:45.123456Z",
      `fixture:SEMIFINAL_1,${F.sf1},2026-11-14T15:00:00.000Z,${T.t1},${T.t2}`,
      `fixture:SEMIFINAL_2,${F.sf2},2026-11-14T15:48:00.000Z,${T.t3},${T.t4}`,
      `fixture:FINAL,${F.fin},2026-11-14T16:56:00.000Z,${F.sf1},${F.sf2}`,
    ].join("\n"));
  });

  it("changes with every single fact it covers: the competition, the sequence, the proposal, the plan revision, the draw, the draw digest, the actor, the instant, and each fixture's id, start and two links (teams or sources)", async () => {
    const { computeSchedulePublicationDigest } = await loadSp();
    const base = computeSchedulePublicationDigest(CID, digestInput(record1()));
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const variants: Array<[string, string]> = [
      ["competition", computeSchedulePublicationDigest(OTHER, digestInput(record1()))],
      ["sequence", computeSchedulePublicationDigest(CID, digestInput(record1({ scheduleProposalSequence: 3 })))],
      ["proposal digest", computeSchedulePublicationDigest(CID, digestInput(record1({ scheduleProposalDigest: sha("other") })))],
      ["plan revision", computeSchedulePublicationDigest(CID, digestInput(record1({ planningRevisionId: OTHER })))],
      ["draw", computeSchedulePublicationDigest(CID, digestInput(record1({ drawId: OTHER })))],
      ["draw digest", computeSchedulePublicationDigest(CID, digestInput(record1({ drawDigest: sha("other-draw") })))],
      ["actor", computeSchedulePublicationDigest(CID, digestInput(record1({ publishedByGamingMemberId: OTHER })))],
      ["instant (one microsecond)", computeSchedulePublicationDigest(CID, digestInput(record1({ publishedAt: "2026-11-12T15:30:45.123457Z" })))],
    ];
    for (let i = 0; i < 3; i++) {
      // A semifinal's line carries its two TEAMS, the final's its two SOURCE fixtures; the verifier (below) refuses a semifinal with sources and a final with teams.
      for (const key of (i < 2 ? ["competitionFixtureId", "startsAt", "teamAId", "teamBId"] : ["competitionFixtureId", "startsAt", "sourceFixtureAId", "sourceFixtureBId"]) as Array<"competitionFixtureId" | "startsAt" | "teamAId" | "teamBId" | "sourceFixtureAId" | "sourceFixtureBId">) {
        const changed = fixtures1().map((f) => ({ ...f }));
        (changed[i] as Record<string, unknown>)[key] = key === "startsAt" ? "2026-11-14T15:01:00.000Z" : OTHER;
        variants.push([`fixture ${i} ${key}`, computeSchedulePublicationDigest(CID, digestInput(record1({ fixtures: changed })))]);
      }
    }
    for (const [name, digest] of variants) expect(digest, name).not.toBe(base);
    expect(new Set(variants.map(([, d]) => d)).size).toBe(variants.length);
  });

  it("is a lowercase 64-digit hexadecimal text", async () => {
    const { computeSchedulePublicationDigest } = await loadSp();
    expect(computeSchedulePublicationDigest(CID, digestInput(record1()))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("[22] a stored publication reproduces itself from its own evidence, and evidence that does not is never handed on", () => {
  it("a consistent publication verifies — both vectors", async () => {
    const { verifySchedulePublication, assertSchedulePublicationVerifies } = await loadSp();
    expect(verifySchedulePublication(CID, record1() as never)).toEqual({ ok: true });
    expect(verifySchedulePublication(CID, record2() as never)).toEqual({ ok: true });
    expect(() => assertSchedulePublicationVerifies(CID, record1() as never)).not.toThrow();
  });

  it("each defect is caught: a changed digest, instant, actor, proposal, plan revision, draw, draw digest, start, team, source link, role, order, count or identifier", async () => {
    const { verifySchedulePublication, assertSchedulePublicationVerifies } = await loadSp();
    const tweak = (index: number, patch: Record<string, unknown>) => fixtures1().map((f, i) => (i === index ? { ...f, ...patch } : f));
    const defects: Array<[string, Record<string, unknown>]> = [
      ["the digest", { publicationDigest: sha("tampered") }], ["an uppercase digest", { publicationDigest: KAT.publication1.toUpperCase() }],
      ["the instant", { publishedAt: "2026-11-12T15:30:45.123457Z" }], ["an instant in milliseconds", { publishedAt: "2026-11-12T15:30:45.123Z" }],
      ["the actor", { publishedByGamingMemberId: STRANGER }], ["the proposal digest", { scheduleProposalDigest: sha("x") }], ["a malformed proposal digest", { scheduleProposalDigest: "abc" }],
      ["the sequence", { scheduleProposalSequence: 3 }], ["a zero sequence", { scheduleProposalSequence: 0 }], ["a fractional sequence", { scheduleProposalSequence: 1.5 }],
      ["the plan revision", { planningRevisionId: STRANGER }], ["the draw", { drawId: STRANGER }], ["the draw digest", { drawDigest: sha("y") }],
      ["a changed start", { fixtures: tweak(0, { startsAt: "2026-11-14T15:01:00.000Z" }) }],
      ["a start with the wrong precision", { fixtures: tweak(0, { startsAt: "2026-11-14T15:00:00Z" }) }],
      ["a changed team", { fixtures: tweak(0, { teamAId: STRANGER }) }],
      ["a team missing from a semifinal", { fixtures: tweak(1, { teamBId: null }) }],
      ["the same team twice", { fixtures: tweak(1, { teamAId: T.t1 }) }],
      ["a team on the final", { fixtures: tweak(2, { teamAId: T.t1 }) }],
      ["a source link broken", { fixtures: tweak(2, { sourceFixtureAId: STRANGER }) }],
      ["the final's links swapped", { fixtures: tweak(2, { sourceFixtureAId: F.sf2, sourceFixtureBId: F.sf1 }) }],
      ["a source link missing", { fixtures: tweak(2, { sourceFixtureBId: null }) }],
      ["a source link on a semifinal", { fixtures: tweak(0, { sourceFixtureAId: F.sf2 }) }],
      ["a repeated fixture identifier", { fixtures: tweak(1, { competitionFixtureId: F.sf1 }) }],
      ["a wrong role", { fixtures: tweak(1, { fixtureRole: "SEMIFINAL_1" }) }],
      ["the fixtures out of role order", { fixtures: [fixtures1()[1], fixtures1()[0], fixtures1()[2]] }],
      ["only two fixtures", { fixtures: fixtures1().slice(0, 2) }], ["four fixtures", { fixtures: [...fixtures1(), fixtures1()[0]] }], ["no fixtures", { fixtures: [] }],
    ];
    for (const [name, patch] of defects) {
      const verdict = verifySchedulePublication(CID, record1(patch) as never);
      expect(verdict.ok, name).toBe(false);
      expect(() => assertSchedulePublicationVerifies(CID, record1(patch) as never), name).toThrow(/could not be verified/);
    }
    expect(verifySchedulePublication(STRANGER, record1() as never).ok, "another competition's digest").toBe(false);
  });
});

describe("what the database returns is judged strictly, field by field", () => {
  it("maps a complete publication to the application's own shape", async () => {
    const { schedulePublicationRecordFromDatabase } = await loadSp();
    expect(schedulePublicationRecordFromDatabase(rawPublication())).toEqual(record1());
  });

  it("refuses anything that is not exactly a publication: a missing or mistyped field, a bad instant, a bad digest, a wrong fixture count, a non-object", async () => {
    const { schedulePublicationRecordFromDatabase } = await loadSp();
    const bad: unknown[] = [
      null, undefined, "x", 1, [], {}, rawPublication({ published_at: "2026-11-12 15:30:45" }), rawPublication({ published_at: 5 }), rawPublication({ publication_digest: "abc" }),
      rawPublication({ schedule_proposal_sequence: "2" }), rawPublication({ schedule_proposal_sequence: 0 }), rawPublication({ schedule_proposal_digest: null }), rawPublication({ draw_id: 1 }),
      rawPublication({ fixtures: null }), rawPublication({ fixtures: [] }), rawPublication({ fixtures: rawPublication().fixtures.slice(0, 2) }),
      rawPublication({ fixtures: rawPublication().fixtures.map((f, i) => (i === 0 ? { ...f, fixture_id: 5 } : f)) }),
      rawPublication({ fixtures: rawPublication().fixtures.map((f, i) => (i === 0 ? { ...f, start_utc: "2026-11-14T15:00:00Z" } : f)) }),
    ];
    for (const raw of bad) expect(() => schedulePublicationRecordFromDatabase(raw), JSON.stringify(raw)?.slice(0, 70)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("what a browser may see: every field is copied by name, so nothing the server holds beyond this list can reach a response", () => {
  it("the public publication carries the three fixture identifiers (with their roles and starts), the proposal and publication digests and the instant — and nothing else", async () => {
    const { publicScheduledPublication } = await loadSp();
    const shown = publicScheduledPublication({ competitionId: CID, alreadyPublished: false, publication: record1() as never });
    expect(shown).toEqual({
      result: { competitionId: CID, state: "PUBLISHED", publishedAt: "2026-11-12T15:30:45.123456Z", semifinal1FixtureId: F.sf1, semifinal2FixtureId: F.sf2, finalFixtureId: F.fin },
      publication: {
        alreadyPublished: false, scheduleProposalDigest: PROPOSAL_DIGEST, publicationDigest: KAT.publication1, publishedAt: "2026-11-12T15:30:45.123456Z",
        fixtures: [
          { fixtureRole: "SEMIFINAL_1", competitionFixtureId: F.sf1, startsAt: "2026-11-14T15:00:00.000Z" },
          { fixtureRole: "SEMIFINAL_2", competitionFixtureId: F.sf2, startsAt: "2026-11-14T15:48:00.000Z" },
          { fixtureRole: "FINAL", competitionFixtureId: F.fin, startsAt: "2026-11-14T16:56:00.000Z" },
        ],
      },
    });
    const text = JSON.stringify(shown);
    for (const secret of [REVISION, DRAW, DRAW_DIGEST, ORGANIZER, T.t1, T.t2, T.t3, T.t4]) expect(text, secret).not.toContain(secret);
    for (const word of ["drawId", "planningRevision", "publishedBy", "gamingMember", "teamA", "teamB", "seed", "permutation"]) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
  });

  it("an exact replay is reported as such", async () => {
    const { publicScheduledPublication } = await loadSp();
    expect(publicScheduledPublication({ competitionId: CID, alreadyPublished: true, publication: record1() as never }).publication.alreadyPublished).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the typed refusals: stable codes, the application's own words, and no database wording ever reaching a browser", () => {
  const CASES: Array<[string, string]> = [
    ["SCHEDULE_PUBLICATION_WRONG_STATE: nope", "WRONG_STATE"], ["SCHEDULE_PUBLICATION_FREEZE_REQUIRED: nope", "FREEZE_REQUIRED"], ["SCHEDULE_PUBLICATION_FREEZE_INCONSISTENT: nope", "FREEZE_INCONSISTENT"],
    ["SCHEDULE_PUBLICATION_DRAW_REQUIRED: nope", "DRAW_REQUIRED"], ["SCHEDULE_PUBLICATION_PLAN_REQUIRED: nope", "PLAN_REQUIRED"], ["SCHEDULE_PUBLICATION_AMENDMENT_PENDING: nope", "AMENDMENT_PENDING"],
    ["SCHEDULE_PUBLICATION_DRAW_NOT_VERIFIABLE: nope", "DRAW_NOT_VERIFIABLE"], ["SCHEDULE_PUBLICATION_PROPOSAL_NOT_FOUND: nope", "PROPOSAL_NOT_FOUND"],
    ["SCHEDULE_PUBLICATION_PROPOSAL_SUPERSEDED: nope", "PROPOSAL_SUPERSEDED"], ["SCHEDULE_PUBLICATION_PROPOSAL_STALE: nope", "PROPOSAL_STALE"],
    ["SCHEDULE_PUBLICATION_PROPOSAL_NOT_VERIFIABLE: nope", "PROPOSAL_NOT_VERIFIABLE"], ["SCHEDULE_PUBLICATION_CONFLICT: nope", "PUBLICATION_CONFLICT"],
    ["SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED: nope", "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED"],
  ];

  it("every database code becomes its typed error with the matching stable code", async () => {
    const { schedulePublicationErrorFromDatabase, SchedulePublicationError } = await loadSp();
    for (const [message, code] of CASES) {
      const error = schedulePublicationErrorFromDatabase(`ERROR: ${message}`);
      expect(error, message).toBeInstanceOf(SchedulePublicationError);
      expect((error as unknown as { code: string }).code, message).toBe(code);
      expect((error as Error).message, message).not.toContain("nope");
      expect((error as Error).message, message).not.toMatch(/SCHEDULE_|competition_|_atomically|row-level|constraint|postgres/i);
    }
  });

  it("a schedule that can no longer be published carries the stable code of the rule it breaks; an invalid request carries its code; anything else is not this module's", async () => {
    const { schedulePublicationErrorFromDatabase, SchedulePublicationNotPublishableError, SchedulePublicationRequestError } = await loadSp();
    const stale = schedulePublicationErrorFromDatabase("SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: START_NOT_FUTURE: the first semifinal's kickoff is not in the future");
    expect(stale).toBeInstanceOf(SchedulePublicationNotPublishableError);
    expect((stale as unknown as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual(["START_NOT_FUTURE"]);
    expect((stale as Error).message).not.toMatch(/SCHEDULE_PUBLICATION/);
    const bare = schedulePublicationErrorFromDatabase("SCHEDULE_PUBLICATION_NOT_PUBLISHABLE");
    expect(bare).toBeInstanceOf(SchedulePublicationNotPublishableError);
    const request = schedulePublicationErrorFromDatabase("SCHEDULE_PUBLICATION_INVALID: DIGEST_INVALID: a proposal digest is required");
    expect(request).toBeInstanceOf(SchedulePublicationRequestError);
    expect((request as unknown as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual(["DIGEST_INVALID"]);
    for (const other of ["", "COMPETITION_NOT_FOUND: x", "boom", "SCHEDULE_PROPOSAL_DRAW_REQUIRED: x", "SCHEDULE_PUBLICATION"]) expect(schedulePublicationErrorFromDatabase(other), other).toBeNull();
    expect(schedulePublicationErrorFromDatabase(undefined as never)).toBeNull();
  });

  it("how a failed publication is answered: 400 for the request, 404 only for a proposal that is not there, 409 for everything else with its code — and null for what is not this module's", async () => {
    const { schedulePublicationFailure, SchedulePublicationError, SchedulePublicationNotPublishableError, SchedulePublicationRequestError } = await loadSp();
    expect(schedulePublicationFailure(new SchedulePublicationRequestError([{ field: "scheduleProposalDigest", code: "DIGEST_INVALID", message: "m" }]))).toEqual({
      status: 400, body: { error: "Invalid publish payload.", problems: [{ field: "scheduleProposalDigest", code: "DIGEST_INVALID", message: "m" }] },
    });
    const notFound = schedulePublicationFailure(new SchedulePublicationError("PROPOSAL_NOT_FOUND"))!;
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ error: expect.any(String), code: "PROPOSAL_NOT_FOUND" });
    for (const [, code] of CASES.filter(([, c]) => c !== "PROPOSAL_NOT_FOUND")) {
      const failure = schedulePublicationFailure(new SchedulePublicationError(code as never))!;
      expect(failure.status, code).toBe(409);
      expect(failure.body, code).toEqual({ error: expect.any(String), code });
    }
    const violations = [{ field: "schedule", code: "START_NOT_FUTURE", message: "Late." }];
    expect(schedulePublicationFailure(new SchedulePublicationNotPublishableError(violations))).toEqual({
      status: 409, body: { error: expect.any(String), code: "SCHEDULE_NOT_PUBLISHABLE", problems: violations },
    });
    for (const other of [new Error("boom"), new CompetitionNotFoundError(), "x", null, undefined, {}]) expect(schedulePublicationFailure(other), String(other)).toBeNull();
  });

  it("the legacy refusal says plainly that the manual path is closed for this competition and where to go instead — and names no table, function or code of the database", async () => {
    const { SchedulePublicationError } = await loadSp();
    const error = new SchedulePublicationError("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(error.message).toMatch(/schedule proposal/i);
    expect(error.message).not.toMatch(/SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED|publish_competition|competition_/);
    expect(error.message).not.toMatch(/choose|pick|enter the teams|pairing/i);
  });

  it("the shared database translation maps every code of this gate, ahead of every shared code", async () => {
    const { translateError } = await import("../lib/gaming/competitions/db/supabaseCompetitionsRepository");
    const { SchedulePublicationError, SchedulePublicationNotPublishableError, SchedulePublicationRequestError } = await loadSp();
    for (const [message, code] of CASES) {
      const error = translateError({ code: "P0001", message });
      expect(error, message).toBeInstanceOf(SchedulePublicationError);
      expect((error as unknown as { code: string }).code).toBe(code);
    }
    expect(translateError({ code: "P0001", message: "SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: FINAL_REST: too soon" })).toBeInstanceOf(SchedulePublicationNotPublishableError);
    expect(translateError({ code: "P0001", message: "SCHEDULE_PUBLICATION_INVALID: DIGEST_INVALID: x" })).toBeInstanceOf(SchedulePublicationRequestError);
    expect(translateError({ code: "P0001", message: "COMPETITION_ACCESS_DENIED: only this competition's own organizer may publish it" })).toBeInstanceOf(CompetitionAccessDeniedError);
    expect(translateError({ code: "P0001", message: "COMPETITION_NOT_FOUND: no such competition exists" })).toBeInstanceOf(CompetitionNotFoundError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The command and the route
// ---------------------------------------------------------------------------------------------------------------------------------------------

function makeRepo() {
  return {
    getCompetitionById: vi.fn(),
    publishCompetition: vi.fn().mockResolvedValue({ competitionId: CID, state: "PUBLISHED", publishedAt: "2026-11-12T15:30:45.000Z", semifinal1FixtureId: "sf1", semifinal2FixtureId: "sf2", finalFixtureId: "fin" }),
    publishScheduledCompetition: vi.fn().mockResolvedValue({ competitionId: CID, alreadyPublished: false, publication: record1() }),
  };
}

describe("the command: it passes exactly the competition, the verified caller and the digest — and nothing else — to the one atomic operation", () => {
  it("publishScheduledCompetition forwards exactly three arguments and returns the repository's verified result", async () => {
    const { publishScheduledCompetition } = await loadSp();
    const repo = makeRepo();
    const result = await publishScheduledCompetition(repo as never, CID, ORGANIZER, { scheduleProposalDigest: PROPOSAL_DIGEST });
    expect(repo.publishScheduledCompetition).toHaveBeenCalledTimes(1);
    expect(repo.publishScheduledCompetition).toHaveBeenCalledWith(CID, ORGANIZER, PROPOSAL_DIGEST);
    expect(result).toEqual({ competitionId: CID, alreadyPublished: false, publication: record1() });
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
    expect(repo.publishCompetition).not.toHaveBeenCalled();
  });

  it("a malformed digest never reaches the repository", async () => {
    const { publishScheduledCompetition } = await loadSp();
    const repo = makeRepo();
    for (const bad of ["", "abc", PROPOSAL_DIGEST.toUpperCase(), 5 as never]) await expect(publishScheduledCompetition(repo as never, CID, ORGANIZER, { scheduleProposalDigest: bad })).rejects.toThrow();
    expect(repo.publishScheduledCompetition).not.toHaveBeenCalled();
  });

  it("the module's own refusals pass through untouched, and a repository failure is never swallowed", async () => {
    const { publishScheduledCompetition, SchedulePublicationError } = await loadSp();
    const repo = makeRepo();
    repo.publishScheduledCompetition.mockRejectedValue(new SchedulePublicationError("PROPOSAL_STALE"));
    await expect(publishScheduledCompetition(repo as never, CID, ORGANIZER, SSS_BODY() as never)).rejects.toMatchObject({ code: "PROPOSAL_STALE" });
    repo.publishScheduledCompetition.mockRejectedValue(new HostAccessRevokedError());
    await expect(publishScheduledCompetition(repo as never, CID, ORGANIZER, SSS_BODY() as never)).rejects.toBeInstanceOf(HostAccessRevokedError);
  });
});

describe("the route for both request shapes: 503 first, 401, the exact bodies, 201 / 200 / 400 / 403 / 404 / 409, bounded errors, no caching", () => {
  const ctx = (competitionId: string): Ctx => ({ params: { competitionId } });
  const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    vi.clearAllMocks();
    repo = makeRepo();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as never);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    return () => { if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL; };
  });

  it("exports exactly POST", async () => {
    const mod = await loadRoute();
    expect(["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function")).toEqual(["POST"]);
  });

  it("with the schema not ready it answers 503 first — before authenticating, parsing a body or building a repository", async () => {
    const mod = await loadRoute();
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = value;
      const res = await mod.POST!(post("not json {{{"), ctx(CID));
      expect(res.status, String(value)).toBe(503);
    }
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
  });

  it("answers 401 from the credential alone, with no repository built, for both shapes", async () => {
    const mod = await loadRoute();
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) } as never);
    for (const body of [SSS_BODY(), LEGACY_BODY()]) expect((await mod.POST!(post(body), ctx(CID))).status).toBe(401);
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
    expect(repo.publishScheduledCompetition).not.toHaveBeenCalled();
    expect(repo.publishCompetition).not.toHaveBeenCalled();
  });

  it("[1] the schedule shape: 201 with exactly the bounded publication and the legacy-compatible result; the repository receives the competition, the VERIFIED caller and the digest only", async () => {
    const mod = await loadRoute();
    const { publicScheduledPublication } = await loadSp();
    const res = await mod.POST!(post(SSS_BODY()), ctx(CID));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(await res.json()).toEqual(publicScheduledPublication({ competitionId: CID, alreadyPublished: false, publication: record1() as never }));
    expect(repo.publishScheduledCompetition).toHaveBeenCalledWith(CID, ORGANIZER, PROPOSAL_DIGEST);
    expect(repo.publishCompetition).not.toHaveBeenCalled();
  });

  it("[18] an exact authorized replay answers 200 with the same body and the flag", async () => {
    const mod = await loadRoute();
    repo.publishScheduledCompetition.mockResolvedValue({ competitionId: CID, alreadyPublished: true, publication: record1() });
    const res = await mod.POST!(post(SSS_BODY()), ctx(CID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publication.alreadyPublished).toBe(true);
    expect(body.result.finalFixtureId).toBe(F.fin);
  });

  it("[2] unknown, extra, mixed and legacy fields are 400 with every problem listed — and neither store is touched", async () => {
    const mod = await loadRoute();
    for (const field of ["teams", "pairing", "kickoff", "pitch", "venue", "timeZone", "duration", "capacity", "format", "drawId", "planningRevisionId", "fixtureId", "organizerGamingMemberId", "actor", "whatever", ...LEGACY_FIELDS]) {
      const res = await mod.POST!(post({ ...SSS_BODY(), [field]: "x" }), ctx(CID));
      expect(res.status, field).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const body = await res.json();
      expect(body.error).toBe("Invalid publish payload.");
      expect(body.problems.map((p: { field: string }) => p.field)).toEqual([field]);
    }
    expect((await mod.POST!(post({ ...LEGACY_BODY(), extra: 1 }), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post({ ...LEGACY_BODY(), ...SSS_BODY() }), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post({}), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post({ scheduleProposalDigest: PROPOSAL_DIGEST.toUpperCase() }), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post("not json {{{"), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post([SSS_BODY()]), ctx(CID))).status).toBe(400);
    expect(repo.publishScheduledCompetition).not.toHaveBeenCalled();
    expect(repo.publishCompetition).not.toHaveBeenCalled();
  });

  it("the schedule shape with a malformed competition id is 404 before the repository is built", async () => {
    const mod = await loadRoute();
    const res = await mod.POST!(post(SSS_BODY()), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(repo.publishScheduledCompetition).not.toHaveBeenCalled();
  });

  it("the legacy shape still reaches the manual operation with the same nine arguments in the same order, and answers 200 { result } as it always did", async () => {
    const mod = await loadRoute();
    const res = await mod.POST!(post(LEGACY_BODY()), ctx(CID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { competitionId: CID, state: "PUBLISHED", publishedAt: "2026-11-12T15:30:45.000Z", semifinal1FixtureId: "sf1", semifinal2FixtureId: "sf2", finalFixtureId: "fin" } });
    expect(repo.publishCompetition).toHaveBeenCalledWith(CID, ORGANIZER, "ta1", "tb1", "ta2", "tb2", "2026-11-14T15:00:00.000Z", "2026-11-14T16:00:00.000Z", "2026-11-14T17:00:00.000Z");
    expect(repo.publishScheduledCompetition).not.toHaveBeenCalled();
  });

  it("[24] the legacy shape for a competition that belongs to the schedule journey is a 409 with the stable code SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED and bounded words", async () => {
    const mod = await loadRoute();
    const { SchedulePublicationError } = await loadSp();
    repo.publishCompetition.mockRejectedValue(new SchedulePublicationError("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED"));
    const res = await mod.POST!(post(LEGACY_BODY()), ctx(CID));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(JSON.stringify(body)).not.toMatch(/publish_competition|competition_|postgres/i);
  });

  it("every refusal of the schedule shape is answered with its status and stable code: 403 for a stranger or a former host, 404 for an unknown competition or proposal, 409 for the rest, 409 with problems for a schedule that can no longer be published", async () => {
    const mod = await loadRoute();
    const { SchedulePublicationError, SchedulePublicationNotPublishableError } = await loadSp();
    const cases: Array<[Error, number, string | null]> = [
      [new CompetitionAccessDeniedError(), 403, null], [new HostAccessRevokedError(), 403, null], [new CompetitionNotFoundError(), 404, null],
      [new SchedulePublicationError("PROPOSAL_NOT_FOUND"), 404, "PROPOSAL_NOT_FOUND"], [new SchedulePublicationError("PROPOSAL_SUPERSEDED"), 409, "PROPOSAL_SUPERSEDED"],
      [new SchedulePublicationError("PROPOSAL_STALE"), 409, "PROPOSAL_STALE"], [new SchedulePublicationError("PUBLICATION_CONFLICT"), 409, "PUBLICATION_CONFLICT"],
      [new SchedulePublicationError("WRONG_STATE"), 409, "WRONG_STATE"], [new SchedulePublicationError("AMENDMENT_PENDING"), 409, "AMENDMENT_PENDING"],
      [new SchedulePublicationNotPublishableError([{ field: "schedule", code: "START_NOT_FUTURE", message: "Late." }]), 409, "SCHEDULE_NOT_PUBLISHABLE"],
    ];
    for (const [error, status, code] of cases) {
      repo.publishScheduledCompetition.mockRejectedValue(error);
      const res = await mod.POST!(post(SSS_BODY()), ctx(CID));
      expect(res.status, error.constructor.name + String(code)).toBe(status);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const body = await res.json();
      if (code) expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toMatch(/SCHEDULE_PUBLICATION_|publish_competition_schedule|competition_schedule_|postgres|row-level/i);
    }
  });

  it("an unexpected failure is a bounded 500 that names nothing", async () => {
    const mod = await loadRoute();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.publishScheduledCompetition.mockRejectedValue(new Error("connection to 10.0.0.1 refused (secret-table)"));
    const res = await mod.POST!(post(SSS_BODY()), ctx(CID));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/10\.0\.0\.1|secret-table/);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The repository adapter
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the repository adapter sends exactly the competition, the verified caller and the digest — and never hands on evidence that does not reproduce itself", () => {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  function answer(body: unknown, status = 200) {
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      sent.push({ url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }));
  }
  const repository = () => new SupabaseCompetitionsRepository("http://127.0.0.1:1", "service-key");
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends exactly three parameters to the one operation and returns the verified publication", async () => {
    answer({ already_published: false, publication: rawPublication() });
    const result = await repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST);
    expect(result).toEqual({ competitionId: CID, alreadyPublished: false, publication: record1() });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/rest\/v1\/rpc\/publish_competition_schedule_atomically$/);
    expect(sent[0].body).toEqual({ p_competition_id: CID, p_organizer_gaming_member_id: ORGANIZER, p_schedule_proposal_digest: PROPOSAL_DIGEST });
  });

  it("an exact replay is reported as such", async () => {
    answer({ already_published: true, publication: rawPublication() });
    expect((await repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST)).alreadyPublished).toBe(true);
  });

  it("a database refusal becomes its typed error (the shared translation, ahead of every shared code)", async () => {
    const { SchedulePublicationError, SchedulePublicationNotPublishableError } = await loadSp();
    answer({ code: "P0001", message: "SCHEDULE_PUBLICATION_PROPOSAL_STALE: no", details: null, hint: null }, 400);
    const stale = await repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST).then(() => null, (e: unknown) => e);
    expect(stale).toBeInstanceOf(SchedulePublicationError);
    expect((stale as { code: string }).code).toBe("PROPOSAL_STALE");
    answer({ code: "P0001", message: "SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: START_NOT_FUTURE: late", details: null, hint: null }, 400);
    expect(await repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST).then(() => null, (e: unknown) => e)).toBeInstanceOf(SchedulePublicationNotPublishableError);
    answer({ code: "P0001", message: "COMPETITION_ACCESS_DENIED: only this competition's own organizer may publish it", details: null, hint: null }, 400);
    expect(await repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST).then(() => null, (e: unknown) => e)).toBeInstanceOf(CompetitionAccessDeniedError);
  });

  it("evidence that does not verify is never returned (a changed digest, a changed start, a changed link, a response without a publication)", async () => {
    for (const body of [
      { already_published: false, publication: rawPublication({ publication_digest: sha("tampered") }) },
      { already_published: false, publication: rawPublication({ fixtures: rawPublication().fixtures.map((f, i) => (i === 0 ? { ...f, start_utc: "2026-11-14T15:01:00.000Z" } : f)) }) },
      { already_published: false, publication: rawPublication({ fixtures: rawPublication().fixtures.map((f, i) => (i === 2 ? { ...f, source_fixture_a_id: STRANGER } : f)) }) },
      { already_published: false, publication: rawPublication({ schedule_proposal_digest: sha("another") }) },
      { already_published: false }, { already_published: false, publication: null }, { already_published: false, publication: [] }, null, "x", [],
    ]) {
      answer(body);
      await expect(repository().publishScheduledCompetition(CID, ORGANIZER, PROPOSAL_DIGEST), JSON.stringify(body)?.slice(0, 80)).rejects.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The static facts about the surface
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SURFACE = ["lib/gaming/competitions/schedulePublication.ts", "app/api/gaming/competitions/[competitionId]/publish/route.ts"];
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const PUBLIC = () => walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js|css)$/i.test(f));

describe("no clock, no randomness and no environment in the module: the publication instant and every identifier are the database's alone", () => {
  it("the module reads no clock, no environment and no source of randomness", () => {
    const source = strip(read("lib/gaming/competitions/schedulePublication.ts"));
    for (const pattern of [/\bDate\.now\b/, /new Date\(\s*\)/, /\bprocess\.env\b/, /Math\.random/, /randomUUID|randomBytes|getRandomValues|crypto\.random/]) expect(source, String(pattern)).not.toMatch(pattern);
  });

  it("neither the module nor the route names a format, and the registry still knows exactly the same four", () => {
    expect([...SOCCER_FORMAT_KEYS]).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    for (const file of SURFACE) expect(strip(read(file)), file).not.toMatch(/SOCCER_[5-8]V[5-8]/);
  });
});

describe("[26][27] no page offers a publication control, and no format other than five-a-side is made available", () => {
  it("no public page or script sends the digest, names the schedule publication or calls the publish route's new shape", () => {
    for (const file of PUBLIC()) {
      const source = readFileSync(file, "utf8");
      const where = path.relative(REPO_ROOT, file);
      expect(source, `${where}: scheduleProposalDigest`).not.toMatch(/scheduleProposalDigest/);
      expect(source, `${where}: a schedule publication name`).not.toMatch(/schedule[_ ]?publication|SchedulePublication|competition_schedule_publication/i);
    }
  });

  it("the creation routes and functions still take no format, no draw, no schedule and no publication from this gate", () => {
    expect(read("lib/gaming/competitions/createCompetition.ts")).not.toMatch(/formats|SOCCER_FORMAT|planning|draw|schedule/i);
    expect(read("app/api/gaming/host/competition/route.ts")).not.toMatch(/activityKey|formats|SOCCER_|draw|schedule/i);
    expect(read("app/api/gaming/competitions/route.ts")).not.toMatch(/planning|formats|draw|schedule/i);
  });

  it("no discovery read or administration function mentions the schedule publication", () => {
    for (const file of ["lib/gaming/competitions/getCompetitionView.ts", "lib/gaming/competitions/createCompetition.ts", "lib/gaming/competitions/organizerAccess.ts",
      "lib/gaming/competitions/administration.ts", "lib/gaming/competitions/resolveCompetitionByPublicCode.ts"]) {
      expect(read(file), file).not.toMatch(/schedule[-_ ]?publication|SchedulePublication/);
    }
  });

  it("the legacy module says plainly that it is retained for competitions outside the schedule journey, and does not offer itself for new ones", () => {
    const source = read("lib/gaming/competitions/publishCompetition.ts");
    expect(source).toMatch(/LEGACY/);
    expect(source).toMatch(/schedule proposal/i);
    expect(source).not.toMatch(/\brecommended\b|preferred way|should use this/i);
  });
});

describe("the migration (static contract): exactly one new, append-only migration", () => {
  const DIR = path.join(REPO_ROOT, "supabase/migrations");
  /** The schedule proposal's migration (SSS-022): this one must sort after it, and nothing else may sort after it but this one. */
  const PROPOSAL_MIGRATION = "20261105120000_competition_four_team_schedule_proposal_foundation.sql";
  const found = () => readdirSync(DIR).filter((f) => /schedule_publication/i.test(f));
  const code = () => {
    const files = found();
    if (files.length !== 1) throw new Error(`expected exactly one schedule-publication migration, found ${files.length}`);
    return readFileSync(path.join(DIR, files[0]), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  };
  const body = (sql: string, name: string) => {
    const start = sql.search(new RegExp(`create (or replace )?function (public\\.)?${name}\\(`, "i"));
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    const end = sql.indexOf("$function$;", sql.indexOf("$function$", start + 20) + 5);
    return sql.slice(start, end);
  };
  const TABLE = "competition_schedule_publications";
  const RPC = "publish_competition_schedule_atomically";
  const HELPERS = ["competition_schedule_publication_digest", "competition_schedule_publication_evidence", "competition_schedule_publication_verify", "competition_schedule_publication_verify_row", "competition_schedule_publication_reject_change"];

  it("is exactly one migration with a descriptive schedule-publication name, after the proposal's, and the only one after it", () => {
    const files = found();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_[a-z0-9_]*schedule_publication[a-z0-9_]*\.sql$/);
    expect(files[0] > PROPOSAL_MIGRATION).toBe(true);
    expect(readdirSync(DIR).filter((f) => f > PROPOSAL_MIGRATION)).toEqual(files);
  });

  it("creates exactly one table, server-only: row-level security on, no policy, no privilege for anyone — not even the server role", () => {
    const sql = code();
    expect([...sql.matchAll(/create table (\w+)/g)].map((m) => m[1])).toEqual([TABLE]);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE} enable row level security;`));
    expect(sql).toMatch(new RegExp(`revoke all on table ${TABLE} from public, anon, authenticated, service_role;`));
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|truncate|all)[^;]*\bon\s+(table\s+)?competition_schedule/i);
  });

  it("holds one publication per competition and per proposal, with the three fixture identifiers distinct and every digest a 64-digit hexadecimal text", () => {
    const sql = code();
    expect(sql).toMatch(/unique \(competition_id\)/);
    expect(sql).toMatch(/unique \(schedule_proposal_id\)/);
    expect(sql).toMatch(/semifinal_1_fixture_id uuid not null/);
    expect(sql).toMatch(/semifinal_2_fixture_id uuid not null/);
    expect(sql).toMatch(/final_fixture_id uuid not null/);
    expect(sql).toMatch(/publication_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/published_at timestamptz not null/);
    expect(sql).not.toMatch(/\b(pitch|venue)\w*\s+(uuid|text|integer)/i); // no pitch or venue column anywhere: the proposal and the publication remain the linkage
  });

  it("is append-only: update, delete and truncate are refused by triggers; the verification runs at commit; the operation and the helpers are not executable by the browser roles", () => {
    const sql = code();
    expect(sql).toMatch(new RegExp(`create trigger \\w+ before update or delete on ${TABLE}`));
    expect(sql).toMatch(new RegExp(`create trigger \\w+ before truncate on ${TABLE}`));
    expect(sql).toMatch(/create constraint trigger \w+ after insert on competition_schedule_publications\s+deferrable initially deferred/);
    expect(sql).toMatch(new RegExp(`revoke all on function ${RPC}\\(uuid, uuid, text\\) from public, anon, authenticated;`));
    expect(sql).toMatch(new RegExp(`grant execute on function ${RPC}\\(uuid, uuid, text\\) to service_role;`));
    for (const helper of HELPERS) {
      expect(sql, helper).toMatch(new RegExp(`create function ${helper}\\(`));
      expect(sql, helper).toMatch(new RegExp(`revoke all on function ${helper}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql, helper).toMatch(new RegExp(`revoke all on function ${helper}\\([^)]*\\) from service_role;`));
    }
  });

  it("creates the operation, the helpers and replaces exactly ONE existing function — the legacy publish — with the same signature", () => {
    const sql = code();
    expect([...sql.matchAll(/create function (\w+)\(/g)].map((m) => m[1]).sort()).toEqual([...HELPERS, RPC].sort());
    const replaced = [...sql.matchAll(/create or replace function (?:public\.)?(\w+)\(/gi)].map((m) => m[1]);
    expect(replaced).toEqual(["publish_competition_atomically"]);
    expect(sql).toMatch(/create or replace function public\.publish_competition_atomically\(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_semifinal_1_team_a_id uuid, p_semifinal_1_team_b_id uuid, p_semifinal_2_team_a_id uuid, p_semifinal_2_team_b_id uuid, p_semifinal_1_scheduled_at timestamp with time zone, p_semifinal_2_scheduled_at timestamp with time zone, p_final_scheduled_at timestamp with time zone\)/i);
    expect(sql).not.toMatch(/\bdrop\s+(function|table|trigger|policy|schema)/i);
    expect(sql).not.toMatch(/alter table (?!competition_schedule_publications)/i);
  });

  it("[24] the legacy publish refuses, in the database, every competition with a registration freeze, a draw or a schedule proposal — after the ownership and revocation checks, before the state check", () => {
    const legacy = body(code(), "publish_competition_atomically");
    expect(legacy).toMatch(/SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED/);
    for (const table of ["competition_registration_freezes", "competition_draws", "competition_schedule_proposals"]) expect(legacy, table).toMatch(new RegExp(`from ${table}\\b`));
    const at = (needle: RegExp) => legacy.search(needle);
    expect(at(/p_organizer_gaming_member_id is distinct from v_organizer_id/)).toBeGreaterThan(-1);
    expect(at(/p_organizer_gaming_member_id is distinct from v_organizer_id/)).toBeLessThan(at(/assert_competition_not_host_revoked/));
    expect(at(/assert_competition_not_host_revoked/)).toBeLessThan(at(/SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED/));
    expect(at(/SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED/)).toBeLessThan(at(/COMPETITION_NOT_READY_TO_PUBLISH/));
    expect(legacy).toMatch(/perform pg_advisory_xact_lock\(hashtext\('competition_scope:' \|\| p_competition_id::text\)\)/);
  });

  it("[24][25] apart from that guard, the legacy function's accepted behavior is carried over unchanged: the same checks, the same errors, the same three inserts and the same update", () => {
    const legacy = body(code(), "publish_competition_atomically");
    for (const must of [
      /COMPETITION_NOT_FOUND/, /COMPETITION_ACCESS_DENIED/, /COMPETITION_NOT_READY_TO_PUBLISH/, /COMPETITION_TEAM_COUNT_INVALID/, /COMPETITION_PAIRING_INVALID/,
      /v_state <> 'READY_TO_PUBLISH'/, /v_team_count <> 4/, /v_distinct_pairing_count <> 4/, /v_published_at := now\(\)/,
      /insert into competition_fixtures \(competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state\)\s+values \(p_competition_id, 'SEMIFINAL_1'/,
      /insert into competition_fixtures \(competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state\)\s+values \(p_competition_id, 'SEMIFINAL_2'/,
      /insert into competition_fixtures \(competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state\)\s+values \(p_competition_id, 'FINAL'/,
      /update competitions\s+set state = 'PUBLISHED', published_at = v_published_at/,
    ]) expect(legacy, String(must)).toMatch(must);
    expect(legacy.match(/insert into competition_fixtures/g)).toHaveLength(3);
  });

  it("the operation takes no team, pairing, time, pitch, venue, zone, duration, capacity, format, draw, plan or actor beyond the verified organizer — only the digest", () => {
    const rpc = body(code(), RPC);
    const signature = rpc.slice(0, rpc.indexOf("returns"));
    expect(signature).toMatch(/\(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_schedule_proposal_digest text\)/);
    expect(rpc).not.toMatch(/p_team|p_pair|p_semifinal|p_final|p_scheduled|p_start|p_pitch|p_venue|p_zone|p_time|p_duration|p_capacity|p_format|p_draw|p_plan|p_now|p_actor|p_published/);
  });

  it("the operation decides in the documented order, under the one competition lock, with null-safe ownership and the existing host-revocation guard", () => {
    const rpc = body(code(), RPC);
    const order = [
      /perform pg_advisory_xact_lock\(hashtext\('competition_scope:' \|\| p_competition_id::text\)\)/, /for update/, /p_organizer_gaming_member_id is distinct from v_organizer_id/,
      /perform assert_competition_not_host_revoked\(p_competition_id\)/, /DIGEST_INVALID/, /proposal_digest = p_schedule_proposal_digest/,
      /already_published/, /v_now := competition_registration_clock\(\)/, /competition_schedule_eligibility_problem\(p_competition_id, v_now\)/, /competition_draw_verify\(/,
      /raise exception 'SCHEDULE_PUBLICATION_AMENDMENT_PENDING/, /raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_SUPERSEDED/, /raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_STALE/,
      /competition_schedule_proposal_verify\(/, /competition_schedule_evaluate\(/,
      /insert into competition_fixtures/, /insert into competition_schedule_publications/, /update competitions/,
    ];
    let previous = -1;
    for (const step of order) {
      const at = rpc.search(step);
      expect(at, String(step)).toBeGreaterThan(-1);
      expect(at, `${String(step)} comes after the previous step`).toBeGreaterThan(previous);
      previous = at;
    }
    expect(rpc).not.toMatch(/gaming_member_id\s*(<>|!=)/);
    expect(rpc).not.toMatch(/(<>|!=)\s*[a-z_.]*gaming_member_id/);
  });

  it("creates exactly three fixtures from the draw's positions and the proposal's instants, with the final's slots unresolved and its sources the two semifinals", () => {
    const rpc = body(code(), RPC);
    expect(rpc.match(/insert into competition_fixtures/g)).toHaveLength(3);
    expect(rpc).toMatch(/draw_position = 1/);
    expect(rpc).toMatch(/draw_position = 2/);
    expect(rpc).toMatch(/draw_position = 3/);
    expect(rpc).toMatch(/draw_position = 4/);
    expect(rpc).toMatch(/team_a_source_fixture_id, team_b_source_fixture_id/);
    expect(rpc).toMatch(/'SCHEDULED'/);
    expect(rpc.match(/update competitions/g)).toHaveLength(1);
    expect(rpc).toMatch(/set state = 'PUBLISHED', published_at = v_now/);
    expect(rpc).not.toMatch(/\bnow\s*\(\s*\)/i);
    expect(rpc).not.toMatch(/clock_timestamp|current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/i);
  });

  it("uses no weak or external randomness and no wall clock in the new objects: only the accepted clock seam", () => {
    const sql = code();
    const withoutLegacy = sql.replace(body(sql, "publish_competition_atomically"), "");
    for (const pattern of [/\brandom\s*\(/i, /setseed/i, /tablesample/i, /order by\s+random/i, /gen_random_bytes/i, /pgcrypto/i, /create extension/i, /uuid_generate/i, /dblink|http_|pg_net|plv8|plpython/i,
      /\bnow\s*\(\s*\)/i, /clock_timestamp\s*\(/i, /current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/i]) {
      expect(withoutLegacy, String(pattern)).not.toMatch(pattern);
    }
  });

  it("writes only the publication's own table, the three fixtures and the one state transition; adds no group, standing, bye, third-place, rescheduling, notification or payment structure; names no format", () => {
    const sql = code();
    const withoutLegacy = sql.replace(body(sql, "publish_competition_atomically"), "");
    expect([...new Set([...withoutLegacy.matchAll(/insert into (\w+)/g)].map((m) => m[1]))].sort()).toEqual(["competition_fixtures", TABLE].sort());
    expect([...new Set([...withoutLegacy.matchAll(/update (\w+)\s+set/g)].map((m) => m[1]))]).toEqual(["competitions"]);
    expect(withoutLegacy).not.toMatch(/delete from/i);
    expect(withoutLegacy).not.toMatch(/reschedul|notif|payment|invoice|standing|bye\b|third_place|group_stage|webhook|email|appeal|adjudicat/i);
    expect(sql).not.toMatch(/SOCCER_[5-8]V[5-8]/);
  });

  it("every comparison of a member identifier is null-safe throughout: none uses a bare <> or != (the repository-wide authorization rule the live catalog scan also enforces)", () => {
    const sql = code();
    expect(sql).not.toMatch(/gaming_member_id\s*(<>|!=)/);
    expect(sql).not.toMatch(/(<>|!=)\s*[a-z_.]*gaming_member_id/);
  });
});

describe("the new tests are registered in the explicit lists", () => {
  it("package.json runs this file in the ordinary suite and the contract file in the contract suite", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toContain("__tests__/competitionSchedulePublication.test.ts");
    expect(scripts["test:contract"]).toContain("__tests__/competitionSchedulePublicationSupabase.contract.test.ts");
    expect(scripts["test:contract"]).not.toContain("competitionSchedulePublication.test.ts");
    expect(scripts.test).not.toContain("competitionSchedulePublicationSupabase");
  });
});
