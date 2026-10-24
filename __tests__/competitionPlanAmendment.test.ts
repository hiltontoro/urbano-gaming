import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks the ONE module boundary between a route and the outside world (credentials, repository construction, caller identity), exactly as
// competitions.test.ts does; statusForCompetitionsError and the schema-ready guard keep their REAL implementation.
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
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import type { CompetitionsRepository } from "../lib/gaming/competitions/db/competitionsRepository";
import type { CompetitionPlanningRevisionRecord } from "../lib/gaming/competitions/types";
import { HostAccessRevokedError } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-011 — Post-Freeze Plan Amendment backend foundation: the application side.
 *
 * Every DECISION (who may propose, who may confirm, the window, the clock, the activation) is made inside the atomic database operations and is
 * proved against a real database in competitionPlanAmendmentSupabase.contract.test.ts. This file proves what the application adds on top, and that it
 * adds nothing it should not: the allowlist of what a proposal may carry, the digest, the typed refusals and their stable codes, the routes' uniform
 * non-enumerating answers, and the one bounded signal the addressed view carries for a later page gate.
 *
 * The module under test is loaded lazily so that, before it exists, every test here fails for the behavior it is missing and not because the file
 * could not be collected.
 */

const loadAmend = () => import("../lib/gaming/competitions/planAmendment");
const loadPlanning = () => import("../lib/gaming/competitions/planning");

const CID = "11111111-1111-4111-8111-111111111111";
const BASE_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZER = "00000000-0000-4000-8000-0000000000a1";
const CAPTAIN = "00000000-0000-4000-8000-0000000000c1";
const STRANGER = "00000000-0000-4000-8000-0000000000d9";
const INTENT = "33333333-3333-4333-8333-333333333333";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const randomUuid = () => randomUUID();
const FREEZE_DIGEST = sha("freeze");
const SNAPSHOT = "Draft planning rules.";

function baseRevision(over: Partial<CompetitionPlanningRevisionRecord> = {}): CompetitionPlanningRevisionRecord {
  return {
    planningRevisionId: BASE_ID, competitionId: CID, formatKey: "SOCCER_5V5", revisionNumber: 2, supersedesRevisionNumber: 1,
    authoredByGamingMemberId: ORGANIZER, createdAt: "2026-10-23T10:00:00.000Z",
    venue: { name: "Cancha Vieja", locationDescription: "Calle 5, San José", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "" },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: "2026-10-31T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-01T00:00:00.000Z" },
    rules: { version: "draft-1", snapshot: SNAPSHOT, snapshotDigest: sha(SNAPSHOT) },
    ...over,
  };
}

/** What a proposal may carry — and nothing else. */
const AMENDMENT = () => ({
  venue: { name: "Cancha Nueva", locationDescription: "Calle 9, San José\nbehind the market", restrictionNotes: "No metal cleats.", simultaneousMatchCapacity: 1 },
  pitches: [
    { label: "A", usable: true, supportedFormats: ["SOCCER_6V6", "SOCCER_5V5"], restrictionNotes: "" },
    { label: "B", usable: false, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "Lights off after 21:00." },
  ],
  dates: [
    { date: "2026-11-08", windows: [{ start: "15:00", end: "19:00" }, { start: "09:00", end: "13:00" }] },
    { date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }] },
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the amendment digest: deterministic, order-independent where the facts are unordered, and sensitive to every fact it binds", () => {
  // The same plan, spelled in the application's own shape (the amended facts composed over the base revision's preserved ones).
  async function digestInput(over: Record<string, unknown> = {}) {
    const { composeAmendedPlan } = await loadAmend();
    const { plan } = composeAmendedPlan(baseRevision(), AMENDMENT());
    return { competitionId: CID, freezeDigest: FREEZE_DIGEST, baseRevisionId: BASE_ID, sequenceNumber: 3, formatKey: "SOCCER_5V5" as const, plan, ...over };
  }
  // Computed independently (Python hashlib) from the canonical text in planAmendment.ts's header; this pins the format forever. The database function must
  // return the same value for the same facts (the contract test checks that against a real database).
  const KNOWN_ANSWER = "808d065b2ba21925099be3858cbcf4a7e5cbe537073f4184881e8065e9a2f429";

  it("matches an independently computed known answer", async () => {
    const { computePlanAmendmentDigest } = await loadAmend();
    expect(computePlanAmendmentDigest(await digestInput())).toBe(KNOWN_ANSWER);
  });

  it("does not depend on the order dates, windows and supported formats arrive in", async () => {
    const { computePlanAmendmentDigest } = await loadAmend();
    const a = await digestInput();
    const shuffled = await digestInput();
    shuffled.plan.dates.reverse();
    for (const d of shuffled.plan.dates) d.windows.reverse();
    for (const p of shuffled.plan.pitches) p.supportedFormats.reverse();
    expect(computePlanAmendmentDigest(shuffled)).toBe(computePlanAmendmentDigest(a));
    expect(computePlanAmendmentDigest(shuffled)).toBe(KNOWN_ANSWER);
  });

  it("changes when any one bound fact changes — including the sequence, the freeze, the base revision and the order of the pitches", async () => {
    const { computePlanAmendmentDigest } = await loadAmend();
    const mutations: Array<[string, (i: Awaited<ReturnType<typeof digestInput>>) => void]> = [
      ["competition", (i) => { i.competitionId = "11111111-1111-4111-8111-111111111112"; }],
      ["freeze digest", (i) => { i.freezeDigest = sha("another freeze"); }],
      ["base revision", (i) => { i.baseRevisionId = "22222222-2222-4222-8222-222222222223"; }],
      ["sequence", (i) => { i.sequenceNumber = 4; }],
      ["venue name", (i) => { i.plan.venue.name = "Cancha Vieja"; }],
      ["venue location", (i) => { i.plan.venue.locationDescription = "elsewhere"; }],
      ["venue notes", (i) => { i.plan.venue.restrictionNotes = ""; }],
      ["capacity", (i) => { i.plan.venue.simultaneousMatchCapacity = 2; }],
      ["a pitch label", (i) => { i.plan.pitches[0].label = "Z"; }],
      ["a pitch usability", (i) => { i.plan.pitches[0].usable = false; }],
      ["a pitch note", (i) => { i.plan.pitches[0].restrictionNotes = "wet"; }],
      ["a supported format", (i) => { i.plan.pitches[0].supportedFormats = ["SOCCER_5V5"]; }],
      ["the pitch order", (i) => { i.plan.pitches.reverse(); }],
      ["a date", (i) => { i.plan.dates[0].date = "2026-11-09"; }],
      ["a window", (i) => { i.plan.dates[0].windows[0].end = "12:00"; }],
      ["the preserved roster", (i) => { i.plan.roster.maximum = 9; }],
      ["the preserved deadline", (i) => { i.plan.registrationDeadline.utc = "2026-11-01T00:00:00.001Z"; }],
      ["the preserved rules", (i) => { i.plan.rules.snapshot = "Other rules."; }],
      ["the preserved time zone", (i) => { i.plan.venue.timeZone = "America/Chicago"; }],
    ];
    for (const [label, mutate] of mutations) {
      const input = await digestInput();
      mutate(input);
      expect(computePlanAmendmentDigest(input), label).not.toBe(KNOWN_ANSWER);
    }
  });

  it("is a lowercase hex SHA-256, and free text is hashed so that no separator in a name can move a line", async () => {
    const { computePlanAmendmentDigest } = await loadAmend();
    const input = await digestInput();
    expect(computePlanAmendmentDigest(input)).toMatch(/^[0-9a-f]{64}$/);
    const hostile = await digestInput();
    hostile.plan.venue.name = "x\nsequence:99\nformat:SOCCER_8V8";
    expect(computePlanAmendmentDigest(hostile)).not.toBe(computePlanAmendmentDigest(input));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a proposal may carry
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the proposal allowlist: only the amendable sections are accepted, and the preserved facts always come from the current revision", () => {
  const IMMUTABLE_NAMES = [
    "format", "formatKey", "activityKey", "competitionFormat", "roster", "rosterMinimum", "rosterMaximum", "registrationDeadline", "deadline", "rules", "rulesVersion",
    "rulesSnapshot", "teams", "captains", "members", "competitionId", "status", "digest", "amendmentDigest", "sequenceNumber", "expiresAt", "createdAt", "now", "freeze",
  ];

  it("accepts exactly venue (name, locationDescription, restrictionNotes, simultaneousMatchCapacity), pitches and dates", async () => {
    const { parsePlanAmendmentRequest } = await loadAmend();
    const parsed = parsePlanAmendmentRequest({ intentId: INTENT, amendment: AMENDMENT() });
    expect(parsed.intentId).toBe(INTENT);
    expect(Object.keys(parsed).sort()).toEqual(["amendment", "intentId"]);
    expect(Object.keys(AMENDMENT()).sort()).toEqual(["dates", "pitches", "venue"]);
  });

  it("refuses the venue time zone and every preserved or system field by name, at every level, and says which", async () => {
    const { composeAmendedPlan, PlanAmendmentValidationError } = await loadAmend();
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["venue.timeZone", { ...AMENDMENT(), venue: { ...AMENDMENT().venue, timeZone: "America/Chicago" } }],
      ...IMMUTABLE_NAMES.map((name): [string, Record<string, unknown>] => [name, { ...AMENDMENT(), [name]: name === "roster" ? { minimum: 6, maximum: 9 } : "x" }]),
      ...IMMUTABLE_NAMES.map((name): [string, Record<string, unknown>] => [`venue.${name}`, { ...AMENDMENT(), venue: { ...AMENDMENT().venue, [name]: "x" } }]),
    ];
    for (const [label, body] of attempts) {
      let caught: unknown = null;
      try { composeAmendedPlan(baseRevision(), body); } catch (err) { caught = err; }
      expect(caught, label).toBeInstanceOf(PlanAmendmentValidationError);
      const codes = (caught as InstanceType<typeof PlanAmendmentValidationError>).violations.map((v) => v.code);
      expect(codes.some((c) => c === "IMMUTABLE_FIELD" || c === "UNKNOWN_FIELD"), `${label}: ${codes.join(",")}`).toBe(true);
    }
    // The ones that are preserved facts are named as such, not as unknown.
    for (const name of ["roster", "registrationDeadline", "rules", "format", "teams", "captains", "members"]) {
      let caught: any = null;
      try { composeAmendedPlan(baseRevision(), { ...AMENDMENT(), [name]: {} }); } catch (err) { caught = err; }
      expect(caught.violations.map((v: { code: string }) => v.code), name).toContain("IMMUTABLE_FIELD");
    }
  });

  it("refuses any request field beyond the intent and the amendment (a client cannot name an organizer, a time, a status or a digest)", async () => {
    const { parsePlanAmendmentRequest, PlanAmendmentValidationError } = await loadAmend();
    for (const extra of ["organizerGamingMemberId", "gamingMemberId", "now", "state", "status", "digest", "expiresAt", "format", "baseRevision", "freeze"]) {
      let caught: unknown = null;
      try { parsePlanAmendmentRequest({ intentId: INTENT, amendment: AMENDMENT(), [extra]: "x" }); } catch (err) { caught = err; }
      expect(caught, extra).toBeInstanceOf(PlanAmendmentValidationError);
    }
    for (const bad of [null, "x", 7, [], {}, { amendment: AMENDMENT() }, { intentId: "not-a-uuid", amendment: AMENDMENT() }, { intentId: INTENT }, { intentId: INTENT, amendment: "x" }, { intentId: INTENT, amendment: [] }]) {
      expect(() => parsePlanAmendmentRequest(bad), JSON.stringify(bad)).toThrow(PlanAmendmentValidationError);
    }
  });

  it("composes the complete plan from the CURRENT revision: every preserved fact is the revision's own, and the result is a valid plan", async () => {
    const { composeAmendedPlan } = await loadAmend();
    const { parsePlanningPlan } = await loadPlanning();
    const base = baseRevision();
    const { plan, facts } = composeAmendedPlan(base, AMENDMENT());
    expect(plan.venue.timeZone).toBe(base.venue.timeZone);
    expect(plan.roster).toEqual(base.roster);
    expect(plan.registrationDeadline).toEqual(base.registrationDeadline);
    expect(plan.rules).toEqual({ version: base.rules.version, snapshot: base.rules.snapshot });
    expect(plan.venue.name).toBe("Cancha Nueva");
    expect(facts.dates.map((d) => d.date)).toEqual(["2026-11-07", "2026-11-08"]);
    expect(facts.dates[1].windows.map((w) => w.start)).toEqual(["09:00", "15:00"]);
    expect(Object.keys(facts).sort()).toEqual(["dates", "pitches", "venue"]);
    expect(Object.keys(facts.venue).sort()).toEqual(["locationDescription", "name", "restrictionNotes", "simultaneousMatchCapacity"]);
    // The very same validator the DRAFT editor uses accepts the composed plan (nothing is judged by a second, looser rule set).
    expect(() => parsePlanningPlan(JSON.parse(JSON.stringify(plan)), "SOCCER_5V5")).not.toThrow();
  });

  it("judges the amendable facts with the planning validator: counts, span, overlap, midnight, capacity and format support are all refused with the planning codes", async () => {
    const { composeAmendedPlan, PlanAmendmentValidationError } = await loadAmend();
    const bad = (mutate: (a: ReturnType<typeof AMENDMENT>) => void) => { const a = AMENDMENT(); mutate(a); return a; };
    const cases: Array<[string, ReturnType<typeof AMENDMENT>, string]> = [
      ["four dates", bad((a) => { a.dates = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"].map((date) => ({ date, windows: [{ start: "09:00", end: "10:00" }] })); }), "DATE_COUNT_INVALID"],
      ["a span over fourteen days", bad((a) => { a.dates = [{ date: "2026-11-07", windows: [{ start: "09:00", end: "10:00" }] }, { date: "2026-11-21", windows: [{ start: "09:00", end: "10:00" }] }]; }), "DATE_SPAN_TOO_LONG"],
      ["overlapping windows", bad((a) => { a.dates[1].windows = [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }]; }), "WINDOW_OVERLAP"],
      ["a window across midnight", bad((a) => { a.dates[1].windows = [{ start: "22:00", end: "02:00" }]; }), "WINDOW_CROSSES_MIDNIGHT"],
      ["three windows on one date", bad((a) => { a.dates[1].windows = [{ start: "08:00", end: "09:00" }, { start: "10:00", end: "11:00" }, { start: "12:00", end: "13:00" }]; }), "WINDOW_COUNT_INVALID"],
      ["capacity above the usable pitches", bad((a) => { a.venue.simultaneousMatchCapacity = 2; a.pitches[0].usable = true; a.pitches[1].usable = false; }), "CAPACITY_INVALID"],
      ["no pitch that supports the competition's format", bad((a) => { a.pitches = [{ label: "A", usable: true, supportedFormats: ["SOCCER_6V6"], restrictionNotes: "" }]; a.venue.simultaneousMatchCapacity = 1; }), "FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH"],
      ["a window that starts before the registration deadline closed", bad((a) => { a.dates = [{ date: "2026-10-31", windows: [{ start: "09:00", end: "10:00" }] }]; }), "DEADLINE_NOT_BEFORE_FIRST_WINDOW"],
    ];
    for (const [label, body, code] of cases) {
      let caught: any = null;
      try { composeAmendedPlan(baseRevision(), body); } catch (err) { caught = err; }
      expect(caught, label).toBeInstanceOf(PlanAmendmentValidationError);
      expect(caught.violations.map((v: { code: string }) => v.code), label).toContain(code);
    }
  });

  it("refuses a local time that a clock change skips or repeats, in the venue's own (preserved) time zone", async () => {
    const { composeAmendedPlan, PlanAmendmentValidationError } = await loadAmend();
    const ny = baseRevision({
      venue: { name: "Field", locationDescription: "Queens", timeZone: "America/New_York", simultaneousMatchCapacity: 1, restrictionNotes: "" },
      registrationDeadline: { local: "2026-02-20T12:00", timeZone: "America/New_York", utcOffset: "-05:00", utc: "2026-02-20T17:00:00.000Z" },
    });
    const at = (date: string, start: string, end: string) => ({ ...AMENDMENT(), pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }], venue: { ...AMENDMENT().venue, simultaneousMatchCapacity: 1 }, dates: [{ date, windows: [{ start, end }] }] });
    for (const [label, body, code] of [
      ["nonexistent (spring forward)", at("2026-03-08", "02:30", "03:30"), "WINDOW_NONEXISTENT_LOCAL_TIME"],
      ["ambiguous (fall back)", at("2026-11-01", "01:30", "03:00"), "WINDOW_AMBIGUOUS_LOCAL_TIME"],
    ] as const) {
      let caught: any = null;
      try { composeAmendedPlan(ny, body); } catch (err) { caught = err; }
      expect(caught, label).toBeInstanceOf(PlanAmendmentValidationError);
      expect(caught.violations.map((v: { code: string }) => v.code), label).toContain(code);
    }
    expect(() => composeAmendedPlan(ny, at("2026-03-09", "09:00", "11:00"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the database's refusals become typed errors with stable codes and bounded wording", () => {
  const MAP: Array<[string, string, string]> = [
    ["PLAN_AMENDMENT_NOT_AVAILABLE: no plan amendment is available", "NOT_AVAILABLE", "NotAvailable"],
    ["PLAN_AMENDMENT_WINDOW_CLOSED: the amendment window is closed", "WINDOW_CLOSED", "WindowClosed"],
    ["PLAN_AMENDMENT_LEAD_TIME: too close", "LEAD_TIME", "LeadTime"],
    ["PLAN_AMENDMENT_STALE: stale", "STALE", "Stale"],
    ["PLAN_AMENDMENT_EXPIRED: expired", "EXPIRED", "Expired"],
    ["PLAN_AMENDMENT_NOT_PENDING: not pending", "NOT_PENDING", "NotPending"],
    ["PLAN_AMENDMENT_DECISION_CONFLICT: conflict", "DECISION_CONFLICT", "DecisionConflict"],
    ["PLAN_AMENDMENT_INTENT_MISMATCH: mismatch", "INTENT_MISMATCH", "IntentMismatch"],
    ["PLAN_AMENDMENT_FREEZE_INCONSISTENT: inconsistent", "FREEZE_INCONSISTENT", "FreezeInconsistent"],
  ];

  it.each(MAP)("%s -> %s", async (message, code) => {
    const { planAmendmentErrorFromDatabase } = await loadAmend();
    const err = planAmendmentErrorFromDatabase(message) as (Error & { code?: string }) | null;
    expect(err).not.toBeNull();
    expect(err!.code).toBe(code);
    // The database's own words never reach the browser: the wording is the application's.
    expect(err!.message).not.toContain("PLAN_AMENDMENT_");
    expect(err!.message.length).toBeLessThan(200);
  });

  it("returns null for anything that is not one of its own refusals, and reports an invalid input as a validation error", async () => {
    const { planAmendmentErrorFromDatabase, PlanAmendmentValidationError } = await loadAmend();
    expect(planAmendmentErrorFromDatabase("COMPETITION_ACCESS_DENIED: x")).toBeNull();
    expect(planAmendmentErrorFromDatabase("")).toBeNull();
    const invalid = planAmendmentErrorFromDatabase("PLAN_AMENDMENT_INVALID: IMMUTABLE_FIELD: the time zone cannot be amended");
    expect(invalid).toBeInstanceOf(PlanAmendmentValidationError);
    expect((invalid as InstanceType<typeof PlanAmendmentValidationError>).violations[0].code).toBe("IMMUTABLE_FIELD");
  });

  it("the repository's translateError gives each one its typed error, and keeps the existing codes", async () => {
    const { translateError } = await import("../lib/gaming/competitions/db/supabaseCompetitionsRepository");
    const { PlanAmendmentStaleError, PlanAmendmentNotAvailableError } = await loadAmend();
    expect(translateError({ code: "P0001", message: "PLAN_AMENDMENT_STALE: x" })).toBeInstanceOf(PlanAmendmentStaleError);
    expect(translateError({ code: "P0001", message: "PLAN_AMENDMENT_NOT_AVAILABLE: x" })).toBeInstanceOf(PlanAmendmentNotAvailableError);
    expect(translateError({ code: "P0001", message: "COMPETITION_NOT_FOUND: x" }).name).toBe("CompetitionNotFoundError");
    expect(translateError({ code: "P0001", message: "HOST_ACCESS_REVOKED: x" }).name).toBe("HostAccessRevokedError");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

function makeRepo() {
  const names = ["getCompetitionById", "getCurrentPlanningRevision", "proposePlanAmendment", "decidePlanAmendment", "withdrawPlanAmendment", "getPlanAmendmentStatus"];
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
}
const competition = (over: Record<string, unknown> = {}) => ({
  competitionId: CID, publicCode: "AbCdEfGhIjKlMnOpQrStUv", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: ORGANIZER, state: "READY_TO_PUBLISH",
  cancelledReason: null, createdAt: "x", publishedAt: null, hostBound: false, hostAccessRevoked: false, ...over,
});

describe("the commands: who is told what, and what reaches the database", () => {
  it("propose: a caller who is not the active organizer gets the uniform not-available BEFORE the amendment is read, and nothing is sent", async () => {
    const { proposeCompetitionPlanAmendment, PlanAmendmentNotAvailableError } = await loadAmend();
    for (const [label, comp] of [["a stranger", competition()], ["a revoked host", competition({ hostBound: true, hostAccessRevoked: true, organizerGamingMemberId: STRANGER })], ["no such competition", null]] as const) {
      const repo = makeRepo();
      repo.getCompetitionById.mockResolvedValue(comp);
      const garbage = { venue: "not even an object", timeZone: "x" };
      await expect(proposeCompetitionPlanAmendment(repo as never, CID, STRANGER, INTENT, garbage), label).rejects.toBeInstanceOf(PlanAmendmentNotAvailableError);
      expect(repo.getCurrentPlanningRevision, label).not.toHaveBeenCalled();
      expect(repo.proposePlanAmendment, label).not.toHaveBeenCalled();
    }
  });

  it("propose: a competition that has not yet reached the freeze can never have recorded a proposal, so the organizer hears so locally and nothing is sent", async () => {
    const { proposeCompetitionPlanAmendment, PlanAmendmentWindowClosedError } = await loadAmend();
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN"]) {
      const repo = makeRepo();
      repo.getCompetitionById.mockResolvedValue(competition({ state }));
      await expect(proposeCompetitionPlanAmendment(repo as never, CID, ORGANIZER, INTENT, AMENDMENT()), state).rejects.toBeInstanceOf(PlanAmendmentWindowClosedError);
      expect(repo.proposePlanAmendment, state).not.toHaveBeenCalled();
    }
  });

  it("propose: once the competition has left READY_TO_PUBLISH an exact retry may still be recorded, so the database is asked — it returns the recorded result or the window refusal", async () => {
    const { proposeCompetitionPlanAmendment, PlanAmendmentWindowClosedError, planAmendmentErrorFromDatabase } = await loadAmend();
    const recorded = { digest: sha("d"), sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: true, supersededDigest: null };
    for (const state of ["PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      const repo = makeRepo();
      repo.getCompetitionById.mockResolvedValue(competition({ state }));
      repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
      repo.proposePlanAmendment.mockResolvedValueOnce(recorded);
      expect(await proposeCompetitionPlanAmendment(repo as never, CID, ORGANIZER, INTENT, AMENDMENT()), state).toEqual(recorded);
      repo.proposePlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase("PLAN_AMENDMENT_WINDOW_CLOSED: x"));
      await expect(proposeCompetitionPlanAmendment(repo as never, CID, ORGANIZER, randomUuid(), AMENDMENT()), state).rejects.toBeInstanceOf(PlanAmendmentWindowClosedError);
      expect(repo.proposePlanAmendment, state).toHaveBeenCalledTimes(2);
    }
  });

  it("propose: the amendment is judged against the current revision, and only the amendable sections reach the database — never a preserved fact", async () => {
    const { proposeCompetitionPlanAmendment } = await loadAmend();
    const repo = makeRepo();
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
    repo.proposePlanAmendment.mockResolvedValue({ digest: sha("d"), sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: false, supersededDigest: null });
    const result = await proposeCompetitionPlanAmendment(repo as never, CID, ORGANIZER, INTENT, AMENDMENT());
    expect(repo.proposePlanAmendment).toHaveBeenCalledTimes(1);
    const [competitionId, organizerId, intentId, payload] = repo.proposePlanAmendment.mock.calls[0];
    expect([competitionId, organizerId, intentId]).toEqual([CID, ORGANIZER, INTENT]);
    expect(Object.keys(payload).sort()).toEqual(["dates", "pitches", "venue"]);
    expect(Object.keys(payload.venue).sort()).toEqual(["locationDescription", "name", "restrictionNotes", "simultaneousMatchCapacity"]);
    expect(JSON.stringify(payload)).not.toMatch(/timeZone|roster|registrationDeadline|rules|utc/i);
    expect(result.digest).toBe(sha("d"));
  });

  it("propose: an invalid amendment is refused with every problem found, before the database is asked", async () => {
    const { proposeCompetitionPlanAmendment, PlanAmendmentValidationError } = await loadAmend();
    const repo = makeRepo();
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
    const bad = { ...AMENDMENT(), venue: { ...AMENDMENT().venue, name: "" } };
    await expect(proposeCompetitionPlanAmendment(repo as never, CID, ORGANIZER, INTENT, bad)).rejects.toBeInstanceOf(PlanAmendmentValidationError);
    expect(repo.proposePlanAmendment).not.toHaveBeenCalled();
  });

  it("decide: the digest must be a SHA-256 and the decision exactly CONFIRMED or REJECTED; the actor is only ever the verified caller", async () => {
    const { decideCompetitionPlanAmendment, parsePlanAmendmentDecisionRequest, PlanAmendmentValidationError } = await loadAmend();
    expect(parsePlanAmendmentDecisionRequest({ amendmentDigest: sha("x"), decision: "CONFIRMED" })).toEqual({ amendmentDigest: sha("x"), decision: "CONFIRMED" });
    expect(parsePlanAmendmentDecisionRequest({ amendmentDigest: sha("x"), decision: "REJECTED" }).decision).toBe("REJECTED");
    for (const bad of [null, {}, { amendmentDigest: sha("x") }, { decision: "CONFIRMED" }, { amendmentDigest: "short", decision: "CONFIRMED" }, { amendmentDigest: sha("x").toUpperCase(), decision: "CONFIRMED" },
      { amendmentDigest: sha("x"), decision: "confirmed" }, { amendmentDigest: sha("x"), decision: "APPROVE" }, { amendmentDigest: sha("x"), decision: true },
      { amendmentDigest: sha("x"), decision: "CONFIRMED", captainGamingMemberId: STRANGER }, { amendmentDigest: sha("x"), decision: "CONFIRMED", now: "2020-01-01T00:00:00Z" }]) {
      expect(() => parsePlanAmendmentDecisionRequest(bad), JSON.stringify(bad)).toThrow(PlanAmendmentValidationError);
    }
    const repo = makeRepo();
    repo.decidePlanAmendment.mockResolvedValue({ decision: "CONFIRMED", status: "PENDING", confirmedCount: 1, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: null });
    await decideCompetitionPlanAmendment(repo as never, CID, CAPTAIN, sha("x"), "CONFIRMED");
    expect(repo.decidePlanAmendment).toHaveBeenCalledWith(CID, CAPTAIN, sha("x"), "CONFIRMED");
  });

  it("withdraw: organizer-only (uniform not-available otherwise) and bound to the exact digest", async () => {
    const { withdrawCompetitionPlanAmendment, parsePlanAmendmentWithdrawRequest, PlanAmendmentNotAvailableError, PlanAmendmentValidationError } = await loadAmend();
    expect(parsePlanAmendmentWithdrawRequest({ amendmentDigest: sha("x") })).toEqual({ amendmentDigest: sha("x") });
    for (const bad of [null, {}, { amendmentDigest: "x" }, { amendmentDigest: sha("x"), extra: 1 }]) expect(() => parsePlanAmendmentWithdrawRequest(bad)).toThrow(PlanAmendmentValidationError);
    const repo = makeRepo();
    repo.getCompetitionById.mockResolvedValue(competition());
    await expect(withdrawCompetitionPlanAmendment(repo as never, CID, STRANGER, sha("x"))).rejects.toBeInstanceOf(PlanAmendmentNotAvailableError);
    expect(repo.withdrawPlanAmendment).not.toHaveBeenCalled();
    repo.withdrawPlanAmendment.mockResolvedValue({ status: "WITHDRAWN", alreadyWithdrawn: false });
    await withdrawCompetitionPlanAmendment(repo as never, CID, ORGANIZER, sha("x"));
    expect(repo.withdrawPlanAmendment).toHaveBeenCalledWith(CID, ORGANIZER, sha("x"));
  });

  it("read: the database answers for the caller (null for anyone unrelated), and nothing is read for a malformed competition", async () => {
    const { readCompetitionPlanAmendment } = await loadAmend();
    const repo = makeRepo();
    repo.getPlanAmendmentStatus.mockResolvedValue(null);
    expect(await readCompetitionPlanAmendment(repo as never, CID, STRANGER)).toBeNull();
    expect(repo.getPlanAmendmentStatus).toHaveBeenCalledWith(CID, STRANGER);
  });

  it("the public shape carries no amendment id, no internal id and no author, and nothing the caller's role does not allow", async () => {
    const { publicPlanAmendmentStatus } = await loadAmend();
    const facts = { venue: { name: "V", locationDescription: "L", restrictionNotes: "", simultaneousMatchCapacity: 1 }, pitches: [], dates: [] };
    const record = {
      role: { organizer: false, captain: true }, windowOpen: true, myTeamName: "Alpha",
      amendment: {
        digest: sha("d"), sequenceNumber: 2, status: "PENDING", actionable: true, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", resolvedAt: null,
        confirmedCount: 1, requiredCount: 4, teams: [{ teamName: "Alpha", decision: "CONFIRMED" }, { teamName: "Bravo", decision: null }], myDecision: "CONFIRMED", proposed: facts, current: facts,
      },
      history: null,
    };
    const shown = publicPlanAmendmentStatus(record as never);
    expect(JSON.stringify(shown)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(Object.keys(shown).sort()).toEqual(["amendment", "history", "myTeamName", "role", "windowOpen"]);
    expect(Object.keys(shown.amendment!).sort()).toEqual(["actionable", "confirmedCount", "createdAt", "current", "digest", "expiresAt", "myDecision", "proposed", "requiredCount", "resolvedAt", "sequenceNumber", "status", "teams"]);
  });

  it("a status never invites an action the server will refuse: actionable is false whenever the window is closed (the organizer's revocation, for one) or the proposal is not pending, whatever the payload said", async () => {
    const { planAmendmentStatusFromDatabase, publicPlanAmendmentStatus } = await loadAmend();
    const facts = { venue: { name: "V", location_description: "L", restriction_notes: "", simultaneous_match_capacity: 1 }, pitches: [], dates: [] };
    const payload = (over: { window_open: boolean; status: string; actionable: boolean }) => ({
      role: { organizer: false, captain: true }, window_open: over.window_open, my_team_name: "Alpha", history: null,
      amendment: {
        digest: sha("d"), sequence_number: 1, status: over.status, actionable: over.actionable, created_at: "2026-10-23T12:00:00.000Z", expires_at: "2026-10-24T12:00:00.000Z", resolved_at: null,
        confirmed_count: 1, required_count: 4, teams: [{ team_name: "Alpha", decision: "CONFIRMED" }], my_decision: "CONFIRMED", proposed: facts, current: facts,
      },
    });
    // The contradiction: a closed window (for instance after the organizer's revocation) reported together with an actionable proposal.
    const revoked = planAmendmentStatusFromDatabase(payload({ window_open: false, status: "PENDING", actionable: true }))!;
    expect([revoked.windowOpen, revoked.amendment!.actionable]).toEqual([false, false]);
    expect(publicPlanAmendmentStatus({ ...revoked, amendment: { ...revoked.amendment!, actionable: true } }).amendment!.actionable).toBe(false);
    // A proposal that is not pending is never actionable either.
    for (const status of ["ACTIVATED", "REJECTED", "WITHDRAWN", "SUPERSEDED", "EXPIRED"]) {
      expect(planAmendmentStatusFromDatabase(payload({ window_open: true, status, actionable: true }))!.amendment!.actionable, status).toBe(false);
    }
    // The control: an open window and a pending proposal stay actionable, so the rule is not simply "never".
    const open = planAmendmentStatusFromDatabase(payload({ window_open: true, status: "PENDING", actionable: true }))!;
    expect([open.windowOpen, open.amendment!.actionable, publicPlanAmendmentStatus(open).amendment!.actionable]).toEqual([true, true, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the routes: 401 first, one uniform not-available, bounded errors, no caching", () => {
  const ROUTES = {
    base: "../app/api/gaming/competitions/[competitionId]/plan-amendment/route",
    decision: "../app/api/gaming/competitions/[competitionId]/plan-amendment/decision/route",
    withdraw: "../app/api/gaming/competitions/[competitionId]/plan-amendment/withdraw/route",
  } as const;
  const ctx = (competitionId: string) => ({ params: { competitionId } });
  const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = () => new Request("http://localhost/x", { method: "GET" });
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

  it("exports exactly GET and POST on the base route, and POST only on the decision and withdraw routes", async () => {
    const base = (await import(/* @vite-ignore */ ROUTES.base)) as Record<string, unknown>;
    const decision = (await import(/* @vite-ignore */ ROUTES.decision)) as Record<string, unknown>;
    const withdraw = (await import(/* @vite-ignore */ ROUTES.withdraw)) as Record<string, unknown>;
    const methods = (m: Record<string, unknown>) => ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((k) => typeof m[k] === "function");
    expect(methods(base)).toEqual(["GET", "POST"]);
    expect(methods(decision)).toEqual(["POST"]);
    expect(methods(withdraw)).toEqual(["POST"]);
  });

  it("GET: unrelated callers, unknown competitions and malformed ids all get the one identical 404", async () => {
    const { GET } = (await import(/* @vite-ignore */ ROUTES.base)) as { GET: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    repo.getPlanAmendmentStatus.mockResolvedValue(null);
    const answers = [] as Array<[number, string, string | null]>;
    for (const id of [CID, "99999999-9999-4999-8999-999999999999", "not-a-uuid", ""]) {
      const res = await GET(get(), ctx(id));
      answers.push([res.status, await res.text(), res.headers.get("cache-control")]);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
    for (const a of answers) expect(a[2]).toMatch(/no-store/);
    expect(answers[0][1]).not.toMatch(/amendment is|venue|digest|organizer|captain/i);
  });

  it("GET: a related caller gets 200 with the bounded shape, uncached", async () => {
    const { GET } = (await import(/* @vite-ignore */ ROUTES.base)) as { GET: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    repo.getPlanAmendmentStatus.mockResolvedValue({ role: { organizer: true, captain: false }, windowOpen: true, myTeamName: null, amendment: null, history: [] });
    const res = await GET(get(), ctx(CID));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["amendment"]);
    expect(repo.getPlanAmendmentStatus).toHaveBeenCalledWith(CID, ORGANIZER);
  });

  it("GET after the organizer's revocation: a captain still reads the proposal, truthfully — the window is closed and nothing is actionable — even if the server record contradicted itself; the revoked organizer is told nothing", async () => {
    const { GET } = (await import(/* @vite-ignore */ ROUTES.base)) as { GET: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const facts = { venue: { name: "V", locationDescription: "L", restrictionNotes: "", simultaneousMatchCapacity: 1 }, pitches: [], dates: [] };
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: CAPTAIN });
    repo.getPlanAmendmentStatus.mockResolvedValue({
      role: { organizer: false, captain: true }, windowOpen: false, myTeamName: "Alpha", history: null,
      amendment: { digest: sha("d"), sequenceNumber: 1, status: "PENDING", actionable: true, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", resolvedAt: null,
        confirmedCount: 3, requiredCount: 4, teams: [{ teamName: "Alpha", decision: "CONFIRMED" }], myDecision: "CONFIRMED", proposed: facts, current: facts },
    });
    const res = await GET(get(), ctx(CID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect([body.amendment.windowOpen, body.amendment.amendment.actionable, body.amendment.amendment.status, body.amendment.amendment.confirmedCount]).toEqual([false, false, "PENDING", 3]);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    repo.getPlanAmendmentStatus.mockResolvedValue(null);
    expect((await GET(get(), ctx(CID))).status).toBe(404);
  });

  it("after the organizer's revocation every action answers the one uniform 404 and records nothing: a captain's decision, and the revoked host's proposal and withdrawal", async () => {
    const decision = (await import(/* @vite-ignore */ ROUTES.decision)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const base = (await import(/* @vite-ignore */ ROUTES.base)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const withdraw = (await import(/* @vite-ignore */ ROUTES.withdraw)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: CAPTAIN });
    repo.decidePlanAmendment.mockRejectedValue(new HostAccessRevokedError());
    const refused = await decision.POST(post({ amendmentDigest: sha("x"), decision: "CONFIRMED" }), ctx(CID));
    const refusedText = await refused.text();
    expect(refused.status).toBe(404);
    expect(refusedText).not.toMatch(/revok|host/i);
    // The revoked host: the application never even reaches the database.
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    repo.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    const proposed = await base.POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID));
    const withdrawn = await withdraw.POST(post({ amendmentDigest: sha("x") }), ctx(CID));
    expect([proposed.status, withdrawn.status]).toEqual([404, 404]);
    expect(await proposed.text()).toBe(refusedText);
    expect(repo.proposePlanAmendment).not.toHaveBeenCalled();
    expect(repo.withdrawPlanAmendment).not.toHaveBeenCalled();
  });

  it("POST propose after the competition has left READY_TO_PUBLISH: an exact retry is a 200 with the recorded proposal; a new proposal is the coded 409", async () => {
    const { POST } = (await import(/* @vite-ignore */ ROUTES.base)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const { planAmendmentErrorFromDatabase } = await loadAmend();
    repo.getCompetitionById.mockResolvedValue(competition({ state: "PUBLISHED" }));
    repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
    repo.proposePlanAmendment.mockResolvedValueOnce({ digest: sha("d"), sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: true, supersededDigest: null });
    const retry = await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID));
    expect(retry.status).toBe(200);
    expect((await retry.json()).amendment.alreadyProposed).toBe(true);
    repo.proposePlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase("PLAN_AMENDMENT_WINDOW_CLOSED: x"));
    const fresh = await POST(post({ intentId: randomUuid(), amendment: AMENDMENT() }), ctx(CID));
    expect([fresh.status, (await fresh.json()).code]).toEqual([409, "WINDOW_CLOSED"]);
  });

  it("signed out is a 401 before the repository is touched, on every route", async () => {
    const base = (await import(/* @vite-ignore */ ROUTES.base)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    const decision = (await import(/* @vite-ignore */ ROUTES.decision)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    const withdraw = (await import(/* @vite-ignore */ ROUTES.withdraw)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) } as never);
    const calls: Array<Promise<Response>> = [base.GET(get(), ctx(CID)), base.POST(post({}), ctx(CID)), decision.POST(post({}), ctx(CID)), withdraw.POST(post({}), ctx(CID))];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
    expect(repo.getPlanAmendmentStatus).not.toHaveBeenCalled();
  });

  it("with readiness disabled every route answers 503 without authenticating", async () => {
    delete process.env.COMPETITIONS_SCHEMA_READY;
    const base = (await import(/* @vite-ignore */ ROUTES.base)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    const decision = (await import(/* @vite-ignore */ ROUTES.decision)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    const withdraw = (await import(/* @vite-ignore */ ROUTES.withdraw)) as Record<string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>>;
    for (const res of await Promise.all([base.GET(get(), ctx(CID)), base.POST(post({}), ctx(CID)), decision.POST(post({}), ctx(CID)), withdraw.POST(post({}), ctx(CID))])) expect(res.status).toBe(503);
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
  });

  it("POST propose: 201 for a new proposal, 200 for an exact replay; the organizer is always the verified caller; a body that names anyone else is refused", async () => {
    const { POST } = (await import(/* @vite-ignore */ ROUTES.base)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
    const result = { digest: sha("d"), sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: false, supersededDigest: null };
    repo.proposePlanAmendment.mockResolvedValue(result);
    const created = await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    const body = await created.json();
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(body.amendment.digest).toBe(sha("d"));
    repo.proposePlanAmendment.mockResolvedValue({ ...result, alreadyProposed: true });
    expect((await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID))).status).toBe(200);
    const impostor = await POST(post({ intentId: INTENT, amendment: AMENDMENT(), organizerGamingMemberId: STRANGER }), ctx(CID));
    expect(impostor.status).toBe(400);
    expect(repo.proposePlanAmendment.mock.calls.every((c) => c[1] === ORGANIZER)).toBe(true);
  });

  it("POST propose: a non-organizer gets the same 404 as an unknown competition; a refusal for the organizer is a bounded, coded 409; invalid input is a 400 with every problem", async () => {
    const { POST } = (await import(/* @vite-ignore */ ROUTES.base)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: STRANGER });
    repo.getCompetitionById.mockResolvedValue(competition());
    const stranger = await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID));
    repo.getCompetitionById.mockResolvedValue(null);
    const unknown = await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx("99999999-9999-4999-8999-999999999999"));
    expect([stranger.status, unknown.status]).toEqual([404, 404]);
    expect(await stranger.text()).toBe(await unknown.text());

    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.getCurrentPlanningRevision.mockResolvedValue(baseRevision());
    const { planAmendmentErrorFromDatabase } = await loadAmend();
    for (const [message, code] of [["PLAN_AMENDMENT_LEAD_TIME: x", "LEAD_TIME"], ["PLAN_AMENDMENT_WINDOW_CLOSED: x", "WINDOW_CLOSED"], ["PLAN_AMENDMENT_INTENT_MISMATCH: x", "INTENT_MISMATCH"], ["PLAN_AMENDMENT_FREEZE_INCONSISTENT: x", "FREEZE_INCONSISTENT"]] as const) {
      repo.proposePlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase(message));
      const res = await POST(post({ intentId: INTENT, amendment: AMENDMENT() }), ctx(CID));
      expect(res.status, code).toBe(409);
      const body = await res.json();
      expect(body.code, code).toBe(code);
      expect(body.error).not.toContain("PLAN_AMENDMENT_");
    }
    const invalid = await POST(post({ intentId: INTENT, amendment: { ...AMENDMENT(), venue: { ...AMENDMENT().venue, name: "" } } }), ctx(CID));
    expect(invalid.status).toBe(400);
    expect(Array.isArray((await invalid.json()).problems)).toBe(true);
    expect((await POST(post("{not json"), ctx(CID))).status).toBe(400);
  });

  it("POST decision: the caller is the actor; an unrelated caller gets the uniform 404; refusals are bounded 409s", async () => {
    const { POST } = (await import(/* @vite-ignore */ ROUTES.decision)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const { planAmendmentErrorFromDatabase } = await loadAmend();
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: CAPTAIN });
    repo.decidePlanAmendment.mockResolvedValue({ decision: "CONFIRMED", status: "PENDING", confirmedCount: 1, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: null });
    const ok = await POST(post({ amendmentDigest: sha("x"), decision: "CONFIRMED" }), ctx(CID));
    expect(ok.status).toBe(200);
    expect(repo.decidePlanAmendment).toHaveBeenCalledWith(CID, CAPTAIN, sha("x"), "CONFIRMED");
    expect(await ok.json()).toEqual({ decision: "CONFIRMED", status: "PENDING", confirmedCount: 1, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: null });
    repo.decidePlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase("PLAN_AMENDMENT_NOT_AVAILABLE: x"));
    const hidden = await POST(post({ amendmentDigest: sha("x"), decision: "CONFIRMED" }), ctx(CID));
    expect(hidden.status).toBe(404);
    for (const [message, code] of [["PLAN_AMENDMENT_STALE: x", "STALE"], ["PLAN_AMENDMENT_EXPIRED: x", "EXPIRED"], ["PLAN_AMENDMENT_NOT_PENDING: x", "NOT_PENDING"], ["PLAN_AMENDMENT_DECISION_CONFLICT: x", "DECISION_CONFLICT"]] as const) {
      repo.decidePlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase(message));
      const res = await POST(post({ amendmentDigest: sha("x"), decision: "REJECTED" }), ctx(CID));
      expect([res.status, (await res.json()).code], code).toEqual([409, code]);
    }
    expect((await POST(post({ amendmentDigest: sha("x"), decision: "MAYBE" }), ctx(CID))).status).toBe(400);
  });

  it("POST withdraw: a non-organizer gets the uniform 404; the organizer's refusals are bounded 409s; an exact repeat is a 200", async () => {
    const { POST } = (await import(/* @vite-ignore */ ROUTES.withdraw)) as { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
    const { planAmendmentErrorFromDatabase } = await loadAmend();
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.withdrawPlanAmendment.mockResolvedValue({ status: "WITHDRAWN", alreadyWithdrawn: false });
    expect((await POST(post({ amendmentDigest: sha("x") }), ctx(CID))).status).toBe(200);
    repo.withdrawPlanAmendment.mockRejectedValueOnce(planAmendmentErrorFromDatabase("PLAN_AMENDMENT_NOT_PENDING: x"));
    expect((await POST(post({ amendmentDigest: sha("x") }), ctx(CID))).status).toBe(409);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: STRANGER });
    const hidden = await POST(post({ amendmentDigest: sha("x") }), ctx(CID));
    expect(hidden.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The one signal the addressed view carries
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the addressed view: a bounded signal for the organizer and the frozen captains only, and an unchanged view for everyone else", () => {
  function viewRepo(over: { state?: string; teams?: unknown[]; frozen?: boolean; organizer?: string; revoked?: boolean } = {}) {
    const names = [
      "getCompetitionById", "getCompetitionTeams", "getCompetitionFixtures", "getMyRegistration", "getMyTeamMembership", "getMyPendingJoinRequest", "getTeamMemberships",
      "getPendingJoinRequestsForTeam", "getMemberParticipationRecords", "getDisplayNames", "getCurrentRoster", "getRegistrationStatus", "getRegistrationFreeze",
    ];
    const repo = Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
    repo.getCompetitionById.mockResolvedValue(competition({ state: over.state ?? "READY_TO_PUBLISH", organizerGamingMemberId: over.organizer ?? ORGANIZER, hostBound: over.revoked === true, hostAccessRevoked: over.revoked === true }));
    repo.getCompetitionTeams.mockResolvedValue(over.teams ?? [
      { competitionTeamId: "t1", competitionId: CID, name: "Alpha", captainGamingMemberId: CAPTAIN, status: "ACCEPTED", publicCode: "pa", createdAt: "x" },
      { competitionTeamId: "t2", competitionId: CID, name: "Bravo", captainGamingMemberId: "00000000-0000-4000-8000-0000000000c2", status: "ACCEPTED", publicCode: "pb", createdAt: "x" },
    ]);
    repo.getCompetitionFixtures.mockResolvedValue([]);
    repo.getMyRegistration.mockResolvedValue(null); repo.getMyTeamMembership.mockResolvedValue(null); repo.getMyPendingJoinRequest.mockResolvedValue(null);
    repo.getTeamMemberships.mockResolvedValue([]); repo.getPendingJoinRequestsForTeam.mockResolvedValue([]); repo.getMemberParticipationRecords.mockResolvedValue([]);
    repo.getDisplayNames.mockResolvedValue({}); repo.getCurrentRoster.mockResolvedValue(null);
    repo.getRegistrationStatus.mockResolvedValue(over.frozen === false ? { deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: true, acceptingNewWrites: false, frozen: false, rosterMinimum: 5, rosterMaximum: 8 }
      : { deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: true, acceptingNewWrites: false, frozen: true, rosterMinimum: 5, rosterMaximum: 8 });
    repo.getRegistrationFreeze.mockResolvedValue(null);
    return repo as unknown as CompetitionsRepository;
  }

  it("the active organizer and a frozen captain each get exactly their own flag, and nothing else about any amendment", async () => {
    const organizer = await getCompetitionView(viewRepo(), CID, ORGANIZER);
    expect(organizer.planAmendment).toEqual({ organizer: true, captain: false });
    const captain = await getCompetitionView(viewRepo(), CID, CAPTAIN);
    expect(captain.planAmendment).toEqual({ organizer: false, captain: true });
    const both = await getCompetitionView(viewRepo(), CID, CAPTAIN);
    expect(Object.keys(both.planAmendment!).sort()).toEqual(["captain", "organizer"]);
    expect(JSON.stringify(captain)).not.toMatch(/digest|expiresAt|proposed|venue/i);
  });

  it("an organizer who is also a frozen captain gets both flags", async () => {
    const view = await getCompetitionView(viewRepo({ organizer: CAPTAIN }), CID, CAPTAIN);
    expect(view.planAmendment).toEqual({ organizer: true, captain: true });
  });

  it("everyone else — a stranger, a registrant, a member of a team, a captain of a team that is not accepted — gets a view with NO such key at all", async () => {
    const stranger = await getCompetitionView(viewRepo(), CID, STRANGER);
    expect("planAmendment" in stranger).toBe(false);
    const pending = await getCompetitionView(viewRepo({ teams: [{ competitionTeamId: "t9", competitionId: CID, name: "Nope", captainGamingMemberId: STRANGER, status: "PENDING_ORGANIZER_APPROVAL", publicCode: "pp", createdAt: "x" }] }), CID, STRANGER);
    expect("planAmendment" in pending).toBe(false);
  });

  it("no signal outside the amendment window: not before the freeze, not in any other state, not for a revoked host", async () => {
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      expect("planAmendment" in (await getCompetitionView(viewRepo({ state }), CID, ORGANIZER)), state).toBe(false);
      expect("planAmendment" in (await getCompetitionView(viewRepo({ state }), CID, CAPTAIN)), state).toBe(false);
    }
    expect("planAmendment" in (await getCompetitionView(viewRepo({ frozen: false }), CID, ORGANIZER))).toBe(false);
    const revoked = await getCompetitionView(viewRepo({ revoked: true }), CID, ORGANIZER);
    expect("planAmendment" in revoked).toBe(false);
  });

  it("source: the view signal reads no clock and no repository method the existing view tests do not already stub", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../lib/gaming/competitions/getCompetitionView.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(source).not.toMatch(/getPlanAmendment|planAmendment\./);
  });
});
