import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsdomModule from "jsdom";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * The Home and the four experience pages (Founder direction of 2026-10-31).
 *
 * The Home shows a featured card ("Destacado": the Halloween contest at The Pub by Beer Box, an URBANO Voting experience, with its TWO buttons "Votar por tu
 * disfraz favorito" and "Participar como concursante") and, below it, the four experiences of URBANO Gaming in this order: URBANO Voting, URBANO Score, URBANO
 * Trivia and URBANO Poker. Each panel has ONE control, "Descubrí más" / "Discover more", that opens that experience's own page, where the information is, and no
 * page lists the other experiences. The Home links to nothing that is not an existing page, and the featured card's two buttons are words, not links, until the
 * server says that a contest is listed: a person arriving in a crowd (the day of an event) can press anything on it and land somewhere that works.
 *
 * Proves, on the files as shipped (every page parsed whole in jsdom, with the REAL language module):
 *   - the featured card, the four panels, their order, their single link each, and what the Home does NOT contain (no play button, no form, no link into a flow);
 *   - every link and every file the five pages reference is a real file of public/ (and every #anchor a real id), so no page can send a visitor to a page that does
 *     not exist; the only links into the application are the two Score ones, written down here;
 *   - the featured card's module (/featuredContest.js): the two buttons become links ONLY when the server's answer is exactly the documented shape, on the Home and on
 *     the URBANO Voting page; every other answer (an error, a 404, a late or malformed body, a link to anywhere else, an unknown phase) leaves them as written, with no
 *     link at all, and what the server sends is shown as text, never as markup;
 *   - the Spanish default in the markup is exactly the language table, every key exists in Spanish and English, and each page's generated Spanish fallback equals the
 *     module's dictionary for that page's key prefixes (so a failing language module cannot leave a raw key on screen);
 *   - the header's sign-in control works on all five pages with the real shared client;
 *   - the CSS contract of the layout (wide cards from 641 px, two columns from 900 px, stacked cards on a phone; the whole panel is the tap target; reduced motion).
 *
 * Limits, stated plainly: jsdom does not lay a page out, so the layout is pinned here as CSS contract only and was measured in a real browser separately. The
 * voting endpoint and the voting pages belong to another change that is not part of this one: the featured card is tested against its documented answer with a
 * stubbed network, and against every other answer a browser could receive.
 */

// jsdom is CommonJS: depending on the loader its classes are named exports or members of the default export.
const jsdom: typeof import("jsdom") = ((jsdomModule as any).default && (jsdomModule as any).default.JSDOM ? (jsdomModule as any).default : jsdomModule) as any;
const { JSDOM, requestInterceptor } = jsdom as any;

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const read = (file: string) => readFileSync(path.join(PUBLIC, file), "utf8");

const EXPERIENCES = ["voting", "score", "trivia", "poker"] as const;
type Experience = (typeof EXPERIENCES)[number];
const PAGE_FILE: Record<Experience, string> = { voting: "voting.html", score: "score.html", trivia: "trivia.html", poker: "poker.html" };
const ALL_PAGES = ["index.html", ...EXPERIENCES.map((k) => PAGE_FILE[k])];
const HTML: Record<string, string> = Object.fromEntries(ALL_PAGES.map((f) => [f, read(f)]));
const htmlOf = (file: string) => HTML[file] ?? read(file); // the five pages, or any other page of public/ that one of them points at
const CSS = read("experience.css");
const I18N_SOURCE = read("urbanoI18n.js");
const FEATURED_SOURCE = read("featuredContest.js");

const moduleApi = (() => {
  const sandbox: any = { window: {}, document: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(I18N_SOURCE, sandbox);
  return sandbox.UrbanoI18n;
})();
const ES = moduleApi.dictionary().es as Record<string, string>;
const EN = moduleApi.dictionary().en as Record<string, string>;

const dom = (file: string): Document => new JSDOM(htmlOf(file), { url: "https://gaming.example/" + (file === "index.html" ? "" : file) }).window.document;
const links = (root: ParentNode) => Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
const visibleText = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------------------------------------------------------
// the Home
// ----------------------------------------------------------------------------------------------------------------------------
describe("the Home: a featured card, then four experiences with one way into each", () => {
  const doc = dom("index.html");
  const panels = Array.from(doc.querySelectorAll("ul.xp-grid > li > article.xp"));

  it("shows exactly four panels, in the Founder's order: URBANO Voting, URBANO Score, URBANO Trivia, URBANO Poker (every name uniform)", () => {
    expect(panels.map((p) => EXPERIENCES.find((k) => p.classList.contains(`xp-${k}`)))).toEqual([...EXPERIENCES]);
    expect(panels.map((p) => visibleText(p.querySelector(".xp-title")!))).toEqual(["URBANO Voting", "URBANO Score", "URBANO Trivia", "URBANO Poker"]);
    for (const lang of [ES, EN]) for (const k of EXPERIENCES) expect(lang[`home.xp.${k}.title`], k).toMatch(/^URBANO [A-Z][a-z]+$/);
  });

  it("each panel has exactly ONE link, to that experience's own page, and its words are 'Descubrí más' (and the experience's name for a screen reader)", () => {
    for (const [i, panel] of panels.entries()) {
      const k = EXPERIENCES[i];
      const anchors = Array.from(panel.querySelectorAll("a"));
      expect(anchors, k).toHaveLength(1);
      expect(anchors[0].getAttribute("href"), k).toBe("/" + PAGE_FILE[k]);
      expect(anchors[0].classList.contains("xp-cta"), k).toBe(true);
      expect(visibleText(anchors[0]), k).toBe(`${ES["home.xp.cta"]}: ${ES[`home.xp.${k}.title`]}`);
      expect(visibleText(anchors[0].firstElementChild!), k).toBe("Descubrí más"); // the words a sighted person sees
      expect(anchors[0].querySelector(".sr-only"), k).not.toBeNull();
      expect(panel.getAttribute("aria-labelledby"), k).toBe(panel.querySelector(".xp-title")!.id);
    }
  });

  it("the featured card (Destacado) says Halloween, The Pub by Beer Box and 31 de octubre, is an URBANO Voting experience, and has TWO buttons instead of 'Descubrí más'", () => {
    const card = doc.getElementById("featured-contest")!;
    expect(card).not.toBeNull();
    expect(visibleText(card.querySelector(".xf-label")!)).toBe("Destacado");
    expect(visibleText(card.querySelector(".xp-kicker")!)).toBe("URBANO Voting");
    expect(visibleText(card.querySelector(".xf-title")!)).toBe("Halloween");
    expect(card.querySelector(".xf-title")!.tagName).toBe("H2");
    expect(visibleText(card.querySelector(".xf-meta")!)).toBe("Concurso de disfraces · The Pub by Beer Box · 31 de octubre");
    expect(Array.from(card.querySelectorAll("[data-feat]")).map((b) => [b.getAttribute("data-feat"), visibleText(b)])).toEqual([["vote", "Votar por tu disfraz favorito"], ["join", "Participar como concursante"]]);
    expect(card.textContent).not.toMatch(/Descubrí más|Discover more/);
    expect(visibleText(card.querySelector("[data-feat-status]")!)).toBe("Las inscripciones y la votación todavía no están disponibles.");
    expect(card.querySelector("[data-feat-status]")!.getAttribute("role")).toBe("status");
    expect(card.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(EN["home.feat.vote"]).toBe("Vote for your favorite costume");
    expect(EN["home.feat.join"]).toBe("Take part as a contestant");
    expect(EN["home.feat.date"]).toBe("October 31");
  });

  it("in the first HTML the featured card's two buttons are NOT links (words in a dashed outline), so nobody can press a link that leads nowhere", () => {
    const card = doc.getElementById("featured-contest")!;
    expect(card.querySelectorAll("a, button, form, input")).toHaveLength(0);
    for (const b of Array.from(card.querySelectorAll("[data-feat]"))) {
      expect(b.tagName).toBe("SPAN");
      expect(b.hasAttribute("href")).toBe(false);
      expect(b.hasAttribute("tabindex")).toBe(false);
    }
    expect(card.querySelector("[data-feat-cats]")!.hasAttribute("hidden")).toBe(true);
  });

  it("has no 'play' control and no link into a flow: the only links in the page body are the four panels', the only buttons are the language selector and the account control, and there is no form", () => {
    const main = doc.querySelector("main")!;
    expect(links(main)).toEqual(EXPERIENCES.map((k) => "/" + PAGE_FILE[k]));
    expect(Array.from(doc.querySelectorAll("button")).map((b) => b.id || b.getAttribute("data-lang"))).toEqual(["es", "en", "btn-signin"]);
    expect(doc.querySelectorAll("form, input, select, textarea, [role='button'], [onclick]").length).toBe(0);
    for (const lang of [ES, EN]) {
      const words = [...EXPERIENCES.flatMap((k) => [lang[`home.xp.${k}.kicker`], lang[`home.xp.${k}.title`], lang[`home.xp.${k}.desc`]]), lang["home.xp.cta"], lang["home.xp.choose"], lang["home.hero.title"], lang["home.hero.sub"]].join(" | ");
      expect(words).not.toMatch(/jugar ahora|play now|unirme|join now|votar ahora|vote now|inscrib|register|apost|\bbet\b|playtest|próximamente|coming soon/i);
    }
  });

  it("is static where it matters: its own code makes no request (the featured card's one read is made by /featuredContest.js, the account control's by the shared client), and it carries none of the old Home's data scripts", () => {
    const html = HTML["index.html"];
    const scripts = Array.from(doc.querySelectorAll("script")).map((s) => s.getAttribute("src") ?? (s.id ? `inline#${s.id}` : "inline"));
    expect(scripts).toEqual(["/urbanoI18n.js", "/urbanoClubCrests.js", "/featuredContest.js", "inline#i18n-fallback", "/urbanoAuth.js", "inline"]);
    const inline = Array.from(doc.querySelectorAll("script:not([src])")).filter((s) => s.id !== "i18n-fallback").map((s) => s.textContent).join("\n");
    expect(inline).not.toMatch(/fetch\(|XMLHttpRequest|\/api\//);
    for (const gone of ["hostAvailability.js", "homeUpcoming.js", "homeUpcomingData.js", "/api/gaming/predictions", "/api/gaming/host", "/halloween.html"]) expect(html, gone).not.toContain(gone);
  });

  it("every word of the featured card and of the four panels is in the first HTML (no script is needed to see them), in Spanish", () => {
    const text = visibleText(doc.querySelector("main")!);
    for (const k of EXPERIENCES) for (const part of ["kicker", "title", "desc"]) expect(text, `${k}.${part}`).toContain(ES[`home.xp.${k}.${part}`]);
    for (const key of ["label", "product", "title", "sub", "venue", "date", "desc", "vote", "join"]) expect(text, `feat.${key}`).toContain(ES[`home.feat.${key}`]);
    expect(doc.documentElement.getAttribute("lang")).toBe("es");
  });

  it("keeps both navigation anchors alive: #experiences and #play (every page's navigation points at them) land on the four panels", () => {
    const section = doc.getElementById("experiences")!;
    const play = doc.getElementById("play")!;
    expect(section).not.toBeNull();
    expect(play).not.toBeNull();
    expect(section.contains(play)).toBe(true);
    expect(play.querySelectorAll("article.xp")).toHaveLength(4);
    expect(section.contains(doc.getElementById("featured-contest"))).toBe(false);
  });

  it("the Score panel carries the strip of the ten crests (the Founder asked to keep it): the ten teams in the Founder's order, each named in text, labelled by a visible heading, with the approved sentence that says what the crests are NOT; no other panel carries a crest", () => {
    const TEAMS = ["Real Madrid", "FC Barcelona", "Manchester City", "Manchester United", "Arsenal", "Olimpia", "Motagua", "Inter de Milán", "Bayern Múnich", "Paris Saint-Germain"];
    const score = doc.querySelector("article.xp-score")!;
    const chips = Array.from(score.querySelectorAll("ul.ten-crests > li.crest-chip"));
    expect(chips.map((c) => c.getAttribute("data-club"))).toEqual(TEAMS);
    expect(chips.map((c) => c.textContent)).toEqual(TEAMS);
    const label = score.querySelector("#featured-teams-label")!;
    expect(score.querySelector("ul.ten-crests")!.getAttribute("aria-labelledby")).toBe(label.id);
    expect(label.getAttribute("data-i18n")).toBe("home.upcoming.teamsLabel");
    const legal = score.querySelector(".featured-legal")!;
    expect(legal.getAttribute("data-i18n")).toBe("upcoming.disclaimer");
    expect(legal.textContent).toBe(ES["upcoming.disclaimer"]);
    expect(ES["upcoming.disclaimer"]).toMatch(/solo identifican a los equipos.*no está afiliado.*patrocinio o respaldo/);
    expect(EN["upcoming.disclaimer"]).toMatch(/only identify the teams.*not affiliated with, sponsored by or endorsed by/);
    // the strip and its sentence are ONE unit (the sentence is never separated from the crests), and they are not links
    expect(legal.closest(".xp-teams")).toBe(score.querySelector("ul.ten-crests")!.closest(".xp-teams"));
    expect(score.querySelector(".xp-teams a, .xp-teams button")).toBeNull();
    // the button still comes last in the panel's words
    expect(Array.from(score.querySelector(".xp-body")!.children).map((e) => e.className)).toEqual(["xp-title", "xp-desc", "xp-teams", "xp-cta"]);
    for (const other of ["voting", "trivia", "poker"]) expect(doc.querySelector(`article.xp-${other}`)!.querySelector("[data-club], .club-crest, .ten-crests")).toBeNull();
    expect(doc.getElementById("featured-contest")!.querySelector("[data-club], .club-crest, .ten-crests")).toBeNull();
  });

  it("the four experience pages carry no crest and name no club (the strip lives on the Home's Score panel)", () => {
    for (const file of ALL_PAGES.slice(1)) {
      expect(HTML[file], file).not.toMatch(/urbanoClubCrests|club-crest|ten-crests|crest-chip|data-club|assets\/clubs|URBANO_CRESTS_PREVIEW/);
    }
  });

  it("every picture is decoration: empty alt text, the size of its file, and no panel depends on a picture for its words", () => {
    const imgs = Array.from(doc.querySelectorAll("main img"));
    expect(imgs).toHaveLength(5); // the featured card and the four panels
    for (const img of imgs) {
      expect(img.getAttribute("alt")).toBe("");
      expect(img.getAttribute("width")).toBe("1280");
      expect(img.getAttribute("height")).toBe("720");
    }
    // the five pictures are five different files, except that the featured card and the URBANO Voting panel may not show the same one
    const sources = imgs.map((i) => i.getAttribute("src"));
    expect(new Set(sources).size).toBe(sources.length);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------
// the header's sign-in control, with the REAL shared client
// ----------------------------------------------------------------------------------------------------------------------------
describe("the header's sign-in control works on all five pages, with the real shared client (/urbanoAuth.js)", () => {
  const AUTH_SOURCE = read("urbanoAuth.js");
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const closers: Array<() => void> = [];
  afterEach(() => { while (closers.length) closers.pop()!(); });

  /** The page as a browser runs it: its own <script> tags are fetched (here from disk, through jsdom's own loader) and executed in order, as classic scripts. */
  async function boot(file: string) {
    const served: Record<string, string> = { "/urbanoI18n.js": I18N_SOURCE, "/urbanoAuth.js": AUTH_SOURCE, "/urbanoClubCrests.js": read("urbanoClubCrests.js"), "/featuredContest.js": FEATURED_SOURCE };
    const dom = new JSDOM(htmlOf(file), {
      url: `https://gaming.example/${file === "index.html" ? "" : file}`, runScripts: "dangerously", pretendToBeVisual: true,
      resources: {
        interceptors: [requestInterceptor((request: Request) => {
          const url = new URL(request.url);
          if (url.hostname !== "gaming.example") return new Response("", { status: 200, headers: { "Content-Type": "text/css" } }); // fonts: never the network
          if (url.pathname === "/experience.css") return new Response(CSS, { status: 200, headers: { "Content-Type": "text/css" } });
          const body = served[url.pathname];
          return body ? new Response(body, { status: 200, headers: { "Content-Type": "application/javascript" } }) : new Response("", { status: 404 });
        })],
      },
      beforeParse(window: any) {
        window.supabase = { createClient: () => ({ auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, async getSession() { return { data: { session: null } }; }, async signOut() { return { error: null }; } } }) };
        window.fetch = async (url: string) => {
          if (url === "/api/gaming/config") return reply(200, { supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" });
          if (url === "/api/gaming/auth-methods") return reply(200, { email: true, phone: false });
          return reply(404, {});
        };
      },
    });
    const w = dom.window as any;
    closers.push(() => w.close());
    await new Promise<void>((resolve) => { if (w.document.readyState === "complete") resolve(); else w.addEventListener("load", () => resolve()); });
    await new Promise((r) => setTimeout(r, 120));
    return w;
  }

  it("UrbanoAuth is a top-level const of its script (a global binding, NOT a property of window): the pages must look for it with typeof, never with window.UrbanoAuth", async () => {
    const w = await boot("index.html");
    expect(w.eval("typeof UrbanoAuth")).toBe("object");
    expect(typeof w.UrbanoAuth).toBe("undefined");
    for (const file of ALL_PAGES) {
      // the page's own code (its inline scripts, without the generated fallback and without comments)
      const code = Array.from(dom(file).querySelectorAll("script:not([src])")).filter((el) => (el as HTMLElement).id !== "i18n-fallback").map((el) => el.textContent ?? "").join("\n").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).toMatch(/typeof UrbanoAuth !== "undefined"/);
      expect(code, file).not.toMatch(/window\.UrbanoAuth/);
    }
  });

  for (const file of ALL_PAGES) {
    it(`${file}: the control is attached and revealed, and it opens the sign-in panel in Spanish`, async () => {
      const w = await boot(file);
      const doc = w.document as Document;
      const button = doc.getElementById("btn-signin") as HTMLElement;
      expect(button.style.visibility, "revealed by the shared client once it has attached").not.toBe("hidden");
      expect(button.textContent).toBe("Iniciar sesión / Crear cuenta");
      button.click();
      await new Promise((r) => setTimeout(r, 40));
      const panel = (doc.querySelector("[data-urbano-signin-panel]")?.textContent ?? "").replace(/\s+/g, " ");
      expect(panel).toContain("Entrá a URBANO");
      expect(panel).toContain("Iniciar sesión");
      expect(panel).toContain("Crear cuenta");
    });
  }
});

// ----------------------------------------------------------------------------------------------------------------------------
// no dead link, on any of the five pages
// ----------------------------------------------------------------------------------------------------------------------------
describe("no link on any of the five pages leads nowhere", () => {
  const SITE_REF = /^\/(?!\/)/;
  const references = (file: string) => {
    const doc = dom(file);
    const out: Array<{ attr: string; value: string; tag: string }> = [];
    for (const el of Array.from(doc.querySelectorAll("[href], [src]"))) {
      for (const attr of ["href", "src"]) if (el.hasAttribute(attr)) out.push({ attr, value: el.getAttribute(attr)!, tag: el.tagName.toLowerCase() });
    }
    return out;
  };

  for (const file of ALL_PAGES) {
    it(`${file}: every site link and every file it loads is a real file of public/, every #anchor a real id, and there is no empty or script link`, () => {
      const idsOf = (page: string) => new Set(Array.from(dom(page).querySelectorAll("[id]")).map((e) => e.id));
      for (const { attr, value, tag } of references(file)) {
        expect(value, `${file} <${tag} ${attr}>`).not.toMatch(/^(#|javascript:|)$/i);
        if (/^https?:\/\//i.test(value)) {
          expect(value, `${file}: external ${value}`).toMatch(/^https:\/\/(urbanohn\.com\/|www\.tecnomovi\.com\/|fonts\.googleapis\.com|fonts\.gstatic\.com)/);
          continue;
        }
        expect(value, `${file}: ${value}`).toMatch(SITE_REF);
        const url = new URL(value, "https://gaming.example/");
        const target = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        expect(existsSync(path.join(PUBLIC, target)), `${file}: ${value} -> public/${target}`).toBe(true);
        if (url.hash && tag === "a") {
          const id = url.hash.slice(1);
          // The Score page builds its two sections (cartelera, historial) with its own script and documents arriving on either one from another
          // page ("from Home, 'Mis participaciones y premios'"); for those, the proof is that the page's source builds that very id.
          const builtByScript = target === "soccer-predictions.html" && (id === "historial" || id === "cartelera");
          const present = idsOf(target).has(id) || (builtByScript && read(target).includes(`id="${id}"`) && read(target).includes("hashTarget"));
          expect(present, `${file}: ${value} -> #${id} in ${target}`).toBe(true);
        }
      }
    });
  }

  it("headings never skip a level, on any page (h1, then h2, then h3)", () => {
    for (const file of ALL_PAGES) {
      const levels = Array.from(dom(file).querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => +h.tagName[1]);
      expect(levels[0], file).toBe(1);
      expect(levels.filter((l) => l === 1), file).toHaveLength(1);
      for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `${file} heading ${i}`).toBeLessThanOrEqual(1);
    }
  });

  it("the only links from the experience pages into the application are the two on the Score page (and the featured card's two, which exist only once the server says so)", () => {
    const APP = /host\.html|participant\.html|poker-(host|table)|trivia-playtest|quiz-playtest|become-a-host|competitions|soccer-predictions|community-voting|\/api\//;
    for (const file of ALL_PAGES) {
      const hits = references(file).filter((r) => r.tag === "a" && APP.test(r.value)).map((r) => r.value);
      expect(hits, file).toEqual(file === "score.html" ? ["/soccer-predictions.html", "/soccer-predictions.html#historial"] : []);
    }
  });

  it("each experience page is linked from the Home, links back to the Home's experiences, and lists NO other experience (the 'more experiences' blocks are gone)", () => {
    const home = links(dom("index.html").querySelector("main")!);
    for (const k of EXPERIENCES) expect(home.filter((h) => h === "/" + PAGE_FILE[k]), k).toHaveLength(1);
    for (const file of ALL_PAGES.slice(1)) {
      const d = dom(file);
      expect(d.querySelector("a.lp-back")!.getAttribute("href"), file).toBe("/#experiences");
      expect(d.querySelector(".lp-more, .lp-more-card"), file).toBeNull();
      expect(visibleText(d.body), file).not.toMatch(/Más experiencias|More experiences/);
      const others = links(d.querySelector("main")!).filter((h) => ALL_PAGES.slice(1).map((f) => "/" + f).includes(h));
      expect(others, file).toEqual([]);
    }
    for (const lang of [ES, EN]) expect(Object.keys(lang).filter((key) => key.startsWith("lp.common.more")), "no key is left for the removed block").toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------
// the experience pages
// ----------------------------------------------------------------------------------------------------------------------------
describe("the four experience pages", () => {
  for (const k of EXPERIENCES) {
    it(`${PAGE_FILE[k]}: its title, its one h1 (the experience's name), its lead, three steps, what is good to know, and the same frame as every other page`, () => {
      const doc = dom(PAGE_FILE[k]);
      expect(doc.title).toBe(ES[`lp.${k}.pageTitle`]);
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      expect(visibleText(doc.querySelector("h1")!)).toBe(ES[`home.xp.${k}.title`]);
      expect(visibleText(doc.querySelector(".xp-desc")!)).toBe(ES[`lp.${k}.lead`]);
      expect(doc.querySelector("meta[name=description]")!.getAttribute("content")!.length).toBeGreaterThan(30);
      expect(doc.documentElement.getAttribute("lang")).toBe("es");
      expect(doc.querySelector("link[rel=stylesheet][href='/experience.css']")).not.toBeNull();
      expect(doc.querySelectorAll("img.xp-art")).toHaveLength(1);
      expect(doc.querySelector("img.xp-art")!.getAttribute("alt")).toBe("");
      expect(doc.querySelectorAll("ol.lp-steps > li")).toHaveLength(3);
      expect(doc.querySelectorAll("ul.lp-know > li").length).toBeGreaterThanOrEqual(1);
    });
  }

  it("the header, the navigation and the footer are the same on all five pages (only the highlighted item differs)", () => {
    const frame = (file: string) => {
      const doc = dom(file);
      const nav = doc.querySelector("nav.primary-nav")!.cloneNode(true) as Element;
      nav.querySelectorAll("a").forEach((a) => { a.removeAttribute("aria-current"); a.classList.remove("is-active"); });
      return doc.querySelector("header.shell-header")!.outerHTML + nav.outerHTML + doc.querySelector("footer")!.outerHTML;
    };
    const home = frame("index.html");
    for (const file of ALL_PAGES.slice(1)) expect(frame(file), file).toBe(home);
  });

  it("the URBANO Voting page states what is true and nothing more: no prize, sponsor, fee, capacity or rule is invented; the Halloween block repeats the featured card's two buttons", () => {
    const all = Object.entries(ES).filter(([key]) => key.startsWith("lp.voting.") || key.startsWith("home.feat.") || key.startsWith("home.xp.voting.")).map(([, v]) => v).join(" | ");
    expect(all).not.toMatch(/premio|prize|gratis|free|\$|L\.\s?\d|lempira|patrocin|sponsor|capacidad|capacity/i);
    const doc = dom("voting.html");
    const block = doc.getElementById("featured-live")!;
    expect(block).not.toBeNull();
    expect(Array.from(block.querySelectorAll("[data-feat]")).map((b) => [b.tagName, b.getAttribute("data-feat"), visibleText(b)])).toEqual([["SPAN", "vote", ES["home.feat.vote"]], ["SPAN", "join", ES["home.feat.join"]]]);
    expect(block.querySelectorAll("a")).toHaveLength(0);
    expect(visibleText(block.querySelector("[data-feat-status]")!)).toBe(ES["home.feat.status.default"]);
    expect(HTML["voting.html"]).toContain('<script src="/featuredContest.js"></script>');
  });

  it("Score names the access it already has (cartelera, historial) with the words the application already uses; the other three have no link into any flow", () => {
    const doc = dom("score.html");
    const hero = Array.from(doc.querySelectorAll(".xp--hero a")).map((a) => [a.getAttribute("href"), visibleText(a)]);
    expect(hero).toEqual([["/soccer-predictions.html", "Ver cartelera de Score"], ["/soccer-predictions.html#historial", "Mis participaciones y premios"]]);
    expect(ES["lp.score.know1"]).toBe(ES["home.upcoming.note"]);
    expect(ES["lp.score.cta.lineup"]).toBe(ES["home.upcoming.play"]);
    expect(ES["lp.score.cta.history"]).toBe(ES["home.upcoming.past"]);
    for (const k of ["voting", "trivia", "poker"] as const) expect(dom(PAGE_FILE[k]).querySelectorAll(".xp--hero a"), k).toHaveLength(0);
  });

  it("Trivia, Poker and Voting name no club, league, sponsor or venue other than the featured card's (a crest or a team is never implied)", () => {
    for (const k of ["voting", "trivia", "poker"] as const) {
      const text = Object.entries(ES).filter(([key]) => key.startsWith(`lp.${k}.`) || key.startsWith(`home.xp.${k}.`)).map(([, v]) => v).join(" | ");
      expect(text, k).not.toMatch(/\b(real madrid|barcelona|manchester|arsenal|olimpia|motagua|bayern|psg|mundial|champions|fifa|uefa|the pub|beer box)\b|\bliga\b|\binter\b/i);
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------------------
// the language table
// ----------------------------------------------------------------------------------------------------------------------------
describe("the language table of the five pages", () => {
  const SAME_IN_BOTH = new Set([
    "home.xp.voting.title", "home.xp.score.title", "home.xp.trivia.title", "home.xp.poker.title",
    "lp.voting.pageTitle", "lp.score.pageTitle", "lp.trivia.pageTitle", "lp.poker.pageTitle",
    "home.feat.product", "home.feat.title", "home.feat.venue",
  ]);

  it("every key a page uses exists in Spanish and in English, and the Spanish default written in the markup is EXACTLY the table's Spanish", () => {
    for (const file of ALL_PAGES) {
      const doc = dom(file);
      const problems: string[] = [];
      for (const el of Array.from(doc.querySelectorAll("[data-i18n]"))) {
        const key = el.getAttribute("data-i18n")!;
        if (!(key in ES)) problems.push(`${key}: not in the Spanish table`);
        else if (!(key in EN) || EN[key].trim() === "") problems.push(`${key}: not in the English table`);
        else if (el.textContent !== ES[key]) problems.push(`${key}: markup says «${el.textContent}», table says «${ES[key]}»`);
      }
      for (const el of Array.from(doc.querySelectorAll("[data-i18n-attr]"))) {
        for (const pair of el.getAttribute("data-i18n-attr")!.split(";")) {
          const [attr, key] = [pair.slice(0, pair.indexOf(":")).trim(), pair.slice(pair.indexOf(":") + 1).trim()];
          if (!(key in ES) || !(key in EN)) problems.push(`${attr}:${key}: missing`);
          else if (el.getAttribute(attr) !== ES[key]) problems.push(`${attr}:${key}: markup says «${el.getAttribute(attr)}»`);
        }
      }
      expect(problems, file).toEqual([]);
    }
  });

  it("every new key is translated (English differs from Spanish except the names that are the same in both), with the same placeholders", () => {
    const keys = Object.keys(ES).filter((key) => key.startsWith("home.xp.") || key.startsWith("home.feat.") || key.startsWith("lp."));
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) {
      expect(EN[key], key).toBeTruthy();
      if (!SAME_IN_BOTH.has(key)) expect(EN[key], `${key} is untranslated`).not.toBe(ES[key]);
      const names = (s: string) => Array.from(s.matchAll(/\{(\w+)\}/g)).map((m) => m[1]).sort();
      expect(names(EN[key]), key).toEqual(names(ES[key]));
    }
  });

  const PREFIXES: Record<string, string[]> = {
    "index.html": ["shell.", "home.", "auth.", "upcoming."],
    "voting.html": ["shell.", "auth.", "home.xp.", "home.feat.", "lp.common.", "lp.voting."],
    "score.html": ["shell.", "auth.", "home.xp.", "lp.common.", "lp.score."],
    "trivia.html": ["shell.", "auth.", "home.xp.", "lp.common.", "lp.trivia."],
    "poker.html": ["shell.", "auth.", "home.xp.", "lp.common.", "lp.poker."],
  };
  for (const file of ALL_PAGES) {
    it(`${file}: the generated Spanish fallback holds exactly the module's Spanish keys of its prefixes, with exactly the module's words, and t() agrees for every key`, () => {
      const m = HTML[file].match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/);
      expect(m, "carries the block").not.toBeNull();
      const sandbox: any = { document: { querySelectorAll: () => [] } };
      sandbox.window = sandbox;
      vm.runInNewContext(m![1], sandbox);
      const fallback = sandbox.UrbanoI18n;
      const expected = Object.fromEntries(Object.entries(ES).filter(([key]) => PREFIXES[file].some((p) => key.startsWith(p))));
      expect(fallback.dictionary().es).toEqual(expected);
      for (const key of Object.keys(expected)) expect(fallback.t(key), key).toBe(moduleApi.t(key));
      expect(fallback.getLang()).toBe("es");
    });
  }
});

// ----------------------------------------------------------------------------------------------------------------------------
// the featured card's module: the way into the voting appears only when the server says there is one
// ----------------------------------------------------------------------------------------------------------------------------
describe("the featured card (/featuredContest.js): the two buttons become links only when the server's answer is exactly the documented one", () => {
  const ENDPOINT = "/api/gaming/community-voting/contests/featured";
  const ID = "4f6c2a1e-8d3b-4c7a-9e55-0a1b2c3d4e5f";
  const OTHER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const VOTE_URL = `/community-voting-round.html?c=${ID}`;
  const JOIN_URL = `${VOTE_URL}&participar=1`;
  // The answer as the voting lane's server documents it (getFeaturedContest): the contest's id, its page (url / voteUrl), the same page opened on the contestant's
  // registration (registerUrl), the contest's phase, where registration stands, the categories, and fields this page ignores (serverNow, timeZone, prizePromise).
  const FEATURED = (over: Record<string, unknown> = {}) => ({
    featured: {
      contestId: ID, url: VOTE_URL, voteUrl: VOTE_URL, registerUrl: JOIN_URL, phase: "OPEN", serverNow: "2026-10-31T20:00:00Z", timeZone: "America/Tegucigalpa",
      registration: { phase: "CLOSED", opensAt: "2026-10-31T23:00:00Z", closesAt: "2026-11-01T01:00:00Z" },
      categories: [
        { key: "MOST_ELABORATE", name: { es: "Disfraz más elaborado", en: "Most elaborate costume" }, phase: "OPEN" },
        { key: "BEST_GROUP", name: { es: "Mejor disfraz en grupo", en: "Best group costume" }, phase: "OPEN" },
      ],
      prizePromise: { es: "ignored", en: "ignored" }, ...over,
    },
  });
  const closers: Array<() => void> = [];
  afterEach(() => { while (closers.length) closers.pop()!(); });

  const WHERE = { home: { file: "index.html", root: "featured-contest" }, voting: { file: "voting.html", root: "featured-live" } } as const;
  async function open(where: keyof typeof WHERE, answer: unknown, opts: { module?: boolean; lang?: "es" | "en" } = {}) {
    const w = new JSDOM(htmlOf(WHERE[where].file), { url: "https://gaming.example/" + WHERE[where].file, runScripts: "outside-only", pretendToBeVisual: true }).window as any;
    closers.push(() => w.close());
    const calls: Array<{ url: string; init: any }> = [];
    w.fetch = vi.fn((url: string, init: any) => {
      calls.push({ url, init });
      const a = typeof answer === "function" ? (answer as any)() : answer;
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a);
    });
    if (opts.module === false) w.eval(/<script id="i18n-fallback">([\s\S]*?)<\/script>/.exec(htmlOf(WHERE[where].file))![1]);
    else w.eval(I18N_SOURCE);
    if (opts.lang === "en") w.UrbanoI18n.setLang("en");
    w.eval(FEATURED_SOURCE);
    const root = w.document.getElementById(WHERE[where].root) as HTMLElement;
    w.UrbanoFeaturedContest.bind(root);
    await tick(); await tick();
    return { w, doc: w.document as Document, root, calls };
  }
  const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  const state = (root: HTMLElement) => ({
    buttons: Array.from(root.querySelectorAll("[data-feat]")),
    status: root.querySelector("[data-feat-status]") as HTMLElement,
    cats: root.querySelector("[data-feat-cats]") as HTMLElement,
    anchors: Array.from(root.querySelectorAll("a")),
  });
  /** The sentence under the buttons: while voting has not opened, where registration stands (when the server says), then where voting stands. */
  const sentence = (lang: Record<string, string>, phase: string, registration?: string) =>
    [phase === "NOT_OPEN" && registration && registration !== "NOT_SCHEDULED" ? lang[`home.feat.reg.${registration}`] : "", lang[`home.feat.status.${phase}`]].filter(Boolean).join(" ");
  const informational = (root: HTMLElement) => {
    const s = state(root);
    expect(s.anchors).toHaveLength(0);
    expect(s.buttons.map((b) => b.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(s.cats.hidden).toBe(true);
    expect(s.status.getAttribute("data-i18n")).toBe("home.feat.status.default");
    expect(s.status.textContent).toBe(ES["home.feat.status.default"]);
  };

  for (const where of ["home", "voting"] as const) {
    describe(`on the ${where === "home" ? "Home's featured card" : "URBANO Voting page"}`, () => {
      it("asks the server exactly once, with a plain GET to the one documented address, without credentials and without a cache", async () => {
        const { calls } = await open(where, json({ featured: null }));
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(ENDPOINT);
        expect(calls[0].init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
      });

      const NOTHING: Array<[string, unknown]> = [
        ["the operator has listed no contest ({ featured: null })", json({ featured: null })],
        ["the network fails", new Error("offline")],
        ["a 404 (the endpoint is not deployed)", json({ error: "x" }, 404)],
        ["a 500", json({ error: "x" }, 500)],
        ["a body that is not JSON", { ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) }],
        ["an empty object", json({})],
        ["null", json(null)],
        ["an array", json([FEATURED()])],
        ["a featured value that is not an object", json({ featured: "yes" })],
        ["the old shape: a single url and no voteUrl / registerUrl", json(FEATURED({ voteUrl: undefined, registerUrl: undefined }))],
        ["no voteUrl", json(FEATURED({ voteUrl: undefined }))],
        ["no registerUrl", json(FEATURED({ registerUrl: undefined }))],
        ["a voteUrl that is not text", json(FEATURED({ voteUrl: 7 }))],
        ["a voteUrl to another site", json(FEATURED({ voteUrl: `https://evil.example/community-voting-round.html?c=${ID}` }))],
        ["a registerUrl to another site", json(FEATURED({ registerUrl: `https://evil.example${JOIN_URL}` }))],
        ["a protocol-relative voteUrl", json(FEATURED({ voteUrl: `//evil.example/community-voting-round.html?c=${ID}` }))],
        ["a protocol-relative registerUrl", json(FEATURED({ registerUrl: `//evil.example${JOIN_URL}` }))],
        ["a script voteUrl", json(FEATURED({ voteUrl: "javascript:alert(1)" }))],
        ["a script registerUrl", json(FEATURED({ registerUrl: "javascript:alert(1)" }))],
        ["a voteUrl to another page of the site", json(FEATURED({ voteUrl: "/host.html" }))],
        ["a registerUrl to another page of the site", json(FEATURED({ registerUrl: "/host.html?participar=1" }))],
        ["the voting page without a contest id", json(FEATURED({ voteUrl: "/community-voting-round.html" }))],
        ["the registration page without a contest id", json(FEATURED({ registerUrl: "/community-voting-round.html?participar=1" }))],
        ["a voteUrl with an id that is not an id", json(FEATURED({ voteUrl: "/community-voting-round.html?c=1" }))],
        ["a voteUrl with extra parameters", json(FEATURED({ voteUrl: `${VOTE_URL}&x=1` }))],
        ["a voteUrl that is the registration page (the two buttons swapped)", json(FEATURED({ voteUrl: JOIN_URL }))],
        ["a registerUrl that is the voting page (no &participar=1)", json(FEATURED({ registerUrl: VOTE_URL }))],
        ["a registerUrl with extra parameters", json(FEATURED({ registerUrl: `${JOIN_URL}&x=1` }))],
        ["a registerUrl with &participar=2", json(FEATURED({ registerUrl: `${VOTE_URL}&participar=2` }))],
        ["the two buttons about two different contests", json(FEATURED({ registerUrl: `/community-voting-round.html?c=${OTHER_ID}&participar=1` }))],
        ["a contestId that is another contest", json(FEATURED({ contestId: OTHER_ID }))],
        ["a contestId that is not text", json(FEATURED({ contestId: 12 }))],
        ["a contest with no category (an empty list)", json(FEATURED({ categories: [] }))],
        ["a contest with no category list at all", json(FEATURED({ categories: undefined }))],
        ["a category list that is not a list", json(FEATURED({ categories: "none" }))],
        ["an unknown phase", json(FEATURED({ phase: "SOON" }))],
        ["a phase in lower case", json(FEATURED({ phase: "open" }))],
        ["a phase that is not text", json(FEATURED({ phase: 1 }))],
        ["a phase that is an Object.prototype name", json(FEATURED({ phase: "constructor" }))],
      ];
      for (const [label, answer] of NOTHING) {
        it(`leaves the two buttons as written, with no link at all, when the answer is: ${label}`, async () => {
          const { root } = await open(where, answer);
          informational(root);
        });
      }

      for (const phase of ["NOT_OPEN", "OPEN", "CLOSED", "RESULTS"] as const) {
        it(`${phase}: the vote button goes to the contest's page, the participate button to the same page opened on the registration, the sentence says where things stand, the categories are listed, in Spanish and then in English`, async () => {
          const { w, root } = await open(where, json(FEATURED({ phase })));
          const dest = w.UrbanoFeaturedContest.destinations(w.UrbanoFeaturedContest.validate(FEATURED({ phase })));
          expect(dest).toEqual({ vote: VOTE_URL, join: JOIN_URL });
          let s = state(root);
          expect(s.buttons.map((b) => [b.tagName, b.getAttribute("data-feat"), b.getAttribute("href"), visibleText(b)])).toEqual([
            ["A", "vote", VOTE_URL, ES["home.feat.vote"]], ["A", "join", JOIN_URL, ES["home.feat.join"]],
          ]);
          expect(s.anchors).toHaveLength(2); // the only links in the block
          expect(s.buttons.map((b) => b.className)).toEqual(["xf-btn is-primary", "xf-btn is-secondary"]);
          expect(s.status.hasAttribute("data-i18n")).toBe(false); // the page now owns this text; the module must not overwrite it
          expect(s.status.textContent).toBe(sentence(ES, phase, "CLOSED"));
          expect(Array.from(s.cats.children).map((li) => li.textContent)).toEqual(["Disfraz más elaborado", "Mejor disfraz en grupo"]);
          expect(s.cats.hidden).toBe(false);
          w.UrbanoI18n.setLang("en"); // the links re-translate themselves (data-i18n), the sentence and the categories are redrawn
          s = state(root);
          expect(s.buttons.map((b) => visibleText(b))).toEqual([EN["home.feat.vote"], EN["home.feat.join"]]);
          expect(s.anchors).toHaveLength(2);
          expect(s.status.textContent).toBe(sentence(EN, phase, "CLOSED"));
          expect(Array.from(s.cats.children).map((li) => li.textContent)).toEqual(["Most elaborate costume", "Best group costume"]);
          expect(s.cats.getAttribute("aria-label")).toBe(EN["home.feat.categories"]);
        });
      }

      for (const registration of ["NOT_SCHEDULED", "NOT_OPEN", "OPEN", "CLOSED"] as const) {
        it(`registration ${registration}: while voting has not opened the sentence says where registration stands${registration === "NOT_SCHEDULED" ? " only when the server says (here it does not)" : ""}; once voting is open (or over) it says only where voting stands; the two buttons are links either way`, async () => {
          for (const phase of ["NOT_OPEN", "OPEN", "CLOSED", "RESULTS"] as const) {
            const { root, w } = await open(where, json(FEATURED({ phase, registration: { phase: registration, opensAt: null, closesAt: null } })));
            expect(state(root).anchors.map((a) => a.getAttribute("href")), `${registration}/${phase}`).toEqual([VOTE_URL, JOIN_URL]);
            expect(state(root).status.textContent, `${registration}/${phase} es`).toBe(sentence(ES, phase, registration));
            w.UrbanoI18n.setLang("en");
            expect(state(root).status.textContent, `${registration}/${phase} en`).toBe(sentence(EN, phase, registration));
          }
          // the sentences themselves: registration is one sentence of its own, never merged into the voting one
          expect(sentence(ES, "NOT_OPEN", "OPEN")).toBe("Las inscripciones están abiertas. La votación se abre pronto.");
          expect(sentence(ES, "OPEN", "OPEN")).toBe("La votación está abierta.");
        });
      }

      it("an answer without a registration (an older server), or with a registration word it does not know, still links both buttons and says nothing about registration", async () => {
        for (const registration of [undefined, null, {}, { phase: "SOON" }, { phase: 3 }, { phase: "constructor" }, "OPEN"]) {
          const { root } = await open(where, json(FEATURED({ phase: "NOT_OPEN", registration })));
          expect(state(root).anchors.map((a) => a.getAttribute("href")), JSON.stringify(registration)).toEqual([VOTE_URL, JOIN_URL]);
          expect(state(root).status.textContent, JSON.stringify(registration)).toBe(ES["home.feat.status.NOT_OPEN"]);
        }
      });

      it("draws in the language chosen before the answer arrives", async () => {
        const { root } = await open(where, json(FEATURED()), { lang: "en" });
        const s = state(root);
        expect(s.status.textContent).toBe(EN["home.feat.status.OPEN"]);
        expect(s.buttons.map((b) => visibleText(b))).toEqual([EN["home.feat.vote"], EN["home.feat.join"]]);
      });

      it("what the server sends is text: markup in a category name is shown as characters, never built into elements", async () => {
        const evil = { key: "X", name: { es: '<img src=x onerror="window.pwned=1">', en: "<b>bold</b>" } };
        const { w, root } = await open(where, json(FEATURED({ categories: [evil] })));
        const s = state(root);
        expect(s.cats.children).toHaveLength(1);
        expect(s.cats.querySelector("img, b")).toBeNull();
        expect(s.cats.textContent).toBe(evil.name.es);
        expect(w.pwned).toBeUndefined();
      });

      it("keeps only well-formed categories, at most eight; when none of them is well-formed the two links are still drawn (the contest has categories) and the list stays hidden", async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ key: `K${i}`, name: { es: `Categoría ${i}`, en: `Category ${i}` } }));
        const junk = [null, 5, { name: null }, { name: { es: "x" } }, { name: { es: "", en: "" } }, { name: { es: "a".repeat(81), en: "b" } }];
        // the junk is skipped and the first eight well-formed names are kept
        let r = await open(where, json(FEATURED({ categories: [...junk, ...many] })));
        expect(Array.from(state(r.root).cats.children).map((li) => li.textContent)).toEqual(many.slice(0, 8).map((c) => c.name.es));
        r = await open(where, json(FEATURED({ categories: junk })));
        expect(state(r.root).anchors).toHaveLength(2);
        expect(state(r.root).cats.hidden).toBe(true);
      });

      it("works without the language module: the generated Spanish fallback draws the same sentence and links", async () => {
        const { root } = await open(where, json(FEATURED()), { module: false });
        const s = state(root);
        expect(s.status.textContent).toBe(ES["home.feat.status.OPEN"]);
        expect(s.buttons.map((b) => [b.tagName, b.getAttribute("href"), visibleText(b)])).toEqual([["A", VOTE_URL, ES["home.feat.vote"]], ["A", JOIN_URL, ES["home.feat.join"]]]);
        expect(Array.from(s.cats.children).map((li) => li.textContent)).toEqual(["Disfraz más elaborado", "Mejor disfraz en grupo"]);
      });
    });
  }

  it("the module sends nothing and stores nothing: no POST, no form, no storage, no cookie, no markup built from the answer, and exactly one fetch", () => {
    expect(FEATURED_SOURCE).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)|FormData|localStorage|sessionStorage|document\.cookie|innerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(FEATURED_SOURCE.match(/\bfetch\(/g)).toHaveLength(1);
    expect(FEATURED_SOURCE).toContain(`"${ENDPOINT}"`);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------
// the CSS contract of the layout
// ----------------------------------------------------------------------------------------------------------------------------
describe("the layout contract (experience.css)", () => {
  const block = (source: string, header: string) => {
    const start = source.indexOf(header);
    expect(start, header).toBeGreaterThanOrEqual(0);
    let depth = 0, i = source.indexOf("{", start);
    const from = i;
    for (; i < source.length; i++) { if (source[i] === "{") depth++; else if (source[i] === "}" && --depth === 0) break; }
    return source.slice(from + 1, i);
  };

  it("one column by default, two wide cards side by side from 900 px; a stacked card (the whole picture, then the words) up to 640 px", () => {
    expect(block(CSS, ".xp-grid {")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(block(CSS, "@media (min-width: 900px)")).toMatch(/\.xp-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    const phone = block(CSS, "@media (max-width: 640px)");
    expect(phone).toMatch(/\.xp-art\s*\{[^}]*position:\s*relative;[^}]*aspect-ratio:\s*16\s*\/\s*9/); // the whole picture, not a crop of it
    expect(phone).toMatch(/\.xp,\s*\.xp--hero\s*\{[^}]*padding:\s*0/);
    expect(phone).toMatch(/\.xp-top\s*\{[^}]*position:\s*absolute/); // the kicker sits on the picture, the words below it
    expect(phone).toMatch(/\.xf-art\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(CSS).not.toMatch(/repeat\(4,\s*minmax/); // no four-column row any more
  });

  it("the whole panel is the tap target (the link's pseudo-element covers it, with NO border radius of its own, so every corner answers), the button is at least 44 px high, and the focus ring is visible", () => {
    const before = block(CSS, ".xp-cta::before");
    expect(before).toMatch(/position:\s*absolute;[^}]*inset:\s*0/);
    expect(before).not.toMatch(/border-radius/); // found in the real-browser check: inheriting the pill's radius left the corners of a panel dead
    expect(block(CSS, ".xp {")).toMatch(/position:\s*relative/);
    expect(block(CSS, ".xp-cta {")).toMatch(/min-height:\s*46px/);
    expect(block(CSS, ".xf-btn {")).toMatch(/min-height:\s*48px/);
    expect(CSS).toMatch(/\.xp-cta:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--gold\)/);
    expect(CSS).toMatch(/\.xf-btn:focus-visible/);
  });

  it("motion is a pointer-device refinement and is switched off for people who ask for less", () => {
    expect(block(CSS, "@media (hover: hover) and (prefers-reduced-motion: no-preference)")).toMatch(/\.xp:hover/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition:\s*none/);
    expect(CSS).not.toMatch(/@keyframes|animation\s*:/);
  });

  it("the shell keeps its 44 px touch targets and the sign-in control is never broken mid-word or wider than the header", () => {
    expect(block(CSS, ".signin-btn {")).toMatch(/white-space:\s*nowrap/);
    expect(block(CSS, ".signin-btn {")).toMatch(/max-width:\s*100%/);
    expect(block(CSS, ".lang-switch button {")).toMatch(/min-height:\s*44px/);
    expect(block(CSS, "@media (max-width: 640px)")).toMatch(/\.signin-btn\s*\{[^}]*min-height:\s*44px/);
    expect(block(CSS, "@media (max-width: 374px)")).toMatch(/\.shell-header\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("no button is filled with an accent colour: the panels' button, the pages' button and the featured card's live button are the shell's ivory pill", () => {
    expect(block(CSS, ".xp-cta {")).toMatch(/background:\s*var\(--primary-fill\)/);
    expect(block(CSS, ".lp-btn {")).toMatch(/background:\s*var\(--primary-fill\)/);
    expect(block(CSS, "a.xf-btn.is-primary {")).toMatch(/background:\s*var\(--primary-fill\)/);
    for (const k of EXPERIENCES) expect(ES[`home.xp.${k}.kicker`].length).toBeGreaterThan(3);
  });

  it("the featured card's two buttons, while they are not links, are words in a dashed outline (never a faded button), and the sentence under them says why", () => {
    const off = block(CSS, "span.xf-btn {");
    expect(off).toMatch(/border:\s*1\.5px dashed/);
    expect(off).toMatch(/cursor:\s*default/);
    expect(off).not.toMatch(/(^|[;\s])opacity\s*:/);
    expect(block(CSS, ".xf-status {")).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.9/);
    expect(block(CSS, ".xf-label {")).toMatch(/background:\s*var\(--accent\)/); // the one place an accent is a fill: a label, not a control
  });

  it("the strip in the Score panel: two rows of five in a wide card, one row of ten in a stacked card (a phone), five again at 320 px, and the names' own layout still wins when no crest is drawn", () => {
    const panel = (css: string) => css.match(/\.xp-teams \.ten-crests\s*\{[^}]*grid-template-columns:\s*repeat\((\d+)/g) ?? [];
    expect(panel(CSS).map((r) => Number(/repeat\((\d+)/.exec(r)![1]))).toEqual([5, 10, 5]);
    expect(block(CSS, "@media (max-width: 640px)")).toMatch(/\.xp-teams \.ten-crests\s*\{[^}]*repeat\(10/);
    expect(block(CSS, "@media (max-width: 339px)")).toMatch(/\.xp-teams \.ten-crests\s*\{[^}]*repeat\(5/);
    expect(CSS).toMatch(/\.xp-teams \.ten-crests:not\(:has\(\.club-crest\)\)\s*\{[^}]*repeat\(auto-fit,\s*minmax\(112px/);
    expect(block(CSS, ".xp-teams {")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.78\)/); // its own dark backing: the small words never depend on the picture behind them
  });

  it("a dark scrim sits between every picture and its words, strongest where the words are (the left of a wide card, the foot of the picture on a phone), and the picture shows at its own brightness", () => {
    expect(block(CSS, ".xp-art {")).toMatch(/z-index:\s*-2/);
    expect(block(CSS, ".xp-scrim {")).toMatch(/z-index:\s*-1/);
    expect(block(CSS, ".xp {")).toMatch(/isolation:\s*isolate/);
    const alphas = (gradient: string) => Array.from(gradient.matchAll(/rgba\(10,\s*10,\s*10,\s*([\d.]+)\)/g)).map((m) => Number(m[1]));
    const wide = block(CSS, ".xp-scrim {");
    expect(wide).toMatch(/linear-gradient\(90deg,/);
    const sideways = wide.slice(wide.indexOf("linear-gradient(90deg"), wide.indexOf("linear-gradient(0deg")); // the gradient that carries the words
    expect(alphas(sideways)[0]).toBeGreaterThanOrEqual(0.95); // darkest at the left, where the words are
    expect(alphas(sideways)[alphas(sideways).length - 1]).toBe(0); // and nothing at the right: the picture is not dimmed where there are no words
    expect(wide).not.toMatch(/background:\s*rgba\(/); // never one flat layer over the whole picture
    const stacked = block(CSS, ".xp-scrim, .xp--hero .xp-scrim {");
    expect(stacked).toMatch(/linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.9\d?\)\s*0,\s*rgba\(10,\s*10,\s*10,\s*0\)\s*55%\)/); // only a fade at the foot of the picture, which ends where the words begin
    expect(block(CSS, ".xf-scrim {")).toMatch(/linear-gradient\(90deg,/);
    // the picture itself is never faded, filtered or blended
    expect(block(CSS, ".xp-art {")).not.toMatch(/(^|[;\s])(opacity|filter|mix-blend-mode|mask|clip-path)\s*:/i);
    expect(block(CSS, ".xf-art {")).not.toMatch(/(^|[;\s])(opacity|filter|mix-blend-mode|mask|clip-path)\s*:/i);
  });

  it("words over a picture are ivory with a shadow, chips and kickers sit on their own dark fill, and nothing on a panel is faded (a state is carried by words, never by dimming)", () => {
    expect(block(CSS, ".xp-desc {")).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.9\d?\)/);
    expect(block(CSS, ".xp-desc {")).toMatch(/text-shadow:/);
    expect(block(CSS, ".xp-kicker, .xp-chip {")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\)/);
    expect(Number(/rgba\(245,\s*241,\s*232,\s*([\d.]+)\)/.exec(block(CSS, ".featured-legal {"))![1])).toBeGreaterThanOrEqual(0.8);
    const rules = Array.from(CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2] }));
    for (const { selector, body } of rules.filter((r) => /(^|[\s,.])xp(-|\s|,|$)|(^|[\s,.])xf(-|\s|,|$)|\.lp-|\.featured-|ten-crests/.test(r.selector))) expect(body, selector).not.toMatch(/(^|[;\s])opacity\s*:/i);
  });

  it("nothing scrolls sideways: every grid cell and panel can shrink, the grid uses minmax(0, 1fr), and the one strip that does scroll (the navigation) hides its bar", () => {
    expect(block(CSS, ".xp-grid > li {")).toMatch(/min-width:\s*0/);
    expect(block(CSS, ".xp {")).toMatch(/width:\s*100%/);
    expect(block(CSS, ".primary-nav {")).toMatch(/overflow-x:\s*auto/);
    expect(CSS).toMatch(/\.primary-nav::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });
});
