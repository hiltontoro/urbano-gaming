import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The shared language module (public/urbanoI18n.js), evaluated as shipped in jsdom. Proves: Spanish by default and NEVER from the browser's
 * own language; the choice is remembered when storage works and the page still works when it does not; <html lang>, the selector and the
 * translated text follow the choice; variables and nested markers; the two languages carry the same keys and the same placeholders; and the
 * table is tied to the real strings it translates (the server's member-facing messages and the shared sign-in component's English text), so
 * it cannot drift from them unnoticed.
 *
 * What this does NOT prove: that no English remains on a page. Comparing dictionaries cannot show that; the page tests render each page in
 * Spanish and scan what is actually visible (see shellPublic.test.ts), and even that is a heuristic, stated as one.
 */

const ROOT = process.cwd();
const SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type StorageMode = "ok" | "blocked" | "set-throws";

function load(opts: { html?: string; stored?: string | null; storage?: StorageMode; browserLanguage?: string } = {}) {
  const dom = new JSDOM(opts.html ?? `<!doctype html><html lang="es"><body></body></html>`, { url: "http://localhost/", runScripts: "outside-only" });
  const win = dom.window as unknown as Window & Record<string, any>;
  if (opts.browserLanguage) {
    Object.defineProperty(win.navigator, "language", { value: opts.browserLanguage, configurable: true });
    Object.defineProperty(win.navigator, "languages", { value: [opts.browserLanguage], configurable: true });
  }
  if (opts.storage === "blocked") {
    Object.defineProperty(win, "localStorage", { get() { throw new Error("storage blocked"); }, configurable: true });
  } else {
    if (opts.stored !== undefined && opts.stored !== null) win.localStorage.setItem("urbano.lang", opts.stored);
    if (opts.storage === "set-throws") win.Storage.prototype.setItem = () => { throw new Error("quota exceeded"); };
  }
  win.eval(SOURCE);
  return { win, doc: win.document, i18n: win.UrbanoI18n as Record<string, any> };
}

describe("Spanish by default, and never from the browser's language", () => {
  it("a browser that says English still gets Spanish until the person chooses", () => {
    const { i18n, doc } = load({ browserLanguage: "en-US" });
    expect(i18n.getLang()).toBe("es");
    expect(doc.documentElement.getAttribute("lang")).toBe("es");
    expect(i18n.t("shell.nav.home")).toBe("Inicio");
    expect(i18n.locale()).toBe("es-HN");
  });

  it("a saved choice is restored; a saved value that is not a supported language is ignored", () => {
    expect(load({ stored: "en" }).i18n.getLang()).toBe("en");
    for (const junk of ["fr", "EN", "", "es-HN", "<script>"]) expect(load({ stored: junk }).i18n.getLang(), JSON.stringify(junk)).toBe("es");
  });
});

describe("choosing a language", () => {
  const HTML = `<!doctype html><html lang="es"><body>
    <button data-lang="es" aria-pressed="true">ES</button><button data-lang="en" aria-pressed="false">EN</button>
    <p id="a" data-i18n="shell.nav.home">Inicio</p>
    <p id="b" data-i18n="auth.btn.hi" data-i18n-vars='{"name":"Ana"}'>Hola, Ana</p>
    <input id="c" data-i18n-attr="placeholder:auth.input.emailPlaceholder;aria-label:auth.input.emailAria" placeholder="tu@ejemplo.com" />
  </body></html>`;

  it("setLang remembers the choice, updates <html lang>, the selector buttons, the text and the attributes, and tells listeners once", () => {
    const { i18n, doc, win } = load({ html: HTML });
    const seen: string[] = [];
    i18n.onChange((lang: string) => seen.push(lang));
    expect(i18n.setLang("en")).toBe(true);
    expect(i18n.getLang()).toBe("en");
    expect(win.localStorage.getItem("urbano.lang")).toBe("en");
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    expect(doc.getElementById("a")!.textContent).toBe("Home");
    expect(doc.getElementById("b")!.textContent).toBe("Hi, Ana");
    expect(doc.getElementById("c")!.getAttribute("placeholder")).toBe("you@example.com");
    expect(doc.getElementById("c")!.getAttribute("aria-label")).toBe("Email address");
    expect(doc.querySelector('[data-lang="en"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(doc.querySelector('[data-lang="es"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(seen).toEqual(["en"]);
    i18n.setLang("en"); // the same language again is not a change
    expect(seen).toEqual(["en"]);
  });

  it("clicking a selector button chooses the language (the selector works by delegation, so one added later works too)", () => {
    const { i18n, doc } = load({ html: HTML });
    (doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(i18n.getLang()).toBe("en");
    const late = doc.createElement("button");
    late.setAttribute("data-lang", "es");
    doc.body.appendChild(late);
    late.click();
    expect(i18n.getLang()).toBe("es");
  });

  it("a language that is not supported is refused and nothing changes", () => {
    const { i18n, win } = load({ html: HTML, stored: "en" });
    expect(i18n.setLang("fr")).toBe(false);
    expect(i18n.setLang(undefined)).toBe(false);
    expect(i18n.getLang()).toBe("en");
    expect(win.localStorage.getItem("urbano.lang")).toBe("en");
  });

  it("a listener that throws does not stop the others or the change itself", () => {
    const { i18n } = load({ html: HTML });
    const seen: string[] = [];
    i18n.onChange(() => { throw new Error("boom"); });
    i18n.onChange((lang: string) => seen.push(lang));
    expect(() => i18n.setLang("en")).not.toThrow();
    expect(seen).toEqual(["en"]);
  });

  it("when storage is blocked the page still works in Spanish and switching still works for the page", () => {
    const { i18n, doc } = load({ html: HTML, storage: "blocked" });
    expect(i18n.getLang()).toBe("es");
    expect(() => i18n.setLang("en")).not.toThrow();
    expect(i18n.getLang()).toBe("en");
    expect(doc.getElementById("a")!.textContent).toBe("Home");
  });

  it("when saving fails (full storage) the choice still applies to the page", () => {
    const { i18n, doc } = load({ html: HTML, storage: "set-throws" });
    expect(() => i18n.setLang("en")).not.toThrow();
    expect(doc.getElementById("a")!.textContent).toBe("Home");
  });

  it("loaded in <head>, before the text exists, it translates once the document is ready", async () => {
    const dom = new JSDOM(`<!doctype html><html lang="es"><head></head><body><p id="a" data-i18n="shell.nav.home">Inicio</p></body></html>`, {
      url: "http://localhost/", runScripts: "outside-only",
      beforeParse(window) { window.localStorage.setItem("urbano.lang", "en"); (window as any).eval(SOURCE); },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.getElementById("a")!.textContent).toBe("Home");
  });
});

describe("variables, nested markers and missing keys", () => {
  it("interpolates {name}, leaves an unknown placeholder visible, and resolves a {\"$t\"} marker in the language chosen when it is drawn", () => {
    const { i18n, doc } = load({
      html: `<!doctype html><html><body><p id="x" data-i18n="pred.yours.full" data-i18n-vars='{"home":2,"away":1,"scorer":{"$t":"pred.noGoalscorer"},"minute":"30&apos;","first":"Alpha FC"}'></p></body></html>`,
    });
    expect(i18n.t("auth.btn.hi", { name: "Ana" })).toBe("Hola, Ana");
    expect(i18n.t("auth.btn.hi")).toBe("Hola, {name}");
    expect(doc.getElementById("x")!.textContent).toBe("Tu predicción: 2–1, Sin goleador, 30', primero: Alpha FC");
    i18n.setLang("en");
    expect(doc.getElementById("x")!.textContent).toBe("Your prediction: 2–1, No Goalscorer, 30', first: Alpha FC");
  });

  it("a key that exists in neither language comes back as the key, never as empty text", () => {
    expect(load().i18n.t("no.such.key")).toBe("no.such.key");
  });

  it("variables are text, never markup", () => {
    const { i18n } = load();
    expect(i18n.t("auth.btn.hi", { name: "<img src=x onerror=alert(1)>" })).toBe("Hola, <img src=x onerror=alert(1)>");
    const dom = load({ html: `<!doctype html><html><body><p id="x" data-i18n="auth.btn.hi" data-i18n-vars='{"name":"<b>x</b>"}'></p></body></html>` });
    expect(dom.doc.getElementById("x")!.children.length).toBe(0);
  });
});

describe("the two languages carry the same table", () => {
  const { i18n } = load();
  const { es, en } = i18n.dictionary() as { es: Record<string, string>; en: Record<string, string> };
  const placeholders = (text: string) => Array.from(text.matchAll(/\{(\w+)\}/g)).map((m) => m[1]).sort();

  it("every key exists in both languages and no text is empty", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of [...Object.entries(es), ...Object.entries(en)]) expect(value.trim(), key).not.toBe("");
  });

  it("each key uses the same placeholders in both languages", () => {
    for (const key of Object.keys(en)) expect(placeholders(es[key]), key).toEqual(placeholders(en[key]));
  });

  it("Spanish is real Spanish: no entry is an unchanged copy of the English one unless it is a name or a symbol", () => {
    const SAME_ON_PURPOSE = new Set([
      "home.title", "pred.title", "pred.vs", "upcoming.vs", "home.status.playtest", "profile.soon.avatar", "profile.part.match", // "vs" is the same word in both languages (the separator between two teams)
    ]);
    for (const key of Object.keys(en)) {
      if (SAME_ON_PURPOSE.has(key)) continue;
      expect(es[key], `${key} is still English`).not.toBe(en[key]);
    }
  });

  it("the deleted Clásico card left no key behind, and the allow-list names only keys that exist (a stale entry would hide a real copy of English later)", () => {
    expect(Object.keys(es).filter((k) => k.startsWith("home.score."))).toEqual([]);
    expect(Object.keys(en).filter((k) => k.startsWith("home.score."))).toEqual([]);
    // the disclaimer moved to upcoming.disclaimer: the old home.upcoming.disclaimer no longer exists in either language
    expect(es["home.upcoming.disclaimer"]).toBeUndefined();
    expect(en["home.upcoming.disclaimer"]).toBeUndefined();
    const source = read("__tests__/urbanoI18n.test.ts");
    const list = /const SAME_ON_PURPOSE = new Set\(\[([\s\S]*?)\]\);/.exec(source)![1].replace(/\/\/.*$/gm, ""); // the keys only, not the comment beside them
    const named = Array.from(list.matchAll(/"([\w.]+)"/g)).map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const key of named) expect(en[key], `${key} is in the allow-list but is not a key of the table`).toBeDefined();
  });

  it("the words of the upcoming-matches card: the state chips never say a match is NOT open, 'vs' is the same word in both languages, and one o'clock takes the singular article only in Spanish", () => {
    expect(es["upcoming.state.next"]).toBe("Preselección");
    expect(en["upcoming.state.next"]).toBe("Shortlisted");
    for (const text of [es["upcoming.state.next"], en["upcoming.state.next"]]) expect(text).not.toMatch(/no abierto|not open/i);
    expect(es["upcoming.vs"]).toBe("vs");
    expect(en["upcoming.vs"]).toBe("vs");
    expect(es["upcoming.opensAt"]).toBe("Participación desde las {time} (hora de Honduras)");
    expect(es["upcoming.opensAtOne"]).toBe("Participación desde la {time} (hora de Honduras)");
    expect(en["upcoming.opensAt"]).toBe("Participation from {time} (Honduras time)");
    expect(en["upcoming.opensAtOne"]).toBe(en["upcoming.opensAt"]);
    expect(es["upcoming.opensAtOne"]).not.toBe(es["upcoming.opensAt"]);
    expect(placeholders(es["upcoming.opensAtOne"])).toEqual(["time"]);
    expect(placeholders(en["upcoming.opensAtOne"])).toEqual(["time"]);
    expect(es["upcoming.status.none"]).toBe("Todavía no hay partidos abiertos para participar.");
    expect(en["upcoming.status.none"]).toBe("No match is open for participation yet.");
    expect(es["upcoming.status.open"]).toBe("Hay partidos abiertos para participar. Los ves en la cartelera de Score.");
    expect(en["upcoming.status.open"]).toBe("Some matches are open for participation. You can see them in the Score fixtures.");
  });

  it("the card's other words: intro, teams label, link, past access and its note, the disclaimer (which says nothing about prizes), and the Score page's lineup titles", () => {
    expect(es["home.upcoming.intro"]).toBe("Preselección de los próximos partidos de URBANO Score.");
    expect(en["home.upcoming.intro"]).toBe("Shortlist of the upcoming URBANO Score matches.");
    expect(es["home.upcoming.teamsLabel"]).toBe("Equipos que podrían aparecer en URBANO Score");
    expect(en["home.upcoming.teamsLabel"]).toBe("Teams that may appear in URBANO Score");
    expect(en["home.upcoming.play"]).toBe("See the Score fixtures");
    expect(es["home.upcoming.past"]).toBe("Mis participaciones y premios");
    expect(en["home.upcoming.past"]).toBe("My participations and prizes");
    expect(es["home.upcoming.pastNote"]).toBe("Tus participaciones en partidos finalizados y el estado de tus premios.");
    expect(en["home.upcoming.pastNote"]).toBe("Your participations in finished matches and the status of your prizes.");
    expect(es["upcoming.disclaimer"]).toBe("Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.");
    expect(en["upcoming.disclaimer"]).toBe("Crests only identify the teams. URBANO is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here.");
    // the card makes no statement about prizes: the old sentence ("prizes are shown only when confirmed") is gone from both languages
    for (const text of [es["upcoming.disclaimer"], en["upcoming.disclaimer"]]) expect(text).not.toMatch(/premio|prize/i);
    expect(es["pred.lineup.title"]).toBe("Cartelera");
    expect(en["pred.lineup.title"]).toBe("Fixtures");
    expect(es["pred.lineup.upcomingTitle"]).toBe("Próximos partidos (preselección)");
    expect(en["pred.lineup.upcomingTitle"]).toBe("Upcoming matches (shortlist)");
    expect(es["pred.lineup.upcomingNote"]).toBe("Por ahora no están abiertos para participar. Fechas y horarios informativos: pueden cambiar. Hora de Honduras.");
    expect(en["pred.lineup.upcomingNote"]).toBe("They are not open for participation for now. Dates and times are informational and may change. Honduras time.");
  });

  it("the language names stay correct in each language", () => {
    expect(es["shell.lang.es"]).toBe("Cambiar a español");
    expect(en["shell.lang.en"]).toBe("Switch to English");
  });
});

describe("the table is tied to the strings it translates", () => {
  const { i18n } = load();
  const { en } = i18n.dictionary() as { en: Record<string, string> };

  it("every known server message is exactly what the server says, and maps to its key", () => {
    const sources = [
      read("lib/gaming/predictions/types.ts"),
      read("lib/gaming/predictions/prizeLadder.ts"),
      read("lib/gaming/predictions/httpAuth.ts"),
      read("lib/gaming/legal/types.ts"),
      read("app/api/gaming/predictions/matches/[matchId]/predict/route.ts"),
      read("app/api/gaming/member/route.ts"),
      read("lib/gaming/types.ts"),
    ].join("\n");
    const keys = Object.keys(en).filter((k) => k.startsWith("pred.srv.") || k.startsWith("auth.srv."));
    expect(keys.length).toBeGreaterThanOrEqual(19);
    for (const key of keys) {
      const message = en[key];
      expect(i18n.serverMessageKey(message), `${key} must be recognised from its English text`).toBe(key);
      // The text is what the server really sends: it appears (quote-escaped) in the server source.
      expect(sources.includes(message.replace(/"/g, '\\"')) || sources.includes(message), `${key}: the server never says "${message}"`).toBe(true);
    }
    expect(i18n.serverMessageKey("Failed to create Gaming Member.")).toBe("auth.err.profileFailed");
    expect(i18n.serverMessageKey("some message nobody wrote")).toBeNull();
    expect(i18n.serverMessageKey("failed to submit prediction.")).toBeNull(); // exact match only
  });

  it("the English fallback text written in the shared sign-in component equals the English table, so the two cannot drift", () => {
    const auth = read("public/urbanoAuth.js");
    // Both the direct calls (tr / urbanoAuthText) and the message descriptors (msg) carry an English fallback next to their key.
    const calls = Array.from(auth.matchAll(/(?:urbanoAuthText|\btr|\bmsg)\(\s*"([\w.]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g));
    expect(calls.length).toBeGreaterThanOrEqual(90);
    const seen = new Set<string>();
    for (const [, key, raw] of calls) {
      const fallback = raw.replace(/\\"/g, '"').replace(/\\'/g, "'");
      expect(en[key], `${key} is used in urbanoAuth.js but missing from the table`).toBeDefined();
      expect(fallback, `${key}: the fallback in urbanoAuth.js differs from the English table`).toBe(en[key]);
      seen.add(key);
    }
    // And the other direction: every auth.* key the table defines is actually used by the component.
    for (const key of Object.keys(en).filter((k) => k.startsWith("auth.") && !k.startsWith("auth.srv."))) {
      expect(seen.has(key) || auth.includes(`"${key}"`), `${key} is in the table but never used`).toBe(true);
    }
  });
});

describe("every public page is wired to the table", () => {
  const { i18n } = load();
  const { es, en } = i18n.dictionary() as { es: Record<string, string>; en: Record<string, string> };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

  for (const file of ["public/index.html", "public/soccer-predictions.html", "public/profile.html", "public/leaderboards.html", "public/rewards.html"]) {
    it(`${file}: Spanish first paint, a key for every translated node, and the first-paint text equals the Spanish table`, () => {
      const dom = new JSDOM(read(file), { url: "http://localhost/" }); // no scripts run: this is the no-script first paint
      const doc = dom.window.document;
      expect(doc.documentElement.getAttribute("lang")).toBe("es");
      for (const node of Array.from(doc.querySelectorAll("[data-i18n]"))) {
        const key = node.getAttribute("data-i18n")!;
        expect(es[key], `${file}: ${key}`).toBeDefined();
        expect(en[key], `${file}: ${key}`).toBeDefined();
        if (!node.hasAttribute("data-i18n-vars")) expect(normalize(node.textContent ?? ""), `${file}: ${key}`).toBe(normalize(es[key]));
      }
      for (const node of Array.from(doc.querySelectorAll("[data-i18n-attr]"))) {
        for (const pair of node.getAttribute("data-i18n-attr")!.split(";")) {
          const [attr, key] = pair.split(":");
          expect(es[key], `${file}: ${key}`).toBeDefined();
          if (node.hasAttribute(attr) && !node.hasAttribute("data-i18n-vars")) expect(node.getAttribute(attr), `${file}: ${attr}=${key}`).toBe(es[key]);
        }
      }
      const buttons = Array.from(doc.querySelectorAll("[data-lang]")).map((b) => `${b.getAttribute("data-lang")}:${b.getAttribute("aria-pressed")}:${b.tagName}`);
      expect(buttons).toEqual(["es:true:BUTTON", "en:false:BUTTON"]);
      // The module is loaded before the page's own script, and the shared sign-in component after it.
      const html = read(file);
      expect(html.indexOf('<script src="/urbanoI18n.js"></script>')).toBeGreaterThan(-1);
      expect(html.indexOf('<script src="/urbanoI18n.js"></script>')).toBeLessThan(html.indexOf('<script src="/urbanoAuth.js"></script>'));
      expect(html.indexOf('<script src="/urbanoAuth.js"></script>')).toBeLessThan(html.indexOf("<script>"));
    });
  }

  it("the administrative portal and the other consumers of the shared sign-in component do NOT load the language module (they stay in English)", () => {
    for (const file of ["public/predictions-admin.html", "public/competitions-admin.html", "public/host-applications-admin.html", "public/competitions.html",
      "public/become-a-host.html", "public/trivia-playtest.html", "public/quiz-playtest.html"]) {
      expect(read(file), file).not.toContain("urbanoI18n.js");
    }
  });
});
