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
 * Update of 2026-10-31 (Founder direction: the Home shows four experiences): the Home no longer carries the "Próximos partidos" card or the Become a Host card,
 * so the tests that proved THOSE cards survive a failing language module (and their negative controls) were retired with them (git history, 98bb902; the old Home is
 * kept in archive/home.score-card-2026-10-29.html). The differential below now compares the new Home's four panels, the strip of crests on the Score panel and the sentence
 * beside it, the header's account control and the footer, with and without the module, in every failure mode; the Score page and the profile are unchanged.
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
const CRESTS_SOURCE = read("public/urbanoClubCrests.js");
const FEATURED_SOURCE = read("public/featuredContest.js"); // the featured card's module (one strict read; fail-closed)
const UPCOMING_DATA_SOURCE = read("public/homeUpcomingData.js");
const UPCOMING_SOURCE = read("public/homeUpcoming.js");

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
function interceptorFor(mode: Mode, fetched: string[], upcomingSource: string = UPCOMING_SOURCE) {
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
    if (url.pathname === "/featuredContest.js") return js(FEATURED_SOURCE); // the Home's featured card: two buttons that are links only when the server's answer is exactly right
    if (url.pathname === "/urbanoClubCrests.js") return js(CRESTS_SOURCE); // decoration: the crests of the ten teams (Home) and of the teams of a match (Score)
    if (url.pathname === "/homeUpcomingData.js") return js(UPCOMING_DATA_SOURCE);
    if (url.pathname === "/homeUpcoming.js") return js(upcomingSource); // the shipped module (a negative control serves a modified COPY of it)
    return new Response("", { status: 404 });
  });
}

/** The page's own clock, fixed at `iso` and ticking from there. The "Próximos partidos" list is real data that leaves the card as its matches pass, so what
 *  these pages show of it may not depend on today's date. */
function fixClock(window: any, iso: string) {
  const RealDate = window.Date;
  const offset = Date.parse(iso) - RealDate.now();
  function FakeDate(...args: unknown[]) { return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset); }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
}
/** The Home is always opened at this instant (the day of the Founder's decisions); the Score page only when a test says so (its fixtures are built from the real clock). */
const HOME_NOW = "2026-10-29T15:00:00Z";

interface OpenOptions {
  now?: string; // the page's clock, fixed (default: the Home's HOME_NOW; the Score page and the profile run on the real clock)
  html?: string;
  session?: "A" | null; // signed in as A (a finished member) or nobody
  incomplete?: boolean; // signed in, but the account is not finished
  matches?: unknown[];
  mine?: Record<string, unknown>;
  predict?: { status: number; json: unknown };
  position?: { latitude: number; longitude: number; accuracy: number } | null;
  hostOpen?: boolean;
  profileFails?: boolean;
  /** How the public matches list answers instead of a good list: never answers, the network fails, or an answer that is not a list (an error status, a body without `matches`, no body, not JSON). */
  list?: "pending" | "offline" | { status: number; body?: unknown; notJson?: boolean };
  upcomingSource?: string; // negative controls only: a modified copy of /homeUpcoming.js
}

/** The first announced match of the editorial list (Valencia – Real Madrid, 7 Nov 2026 20:00 UTC) as the public matches list would return it, with an enabled activation and an available offer. */
const announcedMatch = (over: Record<string, unknown> = {}) => ({
  matchId: "n26-26", competition: "LaLiga", cancelledAt: null, finalized: false, kickoffAt: "2026-11-07T20:00:00.000Z", participationOpensAt: null,
  homeTeam: { teamId: "tv", name: "Valencia", players: [] }, awayTeam: { teamId: "tr", name: "Real Madrid", players: [] },
  venueActivations: [{ venueActivationId: "act-9", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, prizeTiers: [], offer: { available: true } }],
  ...over,
});

/** Every way the public matches list can fail to be READ. None of them is "there are no matches". */
const UNREADABLE_LISTS: Array<[string, NonNullable<OpenOptions["list"]>]> = [
  ["HTTP 500 {error}", { status: 500, body: { error: "boom" } }],
  ["HTTP 401 {error}", { status: 401, body: { error: "no" } }],
  ["200 {matches:null}", { status: 200, body: { matches: null } }],
  ["200 {}", { status: 200, body: {} }],
  ["200 with no body", { status: 200, body: null }],
  ["200 that is not JSON", { status: 200, notJson: true }],
  ["the network fails", "offline"],
];

const clubTeam = (name: string) => ({ teamId: `t-${name}`, name, players: [] });
/** A match the server says is open that is NOT one of the editorial rows (another fixture altogether): it must change the sentence under the list, and no row. */
const openElsewhere = (over: Record<string, unknown> = {}) => announcedMatch({ matchId: "elsewhere", competition: "Liga Nacional", kickoffAt: "2026-11-03T20:00:00.000Z", homeTeam: clubTeam("Alpha FC"), awayTeam: clubTeam("Beta FC"), ...over });
/** Valencia – Real Madrid under another spelling (the server's own): open for participation, and tied to no row by the strict rule (a twin only, for the Score page). */
const respelled = (over: Record<string, unknown> = {}) => announcedMatch({ homeTeam: clubTeam("Valencia CF"), awayTeam: clubTeam("Real Madrid CF"), ...over });

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
    if (target === "/api/gaming/predictions/matches") {
      const list = options.list;
      if (list === "offline") throw new TypeError("fetch failed");
      if (list === "pending") return new Promise(() => {});
      if (list) return { ok: list.status >= 200 && list.status < 300, status: list.status, json: async () => { if (list.notJson) throw new SyntaxError("Unexpected token < in JSON"); return list.body; } };
      return json(200, { matches: JSON.parse(JSON.stringify(options.matches ?? [])) });
    }
    if (target.endsWith("/mine")) return json(200, options.mine ?? {});
    if (init?.method === "POST") { const out = options.predict ?? { status: 201, json: { prediction: { predictionId: "pr1" } } }; return json(out.status, out.json); }
    return json(404, {});
  };
  const html = options.html ?? PAGE_HTML[page];
  const dom = new JSDOM(html, {
    url: `http://localhost/${page}`, runScripts: "dangerously", resources: { interceptors: [interceptorFor(mode, fetched, options.upcomingSource)] }, pretendToBeVisual: true, virtualConsole,
    beforeParse(window: any) {
      const w = window as any;
      const now = options.now ?? (page === "index.html" ? HOME_NOW : undefined);
      if (now) fixClock(w, now);
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
  // every text node on its own, separated: a raw key that sits right against another word (the rows of a list are inline elements with no
  // whitespace between them) cannot hide in it
  const parts: string[] = [];
  const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return norm(parts.join(" "));
};
/** A dictionary key as a page's own script or markup (or the card's module) writes it: quoted, with one of the dictionary's prefixes. */
const USED_KEY = /["'`](?:shell|home|pred|legal|profile|auth|upcoming)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*["'`]/g;
const RAW_KEY = /\b(?:shell|home|pred|legal|profile|auth|upcoming)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*\b/;

/** The rows of a "Próximos partidos" list (the Home card, or the preselection in the Score lineup), as a person reads them. */
const upcomingRows = (doc: Document, listSelector: string) => Array.from(doc.querySelectorAll(`${listSelector} .upcoming-item`)).map((row) => ({
  id: row.getAttribute("data-match"), state: row.getAttribute("data-state"), time: row.getAttribute("data-time"),
  teams: Array.from(row.querySelectorAll(".upcoming-team")).map((t) => norm(t.textContent)), vs: norm(row.querySelector(".upcoming-vs")?.textContent),
  competition: norm(row.querySelector(".upcoming-comp")?.textContent), when: norm(row.querySelector(".upcoming-time")?.textContent), datetime: row.querySelector("time")?.getAttribute("datetime") ?? null,
  chip: norm(row.querySelector(".upcoming-chip")?.textContent), opens: norm(row.querySelector(".upcoming-opens")?.textContent),
}));

function homeSnapshot(page: Page) {
  const { doc, text } = page;
  return {
    lang: doc.documentElement.lang, title: doc.title,
    hero: [text(".hero h1"), text(".hero p")],
    // the four experience panels of the Home (since 2026-10-31), the strip of the ten crests on the Score panel and the sentence beside it
    panels: Array.from(doc.querySelectorAll("article.xp")).map((c) => ({
      cls: c.className, title: norm(c.querySelector(".xp-title")?.textContent), kicker: norm(c.querySelector(".xp-kicker")?.textContent), chip: norm(c.querySelector(".xp-chip")?.textContent),
      desc: norm(c.querySelector(".xp-desc")?.textContent), cta: norm(c.querySelector(".xp-cta")?.textContent), href: c.querySelector("a.xp-cta")?.getAttribute("href") ?? null,
    })),
    featured: {
      label: text("#featured-contest .xf-label"), product: text("#featured-contest .xp-kicker"), title: text("#featured-contest .xf-title"), meta: text("#featured-contest .xf-meta"), desc: text("#featured-contest .xf-desc"),
      buttons: Array.from(doc.querySelectorAll("#featured-contest [data-feat]")).map((e) => [e.tagName, norm(e.textContent), e.getAttribute("href")]), status: text("#featured-contest [data-feat-status]"),
    },
    teams: Array.from(doc.querySelectorAll("article.xp-score li.crest-chip")).map((li) => [li.getAttribute("data-club"), norm(li.querySelector(".crest-name")?.textContent), li.querySelector("img.club-crest")?.getAttribute("data-crest") ?? null]),
    teamsLabel: text("#featured-teams-label"), teamsLegal: text("article.xp-score .featured-legal"), choose: text(".xp-choose"),
    nav: Array.from(doc.querySelectorAll(".primary-nav a")).map((a) => [a.textContent, a.getAttribute("href")]),
    labels: Array.from(doc.querySelectorAll(".section-label")).map((e) => e.textContent),
    cards: Array.from(doc.querySelectorAll(".exp-card")).map((c) => ({
      // (the Halloween announcement is a static section above the Score card: its title is an h2 and it carries a date and an availability line of its own)
      title: norm(c.querySelector("h2, h3")?.textContent), tag: c.tagName, href: c.getAttribute("href"), locked: c.className.includes("is-locked"),
      pill: norm(c.querySelector(".status-pill")?.textContent), kicker: norm(c.querySelector(".art-kicker")?.textContent), sub: norm(c.querySelector(".exp-sub")?.textContent), action: norm(c.querySelector(".exp-action")?.textContent),
      date: norm(c.querySelector(".halloween-date")?.textContent), availability: norm(c.querySelector(".halloween-availability")?.textContent),
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
    ["the database holds an announced match that the server says is open (the row says so; nothing else changes)", { matches: [announcedMatch()] }],
    ["the database holds an announced match with an approved window that has not opened (the opening hour is the server's)", { matches: [announcedMatch({ participationOpensAt: "2026-11-07T17:07:00.000Z" })] }],
    ["an approved window that opens at 1:07 p. m. (one o'clock takes the singular article)", { matches: [announcedMatch({ participationOpensAt: "2026-11-07T19:07:00.000Z" })] }],
    ["the server holds an open match that is not one of the rows (the sentence follows the server's list; no row changes)", { matches: [openElsewhere()] }],
    ["the server holds the announced match under another spelling, open (it ties to no row; the sentence says some are open)", { matches: [respelled()] }],
    ["the server's only match is cancelled, finalized or already started (the sentence says none is open)", { matches: [openElsewhere({ cancelledAt: "2026-10-28T00:00:00.000Z" }), openElsewhere({ finalized: true }), openElsewhere({ kickoffAt: "2026-10-28T20:00:00.000Z" })] }],
    ...UNREADABLE_LISTS.map(([label, list]) => [`the public matches list cannot be read (${label}): the sentence is not shown`, { list }] as [string, OpenOptions]),
    ["the public matches list has not answered yet: the sentence is not shown", { list: "pending" }],
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
      page.win.eval("refresh().catch(function () { showLoadError('pred.err.load'); })");
      await tick(40);
      expect(page.text("#cartelera .load-error .msg"), mode).toBe("No pudimos cargar los partidos. Intentá de nuevo.");
      expect(page.text("#historial .load-error .msg"), mode).toBe("No pudimos cargar tu historial de participaciones y premios. Intentá de nuevo.");
      expect(page.text("#historial [data-retry]"), mode).toBe("Reintentar"); // the fallback table carries the new words as well
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// URBANO Score: the lineup, the history, the access to it and the preselection — the new words must never leak as raw keys
// ---------------------------------------------------------------------------------------------------------------------------------

describe("URBANO Score without the module: the same sections, the same access to the history, the same preselection", () => {
  const SCORE_NOW = "2026-10-29T15:00:00Z"; // the page's clock here: the fixtures below are written from it, not from today's date
  const MINE = {
    prediction: { predictionId: "pr1", predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: "p1", predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", venueActivationId: "act-1" },
    evaluation: { evaluationId: "e1", scorelineCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: false, firstTeamToScoreCorrect: false, correctDimensionCount: 2 },
    qualification: { prizeQualificationId: "q1", venueActivationId: "act-1", prizeTierId: "tier-2", redeemedAt: null, supersededAt: null, alreadyDelivered: false, underReview: false },
  };
  /** El Clásico of 25 October: finished, with its result, the member's participation and a prize. It belongs in the History, and only there. */
  const clasico = () => futureMatch({
    matchId: "clasico", competition: "La Liga", finalized: true, finalResult: { homeScore: 2, awayScore: 1 }, kickoffAt: "2026-10-25T20:00:00.000Z",
    homeTeam: { teamId: "ta", name: "FC Barcelona", players: [{ playerId: "p1", name: "Ana Díaz" }, { playerId: "p2", name: "Bob Stone" }] },
    awayTeam: { teamId: "tb", name: "Real Madrid", players: [{ playerId: "p3", name: "Cleo Park" }] },
    venueActivations: [{ venueActivationId: "act-1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, prizeTiers: [{ prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: "Pitcher gratis" }] }],
  });
  const openMatch = () => futureMatch({ matchId: "m-open", kickoffAt: "2026-10-30T20:00:00.000Z" }); // a day after SCORE_NOW

  const section = (page: Page, id: string) => ({
    id, heading: page.text(`#${id} > h2`), intro: page.text(`#${id} > .score-section-intro`),
    cards: Array.from(page.doc.querySelectorAll(`#${id} [data-match-id]`)).map((c) => c.getAttribute("data-match-id")), empty: page.text(`#${id} > .empty-state`),
  });
  const scoreSnapshot = (page: Page) => {
    const { doc, text } = page;
    const block = doc.getElementById("lineup-upcoming") as HTMLElement | null;
    return {
      lang: doc.documentElement.lang,
      access: { label: doc.querySelector(".score-access")?.getAttribute("aria-label") ?? null, text: text(".score-access-link"), href: doc.querySelector(".score-access-link")?.getAttribute("href") ?? null, note: text(".score-access-note") },
      order: Array.from(doc.querySelectorAll("#content > section")).map((e) => e.id),
      sections: [section(page, "cartelera"), section(page, "historial")],
      upcoming: block ? { hidden: block.hidden, title: text("#lineup-upcoming h3"), note: text("#lineup-upcoming .score-section-intro"), label: doc.getElementById("score-upcoming")?.getAttribute("aria-label") ?? null, role: doc.getElementById("score-upcoming")?.getAttribute("role") ?? null, rows: upcomingRows(doc, "#score-upcoming") } : null,
      // the note about the crests: drawn after every successful drawing as the LAST child of #content, never in a loading or an error state
      crestsNote: (() => { const note = doc.querySelector(".score-crests-note"); const content = doc.getElementById("content"); return note ? { text: norm(note.textContent), last: content?.lastElementChild === note, parentIsContent: note.parentElement === content, count: doc.querySelectorAll(".score-crests-note").length } : null; })(),
      history: Array.from(doc.querySelectorAll("#historial [data-match-id]")).map((c) => ({ id: c.getAttribute("data-match-id"), result: norm(c.querySelector(".status-pill")?.textContent), prize: norm(c.querySelector("[data-prize-slot]")?.textContent) })),
    };
  };
  const ROWS_ES = [
    ["N26-26", "next", "set", "sáb 7 nov · 🇭🇳 2:00 p. m.", "Preselección"], ["N26-27", "next", "set", "dom 8 nov · 🇭🇳 2:00 p. m.", "Preselección"], ["N26-46", "next", "tbc", "jue 19 nov · Horario por confirmar", "Preselección"],
    ["N26-22", "next", "set", "dom 22 nov · 🇭🇳 10:30 a. m.", "Preselección"], ["N26-24", "next", "set", "dom 29 nov · 🇭🇳 10:30 a. m.", "Preselección"],
  ];
  const CRESTS_NOTE_ES = { text: "Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.", last: true, parentIsContent: true, count: 1 };
  const LOAD_ERROR_ES = "No pudimos cargar los partidos. Intentá de nuevo.";
  const HISTORY_ERROR_ES = "No pudimos cargar tu historial de participaciones y premios. Intentá de nuevo.";
  const rowsOf = (snapshot: ReturnType<typeof scoreSnapshot>) => (snapshot.upcoming?.rows ?? []).map((r) => [r.id, r.state, r.time, r.when, r.chip]);
  const ACCESS_ES = { label: "Accesos de URBANO Score", text: "Mis participaciones y premios", href: "#historial", note: "Tus participaciones en partidos finalizados y el estado de tus premios." };
  const CLASICO_ES = { id: "clasico", result: "Resultado: 2–1", prize: "Premio obtenido: Pitcher gratis — todavía sin canjear — consultá con un anfitrión de URBANO." };

  /** The page with the module, and with each failure of it: the same snapshot, no raw key, nothing left on 'Cargando', and the access always has somewhere to go. */
  async function sameWithoutTheModule(options: OpenOptions) {
    const reference = await open("soccer-predictions.html", "ok", { now: SCORE_NOW, ...options });
    const expected = scoreSnapshot(reference);
    expect(visible(reference.doc)).not.toMatch(RAW_KEY);
    for (const mode of FAILURES) {
      const failed = await open("soccer-predictions.html", mode, { now: SCORE_NOW, ...options });
      expect(scoreSnapshot(failed), mode).toEqual(expected);
      expect(visible(failed.doc), mode).not.toMatch(RAW_KEY);
      expect(failed.text("#content"), mode).not.toContain("Cargando");
      expect(failed.doc.querySelector(String(expected.access.href)), `${mode}: the access to the history has somewhere to go`).not.toBeNull();
    }
    return expected;
  }

  it("the finished Clásico is in the History only, with its result, the member's participation and the prize; the Lineup says nothing is open and lists the shortlist (the match without an hour included, every one 'Preselección')", async () => {
    const snapshot = await sameWithoutTheModule({ matches: [clasico()], session: "A", mine: MINE });
    expect(snapshot.lang).toBe("es");
    expect(snapshot.access).toEqual(ACCESS_ES);
    expect(snapshot.order).toEqual(["cartelera", "historial"]);
    expect(snapshot.sections).toEqual([
      { id: "cartelera", heading: "Cartelera", intro: "", cards: [], empty: "Todavía no hay partidos abiertos para predicciones — volvé pronto." },
      { id: "historial", heading: "Historial", intro: "Partidos finalizados, con tu participación y tus premios.", cards: ["clasico"], empty: "" },
    ]);
    expect(snapshot.history).toEqual([CLASICO_ES]);
    expect(snapshot.upcoming).toMatchObject({ hidden: false, title: "Próximos partidos (preselección)", note: "Por ahora no están abiertos para participar. Fechas y horarios informativos: pueden cambiar. Hora de Honduras.", label: "Lista de próximos partidos", role: "list" });
    expect(snapshot.crestsNote).toEqual(CRESTS_NOTE_ES); // the same words, the same place (the last child of the content), with and without the language module
    expect(rowsOf(snapshot)).toEqual(ROWS_ES);
    expect(snapshot.upcoming!.rows.map((r) => r.teams.join(" vs "))).toEqual(["Valencia vs Real Madrid", "Atlético de Madrid vs FC Barcelona", "Motagua vs Olimpia", "Liverpool vs Manchester United", "Arsenal vs Manchester City"]);
    expect(snapshot.upcoming!.rows.map((r) => r.opens)).toEqual(["", "", "", "", ""]); // no window hour: the server reported none
    expect(snapshot.upcoming!.rows[2].datetime).toBe("2026-11-19"); // the match without an hour keeps a date and no instant
  });

  it("a match that is open is a card in the Lineup and the Clásico stays in the History; the preselection is unchanged", async () => {
    const snapshot = await sameWithoutTheModule({ matches: [clasico(), openMatch()], session: "A", mine: MINE });
    expect(snapshot.sections.map((s) => [s.id, s.heading, s.cards, s.empty])).toEqual([["cartelera", "Cartelera", ["m-open"], ""], ["historial", "Historial", ["clasico"], ""]]);
    expect(snapshot.history).toEqual([CLASICO_ES]);
    expect(rowsOf(snapshot)).toEqual(ROWS_ES);
    expect(snapshot.access).toEqual(ACCESS_ES);
  });

  it("the server's word is honoured: an announced match it says is open is a card in the Lineup and leaves the preselection (which lists only matches that are just announced)", async () => {
    const snapshot = await sameWithoutTheModule({ matches: [clasico(), announcedMatch()], session: "A", mine: MINE });
    expect(snapshot.sections[0].cards).toEqual(["n26-26"]);
    expect(rowsOf(snapshot)).toEqual(ROWS_ES.slice(1));
  });

  it("with no match at all both sections still exist, say so in Spanish, and the access to the history still works; the preselection is still listed", async () => {
    const snapshot = await sameWithoutTheModule({ matches: [] });
    expect(snapshot.access).toEqual(ACCESS_ES);
    expect(snapshot.sections).toEqual([
      { id: "cartelera", heading: "Cartelera", intro: "", cards: [], empty: "Todavía no hay partidos abiertos para predicciones — volvé pronto." },
      { id: "historial", heading: "Historial", intro: "Partidos finalizados, con tu participación y tus premios.", cards: [], empty: "Todavía no hay partidos finalizados." },
    ]);
    expect(snapshot.history).toEqual([]);
    expect(rowsOf(snapshot)).toEqual(ROWS_ES);
    expect(snapshot.crestsNote).toEqual(CRESTS_NOTE_ES); // the note closes every successful drawing, matches or not
  });

  it("when every announced match has passed the preselection is not shown at all (no empty heading, no raw key), and the History and the access remain", async () => {
    const snapshot = await sameWithoutTheModule({ matches: [clasico()], session: "A", mine: MINE, now: "2026-12-30T00:00:00Z" });
    expect(snapshot.upcoming).toMatchObject({ hidden: true, rows: [] });
    expect(snapshot.history).toEqual([CLASICO_ES]);
    expect(snapshot.access).toEqual(ACCESS_ES);
    expect(snapshot.sections[1]).toMatchObject({ id: "historial", cards: ["clasico"] });
    expect(snapshot.crestsNote).toEqual(CRESTS_NOTE_ES);
  });

  it("a server match that is the announced one under another spelling (a twin) is a card in the Lineup and its row leaves the shortlist, with and without the module; a server match with nothing in common leaves every row", async () => {
    const twin = await sameWithoutTheModule({ matches: [clasico(), respelled()], session: "A", mine: MINE });
    expect(twin.sections[0].cards).toEqual(["n26-26"]);
    expect(rowsOf(twin)).toEqual(ROWS_ES.slice(1)); // Valencia CF – Real Madrid CF is the card; its row «Valencia – Real Madrid» would contradict it
    expect(twin.crestsNote).toEqual(CRESTS_NOTE_ES);
    const unrelated = await sameWithoutTheModule({ matches: [openElsewhere()], session: "A", mine: MINE });
    expect(unrelated.sections[0].cards).toEqual(["elsewhere"]);
    expect(rowsOf(unrelated)).toEqual(ROWS_ES);
  });

  it("the note about the crests is the last thing of a drawing and exists only in a drawing: not while the list is still loading, and not in the error state — the same with and without the module", async () => {
    for (const mode of ["ok", ...FAILURES] as const) {
      const loading = await open("soccer-predictions.html", mode, { now: SCORE_NOW, list: "pending" });
      expect(loading.text("#content"), mode).toContain("Cargando");
      expect(scoreSnapshot(loading).crestsNote, mode).toBeNull();
      expect(loading.doc.querySelector("#content > section, .upcoming-item"), mode).toBeNull();
    }
  });

  // An unreadable list is a LOAD FAILURE, never "no matches": the person looking for their prize must not be told that nothing is finished.
  for (const [label, list] of UNREADABLE_LISTS) {
    it(`a list that cannot be read (${label}) shows a recoverable load error in the two parts and draws nothing from it — no «Todavía no hay partidos finalizados.», no shortlist, no note about crests — with and without the module`, async () => {
      const options: OpenOptions = { now: SCORE_NOW, list, session: "A", mine: MINE, matches: [clasico()] };
      const check = (page: Page, mode: Mode) => {
        expect([...page.doc.querySelectorAll("#content > *")].map((node) => node.id), mode).toEqual(["cartelera", "historial"]); // the error shells of the two parts: the access has somewhere to go
        expect(page.text("#cartelera .load-error .msg"), mode).toBe(LOAD_ERROR_ES);
        expect(page.text("#historial .load-error .msg"), mode).toBe(HISTORY_ERROR_ES);
        expect(page.doc.querySelectorAll("#content [data-retry]"), mode).toHaveLength(2);
        for (const id of ["lineup-upcoming", "score-upcoming"]) expect(page.doc.getElementById(id), `${mode}: #${id}`).toBeNull();
        expect(page.doc.querySelector(".upcoming-item, .score-crests-note, [data-match-id], .empty-state"), mode).toBeNull();
        expect(visible(page.doc), mode).not.toMatch(/Todavía no hay partidos (finalizados|abiertos)/);
        expect(visible(page.doc), mode).not.toMatch(RAW_KEY);
        expect(page.text("#content"), mode).not.toContain("Cargando");
      };
      const reference = await open("soccer-predictions.html", "ok", options);
      check(reference, "ok");
      const expected = scoreSnapshot(reference);
      expect(expected.crestsNote).toBeNull();
      expect(expected.upcoming).toBeNull();
      for (const mode of FAILURES) {
        const failed = await open("soccer-predictions.html", mode, options);
        check(failed, mode);
        expect(scoreSnapshot(failed), mode).toEqual(expected);
      }
    });
  }
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
  const PREFIXES: Record<PageName, string[]> = { "index.html": ["shell.", "home.", "auth.", "upcoming."], "soccer-predictions.html": ["shell.", "pred.", "legal.", "auth.", "upcoming."], "profile.html": ["shell.", "profile.", "auth."] };

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

  it("the words of the review: the singular opening-hour template and the crests disclaimer are in the module and in the Home and Score blocks, and the disclaimer that moved to the shared 'upcoming.' prefix no longer exists under 'home.'", () => {
    const english = moduleApi.dictionary().en as Record<string, string>;
    expect(dictionary.es["upcoming.opensAtOne"]).toBe("Participación desde la {time} (hora de Honduras)");
    expect(english["upcoming.opensAtOne"]).toBe(english["upcoming.opensAt"]); // English has no singular article: the same sentence
    expect(dictionary.es["upcoming.disclaimer"]).toMatch(/^Los escudos solo identifican a los equipos\./);
    expect(english["upcoming.disclaimer"]).toMatch(/^Crests only identify the teams\./);
    expect(Object.keys(dictionary.es).concat(Object.keys(english))).not.toContain("home.upcoming.disclaimer");
    expect(I18N_SOURCE).not.toContain("home.upcoming.disclaimer");
    for (const page of ["index.html", "soccer-predictions.html"] as const) {
      const fallback = fallbackOf(page);
      for (const key of ["upcoming.opensAtOne", "upcoming.disclaimer"]) expect(fallback.has(key), `${page}: ${key}`).toBe(true);
      expect(fallback.has("home.upcoming.disclaimer"), page).toBe(false);
      expect(PAGE_HTML[page], page).not.toContain("home.upcoming.disclaimer");
    }
    expect(fallbackOf("profile.html").has("upcoming.disclaimer")).toBe(false);
  });

  it("the Predictions block maps every known server message to the module's key, and nothing else (the other pages map none)", () => {
    const fallback = fallbackOf("soccer-predictions.html");
    for (const [message, key] of Object.entries(SERVER_MESSAGES)) expect(fallback.serverMessageKey(message), message).toBe(key);
    expect(fallback.serverMessageKey("Some brand-new server message nobody mapped.")).toBeNull();
    expect(fallbackOf("index.html").serverMessageKey("Predictions are locked for this match.")).toBeNull();
    expect(fallbackOf("profile.html").serverMessageKey("Predictions are locked for this match.")).toBeNull();
  });

  it("every dictionary key a page's own script or markup uses — and the keys of the card's module, on the pages that load it — is in that page's block (so nothing can fall back to a raw key)", () => {
    const keysIn = (source: string) => new Set(Array.from(source.matchAll(USED_KEY)).map((m) => m[0].slice(1, -1)));
    for (const page of Object.keys(PAGE_HTML) as PageName[]) {
      const fallback = fallbackOf(page);
      const html = PAGE_HTML[page].replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "");
      const used = keysIn(html);
      // Home and the Score page both load /homeUpcoming.js, which writes the shared "upcoming." words: they must be in both blocks
      if (/<script src="\/homeUpcoming\.js"><\/script>/.test(PAGE_HTML[page])) {
        const fromModule = keysIn(UPCOMING_SOURCE);
        expect(Array.from(fromModule).filter((k) => k.startsWith("upcoming.")).length, `${page}: the module's keys are found`).toBeGreaterThanOrEqual(16);
        for (const key of fromModule) used.add(key);
      }
      for (const key of used) expect(fallback.has(key), `${page} uses ${key}`).toBe(true);
    }
    expect(PAGE_HTML["profile.html"]).not.toContain("/homeUpcoming.js"); // the profile has no card: it carries no "upcoming." words
  });

  it("the used-keys scan recognises every prefix, the shared 'upcoming.' one included (a stray 'upcoming.*' key would be found)", () => {
    const found = Array.from(`t("upcoming.state.next"); x('home.title'); y(\`pred.lineup.title\`); z("upcoming-list"); w("window.upcoming")`.matchAll(USED_KEY)).map((m) => m[0].slice(1, -1));
    expect(found).toEqual(["upcoming.state.next", "home.title", "pred.lineup.title"]);
    for (const page of ["index.html", "soccer-predictions.html"] as const) {
      const html = PAGE_HTML[page].replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "");
      expect(Array.from(html.matchAll(USED_KEY)).some((m) => /^["'`](?:home|pred)\.(?:upcoming|lineup|history|access)\./.test(m[0])), page).toBe(true); // the page's own new keys are in what it scans
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

  it("a fallback that replaced a WORKING module (guard removed) is caught: the selector would be hidden and English lost", async () => {
    const html = PAGE_HTML["index.html"].replace(/if \(m && typeof m\.t === "function"[^\n]*\n/, "");
    expect(html).not.toBe(PAGE_HTML["index.html"]);
    const page = await open("index.html", "ok", { html });
    expect(page.win.UrbanoI18n.fallback).toBe(true); // wrong: the real module was thrown away
    expect(selectorHidden(page.doc)).toBe(true);
  });

  it("a Score page whose block lacks a shared 'upcoming.' word or one of the new section words shows it raw, and the differential catches it", async () => {
    const page = "soccer-predictions.html";
    // (words that the page draws in script; the ones written in its static markup, such as the access link, are held by the drift test above instead:
    // the markup is the Spanish first paint and stays on screen whatever the block says)
    const lines = [
      '    "upcoming.state.next": "Preselección",\n', '    "pred.history.title": "Historial",\n',
      '    "pred.lineup.upcomingNote": "Por ahora no están abiertos para participar. Fechas y horarios informativos: pueden cambiar. Hora de Honduras.",\n',
      '    "upcoming.disclaimer": "Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.",\n',
    ];
    for (const line of lines) expect(PAGE_HTML[page].split(line).length - 1, line).toBe(1);
    const options = { matches: [], now: "2026-10-29T15:00:00Z" };
    const reference = predictionsSnapshot(await open(page, "ok", options));
    for (const line of lines) {
      const mutated = await open(page, "missing", { ...options, html: PAGE_HTML[page].replace(line, "") });
      expect(predictionsSnapshot(mutated), line).not.toEqual(reference);
      expect(visible(mutated.doc), line).toMatch(RAW_KEY);
    }
  });

  it("a Score page that treats an unreadable list as an empty list (the guard removed) tells the person there are no finished matches, and the load-error tests catch it", async () => {
    const guard = 'if (!readable || !data || !Array.isArray(data.matches)) throw new Error("the list of matches could not be read");';
    expect(PAGE_HTML["soccer-predictions.html"].split(guard).length - 1).toBe(1);
    const html = PAGE_HTML["soccer-predictions.html"].replace(guard, "");
    for (const list of [{ status: 500, body: { error: "boom" } }, { status: 200, body: {} }] as const) {
      const shipped = await open("soccer-predictions.html", "ok", { list, now: "2026-10-29T15:00:00Z" });
      expect(shipped.text("#cartelera .load-error .msg")).toBe("No pudimos cargar los partidos. Intentá de nuevo.");
      expect(shipped.text("#content")).not.toContain("Todavía no hay partidos finalizados.");
      const mutated = await open("soccer-predictions.html", "ok", { list, now: "2026-10-29T15:00:00Z", html });
      expect(mutated.text("#content")).toContain("Todavía no hay partidos finalizados.");
      expect(mutated.doc.getElementById("historial")).not.toBeNull();
    }
  });
});
