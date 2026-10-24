import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsdomModule from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * B1 — the language module failing must not take the pages down.
 *
 * Home, URBANO Score (public/soccer-predictions.html) and the profile used to call UrbanoI18n without a guard, so when /urbanoI18n.js did
 * not load the Home drew no cards and never evaluated Predictions or Become a Host, and the other two pages stayed on "Cargando…" for
 * good. Each page now carries a generated Spanish fallback (an inline block right after the module's script tag) that is used only when
 * the module is absent or unusable.
 *
 * Nothing here is simulated at the function level: each page is loaded through jsdom's real subresource pipeline, which really requests
 * /urbanoI18n.js and really reports the failure to the page's <script> element. The failures covered:
 *   missing  — the request fails (no connection, reset): the script never arrives;
 *   http500  — the server answers 500: the script never runs;
 *   htmlPage — an error page answered with 200: HTML where JavaScript was expected (a syntax error when it runs);
 *   throws   — the file arrives but throws while starting;
 *   partial  — the file arrives and defines a stub that lacks most of the API.
 *
 * The method is differential: the page is also loaded with the module present, and what a person can see and do must be IDENTICAL
 * (same words, same cards, same links, same requests), except that the language selector is hidden (there is no English without the
 * module). On top of that: no dictionary key is ever shown as text, nothing is left on "Cargando…", and a language failure never
 * enables an operation: no request that the working page would not make is made, and every condition (sign-in, an open match, location,
 * the server's own answer about Become a Host) still applies. Drift tests keep the generated blocks equal to the module's dictionary.
 */

// jsdom is CommonJS: depending on the loader its classes are named exports or members of the default export.
const jsdom: typeof import("jsdom") = ((jsdomModule as any).default && (jsdomModule as any).default.JSDOM ? (jsdomModule as any).default : jsdomModule) as any;
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom as any;

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const PAGE_HTML = { "index.html": read("public/index.html"), "soccer-predictions.html": read("public/soccer-predictions.html"), "profile.html": read("public/profile.html") } as const;
type PageName = keyof typeof PAGE_HTML;
const I18N_SOURCE = read("public/urbanoI18n.js");
const AUTH_SOURCE = read("public/urbanoAuth.js");
const HOST_READER_SOURCE = read("public/hostAvailability.js");

const FAILURES = ["missing", "http500", "htmlPage", "throws", "partial"] as const;
type Failure = (typeof FAILURES)[number];
type Mode = "ok" | Failure;

// Each case loads real pages several times (every failure mode, plus the working page to compare with).
vi.setConfig({ testTimeout: 90_000 });

/** The negative controls load a page that is broken ON PURPOSE: its own unhandled rejections are the defect being shown, not a failure of this run. */
async function expectingUnhandledRejections<T>(run: () => Promise<T>): Promise<{ result: T; rejections: string[] }> {
  const rejections: string[] = [];
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const collect = (reason: unknown) => { rejections.push(String((reason as Error)?.message ?? reason)); };
  process.on("unhandledRejection", collect);
  try {
    const result = await run();
    await new Promise((r) => setTimeout(r, 50)); // unhandled rejections are reported on a later turn
    return { result, rejections };
  } finally {
    process.removeListener("unhandledRejection", collect);
    for (const listener of saved) process.on("unhandledRejection", listener as (...args: unknown[]) => void);
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

/** The page's own subresource requests are answered here: real files from public/, except /urbanoI18n.js which fails the way `mode` says. */
function interceptorFor(mode: Mode, fetched: string[]) {
  return requestInterceptor((request: Request) => {
    const url = new URL(request.url);
    if (url.hostname !== "localhost") return new Response("", { status: 200, headers: { "Content-Type": "text/css" } }); // fonts and the like: never the network
    fetched.push(url.pathname);
    const js = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "application/javascript" } });
    if (url.pathname === "/urbanoI18n.js") {
      switch (mode) {
        case "ok": return js(I18N_SOURCE);
        case "missing": return Promise.reject(new TypeError("fetch failed")); // a network failure: no response at all
        case "http500": return new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } });
        case "htmlPage": return new Response("<!doctype html><html><body><h1>Service unavailable</h1></body></html>", { status: 200, headers: { "Content-Type": "text/html" } }); // an error page answered with 200: not JavaScript
        case "throws": return js('throw new Error("the language module failed to start");');
        case "partial": return js('window.UrbanoI18n = { t: function (key) { return "<<" + key + ">>"; } };');
      }
    }
    if (url.pathname === "/urbanoAuth.js") return js(AUTH_SOURCE);
    if (url.pathname === "/hostAvailability.js") return js(HOST_READER_SOURCE);
    return new Response("", { status: 404 });
  });
}

interface OpenOptions {
  html?: string;
  session?: "A" | null; // signed in as A (a finished member) or nobody
  incomplete?: boolean; // signed in, but the account is not finished
  matches?: unknown[];
  mine?: Record<string, unknown>;
  predict?: { status: number; json: unknown };
  position?: { latitude: number; longitude: number; accuracy: number } | null;
  hostOpen?: boolean;
  profileFails?: boolean;
}

const futureMatch = (over: Record<string, unknown> = {}) => ({
  matchId: "m1", competition: "Liga Nacional", cancelledAt: null, finalized: false,
  kickoffAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
  homeTeam: { teamId: "ta", name: "Alpha FC", players: [{ playerId: "p1", name: "Ana Díaz" }] },
  awayTeam: { teamId: "tb", name: "Beta FC", players: [{ playerId: "p3", name: "Cleo Park" }] },
  venueActivations: [{ venueActivationId: "act-1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, prizeTiers: [] }],
  ...over,
});

async function open(page: PageName, mode: Mode, options: OpenOptions = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetched: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(String(e.message ?? e)));
  const session = options.session === undefined ? null : options.session;
  const stateSession = session ? { access_token: "token-A", user: { id: "uid-A", email: "a@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" } } : null;
  const client = {
    auth: {
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: stateSession } }; },
      async signOut() { return { error: null }; },
      async signInWithOtp() { return { data: {}, error: null }; },
      async verifyOtp() { return { data: { session: null }, error: { code: "otp_expired", message: "x" } }; },
    },
  };
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchFake = async (url: string, init?: Record<string, any>) => {
    const target = String(url);
    requests.push({ url: target, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (target === "/api/gaming/config") return json(200, { supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" });
    if (target === "/api/gaming/auth-methods") return json(200, { email: true, phone: false });
    if (target === "/api/gaming/member") {
      if (options.profileFails) throw new Error("offline");
      return json(200, { gamingMember: stateSession && !options.incomplete ? { gamingMemberId: "gm-A", displayName: "Persona A", createdAt: "2026-02-01T00:00:00.000Z" } : null });
    }
    if (target === "/api/gaming/host/availability") return json(200, { available: options.hostOpen === true });
    if (target === "/api/gaming/predictions/matches") return json(200, { matches: JSON.parse(JSON.stringify(options.matches ?? [])) });
    if (target.endsWith("/mine")) return json(200, options.mine ?? {});
    if (init?.method === "POST") { const out = options.predict ?? { status: 201, json: { prediction: { predictionId: "pr1" } } }; return json(out.status, out.json); }
    return json(404, {});
  };
  const html = options.html ?? PAGE_HTML[page];
  const dom = new JSDOM(html, {
    url: `http://localhost/${page}`, runScripts: "dangerously", resources: { interceptors: [interceptorFor(mode, fetched)] }, pretendToBeVisual: true, virtualConsole,
    beforeParse(window: any) {
      const w = window as any;
      Object.defineProperty(w.navigator, "language", { value: "en-US", configurable: true });
      Object.defineProperty(w.navigator, "languages", { value: ["en-US"], configurable: true });
      const position = options.position === undefined ? { latitude: 14.07, longitude: -87.19, accuracy: 8 } : options.position;
      Object.defineProperty(w.navigator, "geolocation", {
        configurable: true,
        value: { getCurrentPosition: (ok: (p: unknown) => void, fail: () => void) => (position ? ok({ coords: { latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy } }) : fail()) },
      });
      w.supabase = { createClient: () => client };
      w.fetch = fetchFake;
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as any;
  const doc = win.document as Document;
  await new Promise<void>((resolve) => { if (doc.readyState === "complete") resolve(); else win.addEventListener("load", () => resolve()); });
  await tick(80);
  const text = (selector: string) => (doc.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { win, doc, errors, fetched, requests, text, q: (selector: string) => doc.querySelector(selector) as HTMLElement | null };
}
type Page = Awaited<ReturnType<typeof open>>;

const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
const visible = (doc: Document) => {
  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("script, style").forEach((n) => n.remove());
  return norm(body.textContent);
};
const RAW_KEY = /\b(?:shell|home|pred|profile|auth)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*\b/;

function homeSnapshot(page: Page) {
  const { doc, text } = page;
  return {
    lang: doc.documentElement.lang, title: doc.title,
    hero: [text(".hero h1"), text(".hero p")],
    nav: Array.from(doc.querySelectorAll(".primary-nav a")).map((a) => [a.textContent, a.getAttribute("href")]),
    labels: Array.from(doc.querySelectorAll(".section-label")).map((e) => e.textContent),
    featured: { title: text("#featured-title"), descriptor: text(".featured-descriptor"), scope: text(".featured-scope"), when: text(".featured-when"), status: text("#featured-status"), note: text("#featured-note"), history: text("#featured-history"), links: Array.from(doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("href")), hasAction: page.q("#featured-action") !== null },
    cards: Array.from(doc.querySelectorAll(".exp-card")).map((c) => ({
      title: norm(c.querySelector("h3")?.textContent), tag: c.tagName, href: c.getAttribute("href"), locked: c.className.includes("is-locked"),
      pill: norm(c.querySelector(".status-pill")?.textContent), kicker: norm(c.querySelector(".art-kicker")?.textContent), sub: norm(c.querySelector(".exp-sub")?.textContent), action: norm(c.querySelector(".exp-action")?.textContent),
    })),
    footer: text("footer"),
    links: Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")),
  };
}
const predictionsSnapshot = (page: Page) => ({
  lang: page.doc.documentElement.lang, title: page.doc.title, heading: page.text("h1"), descriptor: page.text(".score-descriptor"), scope: page.text(".score-scope"),
  back: page.text(".back-link"), content: page.text("#content"), forms: page.doc.querySelectorAll("#content form").length,
  loginCta: page.doc.querySelectorAll("[data-login-cta]").length, cards: page.doc.querySelectorAll("#content [data-match-id]").length,
});
const profileSnapshot = (page: Page) => ({
  lang: page.doc.documentElement.lang, title: page.doc.title, heading: page.text("h1"), body: page.text("#profile-body"),
  link: (page.q("a.link-out") as HTMLAnchorElement | null)?.getAttribute("href") ?? null, buttons: Array.from(page.doc.querySelectorAll("#profile-body button")).map((b) => norm(b.textContent)),
});
const selectorHidden = (doc: Document) => Array.from(doc.querySelectorAll(".lang-switch")).every((g) => (g as HTMLElement).hidden || (g as HTMLElement).style.display === "none");

// ---------------------------------------------------------------------------------------------------------------------------------
// What "the module failed" really means on each page
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the failure is real, and the fallback is what runs", () => {
  for (const page of Object.keys(PAGE_HTML) as PageName[]) {
    for (const mode of FAILURES) {
      it(`${page} / ${mode}: the module never starts, the fallback is installed, and the language selector is not offered`, async () => {
        const loaded = await open(page, mode);
        expect(loaded.fetched).toContain("/urbanoI18n.js"); // the page really asked for the module
        expect(loaded.win.UrbanoI18n.fallback).toBe(true);
        expect(loaded.win.UrbanoI18n.getLang()).toBe("es");
        if (mode !== "partial") expect(loaded.errors.join(" | ")).toMatch(/urbanoI18n|Could not load|resource|Unexpected token|failed to start|fetch failed/i);
        expect(selectorHidden(loaded.doc)).toBe(true);
        expect(visible(loaded.doc)).not.toMatch(RAW_KEY);
        expect(visible(loaded.doc)).not.toContain("<<");
      });
    }
    it(`${page} / ok: with the module present the fallback is NOT used and the selector is offered`, async () => {
      const loaded = await open(page, "ok");
      expect(loaded.win.UrbanoI18n.fallback).toBeUndefined();
      expect(selectorHidden(loaded.doc)).toBe(false);
      expect(loaded.win.UrbanoI18n.getLang()).toBe("es");
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home without the module: the same content, the same behaviour", () => {
  const scenarios: Array<[string, OpenOptions]> = [
    ["no match open, Become a Host closed", {}],
    ["the database holds an open match (the announcement does not read it)", { matches: [futureMatch()] }],
    ["the database holds a match whose activation is disabled", { matches: [futureMatch({ venueActivations: [{ venueActivationId: "act-1", enabled: false, venue: { active: true } }] })] }],
    ["the server says Become a Host is open", { hostOpen: true }],
    ["signed in as a member", { session: "A" }],
  ];
  for (const [label, options] of scenarios) {
    it(`identical to the working page — ${label}`, async () => {
      const reference = homeSnapshot(await open("index.html", "ok", options));
      for (const mode of FAILURES) {
        const failed = await open("index.html", mode, options);
        expect(homeSnapshot(failed), mode).toEqual(reference);
        expect(visible(failed.doc)).not.toMatch(RAW_KEY);
      }
    });
  }

  it("every card is drawn, in the Founder's order, with the access each one had: only URBANO Poker and Trivia are links", async () => {
    for (const mode of FAILURES) {
      const page = await open("index.html", mode);
      const cards = homeSnapshot(page).cards;
      expect(cards.map((c) => c.title), mode).toEqual(["URBANO Poker", "Halloween", "Trivia", "URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]);
      expect(cards.filter((c) => !c.locked).map((c) => [c.title, c.href, c.pill]), mode).toEqual([["URBANO Poker", "/host.html?experience=poker", "Playtest"], ["Trivia", "/trivia-playtest.html", "Playtest"]]);
      for (const card of cards.filter((c) => c.locked)) {
        expect(card.tag).toBe("DIV");
        expect(card.href).toBeNull();
        expect(card.pill).toBe("Próximamente");
      }
    }
  });

  it("a language failure enables nothing: Become a Host stays closed until the server says open, URBANO Score stays an announcement with no way in even when the database holds an open match, and no request is made that the working page would not make", async () => {
    for (const mode of FAILURES) {
      const closed = await open("index.html", mode, { hostOpen: false, matches: [futureMatch()] });
      expect(closed.doc.querySelector('a[href="/become-a-host.html"]')).toBeNull();
      expect(closed.text("#featured-status")).toBe("Próximamente");
      expect(closed.text("#featured-note")).toBe("Predicciones próximamente");
      expect(closed.doc.querySelector("#featured-action")).toBeNull();
      expect(Array.from(closed.doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("href"))).toEqual(["/soccer-predictions.html"]);
      expect(closed.requests.some((r) => r.url.includes("/api/gaming/predictions"))).toBe(false);
      const reference = await open("index.html", "ok", { hostOpen: false, matches: [futureMatch()] });
      expect(closed.requests.map((r) => `${r.method} ${r.url}`).sort(), mode).toEqual(reference.requests.map((r) => `${r.method} ${r.url}`).sort());
      const openHost = await open("index.html", mode, { hostOpen: true });
      expect(openHost.doc.querySelectorAll('a[href="/become-a-host.html"]')).toHaveLength(1);
    }
  });

  it("the sign-in panel (shared client) opens in Spanish, not English, even though the module is gone", async () => {
    for (const mode of FAILURES) {
      const page = await open("index.html", mode);
      expect(page.text("#btn-signin")).toBe("Iniciar sesión / Crear cuenta");
      page.q("#btn-signin")!.click();
      await tick(30);
      const panel = norm(page.doc.querySelector("[data-urbano-signin-panel]")?.textContent);
      expect(panel, mode).toContain("Entrá a URBANO");
      expect(panel, mode).toContain("Iniciar sesión");
      expect(panel, mode).toContain("Crear cuenta");
      expect(panel, mode).not.toMatch(/Log in|Create account|Enter URBANO/);
    }
  });

  it("the account link in the header names the signed-in person in Spanish", async () => {
    for (const mode of FAILURES) {
      const page = await open("index.html", mode, { session: "A" });
      expect(page.text("#account-link"), mode).toBe("Hola, Persona A");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// URBANO Score (Predictions)
// ---------------------------------------------------------------------------------------------------------------------------------

describe("URBANO Score without the module: loaded, in Spanish, with every condition intact", () => {
  const submit = async (page: Page) => {
    (page.q("form") as HTMLFormElement).dispatchEvent(new page.win.Event("submit", { bubbles: true, cancelable: true }));
    await tick(60);
  };
  const scenarios: Array<[string, OpenOptions]> = [
    ["signed out, one open match", { matches: [futureMatch()] }],
    ["signed in with an unfinished account", { matches: [futureMatch()], session: "A", incomplete: true }],
    ["signed in, one open match (the form)", { matches: [futureMatch()], session: "A" }],
    ["no matches at all", { matches: [] }],
    ["a match that kicked off (locked)", { matches: [futureMatch({ kickoffAt: new Date(Date.now() - 3600_000).toISOString() })], session: "A" }],
    ["a finalized match with the member's result", { matches: [futureMatch({ finalized: true, finalResult: { homeScore: 2, awayScore: 1 }, kickoffAt: "2026-10-24T20:00:00.000Z" })], session: "A", mine: { prediction: { predictionId: "pr1", predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: "p1", predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME" }, evaluation: { evaluationId: "e1", scorelineCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: false, firstTeamToScoreCorrect: false, correctDimensionCount: 2 } } }],
  ];
  for (const [label, options] of scenarios) {
    it(`identical to the working page — ${label}`, async () => {
      const reference = predictionsSnapshot(await open("soccer-predictions.html", "ok", options));
      expect(reference.content).not.toContain("Cargando");
      for (const mode of FAILURES) {
        const failed = await open("soccer-predictions.html", mode, options);
        expect(predictionsSnapshot(failed), mode).toEqual(reference);
        expect(failed.text("#content")).not.toContain("Cargando"); // never left on "loading"
        expect(visible(failed.doc)).not.toMatch(RAW_KEY);
      }
    });
  }

  it("the name, descriptor and scope are on screen before and whatever happens to the list", async () => {
    for (const mode of FAILURES) {
      const page = await open("soccer-predictions.html", mode, { matches: [] });
      expect(page.text("h1")).toBe("URBANO Score");
      expect(page.text(".score-descriptor")).toBe("Tus predicciones deportivas");
      expect(page.text(".score-scope")).toBe("Por ahora solo hay fútbol disponible.");
      expect(page.doc.title).toBe("URBANO Score — URBANO Gaming");
    }
  });

  it("without a session there is no form and the only next step is to sign in; an unfinished account is asked to finish it", async () => {
    for (const mode of FAILURES) {
      const out = await open("soccer-predictions.html", mode, { matches: [futureMatch()] });
      expect(out.doc.querySelectorAll("form")).toHaveLength(0);
      expect(out.text("[data-login-cta]")).toBe("Iniciar sesión o crear cuenta");
      const unfinished = await open("soccer-predictions.html", mode, { matches: [futureMatch()], session: "A", incomplete: true });
      expect(unfinished.doc.querySelectorAll("form")).toHaveLength(0);
      expect(unfinished.text("[data-login-cta]")).toBe("Terminá de crear tu cuenta");
    }
  });

  it("without a location the submit is refused locally, in Spanish, and nothing is sent", async () => {
    for (const mode of FAILURES) {
      const page = await open("soccer-predictions.html", mode, { matches: [futureMatch()], session: "A", position: null });
      await submit(page);
      expect(page.text('[id^="submit-msg"]'), mode).toBe("Se requiere tu ubicación para enviar una predicción.");
      expect(page.requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual([]);
    }
  });

  it("known server answers are translated and unknown ones are never guessed at (generic Spanish), exactly as with the module", async () => {
    const cases: Array<[string, string]> = [
      ["Predictions are locked for this match.", "Las predicciones están cerradas para este partido."],
      ["This match has been cancelled.", "Este partido fue cancelado."],
      ["Submission failed geolocation eligibility.", "El envío no cumplió los requisitos de ubicación."],
      ["Some brand-new server message nobody mapped.", "No pudimos guardar tu predicción. Intentá de nuevo."],
    ];
    for (const mode of FAILURES) {
      for (const [server, spanish] of cases) {
        const page = await open("soccer-predictions.html", mode, { matches: [futureMatch()], session: "A", predict: { status: 409, json: { error: server } } });
        await submit(page);
        expect(page.text('[id^="submit-msg"]'), `${mode}: ${server}`).toBe(spanish);
        expect(page.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      }
    }
  });

  it("a successful save and a failed request with no message are said in Spanish; what is sent is identical to the working page", async () => {
    const sent = async (mode: Mode) => {
      const page = await open("soccer-predictions.html", mode, { matches: [futureMatch()], session: "A" });
      await submit(page);
      return { message: page.text('[id^="submit-msg"]'), posts: page.requests.filter((r) => r.method === "POST") };
    };
    const reference = await sent("ok");
    expect(reference.message).toBe("Predicción guardada. Podés editarla hasta el inicio del partido.");
    for (const mode of FAILURES) expect(await sent(mode), mode).toEqual(reference);
    const none = await open("soccer-predictions.html", "missing", { matches: [futureMatch()], session: "A", predict: { status: 500, json: null } });
    await submit(none);
    expect(none.text('[id^="submit-msg"]')).toBe("No se pudo enviar la predicción.");
  });

  it("when the list itself cannot be loaded the page says so in Spanish instead of staying on 'Cargando…'", async () => {
    for (const mode of FAILURES) {
      const page = await open("soccer-predictions.html", mode, { matches: [futureMatch()] });
      page.win.fetch = async () => { throw new Error("offline"); };
      page.win.eval("refresh().catch(function () { content.replaceChildren(emptyState('pred.err.load')); })");
      await tick(40);
      expect(page.text("#content"), mode).toBe("No pudimos cargar los partidos. Recargá la página para intentar de nuevo.");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the profile without the module: never 'Cargando…' for good", () => {
  const scenarios: Array<[string, OpenOptions]> = [
    ["signed in", { session: "A" }],
    ["signed out", {}],
    ["an unfinished account", { session: "A", incomplete: true }],
    ["the member lookup fails", { session: "A", profileFails: true }],
  ];
  for (const [label, options] of scenarios) {
    it(`identical to the working page — ${label}`, async () => {
      const reference = profileSnapshot(await open("profile.html", "ok", options));
      expect(reference.body).not.toContain("Cargando tu perfil");
      for (const mode of FAILURES) {
        const failed = await open("profile.html", mode, options);
        expect(profileSnapshot(failed), mode).toEqual(reference);
        expect(visible(failed.doc)).not.toMatch(RAW_KEY);
      }
    });
  }

  it("shows the person's own data in Spanish with the explicit verification state, and the link to their predictions names URBANO Score", async () => {
    for (const mode of FAILURES) {
      const page = await open("profile.html", mode, { session: "A" });
      const rows = Array.from(page.doc.querySelectorAll(".profile-fields .row")).map((r) => [norm(r.querySelector("dt")?.textContent), norm(r.querySelector("dd")?.textContent)]);
      expect(rows[0], mode).toEqual(["Nombre", "Persona A"]);
      expect(rows[1], mode).toEqual(["Correo", "a@example.com Verificado"]);
      expect(page.text("a.link-out")).toBe("Mis predicciones en URBANO Score →");
      expect(page.doc.querySelectorAll("#profile-body input, #profile-body form, #profile-body textarea")).toHaveLength(0); // still read-only
    }
  });

  it("a failed lookup says so in Spanish (no endless loading) and a signed-out visitor is offered the sign-in, nothing else", async () => {
    for (const mode of FAILURES) {
      const failed = await open("profile.html", mode, { session: "A", profileFails: true });
      expect(failed.text("#profile-body"), mode).toBe("No pudimos cargar tu perfil. Recargá la página para intentar de nuevo.");
      const out = await open("profile.html", mode);
      expect(out.text("#profile-body")).toContain("Iniciá sesión para ver tu perfil.");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The generated blocks follow the dictionary
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the generated Spanish blocks never drift from the module's dictionary", () => {
  const moduleApi = (() => {
    const sandbox: any = { window: {}, document: undefined };
    sandbox.window = sandbox;
    vm.runInNewContext(I18N_SOURCE, sandbox);
    return sandbox.UrbanoI18n;
  })();
  const dictionary = moduleApi.dictionary() as { es: Record<string, string> };
  const SERVER_MESSAGES = (() => {
    const m = I18N_SOURCE.match(/var SERVER_MESSAGES = (\{[\s\S]*?\n  \});/)!;
    return vm.runInNewContext("(" + m[1] + ")") as Record<string, string>;
  })();
  const PREFIXES: Record<PageName, string[]> = { "index.html": ["shell.", "home.", "auth."], "soccer-predictions.html": ["shell.", "pred.", "auth."], "profile.html": ["shell.", "profile.", "auth."] };

  function fallbackOf(page: PageName) {
    const m = PAGE_HTML[page].match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/);
    expect(m, `${page} carries the block`).not.toBeNull();
    const sandbox: any = { document: { querySelectorAll: () => [] } };
    sandbox.window = sandbox;
    vm.runInNewContext(m![1], sandbox);
    return sandbox.UrbanoI18n;
  }

  for (const page of Object.keys(PAGE_HTML) as PageName[]) {
    it(`${page}: exactly the Spanish keys of its prefixes, with exactly the module's words`, () => {
      const fallback = fallbackOf(page);
      const expected = Object.fromEntries(Object.entries(dictionary.es).filter(([key]) => PREFIXES[page].some((p) => key.startsWith(p))));
      expect(fallback.dictionary().es).toEqual(expected);
      expect(Object.keys(expected).length).toBeGreaterThan(50);
    });

    it(`${page}: t() agrees with the module for every key, with placeholders and with translated variables`, () => {
      const fallback = fallbackOf(page);
      for (const [key, template] of Object.entries(dictionary.es)) {
        if (!PREFIXES[page].some((p) => key.startsWith(p))) continue;
        const names = Array.from(template.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);
        const vars = Object.fromEntries(names.map((n, i) => [n, i % 2 ? { $t: "shell.nav.home" } : `valor-${n}`]));
        expect(fallback.t(key, vars), key).toBe(moduleApi.t(key, vars));
        expect(fallback.has(key)).toBe(true);
      }
      expect(fallback.t("not.a.key")).toBe("not.a.key");
      expect(fallback.has("not.a.key")).toBe(false);
      expect(fallback.locale()).toBe(moduleApi.locale());
    });
  }

  it("the Predictions block maps every known server message to the module's key, and nothing else (the other pages map none)", () => {
    const fallback = fallbackOf("soccer-predictions.html");
    for (const [message, key] of Object.entries(SERVER_MESSAGES)) expect(fallback.serverMessageKey(message), message).toBe(key);
    expect(fallback.serverMessageKey("Some brand-new server message nobody mapped.")).toBeNull();
    expect(fallbackOf("index.html").serverMessageKey("Predictions are locked for this match.")).toBeNull();
    expect(fallbackOf("profile.html").serverMessageKey("Predictions are locked for this match.")).toBeNull();
  });

  it("every dictionary key a page's own script or markup uses is in that page's block (so nothing can fall back to a raw key)", () => {
    for (const page of Object.keys(PAGE_HTML) as PageName[]) {
      const fallback = fallbackOf(page);
      const html = PAGE_HTML[page].replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "");
      const used = new Set(Array.from(html.matchAll(/["'`](?:shell|home|pred|profile|auth)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*["'`]/g)).map((m) => m[0].slice(1, -1)));
      for (const key of used) expect(fallback.has(key), `${page} uses ${key}`).toBe(true);
    }
  });

  it("the Spanish the HTML ships as its first paint is the dictionary's Spanish (so a page without the module reads exactly like one with it)", () => {
    for (const page of Object.keys(PAGE_HTML) as PageName[]) {
      const html = PAGE_HTML[page].replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "").replace(/<script[\s\S]*?<\/script>/g, "");
      for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
        if (m[0].includes("data-i18n-vars")) continue;
        expect(norm(m[3]), `${page}: ${m[2]}`).toBe(norm(dictionary.es[m[2]]));
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: remove each protection from a COPY of a page and the scenario it guards must then fail.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("negative controls", () => {
  const block = (page: PageName) => PAGE_HTML[page].match(/<script id="i18n-fallback">[\s\S]*?<\/script>/)![0];

  it("without the fallback block the Home draws no cards (the original defect)", async () => {
    const html = PAGE_HTML["index.html"].replace(block("index.html"), "");
    const page = await open("index.html", "missing", { html, matches: [futureMatch()] });
    expect(page.doc.querySelectorAll(".exp-card")).toHaveLength(0);
    expect(page.errors.join(" ")).toMatch(/UrbanoI18n is not defined/);
  });

  it("without the fallback block Predictions and the profile stay on 'Cargando…' for good (the original defect)", async () => {
    const { result, rejections } = await expectingUnhandledRejections(async () => {
      const predictions = await open("soccer-predictions.html", "missing", { html: PAGE_HTML["soccer-predictions.html"].replace(block("soccer-predictions.html"), ""), matches: [futureMatch()] });
      const profile = await open("profile.html", "missing", { html: PAGE_HTML["profile.html"].replace(block("profile.html"), ""), session: "A" });
      return { predictions: predictions.text("#content"), profile: profile.text("#profile-body") };
    });
    expect(result.predictions).toContain("Cargando");
    expect(result.profile).toContain("Cargando");
    expect(rejections.join(" ")).toMatch(/UrbanoI18n is not defined/); // the cause: the unguarded call
  });

  it("a fallback word that differs from the module's is caught by the differential check", async () => {
    const html = PAGE_HTML["index.html"].replace('"home.poker.action": "Organizar →"', '"home.poker.action": "Organizar con Soccer Predictions →"');
    expect(html).not.toBe(PAGE_HTML["index.html"]);
    const options = { matches: [futureMatch()] };
    const reference = homeSnapshot(await open("index.html", "ok", options));
    const mutated = homeSnapshot(await open("index.html", "missing", { ...options, html }));
    expect(mutated).not.toEqual(reference);
    expect(mutated.cards.find((c) => c.title === "URBANO Poker")!.action).toBe("Organizar con Soccer Predictions →");
  });

  it("a fallback that replaced a WORKING module (guard removed) is caught: the selector would be hidden and English lost", async () => {
    const html = PAGE_HTML["index.html"].replace(/if \(m && typeof m\.t === "function"[^\n]*\n/, "");
    expect(html).not.toBe(PAGE_HTML["index.html"]);
    const page = await open("index.html", "ok", { html });
    expect(page.win.UrbanoI18n.fallback).toBe(true); // wrong: the real module was thrown away
    expect(selectorHidden(page.doc)).toBe(true);
  });

  it("a stub that only defines t (partial) is not trusted: the page still ends up in Spanish words, not '<<key>>'", async () => {
    const html = PAGE_HTML["index.html"].replace(/if \(m && typeof m\.t === "function" && [^\n]*\) return;/, 'if (m && typeof m.t === "function") return;');
    expect(html).not.toBe(PAGE_HTML["index.html"]);
    const page = await open("index.html", "partial", { html });
    expect(visible(page.doc)).toContain("<<"); // with the guard weakened the half-module is used and raw keys leak onto the page
  });
});
