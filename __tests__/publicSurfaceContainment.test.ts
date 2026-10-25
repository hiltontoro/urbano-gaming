import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * Public surfaces that must say only what is true: Clasificaciones ("Próximamente") and Premios, in Spanish and English, on the shared
 * header.
 *
 * Clasificaciones used to be an English-only page with Global / By Game / My Circles tabs that asked the leaderboard API for its rows and drew
 * them, so what it showed was whatever that API returned (today: test names). It now says, honestly, that leaderboards are not available yet;
 * it asks for nothing, draws no row and no tab, and carries nothing of its own. Hiding the page's content is NOT a closure of the ranking
 * service: GET /api/gaming/leaderboard is a separate matter and is not touched here.
 *
 * Premios keeps its content (empty, honest categories and the boundary with URBANO Lifestyle rewards) and gains the language selector, the
 * shared header and navigation, and Spanish, so that moving between pages never drops the person back into English.
 *
 * Each page is parsed and run whole in jsdom with the REAL language module (and, for the failure case, without it).
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const I18N_SOURCE = read("public/urbanoI18n.js");
const PAGES = { "leaderboards.html": read("public/leaderboards.html"), "rewards.html": read("public/rewards.html") } as const;
type PageName = keyof typeof PAGES;

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function open(page: PageName, opts: { lang?: "es" | "en"; withModule?: boolean } = {}) {
  const requests: string[] = [];
  const attach: unknown[] = [];
  const dom = new JSDOM(PAGES[page], {
    url: `http://localhost/${page}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      if (opts.lang) window.localStorage.setItem("urbano.lang", opts.lang);
      if (opts.withModule !== false) w.eval(I18N_SOURCE); // as the script tag would; jsdom does not load external scripts
      w.UrbanoAuth = { attachSignInButton: (...args: unknown[]) => { attach.push(args); } };
      w.fetch = (url: string) => { requests.push(String(url)); return Promise.reject(new TypeError("no network in this test")); };
      w.XMLHttpRequest = function () { requests.push("xhr"); throw new Error("no xhr"); };
    },
  });
  closers.push(() => dom.window.close());
  await tick();
  const doc = dom.window.document;
  const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const bodyText = () => (doc.body.cloneNode(true) as HTMLElement & { querySelectorAll: Document["querySelectorAll"] }).textContent!.replace(/\s+/g, " ").trim();
  return { win: dom.window as any, doc, requests, attach, text, bodyText, en: () => (doc.querySelector('[data-lang="en"]') as HTMLElement).click(), es: () => (doc.querySelector('[data-lang="es"]') as HTMLElement).click() };
}

const visibleText = (doc: Document) => {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
};

describe("Clasificaciones: honest 'Próximamente', and nothing else", () => {
  it("says it in Spanish by default: not available yet, no positions and no scores", async () => {
    const page = await open("leaderboards.html");
    expect(page.doc.documentElement.lang).toBe("es");
    expect(page.text("h1")).toBe("Clasificaciones");
    expect(page.text(".status-pill")).toBe("Próximamente");
    expect(page.text(".soft-title")).toBe("Las clasificaciones todavía no están disponibles.");
    expect(page.text(".soft-sub")).toBe("Cuando estén listas, las vas a encontrar acá. Por ahora no mostramos posiciones ni puntajes.");
    expect(page.doc.title).toBe("Clasificaciones — URBANO Gaming");
  });

  it("asks for nothing: no request of any kind, so no ranking can ever be read, drawn or counted", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await open("leaderboards.html", { lang });
      await tick(80);
      expect(page.requests, lang).toEqual([]);
    }
    const source = PAGES["leaderboards.html"];
    const code = source.slice(source.lastIndexOf('<script src="/urbanoAuth.js">'));
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|api\/gaming\/leaderboard|sendBeacon|WebSocket/);
    expect(source).not.toMatch(/\/api\/gaming\/leaderboard/);
  });

  it("draws no tab, no table, no row, no filter chip and no name of any player or game", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await open("leaderboards.html", { lang });
      expect(page.doc.querySelectorAll("table, tr, td, th, .tab-btn, .tab-row, .tab-panel, .filter-chip, [role=tab], [role=tablist]"), lang).toHaveLength(0);
      const text = visibleText(page.doc);
      expect(text, lang).not.toMatch(/Global|By Game|Por juego|My Circles|Mis círculos|Soccer Predictions|Trivia|\bRank\b|Gaming XP|\bXP\b|Display Name|Level\s*\d+|\d{2,}\s*XP/i);
      expect(text, lang).not.toMatch(/\d{3,}/); // not a single score or position on the page
    }
  });

  it("is in English when the language is English, and follows the selector in place without a second request", async () => {
    const page = await open("leaderboards.html");
    page.en();
    await tick();
    expect(page.doc.documentElement.lang).toBe("en");
    expect(page.text("h1")).toBe("Leaderboards");
    expect(page.text(".status-pill")).toBe("Coming Soon");
    expect(page.text(".soft-title")).toBe("Leaderboards are not available yet.");
    expect(page.text(".soft-sub")).toBe("When they are ready, you will find them here. For now we do not show rankings or scores.");
    expect(page.text(".coming-link")).toBe("See my participations");
    expect(page.doc.title).toBe("Leaderboards — URBANO Gaming");
    page.es();
    await tick();
    expect(page.text("h1")).toBe("Clasificaciones");
    expect(page.requests).toEqual([]);
  });

  it("points to where history really is: Mi perfil → Mis participaciones", async () => {
    const page = await open("leaderboards.html");
    const link = page.doc.querySelector(".coming-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/profile.html");
    expect(link.textContent).toBe("Ver mis participaciones");
  });
});

describe("Premios: Spanish and English on the shared header, with the same honest content", () => {
  it("is in Spanish by default, with every section and the boundary with URBANO Lifestyle rewards", async () => {
    const page = await open("rewards.html");
    expect(page.doc.documentElement.lang).toBe("es");
    expect(page.text("h1")).toBe("Premios");
    expect(Array.from(page.doc.querySelectorAll(".reward-section h2")).map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())).toEqual([
      "Logros", "Desbloqueables", "Colecciones", "Recompensas cosméticas", "Beneficios del ecosistema URBANO Próximamente",
    ]);
    expect(page.text(".boundary-card")).toBe("Hoy, los premios de Gaming y los de URBANO Lifestyle están separados. A medida que URBANO Gaming crezca, la participación elegible podría desbloquear beneficios más amplios de URBANO, pero el progreso en Gaming no se convierte automáticamente en moneda ni en puntos, y hoy no existe ese intercambio.");
    expect(page.requests).toEqual([]);
  });

  it("is in English when the language is English, keeping the original wording, and switches in place", async () => {
    const page = await open("rewards.html", { lang: "en" });
    expect(page.text("h1")).toBe("Rewards");
    expect(page.text(".page-sub")).toBe("Your URBANO Gaming progress, recognition, and future perks — all in one place.");
    expect(Array.from(page.doc.querySelectorAll(".reward-section h2")).map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())).toEqual([
      "Achievements", "Unlockables", "Collections", "Cosmetic Rewards", "URBANO Ecosystem Benefits Coming Soon",
    ]);
    expect(page.text(".boundary-card")).toBe("Gaming and URBANO Lifestyle rewards are separate today. As URBANO Gaming grows, eligible participation may unlock broader URBANO benefits — but Gaming progress does not automatically convert into currency or points, and no such exchange exists yet.");
    page.es();
    await tick();
    expect(page.text("h1")).toBe("Premios");
  });

  it("invents nothing: no balance, no item, no amount, no exchange rate and no redemption", async () => {
    for (const lang of ["es", "en"] as const) {
      const page = await open("rewards.html", { lang });
      const text = visibleText(page.doc);
      expect(page.doc.querySelectorAll("button:not([data-lang]):not(#btn-signin), input, select, form, table, ol li"), lang).toHaveLength(0);
      expect(text, lang).not.toMatch(/\d/);
      expect(text, lang).not.toMatch(/canje|redeem|saldo|balance|L\.\s?\d|\$|HNL|USD/i);
    }
  });
});

describe("both pages share the header, the navigation and the language with the rest of the product", () => {
  for (const name of Object.keys(PAGES) as PageName[]) {
    it(`${name}: language selector, brand, account entry, five navigation links with this page marked, footer; ES then EN`, async () => {
      const page = await open(name);
      expect(Array.from(page.doc.querySelectorAll("[data-lang]")).map((b) => `${b.getAttribute("data-lang")}:${b.getAttribute("aria-pressed")}`)).toEqual(["es:true", "en:false"]);
      expect(page.doc.querySelector(".brand-badge")?.getAttribute("href")).toBe("/");
      expect(page.doc.getElementById("btn-signin")).not.toBeNull();
      expect(page.doc.getElementById("account-link")).not.toBeNull();
      expect(page.attach).toHaveLength(1);
      const nav = Array.from(page.doc.querySelectorAll(".primary-nav a"));
      expect(nav.map((a) => a.getAttribute("href"))).toEqual(["/", "/#play", "/#experiences", "/leaderboards.html", "/rewards.html"]);
      expect(nav.map((a) => a.textContent)).toEqual(["Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios"]);
      const current = page.doc.querySelectorAll('.primary-nav a[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect((current[0] as HTMLAnchorElement).getAttribute("href")).toBe(name === "leaderboards.html" ? "/leaderboards.html" : "/rewards.html");
      expect(page.text("footer")).toContain("URBANO Gaming — parte de URBANO");
      page.en();
      await tick();
      expect(nav.map((a) => a.textContent)).toEqual(["Home", "Play", "Experiences", "Leaderboards", "Rewards"]);
      expect(page.doc.querySelector(".primary-nav")!.getAttribute("aria-label")).toBe("Main navigation");
      expect(page.text("footer")).toContain("URBANO Gaming — part of URBANO");
    });

    it(`${name}: a language chosen on another page is kept when arriving here (never back to English by navigating)`, async () => {
      const page = await open(name, { lang: "en" });
      expect(page.doc.documentElement.lang).toBe("en");
      expect(page.doc.querySelector('[data-lang="en"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(page.text(".primary-nav")).toBe("Home Play Experiences Leaderboards Rewards");
    });

    it(`${name}: wide layout rules for a phone — the header wraps in two rows, nothing wider than the screen, 16 px gutters`, () => {
      const css = PAGES[name].slice(PAGES[name].indexOf("<style>"), PAGES[name].indexOf("</style>"));
      const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
      expect(phone).toMatch(/\.header-tools\s*\{\s*display:\s*contents/);
      expect(phone).toMatch(/\.account-group\s*\{\s*flex:\s*1 1 100%/);
      expect(phone).toMatch(/\.content[^{]*\{[^}]*padding-left:\s*16px/);
      expect(css).toMatch(/\.primary-nav\s*\{[^}]*overflow-x:\s*auto/);
      expect(css).not.toMatch(/[^-]min-width:\s*\d{3,}px|[^-]width:\s*\d{3,}px/); // no fixed width wider than a phone
    });
  }
});

describe("without the language module the pages still read, in Spanish, and still ask for nothing", () => {
  for (const name of Object.keys(PAGES) as PageName[]) {
    it(`${name}: the generated Spanish fallback gives the same words, hides the selector, and no key is ever shown`, async () => {
      const reference = await open(name, { withModule: true });
      const fallback = await open(name, { withModule: false });
      expect(fallback.win.UrbanoI18n.fallback).toBe(true);
      // everything outside the language selector (hidden in the fallback) reads the same
      const withoutSelector = (doc: Document) => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script, style, .lang-switch").forEach((n) => n.remove()); return (c.textContent ?? "").replace(/\s+/g, " ").trim(); };
      expect(withoutSelector(fallback.doc)).toBe(withoutSelector(reference.doc));
      expect(fallback.text("h1")).toBe(reference.text("h1"));
      expect(fallback.text("main")).toBe(reference.text("main"));
      expect(fallback.text(".primary-nav")).toBe(reference.text(".primary-nav"));
      const group = fallback.doc.querySelector(".lang-switch") as HTMLElement;
      expect(group.hidden).toBe(true);
      expect(visibleText(fallback.doc)).not.toMatch(/\b(lb|rw|shell|auth)\.[a-z]+/);
      expect(fallback.requests).toEqual([]);
    });
  }

  it("the generated blocks equal the module's Spanish dictionary for their prefixes (no drift)", () => {
    const sandbox: any = { window: {}, document: undefined };
    sandbox.window = sandbox;
    vm.runInNewContext(I18N_SOURCE, sandbox);
    const es = sandbox.UrbanoI18n.dictionary().es as Record<string, string>;
    const PREFIXES: Record<PageName, string[]> = { "leaderboards.html": ["shell.", "lb.", "auth."], "rewards.html": ["shell.", "rw.", "auth."] };
    for (const name of Object.keys(PAGES) as PageName[]) {
      const m = PAGES[name].match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/)!;
      expect(m, name).not.toBeNull();
      const box: any = { document: { querySelectorAll: () => [] } };
      box.window = box;
      vm.runInNewContext(m[1], box);
      const expected = Object.fromEntries(Object.entries(es).filter(([key]) => PREFIXES[name].some((p) => key.startsWith(p))));
      expect(box.UrbanoI18n.dictionary().es, name).toEqual(expected);
      // every key the page's own markup uses is in the block, so nothing can fall back to a raw key
      const used = new Set(Array.from(PAGES[name].replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "").matchAll(/data-i18n(?:-attr)?="(?:[a-z-]+:)?((?:shell|lb|rw|auth)\.[A-Za-z0-9.]+)"/g)).map((x) => x[1]));
      for (const key of used) expect(box.UrbanoI18n.has(key), `${name} uses ${key}`).toBe(true);
    }
  });

  it("the Spanish the HTML ships as its first paint is the dictionary's Spanish", () => {
    const sandbox: any = { window: {}, document: undefined };
    sandbox.window = sandbox;
    vm.runInNewContext(I18N_SOURCE, sandbox);
    const es = sandbox.UrbanoI18n.dictionary().es as Record<string, string>;
    for (const name of Object.keys(PAGES) as PageName[]) {
      const doc = new JSDOM(PAGES[name]).window.document;
      for (const node of Array.from(doc.querySelectorAll("[data-i18n]"))) {
        const key = node.getAttribute("data-i18n")!;
        expect(es[key], `${name}: ${key}`).toBeDefined();
        expect((node.textContent ?? "").replace(/\s+/g, " ").trim(), `${name}: ${key}`).toBe(es[key].replace(/\s+/g, " ").trim());
      }
    }
  });
});
