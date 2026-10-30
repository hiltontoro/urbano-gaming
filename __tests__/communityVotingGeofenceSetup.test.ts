import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import { toHttpErrorResponse } from "../lib/gaming/communityVoting/httpSupport";
import { assessLocationEligibility } from "../lib/gaming/communityVoting/eligibility";
import { configureFinalGeofence, registerCommunityVotingRound, testFinalGeofence } from "../lib/gaming/communityVoting/rounds/operations";

/**
 * UG-IV-GATE-010 — the operator's geofence setup, without a database or a DOM.
 *   1. the server operations: they validate the SHAPE of a request, forward exactly the permitted fields to the repository (which asks the
 *      database to decide), never run on a request that fails validation, and never log or echo a coordinate;
 *   2. the operator module's pure logic, executed from the EXACT deployed source text: the form model, the local schematic's geometry, the
 *      wording of every outcome, the reading of the device position, the lobby-lock prerequisite;
 *   3. the labelling of a test event, which must be the same words on every page.
 * The pages themselves (what a person sees and what is sent) are in communityVotingGeofencePages.test.ts; the database rules (authority, freeze,
 * race, audit, evaluator parity) are in communityVotingGeofenceSetup.contract.test.ts.
 */

function load<T>(file: string, name: string): T {
  const source = readFileSync(`public/${file}`, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${source}\nreturn ${name};`)() as T;
}

type Json = Record<string, any>;
type Venue = { venueLatitude: number; venueLongitude: number; venueRadiusMeters: number; maxAccuracyMeters: number; insideMarginFactor: number; outsideMarginFactor: number };
type Reading = { latitude: number; longitude: number; accuracyMeters: number };

const CTX = { instanceId: "11111111-2222-4333-8444-555555555555", hostToken: "host-token-123", operatorMemberId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001" };
const VENUE: Venue = { venueLatitude: 14.0987, venueLongitude: -87.2012, venueRadiusMeters: 75, maxAccuracyMeters: 30, insideMarginFactor: 0.5, outsideMarginFactor: 1.5 };
const READING: Reading = { latitude: 14.123456789, longitude: -87.987654321, accuracyMeters: 7.654321 };

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================================================================
// 1. Server operations
// =====================================================================================================================

describe("configureFinalGeofence (server operation)", () => {
  const fakeRepo = () => ({ configureFinalGeofence: vi.fn(async (input: Json) => ({ ...input.venue, configuredAt: "2026-10-31T20:00:00.000Z" })) });

  it("forwards the operator context and EXACTLY the six permitted numbers — nothing else in the body reaches the repository", async () => {
    const repo = fakeRepo();
    const out = await configureFinalGeofence(repo as never, CTX, {
      venue: { ...VENUE, instanceId: "other", sessionId: "other", isTest: true, testMode: true, roundRole: "PRELIMINARY", extra: 1 },
      instanceId: "someone-elses", operatorMemberId: "someone-else", hostToken: "other-token", isTest: true,
    });
    expect(repo.configureFinalGeofence).toHaveBeenCalledTimes(1);
    expect(repo.configureFinalGeofence.mock.calls[0][0]).toEqual({ ...CTX, venue: VENUE });
    expect(out).toMatchObject(VENUE);
  });

  it("refuses an invalid body BEFORE the repository is touched, with a fixed message that repeats no value", async () => {
    const repo = fakeRepo();
    const bodies: unknown[] = [
      undefined, null, "x", 5, [], {}, { venue: null }, { venue: {} }, { venue: [] },
      { venue: { ...VENUE, venueLatitude: 91 } }, { venue: { ...VENUE, venueLatitude: "14" } }, { venue: { ...VENUE, venueLongitude: -181 } },
      { venue: { ...VENUE, venueRadiusMeters: 0 } }, { venue: { ...VENUE, venueRadiusMeters: 100001 } },
      { venue: { ...VENUE, maxAccuracyMeters: -1 } }, { venue: { ...VENUE, insideMarginFactor: 1001 } }, { venue: { ...VENUE, outsideMarginFactor: null } },
      { venue: { ...VENUE, venueRadiusMeters: Number.NaN } }, { venue: { ...VENUE, venueRadiusMeters: Number.POSITIVE_INFINITY } },
    ];
    for (const body of bodies) {
      await expect(configureFinalGeofence(repo as never, CTX, body), JSON.stringify(body)).rejects.toMatchObject({
        name: "CommunityVotingError",
        code: body === undefined || body === null || typeof body !== "object" || Array.isArray(body) ? "INVALID_REQUEST" : "INVALID_GEOFENCE_CONFIG",
      });
    }
    expect(repo.configureFinalGeofence).not.toHaveBeenCalled();
  });

  it("logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await configureFinalGeofence(fakeRepo() as never, CTX, { venue: VENUE });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("testFinalGeofence (server operation)", () => {
  const RESULT = { decision: "INSIDE", distanceMeters: 12.3, accuracyMeters: 7.7, radiusMeters: 75, maxAccuracyMeters: 30 };
  const fakeRepo = () => ({ testFinalGeofence: vi.fn(async () => RESULT) });

  it("validates the reading exactly as a vote does, forwards only its three fields, and returns what the database decided", async () => {
    const repo = fakeRepo();
    const out = await testFinalGeofence(repo as never, CTX, { location: { ...READING, eligible: true, timestamp: 1 }, eligible: true, instanceId: "x" });
    expect(repo.testFinalGeofence).toHaveBeenCalledWith({ ...CTX, location: READING });
    expect(out).toEqual(RESULT);
  });

  it("refuses a malformed or implausible reading BEFORE the repository is touched, as INVALID_LOCATION_READING", async () => {
    const repo = fakeRepo();
    const locations: unknown[] = [
      undefined, null, "x", [], {}, { latitude: 1 }, { latitude: 91, longitude: 0.1, accuracyMeters: 5 }, { latitude: 1, longitude: 181, accuracyMeters: 5 },
      { latitude: 1, longitude: 1, accuracyMeters: 0 }, { latitude: 1, longitude: 1, accuracyMeters: -1 }, { latitude: 0, longitude: 0, accuracyMeters: 5 },
      { latitude: "1", longitude: 1, accuracyMeters: 5 }, { latitude: Number.NaN, longitude: 1, accuracyMeters: 5 }, { latitude: 1, longitude: 1, accuracyMeters: Number.POSITIVE_INFINITY },
    ];
    for (const location of locations) {
      await expect(testFinalGeofence(repo as never, CTX, { location }), JSON.stringify(location)).rejects.toMatchObject({ code: "INVALID_LOCATION_READING" });
    }
    await expect(testFinalGeofence(repo as never, CTX, null)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(repo.testFinalGeofence).not.toHaveBeenCalled();
  });

  it("its errors repeat no coordinate and it logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await testFinalGeofence(fakeRepo() as never, CTX, { location: READING });
    const bad = await testFinalGeofence(fakeRepo() as never, CTX, { location: { ...READING, accuracyMeters: -1 } }).catch((e: Error) => e);
    expect((bad as Error).message).not.toMatch(/123456789|987654321|654321/);
    for (const spy of spies) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(/123456789|987654321/);
  });
});

describe("registerCommunityVotingRound: test mode", () => {
  const OPS = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
  const run = (body: Json, repoExtra: Json = {}) => {
    const repo = { registerRound: vi.fn(async (i: Json) => ({ instanceId: "i", sessionId: i.sessionId, roundRole: i.roundRole, ruleVersion: 1, sourceInstanceId: null, windowSeconds: null, isTest: i.testMode === true, createdAt: "2026-10-31T20:00:00.000Z", ...repoExtra })) };
    const promise = registerCommunityVotingRound(repo as never, { body, hostToken: "t", operatorMemberId: OPS, allowlistRaw: OPS });
    return { repo, promise };
  };
  const SESSION = "bbbbbbbb-bbbb-4ccc-8ddd-000000000002";

  it("passes testMode only when it is the boolean true; the default is a real round", async () => {
    const a = run({ sessionId: SESSION, roundRole: "PRELIMINARY" });
    await a.promise;
    expect(a.repo.registerRound.mock.calls[0][0].testMode).toBe(false);
    const b = run({ sessionId: SESSION, roundRole: "PRELIMINARY", testMode: false });
    await b.promise;
    expect(b.repo.registerRound.mock.calls[0][0].testMode).toBe(false);
    const c = run({ sessionId: SESSION, roundRole: "PRELIMINARY", testMode: true });
    await c.promise;
    expect(c.repo.registerRound.mock.calls[0][0].testMode).toBe(true);
    const d = run({ sessionId: SESSION, roundRole: "FINAL", sourceInstanceId: "cccccccc-bbbb-4ccc-8ddd-000000000003", venue: VENUE, testMode: true });
    await d.promise;
    expect(d.repo.registerRound.mock.calls[0][0]).toMatchObject({ testMode: true, venue: VENUE });
  });

  it("anything else in testMode is refused before the repository is touched (no truthy string, number or object turns a round into a test)", async () => {
    for (const bad of ["true", "yes", 1, 0, null, {}, []]) {
      const r = run({ sessionId: SESSION, roundRole: "PRELIMINARY", testMode: bad });
      await expect(r.promise, JSON.stringify(bad)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(r.repo.registerRound).not.toHaveBeenCalled();
    }
  });
});

describe("HTTP statuses of the new refusals", () => {
  it("GEOFENCE_FROZEN, NOT_A_FINAL and TEST_MODE_MISMATCH are conflicts; a bad reading or geofence is a 400; none carries a value", () => {
    const status = (code: string) => toHttpErrorResponse(new CommunityVotingError(code as never, "m"), "T");
    expect(status("GEOFENCE_FROZEN")).toMatchObject({ status: 409, body: { code: "GEOFENCE_FROZEN" } });
    expect(status("NOT_A_FINAL")).toMatchObject({ status: 409, body: { code: "NOT_A_FINAL" } });
    expect(status("TEST_MODE_MISMATCH")).toMatchObject({ status: 409, body: { code: "TEST_MODE_MISMATCH" } });
    expect(status("INVALID_GEOFENCE_CONFIG").status).toBe(400);
    expect(status("INVALID_LOCATION_READING").status).toBe(400);
  });
});

// =====================================================================================================================
// 2. The operator module
// =====================================================================================================================

interface Geometry {
  size: number;
  centre: { x: number; y: number };
  metersPerPixel: number;
  radiusPx: number;
  reading: null | { x: number; y: number; accuracyPx: number; outOfFrame: boolean; bearingDegrees: number; distanceMeters: number };
  scaleBar: { meters: number; px: number; label: string };
}
interface Operator {
  TEST_EVENT_LABEL: string;
  TEST_EVENT_NOTICE: string;
  GEOFENCE_HELP: Record<string, string>;
  parseGeofenceForm(form: Record<string, string>): { ok: true; venue: Venue } | { ok: false; errors: Record<string, string> };
  geofenceToForm(venue: Venue): Record<string, string>;
  geofenceDirty(saved: Venue | null, form: Record<string, string>): boolean;
  proposeCenter(reading: Reading, maxAccuracyMeters: number | null): { ok: true; latitude: number; longitude: number; accuracyMeters: number } | { ok: false; code: string };
  readDevicePosition(geolocation: unknown, options?: Json): Promise<Reading>;
  describeLocationError(code: string): string;
  describeTestResult(result: Json): { tone: "good" | "bad" | "warn"; title: string; detail: string };
  schematic(input: { radiusMeters: number; centre: { latitude: number; longitude: number }; reading?: Reading | null; size?: number }): Geometry | null;
  lobbyStatus(overview: Json | null): { pending: boolean; text: string | null };
  nextSteps(overview: Json): Array<{ key: string; label: string; done: boolean; enabled: boolean; reason: string | null }>;
  describeError(code: string | undefined | null): string;
  buildOperatorApi(fetchImpl: (url: string, init: Json) => Promise<Json>, getToken: () => Promise<string | null>, getHostToken: () => string, instanceId: string): Record<string, (...a: any[]) => Promise<Json>>;
}
const O = load<Operator>("communityVotingRoundOperator.js", "CommunityVotingRoundOperator");
const ROUND_JS = load<{ TEST_EVENT_LABEL: string; TEST_EVENT_NOTICE: string }>("communityVotingRound.js", "CommunityVotingRound");

const FORM = { lat: "14.0987", lon: "-87.2012", radius: "75", accuracy: "30", inside: "0.5", outside: "1.5" };

describe("operator module: the geofence form", () => {
  it("parses a valid form into the six numbers the server expects, trimming whitespace and accepting a decimal comma", () => {
    expect(O.parseGeofenceForm(FORM)).toEqual({ ok: true, venue: VENUE });
    expect(O.parseGeofenceForm({ ...FORM, lat: " 14,0987 ", radius: " 75 " })).toEqual({ ok: true, venue: VENUE });
  });

  it("names each wrong field, in Spanish, and never produces a venue from a wrong form (blank, text, NaN, Infinity, out of range)", () => {
    const wrong: Array<[string, string, string]> = [
      ["lat", "", "blank"], ["lat", "abc", "text"], ["lat", "NaN", "NaN"], ["lat", "91", "above 90"], ["lat", "-90.5", "below -90"],
      ["lon", "181", "above 180"], ["lon", "Infinity", "Infinity"], ["radius", "0", "zero"], ["radius", "-5", "negative"], ["radius", "100001", "above the ceiling"],
      ["accuracy", "0", "zero"], ["accuracy", "100001", "above the ceiling"], ["inside", "-0.1", "negative"], ["inside", "1001", "above the ceiling"],
      ["outside", "x", "text"], ["outside", "1e999", "overflow"],
    ];
    for (const [field, value, label] of wrong) {
      const result = O.parseGeofenceForm({ ...FORM, [field]: value });
      expect(result.ok, `${field} ${label}`).toBe(false);
      if (!result.ok) {
        expect(Object.keys(result.errors), `${field} ${label}`).toEqual([field]);
        expect(result.errors[field].length, `${field} ${label}`).toBeGreaterThan(20);
      }
    }
    const everything = O.parseGeofenceForm({ lat: "", lon: "", radius: "", accuracy: "", inside: "", outside: "" });
    expect(everything.ok).toBe(false);
    if (!everything.ok) expect(Object.keys(everything.errors).sort()).toEqual(["accuracy", "inside", "lat", "lon", "outside", "radius"]);
  });

  it("round-trips a venue through the form, and tells unsaved edits from the saved values (numerically, not textually)", () => {
    expect(O.geofenceToForm(VENUE)).toEqual(FORM);
    expect(O.geofenceDirty(VENUE, FORM)).toBe(false);
    expect(O.geofenceDirty(VENUE, { ...FORM, lat: "14.09870" })).toBe(false);
    expect(O.geofenceDirty(VENUE, { ...FORM, radius: "76" })).toBe(true);
    expect(O.geofenceDirty(VENUE, { ...FORM, radius: "" })).toBe(true);
    expect(O.geofenceDirty(null, FORM)).toBe(true);
  });

  it("explains each setting in plain Spanish and says that the browser location is an eligibility signal, not proof against spoofing", () => {
    for (const key of ["radius", "accuracy", "inside", "outside", "browser"]) expect(O.GEOFENCE_HELP[key], key).toMatch(/\S{3,}/);
    expect(O.GEOFENCE_HELP.accuracy).toMatch(/precisi[óo]n/i);
    expect(O.GEOFENCE_HELP.inside).toMatch(/margen/i);
    expect(O.GEOFENCE_HELP.outside).toMatch(/margen/i);
    expect(O.GEOFENCE_HELP.browser).toMatch(/se[ñn]al de elegibilidad/i);
    expect(O.GEOFENCE_HELP.browser).toMatch(/no es (una )?prueba/i);
    expect(O.GEOFENCE_HELP.browser).toMatch(/suplant|falsific|simul/i);
  });
});

describe("operator module: the position of the device", () => {
  const geo = (behavior: (ok: (p: Json) => void, err: (e: Json) => void, options: Json) => void) => ({ getCurrentPosition: vi.fn(behavior) });

  it("asks the sensor once, for a fresh high-accuracy reading, and returns only latitude, longitude and accuracy", async () => {
    const sensor = geo((ok) => ok({ coords: { latitude: 14.1, longitude: -87.2, accuracy: 12.5, altitude: 100, speed: 3, heading: 4 }, timestamp: 1 }));
    expect(await O.readDevicePosition(sensor)).toEqual({ latitude: 14.1, longitude: -87.2, accuracyMeters: 12.5 });
    expect(sensor.getCurrentPosition).toHaveBeenCalledTimes(1);
    const options = sensor.getCurrentPosition.mock.calls[0][2];
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(options.timeout).toBeGreaterThanOrEqual(5000);
  });

  it("maps denial, unavailability, timeout, a missing sensor and a malformed reading to distinct codes", async () => {
    const failing = (code: number) => geo((_ok, err) => err({ code }));
    await expect(O.readDevicePosition(failing(1))).rejects.toEqual({ code: "LOCATION_DENIED" });
    await expect(O.readDevicePosition(failing(2))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
    await expect(O.readDevicePosition(failing(3))).rejects.toEqual({ code: "LOCATION_TIMEOUT" });
    await expect(O.readDevicePosition(undefined)).rejects.toEqual({ code: "LOCATION_UNSUPPORTED" });
    await expect(O.readDevicePosition({})).rejects.toEqual({ code: "LOCATION_UNSUPPORTED" });
    await expect(O.readDevicePosition(geo((ok) => ok({ coords: { latitude: Number.NaN, longitude: 1, accuracy: 5 } })))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
    await expect(O.readDevicePosition(geo((ok) => ok({ coords: { latitude: 1, longitude: 1 } })))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
  });

  it("has a different, understandable message for each failure, and none repeats a coordinate", () => {
    const codes = ["LOCATION_DENIED", "LOCATION_UNAVAILABLE", "LOCATION_TIMEOUT", "LOCATION_UNSUPPORTED", "ACCURACY_INSUFFICIENT"];
    const messages = codes.map((c) => O.describeLocationError(c));
    expect(new Set(messages).size).toBe(codes.length);
    for (const m of messages) expect(m).toMatch(/\S{3,}/);
    expect(O.describeLocationError("LOCATION_DENIED")).toMatch(/permit/i);
    expect(O.describeLocationError("LOCATION_TIMEOUT")).toMatch(/tard/i);
    expect(O.describeLocationError("SOMETHING_NEW")).toMatch(/No se pudo/);
  });

  it("proposes the centre from a reading ONLY when the device is precise enough for the accuracy the venue asks of voters", () => {
    expect(O.proposeCenter({ latitude: 14.1, longitude: -87.2, accuracyMeters: 12 }, 30)).toEqual({ ok: true, latitude: 14.1, longitude: -87.2, accuracyMeters: 12 });
    expect(O.proposeCenter({ latitude: 14.1, longitude: -87.2, accuracyMeters: 30 }, 30)).toMatchObject({ ok: true });
    expect(O.proposeCenter({ latitude: 14.1, longitude: -87.2, accuracyMeters: 31 }, 30)).toEqual({ ok: false, code: "ACCURACY_INSUFFICIENT" });
    expect(O.proposeCenter({ latitude: 14.1, longitude: -87.2, accuracyMeters: 400 }, null)).toEqual({ ok: false, code: "ACCURACY_INSUFFICIENT" });
    expect(O.proposeCenter({ latitude: 91, longitude: -87.2, accuracyMeters: 5 }, 30)).toEqual({ ok: false, code: "INVALID_READING" });
    expect(O.proposeCenter({ latitude: 0, longitude: 0, accuracyMeters: 5 }, 30)).toEqual({ ok: false, code: "INVALID_READING" });
  });
});

describe("operator module: what the test says", () => {
  const base = { distanceMeters: 23.4, accuracyMeters: 8, radiusMeters: 75, maxAccuracyMeters: 30 };

  it("says INSIDE, OUTSIDE, AMBIGUOUS and insufficient accuracy in different words and tones, always with the distance and the accuracy it saw", () => {
    const inside = O.describeTestResult({ ...base, decision: "INSIDE" });
    const outside = O.describeTestResult({ ...base, decision: "OUTSIDE", distanceMeters: 480.2 });
    const ambiguous = O.describeTestResult({ ...base, decision: "AMBIGUOUS", distanceMeters: 80 });
    const accuracy = O.describeTestResult({ ...base, decision: "ACCURACY_EXCESSIVE", accuracyMeters: 120 });
    expect([inside.tone, outside.tone, ambiguous.tone, accuracy.tone]).toEqual(["good", "bad", "warn", "warn"]);
    expect(new Set([inside.title, outside.title, ambiguous.title, accuracy.title]).size).toBe(4);
    expect(inside.title).toMatch(/dentro/i);
    expect(outside.title).toMatch(/fuera/i);
    expect(ambiguous.title).toMatch(/no se puede confirmar|ambig/i);
    expect(accuracy.title).toMatch(/precisi[óo]n/i);
    expect(inside.detail).toMatch(/23[.,]4 m/);
    expect(outside.detail).toMatch(/480[.,]2 m/);
    expect(accuracy.detail).toMatch(/120 m/);
    expect(accuracy.detail).toMatch(/30 m/);
    for (const r of [inside, outside, ambiguous, accuracy]) expect(r.detail).toMatch(/no se (guard|registr)/i);
  });

  it("an unknown decision is never presented as an approval", () => {
    const odd = O.describeTestResult({ ...base, decision: "WHATEVER" });
    expect(odd.tone).not.toBe("good");
    expect(odd.title).not.toMatch(/dentro/i);
  });
});

describe("operator module: the local schematic (no map, no provider)", () => {
  const centre = { latitude: 14.1, longitude: -87.2 };
  const mPerDegLat = 111_194.9;
  const mPerDegLon = (lat: number) => 111_194.9 * Math.cos((lat * Math.PI) / 180);
  const at = (eastMeters: number, northMeters: number, accuracyMeters = 10): Reading => ({
    latitude: centre.latitude + northMeters / mPerDegLat, longitude: centre.longitude + eastMeters / mPerDegLon(centre.latitude), accuracyMeters,
  });

  it("puts the centre in the middle and draws the radius to scale, with a scale bar of a round number", () => {
    const g = O.schematic({ radiusMeters: 75, centre, size: 240 }) as Geometry;
    expect(g.size).toBe(240);
    expect(g.centre).toEqual({ x: 120, y: 120 });
    expect(g.reading).toBeNull();
    expect(g.radiusPx * g.metersPerPixel).toBeCloseTo(75, 0);
    expect(g.radiusPx).toBeLessThanOrEqual(120 * 0.85);
    expect(g.radiusPx).toBeGreaterThan(120 * 0.4);
    expect([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]).toContain(g.scaleBar.meters);
    expect(g.scaleBar.px).toBeCloseTo(g.scaleBar.meters / g.metersPerPixel, 3);
    expect(g.scaleBar.label).toMatch(new RegExp(`${g.scaleBar.meters} ?m`));
  });

  it("places a reading at its true offset, north up and east right, with its accuracy circle to scale", () => {
    const g = O.schematic({ radiusMeters: 100, centre, reading: at(50, 0, 20), size: 240 }) as Geometry;
    const r = g.reading!;
    expect(r.outOfFrame).toBe(false);
    expect(r.x - g.centre.x).toBeCloseTo(50 / g.metersPerPixel, 0);
    expect(r.y).toBeCloseTo(g.centre.y, 0);
    expect(r.accuracyPx * g.metersPerPixel).toBeCloseTo(20, 0);
    expect(r.distanceMeters).toBeCloseTo(50, 0);
    const north = O.schematic({ radiusMeters: 100, centre, reading: at(0, 60), size: 240 }) as Geometry;
    expect(north.reading!.y).toBeLessThan(north.centre.y);
    expect(north.reading!.x).toBeCloseTo(north.centre.x, 0);
    const south = O.schematic({ radiusMeters: 100, centre, reading: at(0, -60), size: 240 }) as Geometry;
    expect(south.reading!.y).toBeGreaterThan(south.centre.y);
  });

  it("zooms out to keep a nearby reading in view, and shows a distant one as an arrow on the edge instead of squashing the venue", () => {
    const near = O.schematic({ radiusMeters: 100, centre, reading: at(180, 0), size: 240 }) as Geometry;
    expect(near.reading!.outOfFrame).toBe(false);
    expect(near.reading!.x).toBeGreaterThanOrEqual(0);
    expect(near.reading!.x).toBeLessThanOrEqual(240);
    expect(near.radiusPx).toBeLessThan(120 * 0.85);
    const far = O.schematic({ radiusMeters: 100, centre, reading: at(0, 11_000), size: 240 }) as Geometry;
    expect(far.reading!.outOfFrame).toBe(true);
    expect(far.reading!.x).toBeGreaterThanOrEqual(0);
    expect(far.reading!.x).toBeLessThanOrEqual(240);
    expect(far.reading!.y).toBeGreaterThanOrEqual(0);
    expect(far.reading!.y).toBeLessThanOrEqual(240);
    expect(far.reading!.bearingDegrees).toBeCloseTo(0, 0);
    expect(far.reading!.distanceMeters).toBeGreaterThan(10_000);
    expect(far.radiusPx).toBeGreaterThan(120 * 0.3);
  });

  it("returns nothing for values that cannot be drawn, and never a NaN", () => {
    expect(O.schematic({ radiusMeters: Number.NaN, centre })).toBeNull();
    expect(O.schematic({ radiusMeters: 0, centre })).toBeNull();
    expect(O.schematic({ radiusMeters: -4, centre })).toBeNull();
    expect(O.schematic({ radiusMeters: 50, centre: { latitude: 120, longitude: 0 } })).toBeNull();
    const g = O.schematic({ radiusMeters: 50, centre, reading: { latitude: Number.NaN, longitude: 1, accuracyMeters: 5 } }) as Geometry;
    expect(g.reading).toBeNull();
    expect(JSON.stringify(g)).not.toMatch(/NaN|null,"y"/);
  });

  it("agrees with the evaluator about where the boundary is (the drawing is not a second opinion)", () => {
    const venue: Venue = { venueLatitude: centre.latitude, venueLongitude: centre.longitude, venueRadiusMeters: 100, maxAccuracyMeters: 50, insideMarginFactor: 1, outsideMarginFactor: 1 };
    for (const [east, accuracy, expected] of [[10, 5, "INSIDE"], [300, 5, "OUTSIDE"], [90, 20, "AMBIGUOUS"], [10, 80, "ACCURACY_EXCESSIVE"]] as const) {
      const reading = at(east, 0, accuracy);
      const g = O.schematic({ radiusMeters: 100, centre, reading, size: 240 }) as Geometry;
      const decision = assessLocationEligibility(reading, venue).decision;
      expect(decision).toBe(expected);
      const inCircle = Math.hypot(g.reading!.x - g.centre.x, g.reading!.y - g.centre.y) <= g.radiusPx;
      expect(inCircle, `${east} m`).toBe(east <= 100);
    }
  });
});

describe("operator module: the lobby-lock prerequisite", () => {
  const overview = (over: Json = {}) => ({
    roundRole: "PRELIMINARY", sessionState: "LOBBY_LOCKED", opened: false, closed: false, published: false, finalistsSelected: false, serverNow: "2026-10-31T21:00:00.000Z",
    schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: "2026-10-31T22:00:00.000Z", status: "TENTATIVE" },
    pendingResolutions: [], review: null,
    entries: [1, 2].map((n) => ({ entryId: `e${n}`, label: `#${n}`, association: "CONFIRMED", media: "APPROVED", photoId: `p${n}`, promotional: "NOT_ASKED", withdrawn: false, carried: false, claimable: false })),
    ...over,
  });
  const step = (o: Json, key: string) => O.nextSteps(o).find((s) => s.key === key)!;

  it("opening is blocked, with the reason in words, while the lobby is not locked — and the page does not pretend to lock it", () => {
    const open = O.nextSteps(overview({ sessionState: "LOBBY_OPEN" })).find((s) => s.key === "OPEN")!;
    expect(open.enabled).toBe(false);
    expect(open.reason).toMatch(/lobby/i);
    expect(open.reason).toMatch(/anfitri[óo]n/i);
    const status = O.lobbyStatus(overview({ sessionState: "LOBBY_OPEN" }));
    expect(status.pending).toBe(true);
    expect(status.text).toMatch(/lobby/i);
    expect(status.text).toMatch(/anfitri[óo]n/i);
    expect(status.text).toMatch(/esta pantalla no/i);
  });

  it("a locked lobby (or a round that already opened) shows no prerequisite and does not block", () => {
    expect(step(overview(), "OPEN").enabled).toBe(true);
    expect(O.lobbyStatus(overview())).toEqual({ pending: false, text: null });
    expect(O.lobbyStatus(overview({ sessionState: "PROMPT_ACTIVE", opened: true }))).toEqual({ pending: false, text: null });
    expect(O.lobbyStatus(null)).toEqual({ pending: false, text: null });
  });

  it("an overview that does not say the Session's state blocks nothing (the server stays the authority)", () => {
    const { sessionState, ...without } = overview();
    void sessionState;
    expect(step(without, "OPEN").enabled).toBe(true);
    expect(O.lobbyStatus(without)).toEqual({ pending: false, text: null });
  });

  it("the server's own refusal still has its message", () => {
    expect(O.describeError("SESSION_NOT_STARTABLE")).toMatch(/lobby/i);
  });
});

describe("operator module: messages and routes", () => {
  it("has a specific message for each new server code", () => {
    const generic = O.describeError("SOMETHING_NEW");
    for (const code of ["GEOFENCE_FROZEN", "NOT_A_FINAL", "TEST_MODE_MISMATCH", "INVALID_LOCATION_READING", "INVALID_GEOFENCE_CONFIG"]) {
      expect(O.describeError(code), code).not.toBe(generic);
    }
    expect(O.describeError("GEOFENCE_FROZEN")).toMatch(/abri[óo]/i);
    expect(O.describeError("TEST_MODE_MISMATCH")).toMatch(/prueba/i);
  });

  it("reaches the two new routes with the bearer AND the host token, PUT for the save and POST for the test", async () => {
    const calls: Array<{ url: string; init: Json }> = [];
    const api = O.buildOperatorApi(async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({}) }; }, async () => "tok", () => "host", CTX.instanceId);
    await api.geofence(VENUE);
    await api.testGeofence(READING);
    expect(calls.map((c) => [c.init.method, c.url.replace(`/api/gaming/community-voting/rounds/${CTX.instanceId}`, "")])).toEqual([
      ["PUT", "/operator/geofence"], ["POST", "/operator/geofence/test"],
    ]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ venue: VENUE });
    expect(JSON.parse(calls[1].init.body)).toEqual({ location: READING });
    for (const c of calls) expect(c.init.headers).toMatchObject({ Authorization: "Bearer tok", "x-host-token": "host" });
  });
});

// =====================================================================================================================
// 3. The words of a test event are the same everywhere
// =====================================================================================================================

describe("test-event labelling", () => {
  it("is the same unmistakable label, in capitals, in the operator module and in the voter/display module", () => {
    expect(O.TEST_EVENT_LABEL).toBe("EVENTO DE PRUEBA");
    expect(ROUND_JS.TEST_EVENT_LABEL).toBe(O.TEST_EVENT_LABEL);
    expect(ROUND_JS.TEST_EVENT_NOTICE).toMatch(/ensayo|prueba/i);
    expect(ROUND_JS.TEST_EVENT_NOTICE).toMatch(/no (es|cuenta)/i);
    expect(O.TEST_EVENT_NOTICE).toMatch(/ensayo|prueba/i);
  });
});
