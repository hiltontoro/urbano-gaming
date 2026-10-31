import { describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Home page's URBANO Score card, "Próximos partidos" (historically "Soccer Predictions": the route and every identifier keep that name).
 *
 * The shipped landing page (public/index.html) is parsed and run whole in jsdom with the REAL shipped scripts. The card announces up to FIVE
 * coming matches from an EDITORIAL list (public/homeUpcomingData.js) that the Founder approved on 2026-10-29 as a PRESELECTION, not as open
 * matches. Each match has ONE timing (an instant, or only a Honduras date whose hour is "Horario por confirmar") and is in ONE of five states,
 * said in words:
 *
 *   Preselección            announced only (the default: nothing is promised; the chip never says that a match is NOT open)
 *   Participación programada   the SERVER says the match has an approved window that has not opened (the opening hour is shown)
 *   Abierto para participar    the SERVER lists an enabled venue activation of an active venue with an available offer, window open
 *   Cerrado / Finalizado    the match has started / the server has its final result
 *
 * The card reads the public matches list ONCE and upgrades a match only when the server match has the SAME start instant and the SAME two teams;
 * so a test, rehearsal or past match in the database can never turn the announcement of another match into an opening, a match WITHOUT a
 * confirmed hour can never be tied to any server match at all (there is no instant to compare), and anything the card cannot read leaves every
 * match as "Preselección". It promises no prize and no tie with any club.
 *
 * The one sentence under the list speaks about the SERVER's list, not about the editorial rows: "no match is open" only after the list has been
 * READ and none of its matches accepts participation, "some are open" when one does (whether or not it is one of the rows); while the list is
 * being read, or when it could not be read, the sentence is not shown at all (hidden and empty).
 *
 * What the Founder decided on 2026-10-29 and these tests protect: the crests of the TEN teams stay on the card (a visual decision that does not
 * establish a licence); the Clásico is not on the card and has no "Jugar ahora" button; the way to earlier participations and prizes is its own
 * visible link, apart from the list; the way into the Score lineup only informs.
 *
 * Every clock in these tests is fixed: the list is real data that leaves the card as the matches pass, so nothing here depends on today's date.
 * The tests of the card's LOGIC (states, matching, failure) run on a fixed fixture, not on the editorial selection.
 */

/**
 * Update of 2026-10-31 (Founder direction: the Home shows four experiences). The Home no longer carries this card: it has no list of coming matches, no status line
 * and no access links of its own, and it does not run /homeUpcoming.js. The tests below are those of the MODULE (the editorial list and its rules, the states, the
 * timing, the twins, the hours, the redraws), which the Score page still runs with a list of its own (its "Cartelera" preselection), and they are unchanged. The tests
 * that booted the old Home page to prove the card's own markup, words, crests strip (now proven on the Home's Score panel, in clubCrests.test.ts), status sentence,
 * phone layout and fail-closed reading were retired with the card; they are in git history at 98bb902, and the old Home is kept in
 * archive/home.score-card-2026-10-29.html.
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const CRESTS_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const DATA_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcomingData.js"), "utf8");
const MODULE_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcoming.js"), "utf8");
const SCORE_HTML = readFileSync(path.join(ROOT, "public/soccer-predictions.html"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

// The page's own CSS, as rules (so a test can read what one rule says without a browser).
const STYLE = Array.from(INDEX_HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = Array.from(STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));

type Reply = { status: number; json?: unknown } | "reject" | "badjson" | "hang";
interface Call { url: string; init: Record<string, any> }

const NOW_QUIET = "2026-10-29T03:00:00Z"; // the evening of 28 October in Honduras: nothing has started
const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The page, run whole. `now` fixes the clock of the page; `server` is what the public matches list answers; `crests` loads the central crest
 *  module as the page's script tag does (WITHOUT any preview flag: the ten crests are drawn as shipped); `data` replaces the editorial list. */
async function loadHome(opts: { lang?: "es" | "en"; now?: string; server?: Reply; crests?: boolean; data?: unknown; tweak?: (w: Record<string, any>) => void } = {}) {
  const calls: Call[] = [];
  // what the page logs and what escapes its scripts: a test can say "it logged this" and "nothing threw"
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); });
  virtualConsole.on("jsdomError", (err: Error) => { pageErrors.push(String(err && err.message)); });
  const dom = new JSDOM(INDEX_HTML, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = { attachSignInButton: () => {} };
      window.localStorage.setItem("urbano.lang", opts.lang ?? "es");
      const fixed = Date.parse(opts.now ?? NOW_QUIET);
      const RealDate = window.Date;
      const offset = fixed - RealDate.now();
      function FakeDate(this: unknown, ...args: unknown[]) { return args.length ? new (RealDate as any)(...args) : new RealDate(RealDate.now() + offset); }
      FakeDate.prototype = RealDate.prototype;
      FakeDate.now = () => RealDate.now() + offset;
      FakeDate.parse = RealDate.parse;
      FakeDate.UTC = RealDate.UTC;
      w.Date = FakeDate;
      window.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped scripts are evaluated, as the script tags would
      if (opts.crests) window.eval(CRESTS_SOURCE); // no URBANO_CRESTS_PREVIEW: the ten crests are drawn as the page ships
      window.eval(DATA_SOURCE);
      if (opts.data) w.UrbanoUpcomingData = opts.data; // the LOGIC tests run on a fixed fixture: the editorial selection can change without touching them
      window.eval(MODULE_SOURCE);
      if (opts.tweak) opts.tweak(w); // a failure the page must survive: a module that is missing, or that throws when it starts
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        calls.push({ url: String(url), init });
        return (async () => {
          if (String(url) !== MATCHES_URL) return { status: 404, json: async () => ({}) };
          const out = opts.server ?? { status: 200, json: { matches: [] } };
          if (out === "hang") return await new Promise(() => {}); // a read that never ends: the list is still "being read"
          if (out === "reject") throw new TypeError("network failure");
          if (out === "badjson") return { status: 200, json: async () => { throw new SyntaxError("bad json"); } };
          return { status: out.status, json: async () => out.json };
        })();
      };
    },
  });
  const doc = dom.window.document;
  const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[];
  const home = {
    win: dom.window as any,
    doc,
    calls,
    consoleErrors,
    pageErrors,
    settle: async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); },
    status: () => squash(q("#featured-status")?.textContent),
    items: () => qa("#upcoming-list .upcoming-item"),
    itemText: (el: HTMLElement) => squash(el.textContent),
    chips: () => qa("#upcoming-list .upcoming-chip").map((e) => squash(e.textContent)),
    states: () => qa("#upcoming-list .upcoming-item").map((e) => e.getAttribute("data-state")),
    ids: () => qa("#upcoming-list .upcoming-item").map((e) => e.getAttribute("data-match")),
    teams: () => qa("#upcoming-list .upcoming-item").map((e) => Array.from(e.querySelectorAll(".upcoming-team")).map((t) => squash(t.textContent)).join(" v ")),
    times: () => qa("#upcoming-list .upcoming-item").map((e) => [e.getAttribute("data-time"), e.querySelector("time")!.getAttribute("datetime"), squash(e.querySelector("time")!.textContent)]),
    statusLine: () => squash(q("#upcoming-status")?.textContent),
    statusHidden: () => (q("#upcoming-status") as HTMLElement).hidden,
    note: () => q("#featured-note") as HTMLElement,
    /** The card's words WITHOUT its legal line (which names sponsorship in order to deny it): what the card could be read as promising. */
    promiseText: () => { const copy = q("#featured-predictions")!.cloneNode(true) as HTMLElement; copy.querySelector(".featured-legal")?.remove(); return squash(copy.textContent); },
    strip: () => qa("#featured-predictions ul.ten-crests > li.crest-chip"),
    card: () => q("#featured-predictions") as HTMLElement,
    cardText: () => squash(q("#featured-predictions")?.textContent),
    part: (sel: string) => squash(q(`#featured-predictions ${sel}`)?.textContent),
    q,
    qa,
  };
  await home.settle();
  return home;
}
type Home = Awaited<ReturnType<typeof loadHome>>;

/** Waits (in real time, briefly) until something the page does on its own has happened: a timer ticking, a read ending. */
async function waitFor(condition: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!condition()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The page's language table, behind a counting stub: how many listeners are subscribed to onChange right now. */
const countingI18n = (win: any) => {
  const real = win.UrbanoI18n;
  const subs = new Set<(lang: string) => void>();
  return {
    subs,
    i18n: { t: (key: string, vars?: unknown) => real.t(key, vars), onChange: (cb: (lang: string) => void) => { subs.add(cb); return () => { subs.delete(cb); }; } },
    emit: () => Array.from(subs).forEach((cb) => cb("en")),
  };
};

/** Where an hour was read and when it was last compared with that source: the card shows an hour only with both (see the tests of that rule). */
const SRC = { source: "Fuente de ensayo", verifiedAt: "2026-10-01" };

/** A fixed list for the tests of the card's LOGIC (states, matching, failure): it is not the editorial selection, so choosing other matches never breaks them. */
const FIXTURE = {
  lastVerified: "2026-10-28",
  matches: [
    { ...SRC, id: "T-1", kickoffAt: "2026-11-01T15:15:00Z", home: "Racing de Santander", away: "Real Madrid", competition: "LaLiga" },
    { ...SRC, id: "T-2", kickoffAt: "2026-11-01T23:15:00Z", home: "Motagua", away: "Marathón", competition: "Liga Nacional" },
    { ...SRC, id: "T-3", kickoffAt: "2026-11-03T20:00:00Z", home: "FC Barcelona", away: "Aston Villa", competition: "Champions League" },
    { ...SRC, id: "T-4", kickoffAt: "2026-11-03T20:00:00Z", home: "Atlético de Madrid", away: "Bayern München", competition: "Champions League" },
    { ...SRC, id: "T-5", kickoffAt: "2026-11-04T17:45:00Z", home: "AEK Athens", away: "Real Madrid", competition: "Champions League" },
  ],
};
const loadLogic = (opts: Parameters<typeof loadHome>[0] = {}) => loadHome({ ...opts, data: FIXTURE });

// A match as the PUBLIC matches list returns it (only the fields the card reads, as the route sends them).
function serverMatch(over: Record<string, unknown> = {}) {
  return {
    matchId: "m-1",
    homeTeam: { teamId: "t1", name: "FC Barcelona", players: [] },
    awayTeam: { teamId: "t2", name: "Aston Villa", players: [] },
    competition: "Champions League",
    kickoffAt: "2026-11-03T20:00:00.000Z",
    cancelledAt: null,
    finalized: false,
    finalResult: null,
    participationOpensAt: null,
    venueActivations: [{ venueActivationId: "va-1", enabled: true, venue: { venueId: "v1", name: "Sede", latitude: 14.1, longitude: -87.2, radiusMeters: 150, active: true }, prizeTiers: [], offer: { available: true, maxLevel: 2, levels: [], digest: "x", problem: null } }],
    ...over,
  };
}
const answer = (...matches: unknown[]): Reply => ({ status: 200, json: { matches } });
const noOffer = { available: false, maxLevel: 0, levels: [], digest: null, problem: "NO_LEVELS" };
const disabled = (m: any, patch: Record<string, unknown>) => ({ ...m, venueActivations: [{ ...m.venueActivations[0], ...patch }] });

// The ten teams of the strip, in the Founder's order, with the key of the crest the central registry draws for each.
const STRIP = [
  { name: "Real Madrid", crest: "real-madrid-cf" },
  { name: "FC Barcelona", crest: "fc-barcelona" },
  { name: "Manchester City", crest: "manchester-city" },
  { name: "Manchester United", crest: "manchester-united" },
  { name: "Arsenal", crest: "arsenal" },
  { name: "Olimpia", crest: "olimpia" },
  { name: "Motagua", crest: "motagua" },
  { name: "Inter de Milán", crest: "inter" },
  { name: "Bayern Múnich", crest: "bayern-munchen" },
  { name: "Paris Saint-Germain", crest: "paris-saint-germain" },
];
const STRIP_NAMES = STRIP.map((s) => s.name);
const STRIP_KEYS = STRIP.map((s) => s.crest);

const COPY = {
  es: {
    pill: "Próximos partidos",
    intro: "Preselección de los próximos partidos de URBANO Score.",
    listLabel: "Lista de próximos partidos",
    teamsLabel: "Equipos que podrían aparecer en URBANO Score",
    note: "Fechas y horarios informativos: pueden cambiar. Hora de Honduras.",
    lineup: "Ver cartelera de Score",
    past: "Mis participaciones y premios",
    pastNote: "Tus participaciones en partidos finalizados y el estado de tus premios.",
    legal: "Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.",
    next: "Preselección", scheduled: "Participación programada", open: "Abierto para participar", closed: "Cerrado", final: "Finalizado",
    tbc: "Horario por confirmar",
    none: "Estamos preparando los próximos partidos.",
    statusNone: "Todavía no hay partidos abiertos para participar.",
    statusOpen: "Hay partidos abiertos para participar. Los ves en la cartelera de Score.",
  },
  en: {
    pill: "Upcoming matches",
    intro: "Shortlist of the upcoming URBANO Score matches.",
    listLabel: "List of upcoming matches",
    teamsLabel: "Teams that may appear in URBANO Score",
    note: "Dates and times are informational and may change. Honduras time.",
    lineup: "See the Score fixtures",
    past: "My participations and prizes",
    pastNote: "Your participations in finished matches and the status of your prizes.",
    legal: "Crests only identify the teams. URBANO is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here.",
    next: "Shortlisted", scheduled: "Participation scheduled", open: "Open to participate", closed: "Closed", final: "Finished",
    tbc: "Time to be confirmed",
    none: "We are preparing the upcoming matches.",
    statusNone: "No match is open for participation yet.",
    statusOpen: "Some matches are open for participation. You can see them in the Score fixtures.",
  },
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// What the card says
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the card: what it says, in both languages", () => {

  it("without the language table the card is not started and adds no failure of its own (the page's own handling of that failure is what it was)", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    expect(page.win.UrbanoHomeUpcoming.init({ host, i18n: {}, data: { matches: [] }, fetch: null, refreshMs: 0 })).toBeNull();
    expect(page.win.UrbanoHomeUpcoming.init({ host, i18n: { t: "not a function" }, data: { matches: [] }, fetch: null, refreshMs: 0 })).toBeNull();
    expect(page.win.UrbanoHomeUpcoming.init({ host: null })).toBeNull();
    expect(host.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The access to earlier participations and prizes, and the way into the Score lineup
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the access to earlier participations and prizes: its own, visible, before the list", () => {

  it("the Score page has the place that link points to: the history section", () => {
    expect(SCORE_HTML).toMatch(/id="historial"/);
    expect(SCORE_HTML).toMatch(/id="score-access-history"[^>]*href="#historial"|href="#historial"[^>]*id="score-access-history"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The Clásico and its button are gone
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the Clásico and its 'Jugar ahora' button are gone from the Home card", () => {

  it("nothing of the old card is left in the page, the language tables or the fallback: #featured-play, .featured-past, the old strip of two crests, home.upcoming.pastLabel, home.score.*", async () => {
    const page = await loadHome();
    expect(CODE).not.toMatch(/cl[aá]sico/i);
    expect(CODE).not.toMatch(/jugar ahora|play now/i);
    expect(CODE).not.toMatch(/featured-play|featured-crest/);
    expect(CODE).not.toMatch(/\.featured-past\b|class="[^"]*\bfeatured-past\b/);
    expect(CODE).not.toMatch(/home\.score\.|pastLabel/);
    for (const sel of ["#featured-play", ".featured-play", ".featured-past", ".featured-crests", ".featured-crest", ".featured-crest-vs"]) expect(page.doc.querySelector(sel), sel).toBeNull();
    const dict = page.win.UrbanoI18n.dictionary();
    for (const lang of ["es", "en"] as const) {
      const keys = Object.keys(dict[lang]);
      expect(keys.filter((k) => k.startsWith("home.score.") || k === "home.upcoming.pastLabel"), lang).toEqual([]);
      // no Home or list string of the shared prefixes talks about the Clásico or about playing now
      const values = keys.filter((k) => k.startsWith("home.upcoming.") || k.startsWith("upcoming.")).map((k) => dict[lang][k] as string);
      expect(values.length).toBeGreaterThan(20);
      for (const value of values) expect(value, value).not.toMatch(/cl[aá]sico|jugar ahora|play now/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Five matches at most, and the filter of states
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the limit of five, and the filter of states applied BEFORE it", () => {
  const entry = (n: number, kickoffAt: string) => ({ ...SRC, id: `E-${n}`, kickoffAt, home: `Casa ${n}`, away: `Visita ${n}`, competition: "Liga" });
  // E-1 and E-2 have started (3 hours not yet passed): "closed"; E-3 to E-7 are announced: "next"
  const ENTRIES = [entry(1, "2026-11-03T20:00:00Z"), entry(2, "2026-11-03T20:30:00Z"), entry(3, "2026-11-10T20:00:00Z"), entry(4, "2026-11-11T20:00:00Z"), entry(5, "2026-11-12T20:00:00Z"), entry(6, "2026-11-13T20:00:00Z"), entry(7, "2026-11-14T20:00:00Z")];
  const NOW = Date.parse("2026-11-03T21:00:00Z");
  const ids = (items: any[]) => Array.from(items, (i) => i.entry.id);
  const states = (items: any[]) => Array.from(items, (i) => i.state);

  it("with `only`, the states are filtered BEFORE the limit: three 'next' matches are returned even though the first two entries are 'closed'", async () => {
    const api = (await loadHome()).win.UrbanoHomeUpcoming;
    const all = api.select(ENTRIES, [], NOW, 3);
    expect(states(all)).toEqual(["closed", "closed", "next"]);
    const onlyNext = api.select(ENTRIES, [], NOW, 3, ["next"]);
    expect(ids(onlyNext)).toEqual(["E-3", "E-4", "E-5"]);
    expect(states(onlyNext)).toEqual(["next", "next", "next"]);
    expect(ids(api.select(ENTRIES, [], NOW, 5, ["closed"]))).toEqual(["E-1", "E-2"]);
    expect(ids(api.select(ENTRIES, [], NOW, 5, ["closed", "next"]))).toEqual(["E-1", "E-2", "E-3", "E-4", "E-5"]);
    expect(ids(api.select(ENTRIES, [], NOW, 5, ["open"]))).toEqual([]);
    expect(ids(api.select(ENTRIES, [], NOW, 5, "next"))).toEqual(["E-1", "E-2", "E-3", "E-4", "E-5"]); // not an array: no filter
  });

  it("`only` and `limit` also work through init (the Score lineup lists only the 'next' ones) and the filtered list is what onPaint reports", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    const painted: string[][] = [];
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: { matches: ENTRIES }, now: () => NOW, serverMatches: [], only: ["next"], limit: 2, refreshMs: 0, onPaint: (items: any[]) => painted.push(Array.from(items, (i) => i.entry.id)) });
    expect(Array.from(host.querySelectorAll(".upcoming-item")).map((e) => e.getAttribute("data-match"))).toEqual(["E-3", "E-4"]);
    expect(painted).toEqual([["E-3", "E-4"]]);
    handle.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A match without a confirmed hour
// ---------------------------------------------------------------------------------------------------------------------------------

describe("a match with only a date: 'Horario por confirmar', stays through the Honduras date, and can NEVER be opened", () => {
  const TBC = { id: "D-1", date: "2026-11-19", home: "Motagua", away: "Olimpia", competition: "Liga Nacional" };
  const api = (page: Home) => page.win.UrbanoHomeUpcoming;
  const states = (items: any[]) => Array.from(items, (i) => i.state);

  it("is placed by its Honduras date: 00:00 Honduras of that date to the end of that date (24 h); an hour-less match sorts among the timed ones by that moment", async () => {
    const page = await loadHome();
    expect({ ...api(page).timing(TBC) }).toEqual({ hasTime: false, start: Date.parse("2026-11-19T06:00:00Z"), leaves: Date.parse("2026-11-20T06:00:00Z") });
    const before = { ...SRC, id: "B", kickoffAt: "2026-11-18T20:00:00Z", home: "Casa B", away: "Visita B", competition: "Liga" };
    const after = { ...SRC, id: "A", kickoffAt: "2026-11-20T20:00:00Z", home: "Casa A", away: "Visita A", competition: "Liga" };
    const ids = Array.from(api(page).select([after, TBC, before], [], Date.parse("2026-11-10T00:00:00Z"), 5), (i: any) => i.entry.id);
    expect(ids).toEqual(["B", "D-1", "A"]);
  });

  it("KEY SAFETY PROPERTY: even if the server lists an enabled, available, open match with the same two teams whose kickoff falls on that date, the match stays 'Preselección'", async () => {
    const kickoffs = ["2026-11-19T06:00:00.000Z", "2026-11-19T20:00:00.000Z", "2026-11-20T01:30:00.000Z", "2026-11-20T05:59:00.000Z"]; // from 00:00 to 23:59 Honduras of the 19th
    const page = await loadHome(); // the state functions are pure: one page is enough
    for (const kickoffAt of kickoffs) {
      const server = serverMatch({ kickoffAt, homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" }, competition: "Liga Nacional" });
      expect(api(page).findServerMatch(TBC, [server]), kickoffAt).toBeNull(); // never tied to it
      for (const variant of [server, { ...server, finalized: true, finalResult: { homeScore: 1, awayScore: 0 } }, { ...server, participationOpensAt: "2026-11-19T12:00:00.000Z" }, { ...server, participationOpensAt: "2026-11-25T12:00:00.000Z" }]) {
        for (const now of ["2026-11-18T12:00:00Z", "2026-11-19T06:00:00Z", kickoffAt, "2026-11-20T00:00:00Z", "2026-11-20T05:00:00Z"]) {
          const ms = Date.parse(now);
          expect({ ...api(page).deriveState(TBC, variant, ms) }, `${kickoffAt} @ ${now}`).toEqual({ state: "next", opensAt: null });
          expect(states(api(page).select([TBC], [variant], ms, 5)), `${kickoffAt} @ ${now}`).toEqual(["next"]);
        }
      }
    }
    // the control: the SAME server match opens the SAME match as soon as the match has a confirmed hour
    const control = await loadHome();
    const timed = { ...SRC, id: "D-1", kickoffAt: "2026-11-20T01:30:00Z", home: "Motagua", away: "Olimpia", competition: "Liga Nacional" };
    const server = serverMatch({ kickoffAt: "2026-11-20T01:30:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" } });
    expect(states(api(control).select([timed], [server], Date.parse("2026-11-19T18:00:00Z"), 5))).toEqual(["open"]);
    expect(states(api(control).select([timed], [server], Date.parse("2026-11-20T01:30:00Z"), 5))).toEqual(["closed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The timing of an editorial entry is validated; an entry that cannot be placed is dropped, never guessed
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the timing of an entry: kickoffAt is a valid ISO instant or the entry is dropped; date is a real calendar date or the entry is dropped", () => {
  // the timing functions are pure: one page is enough for all of these
  let shared: Promise<any> | null = null;
  const api = () => (shared ??= loadHome().then((p) => p.win.UrbanoHomeUpcoming));
  const base = { ...SRC, home: "Casa", away: "Visita", competition: "Liga" };
  const VALID_DATE = "2026-11-19";

  it("a valid kickoffAt gives { hasTime: true, start: the instant, leaves: three hours later }", async () => {
    const t = (await api()).timing({ ...base, id: "a", kickoffAt: "2026-11-07T20:00:00Z" });
    expect({ ...t }).toEqual({ hasTime: true, start: Date.parse("2026-11-07T20:00:00Z"), leaves: Date.parse("2026-11-07T23:00:00Z") });
  });

  it.each([
    ["Z", "2026-11-07T20:00:00Z", "2026-11-07T20:00:00Z"],
    ["Z with milliseconds", "2026-11-07T20:00:00.000Z", "2026-11-07T20:00:00Z"],
    ["Z without seconds", "2026-11-07T20:00Z", "2026-11-07T20:00:00Z"],
    ["an explicit offset (Honduras, -06:00)", "2026-11-07T14:00:00-06:00", "2026-11-07T20:00:00Z"],
    ["an explicit positive offset (Spain, +01:00)", "2026-11-07T21:00:00+01:00", "2026-11-07T20:00:00Z"],
  ])("kickoffAt with its zone is accepted: %s", async (_why, kickoffAt, utc) => {
    const t = (await api()).timing({ ...base, id: "z", kickoffAt });
    expect(t).not.toBeNull();
    expect(t.hasTime).toBe(true);
    expect(t.start).toBe(Date.parse(utc));
  });

  it.each([
    ["not a time at all", "pronto"],
    ["an empty string", ""],
    ["an impossible month and day", "2026-13-45T00:00:00Z"],
    ["an instant WITHOUT its zone (each device would read it in its own zone)", "2026-11-07T20:00:00"],
    ["a date alone (no hour, no zone)", "2026-11-07"],
    ["an hour with a space instead of T", "2026-11-07 20:00:00Z"],
    ["a number (an epoch)", 1793000000000],
    ["the number zero", 0],
    ["NaN", NaN],
    ["a boolean", true],
    ["an object", {}],
    ["an array", []],
  ])("kickoffAt that is %s drops the entry and does NOT fall back to its (valid) date", async (_why, kickoffAt) => {
    const m = await api();
    const entry = { ...base, id: "x", kickoffAt, date: VALID_DATE };
    expect(m.timing(entry)).toBeNull();
    expect(m.select([entry], [], Date.parse("2026-11-10T00:00:00Z"), 5)).toHaveLength(0);
    expect(m.select([entry], [], Date.parse(`${VALID_DATE}T12:00:00Z`), 5)).toHaveLength(0); // not even on the day of that date
  });

  it.each([
    ["February 30", "2026-02-30"],
    ["month 13", "2026-13-01"],
    ["month 00", "2026-00-10"],
    ["day 00", "2026-11-00"],
    ["November 31", "2026-11-31"],
    ["29 February of a year that is not a leap year", "2026-02-29"],
    ["day-month-year order", "19-11-2026"],
    ["a single-digit day", "2026-11-1"],
    ["a single-digit month", "2026-1-19"],
    ["slashes", "2026/11/19"],
    ["no separators", "20261119"],
    ["a full timestamp in the date field", "2026-11-19T00:00:00Z"],
    ["leading space", " 2026-11-19"],
    ["trailing space", "2026-11-19 "],
    ["an empty string", ""],
    ["a number", 20261119],
    ["a boolean", true],
    ["an object", {}],
  ])("a date that is %s (%j) drops the entry", async (_why, date) => {
    const m = await api();
    const entry = { ...base, id: "x", date };
    expect(m.timing(entry)).toBeNull();
    expect(m.select([entry], [], Date.parse("2026-11-10T00:00:00Z"), 5)).toHaveLength(0);
  });

  it.each([["2026-11-19"], ["2026-01-01"], ["2026-12-31"], ["2028-02-29"], ["2026-02-28"]])("the real calendar date %s is accepted, as 00:00 Honduras of that date", async (date) => {
    const m = await api();
    const t = m.timing({ ...base, id: "ok", date });
    expect(t.hasTime).toBe(false);
    expect(t.start).toBe(Date.parse(`${date}T06:00:00Z`));
    expect(t.leaves).toBe(t.start + 24 * 3600_000);
  });

  it("an entry with neither kickoffAt nor date, or that is not an object, is dropped", async () => {
    const m = await api();
    for (const entry of [{ ...base, id: "none" }, null, undefined, "2026-11-19", 5, []]) expect(m.timing(entry), String(entry)).toBeNull();
    expect(Array.from(m.select([null, undefined, { ...base, id: "none" }], [], Date.parse("2026-11-10T00:00:00Z"), 5))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The status line under the list
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the status line under the list: it speaks for the SERVER's list, and only once that list has been read", () => {

  it("at module level: the sentence is hidden and empty from the first drawing until the read ends, and after a read that throws, is rejected, answers something that is not the list or answers other than 200", async () => {
    const page = await loadHome();
    const NOW = () => Date.parse("2026-11-03T19:00:00Z");
    const start = (fetchFn: unknown, extra: Record<string, unknown> = {}) => {
      const host = page.doc.createElement("ul");
      const statusHost = page.doc.createElement("p");
      statusHost.hidden = false; // anything the module does not set is visible: it must set it
      statusHost.textContent = "stale";
      const handle = page.win.UrbanoHomeUpcoming.init({ host, statusHost, data: FIXTURE, now: NOW, fetch: fetchFn, refreshMs: 0, ...extra });
      return { host, statusHost, handle };
    };
    const never = start(() => new Promise(() => {}));
    expect(never.statusHost.hidden).toBe(true);
    expect(never.statusHost.textContent).toBe(""); // even a stale sentence is cleared
    expect(never.host.querySelectorAll(".upcoming-item")).toHaveLength(3);
    await page.settle();
    expect(never.statusHost.hidden).toBe(true); // still being read
    expect(never.statusHost.textContent).toBe("");
    const throwing = start(() => { throw new TypeError("fetch is broken"); });
    const rejecting = start(() => Promise.reject(new TypeError("offline")));
    const html = start(() => Promise.resolve({ status: 200, json: async () => "<p>not a list</p>" }));
    const redirect = start(() => Promise.resolve({ status: 302, json: async () => ({ matches: [serverMatch()] }) })); // only a 200 is a list
    await page.settle();
    for (const [name, one] of Object.entries({ throwing, rejecting, html, redirect })) {
      expect(one.statusHost.hidden, name).toBe(true);
      expect(one.statusHost.textContent, name).toBe("");
      expect(one.host.querySelectorAll(".upcoming-item[data-state=next]"), name).toHaveLength(3);
    }
    for (const one of [never, throwing, rejecting, html, redirect]) one.handle.stop();
  });

  it("at module level: a list HANDED to the module counts as read — the sentence is there at once, with no request — and an empty handed list says that nothing is open", async () => {
    const page = await loadHome();
    const before = page.calls.length;
    const NOW = () => Date.parse("2026-11-03T19:00:00Z");
    const run = (serverMatches: unknown[]) => {
      const host = page.doc.createElement("ul");
      const statusHost = page.doc.createElement("p");
      const handle = page.win.UrbanoHomeUpcoming.init({ host, statusHost, data: FIXTURE, now: NOW, serverMatches, refreshMs: 0 });
      const out = { text: squash(statusHost.textContent), hidden: statusHost.hidden };
      handle.stop();
      return out;
    };
    expect(run([])).toEqual({ text: COPY.es.statusNone, hidden: false });
    expect(run([serverMatch()])).toEqual({ text: COPY.es.statusOpen, hidden: false });
    expect(run([serverMatch({ cancelledAt: "2026-11-02T10:00:00.000Z" })])).toEqual({ text: COPY.es.statusNone, hidden: false });
    expect(page.calls.length).toBe(before);
  });

  it("follows the list as time passes and the language changes: said again, hidden again, in the other language", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    const statusHost = page.doc.createElement("p");
    let nowMs = Date.parse("2026-11-03T19:00:00Z");
    const handle = page.win.UrbanoHomeUpcoming.init({ host, statusHost, data: FIXTURE, now: () => nowMs, serverMatches: [serverMatch()], refreshMs: 0 });
    expect(squash(statusHost.textContent)).toBe(COPY.es.statusOpen);
    expect(statusHost.hidden).toBe(false);
    nowMs = Date.parse("2026-11-03T20:30:00Z"); // the match has started: nothing is open any more
    handle.paint();
    expect(squash(statusHost.textContent)).toBe(COPY.es.statusNone);
    expect(statusHost.hidden).toBe(false);
    nowMs = Date.parse("2026-12-30T00:00:00Z"); // everything passed
    handle.paint();
    expect(statusHost.textContent).toBe("");
    expect(statusHost.hidden).toBe(true);
    nowMs = Date.parse("2026-11-03T19:00:00Z");
    page.win.UrbanoI18n.setLang("en"); // the module repaints itself on a change of language
    await page.settle();
    expect(squash(statusHost.textContent)).toBe(COPY.en.statusOpen);
    expect(statusHost.hidden).toBe(false);
    handle.stop();
  });

  it("serverHasOpen is the rule behind the sentence: any match that is not cancelled, not finalized, not started, whose window (if any) has opened, and that accepts participation", async () => {
    const api = (await loadHome()).win.UrbanoHomeUpcoming;
    const at = (iso: string) => Date.parse(iso);
    const has = (list: unknown, iso = "2026-11-03T19:00:00Z") => api.serverHasOpen(list, at(iso));
    expect(has([serverMatch()])).toBe(true);
    expect(has([serverMatch()], "2026-11-03T19:59:59.999Z")).toBe(true);
    expect(has([serverMatch()], "2026-11-03T20:00:00Z")).toBe(false); // from the instant of kickoff
    expect(has([serverMatch()], "2026-11-03T22:00:00Z")).toBe(false);
    expect(has([serverMatch({ cancelledAt: "2026-11-02T10:00:00.000Z" })])).toBe(false);
    expect(has([serverMatch({ cancelledAt: "x" })])).toBe(false);
    expect(has([serverMatch({ finalized: true })])).toBe(false);
    expect(has([serverMatch({ participationOpensAt: "2026-11-03T19:30:00.000Z" })])).toBe(false); // window not opened yet
    expect(has([serverMatch({ participationOpensAt: "2026-11-03T19:30:00.000Z" })], "2026-11-03T19:29:59Z")).toBe(false);
    expect(has([serverMatch({ participationOpensAt: "2026-11-03T19:30:00.000Z" })], "2026-11-03T19:30:00Z")).toBe(true); // it opens AT its hour
    expect(has([serverMatch({ participationOpensAt: "2026-11-03T12:00:00.000Z" })])).toBe(true);
    expect(has([serverMatch({ participationOpensAt: null })])).toBe(true); // no window: nothing to wait for
    for (const patch of [{ enabled: false }, { enabled: "true" }, { enabled: undefined }, { venue: { active: false } }, { venue: null }, { venue: {} }, { offer: noOffer }, { offer: null }, { offer: {} }]) {
      expect(has([disabled(serverMatch(), patch)]), JSON.stringify(patch)).toBe(false);
    }
    expect(has([serverMatch({ venueActivations: [] })])).toBe(false);
    expect(has([serverMatch({ venueActivations: null })])).toBe(false);
    expect(has([serverMatch({ venueActivations: [null, 5, "x"] })])).toBe(false);
    // independent of the editorial rows: other teams, another start, another spelling
    expect(has([serverMatch({ homeTeam: { name: "Rojo FC" }, awayTeam: { name: "Azul FC" }, kickoffAt: "2026-12-01T01:00:00.000Z" })])).toBe(true);
    // ANY of the matches is enough, in any position, and a row that is not a match is skipped without an error
    expect(has([serverMatch({ cancelledAt: "x" }), serverMatch({ matchId: "m-2", venueActivations: [] }), serverMatch({ matchId: "m-3" })])).toBe(true);
    expect(has([null, 5, "x", [], {}, { kickoffAt: "not a date" }, { kickoffAt: 12345 }, serverMatch({ matchId: "m-9" })])).toBe(true);
    expect(has([null, 5, "x", [], {}, { kickoffAt: "not a date" }, { kickoffAt: 12345 }])).toBe(false);
    for (const notAList of [undefined, null, "no", 5, {}, { matches: [serverMatch()] }]) expect(has(notAList), String(notAList)).toBe(false);
    expect(has([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The states, decided by the server
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the states: the card says people can take part only when the server says so", () => {

  it("a match that has started is never 'open', even if the server still lists an enabled venue", async () => {
    const page = await loadLogic({ now: "2026-11-03T20:00:00Z", server: answer(serverMatch()) });
    expect(page.states()).not.toContain("open");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// init: a list handed to it makes no request; stop() lets go of everything
// ---------------------------------------------------------------------------------------------------------------------------------

describe("init: a handed server list makes NO request, and stop() unsubscribes and clears the timer", () => {
  const NOW = () => Date.parse("2026-11-03T19:00:00Z");

  it("an EMPTY array counts as handed too: still no request, every match announced", async () => {
    const page = await loadHome();
    const before = page.calls.length;
    const host = page.doc.createElement("ul");
    page.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: NOW, serverMatches: [], refreshMs: 0 });
    await page.settle();
    expect(page.calls.length).toBe(before);
    expect(host.querySelectorAll(".upcoming-item[data-state=next]")).toHaveLength(3);
  });

  it("without a handed array (absent, null or not an array) the module reads the public list once, as before", async () => {
    const page = await loadHome();
    const before = page.calls.length;
    for (const serverMatches of [undefined, null, "no", {}]) page.win.UrbanoHomeUpcoming.init({ host: page.doc.createElement("ul"), data: FIXTURE, now: NOW, serverMatches, refreshMs: 0 });
    await page.settle();
    expect(page.calls.length - before).toBe(4);
    expect(page.calls.slice(before).every((c) => c.url === MATCHES_URL)).toBe(true);
  });

  it("stop() unsubscribes from i18n.onChange and clears the timer: no listener left, no repaint on a language change, not a tick of the clock", async () => {
    const page = await loadHome();
    const { subs, i18n, emit } = countingI18n(page.win);
    const host = page.doc.createElement("ul");
    let paints = 0;
    let clock = 0; // how many times the module looked at the clock: once per drawing and once per tick
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: () => { clock++; return NOW(); }, i18n, serverMatches: [], refreshMs: 5, onPaint: () => { paints++; } });
    expect(subs.size).toBe(1); // subscribed once
    expect(paints).toBe(1); // drawn at once
    emit();
    expect(paints).toBe(2); // a change of language repaints
    await waitFor(() => clock >= 8); // the timer is ticking...
    expect(paints).toBe(2); // ...and a tick that finds nothing new redraws nothing (see the tests of the redraw)
    handle.stop();
    expect(subs.size).toBe(0); // unsubscribed
    const frozen = { paints, clock };
    emit();
    await page.settle(80);
    expect({ paints, clock }).toEqual(frozen); // no repaint by language and not a tick of the clock
    expect(() => { handle.stop(); handle.stop(); }).not.toThrow(); // stopping twice is safe
    expect(subs.size).toBe(0);
    handle.paint(); // after stop() nothing is painted at all, not even on request
    expect({ paints, clock }).toEqual(frozen);
  });

  it("two lists on one page unsubscribe independently: stopping one leaves the other listening", async () => {
    const page = await loadHome();
    const { subs, i18n } = countingI18n(page.win);
    const a = page.win.UrbanoHomeUpcoming.init({ host: page.doc.createElement("ul"), data: FIXTURE, now: NOW, i18n, serverMatches: [], refreshMs: 0 });
    const b = page.win.UrbanoHomeUpcoming.init({ host: page.doc.createElement("ul"), data: FIXTURE, now: NOW, i18n, serverMatches: [], refreshMs: 0 });
    expect(subs.size).toBe(2);
    a.stop();
    expect(subs.size).toBe(1);
    b.stop();
    expect(subs.size).toBe(0);
  });

  it("a language table without onChange still works, and stop() does not fail", async () => {
    const page = await loadHome();
    const real = page.win.UrbanoI18n;
    const host = page.doc.createElement("ul");
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: NOW, i18n: { t: (k: string, v?: unknown) => real.t(k, v) }, serverMatches: [], refreshMs: 0 });
    expect(host.querySelectorAll(".upcoming-item")).toHaveLength(3);
    expect(() => handle.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The editorial list and what the card never says
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the editorial list and the words of the card", () => {
  type Entry = { id: string; kickoffAt?: string; date?: string; home: string; away: string; competition: string; source: string; sourceUrl: string; verifiedAt: string };
  const data = (() => { const w: any = {}; new Function("window", DATA_SOURCE.replace("typeof window !== \"undefined\" ? window : this", "window"))(w); return w.UrbanoUpcomingData as { matches: Entry[] }; })();
  const TEN = ["Real Madrid", "FC Barcelona", "Manchester City", "Manchester United", "Arsenal", "Olimpia", "Motagua", "Inter", "Bayern München", "Paris Saint-Germain"];

  it("is well formed: unique ids, exactly ONE timing per entry, two named teams, a competition; says when it was last compared with the sources", () => {
    expect(data.matches).toHaveLength(5); // the five of the preselection
    expect(new Set(data.matches.map((m) => m.id)).size).toBe(data.matches.length);
    expect(new Set(data.matches.map((m) => `${m.kickoffAt ?? m.date}|${m.home}|${m.away}`)).size).toBe(data.matches.length);
    for (const m of data.matches) {
      expect(["kickoffAt" in m, "date" in m].filter(Boolean), `${m.id}: exactly one of kickoffAt and date`).toHaveLength(1);
      expect(Object.keys(m).sort(), `${m.id}: no field that writes a participation window, a prize or a venue`).toEqual([m.kickoffAt ? "kickoffAt" : "date", "away", "competition", "home", "id", "source", "sourceUrl", "verifiedAt"].sort());
      expect(m.home.length, m.id).toBeGreaterThan(1);
      expect(m.away.length, m.id).toBeGreaterThan(1);
      expect(m.home, m.id).not.toBe(m.away);
      expect(m.competition.length, m.id).toBeGreaterThan(2);
    }
  });

  it("has exactly ONE entry with a date and no kickoffAt (N26-46, the hour is still to be confirmed); every other has a UTC instant in November 2026, Honduras time", () => {
    const dateOnly = data.matches.filter((m) => m.date !== undefined && m.kickoffAt === undefined);
    expect(dateOnly.map((m) => m.id)).toEqual(["N26-46"]);
    expect(dateOnly[0]!.date).toBe("2026-11-19");
    expect(dateOnly[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const timed = data.matches.filter((m) => m.kickoffAt !== undefined);
    expect(timed).toHaveLength(4);
    for (const m of timed) {
      expect(m.date, m.id).toBeUndefined();
      expect(m.kickoffAt, m.id).toMatch(/^2026-11-\d\dT\d\d:\d\d:00Z$/);
      expect(Number.isNaN(Date.parse(m.kickoffAt!)), m.id).toBe(false);
      expect(new Date(Date.parse(m.kickoffAt!) - 6 * 3600_000).getUTCMonth(), m.id).toBe(10); // November, as the Honduras calendar says
    }
    expect(new Date(Date.parse(`${dateOnly[0]!.date}T06:00:00Z`) - 6 * 3600_000).getUTCMonth()).toBe(10);
  });

  it("is the five-match preselection, in order, and does not force any of the ten teams: a match between two of them is announced once", () => {
    expect(data.matches.map((m) => `${m.id} | ${m.home} v ${m.away} | ${m.kickoffAt ?? m.date} | ${m.competition}`)).toEqual([
      "N26-26 | Valencia v Real Madrid | 2026-11-07T20:00:00Z | LaLiga",
      "N26-27 | Atlético de Madrid v FC Barcelona | 2026-11-08T20:00:00Z | LaLiga",
      "N26-46 | Motagua v Olimpia | 2026-11-19 | Liga Nacional",
      "N26-22 | Liverpool v Manchester United | 2026-11-22T16:30:00Z | Premier League",
      "N26-24 | Arsenal v Manchester City | 2026-11-29T16:30:00Z | Premier League",
    ]);
    const between = data.matches.filter((m) => TEN.includes(m.home) && TEN.includes(m.away));
    expect(between.map((m) => `${m.home} v ${m.away}`).sort()).toEqual(["Arsenal v Manchester City", "Motagua v Olimpia"]);
  });

  it("has no Clásico between the two giants of Spain among its five (the Clásico is a finished event now)", () => {
    expect(data.matches.some((m) => (m.home === "Real Madrid" && m.away === "FC Barcelona") || (m.home === "FC Barcelona" && m.away === "Real Madrid"))).toBe(false);
  });

  it("writes no participation window, prize or sponsorship in its own words, and says that dates are informational and that the hour of a match can be to be confirmed", () => {
    const header = DATA_SOURCE.slice(0, DATA_SOURCE.indexOf("(function"));
    for (const phrase of ["PRESELECTION", "NOT as open matches", "Horario por confirmar", "No participation window is written here and none is invented", "never tied to a server match"]) expect(header, phrase).toContain(phrase);
    const body = DATA_SOURCE.slice(DATA_SOURCE.indexOf("(function")); // the data itself, not the comment above it
    expect(body).not.toMatch(/participationOpensAt|opensAt|venue|prize|premio|enabled/i);
  });

  it("says no prize, sponsorship or tie with any club: the only mentions of prizes say where they are shown or point to the history, and the tie is denied", async () => {
    const dict = (await loadHome()).win.UrbanoI18n.dictionary();
    const own = (lang: "es" | "en") => Object.keys(dict[lang]).filter((k) => k.startsWith("home.upcoming.") || k.startsWith("upcoming."));
    expect(own("es").sort()).toEqual(own("en").sort()); // both languages carry the same keys
    for (const lang of ["es", "en"] as const) {
      expect(own(lang)).toHaveLength(27); // 9 of the card (home.upcoming.*, with the phone's "see all N") and 18 of the list and its notices (upcoming.*)
      const mentionsPrizes = own(lang).filter((k) => /premio|prize/i.test(dict[lang][k]));
      expect(mentionsPrizes.sort()).toEqual(["home.upcoming.past", "home.upcoming.pastNote"]); // the card makes no statement about prizes: only the way to the earlier ones
      for (const key of own(lang)) {
        const value = dict[lang][key] as string;
        if (key === "upcoming.disclaimer" || key === "home.upcoming.past" || key === "home.upcoming.pastNote") continue; // the denial of any tie with the clubs / the way to earlier prizes
        expect(value, `${lang} ${key}`).not.toMatch(/premio|prize|patrocin|sponsor|alianza|partner|oficial|official|gana|win\b|L\s?\d{3}|bono|tequeños/i);
      }
    }
    expect(COPY.es.legal).toMatch(/no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo/);
    expect(COPY.en.legal).toMatch(/is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here/);
    expect(COPY.es.legal).not.toMatch(/premio|prize/i); // the card says nothing about prizes
    expect(COPY.en.legal).not.toMatch(/premio|prize/i);
    expect(dict.es["upcoming.disclaimer"]).toBe(COPY.es.legal);
    expect(dict.en["upcoming.disclaimer"]).toBe(COPY.en.legal);
    expect(dict.es["home.upcoming.disclaimer"]).toBeUndefined(); // the notice is shared with the Score page, under its new key
    expect(dict.en["home.upcoming.disclaimer"]).toBeUndefined();
  });

  it("keeps the rule in the module's own words: five states, the exact-instant-and-teams rule, an entry without an hour is only announced, the server decides", () => {
    const words = MODULE_SOURCE.replace(/\s*\n\s*\*\s*/g, " "); // the header comment as running text
    for (const phrase of ["unless THE SERVER says so", "EXACTLY the entry's", "without a confirmed hour", "Horario por confirmar", "final", "closed", "open", "scheduled", "next"]) expect(words).toContain(phrase);
    expect(MODULE_SOURCE).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(CODE).not.toMatch(/\/api\/gaming\/predictions\/matches/); // the page itself does not read it: only the card's module does
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// After the independent review of the prototype (29-oct-2026). Each fix has its own tests:
//  - a server match that is, beyond reasonable doubt, the same FIXTURE as a row (a "twin") hides the row on the Score page (hasTwin / hideTwins);
//  - an instant needs its zone AND a real calendar (no engine-dependent roll-over of "2026-02-30" into March);
//  - an entry is drawn only if it has an id, two named teams and a placement in time (never "undefined"), and an id is drawn once;
//  - redrawing with nothing new replaces NO node (a screen reader and a text selection are not disturbed every minute);
//  - stop() is final: a read that ends after it paints nothing;
//  - "desde la 1:15", not "desde las 1:15";
//  - the informational list fails alone: the rest of the page (its catalogs) still draws.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("twins: a server match that is the same fixture as a row hides the row (hasTwin / select(..., hideTwins))", () => {
  const BARCA = { ...SRC, id: "T", kickoffAt: "2026-11-03T20:00:00Z", home: "FC Barcelona", away: "Aston Villa", competition: "Champions League" };
  const TBC = { id: "D", date: "2026-11-19", home: "Motagua", away: "Olimpia", competition: "Liga Nacional" };
  const NOW_MS = Date.parse("2026-11-03T12:00:00Z");
  let shared: Promise<Home> | null = null;
  const page = () => (shared ??= loadHome({ crests: true }));

  const server = (over: Record<string, unknown>) => serverMatch(over);
  const named = (home: string, away: string, over: Record<string, unknown> = {}) => server({ homeTeam: { name: home }, awayTeam: { name: away }, ...over });

  it.each([
    ["the same two clubs, the same start", named("FC Barcelona", "Aston Villa"), true],
    ["the same two clubs at ANOTHER start (a day later, a minute off)", named("FC Barcelona", "Aston Villa", { kickoffAt: "2026-11-04T20:01:00.000Z" }), true],
    ["the same two clubs under another spelling the registry knows ('Barcelona')", named("Barcelona", "Aston Villa"), true],
    ["the same start and ONE of the two clubs (a spelling the list does not know for the other)", named("FC Barcelona", "Aston Villa FC"), true],
    ["the same start and only the AWAY club in common", named("Otro FC", "Aston Villa"), true],
    ["the same start and NO club in common (two matches kick off together)", named("Otro FC", "Rojo FC"), false],
    ["another start and only one club in common (another fixture of the same club)", named("FC Barcelona", "Rojo FC", { kickoffAt: "2026-11-08T20:00:00.000Z" }), false],
    ["a CANCELLED match with everything in common", named("FC Barcelona", "Aston Villa", { cancelledAt: "2026-11-02T10:00:00.000Z" }), false],
    ["the clubs swapped (away first) at another start: not the same fixture", named("Aston Villa", "FC Barcelona", { kickoffAt: "2026-11-09T20:00:00.000Z" }), false],
  ])("an entry with an hour: %s -> %s", async (_why, match, expected) => {
    const api = (await page()).win.UrbanoHomeUpcoming;
    expect(api.hasTwin(BARCA, [match]), _why).toBe(expected);
  });

  it.each([
    ["a match on that Honduras date with one of the clubs (19:30 Honduras)", named("Real España", "Olimpia", { kickoffAt: "2026-11-20T01:30:00.000Z" }), true],
    ["the very first instant of the Honduras date (00:00) with one club", named("Motagua", "Real España", { kickoffAt: "2026-11-19T06:00:00.000Z" }), true],
    ["the last instant of the Honduras date with one club", named("Motagua", "Real España", { kickoffAt: "2026-11-20T05:59:59.000Z" }), true],
    ["the first instant of the NEXT Honduras date with one club", named("Motagua", "Real España", { kickoffAt: "2026-11-20T06:00:00.000Z" }), false],
    ["the instant before the date begins with one club", named("Motagua", "Real España", { kickoffAt: "2026-11-19T05:59:59.000Z" }), false],
    ["the same two clubs on another date", named("Motagua", "Olimpia", { kickoffAt: "2026-12-05T01:30:00.000Z" }), true],
    ["another date and one club", named("Motagua", "Real España", { kickoffAt: "2026-11-27T01:30:00.000Z" }), false],
  ])("an entry with only a date: %s -> %s", async (_why, match, expected) => {
    const api = (await page()).win.UrbanoHomeUpcoming;
    expect(api.hasTwin(TBC, [match]), _why).toBe(expected);
  });

  it("anything that is not a list of matches, and any broken element, is no twin (and never throws)", async () => {
    const api = (await page()).win.UrbanoHomeUpcoming;
    for (const bad of [undefined, null, "no", 5, {}]) expect(api.hasTwin(BARCA, bad), String(bad)).toBe(false);
    expect(api.hasTwin(BARCA, [null, undefined, 5, "x", {}, { homeTeam: null, awayTeam: null, kickoffAt: "garbage" }])).toBe(false);
    expect(api.hasTwin(null, [named("FC Barcelona", "Aston Villa")])).toBe(false);
    expect(api.hasTwin({ id: "x", home: "A", away: "B" }, [named("A", "B")])).toBe(false); // an entry with no timing is dropped, never matched
  });

  it("select(..., hideTwins) leaves the twin out; without it the row stays; and a twin that is NOT the strict match never becomes open", async () => {
    const api = (await page()).win.UrbanoHomeUpcoming;
    const entries = [BARCA, { ...BARCA, id: "U", home: "Atlético de Madrid", away: "Bayern München" }];
    const twin = named("FC Barcelona", "Aston Villa FC"); // one club under a spelling nobody knows: a twin, but not the strict match
    const ids = (list: any[]) => Array.from(list, (i) => i.entry.id);
    expect(ids(api.select(entries, [twin], NOW_MS, 5, ["next"], false))).toEqual(["T", "U"]);
    expect(ids(api.select(entries, [twin], NOW_MS, 5, ["next"], true))).toEqual(["U"]);
    expect(Array.from(api.select(entries, [twin], NOW_MS, 5, undefined, false), (i: any) => i.state)).toEqual(["next", "next"]); // the twin did NOT make the row open
    const strict = server({});
    expect(ids(api.select(entries, [strict], NOW_MS, 5, ["next"], true))).toEqual(["U"]); // the strict match is a twin too
    expect(ids(api.select(entries, [strict], NOW_MS, 5, ["open"], false))).toEqual(["T"]);
  });
});

describe("an instant needs its zone and a real calendar; an entry needs an id and two named teams", () => {
  let shared: Promise<Home> | null = null;
  const page = () => (shared ??= loadHome());
  const base = { ...SRC, home: "Casa", away: "Visita", competition: "Liga" };

  it.each([
    ["February 30 (an engine could roll it over to March)", "2026-02-30T10:00:00Z"],
    ["February 29 of a year that is not a leap year", "2026-02-29T10:00:00Z"],
    ["November 31", "2026-11-31T10:00:00Z"],
    ["hour 24", "2026-11-07T24:00:00Z"],
    ["minute 60", "2026-11-07T10:60:00Z"],
    ["second 60", "2026-11-07T10:00:60Z"],
    ["an offset of +24:00", "2026-11-07T10:00:00+24:00"],
    ["an offset with minute 60", "2026-11-07T10:00:00+05:60"],
    ["day 00", "2026-11-00T10:00:00Z"],
    ["month 00", "2026-00-10T10:00:00Z"],
    ["a trailing newline", "2026-11-07T10:00:00Z\n"],
  ])("kickoffAt with %s is dropped (the entry never falls back to anything)", async (_why, kickoffAt) => {
    const m = (await page()).win.UrbanoHomeUpcoming;
    expect(m.timing({ ...base, id: "x", kickoffAt })).toBeNull();
    expect(m.select([{ ...base, id: "x", kickoffAt, date: "2026-11-07" }], [], Date.parse("2026-11-01T00:00:00Z"), 5)).toHaveLength(0);
  });

  it("the offset is applied as arithmetic, fractions are kept, and a leap day is a real day", async () => {
    const m = (await page()).win.UrbanoHomeUpcoming;
    const at = (kickoffAt: string) => m.timing({ ...base, id: "x", kickoffAt })?.start;
    expect(at("2026-11-07T14:00:00.123-06:00")).toBe(Date.parse("2026-11-07T20:00:00.123Z"));
    expect(at("2026-11-07T20:00:00.5Z")).toBe(Date.parse("2026-11-07T20:00:00.500Z"));
    expect(at("2026-11-08T03:30:00+07:30")).toBe(Date.parse("2026-11-07T20:00:00Z"));
    expect(at("2026-11-07T20:00Z")).toBe(Date.parse("2026-11-07T20:00:00Z"));
    expect(at("2028-02-29T10:00:00Z")).toBe(Date.parse("2028-02-29T10:00:00Z"));
    expect(at("2026-12-31T23:59:59Z")).toBe(Date.parse("2026-12-31T23:59:59Z"));
  });

  it("an entry without an id, or with a blank or non-text team, is dropped; an id is drawn once (the first wins); nothing reads 'undefined'", async () => {
    const page2 = await loadHome();
    const m = page2.win.UrbanoHomeUpcoming;
    const ok = { ...base, id: "ok-1", kickoffAt: "2026-11-07T20:00:00Z" };
    const bad = [
      { ...ok, id: "" }, { ...ok, id: "  " }, { ...ok, id: 7 }, { ...ok, id: undefined },
      { ...ok, id: "b1", home: "" }, { ...ok, id: "b2", home: "   " }, { ...ok, id: "b3", away: undefined }, { ...ok, id: "b4", home: { name: "X" } }, { ...ok, id: "b5", away: 5 },
      { ...ok, id: "b6", home: undefined, away: undefined },
    ];
    const dup = { ...ok, home: "Otra", away: "Cosa" }; // the same id again: dropped, the first one stays
    const NOW_MS = Date.parse("2026-11-01T00:00:00Z");
    const shown = m.select([...bad, ok, dup], [], NOW_MS, 5);
    expect(Array.from(shown, (i: any) => i.entry)).toEqual([ok]);
    // drawn: no word is 'undefined' or '[object Object]'
    const host = page2.doc.createElement("ul");
    m.init({ host, data: { matches: [...bad, ok, dup] }, now: () => NOW_MS, serverMatches: [], refreshMs: 0 });
    expect(host.querySelectorAll(".upcoming-item")).toHaveLength(1);
    expect(squash(host.textContent)).not.toMatch(/undefined|\[object|NaN/);
  });

  it("a competition that is not text is drawn as nothing; a container that is not a list lists nothing and throws nothing", async () => {
    const page2 = await loadHome();
    const m = page2.win.UrbanoHomeUpcoming;
    const NOW_MS = Date.parse("2026-11-01T00:00:00Z");
    const host = page2.doc.createElement("ul");
    m.init({ host, data: { matches: [{ ...base, id: "c", kickoffAt: "2026-11-07T20:00:00Z", competition: { name: "LaLiga" } }] }, now: () => NOW_MS, serverMatches: [], refreshMs: 0 });
    expect(squash(host.querySelector(".upcoming-comp")!.textContent)).toBe("");
    for (const container of ["abc", {}, 5, null, undefined, true]) {
      expect(() => m.select(container, [], NOW_MS, 5), String(container)).not.toThrow();
      expect(Array.from(m.select(container, [], NOW_MS, 5))).toHaveLength(0);
      const empty = page2.doc.createElement("ul");
      expect(() => m.init({ host: empty, data: { matches: container }, now: () => NOW_MS, serverMatches: [], refreshMs: 0 }), String(container)).not.toThrow();
      expect(squash(empty.textContent)).toBe("Estamos preparando los próximos partidos.");
    }
  });
});

describe("a redraw with nothing new replaces nothing; a change redraws; stop() is final", () => {
  const NOW_MS = Date.parse("2026-10-30T12:00:00Z"); // all five rows of the fixture are still on the list and none has started
  const ENTRIES = FIXTURE.matches;

  /** Records every change the list or the sentence suffers after the first drawing. */
  function watch(page: Home, nodes: Node[]) {
    const seen: string[] = [];
    const observer = new page.win.MutationObserver((records: MutationRecord[]) => { for (const r of records) seen.push(r.type); });
    for (const node of nodes) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
    return { seen, flush: () => { for (const r of observer.takeRecords()) seen.push(r.type); return seen; }, stop: () => observer.disconnect() };
  }

  it("the 60-second tick over an unchanged state touches no node: the rows and the sentence are the same objects afterwards", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    const status = page.doc.createElement("p");
    page.doc.body.append(host, status);
    const handle = page.win.UrbanoHomeUpcoming.init({ host, statusHost: status, data: { matches: ENTRIES }, now: () => NOW_MS, serverMatches: [], refreshMs: 5 });
    const rows = Array.from(host.children), sentence = status.firstChild;
    expect(rows).toHaveLength(5);
    expect(sentence).not.toBeNull();
    const watcher = watch(page, [host, status]);
    await page.settle(80); // many ticks
    expect(watcher.flush()).toEqual([]);
    expect(Array.from(host.children).every((li, i) => li === rows[i])).toBe(true);
    expect(status.firstChild).toBe(sentence);
    watcher.stop();
    handle.stop();
  });

  it("handle.paint() redraws the rows but leaves the sentence's text node alone when the sentence is the same (a live region is not told the same thing again)", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    const status = page.doc.createElement("p");
    page.doc.body.append(host, status);
    const handle = page.win.UrbanoHomeUpcoming.init({ host, statusHost: status, data: { matches: ENTRIES }, now: () => NOW_MS, serverMatches: [], refreshMs: 0 });
    const sentence = status.firstChild, rows = Array.from(host.children);
    expect(sentence).not.toBeNull();
    handle.paint(); // asked for explicitly: the rows are redrawn…
    expect(Array.from(host.children).some((li, i) => li !== rows[i])).toBe(true);
    expect(status.firstChild).toBe(sentence); // …but the same sentence is not written again
    handle.stop();
  });

  it("a real change (a match starts) redraws the list; so does handle.paint() and a change of language", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    page.doc.body.append(host);
    let nowMs = NOW_MS;
    const counting = countingI18n(page.win);
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: { matches: ENTRIES }, now: () => nowMs, serverMatches: [], i18n: counting.i18n, refreshMs: 5 });
    const first = Array.from(host.children);
    nowMs = Date.parse("2026-11-01T15:30:00Z"); // T-1 has started: its chip changes
    await page.settle(60);
    const second = Array.from(host.children);
    expect(second.some((li) => !first.includes(li))).toBe(true);
    expect(Array.from(host.querySelectorAll(".upcoming-chip")).map((c) => squash(c.textContent))).toContain("Cerrado");
    const before = Array.from(host.children);
    handle.paint(); // asked for explicitly: always redrawn
    expect(Array.from(host.children).some((li, i) => li !== before[i])).toBe(true);
    const beforeLanguage = Array.from(host.children);
    counting.emit(); // the language changed: everything is redrawn, even with the same matches
    expect(Array.from(host.children).every((li, i) => li !== beforeLanguage[i])).toBe(true);
    handle.stop();
  });

  it("stop() is final: a read that ends after it paints nothing (no drawing, no onPaint), and stopping twice is harmless", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    let release!: (r: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const painted: number[] = [];
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: { matches: ENTRIES }, now: () => NOW_MS, fetch: () => pending, refreshMs: 0, onPaint: (items: unknown[]) => painted.push(items.length) });
    expect(painted).toEqual([5]); // the first drawing, from the editorial list
    const rows = Array.from(host.children);
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
    release({ status: 200, json: async () => ({ matches: [serverMatch()] }) });
    await page.settle(40);
    expect(painted).toEqual([5]);
    expect(Array.from(host.children).every((li, i) => li === rows[i])).toBe(true);
    handle.paint(); // even an explicit paint after stop() draws nothing
    expect(painted).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A match the server says is CANCELLED is not an upcoming match. (The public list that production serves today leaves cancelled matches out of
// its answer altogether, so there the rule has nothing to read; it is tested for the day the list says so, with the list as the page would get it.)
// ---------------------------------------------------------------------------------------------------------------------------------

describe("a match the server says is cancelled leaves the list: neither an announcement nor an opening, and never a 'Cancelado' label", () => {
  const api = (page: Home) => page.win.UrbanoHomeUpcoming;
  const BARCA = { ...SRC, id: "c", kickoffAt: "2026-11-03T20:00:00Z", home: "FC Barcelona", away: "Aston Villa", competition: "Champions League" };
  const TBC = { id: "d", date: "2026-11-19", home: "Motagua", away: "Olimpia", competition: "Liga Nacional" };
  const cancelled = (over: Record<string, unknown> = {}) => serverMatch({ cancelledAt: "2026-11-02T10:00:00.000Z", ...over });
  const named = (home: string, away: string, over: Record<string, unknown> = {}) => cancelled({ homeTeam: { name: home }, awayTeam: { name: away }, ...over });

  it.each([
    ["the same fixture at the same instant", cancelled()],
    ["the same fixture whose hour had moved two hours later before it was cancelled (same Honduras day)", cancelled({ kickoffAt: "2026-11-03T22:00:00.000Z" })],
    ["the same fixture whose hour had moved earlier on the same Honduras day (00:00 Honduras)", cancelled({ kickoffAt: "2026-11-03T06:00:00.000Z" })],
    ["the last second of that Honduras day", cancelled({ kickoffAt: "2026-11-04T05:59:59.000Z" })],
    ["a cancelledAt that is only a truthy word (as the rest of the card reads it)", cancelled({ cancelledAt: "x" })],
  ])("an entry with an hour is cancelled by: %s", async (_why, match) => {
    const page = await loadHome();
    expect(api(page).isCancelled(BARCA, [match])).toBe(true);
    expect(Array.from(api(page).select([BARCA], [match], Date.parse("2026-11-03T12:00:00Z"), 5))).toEqual([]);
    expect(Array.from(api(page).selectAll([BARCA], [match], Date.parse("2026-11-03T12:00:00Z")))).toEqual([]);
  });

  it.each([
    ["no list at all", undefined],
    ["a list that is not an array", { matches: [] }],
    ["an empty list", []],
    ["a LIVE match of the same fixture (nothing is cancelled)", [serverMatch()]],
    ["the clubs the other way round", [named("Aston Villa", "FC Barcelona")]],
    ["only one of the two clubs", [named("FC Barcelona", "Rojo FC"), named("Rojo FC", "Aston Villa")]],
    ["two other clubs at the same instant", [named("Rojo FC", "Azul FC")]],
    ["the same clubs the DAY BEFORE (23:59:59 in Honduras)", [cancelled({ kickoffAt: "2026-11-03T05:59:59.000Z" })]],
    ["the same clubs the NEXT day (00:00 in Honduras)", [cancelled({ kickoffAt: "2026-11-04T06:00:00.000Z" })]],
    ["the same clubs a week later", [cancelled({ kickoffAt: "2026-11-10T20:00:00.000Z" })]],
    ["a cancelled match with no readable start", [cancelled({ kickoffAt: "pronto" }), cancelled({ kickoffAt: null }), cancelled({ kickoffAt: undefined })]],
    ["entries that are not matches", [null, 5, "x", [], {}, { cancelledAt: "2026-11-02T10:00:00.000Z" }]],
    ["a cancelled match with no teams", [cancelled({ homeTeam: null, awayTeam: null })]],
  ])("an entry with an hour is NOT cancelled by: %s", async (_why, list) => {
    const page = await loadHome();
    expect(api(page).isCancelled(BARCA, list)).toBe(false);
    expect(Array.from(api(page).select([BARCA], list, Date.parse("2026-11-03T12:00:00Z"), 5)).map((i: any) => i.entry.id)).toEqual(["c"]);
  });

  it("another spelling that the central club registry knows ('Real Madrid CF' for 'Real Madrid') cancels it too; a spelling it does not know leaves the row (as for an opening: what is not recognised changes nothing)", async () => {
    const page = await loadHome({ crests: true }); // the central crest registry knows the spellings
    const val = { ...SRC, id: "s", kickoffAt: "2026-11-07T20:00:00Z", home: "Valencia", away: "Real Madrid", competition: "LaLiga" };
    expect(api(page).isCancelled(val, [named("Valencia", "Real Madrid CF", { kickoffAt: "2026-11-07T20:00:00.000Z" })])).toBe(true);
    expect(api(page).isCancelled(val, [named("Valencia CF", "Real Madrid", { kickoffAt: "2026-11-07T20:00:00.000Z" })])).toBe(false); // 'Valencia CF' is not a spelling the registry knows
    expect(api(page).isCancelled(val, [named("Valencia", "Getafe", { kickoffAt: "2026-11-07T20:00:00.000Z" })])).toBe(false);
  });

  it("a live match of the same pairing on the same Honduras day keeps the fixture, whichever comes first in the list: the row is not removed by the cancelled one", async () => {
    const page = await loadHome();
    const live = serverMatch({ matchId: "new", kickoffAt: "2026-11-03T21:00:00.000Z" });
    for (const list of [[cancelled(), live], [live, cancelled()]]) expect(api(page).isCancelled(BARCA, list)).toBe(false);
  });

  it.each([
    ["19:30 Honduras on that date", "2026-11-20T01:30:00.000Z", true],
    ["the first instant of the date (00:00 Honduras)", "2026-11-19T06:00:00.000Z", true],
    ["the last second of the date (23:59:59 Honduras)", "2026-11-20T05:59:59.000Z", true],
    ["the instant before the date begins", "2026-11-19T05:59:59.000Z", false],
    ["the first instant of the NEXT date", "2026-11-20T06:00:00.000Z", false],
  ])("an entry with only a date is cancelled by a cancelled match of its clubs on that Honduras date, at any hour: %s", async (_why, kickoffAt, expected) => {
    const page = await loadHome();
    expect(api(page).isCancelled(TBC, [named("Motagua", "Olimpia", { kickoffAt })])).toBe(expected);
    expect(api(page).isCancelled(TBC, [named("Olimpia", "Motagua", { kickoffAt })])).toBe(false); // the clubs the other way round: another fixture
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// An hour is shown only with its source and the day it was last verified
// ---------------------------------------------------------------------------------------------------------------------------------

describe("an hour is shown only with its source and the day it was verified; otherwise the match says 'Horario por confirmar'", () => {
  const api = (page: Home) => page.win.UrbanoHomeUpcoming;
  const BASE = { id: "h", kickoffAt: "2026-11-03T20:00:00Z", home: "FC Barcelona", away: "Aston Villa", competition: "Champions League" };
  const GOOD = { ...BASE, source: "UEFA (uefa.com), 21:00 hora de España", verifiedAt: "2026-10-29" };
  const NOW = Date.parse("2026-11-01T12:00:00Z");

  it("the day of the match, and the day before, are valid verification dates (a verification can be done the same day)", async () => {
    const page = await loadHome();
    for (const verifiedAt of ["2026-11-03", "2026-11-02", "2026-10-01"]) expect(api(page).timing({ ...BASE, source: "UEFA", verifiedAt }).hasTime, verifiedAt).toBe(true);
    // the Honduras day of a match late in the evening is the day before in UTC: 2026-11-20T01:30Z is Thursday 19 November in Honduras
    const late = { ...BASE, kickoffAt: "2026-11-20T01:30:00Z", source: "Liga", verifiedAt: "2026-11-19" };
    expect(api(page).timing(late).hasTime).toBe(true);
    expect(api(page).timing({ ...late, verifiedAt: "2026-11-20" }).hasTime).toBe(false);
  });

  it("an invalid instant is still dropped (it does not degrade to a date), traceable or not", async () => {
    const page = await loadHome();
    for (const kickoffAt of ["pronto", "2026-11-03T20:00:00", "2026-02-30T20:00:00Z", 1793000000000]) {
      expect(api(page).timing({ ...GOOD, kickoffAt }), String(kickoffAt)).toBeNull();
      expect(api(page).timing({ ...BASE, kickoffAt }), String(kickoffAt)).toBeNull();
    }
  });

  it("an untraceable hour is also withheld from the Score preselection, through the same module (one rule for both pages)", async () => {
    const page = await loadHome();
    const rows = Array.from(api(page).select([{ ...BASE, id: "u" }, { ...GOOD, id: "g", kickoffAt: "2026-11-04T20:00:00Z" }], [], NOW, 5)) as any[];
    expect(rows.map((r) => [r.entry.id, r.hasTime, r.traceable])).toEqual([["u", false, false], ["g", true, true]]);
  });
});

describe("the shipped editorial list: every entry says where it was read and when it was verified, and each hour shown is traceable", () => {
  type Entry = { id: string; kickoffAt?: string; date?: string; home: string; away: string; source: string; sourceUrl: string; verifiedAt: string };
  const data = (() => { const w: any = {}; new Function("window", DATA_SOURCE.replace("typeof window !== \"undefined\" ? window : this", "window"))(w); return w.UrbanoUpcomingData as { matches: Entry[] }; })();

  it("each of the five has a source, an https address, and a verification date that is a real day, not after 2026-10-29 (the day it was compared) and not after its match", () => {
    expect(data.matches).toHaveLength(5);
    for (const m of data.matches) {
      expect(m.source.trim().length, `${m.id}: source`).toBeGreaterThan(10);
      expect(m.sourceUrl, `${m.id}: sourceUrl`).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
      expect(m.verifiedAt, `${m.id}: verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(m.verifiedAt)), m.id).toBe(false);
      expect(m.verifiedAt <= "2026-10-29", `${m.id}: not later than the day it was compared`).toBe(true);
      expect(m.verifiedAt >= "2026-10-28", `${m.id}: compared in this round`).toBe(true);
      const matchDay = m.kickoffAt ? new Date(Date.parse(m.kickoffAt) - 6 * 3600_000).toISOString().slice(0, 10) : m.date!;
      expect(m.verifiedAt <= matchDay, `${m.id}: not after its match`).toBe(true);
    }
  });

  it("the Premier League entries cite the Premier League's own notice and the LaLiga entries the clubs and LaLiga (no other source stands behind an hour)", () => {
    const by = Object.fromEntries(data.matches.map((m) => [m.id, m]));
    for (const id of ["N26-22", "N26-24"]) { expect(by[id]!.source).toMatch(/premierleague\.com/); expect(by[id]!.sourceUrl).toContain("premierleague.com/"); }
    expect(by["N26-26"]!.source).toMatch(/laliga\.com/);
    expect(by["N26-27"]!.source).toMatch(/laliga\.com/);
    expect(by["N26-46"]!.source).toMatch(/lnphn\.com/);
    expect(by["N26-46"]!.kickoffAt).toBeUndefined(); // the Liga's calendar names no teams and no channel: a date, not an hour
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A phone shows the next three and says where the whole lineup is
// ---------------------------------------------------------------------------------------------------------------------------------

describe("on a phone the card shows the next three matches and says where the whole lineup is; wider screens show every one", () => {
  /** A matchMedia that answers the query the page asks, and lets the test turn the phone. */
  const media = (matches: boolean) => {
    const listeners = new Set<() => void>();
    const asked: string[] = [];
    const mq: any = { matches, media: "", addEventListener: (_t: string, cb: () => void) => { listeners.add(cb); }, removeEventListener: (_t: string, cb: () => void) => { listeners.delete(cb); } };
    return { asked, mq, listeners, turn: (to: boolean) => { mq.matches = to; Array.from(listeners).forEach((cb) => cb()); }, tweak: (w: Record<string, any>) => { w.matchMedia = (query: string) => { asked.push(query); mq.media = query; return mq; }; } };
  };
  const link = (page: Home) => page.q("#featured-lineup") as HTMLAnchorElement;

  it("a row that is NOT drawn can leave the list while the drawn ones stay: the next drawing is made anyway, so the total that the link reports follows (a match later in the day leaves before a date-only one earlier in it)", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    const dateOnly = (n: number) => ({ id: `D-${n}`, date: "2026-11-19", home: `Casa ${n}`, away: `Visita ${n}`, competition: "Liga" }); // 00:00 Honduras: stays through the whole date
    const timed = (n: number, kickoffAt: string) => ({ ...SRC, id: `T-${n}`, kickoffAt, home: `Casa T${n}`, away: `Visita T${n}`, competition: "Liga" }); // stays three hours after it starts
    const data = { matches: [dateOnly(1), dateOnly(2), dateOnly(3), timed(1, "2026-11-19T18:00:00Z"), timed(2, "2026-11-19T20:00:00Z")] };
    let nowMs = Date.parse("2026-11-19T10:00:00Z");
    const painted: Array<[string[], number]> = [];
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data, now: () => nowMs, serverMatches: [], limit: () => 3, refreshMs: 5, onPaint: (items: any[], total: number) => painted.push([Array.from(items, (i) => i.entry.id), total]) });
    expect(painted).toEqual([[["D-1", "D-2", "D-3"], 5]]);
    nowMs = Date.parse("2026-11-19T22:00:00Z"); // T-1 left at 21:00; T-2 leaves at 23:00; the three date-only rows are still there
    await waitFor(() => painted.length > 1);
    expect(painted[1]).toEqual([["D-1", "D-2", "D-3"], 4]);
    handle.stop();
  });

  it("init: `limit` may be a function (asked at every drawing) and onPaint receives the shown rows AND the total that belongs in the list", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    let limit = 2;
    const painted: Array<[string[], number]> = [];
    const handle = page.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: () => Date.parse("2026-11-01T00:00:00Z"), serverMatches: [], limit: () => limit, refreshMs: 0, onPaint: (items: any[], total: number) => painted.push([Array.from(items, (i) => i.entry.id), total]) });
    expect(painted).toEqual([[["T-1", "T-2"], 5]]);
    limit = 4;
    handle.paint();
    expect(painted[1]).toEqual([["T-1", "T-2", "T-3", "T-4"], 5]);
    limit = undefined as any;
    handle.paint();
    expect(painted[2]).toEqual([["T-1", "T-2", "T-3", "T-4", "T-5"], 5]); // no limit: the default of five
    handle.stop();
  });
});
