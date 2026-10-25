import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The public name URBANO Score (Founder decision) for the journey that used to be called "Soccer Predictions".
 *
 * What is pinned: the old name is gone from every PUBLIC text of the current journey — Home, the public page, the profile and the shared
 * sign-in panel — in both languages, including titles, accessibility labels and the language table; the name is the heading of the Home
 * announcement (El Clásico at The Pub by Beer Box) and the name, its descriptor ("Tus predicciones deportivas" / "Your sports
 * predictions") and the honest scope ("Por ahora solo hay fútbol disponible." / "For now, only soccer is available.") are shown on the
 * public page; the name does not suggest any other sport; and nothing that is
 * identity rather than text was renamed: the route, the file, the API paths and the code keep their historical names and every existing
 * link still works.
 *
 * Out of scope (reported, not touched): other products' pages that still say "Soccer Predictions" (see the delivery inventory).
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const HTML = { "index.html": read("public/index.html"), "soccer-predictions.html": read("public/soccer-predictions.html"), "profile.html": read("public/profile.html") } as const;
type PageName = keyof typeof HTML;
const I18N_SOURCE = read("public/urbanoI18n.js");
const AUTH_SOURCE = read("public/urbanoAuth.js");

vi.setConfig({ testTimeout: 30_000 });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

const OLD_NAME = /soccer[\s-]*predictions?/i;
const OTHER_SPORTS = /\b(NFL|NBA|MLB|NHL|MLS|baloncesto|basketball|b[eé]isbol|baseball|tenis|tennis|rugby|golf|boxeo|boxing|hockey|f[uú]tbol americano|american football|multi-?deporte|multi-?sport|todos los deportes|all sports|cualquier deporte|any sport|more sports|m[aá]s deportes)\b/i;

async function open(page: PageName, lang: "es" | "en") {
  const dom = new JSDOM(HTML[page], {
    url: `http://localhost/${page}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      w.localStorage.setItem("urbano.lang", lang);
      w.eval(I18N_SOURCE);
      const state = { status: "authenticated", email: "m@example.com", authUserId: "u1", gamingMemberId: "gm1", displayName: "Member" };
      w.eval(AUTH_SOURCE + "\nwindow.__realAuth = UrbanoAuth;");
      w.UrbanoAuth = {
        attachSignInButton: (...args: unknown[]) => (w.__realAuth.attachSignInButton as (...a: unknown[]) => void)(...args),
        getState: async () => state, getProfile: async () => ({ ...state, emailVerified: true, memberSince: "2026-02-01T00:00:00.000Z" }),
        getAccessToken: async () => "t", onAuthStateChange: async () => () => {}, onIdentityChange: async () => () => {}, onIdentityReset: async () => () => {},
        openSignIn: () => true, consumeIntent: () => null,
      };
      w.supabase = { createClient: () => ({ auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, async getSession() { return { data: { session: null } }; }, async signOut() { return { error: null }; } } }) };
      w.fetch = async (url: string) => {
        if (String(url) === "/api/gaming/config") return { ok: true, status: 200, json: async () => ({ supabaseUrl: "http://x", supabaseAnonKey: "k" }) };
        if (String(url) === "/api/gaming/auth-methods") return { ok: true, status: 200, json: async () => ({ email: true, phone: false }) };
        if (String(url) === "/api/gaming/predictions/matches") return { status: 200, json: async () => ({ matches: [] }) };
        if (String(url) === "/api/gaming/predictions/participations") return { ok: true, status: 200, json: async () => ({ participations: [] }) }; // the profile's history
        return { ok: false, status: 404, json: async () => ({}) };
      };
    },
  });
  closers.push(() => dom.window.close());
  await tick();
  const doc = dom.window.document as Document;
  return { win: dom.window as any, doc, text: (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim() };
}

/** Everything a person can read or hear: text nodes (not script or style) and the accessibility-relevant attributes. */
function publicStrings(doc: Document): string[] {
  const out: string[] = [doc.title];
  const walker = doc.createTreeWalker(doc.body, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  for (const el of Array.from(doc.querySelectorAll("[aria-label],[aria-description],[title],[placeholder],[alt],meta[content]"))) {
    for (const attr of ["aria-label", "aria-description", "title", "placeholder", "alt", "content"]) { const v = el.getAttribute(attr); if (v) out.push(v); }
  }
  return out;
}

const dictionary = (() => {
  const sandbox: any = { window: {}, document: undefined };
  sandbox.window = sandbox;
  new Function("window", "document", I18N_SOURCE + "\n;return window.UrbanoI18n;").call(sandbox, sandbox, undefined);
  return sandbox.UrbanoI18n.dictionary() as { es: Record<string, string>; en: Record<string, string> };
})();

describe("the old public name is gone from every public text of the current journey", () => {
  for (const page of Object.keys(HTML) as PageName[]) {
    for (const lang of ["es", "en"] as const) {
      it(`${page} in ${lang}: no visible text, title or accessibility label says "Soccer Predictions"`, async () => {
        const loaded = await open(page, lang);
        expect(publicStrings(loaded.doc).filter((t) => OLD_NAME.test(t))).toEqual([]);
        // and after the shared sign-in panel has been opened
        const button = loaded.doc.getElementById("btn-signin") as HTMLElement | null;
        button?.click();
        await tick();
        expect(publicStrings(loaded.doc).filter((t) => OLD_NAME.test(t))).toEqual([]);
      });
    }
  }

  it("the language table (both languages) never says it", () => {
    for (const lang of ["es", "en"] as const) {
      const offenders = Object.entries(dictionary[lang]).filter(([, value]) => OLD_NAME.test(value)).map(([key]) => key);
      expect(offenders, lang).toEqual([]);
    }
  });

  it("neither does the shared sign-in component's own English fallback text", () => {
    const strings = Array.from(AUTH_SOURCE.matchAll(/(?:urbanoAuthText|tr)\(\s*"[^"]+"\s*,\s*"([^"]+)"/g)).map((m) => m[1]);
    expect(strings.length).toBeGreaterThan(40);
    expect(strings.filter((t) => OLD_NAME.test(t))).toEqual([]);
  });

  it("the markup a page ships as its first paint (before any script) never says it either", () => {
    for (const page of Object.keys(HTML) as PageName[]) {
      // (the route /soccer-predictions.html is an address, not a text: it keeps its name and is what the links point at)
      const withoutScripts = HTML[page].replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/soccer-predictions\.html/g, "/ROUTE");
      expect(withoutScripts.match(OLD_NAME)?.[0] ?? null, page).toBeNull();
    }
  });
});

describe("URBANO Score is named, described and bounded where a person meets it", () => {
  const COPY = {
    es: { descriptor: "Tus predicciones deportivas", scope: "Por ahora solo hay fútbol disponible.", loading: "Cargando URBANO Score…", profileLink: "Mis predicciones en URBANO Score →", homeLine: "El Clásico: FC Barcelona vs. Real Madrid CF", homeVenue: "Vivilo en The Pub by Beer Box" },
    en: { descriptor: "Your sports predictions", scope: "For now, only soccer is available.", loading: "Loading URBANO Score…", profileLink: "My predictions in URBANO Score →", homeLine: "El Clásico: FC Barcelona vs. Real Madrid CF", homeVenue: "Watch it at The Pub by Beer Box" },
  } as const;

  for (const lang of ["es", "en"] as const) {
    it(`Home (${lang}): the featured card is "URBANO Score", announcing El Clásico at The Pub by Beer Box, in a heading the card is named by`, async () => {
      const page = await open("index.html", lang);
      expect(page.text("#featured-title")).toBe("URBANO Score");
      expect(page.doc.querySelector("#featured-predictions h2")!.id).toBe("featured-title");
      expect(page.text("#featured-predictions .featured-descriptor")).toBe(COPY[lang].homeLine);
      expect(page.text("#featured-predictions .featured-scope")).toBe(COPY[lang].homeVenue);
    });

    it(`the public page (${lang}): title, one heading, descriptor, scope and the loading text carry the name`, async () => {
      const page = await open("soccer-predictions.html", lang);
      expect(page.doc.title).toBe("URBANO Score — URBANO Gaming");
      expect(Array.from(page.doc.querySelectorAll("h1")).map((h) => h.textContent)).toEqual(["URBANO Score"]);
      expect(page.doc.querySelector(".score-heading")!.getAttribute("aria-labelledby")).toBe("score-title");
      expect(page.doc.getElementById("score-title")!.textContent).toBe("URBANO Score");
      expect(page.text(".score-descriptor")).toBe(COPY[lang].descriptor);
      expect(page.text(".score-scope")).toBe(COPY[lang].scope);
      expect(dictionary[lang]["pred.loading"]).toBe(COPY[lang].loading);
    });

    it(`the profile (${lang}) links to the journey by its public name`, async () => {
      const page = await open("profile.html", lang);
      expect(page.text("a.link-out")).toBe(COPY[lang].profileLink);
      expect((page.doc.querySelector("a.link-out") as HTMLAnchorElement).getAttribute("href")).toBe("/soccer-predictions.html");
    });
  }

  it("the name and the announcement (Home), and the name, descriptor and scope (public page), are static markup: on screen before any script runs and whatever happens to the list", () => {
    expect(HTML["index.html"]).toMatch(/<h2 id="featured-title">URBANO Score<\/h2>\s*(?:<!--[\s\S]*?-->\s*)?<div class="featured-crests" aria-hidden="true">[\s\S]*?<\/div>\s*<p class="featured-descriptor" data-i18n="home\.score\.clasico">El Clásico: FC Barcelona vs\. Real Madrid CF<\/p>\s*<p class="featured-scope" data-i18n="home\.score\.venue">Vivilo en The Pub by Beer Box<\/p>/);
    expect(HTML["soccer-predictions.html"]).toMatch(/<h1 id="score-title">URBANO Score<\/h1>\s*<p class="score-descriptor" data-i18n="pred\.descriptor">Tus predicciones deportivas<\/p>\s*<p class="score-scope" data-i18n="pred\.scope">Por ahora solo hay fútbol disponible\.<\/p>/);
  });

  it("Home offers no call to action even when the database holds an open match, and its one link still leads to the same page", async () => {
    const dom = new JSDOM(HTML["index.html"], {
      url: "http://localhost/index.html", runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(window) {
        const w = window as any;
        w.eval(I18N_SOURCE);
        w.UrbanoAuth = { attachSignInButton: () => {} };
        w.fetch = async (url: string) => String(url) === "/api/gaming/predictions/matches"
          ? { status: 200, json: async () => ({ matches: [{ matchId: "m1", competition: "Liga", cancelledAt: null, finalized: false, kickoffAt: new Date(Date.now() + 3600_000 * 3).toISOString(), homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true } }] }] }) }
          : { status: 404, json: async () => ({}) };
      },
    });
    closers.push(() => dom.window.close());
    await tick();
    const doc = dom.window.document;
    expect(doc.querySelector("#featured-action")).toBeNull();
    expect(doc.querySelector("#featured-predictions .featured-cta")).toBeNull();
    const links = Array.from(doc.querySelectorAll("#featured-predictions a")) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/soccer-predictions.html"]);
    expect(links[0].textContent).toBe("Jugar ahora");
  });
});

describe("the name does not enable other sports or a multi-sport architecture", () => {
  it("no public text names or hints at another sport or at 'all sports', in either language", async () => {
    for (const page of Object.keys(HTML) as PageName[]) {
      for (const lang of ["es", "en"] as const) {
        const loaded = await open(page, lang);
        expect(publicStrings(loaded.doc).filter((t) => OTHER_SPORTS.test(t)), `${page}/${lang}`).toEqual([]);
      }
    }
    for (const lang of ["es", "en"] as const) {
      const offenders = Object.entries(dictionary[lang]).filter(([key, value]) => /^(home|pred|profile)\./.test(key) && OTHER_SPORTS.test(value)).map(([key]) => key);
      expect(offenders, lang).toEqual([]);
    }
  });

  it("there is no sport selector, tab or filter anywhere on Home or the public page: soccer is the only thing, and it is said", async () => {
    for (const page of ["index.html", "soccer-predictions.html"] as const) {
      const loaded = await open(page, "es");
      expect(loaded.doc.querySelector("[data-sport], [name='sport'], #sport, .sport-tabs, .sport-filter, [aria-label*='deporte' i]")).toBeNull();
      const sportSelect = Array.from(loaded.doc.querySelectorAll("select")).filter((s) => /sport|deporte/i.test(`${s.id} ${s.getAttribute("name") ?? ""} ${s.getAttribute("aria-label") ?? ""}`));
      expect(sportSelect).toHaveLength(0);
    }
    expect(HTML["index.html"]).not.toMatch(/data-sport|sport-tabs|sport-filter/);
    expect(HTML["soccer-predictions.html"]).not.toMatch(/data-sport|sport-tabs|sport-filter|sportKey|sport_key/);
  });

  it("the scope sentence is the product's only statement about sports, and it is about soccer", () => {
    for (const lang of ["es", "en"] as const) {
      const mentions = Object.entries(dictionary[lang]).filter(([key, value]) => /^(home|pred|profile)\./.test(key) && /f[uú]tbol|soccer|deport|sport/i.test(value) && !/^pred\.(f\.|dim\.|geo\.)/.test(key));
      const keys = mentions.map(([key]) => key).sort();
      expect(keys, lang).toEqual(["home.hero.sub", "pred.descriptor", "pred.scope"].filter((k) => keys.includes(k)).sort());
    }
  });
});

describe("what is identity, not text, kept its historical name", () => {
  it("the route and the file are unchanged, and every existing link to them still points there", () => {
    expect(existsSync(path.join(ROOT, "public/soccer-predictions.html"))).toBe(true);
    expect(existsSync(path.join(ROOT, "public/score.html"))).toBe(false);
    expect(HTML["index.html"].match(/href="\/soccer-predictions\.html"/g)!.length).toBeGreaterThanOrEqual(1); // the link to the past predictions and results
    expect(HTML["profile.html"]).toContain('link.href = "/soccer-predictions.html"');
  });

  it("the API paths, the code and the persistence keep their historical names (nothing was renamed)", () => {
    expect(HTML["soccer-predictions.html"]).toContain("/api/gaming/predictions/matches");
    for (const dir of ["app/api/gaming/predictions", "lib/gaming/predictions", "supabase/migrations"]) expect(existsSync(path.join(ROOT, dir)), dir).toBe(true);
    expect(existsSync(path.join(ROOT, "lib/gaming/predictions/types.ts"))).toBe(true);
    expect(HTML["index.html"]).toContain('id="featured-predictions"'); // the element ids keep their names too
    expect(HTML["index.html"]).toContain('id="featured-status"');
  });
});
