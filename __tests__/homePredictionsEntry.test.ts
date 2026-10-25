import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Home page's URBANO Score entry (historically "Soccer Predictions") is a STATIC ANNOUNCEMENT, and says only what is true.
 *
 * The shipped landing page (public/index.html) is parsed and run whole in jsdom. The featured card announces El Clásico (FC Barcelona, the home
 * team, and Real Madrid CF) at The Pub by Beer Box, with the stadium. It is informational: no match is created or read and it never says that predictions
 * for it are open. In particular the page does NOT look at the public matches list (GET /api/gaming/predictions/matches) at all, so a
 * past, test, rehearsal or open match in the database can never turn the announcement into an opening. Its one action, "Jugar ahora",
 * goes to URBANO Score, which is where the matches that are actually open (or the honest "none yet") are shown. Past participations are
 * not on this card: they have their own access, My profile → My participations.
 *
 * Limit, stated plainly: hiding the way in from this card is not a closure of the predictions service. The Predictions page and its API
 * keep working for whatever the database holds; this test pins what the Home says and does, nothing more.
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
// The shared language module the Home page loads. Spanish is the default; the English wording is asserted by loading the page in English.
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
const CRESTS_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoClubCrests.js"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";
const PREDICTIONS_PAGE = "/soccer-predictions.html";
// The page without its explanatory comments (they may legitimately name the matches list to say it is not read).
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

type Reply = { status: number; json?: unknown } | "reject";

interface Call { url: string; init: Record<string, any> }

async function loadHome(reply: () => Reply = () => ({ status: 200, json: { matches: [] } }), opts: { lang?: "es" | "en"; crests?: boolean } = {}) {
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
      if (opts.crests) window.eval(CRESTS_SOURCE);
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
    play: () => q("#featured-play") as HTMLAnchorElement | null,
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
    pill: "Próximo partido",
    clasico: "El Clásico: FC Barcelona vs. Real Madrid CF",
    venue: "Vivilo en The Pub by Beer Box",
    when: "Domingo 25 de octubre · 🇭🇳 2:00 p. m. · 🇪🇸 9:00 p. m.",
    stadium: "Estadio: Spotify Camp Nou",
    play: "Jugar ahora",
  },
  en: {
    pill: "Next match",
    clasico: "El Clásico: FC Barcelona vs. Real Madrid CF",
    venue: "Watch it at The Pub by Beer Box",
    when: "Sunday, October 25 · 🇭🇳 2:00 p.m. · 🇪🇸 9:00 p.m.",
    stadium: "Stadium: Spotify Camp Nou",
    play: "Play now",
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
    stadium: page.part(".featured-when span"),
    play: page.part("#featured-play"),
  };
}

describe("the announcement: what the card says, in both languages", () => {
  it.each(["es", "en"] as const)("%s: URBANO Score, El Clásico, The Pub by Beer Box, the verified date, the stadium and the way into URBANO Score", async (lang) => {
    const page = await loadHome(undefined, { lang });
    const c = COPY[lang];
    expect(announcement(page)).toEqual({ pill: c.pill, title: "URBANO Score", clasico: c.clasico, venue: c.venue, when: c.when, stadium: c.stadium, play: c.play });
  });

  it("is already complete before any script or request: the markup itself carries the Spanish announcement and the language keys", () => {
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    const card = withoutScripts.slice(withoutScripts.indexOf('id="featured-predictions"'), withoutScripts.indexOf('<div class="section" id="experiences">'));
    for (const text of [COPY.es.pill, "URBANO Score", COPY.es.clasico, COPY.es.venue, COPY.es.when, COPY.es.stadium, COPY.es.play]) expect(card).toContain(text);
    for (const key of ["home.score.next", "home.score.clasico", "home.score.venue", "home.score.when", "home.score.stadium", "home.score.play"]) expect(card).toContain(`data-i18n="${key}"`);
  });

  it("draws the two crests, home team first, as decoration the page script asks the central module for — and the card says exactly the same words without them", async () => {
    const withCrests = await loadHome(undefined, { lang: "es", crests: true });
    const keys = Array.from(withCrests.card().querySelectorAll(".featured-crests img")).map((img) => img.getAttribute("data-crest"));
    expect(keys).toEqual(["fc-barcelona", "real-madrid-cf"]);
    expect(withCrests.calls).toHaveLength(0); // the card still makes no request of its own
    const without = await loadHome(undefined, { lang: "es" });
    expect(without.card().querySelectorAll("img")).toHaveLength(0);
    expect(withCrests.cardText().replace(/\bvs\b/g, "").replace(/\s+/g, " ")).toBe(without.cardText().replace(/\bvs\b/g, "").replace(/\s+/g, " "));
    expect(announcement(withCrests)).toEqual(announcement(without));
  });

  it("announces the approved participation window as information — planned, 12:30 p. m. to 2:00 p. m. in Honduras — and says nothing that reads as 'open now'", async () => {
    const expected = { es: "Ventana de participación prevista: de 12:30 p. m. a 2:00 p. m. (hora de Honduras)", en: "Planned participation window: 12:30 p.m. to 2:00 p.m. (Honduras time)" } as const;
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.part(".featured-window")).toBe(expected[lang]);
      expect(page.calls).toHaveLength(0); // still no request: it is text, not a state read from anywhere
      expect(page.part(".featured-window")).not.toMatch(OPENING_LANGUAGE);
      expect(page.part(".featured-window")).not.toMatch(/abierta|abre ahora|open now|is open|opens now|ya podés|you can now/i);
    }
    // the window is 90 minutes before the planned start and closes at the start: 12:30 + 90 min = 2:00 p. m. in Honduras
    const iso = INDEX_HTML.match(/<time datetime="([^"]+)"/)![1];
    const honduras = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    expect(honduras(new Date(iso).getTime() - 90 * 60_000)).toBe("12:30");
    expect(honduras(new Date(iso).getTime())).toBe("14:00");
    // and it is part of the static markup before any script runs
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).toContain('<p class="featured-window" data-i18n="home.score.window">' + expected.es + "</p>");
  });

  it("states the moment once, machine-readable, and the visible times are that same moment: 20:00 UTC is 21:00 in Spain and 2:00 p. m. in Honduras on 25 October", () => {
    const iso = INDEX_HTML.match(/<time datetime="([^"]+)"/)![1];
    expect(iso).toBe("2026-10-25T20:00:00Z");
    const at = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    expect(at("Europe/Madrid")).toBe("25 October at 21:00"); // after the clocks go back that morning: CET, UTC+1
    expect(at("America/Tegucigalpa")).toBe("25 October at 14:00"); // Honduras keeps UTC-6 all year
    // the announcement is "🇭🇳 2:00 p. m. · 🇪🇸 9:00 p. m." (the flags name the two places; nothing else is added to it)
    expect(COPY.es.when).toBe("Domingo 25 de octubre · 🇭🇳 2:00 p. m. · 🇪🇸 9:00 p. m.");
    expect(COPY.en.when).toBe("Sunday, October 25 · 🇭🇳 2:00 p.m. · 🇪🇸 9:00 p.m.");
  });

  it("no longer says predictions are 'coming soon', no longer names who is home or visitor, and carries no link to past predictions", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.cardText()).not.toMatch(/próximamente|coming soon|es local|home team|visitante|visitor|anteriores|past predictions/i);
      expect(page.doc.querySelector("#featured-note, #featured-history")).toBeNull();
    }
  });

  it("names El Clásico's two sides as announced and nothing else: no other match, venue, sport, prize or sponsor", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.cardText()).not.toMatch(/Finca|NFL|premio|prize|reward|patrocin|sponsor|gratis|free|L\.\s?\d|\$|HNL|USD|apuest|bet\b|wager/i);
      expect(page.cardText().match(/Real Madrid/g)).toHaveLength(1); // the title line (the crests carry no text)
      expect(page.cardText().indexOf("FC Barcelona")).toBeLessThan(page.cardText().indexOf("Real Madrid CF")); // the home team first
      expect(page.cardText().match(/The Pub by Beer Box/g)).toHaveLength(1);
    }
  });

  it("brings no club crest, photograph or player image: the card has no element image at all, its art is a CSS background", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="featured-predictions"'), INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    expect(card).not.toMatch(/<img|<svg|<picture|<video|<canvas|<iframe|<object|<embed/i);
  });
});

describe("it announces; it never opens", () => {
  it.each(["es", "en"] as const)("%s: one action only — into URBANO Score — and no claim that predictions for El Clásico are open", async (lang) => {
    const page = await loadHome(() => list(match()), { lang });
    await page.settle();
    expect(page.card().querySelectorAll("a")).toHaveLength(1);
    expect(page.card().querySelectorAll("button, form, input, select, textarea, [role=button], .featured-cta, #featured-action")).toHaveLength(0);
    const play = page.play()!;
    expect(play.getAttribute("href")).toBe(PREDICTIONS_PAGE);
    expect(play.textContent).toBe(COPY[lang].play);
    expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
    expect(page.cardText()).not.toMatch(/predicci|prediction/i); // the card does not talk about the state of predictions at all
    expect(page.status()).toBe(COPY[lang].pill);
    expect(page.status()).not.toMatch(/Abierto|Open|Playtest|Destacado|Featured|Próximamente|Coming/);
  });

  it("the pill is about the match (it is the next one), not about predictions", async () => {
    const page = await loadHome(undefined, { lang: "es" });
    const pill = page.doc.querySelector("#featured-status") as HTMLElement;
    expect(pill.className).not.toContain("status-featured");
    expect(pill.getAttribute("data-i18n")).toBe("home.score.next");
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
    expect(announcement(page)).toEqual({ pill: COPY.en.pill, title: "URBANO Score", clasico: COPY.en.clasico, venue: COPY.en.venue, when: COPY.en.when, stadium: COPY.en.stadium, play: COPY.en.play });
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
    expect(titles).toEqual(["URBANO Poker", "Costume contest", "Trivia", "URBANO Rutas", "URBANO Towers", "Become a Host", "URBANO Competitions"]);
    expect(Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.textContent).join(" ")).not.toMatch(/Level\s*33/i); // the retired card: its implementation and documentation are untouched, the Home card is gone
    const byTitle = (t: string) => Array.from(page.doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h3")?.textContent === t) as HTMLElement;
    for (const [title, href] of [["Trivia", "/trivia-playtest.html"], ["URBANO Poker", "/host.html?experience=poker"]] as const) {
      expect(byTitle(title).getAttribute("href"), title).toBe(href);
      expect(byTitle(title).className).toContain("is-actionable");
    }
    for (const title of ["Costume contest", "URBANO Rutas", "URBANO Towers", "Become a Host", "URBANO Competitions"]) {
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
