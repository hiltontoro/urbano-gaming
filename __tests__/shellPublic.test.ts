import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The public shell in Spanish and English: the Home page (public/index.html) and the public URBANO Score journey
 * (public/soccer-predictions.html), each parsed and run whole in jsdom with the REAL shipped language module and stubbed network and
 * sign-in. No network, no credentials, no real mail.
 *
 * Proves: Spanish first, never from the browser; the visible ES/EN selector and its persistence (and the page working without storage);
 * the header (logo link, selector, account group), the footer (Powered by TecnoMovi) and the internal navigation; honest cards (what is
 * informational stays informational, Level 33 is gone, no card gains a new operational link); Predictions' dynamic states, validations and
 * known server errors in both languages, translated IN PLACE so what a person typed survives a change of language; and that language never
 * changes data, API requests or the time-zone policy.
 *
 * Limits, stated plainly: jsdom does not lay a page out, so "no overflow at 375 px" is pinned here as CSS contract only and measured in a
 * real browser separately. The scan for English left on a Spanish page is a HEURISTIC (a list of unambiguous English function words in
 * what is visible); it can miss English that uses none of them, and it is not a proof of absence.
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const PRED_HTML = readFileSync(path.join(ROOT, "public/soccer-predictions.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

interface StorageOpts { stored?: "es" | "en" | null; storage?: "ok" | "blocked" }

function prepareWindow(window: any, opts: StorageOpts) {
  if (opts.storage === "blocked") Object.defineProperty(window, "localStorage", { get() { throw new Error("storage blocked"); }, configurable: true });
  else if (opts.stored) window.localStorage.setItem("urbano.lang", opts.stored);
  // The browser says English; the page must ignore that.
  Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
  Object.defineProperty(window.navigator, "languages", { value: ["en-US"], configurable: true });
  window.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped module is evaluated, as the script tag would
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Heuristic: English function words that cannot be Spanish, looked for in everything a person can read or hear on the page.
// ---------------------------------------------------------------------------------------------------------------------------------
const ENGLISH_WORDS = /\b(the|and|your|you|you're|of|for|with|is|are|was|will|can|please|before|until|check|again|this|that|from|into|not|reload|sign|log|submit|update|loading|location|enable)\b/i;
function visibleStrings(doc: Document): string[] {
  const out: string[] = [];
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  for (const el of Array.from(doc.body.querySelectorAll("[aria-label],[placeholder],[title],[alt]"))) {
    for (const attr of ["aria-label", "placeholder", "title", "alt"]) { const v = el.getAttribute(attr); if (v) out.push(v); }
  }
  return out;
}
// A venue's own name is a proper noun, not a sentence: "The Pub by Beer Box" is written in English and stays so in Spanish.
const PROPER_NAMES = /The Pub by Beer Box/g;
const englishLeft = (doc: Document) => visibleStrings(doc).map((t) => t.replace(PROPER_NAMES, "")).filter((t) => ENGLISH_WORDS.test(t));

// ---------------------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------------------

function hostileSafeMatch(over: Record<string, unknown> = {}) {
  return {
    matchId: "m1", competition: "Liga Nacional", cancelledAt: null, finalized: false,
    kickoffAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    homeTeam: { name: "Alpha FC" }, awayTeam: { name: "Beta FC" },
    venueActivations: [{ enabled: true, venue: { active: true } }],
    ...over,
  };
}

async function loadHome(opts: StorageOpts & { matches?: unknown[] } = {}) {
  const attach: Array<{ button: any; status: any; options: any }> = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      prepareWindow(w, opts);
      w.UrbanoAuth = { attachSignInButton: (button: any, status: any, options: any) => { attach.push({ button, status, options }); } };
      w.fetch = async (url: string) => {
        if (String(url) === MATCHES_URL) return { status: 200, json: async () => ({ matches: opts.matches ?? [] }) };
        return { status: 404, json: async () => ({}) };
      };
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as any;
  const doc = win.document as Document;
  await tick();
  // (the Halloween announcement is a static card near the top, so its title is an h2; every catalog card's is an h3)
  const card = (title: string) => Array.from(doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h2, h3")?.textContent === title) as HTMLElement | undefined;
  return { win, doc, attach, card, text: (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim() };
}

describe("Home — Spanish first, never from the browser", () => {
  it("opens in Spanish for a browser that says English: <html lang>, hero, navigation, sections, footer and the featured entry", async () => {
    const page = await loadHome();
    expect(page.doc.documentElement.lang).toBe("es");
    expect(page.text(".hero h1")).toBe("Jugá, predecí y competí con tu comunidad.");
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.textContent)).toEqual(["Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios"]);
    expect(Array.from(page.doc.querySelectorAll(".section-label")).map((e) => e.textContent)).toEqual(["Destacado", "Experiencias", "Juegos de habilidad", "Minijuegos", "Para organizadores"]);
    expect(page.doc.querySelector("#featured-status")).toBeNull(); // no status pill: the "next match" pill went with the expired promotion, and nothing replaced it
    expect(page.text("#featured-title")).toBe("URBANO Score");
    expect(page.text(".featured-descriptor")).toBe("Tus predicciones deportivas");
    expect(page.text("#featured-play")).toBe("Abrir URBANO Score");
    expect(page.doc.querySelector(".featured-scope, .featured-when, .featured-window, .featured-crests")).toBeNull(); // no venue, date, window or crests
    expect(page.doc.querySelector("#featured-note")).toBeNull(); // no "predictions coming soon" line
    expect(page.doc.querySelector("#featured-history")).toBeNull(); // history has its own access (My profile)
    expect(page.text("footer")).toContain("URBANO Gaming — parte de URBANO");
  });

  it("the Spanish page leaves no English behind (heuristic scan of everything visible, cards included)", async () => {
    const page = await loadHome();
    expect(englishLeft(page.doc)).toEqual([]);
  });
});

describe("Home — the visible, accessible, remembered ES / EN selector", () => {
  it("is a labelled group of two real buttons; Spanish is pressed; both are in the tab order", async () => {
    const page = await loadHome();
    const group = page.doc.querySelector(".lang-switch")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Idioma");
    const buttons = Array.from(group.querySelectorAll("button")) as HTMLButtonElement[];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("data-lang"), b.getAttribute("aria-pressed"), b.type, b.tabIndex])).toEqual([
      ["ES", "es", "true", "button", 0], ["EN", "en", "false", "button", 0],
    ]);
    expect(buttons[1].getAttribute("aria-label")).toBe("Cambiar a inglés");
  });

  it("choosing English changes the page, the pressed state, <html lang> and the saved choice, and the cards are redrawn in English", async () => {
    const page = await loadHome();
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.doc.documentElement.lang).toBe("en");
    expect(page.win.localStorage.getItem("urbano.lang")).toBe("en");
    expect(page.text(".hero h1")).toBe("Play, predict, and compete with your community.");
    expect(page.doc.querySelector('[data-lang="en"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(page.doc.querySelector("#featured-status")).toBeNull();
    expect(page.card("URBANO Poker")!.textContent).toContain("Host a private No-Limit Hold'em table for your group.");
    expect(page.card("URBANO Poker")!.textContent).toContain("Host →");
    expect(page.card("Costume contest")!.textContent).toContain("Coming Soon");
    expect(page.text(".featured-descriptor")).toBe("Your sports predictions");
    expect(page.text("#featured-play")).toBe("Open URBANO Score");
    expect(page.doc.querySelector(".featured-scope, .featured-when, .featured-window, .featured-crests")).toBeNull();
    expect(page.text("footer")).toContain("URBANO Gaming — part of URBANO");
  });

  it("a saved choice is honoured on the next visit; without storage the page opens in Spanish and switching still works", async () => {
    const saved = await loadHome({ stored: "en" });
    expect(saved.doc.documentElement.lang).toBe("en");
    expect(saved.text(".hero h1")).toBe("Play, predict, and compete with your community.");
    const blocked = await loadHome({ storage: "blocked" });
    expect(blocked.doc.documentElement.lang).toBe("es");
    (blocked.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(blocked.text(".hero h1")).toBe("Play, predict, and compete with your community.");
  });
});

describe("Home — header and footer", () => {
  it("the URBANO mark and wordmark are one link to https://urbanohn.com/; the Gaming badge is a separate link back to this application", async () => {
    const page = await loadHome();
    const logo = page.doc.querySelector("a.brand-link") as HTMLAnchorElement;
    expect(logo.getAttribute("href")).toBe("https://urbanohn.com/");
    expect(logo.getAttribute("rel")).toContain("noopener");
    expect(logo.querySelector("img.brand-mark")).toBeTruthy();
    expect(logo.querySelector(".brand-word")!.textContent).toBe("URBANO");
    expect(logo.getAttribute("aria-label")).toBe("URBANO — ir a urbanohn.com");
    const badge = page.doc.querySelector("a.brand-badge") as HTMLAnchorElement;
    expect(badge.getAttribute("href")).toBe("/");
    expect(badge.textContent).toBe("Gaming");
    expect(logo.contains(badge)).toBe(false); // links are never nested
  });

  it("the footer reads Powered by TecnoMovi, and TecnoMovi (only) links to https://www.tecnomovi.com/", async () => {
    const page = await loadHome();
    const footer = page.doc.querySelector("footer")!;
    expect(footer.textContent!.replace(/\s+/g, " ")).toContain("Powered by TecnoMovi");
    const links = Array.from(footer.querySelectorAll("a"));
    // the only OUTSIDE link is TecnoMovi's; beside it, one internal link to the legal texts (the terms, the privacy notice and the rules)
    const outside = links.filter((a) => /^https?:/.test(a.getAttribute("href") ?? ""));
    expect(outside.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["TecnoMovi", "https://www.tecnomovi.com/"]]);
    expect(links.filter((a) => !outside.includes(a)).map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Términos, privacidad y reglas", "/legal.html"]]);
    expect(outside[0].getAttribute("rel")).toContain("noopener");
    // The footer line is not translated: it is a name, the same in both languages.
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(footer.textContent!.replace(/\s+/g, " ")).toContain("Powered by TecnoMovi");
  });

  it("name and Sign out live together in ONE group on the right, beside the selector; the shared component is handed exactly those elements", async () => {
    const page = await loadHome();
    const header = page.doc.querySelector("header.shell-header")!;
    const tools = header.querySelector(".header-tools")!;
    expect(header.firstElementChild!.classList.contains("brand")).toBe(true);
    expect(header.lastElementChild).toBe(tools);
    expect(Array.from(tools.children).map((c) => c.className)).toEqual(["lang-switch", "account-group"]);
    const group = tools.querySelector(".account-group")!;
    expect(Array.from(group.children).map((c) => c.id)).toEqual(["account-link", "btn-signin"]);
    expect(group.querySelector("#account-link")!.hasAttribute("hidden")).toBe(true); // nobody is signed in on first paint
    expect(page.attach).toHaveLength(1);
    expect(page.attach[0].button).toBe(page.doc.getElementById("btn-signin"));
    expect(page.attach[0].status).toBe(page.doc.getElementById("signin-status"));
    expect(page.attach[0].options.accountLink).toBe(page.doc.getElementById("account-link"));
    expect(page.doc.getElementById("account-link")!.getAttribute("href")).toBe("/profile.html");
  });

  it("keyboard order through the header: logo, Gaming, ES, EN, then the account control; the primary navigation follows and is labelled", async () => {
    const page = await loadHome();
    const focusable = Array.from(page.doc.querySelectorAll("header a[href], header button, nav a[href]")).filter((e) => !e.closest("[hidden]") && !(e as HTMLElement).hasAttribute("hidden"));
    expect(focusable.map((e) => e.getAttribute("aria-label") ?? e.textContent)).toEqual([
      "URBANO — ir a urbanohn.com", "URBANO Gaming — inicio", "Cambiar a español", "Cambiar a inglés", "Iniciar sesión / Crear cuenta",
      "Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios",
    ]);
    expect(page.doc.querySelector("nav.primary-nav")!.getAttribute("aria-label")).toBe("Navegación principal");
    expect(page.doc.querySelector('nav a[aria-current="page"]')!.textContent).toBe("Inicio");
  });

  it("the internal navigation still reaches the same places", async () => {
    const page = await loadHome();
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.getAttribute("href"))).toEqual(["/", "/#play", "/#experiences", "/leaderboards.html", "/rewards.html"]);
  });
});

describe("Home — honest cards", () => {
  it("the Founder's order; the playable cards keep their exact destinations; every other card is informational: no link, no operational action", async () => {
    const page = await loadHome();
    const cards = Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.querySelector("h2, h3")!.textContent);
    expect(cards).toEqual(["Concurso de disfraces", "URBANO Poker", "Trivia", "URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]); // the Halloween announcement first, near the top
    const actionable = Array.from(page.doc.querySelectorAll(".exp-card.is-actionable")).map((c) => [c.querySelector("h3")!.textContent, c.getAttribute("href")]);
    expect(actionable).toEqual([["URBANO Poker", "/host.html?experience=poker"], ["Trivia", "/trivia-playtest.html"]]);
    for (const title of ["Concurso de disfraces", "URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]) {
      const card = page.card(title)!;
      expect(card.tagName, title).toBe("DIV");
      expect(card.className, title).toContain("is-locked");
      expect(card.hasAttribute("href"), title).toBe(false);
      expect(card.querySelector("a, button"), title).toBeNull();
      expect(card.textContent, title).toContain("Próximamente");
    }
    // Quiz and Duel are not shown on the Home (their implementations are untouched); the Halloween announcement names voting only to say it is not available yet.
    expect(visibleStrings(page.doc).join(" ")).not.toMatch(/\bQuiz\b|\bDuel\b/);
    expect(page.doc.querySelector('a[href*="quiz"], a[href*="competitions"]')).toBeNull();
  });

  it("no card (and no link anywhere) points at Rutas, Towers, Race or Pulse: a page that merely answers is not evidence that a product is available", async () => {
    const page = await loadHome();
    expect(page.doc.querySelector('a[href*="rutas"], a[href*="towers"], a[href*="race"], a[href*="pulse"]')).toBeNull();
    expect(INDEX_HTML).not.toMatch(/rutas\.html|towers\.html|race\.html|pulse/i);
  });

  it("the retired Level 33 card is gone from the page and from every language, while Predictions stays the featured entry", async () => {
    const page = await loadHome();
    expect(Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.textContent).join(" ")).not.toMatch(/Level\s*33/i);
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(Array.from(page.doc.querySelectorAll(".exp-card")).map((c) => c.textContent).join(" ")).not.toMatch(/Level\s*33/i);
    expect(page.doc.querySelector("#featured-predictions h2")!.textContent).toBe("URBANO Score");
  });

  it("the Predictions entry is a neutral link in both languages and stays one even when the database holds an eligible match: no opening, no status, no match, no request", async () => {
    const page = await loadHome({ matches: [hostileSafeMatch()] });
    for (const [lang, descriptor, open] of [["es", "Tus predicciones deportivas", "Abrir URBANO Score"], ["en", "Your sports predictions", "Open URBANO Score"]] as const) {
      if (lang === "en") (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
      expect(page.doc.querySelector("#featured-status"), lang).toBeNull();
      expect(page.text(".featured-descriptor"), lang).toBe(descriptor);
      expect(page.text("#featured-play"), lang).toBe(open);
      expect(page.doc.querySelector("#featured-predictions a")!.getAttribute("href"), lang).toBe("/soccer-predictions.html");
      expect(page.doc.querySelector("#featured-action"), lang).toBeNull();
      expect(page.doc.querySelector("#featured-match"), lang).toBeNull();
      expect(page.doc.querySelectorAll("#featured-predictions a"), lang).toHaveLength(1);
      expect(page.text("#featured-predictions"), lang).not.toMatch(/Alpha FC|Beta FC|Liga Nacional|Abierto|Open for|Entrar|Enter URBANO/);
    }
  });

  it("no eligible match leaves the entry exactly the same in both languages: no status, no action, the one link", async () => {
    const page = await loadHome({ matches: [hostileSafeMatch({ finalized: true }), hostileSafeMatch({ cancelledAt: "2026-10-01T00:00:00Z" })] });
    expect(page.doc.querySelector("#featured-status")).toBeNull();
    expect(page.doc.querySelector("#featured-action a")).toBeNull();
    expect(page.text("#featured-play")).toBe("Abrir URBANO Score");
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.doc.querySelector("#featured-status")).toBeNull();
    expect(page.doc.querySelector("#featured-action a")).toBeNull();
    expect(page.text("#featured-play")).toBe("Open URBANO Score");
    expect(page.doc.querySelectorAll("#featured-predictions a")).toHaveLength(1);
  });
});

describe("Home — the layout contract for phones and tablets (CSS pinned here; measured in a real browser separately)", () => {
  const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
  const rule = (selector: string) => {
    const m = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : "";
  };

  it("the selector buttons are 44 px touch targets; the header wraps and its tools never exceed it; the name truncates, Sign out never wraps", () => {
    expect(rule(".lang-switch button")).toMatch(/min-height:\s*44px/);
    expect(rule(".lang-switch button")).toMatch(/min-width:\s*44px/);
    expect(rule(".header-tools")).toMatch(/max-width:\s*100%/);
    expect(rule(".account-group")).toMatch(/justify-content:\s*flex-end/);
    expect(rule(".account-group")).toMatch(/min-width:\s*0/);
    expect(rule(".signin-btn")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".account-group [data-urbano-signout]")).toMatch(/white-space:\s*nowrap/);
  });

  it("on phones the account group gets its own full-width row (right-aligned) so a real name has room; the brand and selector share row 1", () => {
    const start = css.indexOf("@media (max-width: 640px)");
    const phone = css.slice(start, css.indexOf("@media (max-width: 374px)"));
    expect(phone).toMatch(/\.header-tools\s*\{[^}]*display:\s*contents/);
    expect(phone).toMatch(/\.lang-switch\s*\{[^}]*margin-left:\s*auto/);
    expect(phone).toMatch(/\.account-group\s*\{[^}]*flex:\s*1 1 100%/);
    expect(rule(".account-group")).toMatch(/justify-content:\s*flex-end/);
    for (const file of ["public/soccer-predictions.html", "public/profile.html"]) {
      const other = readFileSync(path.join(ROOT, file), "utf8");
      expect(other, file).toMatch(/\.header-tools\s*\{\s*display:\s*contents;\s*\}/);
      expect(other, file).toMatch(/\.account-group\s*\{\s*flex:\s*1 1 100%;\s*\}/);
    }
  });

  it("every interactive control shows a visible keyboard focus", () => {
    expect(css).toMatch(/\.lang-switch button:focus-visible/);
    expect(css).toMatch(/\.brand-link:focus-visible/);
    expect(css).toMatch(/footer a:focus-visible/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Public URBANO Score journey (historically "Soccer Predictions": the route and the file keep that name)
// ---------------------------------------------------------------------------------------------------------------------------------

interface PredOpts extends StorageOpts {
  authenticated?: boolean | "incomplete";
  match?: Record<string, unknown>;
  mine?: Record<string, unknown>;
  position?: { latitude: number; longitude: number; accuracy: number } | null;
  predict?: { status: number; json: unknown };
  matchesFail?: boolean;
  noMatches?: boolean;
}

function predMatch(over: Record<string, unknown> = {}) {
  return {
    matchId: "m1", competition: "Liga Nacional", kickoffAt: new Date(Date.now() + 5 * 3600_000).toISOString(), cancelledAt: null, finalized: false,
    homeTeam: { teamId: "ta", name: "Alpha FC", players: [{ playerId: "p1", name: "Ana Díaz" }, { playerId: "p2", name: "Bob Stone" }] },
    awayTeam: { teamId: "tb", name: "Beta FC", players: [{ playerId: "p3", name: "Cleo Park" }] },
    venueActivations: [{
      venueActivationId: "act-1", enabled: true,
      venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true },
      prizeTiers: [{ prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: "Pitcher gratis" }],
    }],
    ...over,
  };
}

async function loadPredictions(opts: PredOpts = {}) {
  const posts: Array<{ url: string; body: any }> = [];
  const matches = opts.noMatches ? [] : [predMatch(opts.match)];
  const identity = opts.authenticated === false ? { status: "unauthenticated" } : opts.authenticated === "incomplete" ? { status: "profile_incomplete" } : { status: "authenticated", email: "m@example.com", gamingMemberId: "m-1", displayName: "Member" };
  const attach: Array<{ button: any; status: any; options: any }> = [];
  const dom = new JSDOM(PRED_HTML, {
    url: "http://localhost/soccer-predictions.html", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      prepareWindow(w, opts);
      const position = opts.position === undefined ? { latitude: 14.07, longitude: -87.19, accuracy: 8 } : opts.position;
      Object.defineProperty(w.navigator, "geolocation", {
        configurable: true,
        value: { getCurrentPosition: (ok: (p: unknown) => void, fail: () => void) => (position ? ok({ coords: { latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy } }) : fail()) },
      });
      w.UrbanoAuth = {
        attachSignInButton: (button: any, status: any, options: any) => { attach.push({ button, status, options }); },
        getState: async () => identity,
        getAccessToken: async () => "stub-token",
        onAuthStateChange: async () => () => {},
        onIdentityChange: async () => () => {},
        openSignIn: () => true,
        consumeIntent: () => null,
      };
      w.fetch = async (url: string, init?: any) => {
        const target = String(url);
        if (init?.method === "POST") {
          posts.push({ url: target, body: JSON.parse(init.body) });
          const out = opts.predict ?? { status: 201, json: { prediction: { predictionId: "pr1" } } };
          return { status: out.status, json: async () => out.json };
        }
        if (target === "/api/gaming/predictions/matches") {
          if (opts.matchesFail) throw new TypeError("network");
          return { status: 200, json: async () => ({ matches: JSON.parse(JSON.stringify(matches)) }) };
        }
        if (target.endsWith("/mine")) return { status: 200, json: async () => JSON.parse(JSON.stringify(opts.mine ?? {})) };
        return { status: 404, json: async () => ({}) };
      };
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as any;
  const doc = win.document as Document;
  for (let i = 0; i < 100 && !doc.querySelector("#content .card, #content .empty-state:not([data-i18n='pred.loading'])"); i += 1) await tick(5);
  await tick(20);
  const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  const text = (sel: string) => (q(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const en = () => (q('[data-lang="en"]') as HTMLElement).click();
  const es = () => (q('[data-lang="es"]') as HTMLElement).click();
  return { win, doc, q, text, en, es, posts, attach };
}

describe("Predictions — Spanish first, header, footer and navigation", () => {
  it("opens in Spanish; <html lang>, title, navigation, back link, footer", async () => {
    const page = await loadPredictions({ authenticated: false });
    expect(page.doc.documentElement.lang).toBe("es");
    expect(page.doc.title).toBe("URBANO Score — URBANO Gaming");
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.textContent)).toEqual(["Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios"]);
    expect(page.text(".back-link")).toBe("← Volver a URBANO Gaming");
    expect(page.q(".back-link")!.getAttribute("href")).toBe("/");
    expect(page.doc.querySelector("a.brand-link")!.getAttribute("href")).toBe("https://urbanohn.com/");
    expect(page.doc.querySelector('footer a[href^="https://"]')!.getAttribute("href")).toBe("https://www.tecnomovi.com/");
    expect(page.doc.querySelector('footer a[href="/legal.html"]')).not.toBeNull();
    expect(page.text("footer")).toContain("Powered by TecnoMovi");
    expect(page.attach[0].options.accountLink).toBe(page.doc.getElementById("account-link"));
    expect(Array.from(page.doc.querySelectorAll(".lang-switch button")).map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("the selector works and is remembered here too", async () => {
    const page = await loadPredictions({ authenticated: false });
    page.en();
    expect(page.doc.documentElement.lang).toBe("en");
    expect(page.win.localStorage.getItem("urbano.lang")).toBe("en");
    expect(page.text(".back-link")).toBe("← Back to URBANO Gaming");
    const saved = await loadPredictions({ authenticated: false, stored: "en" });
    expect(saved.text(".back-link")).toBe("← Back to URBANO Gaming");
    const blocked = await loadPredictions({ authenticated: false, storage: "blocked" });
    expect(blocked.text(".back-link")).toBe("← Volver a URBANO Gaming");
  });
});

describe("Predictions — signed out and unfinished account", () => {
  it("signed out: the Spanish prompt and action, translated IN PLACE when the language changes (the same button, not a new one)", async () => {
    const page = await loadPredictions({ authenticated: false });
    const button = page.q("[data-login-cta]")!;
    expect(button.textContent).toBe("Iniciar sesión o crear cuenta");
    expect(page.text("#content .msg")).toBe("Iniciá sesión o creá una cuenta para hacer tu predicción.");
    page.en();
    expect(page.q("[data-login-cta]")).toBe(button);
    expect(button.textContent).toBe("Log in or create account");
    expect(page.text("#content .msg")).toBe("Log in or create an account to make your prediction.");
  });

  it("an unfinished account gets the 'one more step' wording", async () => {
    const page = await loadPredictions({ authenticated: "incomplete" });
    expect(page.q("[data-login-cta]")!.textContent).toBe("Terminá de crear tu cuenta");
    expect(page.text("#content .msg")).toContain("Un paso más");
  });

  it("empty and failed states are in the chosen language", async () => {
    const empty = await loadPredictions({ authenticated: false, noMatches: true });
    expect(empty.text("#content .empty-state")).toBe("Todavía no hay partidos abiertos para predicciones — volvé pronto.");
    empty.en();
    expect(empty.text("#content .empty-state")).toBe("No matches are open for prediction yet — check back soon.");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await loadPredictions({ authenticated: false, matchesFail: true });
    expect(failed.text("#content .empty-state")).toBe("No pudimos cargar los partidos. Recargá la página para intentar de nuevo.");
    failed.en();
    expect(failed.text("#content .empty-state")).toBe("Couldn't load the matches. Reload the page to try again.");
  });
});

describe("Predictions — the open form", () => {
  it("every label, option, placeholder, hint and button is Spanish; names (teams, players, venue, competition) are untouched data", async () => {
    const page = await loadPredictions();
    const labels = Array.from(page.doc.querySelectorAll("form label")).map((l) => l.textContent);
    expect(labels).toEqual(["Sede", "Marcador exacto", "¿Quién va a marcar?", "¿En qué minuto se marcará algún gol?", "¿Quién marca primero?"]);
    expect(page.text("form select option[value='']")).toBe("Sin goleador / Sin gol");
    expect((page.q('input[id^="goal-minute-regulation"]') as HTMLInputElement).placeholder).toBe("Sin gol — dejalo en blanco");
    expect((page.q('input[id^="goal-minute-stoppage"]') as HTMLInputElement).placeholder).toBe("agregado");
    expect(page.text('[id^="goal-minute-hint"]')).toBe("El tiempo agregado solo aplica en el minuto 45 o 90.");
    expect(Array.from(page.doc.querySelectorAll(".team-toggle")).map((b) => b.textContent)).toEqual(["Alpha FC", "Beta FC", "Sin gol"]);
    expect(page.text('button[type="submit"]')).toBe("Enviar predicción");
    expect(page.text("#content .match-meta span:first-child")).toBe("Liga Nacional");
    expect(page.text("#venue-select-m1")).toBe("Beer Box");
    expect(Array.from(page.doc.querySelectorAll("#goalscorer-select-m1 option")).map((o) => o.textContent)).toEqual(["Sin goleador / Sin gol", "Ana Díaz", "Bob Stone", "Cleo Park"]);
    expect(page.text('[id^="geo-status"]')).toBe("Tu navegador indica que estás dentro del alcance de esta sede. El servidor lo confirma al enviar.");
    expect(englishLeft(page.doc)).toEqual([]);
  });

  it("outside the venue's range, and with no location at all, say so in Spanish", async () => {
    expect((await loadPredictions({ position: { latitude: 14.5, longitude: -87.5, accuracy: 5 } })).text('[id^="geo-status"]')).toBe("Tu navegador indica que estás fuera del alcance de esta sede; al enviar, el servidor decide.");
    const none = await loadPredictions({ position: null });
    expect(none.text('[id^="geo-status"]')).toBe("Ubicación no disponible — activá el acceso a la ubicación para enviar una predicción.");
    none.en();
    expect(none.text('[id^="geo-status"]')).toBe("Location unavailable — enable location access to submit a prediction.");
  });

  it("changing language redraws the form IN PLACE: the same inputs, with everything the person already typed or chose", async () => {
    const page = await loadPredictions();
    const home = page.q('input[id^="home-score"]') as HTMLInputElement;
    const minute = page.q('input[id^="goal-minute-regulation"]') as HTMLInputElement;
    const scorer = page.q('select[id^="goalscorer"]') as HTMLSelectElement;
    const submit = page.q('button[type="submit"]') as HTMLButtonElement;
    home.value = "3"; minute.value = "45"; minute.dispatchEvent(new page.win.Event("input", { bubbles: true })); scorer.value = "p2";
    (page.doc.querySelector('.team-toggle[data-value="AWAY"]') as HTMLElement).click();
    page.en();
    expect(page.q('input[id^="home-score"]')).toBe(home);
    expect(page.q('button[type="submit"]')).toBe(submit);
    expect([home.value, minute.value, scorer.value]).toEqual(["3", "45", "p2"]);
    expect(page.q(".team-toggle.is-selected")!.getAttribute("data-value")).toBe("AWAY");
    expect(Array.from(page.doc.querySelectorAll("form label")).map((l) => l.textContent)).toEqual(["Venue", "Exact score", "Who will score?", "At what minute will any goal be scored?", "Who scores first?"]);
    expect(submit.textContent).toBe("Submit Prediction");
    expect(minute.placeholder).toBe("No Goal — leave blank");
    expect(Array.from(page.doc.querySelectorAll(".team-toggle")).map((b) => b.textContent)).toEqual(["Alpha FC", "Beta FC", "No Goal"]);
  });

  it("an existing prediction's form says 'Actualizar predicción' and keeps its values", async () => {
    const page = await loadPredictions({ mine: { prediction: { predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: "p1", predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", venueActivationId: "act-1" } } });
    expect(page.text('button[type="submit"]')).toBe("Actualizar predicción");
    expect((page.q('input[id^="home-score"]') as HTMLInputElement).value).toBe("2");
  });
});

describe("Predictions — submitting: what is sent never depends on the language; what is said does", () => {
  const submit = async (page: Awaited<ReturnType<typeof loadPredictions>>) => {
    (page.q("form") as HTMLFormElement).dispatchEvent(new page.win.Event("submit", { bubbles: true, cancelable: true }));
    await tick(40);
  };

  it("the request body is identical in Spanish and English (identifiers and values are never translated)", async () => {
    const make = async (lang: "es" | "en") => {
      const page = await loadPredictions({ stored: lang });
      (page.q('input[id^="home-score"]') as HTMLInputElement).value = "2";
      (page.q('input[id^="away-score"]') as HTMLInputElement).value = "1";
      (page.q('select[id^="goalscorer"]') as HTMLSelectElement).value = "p1";
      (page.q('input[id^="goal-minute-regulation"]') as HTMLInputElement).value = "30";
      (page.doc.querySelector('.team-toggle[data-value="HOME"]') as HTMLElement).click();
      await submit(page);
      return page.posts;
    };
    const [es, en] = [await make("es"), await make("en")];
    expect(es).toHaveLength(1);
    expect(es).toEqual(en);
    expect(Object.keys(es[0].body).sort()).toEqual(["accuracyMeters", "latitude", "longitude", "predictedAwayScore", "predictedFirstTeamToScore", "predictedGoalMinuteRegulation", "predictedGoalMinuteStoppage", "predictedGoalscorerPlayerId", "predictedHomeScore", "venueActivationId"]);
    expect(es[0].body).toMatchObject({ predictedFirstTeamToScore: "HOME", predictedGoalscorerPlayerId: "p1", venueActivationId: "act-1" });
    expect(es[0].url).toBe("/api/gaming/predictions/matches/m1/predict");
  });

  it("'No Goal' still sends null in Spanish (the label changes, the value does not)", async () => {
    const page = await loadPredictions();
    (page.doc.querySelector('.team-toggle[data-value=""]') as HTMLElement).click();
    await submit(page);
    expect(page.posts[0].body.predictedFirstTeamToScore).toBeNull();
  });

  it("success: 'Predicción guardada…', redrawn in English when the language changes", async () => {
    const page = await loadPredictions();
    await submit(page);
    expect(page.text('[id^="submit-msg"]')).toBe("Predicción guardada. Podés editarla hasta el inicio del partido.");
    expect(page.q('[id^="submit-msg"]')!.className).toContain("success");
    page.en();
    expect(page.text('[id^="submit-msg"]')).toBe("Prediction saved. You can edit it until kickoff.");
  });

  it("without a location the submit is refused locally, in the chosen language, and nothing is sent", async () => {
    const page = await loadPredictions({ position: null });
    await submit(page);
    expect(page.posts).toHaveLength(0);
    expect(page.text('[id^="submit-msg"]')).toBe("Se requiere tu ubicación para enviar una predicción.");
  });

  it("known server errors are translated; the same text is what the server sent in English", async () => {
    const cases: Array<[string, string, string]> = [
      ["Predictions are locked for this match.", "Las predicciones están cerradas para este partido.", "Predictions are locked for this match."],
      ["This match has been cancelled.", "Este partido fue cancelado.", "This match has been cancelled."],
      ["Submission failed geolocation eligibility.", "El envío no cumplió los requisitos de ubicación.", "Submission failed geolocation eligibility."],
      ["A valid Authorization header for an authenticated Gaming Member is required.", "Necesitás iniciar sesión como miembro de URBANO Gaming para hacer esto.", "A valid Authorization header for an authenticated Gaming Member is required."],
    ];
    for (const [server, spanish, english] of cases) {
      const page = await loadPredictions({ predict: { status: 409, json: { error: server } } });
      await submit(page);
      expect(page.text('[id^="submit-msg"]'), server).toBe(spanish);
      expect(page.q('[id^="submit-msg"]')!.className).toContain("error");
      page.en();
      expect(page.text('[id^="submit-msg"]'), server).toBe(english);
    }
  });

  it("an unknown server message is never guessed at: generic Spanish in Spanish, as received in English, and it follows a change of language", async () => {
    const page = await loadPredictions({ predict: { status: 500, json: { error: "Some brand-new server message nobody mapped." } } });
    await submit(page);
    expect(page.text('[id^="submit-msg"]')).toBe("No pudimos guardar tu predicción. Intentá de nuevo.");
    page.en();
    expect(page.text('[id^="submit-msg"]')).toBe("Some brand-new server message nobody mapped.");
    page.es();
    expect(page.text('[id^="submit-msg"]')).toBe("No pudimos guardar tu predicción. Intentá de nuevo.");
  });

  it("a failed request with no message at all says 'No se pudo enviar la predicción.'", async () => {
    const page = await loadPredictions({ predict: { status: 500, json: null } });
    await submit(page);
    expect(page.text('[id^="submit-msg"]')).toBe("No se pudo enviar la predicción.");
  });
});

describe("Predictions — results, prizes and times", () => {
  const FINAL = { finalized: true, finalResult: { homeScore: 2, awayScore: 1 }, kickoffAt: "2026-10-24T20:00:00.000Z" };
  const MINE = {
    prediction: { predictionId: "pr1", predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: "p1", predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", venueActivationId: "act-1" },
    evaluation: { evaluationId: "e1", scorelineCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: false, firstTeamToScoreCorrect: false, correctDimensionCount: 2 },
    qualification: { prizeQualificationId: "q1", venueActivationId: "act-1", prizeTierId: "tier-2", redeemedAt: null, supersededAt: null, alreadyDelivered: false, underReview: false },
  };

  it("the finalized recap in Spanish; data stays data; the dynamic parts are re-translated in place", async () => {
    const page = await loadPredictions({ match: FINAL, mine: MINE });
    expect(page.text("#content .status-pill")).toBe("Resultado: 2–1");
    expect(Array.from(page.doc.querySelectorAll(".dimension-cell .label")).map((e) => e.textContent)).toEqual(["Marcador", "Goleador", "Minuto del gol", "Primer anotador"]);
    expect(page.doc.body.textContent).toContain("2 de 4 correctas.");
    expect(page.text("[data-prize-slot]")).toBe("Premio obtenido: Pitcher gratis — todavía sin canjear — consultá con un anfitrión de URBANO.");
    expect(page.doc.body.textContent).toContain("Tu predicción: 2–1, Ana Díaz, 30', primero: Alpha FC");
    expect(englishLeft(page.doc)).toEqual([]);
    page.en();
    expect(page.text("#content .status-pill")).toBe("Result: 2–1");
    expect(page.text("[data-prize-slot]")).toBe("Prize qualified: Pitcher gratis — not yet redeemed — see an URBANO host.");
    expect(page.doc.body.textContent).toContain("Your prediction: 2–1, Ana Díaz, 30', first: Alpha FC");
  });

  it("'no goalscorer' and 'no goal' inside a sentence follow the language (they are table entries, not stored words)", async () => {
    const page = await loadPredictions({ match: FINAL, mine: { ...MINE, prediction: { ...MINE.prediction, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedFirstTeamToScore: null }, qualification: null } });
    expect(page.doc.body.textContent).toContain("Tu predicción: 2–1, Sin goleador, Sin gol, primero: Sin gol");
    page.en();
    expect(page.doc.body.textContent).toContain("Your prediction: 2–1, No Goalscorer, No Goal, first: No Goal");
  });

  it("each prize situation keeps its meaning in Spanish", async () => {
    const say = async (patch: Record<string, unknown>) => (await loadPredictions({ match: FINAL, mine: { ...MINE, qualification: { ...MINE.qualification, ...patch } } })).text("[data-prize-slot]");
    expect(await say({ redeemedAt: "2026-10-24T23:00:00Z" })).toBe("Premio obtenido: Pitcher gratis — ya canjeado.");
    expect(await say({ alreadyDelivered: true })).toBe("Premio obtenido: Pitcher gratis — ya entregado antes — el resultado corregido no lo cambia.");
    expect(await say({ underReview: true })).toContain("en revisión por la sede tras una corrección del resultado");
    expect(await say({ supersededAt: "x" })).toBe("Premio obtenido: Pitcher gratis (reemplazado por una corrección del resultado).");
  });

  it("locked, missed and awaiting-result states are Spanish", async () => {
    const past = { kickoffAt: new Date(Date.now() - 3600_000).toISOString() };
    expect((await loadPredictions({ match: past, mine: {} })).text("#content .status-pill")).toBe("Bloqueado — esperando el resultado oficial");
    expect((await loadPredictions({ match: past, mine: {} })).doc.body.textContent).toContain("No enviaste una predicción antes del inicio del partido.");
    expect((await loadPredictions({ match: past, mine: MINE })).doc.body.textContent).toContain("Tu predicción: 2–1. Esperando el resultado oficial.");
  });

  it("the kick-off time follows the language for month and weekday names, and the time-zone policy is the one it always had (the device's)", async () => {
    // One instant is both the start of the match and the end of participation: two labelled lines, the same time, the zone written out.
    const when = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso));
    const OPEN = "2031-10-24T20:00:00.000Z";
    const page = await loadPredictions({ authenticated: false, match: { kickoffAt: OPEN } });
    const lines = () => Array.from(page.doc.querySelectorAll("[data-time-key]")).map((n) => n.textContent);
    expect(lines()).toEqual([`Inicio del partido: ${when("es-HN", OPEN)}`, `Cierre de participación: ${when("es-HN", OPEN)} (al inicio del partido)`]);
    page.en();
    expect(lines()).toEqual([`Match start: ${when("en-US", OPEN)}`, `Participation closes: ${when("en-US", OPEN)} (when the match starts)`]);
    // Once the instant has passed the participation is closed since then: one line, the same time.
    const CLOSED = "2026-01-24T20:00:00.000Z";
    const closed = await loadPredictions({ authenticated: false, match: { kickoffAt: CLOSED } });
    expect(Array.from(closed.doc.querySelectorAll("[data-time-key]")).map((n) => n.textContent)).toEqual([`Participación cerrada desde el inicio del partido: ${when("es-HN", CLOSED)}`]);
    expect(when("es-HN", OPEN)).toMatch(/GMT|UTC|[A-Z]{2,5}/); // the zone is part of what is shown
    expect(PRED_HTML).not.toMatch(/timeZone\s*:/); // Predictions never forced a zone (it only writes the device's out), and still does not
  });

  it("the page script keeps the shared module as the only owner of the saved choice, and touches browser storage for one purpose only: the unsent progressive draft, in session storage, in one marked region, with no credentials", () => {
    const script = PRED_HTML.slice(PRED_HTML.lastIndexOf("<script>"));
    // No persistent storage of any kind, and no cookie, from the page script.
    expect(script).not.toMatch(/localStorage|indexedDB|document\.cookie|caches\.|openDatabase/);
    // Session storage is reached from the marked region and nowhere else.
    const beginMarker = "// ==== local draft storage (sessionStorage) — begin ====";
    const endMarker = "// ==== local draft storage (sessionStorage) — end ====";
    const begin = script.indexOf(beginMarker);
    const end = script.indexOf(endMarker);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(script.indexOf(beginMarker, begin + 1)).toBe(-1);
    expect(script.indexOf(endMarker, end + 1)).toBe(-1);
    expect(script.slice(0, begin) + script.slice(end + endMarker.length)).not.toMatch(/sessionStorage/);
    // What the region stores carries no credential, token, e-mail or personal profile field (comments aside).
    const code = script.slice(begin, end).split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    expect(code).toMatch(/sessionStorage/);
    expect(code).not.toMatch(/token|password|secret|apikey|api_key|authorization|bearer|email|displayName|authUserId|getAccessToken|UrbanoAuth/i);
    // The key is namespaced, and the only identity in it is the Gaming member id the page was already given.
    expect(code).toContain('"urbano.score.draft."');
    // The other pages still own no storage of their own.
    expect(INDEX_HTML.slice(INDEX_HTML.lastIndexOf("<script>"))).not.toMatch(/localStorage|sessionStorage/);
  });
});
