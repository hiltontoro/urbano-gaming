import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Home page's URBANO Score entry (historically "Soccer Predictions") is a NEUTRAL, STATIC LINK, and says only what is true.
 *
 * The shipped landing page (public/index.html) is parsed and run whole in jsdom. The featured card is a name ("URBANO Score"), its descriptor
 * ("Tus predicciones deportivas" / "Your sports predictions") and one link into URBANO Score ("Abrir URBANO Score" / "Open URBANO Score"). Since
 * the Founder's Home correction of 2026-10-29 it carries NO promotion: the El Clásico announcement (the next-match pill, the two crests, the
 * Barcelona–Madrid line, The Pub by Beer Box, the 25 October date, kick-off and stadium, the participation window and "Jugar ahora") expired with
 * the match and is gone from the markup, the Spanish fallback and both language tables. Nothing replaced it: no status pill, no event, no result,
 * no countdown and no claim that anything is open.
 *
 * The Home does NOT look at the public matches list (GET /api/gaming/predictions/matches) at all, so a past, test, rehearsal or open match in the
 * database can never turn the entry into anything else. What is actually open (or the honest "none yet") is shown by URBANO Score itself. Past
 * participations are not on this card: they have their own access, My profile → My participations.
 *
 * Limit, stated plainly: this entry says nothing about whether predictions are open, and hiding or showing a way in from this card is not a
 * closure of the predictions service. The Predictions page and its API keep working for whatever the database holds; this test pins what the
 * Home says and does, nothing more. (This is a transitional entry; it does not replace or cancel the separate November proposal for Home.)
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
// The shared language module the Home page loads. Spanish is the default; the English wording is asserted by loading the page in English.
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
const CRESTS_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoClubCrests.js"), "utf8");
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
      if (opts.crests) window.eval(CRESTS_SOURCE); // the crests module present on the page, to prove the Home does not use it
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

// The entry, word for word, in both languages (Spanish is the default).
const COPY = {
  es: { descriptor: "Tus predicciones deportivas", open: "Abrir URBANO Score" },
  en: { descriptor: "Your sports predictions", open: "Open URBANO Score" },
} as const;

/** Everything the expired El Clásico promotion said, in either language: the pill, the match, the crests' teams, the venue, the date, the hours, the stadium, the window and the old action. */
const EXPIRED_PROMOTION = /Pr[óo]ximo partido|Next match|Barcelona|Madrid|Cl[aá]sico|\bvs\b|The Pub|Beer Box|octubre|October|Camp Nou|Estadio|Stadium|\d{1,2}:\d{2}|🇭🇳|🇪🇸|Honduras|Espa[ñn]a|Spain|Ventana|window|Jugar ahora|Play now/i;
/** The language-table keys of that promotion: none may survive in the module, the Spanish fallback or the markup. */
const EXPIRED_KEYS = /home\.score\.(clasico|venue|when|window|next|stadium|play)\b/;

/** Everything a person could read as "you can take part now", or as a state of availability, in either language. */
const OPENING_LANGUAGE = /Entrar a|Enter URBANO|Enter Soccer|Abierto para|Open for predictions|Predictions are open|ya pod[ée]s predecir|you can (now )?predict|Hac[ée] tu predicci|Make your prediction|Live now|En vivo ahora|Predecí ahora|Predict now|Participá|Participate now/i;
const AVAILABILITY_LANGUAGE = /pr[óo]ximamente|coming soon|disponible|available|abiert[oa]s?\b|\bopen now\b|is open|are open|ya pod[ée]s|you can now|en vivo|\blive\b|cierra|closes|empieza|starts|hoy\b|today|ahora|\bnow\b/i;

function entry(page: Home) {
  return { title: page.part("h2"), descriptor: page.part(".featured-descriptor"), open: page.part("#featured-play") };
}

describe("the entry: what the card says, in both languages", () => {
  it.each(["es", "en"] as const)("%s: URBANO Score, its descriptor and the way into URBANO Score — and no other word", async (lang) => {
    const page = await loadHome(undefined, { lang });
    const c = COPY[lang];
    expect(entry(page)).toEqual({ title: "URBANO Score", descriptor: c.descriptor, open: c.open });
    expect(page.cardText()).toBe(`URBANO Score ${c.descriptor} ${c.open}`);
    expect(page.calls).toHaveLength(0); // it is text: nothing is requested to say it
  });

  it("is already complete before any script or request: the markup itself carries the Spanish entry and the language keys", () => {
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    const card = withoutScripts.slice(withoutScripts.indexOf('id="featured-predictions"'), withoutScripts.indexOf('<div class="section" id="experiences">'));
    for (const text of ["URBANO Score", COPY.es.descriptor, COPY.es.open]) expect(card).toContain(text);
    for (const key of ["home.score.descriptor", "home.score.open"]) expect(card).toContain(`data-i18n="${key}"`);
  });

  it("the expired El Clásico promotion is absent in Spanish, in English and in the Spanish fallback — rendered, in the markup, and in every language table", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.cardText(), lang).not.toMatch(EXPIRED_PROMOTION);
      expect(page.card().querySelectorAll(".status-pill, [id=featured-status], .featured-crests, .featured-crest, .featured-scope, .featured-when, .featured-window, time, [data-club], img, svg"), lang).toHaveLength(0);
    }
    // the card as written (raw markup, comments included) and the page's code
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="featured-predictions"'), INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    expect(card).not.toMatch(EXPIRED_PROMOTION);
    expect(CODE).not.toMatch(/Pr[óo]ximo partido|Next match|Jugar ahora|Play now|Camp Nou|Barcelona|Real Madrid|Cl[aá]sico|The Pub|25 de octubre|October 25|Ventana de participaci|Planned participation window/);
    expect(CODE).not.toMatch(EXPIRED_KEYS);
    // the Spanish fallback block: the new words are in it, the old ones are not
    const fallback = INDEX_HTML.match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/)![1];
    expect(fallback).toContain(`"home.score.descriptor": "${COPY.es.descriptor}"`);
    expect(fallback).toContain(`"home.score.open": "${COPY.es.open}"`);
    expect(fallback).not.toMatch(EXPIRED_KEYS);
    expect(fallback).not.toMatch(/Próximo partido|Jugar ahora|Camp Nou|Ventana de participaci|Vivilo en The Pub/);
    // the module: both languages carry the new words, neither carries the old keys or words
    expect(I18N_SOURCE).not.toMatch(EXPIRED_KEYS);
    expect(I18N_SOURCE).not.toMatch(/Próximo partido|Next match|Jugar ahora|Play now|Camp Nou|Ventana de participaci|Planned participation window|Vivilo en The Pub|Watch it at The Pub/);
    expect(I18N_SOURCE).toContain(`"home.score.descriptor": "${COPY.es.descriptor}"`);
    expect(I18N_SOURCE).toContain(`"home.score.descriptor": "${COPY.en.descriptor}"`);
    expect(I18N_SOURCE).toContain(`"home.score.open": "${COPY.es.open}"`);
    expect(I18N_SOURCE).toContain(`"home.score.open": "${COPY.en.open}"`);
  });

  it("draws no crest, even with the crests module on the page: the Home does not load it, does not call it and has no holder for it", async () => {
    expect(INDEX_HTML).not.toMatch(/urbanoClubCrests|UrbanoClubCrests|data-club|club-crest|featured-crest/);
    const with_ = await loadHome(undefined, { lang: "es", crests: true });
    const without = await loadHome(undefined, { lang: "es" });
    expect(with_.doc.querySelectorAll("img.club-crest, [data-club], [data-crest]")).toHaveLength(0); // (the header's brand mark is the only image the page draws up there)
    expect(with_.card().querySelectorAll("img, svg")).toHaveLength(0);
    expect(with_.card().outerHTML).toBe(without.card().outerHTML);
    expect(with_.calls).toHaveLength(0);
  });

  it("invents nothing in its place: no status pill, no event, result, date, countdown or availability, and nothing that reads as 'open now'", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await loadHome(undefined, { lang });
      expect(page.cardText(), lang).not.toMatch(OPENING_LANGUAGE);
      expect(page.cardText(), lang).not.toMatch(AVAILABILITY_LANGUAGE);
      expect(page.cardText(), lang).not.toMatch(/\d/); // no date, no time, no score, no count
      expect(page.card().querySelectorAll("[class*='status-'], [role=status], [aria-live], progress, meter"), lang).toHaveLength(0);
      expect(page.cardText(), lang).not.toMatch(/Finca|NFL|premio|prize|reward|patrocin|sponsor|gratis|free|L\.\s?\d|\$|HNL|USD|apuest|bet\b|wager/i);
    }
    // and there is no script that could add any of it later
    expect(CODE).not.toMatch(/featured-(status|note|history|match|action|when|window|scope)|match-slide|match-track/);
  });

  it("brings no club crest, photograph or player image: the card has no element image at all, its art is a CSS background", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="featured-predictions"'), INDEX_HTML.indexOf('<div class="section" id="experiences">'));
    expect(card).not.toMatch(/<img|<svg|<picture|<video|<canvas|<iframe|<object|<embed/i);
  });
});

describe("it links; it never opens", () => {
  it.each(["es", "en"] as const)("%s: one working link only — into URBANO Score — and no control, form or claim that anything is open", async (lang) => {
    const page = await loadHome(() => list(match()), { lang });
    await page.settle();
    expect(page.card().querySelectorAll("a")).toHaveLength(1);
    expect(page.card().querySelectorAll("button, form, input, select, textarea, [role=button], .featured-cta, #featured-action")).toHaveLength(0);
    const play = page.play()!;
    expect(play.getAttribute("href")).toBe(PREDICTIONS_PAGE);
    expect(play.textContent).toBe(COPY[lang].open);
    expect(page.cardText()).not.toMatch(OPENING_LANGUAGE);
    expect(page.doc.querySelector("#featured-status")).toBeNull(); // no status of any kind
  });

  it("the one link goes to a page that exists, and it is the only link to it on the Home", () => {
    expect(existsSync(path.join(process.cwd(), "public", PREDICTIONS_PAGE))).toBe(true);
    expect(INDEX_HTML.match(/href="\/soccer-predictions\.html"/g)).toHaveLength(1);
    const dom = new JSDOM(INDEX_HTML);
    const links = Array.from(dom.window.document.querySelectorAll('a[href="/soccer-predictions.html"]'));
    expect(links.map((a) => a.id)).toEqual(["featured-play"]);
    expect(links[0].closest("#featured-predictions")).not.toBeNull();
  });
});

describe("the Home does not look at the matches list, so no database content can change the entry", () => {
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
    const failed = await loadHome(() => "reject", { lang: "es" });
    await Promise.all([empty.settle(80), open.settle(80), test.settle(80), failed.settle(80)]);
    expect(open.card().outerHTML).toBe(empty.card().outerHTML);
    expect(test.card().outerHTML).toBe(empty.card().outerHTML);
    expect(failed.card().outerHTML).toBe(empty.card().outerHTML);
    expect(open.cardText()).not.toMatch(/Rojo|Azul|Copa Barrio|Prueba/);
    for (const page of [empty, open, test, failed]) page.win.close();
  });

  it("the page source does not name the predictions API at all (the comments that say so are not code)", () => {
    expect(CODE).not.toContain("/api/gaming/predictions");
    expect(CODE).not.toMatch(/openMatchFrom|showOpenPredictionsEntry|resolvePredictionsEntry|MATCHES_URL|featured-match|featured-action|match-slide|match-track/);
    expect(CODE).not.toMatch(/\.kickoffAt|venueActivations|cancelledAt|finalized/);
  });

  it("a change of language redraws the entry in place without a second copy and without any request", async () => {
    const page = await loadHome(() => list(match()), { lang: "es" });
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.doc.querySelectorAll("#featured-predictions")).toHaveLength(1);
    expect(entry(page)).toEqual({ title: "URBANO Score", descriptor: COPY.en.descriptor, open: COPY.en.open });
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(entry(page)).toEqual({ title: "URBANO Score", descriptor: COPY.es.descriptor, open: COPY.es.open });
    expect(page.calls).toEqual([]);
  });
});

describe("the rest of Home keeps its access and its states", () => {
  it("keeps the access of every card that has one, every other card informational, and Become a Host closed by default", async () => {
    const page = await loadHome(() => list());
    await page.settle();
    const titles = Array.from(page.doc.querySelectorAll(".exp-card h2, .exp-card h3")).map((h) => h.textContent);
    expect(titles).toEqual(["Costume contest", "URBANO Poker", "Trivia", "URBANO Rutas", "URBANO Towers", "Become a Host", "URBANO Competitions"]); // the Halloween announcement (static, an h2) comes first
    expect(Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.textContent).join(" ")).not.toMatch(/Level\s*33/i); // the retired card: its implementation and documentation are untouched, the Home card is gone
    const byTitle = (t: string) => Array.from(page.doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h2, h3")?.textContent === t) as HTMLElement;
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
