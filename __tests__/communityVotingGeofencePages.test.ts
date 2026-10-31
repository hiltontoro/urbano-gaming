import { readFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { assessLocationEligibility } from "../lib/gaming/communityVoting/eligibility";

/**
 * UG-IV-GATE-010 — the ACTUAL shipped pages (operator tablet, voter, public display), parsed and run whole in jsdom with the real logic
 * modules, a scripted fake server and a controllable location sensor and identity seam. No network, no provider, no canvas, no map.
 *
 * What these tests pin is behavior: what a person sees, what is (and is not) sent to the server, when the sensor is touched, what happens to
 * unsaved and private state when the signed-in person changes, and how a test event announces itself. Real layout on a phone and a tablet is
 * checked by a person in a real browser (see the implementation record); jsdom has no layout engine.
 */

vi.setConfig({ testTimeout: 60_000 });

const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, "public", f), "utf8");
const FILES: Record<string, string> = {
  "communityVotingRound.js": read("communityVotingRound.js"),
  "communityVotingRoundOperator.js": read("communityVotingRoundOperator.js"),
  "communityVotingSlideshow.js": read("communityVotingSlideshow.js"),
  "urbanoAuth.js": "/* the identity seam is stubbed by the test */",
};
const OPERATOR = read("community-voting-round-operator.html");
const VOTER = read("community-voting-round.html");
const DISPLAY = read("community-voting-round-display.html");

const INSTANCE = "11111111-2222-4333-8444-555555555555";
const PREFIX = `/api/gaming/community-voting/rounds/${INSTANCE}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Json = Record<string, any>;

const inlineScripts = (html: string) => html.replace(/<script src="\/([^"]+)"><\/script>/g, (_m, name: string) => `<script>${FILES[name] ?? ""}</script>`);

interface Call { url: string; method: string; body: any; headers: Record<string, string> }
type Reply = { status: number; json?: unknown; text?: string };
type AuthState = { status: "unauthenticated" | "profile_incomplete" | "authenticated"; email?: string; authUserId?: string; gamingMemberId?: string };
type Sensor = { coords?: { latitude: number; longitude: number; accuracy: number }; errorCode?: number; unsupported?: boolean };

async function loadPage(opts: { html: string; query?: string; auth?: AuthState; respond: (call: Call) => Reply | Promise<Reply>; session?: Record<string, string>; sensor?: () => Sensor }) {
  const calls: Call[] = [];
  let auth: AuthState = opts.auth ?? { status: "unauthenticated" };
  const changeCallbacks: Array<(s: AuthState) => unknown> = [];
  const resetCallbacks: Array<() => unknown> = [];
  const sensorCalls: Json[] = [];
  const geo = {
    getCurrentPosition: vi.fn((ok: (p: unknown) => void, err: (e: unknown) => void, options: Json) => {
      sensorCalls.push(options);
      const unavailable: () => Sensor = () => ({ errorCode: 2 });
      const next = (opts.sensor ?? unavailable)();
      if (next.errorCode) err({ code: next.errorCode });
      else if (next.coords) ok({ coords: next.coords });
      else err({ code: 2 });
    }),
  };
  let unsupported = false;
  const dom = new JSDOM(inlineScripts(opts.html), {
    url: `http://localhost/page.html${opts.query ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      for (const [k, v] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(k, v);
      Object.defineProperty(window.navigator, "geolocation", { get: () => (unsupported ? undefined : geo), configurable: true });
      w.UrbanoAuth = {
        getState: async () => (auth.status === "unauthenticated" ? auth : { authUserId: "stub-user", ...auth }),
        getAccessToken: async () => (auth.status === "unauthenticated" ? null : "stub-access-token"),
        onAuthStateChange: async () => () => {},
        onIdentityChange: async (cb: (s: AuthState) => unknown) => { changeCallbacks.push(cb); return () => {}; },
        onIdentityReset: async (cb: () => unknown) => { resetCallbacks.push(cb); return () => {}; },
        attachSignInButton: () => {},
        requestOtp: async () => ({ status: "sent" }),
        verifyOtp: async () => ({ status: "authenticated" }),
        completeProfile: async () => ({ status: "authenticated" }),
        signOut: async () => ({ status: "unauthenticated" }),
      };
      w.fetch = async (url: string, init: any = {}) => {
        const call: Call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} };
        calls.push(call);
        const out = await opts.respond(call);
        return { status: out.status, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; }, text: async () => out.text ?? "" };
      };
      w.Image = class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
      w.setTimeout = () => 0;
      w.clearTimeout = () => {};
      w.setInterval = () => 0;
      w.URL.createObjectURL = () => "blob:stub";
      w.URL.revokeObjectURL = () => {};
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const settle = async (ms = 30) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, ms / 6)); };
  await settle();
  return {
    win, doc, calls, geo, sensorCalls, settle,
    $: (sel: string) => doc.querySelector(sel) as HTMLElement | null,
    $$: (sel: string) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[],
    text: () => doc.getElementById("app")?.textContent ?? doc.body.textContent ?? "",
    html: () => doc.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ""),
    modal: () => doc.getElementById("modalRoot")?.textContent ?? "",
    stored: () => { const out: Record<string, string> = {}; for (let i = 0; i < win.sessionStorage.length; i++) { const k = win.sessionStorage.key(i) as string; out[k] = win.sessionStorage.getItem(k) as string; } return out; },
    setUnsupported(value: boolean) { unsupported = value; },
    async signOut() { auth = { status: "unauthenticated" }; for (const cb of resetCallbacks) await cb(); await settle(); },
    async signInAs(next: AuthState) { auth = next; for (const cb of resetCallbacks) await cb(); for (const cb of changeCallbacks) await cb({ authUserId: "stub-user", ...next }); await settle(); },
    click: async (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); await settle(); },
    type: async (el: Element | null, value: string) => { const i = el as HTMLInputElement; i.value = value; i.dispatchEvent(new win.Event("input", { bubbles: true })); i.dispatchEvent(new win.Event("change", { bubbles: true })); },
    check: async (el: Element | null, value: boolean) => { const i = el as HTMLInputElement; i.checked = value; i.dispatchEvent(new win.Event("change", { bubbles: true })); await settle(); },
  };
}

// ---------------------------------------------------------------- the operator's world: a scripted server that behaves like the real one

const VENUE = { venueLatitude: 14.0987, venueLongitude: -87.2012, venueRadiusMeters: 75, maxAccuracyMeters: 30, insideMarginFactor: 0.5, outsideMarginFactor: 1.5 };
const SESSION = { "cvop2:round": JSON.stringify({ instanceId: INSTANCE, hostToken: "host-token-123", ownerUserId: "stub-user" }) };
const entries = [201, 202].map((n, i) => ({ entryId: uuid(n), label: `#${1111 * (i + 1)}`, association: "CONFIRMED", media: "APPROVED", photoId: uuid(n + 100), promotional: "NOT_ASKED", withdrawn: false, carried: true, claimable: false, claimExpiresAt: null }));

function operatorWorld(init: { role?: "PRELIMINARY" | "FINAL"; opened?: boolean; isTest?: boolean; sessionState?: string; saveReply?: Reply; geofence?: Partial<typeof VENUE> } = {}) {
  const world = {
    role: init.role ?? "FINAL", opened: init.opened ?? false, isTest: init.isTest ?? false, sessionState: init.sessionState ?? "LOBBY_LOCKED",
    venue: { ...VENUE, ...(init.geofence ?? {}) }, savedAt: null as string | null,
    saves: [] as Json[], tests: [] as Json[], seen: [] as Call[],
  };
  const overview = (): Json => ({
    roundRole: world.role, isTest: world.isTest, sessionState: world.sessionState, interactionState: world.opened ? "PROMPT_ACTIVE" : null, opened: world.opened, closed: false, published: false,
    serverNow: "2026-10-31T21:00:00.000Z", windowSeconds: world.role === "FINAL" ? 300 : null, deadlineAt: null,
    schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: world.role === "FINAL" ? null : "2026-10-31T22:00:00.000Z", status: "TENTATIVE" },
    counters: { boundVoters: 0, votes: 0, entries: 2, withdrawn: 0 }, finalistsSelected: false, noValidResult: false, policies: [], pendingResolutions: [], review: null, tasks: [], publishedAffected: [],
    geofence: world.role === "FINAL" ? { ...world.venue, editable: !world.opened, savedAt: world.savedAt } : null,
    entries,
  });
  const respond = async (call: Call): Promise<Reply> => {
    world.seen.push(call);
    const route = call.url.replace(PREFIX, "").split("?")[0];
    if (route === "/operator/overview") return { status: 200, json: overview() };
    if (route === "/info") return { status: 200, json: { info: { isTest: world.isTest }, texts: { galleryConsent: { version: "g", text: "t" }, promoConsent: { version: "p", text: "t" } } } };
    if (route === "/operator/geofence" && call.method === "PUT") {
      world.saves.push(call);
      if (init.saveReply) return init.saveReply;
      if (world.opened) return { status: 409, json: { code: "GEOFENCE_FROZEN" } };
      world.venue = { ...call.body.venue };
      world.savedAt = "2026-10-31T21:05:00.000Z";
      return { status: 200, json: { geofence: { ...world.venue, configuredAt: world.savedAt } } };
    }
    if (route === "/operator/geofence/test" && call.method === "POST") {
      world.tests.push(call);
      const reading = call.body.location;
      const out = assessLocationEligibility(reading, world.venue);
      return { status: 200, json: { test: { decision: out.decision, distanceMeters: Math.round(out.distanceMeters * 10) / 10, accuracyMeters: Math.round(reading.accuracyMeters * 10) / 10, radiusMeters: world.venue.venueRadiusMeters, maxAccuracyMeters: world.venue.maxAccuracyMeters } } };
    }
    return { status: 200, json: {} };
  };
  return { world, respond };
}

const operatorPage = (w: ReturnType<typeof operatorWorld>, extra: { sensor?: () => Sensor; session?: Record<string, string> } = {}) =>
  loadPage({ html: OPERATOR, respond: w.respond, query: "", auth: { status: "authenticated", authUserId: "stub-user" }, session: extra.session ?? SESSION, sensor: extra.sensor });

const GOOD: Sensor = { coords: { latitude: 14.5, longitude: -87.5, accuracy: 9.4 } };
const field = (p: Awaited<ReturnType<typeof loadPage>>, id: string) => (p.$(`#geo-${id}`) as HTMLInputElement).value;
const geofenceCalls = (w: ReturnType<typeof operatorWorld>) => w.world.seen.filter((c) => /\/operator\/geofence/.test(c.url));
const isVoteSide = (c: Call) => /\/(votes|intents|binding|claims|status|gallery)(\?|$)/.test(c.url.replace(PREFIX, ""));

// ============================================================ the operator's geofence card

describe("operator page — the geofence card", () => {
  it("a FINAL shows its saved geofence, a local schematic, the explanations of each setting and the honest limit of browser location; a PRELIMINARY shows none of it", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    expect(p.$("#geofenceCard")).toBeTruthy();
    expect(field(p, "lat")).toBe("14.0987");
    expect(field(p, "lon")).toBe("-87.2012");
    expect(field(p, "radius")).toBe("75");
    expect(field(p, "accuracy")).toBe("30");
    expect(field(p, "inside")).toBe("0.5");
    expect(field(p, "outside")).toBe("1.5");
    for (const id of ["radius", "accuracy", "inside", "outside", "browser"]) expect(p.$(`#geo-help-${id}`)?.textContent ?? "", id).toMatch(/\S{3,}/);
    expect(p.$("#geo-help-browser")?.textContent).toMatch(/se[ñn]al de elegibilidad/i);
    const svg = p.$("#geo-schematic");
    expect(svg?.tagName.toLowerCase()).toBe("svg");
    expect(svg?.getAttribute("data-radius-meters")).toBe("75");
    expect(p.$("#geo-use-location")).toBeTruthy();
    expect(p.$("#geo-test")).toBeTruthy();
    expect(p.$("#geo-save")).toBeTruthy();
    expect(p.html()).not.toMatch(/maps\.google|openstreetmap|mapbox|leaflet|googleapis\.com\/maps|api[_-]?key/i);

    const pre = await operatorPage(operatorWorld({ role: "PRELIMINARY" }));
    expect(pre.$("#geofenceCard")).toBeNull();
    expect(pre.sensorCalls).toHaveLength(0);
  });

  it("loading the page, drawing the card and editing a field never touch the location sensor or the server's geofence routes", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.type(p.$("#geo-radius"), "90");
    await p.type(p.$("#geo-lat"), "14.2");
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(geofenceCalls(w)).toHaveLength(0);
    expect(p.$("#geo-schematic")?.getAttribute("data-radius-meters")).toBe("90");
    expect(p.$("#geo-dirty")?.textContent ?? "").toMatch(/sin guardar/i);
  });

  it("'Usar mi ubicación' only FILLS a proposal for the centre: it saves nothing, tests nothing, opens nothing, and says the proposal is not saved", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => GOOD });
    await p.click(p.$("#geo-use-location"));
    expect(p.geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(field(p, "lat")).toBe("14.5");
    expect(field(p, "lon")).toBe("-87.5");
    expect(field(p, "radius")).toBe("75");
    expect(p.$("#geo-proposal")?.textContent ?? "").toMatch(/9[.,]4 m/);
    expect(p.$("#geo-proposal")?.textContent ?? "").toMatch(/no (est[aá]|se ha) guardad/i);
    expect(p.$("#geo-dirty")).toBeTruthy();
    expect(geofenceCalls(w)).toHaveLength(0);
    expect(w.world.seen.some((c) => /\/operator\/open|\/operator\/close|\/operator\/publish/.test(c.url))).toBe(false);
    expect(w.world.venue).toEqual(VENUE);
  });

  it("'Usar mi ubicación' does not propose a centre from a reading that is not precise enough, and says why", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => ({ coords: { latitude: 14.5, longitude: -87.5, accuracy: 400 } }) });
    await p.click(p.$("#geo-use-location"));
    expect(field(p, "lat")).toBe("14.0987");
    expect(p.$("#geo-error")?.textContent ?? "").toMatch(/precisi[óo]n/i);
    expect(p.$("#geo-error")?.textContent ?? "").toMatch(/400 m/);
    expect(p.$("#geo-proposal")).toBeNull();
  });

  it("each way the sensor can fail gets its own understandable message, and nothing is changed or saved", async () => {
    const messages = new Set<string>();
    for (const sensor of [{ errorCode: 1 }, { errorCode: 2 }, { errorCode: 3 }] as Sensor[]) {
      const w = operatorWorld();
      const p = await operatorPage(w, { sensor: () => sensor });
      await p.click(p.$("#geo-use-location"));
      const message = p.$("#geo-error")?.textContent ?? "";
      expect(message, JSON.stringify(sensor)).toMatch(/\S{10,}/);
      messages.add(message);
      expect(field(p, "lat")).toBe("14.0987");
      expect(geofenceCalls(w)).toHaveLength(0);
      await p.click(p.$("#geo-test"));
      expect(geofenceCalls(w)).toHaveLength(0);
    }
    expect(messages.size).toBe(3);
    const w = operatorWorld();
    const p = await operatorPage(w);
    p.setUnsupported(true);
    await p.click(p.$("#geo-use-location"));
    expect(p.$("#geo-error")?.textContent ?? "").toMatch(/no permite|no (hay|tiene)|compatible/i);
  });

  it("'Guardar geocerca' is explicit: it sends the six typed numbers to THIS round's route with the bearer and the host token, and confirms only after the server's 200", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.type(p.$("#geo-lat"), "14.0990");
    await p.type(p.$("#geo-lon"), "-87.2000");
    await p.type(p.$("#geo-radius"), "60");
    await p.type(p.$("#geo-accuracy"), "25");
    await p.type(p.$("#geo-inside"), "1");
    await p.type(p.$("#geo-outside"), "2");
    expect(w.world.saves).toHaveLength(0);
    await p.click(p.$("#geo-save"));
    expect(w.world.saves).toHaveLength(1);
    const save = w.world.saves[0];
    expect(save.method).toBe("PUT");
    expect(save.url).toBe(`${PREFIX}/operator/geofence`);
    expect(save.body).toEqual({ venue: { venueLatitude: 14.099, venueLongitude: -87.2, venueRadiusMeters: 60, maxAccuracyMeters: 25, insideMarginFactor: 1, outsideMarginFactor: 2 } });
    expect(save.headers.Authorization).toBe("Bearer stub-access-token");
    expect(save.headers["x-host-token"]).toBe("host-token-123");
    expect(p.text()).toMatch(/Geocerca guardada/);
    expect(p.$("#geo-dirty")).toBeNull();
    expect(p.$("#geo-saved-summary")?.textContent ?? "").toMatch(/60 m/);
  });

  it("invalid values are refused on the page, field by field, before anything is sent", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.type(p.$("#geo-lat"), "ninety");
    await p.type(p.$("#geo-radius"), "0");
    await p.type(p.$("#geo-accuracy"), "");
    await p.click(p.$("#geo-save"));
    expect(w.world.saves).toHaveLength(0);
    for (const f of ["lat", "radius", "accuracy"]) expect((p.$(`[data-field-error="${f}"]`)?.textContent ?? "").length, f).toBeGreaterThan(20);
    expect(p.$('[data-field-error="lon"]')).toBeNull();
  });

  it("the server's refusal to save (it already opened) is shown in words and the card turns read-only after the refresh", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    w.world.opened = true; // the final opened in another tab after this page drew
    await p.type(p.$("#geo-radius"), "60");
    await p.click(p.$("#geo-save"));
    expect(w.world.saves).toHaveLength(1);
    expect(p.text()).toMatch(/ya abri[óo]/i);
    expect(p.$("#geo-lat")).toBeNull();
    expect(p.$("#geo-save")).toBeNull();
    expect(p.$("#geo-use-location")).toBeNull();
    expect(p.$("#geo-status")?.textContent ?? "").toMatch(/congelad/i);
    expect(w.world.venue).toEqual(VENUE);
  });

  it("once the final has opened the card is read-only (values shown, nothing to edit or save) but the location test is still offered", async () => {
    const w = operatorWorld({ opened: true });
    const p = await operatorPage(w, { sensor: () => GOOD });
    expect(p.$("#geofenceCard")).toBeTruthy();
    for (const id of ["lat", "lon", "radius", "accuracy", "inside", "outside"]) expect(p.$(`#geo-${id}`), id).toBeNull();
    expect(p.$("#geo-save")).toBeNull();
    expect(p.$("#geo-use-location")).toBeNull();
    expect(p.$("#geo-frozen-values")?.textContent ?? "").toMatch(/75 m/);
    expect(p.$("#geo-test")).toBeTruthy();
    await p.click(p.$("#geo-test"));
    expect(w.world.tests).toHaveLength(1);
  });
});

describe("operator page — 'Probar mi ubicación'", () => {
  it("sends the device reading to the server's evaluator ONCE and shows inside, outside, ambiguous and insufficient accuracy, with the distance and the accuracy", async () => {
    const readings: Array<[Sensor, string]> = [
      [{ coords: { latitude: 14.0987, longitude: -87.2012, accuracy: 8 } }, "INSIDE"],
      [{ coords: { latitude: 14.2, longitude: -87.2012, accuracy: 8 } }, "OUTSIDE"],
      [{ coords: { latitude: 14.0987 + 75 / 111_194.9, longitude: -87.2012, accuracy: 20 } }, "AMBIGUOUS"],
      [{ coords: { latitude: 14.0987, longitude: -87.2012, accuracy: 90 } }, "ACCURACY_EXCESSIVE"],
    ];
    const titles = new Set<string>();
    for (const [sensor, decision] of readings) {
      const w = operatorWorld();
      const p = await operatorPage(w, { sensor: () => sensor });
      await p.click(p.$("#geo-test"));
      expect(p.geo.getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(w.world.tests).toHaveLength(1);
      expect(w.world.tests[0].url).toBe(`${PREFIX}/operator/geofence/test`);
      expect(w.world.tests[0].body).toEqual({ location: { latitude: sensor.coords!.latitude, longitude: sensor.coords!.longitude, accuracyMeters: sensor.coords!.accuracy } });
      const result = p.$("#geo-result");
      expect(result?.getAttribute("data-decision")).toBe(decision);
      expect(result?.textContent ?? "").toMatch(/\d+[.,]\d m|\d+ m/);
      titles.add(result?.querySelector("strong")?.textContent ?? "");
      expect(p.$("#geo-schematic")?.getAttribute("data-has-reading")).toBe("true");
    }
    expect(titles.size).toBe(4);
  });

  it("is a TEST: it casts no vote, takes no intent, binds nobody, changes no geofence, and the result says that nothing was saved", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => GOOD });
    const before = JSON.stringify(w.world.venue);
    await p.click(p.$("#geo-test"));
    await p.click(p.$("#geo-test"));
    expect(w.world.seen.filter(isVoteSide)).toHaveLength(0);
    expect(w.world.saves).toHaveLength(0);
    expect(JSON.stringify(w.world.venue)).toBe(before);
    expect(p.$("#geo-result")?.textContent ?? "").toMatch(/no se (guard|registr)/i);
  });

  it("a new attempt retires the previous answer: if the position cannot be read this time, the old result is not left on screen as if it were current", async () => {
    const w = operatorWorld();
    let attempt = 0;
    const p = await operatorPage(w, { sensor: () => (attempt++ === 0 ? GOOD : { errorCode: 3 }) });
    await p.click(p.$("#geo-test"));
    expect(p.$("#geo-result")).toBeTruthy();
    expect(p.$("#geo-schematic")?.getAttribute("data-has-reading")).toBe("true");
    await p.click(p.$("#geo-test"));
    expect(p.$("#geo-error")?.textContent ?? "").toMatch(/tard/i);
    expect(p.$("#geo-result")).toBeNull();
    expect(p.$("#geo-schematic")?.getAttribute("data-has-reading")).toBe("false");
    expect(w.world.tests).toHaveLength(1);
  });

  it("tests the position against the values the server has saved, and says when the form has unsaved edits the test did not use", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => GOOD });
    await p.type(p.$("#geo-radius"), "5000");
    await p.click(p.$("#geo-test"));
    expect(w.world.saves).toHaveLength(0);
    expect(p.$("#geo-result")?.getAttribute("data-decision")).toBe("OUTSIDE");
    expect(p.$("#geo-result")?.textContent ?? "").toMatch(/sin guardar|valores guardados/i);
  });

  it("states that browser location is an eligibility signal and not proof against spoofing, next to the result", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => GOOD });
    await p.click(p.$("#geo-test"));
    expect(p.$("#geofenceCard")?.textContent ?? "").toMatch(/se[ñn]al de elegibilidad/i);
  });
});

describe("operator page — private and unsaved state does not outlive the person", () => {
  it("signing out, or another person signing in, removes the typed values, the proposal, the test result, the schematic's reading and the stored round — nothing is left in the page or in storage", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w, { sensor: () => ({ coords: { latitude: 14.123456, longitude: -87.654321, accuracy: 9.4 } }) });
    await p.type(p.$("#geo-radius"), "88");
    await p.click(p.$("#geo-use-location"));
    await p.click(p.$("#geo-test"));
    expect(p.$("#geo-result")).toBeTruthy();
    expect(Object.keys(p.stored())).toContain("cvop2:round");

    await p.signOut();
    expect(p.$("#geofenceCard")).toBeNull();
    expect(p.$("#geo-result")).toBeNull();
    expect(p.$("#geo-radius")).toBeNull();
    expect(p.html()).not.toMatch(/123456|654321/);
    expect(p.stored()).toEqual({});

    await p.signInAs({ status: "authenticated", authUserId: "another-user", email: "other@example.invalid" });
    expect(p.$("#geofenceCard")).toBeNull();
    expect(p.$("#connectCard")).toBeTruthy();
    expect(p.html()).not.toMatch(/123456|654321/);
    expect(p.stored()).toEqual({});
  });

  it("a location test that was in flight when the person changed is dropped when it answers", async () => {
    const w = operatorWorld();
    let release!: (r: Reply) => void;
    const slow = new Promise<Reply>((resolve) => { release = resolve; });
    const respond = async (call: Call) => (call.url.endsWith("/operator/geofence/test") ? slow : w.respond(call));
    const p = await loadPage({ html: OPERATOR, respond, query: "", auth: { status: "authenticated", authUserId: "stub-user" }, session: SESSION, sensor: () => GOOD });
    (p.$("#geo-test") as HTMLElement).click();
    await p.settle();
    await p.signInAs({ status: "authenticated", authUserId: "another-user" });
    release({ status: 200, json: { test: { decision: "INSIDE", distanceMeters: 1, accuracyMeters: 1, radiusMeters: 75, maxAccuracyMeters: 30 } } });
    await p.settle();
    expect(p.$("#geo-result")).toBeNull();
    expect(p.$("#geofenceCard")).toBeNull();
  });
});

// ============================================================ test events

describe("test events — the operator page", () => {
  async function registerWith(checked: boolean) {
    const seen: Call[] = [];
    const respond = async (c: Call): Promise<Reply> => {
      seen.push(c);
      return c.url.endsWith("/api/gaming/community-voting/rounds") ? { status: 201, json: { instance: { instanceId: INSTANCE, isTest: checked } } } : { status: 404, json: { code: "NOT_FOUND" } };
    };
    const p = await loadPage({ html: OPERATOR, respond, query: "", auth: { status: "authenticated", authUserId: "stub-user" } });
    expect((p.$("#reg-test") as HTMLInputElement).checked).toBe(false);
    if (checked) await p.check(p.$("#reg-test"), true);
    await p.type(p.$("#reg-sessionId"), uuid(9));
    await p.type(p.$("#reg-hostToken"), "host");
    await p.click(p.$("#register"));
    return { p, request: seen.find((c) => c.url.endsWith("/api/gaming/community-voting/rounds"))! };
  }

  it("registration offers an explicit test-event choice that says it cannot be changed later; unchecked it never sends true", async () => {
    const { p, request } = await registerWith(false);
    void p;
    expect(request.body.testMode === undefined || request.body.testMode === false).toBe(true);
    const fresh = await loadPage({ html: OPERATOR, respond: async () => ({ status: 404, json: {} }), query: "", auth: { status: "authenticated", authUserId: "stub-user" } });
    expect(fresh.$("#registerCard")?.textContent ?? "").toMatch(/no se puede cambiar/i);
    expect(fresh.$("#registerCard")?.textContent ?? "").toMatch(/EVENTO DE PRUEBA/);
  });

  it("checked, registration sends testMode as the boolean true", async () => {
    const { request } = await registerWith(true);
    expect(request.body.testMode).toBe(true);
    expect(request.body.sessionId).toBe(uuid(9));
  });

  it("a test round is unmistakable on the operator page: a banner with the label, the title, and no way to read it as the real event", async () => {
    const test = await operatorPage(operatorWorld({ isTest: true }));
    expect(test.$("#testBanner")?.textContent ?? "").toMatch(/^EVENTO DE PRUEBA/);
    expect(test.doc.title).toMatch(/^\[PRUEBA\]/);
    const real = await operatorPage(operatorWorld({ isTest: false }));
    expect(real.$("#testBanner")).toBeNull();
    expect(real.doc.title).not.toMatch(/PRUEBA/);
    expect(real.html()).not.toMatch(/EVENTO DE PRUEBA/);
  });

  it("the banner is gone when the operator disconnects or changes: a real round opened next never inherits it", async () => {
    const p = await operatorPage(operatorWorld({ isTest: true }));
    expect(p.$("#testBanner")).toBeTruthy();
    await p.click(p.$("#disconnect"));
    expect(p.$("#testBanner")).toBeNull();
    expect(p.doc.title).not.toMatch(/PRUEBA/);
  });
});

describe("operator page — the lobby-lock prerequisite", () => {
  it("while the Session's lobby is open, opening is blocked and the page explains the prerequisite — it offers no way to lock the lobby itself", async () => {
    const w = operatorWorld({ role: "PRELIMINARY", sessionState: "LOBBY_OPEN" });
    const p = await operatorPage(w);
    expect((p.$("#step-OPEN") as HTMLButtonElement).disabled).toBe(true);
    const notice = p.$("#lobbyNotice");
    expect(notice?.textContent ?? "").toMatch(/lobby/i);
    expect(notice?.textContent ?? "").toMatch(/anfitri[óo]n/i);
    expect(notice?.textContent ?? "").toMatch(/esta pantalla no/i);
    expect(p.html()).not.toMatch(/lock-?lobby|\/lock\b/i);
    expect(w.world.seen.some((c) => /lock/i.test(c.url))).toBe(false);
  });

  it("once the lobby is locked the notice disappears and opening is available", async () => {
    const p = await operatorPage(operatorWorld({ role: "PRELIMINARY", sessionState: "LOBBY_LOCKED" }));
    expect(p.$("#lobbyNotice")).toBeNull();
    expect((p.$("#step-OPEN") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the notice offers a way to look again (the lock happens elsewhere), and looking again re-reads the round", async () => {
    const w = operatorWorld({ role: "PRELIMINARY", sessionState: "LOBBY_OPEN" });
    const p = await operatorPage(w);
    const before = w.world.seen.filter((c) => c.url.endsWith("/operator/overview")).length;
    w.world.sessionState = "LOBBY_LOCKED";
    await p.click(p.$("#lobby-recheck"));
    expect(w.world.seen.filter((c) => c.url.endsWith("/operator/overview")).length).toBe(before + 1);
    expect(p.$("#lobbyNotice")).toBeNull();
    expect((p.$("#step-OPEN") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("voter page — test events and the hidden photograph", () => {
  function voterWorld(over: { isTest?: boolean; phase?: string; published?: boolean; items?: string[]; role?: string } = {}) {
    const respond = async (call: Call): Promise<Reply> => {
      const route = call.url.replace(PREFIX, "").split("?")[0];
      if (route === "/info") {
        return { status: 200, json: { info: { roundRole: over.role ?? "PRELIMINARY", phase: over.phase ?? "OPEN", locationRequired: over.role === "FINAL", windowSeconds: null, deadlineAt: null, serverNow: "2026-11-01T03:03:30.000Z", deadlineRemainingMs: null, registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, tentative: true, approvedContestants: 3, published: !!over.published, isTest: !!over.isTest }, texts: { galleryConsent: { version: "v", text: "t" }, promoConsent: { version: "p", text: "t" } } } };
      }
      if (route === "/results") return { status: 200, json: { published: !!over.published, kind: "WINNERS", items: (over.items ?? []).map((alias) => ({ alias })) } };
      return { status: 404, json: { code: "NOT_FOUND" } };
    };
    return { respond };
  }

  it("a test round announces itself on the voter page in every state, with the label, a title prefix and a notice that it is not the real event", async () => {
    for (const auth of [{ status: "unauthenticated" }, { status: "authenticated" }] as AuthState[]) {
      const p = await loadPage({ html: VOTER, respond: voterWorld({ isTest: true }).respond, query: `?e=${INSTANCE}`, auth });
      const banner = p.$("#testBanner");
      expect(banner?.textContent ?? "", auth.status).toMatch(/^EVENTO DE PRUEBA/);
      expect(banner?.textContent ?? "").toMatch(/no (es|cuenta)/i);
      expect(p.doc.title).toMatch(/^\[PRUEBA\]/);
    }
    const real = await loadPage({ html: VOTER, respond: voterWorld({ isTest: false }).respond, query: `?e=${INSTANCE}` });
    expect(real.$("#testBanner")).toBeNull();
    expect(real.doc.title).not.toMatch(/PRUEBA/);
  });

  it("a test round's published result is labelled as a test result, so it cannot be read as the real Halloween result", async () => {
    const p = await loadPage({ html: VOTER, respond: voterWorld({ isTest: true, phase: "CLOSED", published: true, items: ["1111"] }).respond, query: `?e=${INSTANCE}` });
    expect(p.$("#announcement")).toBeTruthy();
    expect(p.$("#announcement")?.textContent ?? "").toMatch(/EVENTO DE PRUEBA/);
    const real = await loadPage({ html: VOTER, respond: voterWorld({ isTest: false, phase: "CLOSED", published: true, items: ["1111"] }).respond, query: `?e=${INSTANCE}` });
    expect(real.$("#announcement")?.textContent ?? "").not.toMatch(/PRUEBA/);
  });

  it("a published finalist whose photograph was hidden shows a deliberate 'Imagen no disponible' placeholder — never a broken image — and keeps the published number", async () => {
    const p = await loadPage({ html: VOTER, respond: voterWorld({ phase: "CLOSED", published: true, items: ["1111", "2222"] }).respond, query: `?e=${INSTANCE}` });
    const figure = (alias: string) => p.$(`#announcement figure[data-alias="${alias}"]`) as HTMLElement;
    expect(figure("1111")).toBeTruthy();
    expect(figure("1111").querySelector("img")).toBeTruthy();
    expect(figure("1111").textContent).not.toMatch(/Imagen no disponible/);
    figure("1111").querySelector("img")!.dispatchEvent(new p.win.Event("error"));
    await p.settle();
    expect(figure("1111").querySelector("img")).toBeNull();
    const placeholder = figure("1111").querySelector(".photo-missing") as HTMLElement;
    expect(placeholder).toBeTruthy();
    expect(placeholder.textContent).toMatch(/Imagen no disponible/);
    expect(placeholder.getAttribute("role")).toBe("img");
    expect(placeholder.getAttribute("aria-label") ?? "").toMatch(/1111/);
    expect(figure("1111").querySelector("figcaption")?.textContent).toBe("#1111");
    expect(figure("2222").querySelector("img")).toBeTruthy();
    expect(figure("2222").querySelector(".photo-missing")).toBeNull();
  });

  it("the preliminary of a test round still never asks the browser for a location", async () => {
    const p = await loadPage({ html: VOTER, respond: voterWorld({ isTest: true }).respond, query: `?e=${INSTANCE}`, auth: { status: "authenticated" } });
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(p.html()).not.toMatch(/Probar mi ubicaci/);
  });
});

describe("display page — test events", () => {
  function displayWorld(isTest: boolean) {
    return async (call: Call): Promise<Reply> => {
      const route = call.url.replace(PREFIX, "").split("?")[0];
      if (route === "/slideshow") return { status: 200, json: { prompt: "Elige tu disfraz favorito.", rotationSeconds: 8, items: [{ alias: "1111", imageUrl: `${PREFIX}/photos/1111?v=full` }] } };
      if (route === "/info") return { status: 200, json: { info: { roundRole: "PRELIMINARY", phase: "OPEN", deadlineRemainingMs: 60_000, published: false, isTest, votingOpensAt: null, tentative: false } } };
      if (route === "/results") return { status: 200, json: { published: false, items: [] } };
      return { status: 404, json: {} };
    };
  }

  it("a test round shows the label on the venue screen, large and persistent; a real round shows nothing of the sort", async () => {
    const test = await loadPage({ html: DISPLAY, respond: displayWorld(true), query: `?e=${INSTANCE}` });
    const banner = test.$("#testBanner");
    expect(banner?.hasAttribute("hidden")).toBe(false);
    expect(banner?.textContent ?? "").toMatch(/^EVENTO DE PRUEBA/);
    expect(test.doc.title).toMatch(/^\[PRUEBA\]/);
    const real = await loadPage({ html: DISPLAY, respond: displayWorld(false), query: `?e=${INSTANCE}` });
    const none = real.$("#testBanner");
    expect(none === null || none.hasAttribute("hidden")).toBe(true);
    expect(real.doc.title).not.toMatch(/PRUEBA/);
  });
});
