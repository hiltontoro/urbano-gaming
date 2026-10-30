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

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const CRESTS_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const DATA_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcomingData.js"), "utf8");
const MODULE_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcoming.js"), "utf8");
const SCORE_HTML = readFileSync(path.join(ROOT, "public/soccer-predictions.html"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";
const LINEUP_PAGE = "/soccer-predictions.html";
const HISTORY_LINK = "/soccer-predictions.html#historial";
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

// The page's own CSS, as rules (so a test can read what one rule says without a browser).
const STYLE = Array.from(INDEX_HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = Array.from(STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));
const rulesFor = (selector: string) => RULES.filter((r) => r.selector === selector);

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

/** The page's markup as shipped, with NO script run: what a person sees before anything loads. */
function staticPage() {
  const doc = new JSDOM(INDEX_HTML).window.document;
  return { doc, card: doc.getElementById("featured-predictions") as HTMLElement };
}

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

// The five matches of the editorial preselection, in order of start (real data: see the last describe).
const FIVE = ["Valencia v Real Madrid", "Atlético de Madrid v FC Barcelona", "Motagua v Olimpia", "Liverpool v Manchester United", "Arsenal v Manchester City"];
const FIVE_IDS = ["N26-26", "N26-27", "N26-46", "N26-22", "N26-24"];

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

/** Everything a person could read as "you can take part now", in either language (the chip "Abierto para participar" and the status sentence that
 *  says matches are open are the only allowed ones, and only on the server's word: the tests that must not see them use this). */
const OPENING_LANGUAGE = /Entrar a|Enter URBANO|Abierto para|Open to participate|Los ves en la cartelera|Some matches are open|Predictions are open|ya pod[ée]s predecir|you can (now )?predict|Hac[ée] tu predicci|Make your prediction|Live now|En vivo ahora|Jugar ahora|Play now/i;
/** What the card must never promise or imply. Run it on `promiseText()`: the legal line is left out because it names sponsorship in order to DENY it. */
const PROMISES = /gan[aá]\b|ganá|ganar[aá]s?|you will win|win a |premio de L|L ?\d{3}|tequeños|bono|oficial|socio|partner(ship)? with|patrocinado por|sponsored by|en alianza|licens/i;

// ---------------------------------------------------------------------------------------------------------------------------------
// What the card says
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the card: what it says, in both languages", () => {
  it.each(["es", "en"] as const)("%s: pill, name, intro, note, the access to earlier participations and prizes, the strip's label, the Score lineup link, the legal line", async (lang) => {
    const page = await loadHome({ lang });
    const c = COPY[lang];
    expect(page.status()).toBe(c.pill);
    expect(page.part("h2")).toBe("URBANO Score");
    expect(page.part(".featured-descriptor")).toBe(c.intro);
    expect(page.part("#featured-note")).toBe(c.note);
    expect(page.doc.querySelector(".featured-window")).toBeNull(); // renamed: the note is .featured-note#featured-note
    expect(page.part("#featured-past")).toBe(c.past);
    expect(page.part(".featured-access-note")).toBe(c.pastNote);
    expect(page.part("#featured-teams-label")).toBe(c.teamsLabel);
    expect(page.part("#featured-lineup")).toBe(c.lineup);
    expect(page.part(".featured-legal")).toBe(c.legal);
    expect(page.q("#upcoming-list")!.getAttribute("aria-label")).toBe(c.listLabel);
    expect(page.consoleErrors).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });

  it("has exactly two links, in this order: the access to earlier participations and prizes (BEFORE the list) and the informational link to the Score lineup (AFTER it); nothing in the list is a link", async () => {
    const page = await loadHome();
    const links = page.qa("#featured-predictions a") as HTMLAnchorElement[];
    expect(links.map((a) => [a.id, a.getAttribute("href")])).toEqual([["featured-past", HISTORY_LINK], ["featured-lineup", LINEUP_PAGE]]);
    const list = page.q("#upcoming-list")!;
    expect(list.querySelector("a")).toBeNull();
    expect(list.contains(page.doc.getElementById("featured-past"))).toBe(false);
    expect(list.contains(page.doc.getElementById("featured-lineup"))).toBe(false);
    expect(page.doc.querySelector("#featured-action")).toBeNull();
    expect(page.doc.querySelector("#featured-predictions button, #featured-predictions form, #featured-predictions input")).toBeNull();
  });

  it("is already complete before any script or request: the markup carries the Spanish text and the language keys, and the ten names", () => {
    const start = INDEX_HTML.indexOf('id="featured-predictions"');
    const card = INDEX_HTML.slice(start, INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    const withoutScripts = card.replace(/<script[\s\S]*?<\/script>/g, "");
    for (const key of ["home.upcoming.pill", "home.upcoming.intro", "home.upcoming.past", "home.upcoming.pastNote", "home.upcoming.teamsLabel", "home.upcoming.note", "home.upcoming.play", "upcoming.disclaimer"]) expect(withoutScripts, key).toContain(`data-i18n="${key}"`);
    expect(withoutScripts).not.toContain("home.upcoming.disclaimer"); // the legal line's key MOVED to upcoming.disclaimer (the Score page says the same words)
    expect(withoutScripts).toContain("home.upcoming.listLabel");
    expect(withoutScripts).toContain('<span class="status-pill status-soon" id="featured-status" data-i18n="home.upcoming.pill">' + COPY.es.pill + "</span>");
    expect(withoutScripts).toContain('class="featured-legal" data-i18n="upcoming.disclaimer">' + COPY.es.legal + "</p>");
    expect(withoutScripts).toContain('class="featured-note" id="featured-note" data-i18n="home.upcoming.note">' + COPY.es.note + "</p>");
    expect(withoutScripts).toContain('id="featured-past" href="' + HISTORY_LINK + '" data-i18n="home.upcoming.past">' + COPY.es.past + "</a>");
    expect(withoutScripts).toContain('id="featured-lineup" href="' + LINEUP_PAGE + '" data-i18n="home.upcoming.play">' + COPY.es.lineup + "</a>");
    expect(withoutScripts).not.toMatch(/<img|<svg/); // no element image of its own: the crests are drawn by the central module
    // and the same in the parsed page, with no script run
    const { card: parsed } = staticPage();
    expect(parsed.querySelector("h2#featured-title")!.textContent).toBe("URBANO Score");
    expect(Array.from(parsed.querySelectorAll("ul.ten-crests > li.crest-chip .crest-name")).map((e) => e.textContent)).toEqual(STRIP_NAMES);
    expect(parsed.querySelector("#upcoming-list")!.children).toHaveLength(0); // the list is drawn by its module, from the editorial data
    const status = parsed.querySelector("#upcoming-status") as HTMLElement;
    expect(status.hasAttribute("hidden")).toBe(true); // nothing is said under the list until the list is drawn
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(parsed.querySelector("#featured-note")!.hasAttribute("hidden")).toBe(false); // the note is hidden by the list's own drawing, when it has no rows
  });

  it("loads the central scripts in order (language table, crests, editorial data, list) before the page script that starts the list, and no shipped page asks for a crest preview", () => {
    const at = (needle: string) => INDEX_HTML.indexOf(needle);
    const order = ['<script src="/urbanoI18n.js"></script>', '<script src="/urbanoClubCrests.js"></script>', '<script src="/homeUpcomingData.js"></script>', '<script src="/homeUpcoming.js"></script>', '<script id="i18n-fallback">'].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(CODE).toMatch(/UrbanoClubCrests\.decorate\(document\)/);
    // the list is started by the page script, inside try/catch (it is informational: it must never stop the catalogs of the page), and hides the note when it has no rows
    const start = CODE.indexOf("UrbanoHomeUpcoming.init(");
    expect(start).toBeGreaterThan(0);
    const call = CODE.slice(start, CODE.indexOf("\n      });", start));
    expect(call).toContain('host: document.getElementById("upcoming-list")');
    expect(call).toContain('statusHost: document.getElementById("upcoming-status")');
    expect(call).toMatch(/limit: \(\) => \(phone && phone\.matches \? PHONE_ROWS : undefined\)/); // a phone shows the next three; anything wider, every one
    expect(call).toMatch(/onPaint: \(items, total\) => \{/);
    expect(call).toMatch(/if \(note\) note\.hidden = items\.length === 0;/);
    const tryAt = CODE.lastIndexOf("try {", start);
    const catchAt = CODE.indexOf("} catch (err) {", start);
    expect(tryAt).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(start);
    expect(CODE.slice(tryAt, catchAt)).not.toContain("renderCatalog("); // only the list is inside the try: the catalogs are drawn after it
    expect(CODE.slice(catchAt, catchAt + 250)).toContain("console.error(");
    expect(CODE.indexOf("renderCatalog(EXPERIENCES_CATALOG")).toBeGreaterThan(catchAt);
    // the ten crests are drawn as shipped: no page switches a preview on
    for (const html of [INDEX_HTML, SCORE_HTML]) expect(html).not.toMatch(/URBANO_CRESTS_PREVIEW/);
  });

  it("without the language table the card is not started and adds no failure of its own (the page's own handling of that failure is what it was)", async () => {
    const page = await loadHome();
    const host = page.doc.createElement("ul");
    expect(page.win.UrbanoHomeUpcoming.init({ host, i18n: {}, data: { matches: [] }, fetch: null, refreshMs: 0 })).toBeNull();
    expect(page.win.UrbanoHomeUpcoming.init({ host, i18n: { t: "not a function" }, data: { matches: [] }, fetch: null, refreshMs: 0 })).toBeNull();
    expect(page.win.UrbanoHomeUpcoming.init({ host: null })).toBeNull();
    expect(host.children).toHaveLength(0);
  });

  it("every key the card and the list ask for exists in both languages and in the Spanish fallback the page carries", async () => {
    const page = await loadHome();
    const dict = page.win.UrbanoI18n.dictionary();
    const start = INDEX_HTML.indexOf('id="featured-predictions"');
    const card = INDEX_HTML.slice(start, INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    const cardKeys = [
      ...Array.from(card.matchAll(/data-i18n="([^"]+)"/g)).map((m) => m[1]!),
      ...Array.from(card.matchAll(/data-i18n-attr="[a-z-]+:([^"]+)"/g)).map((m) => m[1]!),
    ];
    const moduleKeys = Array.from(new Set(Array.from(MODULE_SOURCE.matchAll(/"(upcoming\.[A-Za-z.]+)"/g)).map((m) => m[1]!)));
    expect(cardKeys.length).toBeGreaterThanOrEqual(9);
    expect(moduleKeys).toEqual(expect.arrayContaining(["upcoming.none", "upcoming.status.none", "upcoming.status.open", "upcoming.whenTbc", "upcoming.when", "upcoming.state.next", "upcoming.opensAt", "upcoming.opensAtOne", "upcoming.vs"]));
    expect(cardKeys).toContain("upcoming.disclaimer");
    expect(cardKeys).not.toContain("home.upcoming.disclaimer");
    const fallback = INDEX_HTML.slice(INDEX_HTML.indexOf('<script id="i18n-fallback">'), INDEX_HTML.indexOf("</script>", INDEX_HTML.indexOf('<script id="i18n-fallback">')));
    for (const key of [...cardKeys, ...moduleKeys]) {
      expect(dict.es[key], `es ${key}`).toEqual(expect.any(String));
      expect(dict.en[key], `en ${key}`).toEqual(expect.any(String));
      expect(fallback, `fallback ${key}`).toContain(`"${key}":`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The access to earlier participations and prizes, and the way into the Score lineup
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the access to earlier participations and prizes: its own, visible, before the list", () => {
  it("is the first link of the card, BEFORE the list of coming matches, outside it, and points to the history of the Score page", async () => {
    const page = await loadHome();
    const past = page.q("#featured-past") as HTMLAnchorElement;
    const list = page.q("#upcoming-list")!;
    const lineup = page.q("#featured-lineup")!;
    expect(past.getAttribute("href")).toBe(HISTORY_LINK);
    expect(past.tagName).toBe("A");
    expect(past.compareDocumentPosition(list) & 4).toBeTruthy(); // 4: the list FOLLOWS the access
    expect(list.compareDocumentPosition(lineup) & 4).toBeTruthy(); // the lineup link FOLLOWS the list
    expect(list.contains(past)).toBe(false);
    expect(page.q("#featured-teams")!.contains(past)).toBe(false);
    // the first link of the card, so nobody has to look for it under the matches
    expect((page.q("#featured-predictions a") as HTMLElement).id).toBe("featured-past");
    expect(page.part(".featured-access-note")).toBe(COPY.es.pastNote);
  });

  it("is visible: nothing in it or around it is hidden, and it has a focus style and a touch-sized target", async () => {
    const page = await loadHome();
    for (let el: HTMLElement | null = page.q("#featured-past"); el && el !== page.doc.body; el = el.parentElement) {
      expect(el.hasAttribute("hidden"), el.id || el.className).toBe(false);
      expect(el.getAttribute("aria-hidden"), el.id || el.className).toBeNull();
    }
    const accessLink = rulesFor(".featured-access-link");
    expect(accessLink).toHaveLength(1);
    expect(accessLink[0]!.body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(accessLink[0]!.body).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
    expect(RULES.some((r) => r.selector.split(",").map((s) => s.trim()).includes(".featured-access-link:focus-visible"))).toBe(true);
  });

  it("stays when there is nothing to list: every match passed, or the server cannot be read", async () => {
    for (const opts of [{ now: "2026-12-30T00:00:00Z" }, { server: { status: 500, json: {} } as Reply }, { server: "reject" as Reply }]) {
      const page = await loadHome(opts);
      expect(page.part("#featured-past"), JSON.stringify(opts)).toBe(COPY.es.past);
      expect((page.q("#featured-past") as HTMLAnchorElement).getAttribute("href")).toBe(HISTORY_LINK);
    }
  });

  it("the Score page has the place that link points to: the history section", () => {
    expect(SCORE_HTML).toMatch(/id="historial"/);
    expect(SCORE_HTML).toMatch(/id="score-access-history"[^>]*href="#historial"|href="#historial"[^>]*id="score-access-history"/);
  });

  it("the way into the Score lineup informs and does not invite: an outlined link (transparent background), not the filled button the other cards use", async () => {
    const page = await loadHome();
    const lineup = rulesFor(".featured-lineup").filter((r) => /border:/.test(r.body)); // the class exists (a phone adds only its margin)
    expect(lineup).toHaveLength(1);
    const backgrounds = Array.from(lineup[0]!.body.matchAll(/background(?:-color)?:\s*([^;]+);/g)).map((m) => m[1]!.trim());
    expect(backgrounds).toEqual(["transparent"]);
    expect(lineup[0]!.body).toMatch(/border:\s*1px solid/);
    expect(lineup[0]!.body).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
    expect(RULES.some((r) => r.selector.split(",").map((s) => s.trim()).includes(".featured-lineup:focus-visible"))).toBe(true);
    expect(page.q("#featured-lineup")!.className).toBe("featured-lineup");
    expect(page.part("#featured-lineup")).toBe(COPY.es.lineup);
    expect(page.part("#featured-lineup")).not.toMatch(OPENING_LANGUAGE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The Clásico and its button are gone
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the Clásico and its 'Jugar ahora' button are gone from the Home card", () => {
  it.each(["es", "en"] as const)("%s: no text about the Clásico or about playing now anywhere in the card, and no #featured-play", async (lang) => {
    const page = await loadHome({ lang, crests: true });
    expect(page.cardText()).not.toMatch(/cl[aá]sico/i);
    expect(page.cardText()).not.toMatch(/jugar ahora|play now/i);
    expect(page.card().innerHTML).not.toMatch(/cl[aá]sico|jugar ahora|play now/i);
    expect(page.doc.getElementById("featured-play")).toBeNull();
    expect(page.doc.querySelector(".featured-play")).toBeNull();
    // the Clásico is not a match of the list either
    expect(page.teams().join(" | ")).not.toMatch(/Barcelona v Real Madrid|Real Madrid v (FC )?Barcelona/);
    expect(page.items().map((el) => page.itemText(el)).join(" ")).not.toMatch(/cl[aá]sico/i);
  });

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
// The strip of the ten teams
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the strip of the ten crests (mandatory by the Founder's decision; it establishes no licence)", () => {
  it("is TEN list items in the Founder's order, each named in text — in the markup, with no script run", () => {
    const { card } = staticPage();
    const chips = Array.from(card.querySelectorAll("ul.ten-crests > li.crest-chip"));
    expect(chips).toHaveLength(10);
    expect(chips.map((li) => li.getAttribute("data-club"))).toEqual(STRIP_NAMES);
    expect(chips.map((li) => squash(li.textContent))).toEqual(STRIP_NAMES);
    expect(chips.map((li) => squash(li.querySelector(".crest-name")!.textContent))).toEqual(STRIP_NAMES);
    expect(card.querySelectorAll("ul.ten-crests img")).toHaveLength(0); // the crests are drawn by the central module, never written into the markup
  });

  it("all TEN crest images are drawn WITH NO preview flag: the right crest of each team, first in its item, decoration (empty alt, aria-hidden), and each file exists", async () => {
    const page = await loadHome({ crests: true });
    expect(page.win.URBANO_CRESTS_PREVIEW).toBeUndefined();
    const chips = page.strip();
    expect(chips).toHaveLength(10);
    expect(chips.map((li) => li.getAttribute("data-club"))).toEqual(STRIP_NAMES);
    const images = chips.map((li) => li.querySelectorAll("img"));
    for (const found of images) expect(found).toHaveLength(1);
    const imgs = chips.map((li) => li.querySelector("img.club-crest") as HTMLImageElement);
    expect(imgs.map((img) => img.getAttribute("data-crest"))).toEqual(STRIP_KEYS);
    expect(new Set(STRIP_KEYS).size).toBe(10);
    chips.forEach((li, i) => {
      expect(li.firstElementChild, STRIP_NAMES[i]).toBe(imgs[i]);
      expect(imgs[i]!.getAttribute("alt"), STRIP_NAMES[i]).toBe("");
      expect(imgs[i]!.getAttribute("aria-hidden"), STRIP_NAMES[i]).toBe("true");
      const src = imgs[i]!.getAttribute("src")!;
      expect(src, STRIP_NAMES[i]).toMatch(/^\/assets\/clubs\/[a-z-]+\.(png|svg)$/);
      expect(existsSync(path.join(ROOT, "public", src)), src).toBe(true);
      expect(squash(li.querySelector(".crest-name")!.textContent), STRIP_NAMES[i]).toBe(STRIP_NAMES[i]); // the name stays in text: the accessible name
      expect(squash(li.textContent)).toBe(STRIP_NAMES[i]); // and nothing else is written in the item (the image has no text)
    });
    for (const img of page.qa("#featured-predictions img")) { expect(img.getAttribute("alt")).toBe(""); expect(img.getAttribute("aria-hidden")).toBe("true"); }
  });

  it("is a list labelled by the visible label above it, in both languages", async () => {
    const page = await loadHome({ crests: true });
    const ul = page.q("#featured-predictions ul.ten-crests")!;
    expect(ul.tagName).toBe("UL");
    expect(ul.getAttribute("aria-labelledby")).toBe("featured-teams-label");
    const label = page.doc.getElementById("featured-teams-label")!;
    expect(squash(label.textContent)).toBe(COPY.es.teamsLabel);
    expect(label.compareDocumentPosition(ul) & 4).toBeTruthy(); // the label comes before the strip
    page.win.UrbanoI18n.setLang("en");
    await page.settle();
    expect(squash(page.doc.getElementById("featured-teams-label")!.textContent)).toBe(COPY.en.teamsLabel);
    expect(ul.getAttribute("aria-labelledby")).toBe("featured-teams-label");
    // the names are proper nouns: they are not translated and the crests are drawn once
    expect(page.strip().map((li) => li.getAttribute("data-club"))).toEqual(STRIP_NAMES);
    expect(page.qa("ul.ten-crests img")).toHaveLength(10);
  });

  it("is outside the list of matches, before it, and has no link or control", async () => {
    const page = await loadHome({ crests: true });
    const ul = page.q("ul.ten-crests")!;
    const list = page.q("#upcoming-list")!;
    expect(list.contains(ul)).toBe(false);
    expect(ul.compareDocumentPosition(list) & 4).toBeTruthy();
    expect(ul.querySelector("a, button, input, form")).toBeNull();
  });

  it("is still complete BY NAME when the crests module is absent: ten items, ten names, no image, still labelled", async () => {
    const page = await loadHome(); // no crests module: the page's script tag failed to load
    expect(page.win.UrbanoClubCrests).toBeUndefined();
    expect(page.doc.querySelectorAll("#featured-predictions img")).toHaveLength(0);
    expect(page.strip().map((li) => squash(li.textContent))).toEqual(STRIP_NAMES);
    expect(page.q("ul.ten-crests")!.getAttribute("aria-labelledby")).toBe("featured-teams-label");
    expect(page.teams()).toEqual(FIVE); // and the list is the same without them
  });

  it("a crest whose file cannot be loaded removes itself and leaves the name: the strip is never a row of broken pictures", async () => {
    const page = await loadHome({ crests: true });
    const first = page.strip()[0]!;
    const img = first.querySelector("img")!;
    img.dispatchEvent(new page.win.Event("error"));
    expect(first.querySelector("img")).toBeNull();
    expect(squash(first.textContent)).toBe("Real Madrid");
    expect(page.strip()).toHaveLength(10);
    expect(page.qa("ul.ten-crests img")).toHaveLength(9);
  });

  it("the list beside it draws a crest only for the clubs the registry has (and Valencia, Atlético de Madrid and Liverpool, which it has not, are just their names); every crest of the list is also in the strip", async () => {
    const page = await loadHome({ crests: true });
    expect(page.teams()).toEqual(FIVE);
    const listCrests = page.qa("#upcoming-list img.club-crest");
    expect(listCrests.map((img) => img.parentElement!.getAttribute("data-club"))).toEqual(["Real Madrid", "FC Barcelona", "Motagua", "Olimpia", "Manchester United", "Arsenal", "Manchester City"]);
    const inStrip = new Set(page.qa("ul.ten-crests img").map((img) => img.getAttribute("data-crest")));
    for (const img of listCrests) expect(inStrip.has(img.getAttribute("data-crest")), img.getAttribute("data-crest")!).toBe(true);
    // the three of the ten that no listed match names (Inter, Bayern, Paris Saint-Germain) keep their crest: five matches do not shrink the strip
    const listed = new Set(page.items().flatMap((el) => Array.from(el.querySelectorAll(".upcoming-team")).map((t) => t.getAttribute("data-club"))));
    expect(STRIP_NAMES.filter((n) => !listed.has(n))).toEqual(["Inter de Milán", "Bayern Múnich", "Paris Saint-Germain"]);
    expect(page.qa("ul.ten-crests img")).toHaveLength(10);
    for (const img of page.qa("#featured-predictions img")) { expect(img.getAttribute("alt")).toBe(""); expect(img.getAttribute("aria-hidden")).toBe("true"); }
  });

  it("a change of language or time redraws the list without adding a second crest to anyone", async () => {
    const page = await loadHome({ crests: true });
    const before = [page.qa("ul.ten-crests img").length, page.qa("#upcoming-list img").length];
    expect(before).toEqual([10, 7]);
    page.win.UrbanoI18n.setLang("en");
    await page.settle();
    expect([page.qa("ul.ten-crests img").length, page.qa("#upcoming-list img").length]).toEqual(before);
    expect(page.qa("#upcoming-list .upcoming-team")).toHaveLength(10);
  });

  it("the page's CSS keeps the names: a name is hidden ONLY beside a drawn crest (as a screen-reader label), and no rule removes the strip or an item, on a phone either", () => {
    const hide = rulesFor(".ten-crests .club-crest + .crest-name");
    expect(hide).toHaveLength(1);
    expect(hide[0]!.body).toMatch(/position:\s*absolute/);
    const name = rulesFor(".ten-crests .crest-name");
    expect(name).toHaveLength(1);
    expect(name[0]!.body).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0\b|clip|position:\s*absolute/);
    for (const rule of RULES.filter((r) => /\.(ten-crests|crest-chip)\b/.test(r.selector))) expect(rule.body, rule.selector).not.toMatch(/display:\s*none/);
    expect(rulesFor(".ten-crests").length).toBeGreaterThanOrEqual(2); // the desktop rule and a rule for a narrow screen
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The list: at most five, in order of start, in Honduras time, all "Preselección" by default
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the list of coming matches", () => {
  it("shows the five matches of the preselection, in order of start, each with ONE state in words: 'Preselección' — and nothing that says people can take part", async () => {
    const page = await loadHome();
    expect(page.teams()).toEqual(FIVE);
    expect(page.ids()).toEqual(FIVE_IDS);
    expect(page.chips()).toEqual(Array(5).fill(COPY.es.next));
    expect(page.states()).toEqual(Array(5).fill("next"));
    expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
    expect(page.promiseText()).not.toMatch(PROMISES);
    expect(page.cardText()).not.toMatch(/Próximo partido|Upcoming match\b/); // the old chip is gone
    expect(page.cardText()).not.toMatch(/Aún no abierto|Not open yet/); // and so is the chip that said a match was NOT open
    expect(page.doc.querySelectorAll("#upcoming-list .upcoming-opens")).toHaveLength(0); // no participation window is written or invented
    expect(page.doc.querySelectorAll("#upcoming-list .state-open, #upcoming-list .state-scheduled")).toHaveLength(0);
  });

  it.each(["es", "en"] as const)("%s: the chip of an announced match is 'Preselección' / 'Shortlisted': it says what the match IS, never that it is NOT open; no other chip changed", async (lang) => {
    const page = await loadHome({ lang });
    expect(page.chips()).toEqual(Array(5).fill(COPY[lang].next));
    expect(COPY[lang].next).toBe(lang === "es" ? "Preselección" : "Shortlisted");
    for (const chip of page.chips()) expect(chip, chip).not.toMatch(/\bno\b|\bnot\b|a[uú]n|yet/i);
    expect(page.qa("#upcoming-list .upcoming-chip").every((c) => c.className === "upcoming-chip state-next")).toBe(true);
    // the other four states are worded as before (and the five are distinct)
    const dict = page.win.UrbanoI18n.dictionary()[lang];
    expect([dict["upcoming.state.scheduled"], dict["upcoming.state.open"], dict["upcoming.state.closed"], dict["upcoming.state.final"]]).toEqual([COPY[lang].scheduled, COPY[lang].open, COPY[lang].closed, COPY[lang].final]);
    expect(new Set([dict["upcoming.state.next"], COPY[lang].scheduled, COPY[lang].open, COPY[lang].closed, COPY[lang].final]).size).toBe(5);
  });

  it("the card's words never promise anything, in either language (the legal line, which names sponsorship only to deny it, is the one text left out)", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome({ lang });
      expect(page.promiseText(), lang).not.toMatch(PROMISES);
      expect(page.promiseText(), lang).not.toMatch(OPENING_LANGUAGE);
      expect(page.cardText(), lang).toContain(COPY[lang].legal); // the legal line is the one thing left out above, and it is there
    }
  });

  it("the markup of a row: li.upcoming-item > div.upcoming-teams > [span.upcoming-team (home)] + span.upcoming-away > [span.upcoming-vs + span.upcoming-team (away)]; then div.upcoming-meta; then span.upcoming-chip", async () => {
    const shape = (el: Element) => `${el.tagName.toLowerCase()}.${el.className.split(" ")[0]}`;
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome({ lang });
      for (const li of page.items()) {
        expect(li.tagName).toBe("LI");
        expect(Array.from(li.children).map(shape)).toEqual(["div.upcoming-teams", "div.upcoming-meta", "span.upcoming-chip"]);
        const [teams, meta] = [li.children[0]!, li.children[1]!];
        expect(Array.from(teams.children).map(shape)).toEqual(["span.upcoming-team", "span.upcoming-away"]);
        expect(Array.from(teams.children[1]!.children).map(shape)).toEqual(["span.upcoming-vs", "span.upcoming-team"]);
        expect(Array.from(meta.children).map(shape)).toEqual(["span.upcoming-comp", "time.upcoming-time"]);
        // descendant selectors still reach the teams and the "vs"
        expect(li.querySelectorAll(".upcoming-team")).toHaveLength(2);
        expect(li.querySelectorAll(".upcoming-vs")).toHaveLength(1);
        expect(squash(li.querySelector(".upcoming-vs")!.textContent)).toBe("vs"); // «vs» in both languages (was «vs.» / «v»)
      }
      // the first row, word for word: home, vs, away
      const first = page.items()[0]!;
      expect(Array.from(first.querySelectorAll(".upcoming-team, .upcoming-vs")).map((e) => squash(e.textContent))).toEqual(["Valencia", "vs", "Real Madrid"]);
      expect(first.children[0]!.getAttribute("class")).toBe("upcoming-teams");
      expect(first.querySelector(".upcoming-away")!.firstElementChild!.className).toBe("upcoming-vs"); // the "vs" stays with the AWAY team
    }
  });

  it("with the crest module the row has the same shape: the crests are added INSIDE each team, and nothing else moves", async () => {
    const page = await loadHome({ crests: true });
    const first = page.items()[0]!;
    expect(Array.from(first.children).map((e) => e.className.split(" ")[0])).toEqual(["upcoming-teams", "upcoming-meta", "upcoming-chip"]);
    expect(Array.from(first.querySelector(".upcoming-teams")!.children).map((e) => e.className)).toEqual(["upcoming-team", "upcoming-away"]);
    expect(first.querySelector(".upcoming-away")!.firstElementChild!.className).toBe("upcoming-vs");
    for (const team of Array.from(first.querySelectorAll(".upcoming-team"))) expect(team.parentElement === first.querySelector(".upcoming-teams") || team.parentElement === first.querySelector(".upcoming-away")).toBe(true);
  });

  it("writes each start once: machine-readable (the UTC instant, or the plain date) and as Honduras time; a match with no confirmed hour says so and shows no hour", async () => {
    const es = await loadHome({ lang: "es" });
    expect(es.times()).toEqual([
      ["set", "2026-11-07T20:00:00Z", "sáb 7 nov · 🇭🇳 2:00 p. m."],
      ["set", "2026-11-08T20:00:00Z", "dom 8 nov · 🇭🇳 2:00 p. m."],
      ["tbc", "2026-11-19", "jue 19 nov · Horario por confirmar"],
      ["set", "2026-11-22T16:30:00Z", "dom 22 nov · 🇭🇳 10:30 a. m."],
      ["set", "2026-11-29T16:30:00Z", "dom 29 nov · 🇭🇳 10:30 a. m."],
    ]);
    const en = await loadHome({ lang: "en" });
    expect(en.times().map((t) => t[2])).toEqual(["Sat, Nov 7 · 🇭🇳 2:00 p.m.", "Sun, Nov 8 · 🇭🇳 2:00 p.m.", "Thu, Nov 19 · Time to be confirmed", "Sun, Nov 22 · 🇭🇳 10:30 a.m.", "Sun, Nov 29 · 🇭🇳 10:30 a.m."]);
    // the clock of the person's device does not matter: only the instant and the six hours
    expect(MODULE_SOURCE).toMatch(/HN_OFFSET_MS = 6 \* 60 \* 60 \* 1000/);
    expect(MODULE_SOURCE).not.toMatch(/Intl\.|toLocale|getTimezoneOffset|getHours\(|getDay\(\)|getDate\(\)/);
  });

  it("Honduras time is the instant minus six hours, with no daylight saving: 01:30 UTC of the 20th is 7:30 p. m. of the 19th; midnight and noon read 12:00 a. m. and 12:00 p. m.", async () => {
    const page = await loadHome();
    const t = (k: string, v?: unknown) => page.win.UrbanoI18n.t(k, v);
    const api = page.win.UrbanoHomeUpcoming;
    expect(api.whenText(Date.parse("2026-11-20T01:30:00Z"), t)).toBe("jue 19 nov · 🇭🇳 7:30 p. m.");
    expect(api.whenText(Date.parse("2026-11-07T06:00:00Z"), t)).toBe("sáb 7 nov · 🇭🇳 12:00 a. m.");
    expect(api.whenText(Date.parse("2026-11-07T18:00:00Z"), t)).toBe("sáb 7 nov · 🇭🇳 12:00 p. m.");
    expect(api.whenText(Date.parse("2026-11-07T05:59:00Z"), t)).toBe("vie 6 nov · 🇭🇳 11:59 p. m.");
    expect(api.whenDateText(Date.parse("2026-11-19T06:00:00Z"), t)).toBe("jue 19 nov · Horario por confirmar");
    const shown = await loadHome({ data: { matches: [{ ...SRC, id: "late", kickoffAt: "2026-11-20T01:30:00Z", home: "Motagua", away: "Olimpia", competition: "Liga Nacional" }] } });
    expect(shown.times()).toEqual([["set", "2026-11-20T01:30:00Z", "jue 19 nov · 🇭🇳 7:30 p. m."]]); // still the 19th in Honduras
  });

  it("a match with an hour leaves the list three hours after it starts (and is 'Cerrado' until then); the list gets shorter, there being only five", async () => {
    const earlier = await loadHome({ now: "2026-11-07T20:15:00Z" }); // 15 minutes after the first kickoff
    expect(earlier.teams()).toEqual(FIVE);
    expect(earlier.states()).toEqual(["closed", "next", "next", "next", "next"]);
    const almost = await loadHome({ now: "2026-11-07T22:59:59Z" }); // one second before the three hours
    expect(almost.teams()[0]).toBe("Valencia v Real Madrid");
    expect(almost.states()[0]).toBe("closed");
    const later = await loadHome({ now: "2026-11-07T23:00:00Z" }); // three hours after
    expect(later.teams()).toEqual(FIVE.slice(1));
    expect(later.states()).toEqual(Array(4).fill("next"));
  });

  it("with more announced matches than fit, the list moves up when one leaves: the next match takes its place", async () => {
    const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ ...SRC, id: `M-${n}`, kickoffAt: `2026-11-0${n}T20:00:00Z`, home: `Casa ${n}`, away: `Visita ${n}`, competition: "Liga" }));
    const before = await loadHome({ data: { matches: entries }, now: NOW_QUIET });
    expect(before.ids()).toEqual(["M-1", "M-2", "M-3", "M-4", "M-5"]); // the sixth waits
    const after = await loadHome({ data: { matches: entries }, now: "2026-11-01T23:00:00Z" }); // M-1 left three hours after its start
    expect(after.ids()).toEqual(["M-2", "M-3", "M-4", "M-5", "M-6"]);
  });

  it("when every announced match has passed, it says it is preparing the next ones (no empty box, no error) and the accesses and the ten crests stay", async () => {
    for (const lang of ["es", "en"] as const) {
      const done = await loadHome({ lang, now: "2026-12-30T00:00:00Z", crests: true });
      expect(done.items()).toHaveLength(0);
      expect(squash(done.doc.querySelector("#upcoming-list .upcoming-none")!.textContent)).toBe(COPY[lang].none);
      expect(done.part("#featured-lineup")).toBe(COPY[lang].lineup); // the way into the lineup is still there
      expect(done.part("#featured-past")).toBe(COPY[lang].past); // and so is the way to earlier participations and prizes
      expect(done.strip()).toHaveLength(10);
      expect(done.qa("ul.ten-crests img")).toHaveLength(10);
      expect(done.note().hidden, lang).toBe(true); // the note about the dates of the rows has nothing to talk about
    }
  });

  it("the note about dates and times (#featured-note) is shown while there are rows and hidden when the list is empty; it returns with the rows", async () => {
    const withRows = await loadHome();
    expect(withRows.items()).toHaveLength(5);
    expect(withRows.note().hidden).toBe(false);
    expect(squash(withRows.note().textContent)).toBe(COPY.es.note);
    expect(withRows.note().className).toBe("featured-note");
    const empty = await loadHome({ now: "2026-12-30T00:00:00Z" });
    expect(empty.items()).toHaveLength(0);
    expect(empty.note().hidden).toBe(true);
    const noEntries = await loadHome({ data: { matches: [] } });
    expect(noEntries.note().hidden).toBe(true);
    // a redrawn list moves the note with it, in both directions, through the module's onPaint
    const note = withRows.note();
    const host = withRows.doc.createElement("ul");
    let nowMs = Date.parse(NOW_QUIET);
    const handle = withRows.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: () => nowMs, serverMatches: [], refreshMs: 0, onPaint: (items: any[]) => { note.hidden = items.length === 0; } });
    expect(note.hidden).toBe(false);
    nowMs = Date.parse("2026-12-30T00:00:00Z");
    handle.paint();
    expect(note.hidden).toBe(true);
    nowMs = Date.parse(NOW_QUIET);
    handle.paint();
    expect(note.hidden).toBe(false);
    handle.stop();
  });

  it("the old note and scope classes are gone: no .featured-window, .featured-scope or .featured-when in the markup, the code or the CSS; .featured-note styles the note", async () => {
    const page = await loadHome();
    expect(CODE).not.toMatch(/featured-window|featured-scope|featured-when/);
    expect(RULES.filter((r) => /featured-window|featured-scope|featured-when/.test(r.selector))).toEqual([]);
    expect(rulesFor(".featured-note")).toHaveLength(1);
    for (const sel of [".featured-window", ".featured-scope", ".featured-when"]) expect(page.doc.querySelector(sel), sel).toBeNull();
    expect(page.doc.querySelectorAll("p#featured-note.featured-note")).toHaveLength(1);
  });

  it("is drawn from text, never markup: a name with markup in it is shown as the words it is", async () => {
    const page = await loadHome();
    const tricky = [
      { ...SRC, id: "x", kickoffAt: "2026-11-02T20:00:00Z", home: "<img src=x onerror=alert(1)>", away: "A&B <b>FC</b>", competition: "<script>1</script>" },
      { id: "y", date: "2026-11-03", home: "<i>Rojo</i>", away: "Azul & Co", competition: "<svg onload=alert(2)>" },
    ];
    page.win.UrbanoHomeUpcoming.init({ host: page.doc.getElementById("upcoming-list"), data: { matches: tricky }, now: () => Date.parse(NOW_QUIET), fetch: null, serverMatches: [], refreshMs: 0 });
    expect(page.doc.querySelectorAll("#upcoming-list img, #upcoming-list b, #upcoming-list i, #upcoming-list script, #upcoming-list svg")).toHaveLength(0); // no element was made out of the data
    expect(page.teams()).toEqual(["<img src=x onerror=alert(1)> v A&B <b>FC</b>", "<i>Rojo</i> v Azul & Co"]);
    expect(page.qa("#upcoming-list .upcoming-comp").map((e) => squash(e.textContent))).toEqual(["<script>1</script>", "<svg onload=alert(2)>"]);
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

  it("MAX_ITEMS is five: the default limit of select and of the card", async () => {
    const page = await loadHome();
    const api = page.win.UrbanoHomeUpcoming;
    expect(api.MAX_ITEMS).toBe(5);
    expect(ids(api.select(ENTRIES, [], NOW))).toEqual(["E-1", "E-2", "E-3", "E-4", "E-5"]);
    expect(ids(api.select(ENTRIES, [], NOW, undefined))).toEqual(["E-1", "E-2", "E-3", "E-4", "E-5"]);
    expect(ids(api.select(ENTRIES, [], NOW, 2))).toEqual(["E-1", "E-2"]); // an explicit limit wins, applied after the order of start
    expect(ids(api.select([...ENTRIES].reverse(), [], NOW, 3))).toEqual(["E-1", "E-2", "E-3"]);
    expect(page.items()).toHaveLength(5); // the real preselection fits exactly
    expect(MODULE_SOURCE).not.toMatch(/MAX_ITEMS = 3/);
  });

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

  it("is drawn with its date and the words 'Horario por confirmar' (never an hour), data-time='tbc', datetime = the date, and the chip 'Preselección' — in both languages", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome({ lang });
      const row = page.items()[2]!;
      expect(row.getAttribute("data-match")).toBe("N26-46");
      expect(row.getAttribute("data-time")).toBe("tbc");
      expect(row.getAttribute("data-state")).toBe("next");
      const time = row.querySelector("time")!;
      expect(time.getAttribute("datetime")).toBe("2026-11-19");
      expect(squash(time.textContent)).toBe(lang === "es" ? "jue 19 nov · Horario por confirmar" : "Thu, Nov 19 · Time to be confirmed");
      expect(squash(time.textContent)).toContain(COPY[lang].tbc);
      expect(squash(time.textContent)).not.toMatch(/\d:\d\d|a\. ?m\.|p\. ?m\./); // no hour is shown or invented
      expect(squash(row.querySelector(".upcoming-chip")!.textContent)).toBe(COPY[lang].next);
      expect(row.querySelector(".upcoming-opens")).toBeNull(); // and no participation window
      // the other four have an hour: the words appear once in the whole list
      expect(page.items().filter((el) => el.getAttribute("data-time") === "set")).toHaveLength(4);
      expect(page.items().filter((el) => page.itemText(el).includes(COPY[lang].tbc))).toHaveLength(1);
    }
  });

  it("is placed by its Honduras date: 00:00 Honduras of that date to the end of that date (24 h); an hour-less match sorts among the timed ones by that moment", async () => {
    const page = await loadHome();
    expect({ ...api(page).timing(TBC) }).toEqual({ hasTime: false, start: Date.parse("2026-11-19T06:00:00Z"), leaves: Date.parse("2026-11-20T06:00:00Z") });
    const before = { ...SRC, id: "B", kickoffAt: "2026-11-18T20:00:00Z", home: "Casa B", away: "Visita B", competition: "Liga" };
    const after = { ...SRC, id: "A", kickoffAt: "2026-11-20T20:00:00Z", home: "Casa A", away: "Visita A", competition: "Liga" };
    const ids = Array.from(api(page).select([after, TBC, before], [], Date.parse("2026-11-10T00:00:00Z"), 5), (i: any) => i.entry.id);
    expect(ids).toEqual(["B", "D-1", "A"]);
  });

  it("stays in the list through the WHOLE Honduras date and leaves at 00:00 Honduras of the next day; it is never 'Cerrado' on its own date (no hour, nothing has started)", async () => {
    const page = await loadHome();
    const at = (iso: string) => states(api(page).select([TBC], [], Date.parse(iso), 5));
    expect(at("2026-11-12T06:00:00Z")).toEqual(["next"]); // announced well ahead
    expect(at("2026-11-19T05:59:59Z")).toEqual(["next"]); // 23:59:59 of the 18th in Honduras
    expect(at("2026-11-19T06:00:00Z")).toEqual(["next"]); // 00:00 of the 19th: the date begins and the match does not become 'Cerrado'
    expect(at("2026-11-19T20:00:00Z")).toEqual(["next"]); // 2:00 p. m. of the 19th
    expect(at("2026-11-20T01:30:00Z")).toEqual(["next"]); // 7:30 p. m. of the 19th
    expect(at("2026-11-20T05:59:59Z")).toEqual(["next"]); // 23:59:59 of the 19th
    expect(at("2026-11-20T06:00:00Z")).toEqual([]); // 00:00 of the 20th: it leaves
    expect(at("2026-11-25T06:00:00Z")).toEqual([]);
    // and in the page itself, on the evening of its date
    const evening = await loadHome({ data: { matches: [TBC] }, now: "2026-11-20T03:00:00Z" });
    expect(evening.states()).toEqual(["next"]);
    expect(evening.chips()).toEqual([COPY.es.next]);
    expect(evening.items()[0]!.getAttribute("data-time")).toBe("tbc");
    const gone = await loadHome({ data: { matches: [TBC] }, now: "2026-11-20T06:00:00Z" });
    expect(gone.items()).toHaveLength(0);
    expect(squash(gone.q("#upcoming-list .upcoming-none")!.textContent)).toBe(COPY.es.none);
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

  it("KEY SAFETY PROPERTY, in the page: the ROW stays 'Preselección' however the server lists the same teams (before, at and after its kickoff, and finalized); the sentence under the list speaks only for the server's own list", async () => {
    const same = (over: Record<string, unknown>) => serverMatch({ kickoffAt: "2026-11-19T20:00:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" }, ...over });
    for (const [now, server, line] of [
      ["2026-11-19T05:00:00Z", same({ kickoffAt: "2026-11-19T06:00:00.000Z" }), COPY.es.statusOpen], // the very instant the date begins in Honduras (00:00): the only instant a date could ever be compared with
      ["2026-11-19T12:00:00Z", same({}), COPY.es.statusOpen],
      ["2026-11-19T20:00:00Z", same({}), COPY.es.statusNone], // kickoff: the server refuses from this instant
      ["2026-11-19T21:00:00Z", same({}), COPY.es.statusNone],
      ["2026-11-19T21:00:00Z", same({ finalized: true, finalResult: { homeScore: 2, awayScore: 2 } }), COPY.es.statusNone],
      ["2026-11-19T12:00:00Z", same({ participationOpensAt: "2026-11-19T18:00:00.000Z" }), COPY.es.statusNone], // its window has not opened
    ] as Array<[string, unknown, string]>) {
      const page = await loadHome({ data: { matches: [TBC] }, now, server: answer(server) });
      expect(page.states(), now).toEqual(["next"]);
      expect(page.chips(), now).toEqual([COPY.es.next]);
      expect(page.items()[0]!.getAttribute("data-time")).toBe("tbc");
      expect(page.statusLine(), now).toBe(line); // the SERVER has (or has not) a match that accepts participation: the line says so, and points to the Score fixtures
      expect(squash(page.q("#upcoming-list")!.textContent), now).not.toMatch(OPENING_LANGUAGE); // and the ROW says nothing of the kind
      expect(page.doc.querySelectorAll("#upcoming-list .upcoming-opens")).toHaveLength(0);
    }
    // with the real editorial list: the server opens Valencia–Real Madrid (it has an hour) and cannot open Motagua–Olimpia (it has not)
    const real = await loadHome({
      now: "2026-11-07T14:00:00Z",
      server: answer(
        serverMatch({ kickoffAt: "2026-11-07T20:00:00.000Z", homeTeam: { name: "Valencia" }, awayTeam: { name: "Real Madrid" } }),
        serverMatch({ matchId: "m-2", kickoffAt: "2026-11-19T20:00:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" } }),
        serverMatch({ matchId: "m-3", kickoffAt: "2026-11-20T01:30:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" } }),
      ),
    });
    expect(real.states()).toEqual(["open", "next", "next", "next", "next"]);
    expect(real.chips()[2]).toBe(COPY.es.next);
    expect(real.statusLine()).toBe(COPY.es.statusOpen);
    // only the matches that tie to no row are on the server's list: no row opens, and the line still says what the server says
    const orphans = await loadHome({
      now: "2026-11-07T14:00:00Z",
      server: answer(serverMatch({ matchId: "m-2", kickoffAt: "2026-11-19T20:00:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" } })),
    });
    expect(orphans.states()).toEqual(Array(5).fill("next"));
    expect(orphans.chips()).toEqual(Array(5).fill(COPY.es.next));
    expect(orphans.statusLine()).toBe(COPY.es.statusOpen);
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

  it("in the page: only the entries that can be placed are drawn; the dropped ones leave no row, no error, and the valid date-only one is kept", async () => {
    const page = await loadHome({
      now: NOW_QUIET,
      data: {
        matches: [
          { ...base, id: "ok-1", kickoffAt: "2026-11-02T20:00:00Z" },
          { ...base, id: "bad-number", kickoffAt: 1793000000000, date: VALID_DATE },
          { ...base, id: "bad-string", kickoffAt: "pronto", date: VALID_DATE },
          { ...base, id: "bad-date-1", date: "2026-02-30" },
          { ...base, id: "bad-date-2", date: "2026-13-01" },
          { ...base, id: "bad-date-3", date: "19-11-2026" },
          { ...base, id: "bad-none" },
          { ...base, id: "ok-2", date: VALID_DATE },
        ],
      },
    });
    expect(page.ids()).toEqual(["ok-1", "ok-2"]);
    expect(page.items().map((el) => el.getAttribute("data-time"))).toEqual(["set", "tbc"]);
    expect(page.cardText()).not.toMatch(/undefined|NaN|Invalid/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The status line under the list
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the status line under the list: it speaks for the SERVER's list, and only once that list has been read", () => {
  it.each(["es", "en"] as const)("%s: after a successful read in which nothing accepts participation it says that nothing is open (visible, polite), and never the sentence that matches are open", async (lang) => {
    const page = await loadHome({ lang });
    expect(page.statusLine()).toBe(COPY[lang].statusNone);
    expect(page.statusHidden()).toBe(false);
    expect(page.q("#upcoming-status")!.getAttribute("aria-live")).toBe("polite");
    expect(page.cardText()).not.toContain(COPY[lang].statusOpen);
    expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
  });

  it.each(["es", "en"] as const)("%s: when the SERVER lists a match that accepts participation it says that matches are open and where to see them", async (lang) => {
    const page = await loadLogic({ lang, now: "2026-11-03T19:00:00Z", server: answer(serverMatch()) });
    expect(page.states().filter((s) => s === "open")).toHaveLength(1);
    expect(page.statusLine()).toBe(COPY[lang].statusOpen);
    expect(page.statusHidden()).toBe(false);
  });

  it.each([
    ["the server lists nothing", answer()],
    ["the venue is not enabled", answer(disabled(serverMatch(), { enabled: false }))],
    ["the venue is not active", answer(disabled(serverMatch(), { venue: { ...serverMatch().venueActivations[0]!.venue, active: false } }))],
    ["there is no venue at all", answer(disabled(serverMatch(), { venue: null }))],
    ["the offer is not available", answer(disabled(serverMatch(), { offer: noOffer }))],
    ["there is no offer", answer(disabled(serverMatch(), { offer: null }))],
    ["there is no venue activation", answer(serverMatch({ venueActivations: [] }))],
    ["enabled is anything but true", answer(disabled(serverMatch(), { enabled: "true" }))],
    ["the match has an approved window that has not opened (it is only scheduled)", answer(serverMatch({ participationOpensAt: "2026-11-03T19:30:00.000Z" }))],
    ["the match is cancelled", answer(serverMatch({ cancelledAt: "2026-11-02T10:00:00.000Z" }))],
    ["the match is finalized", answer(serverMatch({ finalized: true, finalResult: { homeScore: 1, awayScore: 0 } }))],
    ["the start of the match cannot be read", answer(serverMatch({ kickoffAt: "pronto" }))],
  ])("after a successful read it says that nothing is open when %s", async (_why, server) => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server });
    expect(page.states()).not.toContain("open");
    expect(page.statusLine()).toBe(COPY.es.statusNone);
    expect(page.statusHidden()).toBe(false);
  });

  it("after a successful read it says that nothing is open when the matches have started or are finished (nothing is open to participate in)", async () => {
    const started = await loadLogic({ now: "2026-11-03T21:30:00Z", server: answer(serverMatch()) });
    expect(started.states().slice(0, 2)).toEqual(["closed", "closed"]);
    expect(started.statusLine()).toBe(COPY.es.statusNone);
    const exactly = await loadLogic({ now: "2026-11-03T20:00:00Z", server: answer(serverMatch()) }); // the server refuses from the instant of kickoff
    expect(exactly.statusLine()).toBe(COPY.es.statusNone);
    const finished = await loadLogic({ now: "2026-11-03T21:30:00Z", server: answer(serverMatch({ finalized: true, finalResult: { homeScore: 1, awayScore: 0 } })) });
    expect(finished.states().slice(0, 2)).toEqual(["final", "closed"]);
    expect(finished.statusLine()).toBe(COPY.es.statusNone);
  });

  it.each([
    ["a match with ANOTHER start than any row", serverMatch({ kickoffAt: "2026-11-03T20:01:00.000Z" })],
    ["a match with other teams", serverMatch({ homeTeam: { name: "Rojo FC" }, awayTeam: { name: "Azul FC" } })],
    ["a match with other teams and another start", serverMatch({ kickoffAt: "2026-11-05T01:00:00.000Z", homeTeam: { name: "Rojo FC" }, awayTeam: { name: "Azul FC" } })],
    ["a match with other teams whose approved window HAS opened", serverMatch({ participationOpensAt: "2026-11-03T18:00:00.000Z", homeTeam: { name: "Rojo FC" }, awayTeam: { name: "Azul FC" } })],
  ])("it says that matches are open when the server lists %s that accepts participation — even though it ties to no row, and every row stays 'Preselección'", async (_why, match) => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(match) });
    expect(page.states()).toEqual(["next", "next", "next"]); // no row is upgraded: it needs the same instant and both teams
    expect(page.chips()).toEqual(Array(3).fill(COPY.es.next));
    expect(page.statusLine()).toBe(COPY.es.statusOpen);
    expect(page.statusHidden()).toBe(false);
    expect(squash(page.q("#upcoming-list")!.textContent)).not.toMatch(OPENING_LANGUAGE);
  });

  it.each([
    ["'Valencia CF' (another spelling of a row's club)", { kickoffAt: "2026-11-07T20:00:00.000Z", homeTeam: { name: "Valencia CF" }, awayTeam: { name: "Real Madrid" } }],
    ["'Atlético Madrid' (another spelling of a row's club)", { kickoffAt: "2026-11-08T20:00:00.000Z", homeTeam: { name: "Atlético Madrid" }, awayTeam: { name: "FC Barcelona" } }],
    ["the right teams at ANOTHER start", { kickoffAt: "2026-11-07T21:00:00.000Z", homeTeam: { name: "Valencia" }, awayTeam: { name: "Real Madrid" } }],
    ["a match that is not in the editorial list at all", { kickoffAt: "2026-11-10T20:00:00.000Z", homeTeam: { name: "Rojo FC" }, awayTeam: { name: "Azul FC" } }],
  ])("on the real editorial list: %s, open on the server, leaves the five rows 'Preselección' and still makes the line say that matches are open", async (_why, over) => {
    const page = await loadHome({ now: "2026-11-07T14:00:00Z", server: answer(serverMatch(over)) });
    expect(page.states()).toEqual(Array(5).fill("next"));
    expect(page.chips()).toEqual(Array(5).fill(COPY.es.next));
    expect(page.statusLine()).toBe(COPY.es.statusOpen);
  });

  it.each([
    ["the server answers 500", { status: 500, json: { error: "x" } } as Reply],
    ["the server answers 401", { status: 401, json: {} } as Reply],
    ["the answer is not the list", { status: 200, json: { matches: "no" } } as Reply],
    ["the answer has no body", { status: 200, json: null } as Reply],
    ["the network fails", "reject" as Reply],
    ["the answer is not JSON", "badjson" as Reply],
  ])("when the list could not be read (%s) the sentence is NOT shown — hidden and empty — the chips stay 'Preselección' and nothing says anything is open", async (_why, server) => {
    for (const load of [loadLogic, loadHome]) { // the fixed fixture and the real editorial list
      const page = await load({ now: "2026-11-03T19:00:00Z", server });
      expect(page.statusHidden()).toBe(true);
      expect(page.statusLine()).toBe("");
      expect(page.q("#upcoming-status")!.childNodes).toHaveLength(0);
      expect(page.items().length).toBeGreaterThan(0);
      expect(new Set(page.states())).toEqual(new Set(["next"]));
      expect(new Set(page.chips())).toEqual(new Set([COPY.es.next]));
      expect(page.cardText()).not.toContain(COPY.es.statusNone); // neither "nothing is open"...
      expect(page.cardText()).not.toContain(COPY.es.statusOpen); // ...nor "some are open": the list says only what it knows
      expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
    }
  });

  it.each(["es", "en"] as const)("%s: while the list is still being read (a read that never ends) the sentence is not shown — hidden and empty — and the rows are already drawn as 'Preselección'", async (lang) => {
    const page = await loadLogic({ lang, now: "2026-11-03T19:00:00Z", server: "hang" });
    expect(page.calls).toHaveLength(1); // it asked once and is still waiting
    expect(page.statusHidden()).toBe(true);
    expect(page.statusLine()).toBe("");
    expect(page.items()).toHaveLength(3);
    expect(page.chips()).toEqual(Array(3).fill(COPY[lang].next));
    expect(page.cardText()).not.toContain(COPY[lang].statusNone);
    expect(page.cardText()).not.toContain(COPY[lang].statusOpen);
  });

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

  it("is HIDDEN (and empty) when the list is empty: every match passed, or no entry at all — even after a successful read", async () => {
    const passed = await loadHome({ now: "2026-12-30T00:00:00Z" });
    expect(passed.items()).toHaveLength(0);
    expect(passed.statusHidden()).toBe(true);
    expect(passed.statusLine()).toBe("");
    const none = await loadHome({ data: { matches: [] } });
    expect(none.items()).toHaveLength(0);
    expect(none.statusHidden()).toBe(true);
    expect(none.statusLine()).toBe("");
    const withOpenServer = await loadHome({ data: { matches: [] }, server: answer(serverMatch({ kickoffAt: "2026-11-30T20:00:00.000Z" })) });
    expect(withOpenServer.items()).toHaveLength(0); // a server match that is open, but no row to put the sentence under
    expect(withOpenServer.statusHidden()).toBe(true);
    expect(withOpenServer.statusLine()).toBe("");
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
  it("PARTICIPACIÓN PROGRAMADA: the server says the match has an approved window that has not opened — with the opening hour in Honduras time", async () => {
    const page = await loadLogic({ now: "2026-11-03T14:00:00Z", server: answer(serverMatch({ participationOpensAt: "2026-11-03T18:30:00.000Z", venueActivations: [] })) });
    const barca = page.items().find((el) => page.itemText(el).includes("FC Barcelona"))!;
    expect(barca.getAttribute("data-state")).toBe("scheduled");
    expect(squash(barca.querySelector(".upcoming-chip")!.textContent)).toBe(COPY.es.scheduled);
    expect(squash(barca.querySelector(".upcoming-opens")!.textContent)).toBe("Participación desde las 12:30 p. m. (hora de Honduras)");
    expect(page.cardText()).not.toMatch(/Abierto para/);
    expect(page.statusLine()).toBe(COPY.es.statusNone); // scheduled is not open: the line still says that nothing is open
  });

  it("an enabled venue does not open a match whose window has not opened yet: it is still 'programada'", async () => {
    const page = await loadLogic({ now: "2026-11-03T14:00:00Z", server: answer(serverMatch({ participationOpensAt: "2026-11-03T18:30:00.000Z" })) });
    expect(page.states()).toContain("scheduled");
    expect(page.states()).not.toContain("open");
  });

  it("ABIERTO PARA PARTICIPAR: an enabled venue activation of an active venue with an available offer, and the approved window (if any) has opened", async () => {
    const withWindow = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ participationOpensAt: "2026-11-03T18:30:00.000Z" })) });
    expect(withWindow.states().filter((s) => s === "open")).toHaveLength(1);
    const noWindow = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch()) });
    expect(noWindow.chips().filter((c) => c === COPY.es.open)).toHaveLength(1);
    const en = await loadLogic({ lang: "en", now: "2026-11-03T19:00:00Z", server: answer(serverMatch()) });
    expect(en.chips().filter((c) => c === COPY.en.open)).toHaveLength(1);
  });

  it.each([
    ["the venue is not enabled", (m: any) => disabled(m, { enabled: false })],
    ["the venue is not active", (m: any) => disabled(m, { venue: { ...m.venueActivations[0].venue, active: false } })],
    ["there is no venue at all", (m: any) => disabled(m, { venue: null })],
    ["the offer is not available (no prizes, or a gap)", (m: any) => disabled(m, { offer: noOffer })],
    ["there is no offer", (m: any) => disabled(m, { offer: null })],
    ["there is no venue activation", (m: any) => ({ ...m, venueActivations: [] })],
    ["enabled is anything but true", (m: any) => disabled(m, { enabled: "true" })],
  ])("is NOT open when %s: it stays 'Aún no abierto'", async (_why, change) => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(change(serverMatch())) });
    expect(page.states()).toEqual(["next", "next", "next"]);
    expect(page.cardText()).not.toMatch(/Abierto para|Open to participate/);
    expect(page.statusLine()).toBe(COPY.es.statusNone);
  });

  it("CERRADO: the match has started (the server refuses from the instant of kickoff); FINALIZADO: the server has its result", async () => {
    const started = await loadLogic({ now: "2026-11-03T21:30:00Z", server: answer(serverMatch()) });
    expect(started.states().slice(0, 2)).toEqual(["closed", "closed"]); // both 20:00 UTC matches have started
    const finished = await loadLogic({ now: "2026-11-03T21:30:00Z", server: answer(serverMatch({ finalized: true, finalResult: { homeScore: 2, awayScore: 1 } })) });
    expect(finished.states().slice(0, 2)).toEqual(["final", "closed"]);
    expect(finished.chips().slice(0, 2)).toEqual([COPY.es.final, COPY.es.closed]);
    const en = await loadLogic({ lang: "en", now: "2026-11-03T21:30:00Z", server: answer(serverMatch({ finalized: true })) });
    expect(en.chips().slice(0, 2)).toEqual([COPY.en.final, COPY.en.closed]);
  });

  it("a match that has started is never 'open', even if the server still lists an enabled venue", async () => {
    const page = await loadLogic({ now: "2026-11-03T20:00:00Z", server: answer(serverMatch()) });
    expect(page.states()).not.toContain("open");
  });

  it("the state is judged again as time passes: a card left open moves from 'programada' to 'abierto' to 'cerrado' without a reload", async () => {
    const page = await loadLogic({ now: "2026-11-03T18:00:00Z", server: answer(serverMatch({ participationOpensAt: "2026-11-03T18:30:00.000Z" })) });
    const barca = () => page.items().find((el) => page.itemText(el).includes("FC Barcelona"))!.getAttribute("data-state");
    expect(barca()).toBe("scheduled");
    const api = page.win.UrbanoHomeUpcoming;
    const server = [serverMatch({ participationOpensAt: "2026-11-03T18:30:00.000Z" })];
    const at = (iso: string) => api.select(page.win.UrbanoUpcomingData.matches, server, Date.parse(iso), 5).find((s: any) => s.entry.home === "FC Barcelona").state;
    expect([at("2026-11-03T18:00:00Z"), at("2026-11-03T18:30:00Z"), at("2026-11-03T19:59:59Z"), at("2026-11-03T20:00:00Z")]).toEqual(["scheduled", "open", "open", "closed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Which server match counts: the same start, the same two teams
// ---------------------------------------------------------------------------------------------------------------------------------

describe("a server match counts only for the announced match it IS", () => {
  const api = (page: Home) => page.win.UrbanoHomeUpcoming;
  const entry = { ...SRC, id: "e", kickoffAt: "2026-11-03T20:00:00Z", home: "FC Barcelona", away: "Aston Villa", competition: "Champions League" };

  it("a rehearsal or test match with the same teams but ANOTHER start (even by a minute) does not change the card", async () => {
    for (const kickoffAt of ["2026-11-03T20:01:00.000Z", "2026-11-03T19:59:00.000Z", "2026-11-04T20:00:00.000Z", "2026-11-03T21:00:00.000Z"]) {
      const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ kickoffAt })) });
      expect(page.states(), kickoffAt).toEqual(["next", "next", "next"]); // the announcement is not tied to it: every row stays a preselection
      // ... but the sentence speaks about the SERVER's list, and that list does have a match that accepts participation: it says so (and points to the lineup, where that card is)
      expect(page.statusLine(), kickoffAt).toBe(COPY.es.statusOpen);
    }
  });

  it("a CANCELLED match of the same teams and start is not that match, and it is not an upcoming one either: its row LEAVES the list (it is neither an announcement nor an opening)", async () => {
    for (const cancelledAt of ["2026-11-02T10:00:00.000Z", "x"]) {
      const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ cancelledAt })) });
      expect(page.ids(), String(cancelledAt)).toEqual(["T-4", "T-5"]); // T-3 (FC Barcelona v Aston Villa) is the one that was cancelled (T-1 and T-2 have already left the list)
      expect(page.states(), String(cancelledAt)).toEqual(["next", "next"]);
      expect(page.statusLine(), String(cancelledAt)).toBe(COPY.es.statusNone);
      expect(page.items().map((li: any) => li.textContent).join(" "), String(cancelledAt)).not.toMatch(/Aston Villa|Cancelad|Cancelled/);
    }
    const alive = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ cancelledAt: null })) }); // control: the same match, not cancelled, opens it
    expect(alive.ids()).toEqual(["T-3", "T-4", "T-5"]);
    expect(alive.states().filter((s) => s === "open")).toHaveLength(1);
  });

  it("a match at the SAME start with other teams, or with only one of the two, does not change the card", async () => {
    for (const [home, away] of [["Rojo FC", "Azul FC"], ["FC Barcelona", "Azul FC"], ["Rojo FC", "Aston Villa"], ["Aston Villa", "FC Barcelona"]]) {
      const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ homeTeam: { name: home }, awayTeam: { name: away } })) });
      expect(page.states(), `${home} v ${away}`).toEqual(["next", "next", "next"]);
    }
  });

  it("another spelling of a club the crest registry knows is the same club ('Barcelona', 'Bayern Munich', 'Inter de Milán'); a name that merely CONTAINS another is not", async () => {
    const page = await loadLogic({ crests: true, now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ homeTeam: { name: "Barcelona" } })) }); // the registry of spellings is the crests module's
    expect(page.states().filter((s) => s === "open")).toHaveLength(1);
    const plain = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(serverMatch({ homeTeam: { name: "Barcelona" } })) }); // without that module only an exact name counts: it fails closed
    expect(plain.states().filter((s) => s === "open")).toHaveLength(0);
    expect(api(page).sameClub("Bayern Munich", "Bayern München")).toBe(true);
    expect(api(page).sameClub("Bayern Múnich", "Bayern München")).toBe(true);
    expect(api(page).sameClub("PSG", "Paris Saint-Germain")).toBe(true);
    expect(api(page).sameClub("Inter de Milán", "Inter")).toBe(true);
    expect(api(page).sameClub("Man City", "Manchester City")).toBe(true);
    expect(api(page).sameClub("Inter", "Inter Miami")).toBe(false);
    expect(api(page).sameClub("Barcelona 4f2a9c", "FC Barcelona")).toBe(false);
    expect(api(page).sameClub("", "FC Barcelona")).toBe(false);
    expect(api(page).findServerMatch(entry, [serverMatch({ homeTeam: { name: "Barça B" } })])).toBeNull();
  });

  it("a cancelled or malformed server row is ignored without an error", async () => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(null, 5, "x", { homeTeam: null }, { kickoffAt: "not a date", homeTeam: { name: "FC Barcelona" }, awayTeam: { name: "Aston Villa" } }) });
    expect(page.states()).toEqual(["next", "next", "next"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// One request, nothing sent, and every failure leaves "Aún no abierto"
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the card reads the server once, sends nothing, and fails closed", () => {
  it("makes exactly one request — GET of the public matches list, with no credentials and no body — and none when the language changes", async () => {
    const page = await loadLogic({ server: answer(serverMatch()) });
    expect(page.calls.map((c) => c.url)).toEqual([MATCHES_URL]);
    expect(Object.keys(page.calls[0]!.init).sort()).toEqual(["cache"]);
    expect(page.calls[0]!.init.cache).toBe("no-store");
    page.win.document.querySelector('[data-lang="en"], .lang-switch button:last-child')?.dispatchEvent(new page.win.Event("click", { bubbles: true }));
    await page.settle();
    expect(page.calls.filter((c) => c.url === MATCHES_URL)).toHaveLength(1);
  });

  it.each([
    ["the server answers 500", { status: 500, json: { error: "x" } } as Reply],
    ["the server answers 401", { status: 401, json: {} } as Reply],
    ["the answer is not the list", { status: 200, json: { matches: "no" } } as Reply],
    ["the answer has no body", { status: 200, json: null } as Reply],
    ["the network fails", "reject" as Reply],
    ["the answer is not JSON", "badjson" as Reply],
  ])("%s: every match stays 'Preselección', the sentence under the list is not shown, and nothing breaks", async (_why, server) => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server });
    expect(page.states()).toEqual(["next", "next", "next"]);
    expect(page.chips()).toEqual(Array(3).fill(COPY.es.next));
    expect(page.cardText()).not.toMatch(/Abierto para|Participación programada|Cerrado|Finalizado/);
    expect(page.statusHidden()).toBe(true);
    expect(page.statusLine()).toBe("");
    expect(page.part("#featured-lineup")).toBe(COPY.es.lineup);
    expect(page.part("#featured-past")).toBe(COPY.es.past);
    expect(page.consoleErrors).toEqual([]); // an unreadable list is not an error of the page: the card simply says less
    expect(page.pageErrors).toEqual([]);
    // the same with the real editorial list: five rows, all announced
    const real = await loadHome({ server });
    expect(real.states()).toEqual(Array(5).fill("next"));
    expect(real.statusHidden()).toBe(true);
  });

  it("a change of language redraws the list in place, in the other language, with no second copy of the card", async () => {
    const page = await loadLogic({ server: answer() });
    expect(page.doc.querySelectorAll("#featured-predictions")).toHaveLength(1);
    expect(page.doc.querySelectorAll("#upcoming-list .upcoming-item")).toHaveLength(5);
    page.win.UrbanoI18n.setLang("en");
    await page.settle();
    expect(page.doc.querySelectorAll("#featured-predictions")).toHaveLength(1);
    expect(page.doc.querySelectorAll("#upcoming-list .upcoming-item")).toHaveLength(5);
    expect(page.status()).toBe(COPY.en.pill);
    expect(page.chips()).toEqual(Array(5).fill(COPY.en.next));
    expect(page.part("#featured-lineup")).toBe(COPY.en.lineup);
    expect(page.part("#featured-past")).toBe(COPY.en.past);
    expect(page.statusLine()).toBe(COPY.en.statusNone);
  });

  it("a change of language redraws the date-only match in the other language too, still without an hour", async () => {
    const page = await loadHome();
    expect(page.times()[2]).toEqual(["tbc", "2026-11-19", "jue 19 nov · Horario por confirmar"]);
    page.win.UrbanoI18n.setLang("en");
    await page.settle();
    expect(page.times()[2]).toEqual(["tbc", "2026-11-19", "Thu, Nov 19 · Time to be confirmed"]);
    expect(page.items()).toHaveLength(5);
    expect(page.calls.filter((c) => c.url === MATCHES_URL)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// init: a list handed to it makes no request; stop() lets go of everything
// ---------------------------------------------------------------------------------------------------------------------------------

describe("init: a handed server list makes NO request, and stop() unsubscribes and clears the timer", () => {
  const NOW = () => Date.parse("2026-11-03T19:00:00Z");

  it("when serverMatches is an ARRAY the module makes no request at all (neither its own fetch nor the page's) and uses that list", async () => {
    const page = await loadHome();
    expect(page.calls).toHaveLength(1); // the page's own card asked once, as it does
    const own: string[] = [];
    const host = page.doc.createElement("ul");
    page.win.UrbanoHomeUpcoming.init({ host, data: FIXTURE, now: NOW, serverMatches: [serverMatch()], fetch: (u: string) => { own.push(u); return Promise.resolve({ status: 200, json: async () => ({ matches: [] }) }); }, refreshMs: 0 });
    const host2 = page.doc.createElement("ul");
    page.win.UrbanoHomeUpcoming.init({ host: host2, data: FIXTURE, now: NOW, serverMatches: [serverMatch()], refreshMs: 0 }); // no fetch given: it would use the page's
    await page.settle();
    expect(own).toEqual([]);
    expect(page.calls).toHaveLength(1);
    expect(host.querySelectorAll(".upcoming-item[data-state=open]")).toHaveLength(1); // the handed list is what decided it
    expect(host2.querySelectorAll(".upcoming-item[data-state=open]")).toHaveLength(1);
  });

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

  it("is in order of start, and every entry can be placed by the card's own timing (none is silently dropped)", async () => {
    const page = await loadHome();
    const api = page.win.UrbanoHomeUpcoming;
    const placed = data.matches.map((m) => api.timing(m));
    for (const [i, tm] of placed.entries()) expect(tm, data.matches[i]!.id).not.toBeNull();
    const starts = placed.map((tm: any) => tm.start as number);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(placed.map((tm: any) => tm.hasTime)).toEqual([true, true, false, true, true]);
    // and the page shows exactly this list, in this order
    expect(page.ids()).toEqual(data.matches.map((m) => m.id));
    expect(page.win.UrbanoUpcomingData.matches.map((m: Entry) => m.id)).toEqual(data.matches.map((m) => m.id));
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

describe("the hour a window opens: 'desde las 12:30' but 'desde la 1:15'", () => {
  const opens = async (participationOpensAt: string, now: string, lang: "es" | "en" = "es") => {
    const page = await loadLogic({ lang, now, server: answer(serverMatch({ participationOpensAt })) });
    return squash(page.qa("#upcoming-list .upcoming-opens")[0]?.textContent);
  };

  it.each([
    ["2026-11-03T18:30:00.000Z", "2026-11-03T16:00:00Z", "Participación desde las 12:30 p. m. (hora de Honduras)"],
    ["2026-11-03T19:15:00.000Z", "2026-11-03T16:00:00Z", "Participación desde la 1:15 p. m. (hora de Honduras)"],
    ["2026-11-03T19:59:00.000Z", "2026-11-03T16:00:00Z", "Participación desde la 1:59 p. m. (hora de Honduras)"],
    ["2026-11-03T07:05:00.000Z", "2026-11-03T06:30:00Z", "Participación desde la 1:05 a. m. (hora de Honduras)"],
    ["2026-11-03T17:45:00.000Z", "2026-11-03T16:00:00Z", "Participación desde las 11:45 a. m. (hora de Honduras)"],
    ["2026-11-03T08:00:00.000Z", "2026-11-03T06:30:00Z", "Participación desde las 2:00 a. m. (hora de Honduras)"],
    ["2026-11-03T06:10:00.000Z", "2026-11-03T05:30:00Z", "Participación desde las 12:10 a. m. (hora de Honduras)"],
  ])("Spanish: a window that opens at %s says «%s»", async (participationOpensAt, now, expected) => {
    expect(await opens(participationOpensAt, now)).toBe(expected);
  });

  it("English says the same in both cases ('from 1:15 p.m.', 'from 12:30 p.m.')", async () => {
    expect(await opens("2026-11-03T19:15:00.000Z", "2026-11-03T16:00:00Z", "en")).toBe("Participation from 1:15 p.m. (Honduras time)");
    expect(await opens("2026-11-03T18:30:00.000Z", "2026-11-03T16:00:00Z", "en")).toBe("Participation from 12:30 p.m. (Honduras time)");
  });
});

describe("the informational list fails alone: the rest of the Home page still draws", () => {
  const catalogCards = (page: Home) => page.qa("#experiences-carousel > *, #games-carousel > *, #minigames-grid > *").length;
  let reference: Promise<number> | null = null;
  const referenceCards = () => (reference ??= loadHome().then((p) => catalogCards(p)));

  it("if the list's own start throws, the catalogs are drawn as usual, the error is logged and nothing escapes the page", async () => {
    const expected = await referenceCards();
    expect(expected).toBeGreaterThan(0);
    const page = await loadHome({ tweak: (w) => { w.UrbanoHomeUpcoming.init = () => { throw new Error("boom"); }; } });
    expect(catalogCards(page)).toBe(expected);
    expect(page.consoleErrors.join(" ")).toMatch(/did not start/);
    expect(page.pageErrors).toEqual([]);
  });

  it.each([["an object", {}], ["a string", "abc"], ["a number", 5], ["null", null]])("an editorial container that is %s lists nothing (the 'preparing' row), draws the catalogs and logs no error", async (_why, matches) => {
    const expected = await referenceCards();
    const page = await loadHome({ data: { lastVerified: "x", matches } });
    expect(catalogCards(page)).toBe(expected);
    expect(page.part("#upcoming-list .upcoming-none")).toBe("Estamos preparando los próximos partidos.");
    expect(page.note().hidden).toBe(true);
    expect(page.pageErrors).toEqual([]);
  });

  it("the two lists of the card keep their list semantics even though their bullets are removed", () => {
    const { card } = staticPage();
    expect(card.querySelector("ul.ten-crests")!.getAttribute("role")).toBe("list");
    expect(card.querySelector("ul#upcoming-list")!.getAttribute("role")).toBe("list");
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

  it("a cancelled match is never the match an entry is tied to, even when it sits first in the list next to a live match of the same fixture: the live one decides the state (a cancelled twin that looked open must not open the row)", async () => {
    const page = await loadHome();
    const gone = cancelled({ matchId: "old" }); // enabled venue, available offer: it would read as OPEN if it were chosen
    const live = serverMatch({ matchId: "new", venueActivations: [{ venueActivationId: "va-2", enabled: true, venue: { venueId: "v1", name: "Sede", latitude: 14.1, longitude: -87.2, radiusMeters: 150, active: true }, prizeTiers: [], offer: { available: false, maxLevel: 0, levels: [], digest: null, problem: "NO_LEVELS" } }] });
    expect(api(page).findServerMatch(BARCA, [gone])).toBeNull();
    for (const list of [[gone, live], [live, gone]]) {
      expect(api(page).findServerMatch(BARCA, list)?.matchId, JSON.stringify(list.map((m: any) => m.matchId))).toBe("new");
      const rows = Array.from(api(page).select([BARCA], list, Date.parse("2026-11-03T12:00:00Z"), 5)) as any[];
      expect(rows.map((r) => [r.entry.id, r.state]), JSON.stringify(list.map((m: any) => m.matchId))).toEqual([["c", "next"]]); // the live match has no valid offer: not open
    }
    const shown = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(gone, live) });
    expect(shown.states()).toEqual(["next", "next", "next"]);
    expect(shown.ids()).toEqual(["T-3", "T-4", "T-5"]); // nothing left the list: the fixture exists
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

  it("on the card, the cancelled match's row is gone (not relabelled), the others keep their place and state, and the sentence still follows the server's list", async () => {
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(cancelled()) });
    expect(page.ids()).toEqual(["T-4", "T-5"]);
    expect(page.states()).toEqual(["next", "next"]);
    expect(page.statusLine()).toBe(COPY.es.statusNone);
    expect(page.cardText()).not.toMatch(/Aston Villa|Cancelad|Cancelled|Suspendid/i);
    expect(page.note().hidden).toBe(false);
    const withOpen = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(cancelled(), serverMatch({ matchId: "m-2", homeTeam: { name: "Atlético de Madrid" }, awayTeam: { name: "Bayern München" } })) });
    expect(withOpen.ids()).toEqual(["T-4", "T-5"]);
    expect(withOpen.states()).toEqual(["open", "next"]); // T-4 is open on the server's word; T-3 (cancelled) left
    expect(withOpen.statusLine()).toBe(COPY.es.statusOpen);
  });

  it("when every row is cancelled the card says it is preparing the next ones: no rows, no sentence, no note, no 'cancelled' label", async () => {
    const list = [cancelled({ matchId: "x3" }), cancelled({ matchId: "x4", homeTeam: { name: "Atlético de Madrid" }, awayTeam: { name: "Bayern München" } }), cancelled({ matchId: "x5", homeTeam: { name: "AEK Athens" }, awayTeam: { name: "Real Madrid" }, kickoffAt: "2026-11-04T17:45:00.000Z" })];
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server: answer(...list) });
    expect(page.items()).toHaveLength(0);
    expect(squash(page.q("#upcoming-list .upcoming-none")?.textContent)).toBe(COPY.es.none);
    expect(page.statusHidden()).toBe(true);
    expect(page.note().hidden).toBe(true);
    expect(page.cardText()).not.toMatch(/Cancelad|Cancelled/i);
  });

  it("the cancellation counts only once the server's list was READ: while it is read, or if it cannot be, every row stays announced (nothing is known)", async () => {
    for (const server of ["hang", "reject", "badjson", { status: 500, json: { error: "x" } }, { status: 200, json: {} }] as Reply[]) {
      const page = await loadLogic({ now: "2026-11-03T19:00:00Z", server });
      expect(page.ids(), JSON.stringify(server)).toEqual(["T-3", "T-4", "T-5"]);
      expect(page.statusLine(), JSON.stringify(server)).toBe("");
    }
  });

  it("the row is removed when the list arrives, without an error: it was announced first (from the editorial list) and leaves with what the server says", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await loadLogic({ now: "2026-11-03T19:00:00Z", tweak: (w) => { w.__gate = gate; } });
    expect(page.ids()).toEqual(["T-3", "T-4", "T-5"]);
    const painted = page.doc.createElement("ul");
    const handle = page.win.UrbanoHomeUpcoming.init({ host: painted, data: FIXTURE, now: () => Date.parse("2026-11-03T19:00:00Z"), refreshMs: 0, fetch: async () => { await gate; return { status: 200, json: async () => ({ matches: [cancelled()] }) }; } });
    expect(Array.from(painted.querySelectorAll(".upcoming-item")).map((e) => e.getAttribute("data-match"))).toEqual(["T-3", "T-4", "T-5"]);
    release();
    await waitFor(() => painted.querySelectorAll(".upcoming-item").length === 2);
    expect(Array.from(painted.querySelectorAll(".upcoming-item")).map((e) => e.getAttribute("data-match"))).toEqual(["T-4", "T-5"]);
    handle.stop();
    expect(page.pageErrors).toEqual([]);
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

  it("an hour with a source and a verification date is honoured: it is placed at that instant, it can be tied to the server, and the row carries both (data-source, data-verified)", async () => {
    const page = await loadHome();
    expect({ ...api(page).timing(GOOD) }).toEqual({ hasTime: true, start: Date.parse("2026-11-03T20:00:00Z"), leaves: Date.parse("2026-11-03T23:00:00Z") });
    const shown = await loadHome({ data: { matches: [GOOD] } });
    const row = shown.items()[0]!;
    expect(row.getAttribute("data-time")).toBe("set");
    expect(row.getAttribute("data-source")).toBe("UEFA (uefa.com), 21:00 hora de España");
    expect(row.getAttribute("data-verified")).toBe("2026-10-29");
    expect(squash(row.querySelector("time")!.textContent)).toMatch(/2:00 p\. m\./);
  });

  it.each([
    ["no source", { verifiedAt: "2026-10-29" }],
    ["an empty source", { source: "", verifiedAt: "2026-10-29" }],
    ["a blank source", { source: "   ", verifiedAt: "2026-10-29" }],
    ["a source that is not text", { source: 5, verifiedAt: "2026-10-29" }],
    ["no verification date", { source: "UEFA" }],
    ["a verification date that is not text", { source: "UEFA", verifiedAt: 20261029 }],
    ["a verification date in another format", { source: "UEFA", verifiedAt: "29-10-2026" }],
    ["a verification date with an hour", { source: "UEFA", verifiedAt: "2026-10-29T10:00:00Z" }],
    ["an impossible verification date", { source: "UEFA", verifiedAt: "2026-02-30" }],
    ["a verification date AFTER the match's Honduras day", { source: "UEFA", verifiedAt: "2026-11-04" }],
    ["neither", {}],
  ])("an hour with %s is not shown: the match keeps its Honduras date, says 'Horario por confirmar', and can never be tied to a server match", async (_why, fields) => {
    const page = await loadHome();
    const entry = { ...BASE, ...fields };
    expect({ ...api(page).timing(entry) }).toEqual({ hasTime: false, start: Date.parse("2026-11-03T06:00:00Z"), leaves: Date.parse("2026-11-04T06:00:00Z"), unsourced: true });
    const open = serverMatch();
    expect(api(page).findServerMatch(entry, [open])).toBeNull();
    expect({ ...api(page).deriveState(entry, open, Date.parse("2026-11-03T12:00:00Z")) }).toEqual({ state: "next", opensAt: null });
    const shown = await loadHome({ data: { matches: [entry] }, server: answer(open), now: "2026-11-03T12:00:00Z" });
    const row = shown.items()[0]!;
    expect(row.getAttribute("data-time")).toBe("tbc");
    expect(row.getAttribute("data-state")).toBe("next"); // even with the exact match open on the server: no hour that can be traced, no tie
    expect(row.querySelector("time")!.getAttribute("datetime")).toBe("2026-11-03");
    expect(squash(row.querySelector("time")!.textContent)).toBe("mar 3 nov · Horario por confirmar");
    expect(squash(row.querySelector("time")!.textContent)).not.toMatch(/\d:\d\d|a\. ?m\.|p\. ?m\./);
    expect(row.hasAttribute("data-source"), "an entry whose hour cannot be traced does not claim a source").toBe(false);
    expect(row.hasAttribute("data-verified")).toBe(false);
  });

  it("the day of the match, and the day before, are valid verification dates (a verification can be done the same day)", async () => {
    const page = await loadHome();
    for (const verifiedAt of ["2026-11-03", "2026-11-02", "2026-10-01"]) expect(api(page).timing({ ...BASE, source: "UEFA", verifiedAt }).hasTime, verifiedAt).toBe(true);
    // the Honduras day of a match late in the evening is the day before in UTC: 2026-11-20T01:30Z is Thursday 19 November in Honduras
    const late = { ...BASE, kickoffAt: "2026-11-20T01:30:00Z", source: "Liga", verifiedAt: "2026-11-19" };
    expect(api(page).timing(late).hasTime).toBe(true);
    expect(api(page).timing({ ...late, verifiedAt: "2026-11-20" }).hasTime).toBe(false);
  });

  it("an hour near midnight that is not traceable lands on the HONDURAS date, not the UTC one (01:30 UTC of the 20th is Thursday the 19th), and leaves at the end of that Honduras day", async () => {
    const entry = { ...BASE, kickoffAt: "2026-11-20T01:30:00Z" };
    const shown = await loadHome({ data: { matches: [entry] }, now: "2026-11-19T12:00:00Z" });
    expect(shown.times()).toEqual([["tbc", "2026-11-19", "jue 19 nov · Horario por confirmar"]]);
    const stays = await loadHome({ data: { matches: [entry] }, now: "2026-11-20T05:59:00Z" });
    expect(stays.ids()).toEqual(["h"]);
    const gone = await loadHome({ data: { matches: [entry] }, now: "2026-11-20T06:00:00Z" });
    expect(gone.ids()).toEqual([]);
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

  it("the page draws the four hours with their source and verification date, and the one without an hour (Motagua–Olimpia) with 'Horario por confirmar'; no row shows an hour that is not traceable", async () => {
    const page = await loadHome();
    for (const [index, entry] of data.matches.entries()) {
      const row = page.items()[index]!;
      expect(row.getAttribute("data-match")).toBe(entry.id);
      expect(row.getAttribute("data-source"), entry.id).toBe(entry.source);
      expect(row.getAttribute("data-verified"), entry.id).toBe(entry.verifiedAt);
      const text = squash(row.querySelector("time")!.textContent);
      if (entry.kickoffAt) { expect(row.getAttribute("data-time"), entry.id).toBe("set"); expect(text, entry.id).toMatch(/\d:\d\d (a|p)\. m\./); expect(text, entry.id).not.toContain(COPY.es.tbc); }
      else { expect(row.getAttribute("data-time"), entry.id).toBe("tbc"); expect(text, entry.id).toContain(COPY.es.tbc); }
    }
    expect(page.items().filter((el) => el.getAttribute("data-time") === "tbc").map((el) => el.getAttribute("data-match"))).toEqual(["N26-46"]);
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

  it("on a phone (max-width: 480px): the first three by date, the link says 'Ver los 5 partidos en la cartelera', and it still goes to the Score lineup", async () => {
    const m = media(true);
    const page = await loadHome({ tweak: m.tweak });
    expect(m.asked).toEqual(["(max-width: 480px)"]);
    expect(page.ids()).toEqual(FIVE_IDS.slice(0, 3));
    expect(page.teams()).toEqual(FIVE.slice(0, 3).map((t) => t.replace(" v ", " v ")));
    expect(squash(link(page).textContent)).toBe("Ver los 5 partidos en la cartelera");
    expect(link(page).getAttribute("data-i18n")).toBe("home.upcoming.playAll");
    expect(link(page).getAttribute("data-i18n-vars")).toBe('{"total":5}');
    expect(link(page).getAttribute("href")).toBe(LINEUP_PAGE);
    expect(page.note().hidden).toBe(false);
    expect(page.times().map((t) => t[0])).toEqual(["set", "set", "tbc"]); // Motagua–Olimpia (no hour) is the third: it is seen on a phone too
  });

  it("not a phone: all five, and the plain link 'Ver cartelera de Score'", async () => {
    const m = media(false);
    const page = await loadHome({ tweak: m.tweak });
    expect(page.ids()).toEqual(FIVE_IDS);
    expect(squash(link(page).textContent)).toBe(COPY.es.lineup);
    expect(link(page).getAttribute("data-i18n")).toBe("home.upcoming.play");
    expect(link(page).hasAttribute("data-i18n-vars")).toBe(false);
  });

  it("a browser with no matchMedia shows all five (nothing breaks)", async () => {
    const page = await loadHome({ tweak: (w) => { delete w.matchMedia; } });
    expect(page.ids()).toEqual(FIVE_IDS);
    expect(squash(link(page).textContent)).toBe(COPY.es.lineup);
    expect(page.consoleErrors).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });

  it("turning the phone redraws the list: five when it gets wider, three when it narrows again, with the link following", async () => {
    const m = media(true);
    const page = await loadHome({ tweak: m.tweak });
    expect(m.listeners.size).toBe(1);
    m.turn(false);
    expect(page.ids()).toEqual(FIVE_IDS);
    expect(squash(link(page).textContent)).toBe(COPY.es.lineup);
    m.turn(true);
    expect(page.ids()).toEqual(FIVE_IDS.slice(0, 3));
    expect(squash(link(page).textContent)).toBe("Ver los 5 partidos en la cartelera");
  });

  it("an old browser that only has addListener is handled too", async () => {
    const listeners = new Set<() => void>();
    const mq: any = { matches: true, addListener: (cb: () => void) => { listeners.add(cb); } };
    const page = await loadHome({ tweak: (w) => { w.matchMedia = () => mq; } });
    expect(page.ids()).toEqual(FIVE_IDS.slice(0, 3));
    mq.matches = false;
    Array.from(listeners).forEach((cb) => cb());
    expect(page.ids()).toEqual(FIVE_IDS);
  });

  it("in English the link says 'See all 5 matches in the fixtures', and a change of language while on a phone translates it in place (and the rows)", async () => {
    const m = media(true);
    const page = await loadHome({ lang: "en", tweak: m.tweak });
    expect(squash(link(page).textContent)).toBe("See all 5 matches in the fixtures");
    const node = link(page);
    page.win.UrbanoI18n.setLang("es");
    expect(link(page)).toBe(node);
    expect(squash(link(page).textContent)).toBe("Ver los 5 partidos en la cartelera");
    expect(page.chips()).toEqual(["Preselección", "Preselección", "Preselección"]);
  });

  it("with three or fewer matches in the list a phone shows them all and the plain link (nothing is hidden, so nothing is 'see all')", async () => {
    const m = media(true);
    const three = { matches: FIXTURE.matches.slice(2) };
    const page = await loadHome({ tweak: m.tweak, data: three, now: "2026-11-03T19:00:00Z" });
    expect(page.ids()).toEqual(["T-3", "T-4", "T-5"]);
    expect(squash(link(page).textContent)).toBe(COPY.es.lineup);
  });

  it("the three are the NEXT three: when the first leaves the list, the fourth comes up (and the count in the link follows the list)", async () => {
    const m = media(true);
    const page = await loadHome({ tweak: m.tweak, now: "2026-11-08T00:00:00Z" }); // Valencia–Real Madrid (7 Nov) has gone; Atlético–Barça (8 Nov) is next
    expect(page.ids()).toEqual(FIVE_IDS.slice(1, 4));
    expect(squash(link(page).textContent)).toBe("Ver los 4 partidos en la cartelera");
  });

  it("when what the server says changes the TOTAL but not the three shown (the fifth match is cancelled), the link follows the list: 'Ver los 4 partidos', and with only three left it is the plain link again", async () => {
    const m = media(true);
    const gone = (home: string, away: string, kickoffAt: string) => serverMatch({ matchId: `g-${home}`, cancelledAt: "2026-11-02T10:00:00.000Z", homeTeam: { name: home }, awayTeam: { name: away }, kickoffAt });
    const arsenal = gone("Arsenal", "Manchester City", "2026-11-29T16:30:00.000Z"), liverpool = gone("Liverpool", "Manchester United", "2026-11-22T16:30:00.000Z");
    const one = await loadHome({ tweak: m.tweak, server: answer(arsenal) });
    expect(one.ids()).toEqual(FIVE_IDS.slice(0, 3)); // the same three rows as before the server was read
    expect(squash(link(one).textContent)).toBe("Ver los 4 partidos en la cartelera");
    expect(link(one).getAttribute("data-i18n-vars")).toBe('{"total":4}');
    const two = await loadHome({ tweak: m.tweak, server: answer(arsenal, liverpool) });
    expect(two.ids()).toEqual(FIVE_IDS.slice(0, 3));
    expect(squash(link(two).textContent)).toBe(COPY.es.lineup); // three left and three shown: nothing is hidden, so nothing is "see all"
    expect(link(two).hasAttribute("data-i18n-vars")).toBe(false);
  });

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
