import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Home page's URBANO Score entry (historically "Soccer Predictions") is a STATIC ANNOUNCEMENT, and says only what is true.
 *
 * The shipped landing page (public/index.html) is parsed and run whole in jsdom. The featured card announces El Clásico (Real Madrid and
 * Barcelona) at The Pub by Beer Box and says that predictions are coming soon. It is informational: no match is created or read, no way
 * to take part is offered, and it never says that predictions are open. In particular the page does NOT look at the public matches list
 * (GET /api/gaming/predictions/matches) at all, so a past, test or open match in the database can never turn the announcement into an
 * opening. The only link is to the member's past predictions and results, labelled as such.
 *
 * Limit, stated plainly: hiding the way in from this card is not a closure of the predictions service. The Predictions page and its API
 * keep working for whatever the database holds; this test pins what the Home says and does, nothing more.
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
// The shared language module the Home page loads. Spanish is the default; the English wording is asserted by loading the page in English.
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";
const PREDICTIONS_PAGE = "/soccer-predictions.html";
// The page without its explanatory comments (they may legitimately name the matches list to say it is not read).
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

type Reply = { status: number; json?: unknown } | "reject";

interface Call { url: string; init: Record<string, any> }

async function loadHome(reply: () => Reply = () => ({ status: 200, json: { matches: [] } }), opts: { lang?: "es" | "en" } = {}) {
  const calls: Call[] = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = { attachSignInButton: () => {} };
      window.localStorage.setItem("urbano.lang", opts.lang ?? "en");
      window.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped module is evaluated, as the script tag would
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        calls.push({ url: String(url), init });
        return (async () => {
          const out = reply();
          if (out === "reject") throw new TypeError("network failure");
          return { status: out.status, json: async () => out.json };
        })();
      };
    },
  });
  const doc = dom.window.document;
  const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  return {
    win: dom.window,
    doc,
    calls,
    settle: async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); },
    status: () => squash(q("#featured-status")?.textContent),
    note: () => squash(q("#featured-note")?.textContent),
    history: () => q("#featured-history") as HTMLAnchorElement | null,
    cardText: () => squash(q("#featured-predictions")?.textContent),
    card: () => q("#featured-predictions") as HTMLElement,
    part: (sel: string) => squash(q(`#featured-predictions ${sel}`)?.textContent),
  };
}
type Home = Awaited<ReturnType<typeof loadHome>>;

const HOUR = 3_600_000;
function match(overrides: Record<string, unknown> = {}) {
  return {
    matchId: "match-1",
    homeTeam: { teamId: "t1", name: "Rojo FC", players: [] },
    awayTeam: { teamId: "t2", name: "Azul FC", players: [] },
    competition: "Copa Barrio",
    kickoffAt: new Date(Date.now() + 36 * HOUR).toISOString(),
    cancelledAt: null,
    finalized: false,
    finalResult: null,
    venueActivations: [{ venueActivationId: "va-1", enabled: true, venue: { venueId: "v1", name: "Sede 1", latitude: 14.1, longitude: -87.2, radiusMeters: 150, active: true }, prizeTiers: [] }],
    ...overrides,
  };
}
const list = (...matches: unknown[]): Reply => ({ status: 200, json: { matches } });

// The announcement, word for word, in both languages (Spanish is the default).
const COPY = {
  es: {
    pill: "Próximamente",
    clasico: "El Clásico: Real Madrid vs. Barcelona",
    venue: "Vivilo en The Pub by Beer Box",
    when: "Domingo 25 de octubre · 2:00 p. m. (hora de Honduras) · 21:00 en España",
    sides: "Barcelona es local · Real Madrid, visitante",
    soon: "Predicciones próximamente",
    history: "Ver predicciones y resultados anteriores →",
  },
  en: {
    pill: "Coming Soon",
    clasico: "El Clásico: Real Madrid vs. Barcelona",
    venue: "Watch it at The Pub by Beer Box",
    when: "Sunday, October 25 · 2:00 p.m. (Honduras time) · 9:00 p.m. in Spain",
    sides: "Barcelona is the home team · Real Madrid, the visitor",
    soon: "Predictions coming soon",
    history: "See past predictions and results →",
  },
} as const;

/** Everything a person could read as "you can take part now", in either language. */
const OPENING_LANGUAGE = /Entrar a|Enter URBANO|Enter Soccer|Abierto para|Open for predictions|Predictions are open|ya pod[ée]s predecir|you can (now )?predict|Hac[ée] tu predicci|Make your prediction|Live now|En vivo ahora|Predecí ahora|Predict now|Participá|Participate now/i;

function announcement(page: Home) {
  return {
    pill: page.status(),
    title: page.part("h2"),
    clasico: page.part(".featured-descriptor"),
    venue: page.part(".featured-scope"),
    when: page.part(".featured-when time"),
    sides: page.part(".featured-when span"),
    soon: page.note(),
    history: page.part("#featured-history"),
  };
}

describe("the announcement: what the card says, in both languages", () => {
  it.each(["es", "en"] as const)("%s: URBANO Score, El Clásico, The Pub by Beer Box, the verified date and sides, and predictions coming soon", async (lang) => {
    const page = await loadHome(undefined, { lang });
    const c = COPY[lang];
    expect(announcement(page)).toEqual({ pill: c.pill, title: "URBANO Score", clasico: c.clasico, venue: c.venue, when: c.when, sides: c.sides, soon: c.soon, history: c.history });
  });

  it("is already complete before any script or request: the markup itself carries the Spanish announcement and the language keys", () => {
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    const card = withoutScripts.slice(withoutScripts.indexOf('id="featured-predictions"'), withoutScripts.indexOf('<div class="section" id="experiences">'));
    for (const text of [COPY.es.pill, "URBANO Score", COPY.es.clasico, COPY.es.venue, COPY.es.when, COPY.es.sides, COPY.es.soon, COPY.es.history]) expect(card).toContain(text);
    for (const key of ["home.pred.soon", "home.score.clasico", "home.score.venue", "home.score.when", "home.score.sides", "home.score.soon", "home.pred.historyPast"]) expect(card).toContain(`data-i18n="${key}"`);
  });

  it("states the moment once, machine-readable, and the visible times are that same moment: 20:00 UTC is 21:00 in Spain and 2:00 p. m. in Honduras on 25 October", () => {
    const iso = INDEX_HTML.match(/<time datetime="([^"]+)"/)![1];
    expect(iso).toBe("2026-10-25T20:00:00Z");
    const at = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    expect(at("Europe/Madrid")).toBe("25 October at 21:00"); // after the clocks go back that morning: CET, UTC+1
    expect(at("America/Tegucigalpa")).toBe("25 October at 14:00"); // Honduras keeps UTC-6 all year
    expect(COPY.es.when).toContain("2:00 p. m.");
    expect(COPY.es.when).toContain("21:00");
    expect(COPY.en.when).toContain("2:00 p.m.");
    expect(COPY.en.when).toContain("9:00 p.m.");
  });

  it("names El Clásico's two sides as announced and nothing else: no other match, venue, sport, prize or sponsor", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.cardText()).not.toMatch(/Finca|NFL|premio|prize|reward|patrocin|sponsor|gratis|free|L\.\s?\d|\$|HNL|USD|apuest|bet\b|wager/i);
      expect(page.cardText().match(/Real Madrid/g)).toHaveLength(2); // the title line and the sides line
      expect(page.cardText().match(/The Pub by Beer Box/g)).toHaveLength(1);
    }
  });

  it("brings no club crest, photograph or player image: the card has no element image at all, its art is a CSS background", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="featured-predictions"'), INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    expect(card).not.toMatch(/<img|<svg|<picture|<video|<canvas|<iframe|<object|<embed/i);
  });
});

describe("it announces; it never opens", () => {
  it.each(["es", "en"] as const)("%s: no way to take part, no opening language, no play button, one link only — to the past", async (lang) => {
    const page = await loadHome(() => list(match()), { lang });
    await page.settle();
    expect(page.card().querySelectorAll("a")).toHaveLength(1);
    expect(page.card().querySelectorAll("button, form, input, select, textarea, [role=button], .featured-cta, #featured-action")).toHaveLength(0);
    const history = page.history()!;
    expect(history.getAttribute("href")).toBe(PREDICTIONS_PAGE);
    expect(history.className).not.toContain("featured-cta");
    expect(history.textContent).toMatch(lang === "es" ? /anteriores/ : /past/); // identified as the past: never "my predictions", never "enter"
    expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
    expect(page.status()).toBe(COPY[lang].pill);
    expect(page.status()).not.toMatch(/Abierto|Open|Playtest|Destacado|Featured/);
  });

  it("the pill and the line under it are both about 'soon': the card is in the same Próximamente state as the other informational cards", async () => {
    const page = await loadHome(undefined, { lang: "es" });
    const pill = page.doc.querySelector("#featured-status") as HTMLElement;
    expect(pill.className).toContain("status-soon");
    expect(pill.className).not.toContain("status-featured");
    expect(pill.getAttribute("data-i18n")).toBe("home.pred.soon");
  });
});

describe("the Home does not look at the matches list, so no database content can change the announcement", () => {
  it("the page makes no request to the predictions API: not on first paint, not after, whatever the server would have said", async () => {
    const replies: Reply[] = [
      list(),
      list(match()), // an open match
      list(match({ matchId: "past", kickoffAt: new Date(Date.now() - 2 * HOUR).toISOString(), finalized: true })), // a past one
      list(match({ homeTeam: { name: "Prueba Uno" }, awayTeam: { name: "Prueba Dos" }, competition: "Partido de prueba" })), // a test one
      { status: 500, json: {} },
      "reject",
    ];
    for (const reply of replies) {
      const page = await loadHome(() => reply, { lang: "es" });
      await page.settle(80);
      expect(page.calls.filter((c) => c.url.includes("/api/gaming/predictions"))).toEqual([]);
      expect(page.calls).toEqual([]); // and no other request either: the Home's only network use is the shared sign-in module and the host-availability reader, which jsdom does not load
      page.win.close();
    }
  });

  it("the card is identical whatever the database holds: an open match, a historical one or none at all", async () => {
    const empty = await loadHome(() => list(), { lang: "es" });
    const open = await loadHome(() => list(match()), { lang: "es" });
    const test = await loadHome(() => list(match({ homeTeam: { name: "Prueba Uno" }, awayTeam: { name: "Prueba Dos" }, competition: "Partido de prueba" })), { lang: "es" });
    await Promise.all([empty.settle(80), open.settle(80), test.settle(80)]);
    expect(open.card().outerHTML).toBe(empty.card().outerHTML);
    expect(test.card().outerHTML).toBe(empty.card().outerHTML);
    expect(open.cardText()).not.toMatch(/Rojo|Azul|Copa Barrio|Prueba/);
    for (const page of [empty, open, test]) page.win.close();
  });

  it("the page source does not name the predictions API at all (the comments that say so are not code)", () => {
    expect(CODE).not.toContain("/api/gaming/predictions");
    expect(CODE).not.toMatch(/openMatchFrom|showOpenPredictionsEntry|resolvePredictionsEntry|MATCHES_URL|featured-match|featured-action|match-slide|match-track/);
    expect(CODE).not.toMatch(/\.kickoffAt|venueActivations|cancelledAt|finalized/);
  });

  it("a change of language redraws the announcement in place without a second copy and without any request", async () => {
    const page = await loadHome(() => list(match()), { lang: "es" });
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.doc.querySelectorAll("#featured-predictions")).toHaveLength(1);
    expect(announcement(page)).toEqual({ pill: COPY.en.pill, title: "URBANO Score", clasico: COPY.en.clasico, venue: COPY.en.venue, when: COPY.en.when, sides: COPY.en.sides, soon: COPY.en.soon, history: COPY.en.history });
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(page.part(".featured-scope")).toBe(COPY.es.venue);
    expect(page.calls).toEqual([]);
  });
});

describe("the rest of Home keeps its access and its states", () => {
  it("keeps the access of every card that has one, every other card informational, and Become a Host closed by default", async () => {
    const page = await loadHome(() => list());
    await page.settle();
    const titles = Array.from(page.doc.querySelectorAll(".exp-card h3")).map((h) => h.textContent);
    expect(titles).toEqual(["URBANO Poker", "Halloween", "Trivia", "URBANO Rutas", "URBANO Towers", "Become a Host", "URBANO Competitions"]);
    expect(Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.textContent).join(" ")).not.toMatch(/Level\s*33/i); // the retired card: its implementation and documentation are untouched, the Home card is gone
    const byTitle = (t: string) => Array.from(page.doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h3")?.textContent === t) as HTMLElement;
    for (const [title, href] of [["Trivia", "/trivia-playtest.html"], ["URBANO Poker", "/host.html?experience=poker"]] as const) {
      expect(byTitle(title).getAttribute("href"), title).toBe(href);
      expect(byTitle(title).className).toContain("is-actionable");
    }
    for (const title of ["Halloween", "URBANO Rutas", "URBANO Towers", "Become a Host", "URBANO Competitions"]) {
      expect(byTitle(title).className, title).toContain("is-locked");
      expect(byTitle(title).tagName, title).toBe("DIV"); // informational: no link, no operational action
      expect(byTitle(title).getAttribute("href"), title).toBeNull();
    }
    expect(page.doc.querySelector('a[href="/become-a-host.html"]')).toBeNull();
  });

  it("does not touch the entries of other products: no Race, Pulse, Competitions or Host request is made", async () => {
    const page = await loadHome(() => list(match()));
    await page.settle();
    expect(page.calls.map((c) => c.url)).toEqual([]);
  });
});
