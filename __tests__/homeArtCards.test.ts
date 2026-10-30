import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The Home's editorial cards (Founder Design Review composition): URBANO Score as the featured art card (a neutral static entry — its name,
 * a descriptor and one link — over an original pitch drawn in code; the El Clásico promotion it carried expired and was removed by the
 * Founder's Home correction of 2026-10-29), URBANO Poker and Halloween / Community as art cards, Trivia as a visual card of its own, and
 * Rutas / Towers as recognizable Minigame tiles.
 *
 * What this pins: (1) the two photographs (Poker, Halloween) are the only photographs, small local WebP derivatives of the reviewed
 * artwork, each pinned by hash and weight; the two other images are original SVG drawings made in code, also pinned by hash and weight; (2) the art is decoration only, so no card gains an operational action, an availability claim, a reward or an event
 * from the mockup. The one event on the page is the Halloween costume contest, which the Founder authorized (gate of 2026-10-29) as a
 * static, informational announcement: its exact words, its date, and no link, no action, no prize, no vote and no fee; (3) availability stays exactly what it was (Poker keeps its destination and its Playtest label; everything else that
 * was informational stays informational); (4) the CSS contract that keeps text legible over a photograph and the page free of sideways
 * scrolling; (5) both languages.
 *
 * Limits, stated plainly: jsdom does not lay a page out or paint it. Legibility over the photographs was MEASURED in a real browser (WCAG
 * contrast of every text run on an art card or tile against the real rendered background, at 1280, 800 and 500 px, in both languages,
 * with and without an open match; see the candidate package), and the CSS values that measurement depended on are pinned below.
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
// The page without its explanatory comments: they may legitimately name the mockup or the retired Level 33 card.
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
const ASSET_DIR = path.join(ROOT, "public/assets/home");
const MATCHES_URL = "/api/gaming/predictions/matches";

// The Halloween costume-contest announcement: the exact public words, in the order the card reads. The Spanish is the Founder's text
// (gate of 2026-10-29) and the English is its faithful rendering, approved: the Founder's Home correction gate of 2026-10-29 names the
// Halloween copy "approved", in both languages, and tells this comment to stop saying otherwise. It announces that the contest exists and that
// nothing about it can be done yet: no registration, no voting, no rules, no prize, no sponsor, no capacity, no fee.
type HalloweenWords = { event: string; status: string; title: string; date: string; sub: string; availability: string };
const HALLOWEEN: { es: HalloweenWords; en: HalloweenWords } = {
  es: {
    event: "Halloween · Beer Box",
    status: "Próximamente",
    title: "Concurso de disfraces",
    date: "Sábado 31 de octubre",
    sub: "Mostrá tu disfraz y preparate para elegir tus favoritos. Próximamente publicaremos las reglas y los detalles de participación.",
    availability: "Las inscripciones y la votación todavía no están disponibles.",
  },
  en: {
    event: "Halloween · Beer Box",
    status: "Coming Soon",
    title: "Costume contest",
    date: "Saturday, October 31",
    sub: "Show off your costume and get ready to choose your favorites. We will publish the rules and participation details soon.",
    availability: "Registration and voting are not available yet.",
  },
};
// Every link on the Home, in page order, as measured on the page before the announcement existed (4fe7aa0): the announcement adds none.
const HOME_HREFS = [
  "https://urbanohn.com/", "/", "/profile.html", "/", "/#play", "/#experiences", "/leaderboards.html", "/rewards.html",
  "/soccer-predictions.html", "/host.html?experience=poker", "/trivia-playtest.html", "/legal.html", "https://www.tecnomovi.com/",
];

// Provenance.
//  - Poker and Halloween: derivatives of original images generated for URBANO Gaming and archived with their prompt and hash in the
//    Founder Design Review package (Assets/Artwork, "Artwork prompts and provenance.json", status PROPOSED_EDITORIAL_ART_NOT_PRODUCT_RULES):
//    the source resized to 1280x720 and encoded as lossy WebP (quality 72). "Level 33 board.png" is deliberately NOT here.
//  - URBANO Score: an original, schematic pitch (touchlines, halfway line, centre circle, penalty and goal areas) drawn in code for this
//    page: no photograph, no crest, no mark, no third-party material: public/assets/home/urbano-score-pitch.svg. It REPLACES a stadium
//    photograph for which no provenance record exists; that photograph is not published, and this file pins that it is not in the tree.
//  - Trivia: an original line motif drawn in code for this page (no third-party material): public/assets/home/trivia-card.svg.
const ASSETS: Record<string, { sourceSha256?: string; sha256: string; maxBytes: number; width?: number; height?: number }> = {
  "halloween-community.webp": {
    sourceSha256: "19934289111eea1de6aec1c278f6b1e37220eac51b1cdad769068f6ce547630d", // "Halloween voting.png"
    sha256: "da5e0c07c070abd55abe0beb245d0d687eb41db71502dfff5da682d3effd2043",
    maxBytes: 70_000, width: 1280, height: 720,
  },
  "urbano-poker.webp": {
    sourceSha256: "1eceeddc032f0449eed0daf69ee03f1bccd0960882f6ae33cd999cfc305ed6a1", // "Poker table.png"
    sha256: "af905a88c371277ccafdf0016186cdca8223b7d478ff91fe0ba4c5f99563d892",
    maxBytes: 70_000, width: 1280, height: 720,
  },
  "urbano-score-pitch.svg": { sha256: "5e21568909a5cfa6c4a5c8285f3bdd288f2e8e030915793fd484354fe9dedc8d", maxBytes: 6_000 },
  "trivia-card.svg": { sha256: "90ccc0837f06a9a192d5622080a35df3ead7381903c81d46aa3516fe7f14e210", maxBytes: 6_000 },
};
const PHOTOS = Object.keys(ASSETS).filter((n) => n.endsWith(".webp"));
const DRAWINGS = Object.keys(ASSETS).filter((n) => n.endsWith(".svg"));
const TOTAL_PHOTO_BUDGET_BYTES = 150_000;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

async function loadHome(html: string = INDEX_HTML, opts: { matches?: unknown[]; stored?: "es" | "en" } = {}) {
  const dom = new JSDOM(html, {
    url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      if (opts.stored) w.localStorage.setItem("urbano.lang", opts.stored);
      Object.defineProperty(w.navigator, "language", { value: "en-US", configurable: true });
      Object.defineProperty(w.navigator, "languages", { value: ["en-US"], configurable: true });
      w.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped module is evaluated, as the script tag would
      w.UrbanoAuth = { attachSignInButton: () => {} };
      w.fetch = async (url: string) => (String(url) === MATCHES_URL ? { status: 200, json: async () => ({ matches: opts.matches ?? [] }) } : { status: 404, json: async () => ({}) });
    },
  });
  closers.push(() => dom.window.close());
  await tick();
  const win = dom.window as any;
  const doc = win.document as Document;
  // (the Halloween announcement is a static card near the top of the page, so its title is an h2; every catalog card's is an h3)
  const card = (title: string) => Array.from(doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h2, h3")?.textContent === title) as HTMLElement | undefined;
  return { win, doc, card, text: (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim() };
}
type Page = Awaited<ReturnType<typeof loadHome>>;

// Everything that must stay true of the rendered Home, as a list of violations (empty = honest). The same list is used to show that
// each protection is real: a mutated COPY of the page must produce the violation its protection exists to prevent.
function violations(page: Page): string[] {
  const out: string[] = [];
  const { doc, card } = page;
  const poker = card("URBANO Poker");
  if (!poker || poker.tagName !== "A" || poker.getAttribute("href") !== "/host.html?experience=poker" || !/Playtest/i.test(poker.textContent ?? "")) out.push("poker access or Playtest label changed");
  for (const title of ["Concurso de disfraces", "URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]) {
    if ((title === "Ser anfitrión" || title === "Concurso de disfraces") && !card(title)) continue; // (named in English in the English page; the Spanish tests pin them)
    const c = card(title);
    if (!c) { out.push(`${title} card missing`); continue; }
    if (c.tagName !== "DIV" || !c.className.includes("is-locked") || c.hasAttribute("href")) out.push(`${title} is not informational`);
    if (c.querySelector("a, button, [tabindex], [onclick], input, form")) out.push(`${title} gained an operational element`);
    if (!/Próximamente|Coming Soon/.test(c.textContent ?? "")) out.push(`${title} lost its Próximamente state`);
  }
  const imgs = Array.from(doc.querySelectorAll("img.art-img")) as HTMLImageElement[];
  if (imgs.length !== 2) out.push(`expected exactly 2 art images (Poker, Halloween), found ${imgs.length}`);
  for (const img of imgs) {
    if (img.getAttribute("alt") !== "") out.push("an art image is not decorative (alt must be empty)");
    if (img.getAttribute("loading") !== "lazy") out.push("an art image is not lazy-loaded");
    if (!img.getAttribute("width") || !img.getAttribute("height")) out.push("an art image has no intrinsic size");
    if (!/^\/assets\/home\/[a-z-]+\.webp$/.test(img.getAttribute("src") ?? "")) out.push("an art image does not come from /assets/home");
  }
  for (const scrim of Array.from(doc.querySelectorAll(".art-scrim"))) if (scrim.getAttribute("aria-hidden") !== "true") out.push("a scrim is announced");
  if (doc.querySelector("#featured-predictions img, #featured-predictions svg")) out.push("the featured card contains an element image");
  if (Array.from(doc.querySelectorAll("a[href]")).some((a) => /rutas|towers|race|pulse|competitions|quiz/i.test(a.getAttribute("href") ?? ""))) out.push("a link points at Rutas, Towers, Race, Pulse, Competitions or Quiz");
  const trivia = card("Trivia");
  if (!trivia || trivia.tagName !== "A" || trivia.getAttribute("href") !== "/trivia-playtest.html" || !/Playtest/i.test(trivia.textContent ?? "")) out.push("trivia access or Playtest label changed");
  if (trivia && trivia.querySelector("img, svg")) out.push("the Trivia card carries an element image (its art is a CSS background)");
  return out;
}

// A page's first paint: its HTML parsed with no script run (the words the markup itself carries).
function staticDoc(html: string): Document {
  const dom = new JSDOM(html);
  closers.push(() => dom.window.close());
  return dom.window.document;
}

// What must stay true of the Score entry (the featured card), as a list of violations (empty = honest): its name, a descriptor and ONE link into
// URBANO Score, in the Spanish words of the markup — no status pill, crest, match, venue, date, hour, window, number or control. `structureOnly`
// leaves the words aside (a loaded page may be showing English), keeping every structural rule.
function scoreEntryViolations(doc: Document, options: { structureOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  const card = doc.querySelector("#featured-predictions") as HTMLElement | null;
  if (!card) return ["the Score entry is missing"];
  const links = Array.from(card.querySelectorAll("a"));
  if (links.length !== 1 || links[0].id !== "featured-play" || links[0].getAttribute("href") !== "/soccer-predictions.html") out.push("the Score entry does not have exactly one link, into URBANO Score");
  if (card.querySelector("button, form, input, select, textarea, [role=button], [tabindex], [onclick]")) out.push("the Score entry gained a control");
  if (card.querySelector(".status-pill, [id=featured-status], time, [data-club], .featured-crests, .featured-scope, .featured-when, .featured-window, img, svg")) out.push("the Score entry gained a status, a moment, a crest, a match line or an image");
  const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
  if (/\d/.test(text)) out.push("the Score entry carries a number");
  if (!options.structureOnly && text !== "URBANO Score Tus predicciones deportivas Abrir URBANO Score") out.push("the Score entry says something other than its name, descriptor and link");
  return out;
}

// What must stay true of the Halloween announcement, as a list of violations (empty = honest), for the words of one language.
function halloweenViolations(doc: Document, words: HalloweenWords): string[] {
  const out: string[] = [];
  const card = doc.querySelector("#halloween .exp-card") as HTMLElement | null;
  if (!card) return ["the Halloween card is missing"];
  if (card.tagName !== "DIV" || !card.className.includes("is-locked") || card.hasAttribute("href")) out.push("the Halloween card is not informational");
  // (the card itself is checked too: a card that became focusable, clickable or a link is as interactive as one that holds a button)
  const interactive = "a, button, input, select, textarea, form, label, [href], [tabindex], [onclick], [role]";
  if (card.matches(interactive) || card.querySelector(interactive)) out.push("the Halloween card gained an interactive element");
  const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text !== [words.event, words.status, words.title, words.date, words.sub, words.availability].join(" ")) out.push("the Halloween card says something other than the approved words");
  if (/premio|prize|ganad|ganá|winner|\bwins?\b|patrocin|sponsor|cupo|capacity|gratis|\bfree\b|\$|\bL\.?\s?\d|HNL|USD|entrada|ticket/i.test(text)) out.push("the Halloween card makes a prize, sponsor, capacity or price claim");
  if ((text.match(/\d+/g) ?? []).join(",") !== "31") out.push("the Halloween card carries a number other than the date");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The photographs
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — the photographs and the Trivia motif", () => {
  it("public/assets/home holds exactly the reviewed assets: two photographs and two code-drawn motifs; no Level 33 art, no stadium photograph, no multi-sport photograph, no PNG original", () => {
    expect(readdirSync(ASSET_DIR).sort()).toEqual(Object.keys(ASSETS).sort());
    expect(readdirSync(path.join(ROOT, "public/assets")).sort()).toEqual(["clubs", "home"]); // clubs: the two crests, covered by clubCrests.test.ts
    expect(readdirSync(ASSET_DIR).join(" ")).not.toMatch(/level|soccer-predictions|sports|stadium/i);
    expect(PHOTOS).toEqual(["halloween-community.webp", "urbano-poker.webp"]);
  });

  it("each photograph is a real WebP of its pinned size, matches its pinned hash, and the set is light enough not to delay the entries above the fold", () => {
    let total = 0;
    for (const name of PHOTOS) {
      const info = ASSETS[name];
      const file = path.join(ASSET_DIR, name);
      const bytes = readFileSync(file);
      total += bytes.length;
      expect(bytes.subarray(0, 4).toString("ascii"), name).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii"), name).toBe("WEBP");
      expect(bytes.subarray(12, 16).toString("ascii"), name).toBe("VP8 "); // lossy, no alpha, no embedded metadata chunk
      expect(bytes.readUInt16LE(26) & 0x3fff, `${name} width`).toBe(info.width);
      expect(bytes.readUInt16LE(28) & 0x3fff, `${name} height`).toBe(info.height);
      expect(statSync(file).size, `${name} weight`).toBeLessThanOrEqual(info.maxBytes);
      expect(createHash("sha256").update(bytes).digest("hex"), `${name} hash`).toBe(info.sha256);
      expect(info.sourceSha256, `${name} source`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(total).toBeLessThanOrEqual(TOTAL_PHOTO_BUDGET_BYTES);
  });

  it("each code-drawn motif (Trivia, and the Score pitch) is a tiny, self-contained, decorative SVG: no script, no external reference, no text, no embedded image, hidden from assistive technology", () => {
    expect(DRAWINGS.sort()).toEqual(["trivia-card.svg", "urbano-score-pitch.svg"]);
    for (const name of DRAWINGS) {
      const file = path.join(ASSET_DIR, name);
      const svg = readFileSync(file, "utf8");
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), name).toBe(ASSETS[name].sha256);
      expect(statSync(file).size, name).toBeLessThanOrEqual(ASSETS[name].maxBytes);
      expect(svg, name).not.toMatch(/<script|<foreignObject|<text|<image|<use|<style|xlink:href|href=|data:|javascript:|onload=|onclick=|@import|url\(\s*["']?https?:/i);
      expect(svg, name).toContain('aria-hidden="true"');
      expect(svg.match(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/), name).not.toBeNull();
    }
  });

  it("the stadium photograph without provenance is not published: not in the folder, not referenced by the page, the language module or any test fixture", () => {
    expect(readdirSync(ASSET_DIR)).not.toContain("urbano-score-stadium.webp");
    // What must not appear is any reference to a stadium image: no asset path, no image file, no background. (The Home no longer names a
    // stadium in text either; the Score entry is a name, a descriptor and a link.)
    const IMAGE_OF_A_STADIUM = /urbano-score-stadium|stadium[\w-]*\.(webp|jpe?g|png|avif|gif)|url\([^)]*stadium/i;
    expect(INDEX_HTML).not.toMatch(IMAGE_OF_A_STADIUM);
    expect(I18N_SOURCE).not.toMatch(IMAGE_OF_A_STADIUM);
    for (const file of ["public/profile.html", "public/soccer-predictions.html"]) expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(IMAGE_OF_A_STADIUM);
  });

  it("the page references exactly these four and nothing else: no other image file, no remote image, no preload", () => {
    // (the explanatory comments may name a file; what is referenced is what the code references)
    for (const name of Object.keys(ASSETS)) expect(CODE.split(`/assets/home/${name}`).length - 1, name).toBe(1);
    expect(CODE.match(/\/assets\/[^"')\s]+\.(?:webp|svg)/g)!.sort()).toEqual(Object.keys(ASSETS).map((n) => `/assets/home/${n}`).sort());
    expect(CODE.match(/\/assets\/[^"')\s]+\.(?!webp|svg)\w+/g) ?? []).toEqual([]);
    const imageRefs = CODE.match(/[\w/.-]+\.(png|jpe?g|gif|svg|webp|avif)\b/gi) ?? [];
    expect(imageRefs.filter((r) => !r.endsWith("urbano-mark.svg") && !r.startsWith("/assets/home/")).sort()).toEqual([]);
    expect(INDEX_HTML).not.toMatch(/(?:src|href)=["']https?:[^"']*\.(png|jpe?g|gif|svg|webp|avif)/i);
    expect(INDEX_HTML).not.toMatch(/url\(\s*["']?https?:/i);
    expect(INDEX_HTML).not.toMatch(/rel=["']preload["']/i);
    expect(CODE).not.toMatch(/level[-_ ]?33/i);
  });

  it("brings nothing from the prototype: no script, no illustrative data, no mockup class or navigation hook, no external script besides the three this page loads (the language module, the sign-in module and the host-availability reader) — the club crests module is not among them, the Home draws no crest", () => {
    expect(Array.from(INDEX_HTML.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1])).toEqual(["/urbanoI18n.js", "/urbanoAuth.js", "/hostAvailability.js"]);
    expect(CODE).not.toMatch(/\bug-[a-z-]+|data-jump|data-view|data-panel|Founder Design Review|DESIGN PROTOTYPE|Illustrative data|ACRE8M|Community Cup|Community Soccer/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Honest availability
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — decoration never changes what is available", () => {
  it("the rendered page is honest: URBANO Poker and Trivia keep their destination and Playtest label; Halloween, Rutas, Towers, Host and Competitions stay informational", async () => {
    expect(violations(await loadHome())).toEqual([]);
    expect(violations(await loadHome(INDEX_HTML, { stored: "en" }))).toEqual([]);
  });

  it("URBANO Poker: the whole art card is the one existing link, labelled Playtest, with the same wording and no new promise", async () => {
    const page = await loadHome();
    const poker = page.card("URBANO Poker")!;
    expect(poker.className).toContain("art-card");
    expect(poker.className).toContain("is-actionable");
    expect(page.doc.querySelectorAll('a[href="/host.html?experience=poker"]')).toHaveLength(1);
    expect(poker.querySelector(".status-pill")!.textContent).toBe("Playtest");
    expect(poker.querySelector(".exp-sub")!.textContent).toBe("Organizá una mesa privada de No-Limit Hold'em para tu grupo.");
    expect(poker.querySelector(".exp-action")!.textContent).toBe("Organizar →");
    expect(poker.querySelector("img")!.getAttribute("alt")).toBe("");
    // the picture says nothing about money: no betting, prize or currency words anywhere on the card, in either language
    expect(poker.textContent).not.toMatch(/apuest|bet|wager|prize|premio|dinero|money|cash|\$|L\.\s?\d|HNL|USD|rake/i);
  });

  it("Halloween costume contest: an informational announcement with the approved words, the event and the date, and no link, no action, no prize, no vote, no fee", async () => {
    const page = await loadHome();
    const halloween = page.doc.querySelector("#halloween .exp-card") as HTMLElement;
    expect(page.card("Concurso de disfraces")).toBe(halloween);
    expect(halloween.className).toContain("art-card");
    expect(halloween.className).toContain("art-halloween");
    expect(halloween.tagName).toBe("DIV");
    expect(halloween.querySelector(".art-kicker")!.textContent).toBe("Halloween · Beer Box");
    expect(halloween.querySelector(".status-pill")!.textContent).toBe("Próximamente"); // shown in capitals by the pill's own style
    expect(halloween.querySelector("h2")!.textContent).toBe("Concurso de disfraces");
    expect(halloween.querySelector(".halloween-date")!.textContent).toBe("Sábado 31 de octubre");
    expect(halloween.querySelector("time")).toBeNull(); // a plain date, not a moment: and the page has no machine-readable moment at all any more
    expect(INDEX_HTML).not.toMatch(/<time\b/);
    expect(halloween.querySelector(".exp-sub")!.textContent).toBe("Mostrá tu disfraz y preparate para elegir tus favoritos. Próximamente publicaremos las reglas y los detalles de participación.");
    expect(halloween.querySelector(".halloween-availability")!.textContent).toBe("Las inscripciones y la votación todavía no están disponibles.");
    expect(halloween.querySelector("a, button, input, [tabindex]")).toBeNull();
    expect(halloween.querySelector("img")!.getAttribute("src")).toBe("/assets/home/halloween-community.webp");
    expect(halloween.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(halloweenViolations(page.doc, HALLOWEEN.es)).toEqual([]);
    // the card is the only thing on the page about the contest: the old catalog card (which promised votes and a prize) is gone
    expect(page.doc.querySelectorAll("#experiences-carousel .art-halloween")).toHaveLength(0);
    expect(page.doc.body.textContent).not.toMatch(/conquistá los votos|más votado|se lleva un premio/);
  });

  it("Halloween costume contest: it is in the page's first paint, with no script, no session and no server", () => {
    // The HTML alone, scripts not run: what a visitor sees before anything loads, and what a crawler or a link preview reads.
    const dom = new JSDOM(INDEX_HTML, { url: "http://localhost/" });
    closers.push(() => dom.window.close());
    expect(halloweenViolations(dom.window.document, HALLOWEEN.es)).toEqual([]);
    // and the card's own markup depends on nothing: no script, no request, no session, no stored state
    expect(CODE.slice(CODE.indexOf('id="halloween"'), CODE.indexOf('id="featured-predictions"'))).not.toMatch(/<script|fetch\(|UrbanoAuth|localStorage|supabase/i);
  });

  it("Halloween costume contest: it needs no session and no server: the same card with every request failing and with a signed-out account", async () => {
    const dom = new JSDOM(INDEX_HTML, {
      url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(window) {
        const w = window as any;
        w.eval(I18N_SOURCE);
        w.UrbanoAuth = { attachSignInButton: () => {} };
        w.fetch = async () => { throw new Error("offline"); };
      },
    });
    closers.push(() => dom.window.close());
    await tick();
    expect(halloweenViolations(dom.window.document, HALLOWEEN.es)).toEqual([]);
  });

  it("the Home gained no link: every link is one the page already had, in the same order, and none leads to a vote, a registration or an identity page", async () => {
    const page = await loadHome();
    expect(Array.from(page.doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))).toEqual(HOME_HREFS);
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.getAttribute("href"))).toEqual(["/", "/#play", "/#experiences", "/leaderboards.html", "/rewards.html"]);
    expect(CODE).not.toMatch(/href=["'][^"']*(vot[ae]|voting|identity|inscri|registr|disfraz|costume|halloween)/i);
    expect(page.doc.querySelector("#halloween a, #halloween button, #halloween form")).toBeNull();
  });

  it("the announcement comes near the top: after the introduction and before everything else, the featured match included; no navigation was removed", async () => {
    const page = await loadHome();
    const at = (selector: string) => page.doc.querySelector(selector)!;
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
    for (const [first, second] of [[".primary-nav", ".hero"], [".hero", "#halloween"], ["#halloween", "#featured-predictions"], ["#featured-predictions", "#experiences"], ["#experiences", "#play"], ["#play", "#minigames"], ["#minigames", "#organizers"]]) {
      expect(before(at(first), at(second)), `${first} comes before ${second}`).toBe(true);
    }
    // the Score entry is untouched by the announcement: same single link
    expect(page.doc.querySelectorAll("#featured-predictions a")).toHaveLength(1);
    expect(page.doc.querySelectorAll("#halloween")).toHaveLength(1);
    expect(page.doc.querySelectorAll(".section")).toHaveLength(6); // the announcement, the Score entry, Experiences, Skill Games, Minigames, Organizers
  });

  it("reading order is the visual order, and the heading is a real heading: event, status, title, date, explanation, availability", async () => {
    const page = await loadHome();
    const card = page.doc.querySelector("#halloween .exp-card")!;
    const order = Array.from(card.querySelectorAll(".art-kicker, .status-pill, h2, .halloween-date, .exp-sub, .halloween-availability")).map((e) => (e.textContent ?? "").trim());
    expect(order).toEqual([HALLOWEEN.es.event, HALLOWEEN.es.status, HALLOWEEN.es.title, HALLOWEEN.es.date, HALLOWEEN.es.sub, HALLOWEEN.es.availability]);
    // one h1, the announcement's h2 comes before the featured match's h2, and nothing in the card can take focus
    expect(page.doc.querySelectorAll("h1")).toHaveLength(1);
    const h2s = Array.from(page.doc.querySelectorAll("h2")).map((h) => h.textContent);
    expect(h2s).toEqual(["Concurso de disfraces", "URBANO Score"]);
    expect(card.querySelector("[tabindex], a, button, input, select, textarea")).toBeNull();
  });

  it("Trivia: a visual card of its own whose art is a CSS background (no element), with its destination and Playtest label unchanged", async () => {
    const page = await loadHome();
    const trivia = page.card("Trivia")!;
    expect(trivia.className).toContain("art-trivia");
    expect(trivia.tagName).toBe("A");
    expect(trivia.getAttribute("href")).toBe("/trivia-playtest.html");
    expect(trivia.querySelector(".status-pill")!.textContent).toBe("Playtest");
    expect(trivia.querySelector("img, svg")).toBeNull();
    expect(trivia.querySelector(".exp-sub")!.textContent).toBe("Organizá o unite a una sesión en vivo — probá el playtest actual de Trivia.");
    expect(page.doc.querySelectorAll('a[href="/trivia-playtest.html"]')).toHaveLength(1);
  });

  it("Host and Competitions come last and stay informational: no journey is activated and no link to Competitions exists", async () => {
    const page = await loadHome();
    const organizers = Array.from(page.doc.querySelectorAll("#organizers-grid .exp-card"));
    expect(organizers.map((c) => c.querySelector("h3")!.textContent)).toEqual(["Ser anfitrión", "URBANO Competitions"]);
    for (const card of organizers) {
      expect(card.tagName).toBe("DIV");
      expect(card.className).toContain("is-locked");
      expect(card.querySelector("a, button, [tabindex]")).toBeNull();
      expect(card.querySelector(".status-pill")!.textContent).toBe("Próximamente");
    }
    expect(page.doc.querySelector('a[href*="competitions"]')).toBeNull();
    expect(INDEX_HTML).not.toMatch(/competitions\.html/);
    // the last section of the page
    const sections = Array.from(page.doc.querySelectorAll(".section"));
    expect(sections[sections.length - 1].id).toBe("organizers");
  });

  it("Rutas and Towers: recognizable tiles that stay informational, each with a decorative drawing and no link", async () => {
    const page = await loadHome();
    for (const title of ["URBANO Rutas", "URBANO Towers"]) {
      const tile = page.card(title)!;
      expect(tile.className, title).toContain("game-tile");
      expect(tile.tagName, title).toBe("DIV");
      expect(tile.querySelector("svg.tile-icon")!.getAttribute("aria-hidden"), title).toBe("true");
      expect(tile.querySelector(".status-pill")!.textContent, title).toBe("Próximamente");
      expect(tile.querySelector("a, button, [tabindex]"), title).toBeNull();
      expect(tile.closest("#minigames-grid"), title).toBeTruthy();
    }
    expect(Array.from(page.doc.querySelectorAll("#minigames-grid h3")).map((h) => h.textContent)).toEqual(["URBANO Rutas", "URBANO Towers"]);
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
  });

  it("nothing from the mockup's status vocabulary or rewards reaches the page, in either language", async () => {
    // The mockup's status labels ("AVAILABLE", "PRODUCTION-PROVEN", "CONTAINED", "CANDIDATE") and its rewards, products and events. (The word
    // "available" in an ordinary sentence, such as the Founder's "for now, only soccer is available", is not a status label.)
    const forbidden = /\b(Production-proven|Contained|Candidate|XP|badges?|skins?|accolades?|insignias?|Pulse|Rebote|Rebound|Race|Level\s*33)\b/i;
    const statusLabel = /^(Available|Disponible|Production-proven|Contained|Candidate|Direction|Playtest|Próximamente|Coming Soon)$/i;
    for (const stored of ["es", "en"] as const) {
      const page = await loadHome(INDEX_HTML, { stored });
      const body = page.doc.body.cloneNode(true) as HTMLElement;
      body.querySelectorAll("script, style").forEach((n) => n.remove()); // the page's own source is not content
      expect(body.textContent!.replace(/\s+/g, " ")).not.toMatch(forbidden);
      const pills = Array.from(page.doc.querySelectorAll(".status-pill, .art-kicker")).map((e) => (e.textContent ?? "").trim()).filter((t) => statusLabel.test(t));
      expect(pills.filter((t) => /^(Available|Disponible|Production-proven|Contained|Candidate|Direction)$/i.test(t))).toEqual([]); // only this page's own two labels
    }
    const dictionary = I18N_SOURCE.slice(I18N_SOURCE.indexOf('"home.title"'));
    const homeKeys = Array.from(dictionary.matchAll(/"(home\.[a-z.]+)":\s*"([^"]*)"/g)).map((m) => m[2]);
    expect(homeKeys.length).toBeGreaterThan(40);
    for (const value of homeKeys) expect(value).not.toMatch(forbidden);
  });

  it("the Predictions card keeps its art, never gains an element image, and the public matches list cannot change it (the entry is static)", async () => {
    const none = await loadHome();
    expect(none.doc.getElementById("featured-predictions")!.className).toContain("art-card");
    expect(none.doc.querySelector("#featured-action")).toBeNull();
    const kickoff = new Date(Date.now() + 3 * 3600_000).toISOString();
    const open = await loadHome(INDEX_HTML, {
      matches: [{ matchId: "m1", competition: "Liga", cancelledAt: null, finalized: false, kickoffAt: kickoff, homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true } }] }],
    });
    expect(open.doc.getElementById("featured-predictions")!.className).toContain("art-card");
    expect(open.doc.querySelector("#featured-predictions img, #featured-predictions svg")).toBeNull();
    expect(open.doc.querySelector("#featured-predictions a:not(#featured-play)")).toBeNull();
    expect(open.doc.getElementById("featured-predictions")!.outerHTML).toBe(none.doc.getElementById("featured-predictions")!.outerHTML);
    expect(open.doc.querySelector("#featured-status")).toBeNull(); // no status of any kind, whatever the list holds
    expect(open.text("#featured-play")).toBe("Abrir URBANO Score");
    expect(violations(open)).toEqual([]);
    expect(scoreEntryViolations(open.doc, { structureOnly: true })).toEqual([]);
  });

  it("the Score entry is a name, a descriptor and one link into URBANO Score — no pill, crest, match, venue, date, hour, window or availability — already in the first paint", () => {
    expect(scoreEntryViolations(staticDoc(INDEX_HTML))).toEqual([]);
    const card = staticDoc(INDEX_HTML).querySelector("#featured-predictions")!;
    expect(Array.from(card.children).map((c) => `${c.tagName.toLowerCase()}${c.id ? "#" + c.id : ""}${c.className ? "." + c.className : ""}`)).toEqual(["h2#featured-title", "p.featured-descriptor", "a#featured-play.featured-play"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Both languages
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — Spanish and English", () => {
  it("every new word follows the selector, in place: the cards are redrawn, never duplicated", async () => {
    const page = await loadHome();
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
    expect(halloweenViolations(page.doc, HALLOWEEN.es)).toEqual([]);
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.text("#minigames .section-label")).toBe("Minigames");
    // the announcement is static text that the language module rewrites in place: the same element, the same single card, in English
    expect(page.doc.querySelectorAll("#halloween .exp-card")).toHaveLength(1);
    expect(page.card("Costume contest")).toBe(page.doc.querySelector("#halloween .exp-card"));
    expect(halloweenViolations(page.doc, HALLOWEEN.en)).toEqual([]); // not enabled in either language, and no prize, vote count, fee or capacity in either
    expect(page.card("URBANO Poker")!.querySelector(".status-pill")!.textContent).toBe("Playtest");
    expect(page.card("URBANO Poker")!.querySelector(".exp-action")!.textContent).toBe("Host →");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
    expect(page.doc.querySelectorAll("#minigames-grid .exp-card")).toHaveLength(2);
    expect(violations(page)).toEqual([]);
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
    expect(halloweenViolations(page.doc, HALLOWEEN.es)).toEqual([]); // and back: nothing is left in English
  });

  it("the announcement in English from the start (a stored language), and the Spanish module words are the ones the card ships", async () => {
    const page = await loadHome(INDEX_HTML, { stored: "en" });
    expect(halloweenViolations(page.doc, HALLOWEEN.en)).toEqual([]);
    expect(page.doc.documentElement.lang).toBe("en");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// CSS contract: legibility over a photograph, no sideways scrolling
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — CSS contract", () => {
  const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (max-width: 374px)"));
  /** The layers of a `linear-gradient(...), linear-gradient(...)` value: direction and stops (alpha, position). */
  const photoStops = (value: string) =>
    value
      .split(/\)\s*,\s*(?=linear-gradient\()/)
      .map((layer) => layer.replace(/\s+/g, " ").trim())
      .map((layer) => {
        const direction = layer.match(/^linear-gradient\(\s*([\d.]+deg)\s*,/)![1];
        const body = layer.slice(layer.indexOf(",") + 1);
        const stops = Array.from(body.matchAll(/(rgba\([^)]*\)|transparent)(?:\s+(-?[\d.]+(?:px|%)?))?/g)).map((match) => ({
          alpha: match[1] === "transparent" ? 0 : Number(match[1].match(/([\d.]+)\)$/)![1]),
          position: match[2] ?? "0",
        }));
        return { direction, stops };
      });

  it("a dark scrim sits between every photograph and its text: strongest where the text is, on desktop and on a phone", () => {
    // --art-scrim is Trivia's (it did not change); --art-photo-scrim is the one of the three picture cards (Score, Poker, Halloween).
    const desktop = css.match(/--art-scrim:\s*([^;]+);/)![1];
    expect(desktop).toMatch(/linear-gradient\(90deg,\s*rgba\(10,\s*10,\s*10,\s*0\.9\)/); // darkest on the text side
    const mobile = phone.match(/--art-scrim:\s*([^;]+);/)![1];
    expect(mobile).toMatch(/linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)/); // text sits low on a narrow card: darkest at the bottom
    const photoDesktop = css.match(/--art-photo-scrim:\s*([^;]+);/)![1];
    expect(photoDesktop).toMatch(/^linear-gradient\(90deg,\s*rgba\(10,\s*10,\s*10,\s*0\.9\)\s*0,/); // the deep dark is on the text side
    const photoMobile = phone.match(/--art-photo-scrim:\s*([^;]+);/)![1];
    expect(photoMobile).toMatch(/^linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)\s*0%/); // and at the bottom on a phone
    expect(rule(".art-scrim")).toMatch(/background:\s*var\(--art-photo-scrim\)/);
    expect(css).toMatch(/\.featured-card\.art-card::after\s*\{[^}]*var\(--art-photo-scrim\)/);
    for (const selector of [".art-scrim", ".art-img"]) expect(rule(selector), selector).toMatch(/pointer-events:\s*none/);
  });

  it("the picture shows at its own brightness: the image is not faded, the dark zone ends where the text ends, and no uniform layer dims the whole picture", () => {
    // no fade on the photograph itself
    expect(rule(".art-img")).not.toMatch(/opacity/);
    expect(css).not.toMatch(/\.art-img\s*\{[^}]*opacity/);
    // desktop: the dark zone is measured in px (the text has a fixed width whatever the width of the card), it opens up and ends in nothing
    const stops = photoStops(css.match(/--art-photo-scrim:\s*([^;]+);/)![1]);
    const horizontal = stops.find((layer) => layer.direction === "90deg")!;
    expect(horizontal.stops.every((stop) => stop.position.endsWith("px") || stop.position === "0")).toBe(true);
    expect(horizontal.stops[0].alpha).toBeCloseTo(0.9, 5);
    expect(horizontal.stops[horizontal.stops.length - 1].alpha).toBe(0);
    for (let i = 1; i < horizontal.stops.length; i++) expect(horizontal.stops[i].alpha).toBeLessThan(horizontal.stops[i - 1].alpha);
    // the layer behind the buttons stays short, so it does not dim the lower half of the picture
    const bottom = stops.find((layer) => layer.direction === "0deg")!;
    expect(bottom.stops[0].alpha).toBeLessThanOrEqual(0.55);
    expect(parseInt(bottom.stops[bottom.stops.length - 1].position, 10)).toBeLessThanOrEqual(40);
    // phone: only a vertical layer (deep at the bottom, where the text is, open above): the uniform horizontal dimmer is gone, and the top is clear
    const phoneLayers = photoStops(phone.match(/--art-photo-scrim:\s*([^;]+);/)![1]);
    expect(phoneLayers.map((layer) => layer.direction)).toEqual(["0deg"]);
    const top = phoneLayers[0].stops[phoneLayers[0].stops.length - 1];
    expect(top.alpha).toBe(0);
    expect(parseInt(top.position, 10)).toBeLessThanOrEqual(90);
    // the dark zone is still deep where the text sits: at the bottom edge and a third of the way up
    expect(phoneLayers[0].stops[0].alpha).toBeGreaterThanOrEqual(0.95);
    expect(phoneLayers[0].stops[1].alpha).toBeGreaterThanOrEqual(0.9);
    // Trivia keeps its own scrim, untouched
    expect(css).toMatch(/\.art-trivia::after\s*\{[^}]*var\(--art-scrim\)/);
  });

  it("text on a photograph is ivory with a shadow, pills are dark chips, and the featured-status pill uses the lighter purple (the contrast measurement depended on these)", () => {
    expect(rule(".art-card .exp-sub")).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.92\)/);
    expect(rule(".art-card .exp-sub")).toMatch(/text-shadow/);
    // the Score entry's descriptor is ivory with a shadow, and its one action is the light button with dark ink (the same as the other cards')
    expect(css).toMatch(/\.featured-descriptor\s*\{[^}]*rgba\(245,\s*241,\s*232,\s*0\.95\)[^}]*text-shadow/);
    expect(css).toMatch(/\.featured-play\s*\{[^}]*background:\s*var\(--primary-fill\)[^}]*color:\s*var\(--primary-ink\)/);
    expect(rule(".art-card .status-pill")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\)/); // a deeper chip: the picture behind it is no longer dimmed
    // and the Score entry has no pill, crest, match line, moment or window left to style
    expect(css).not.toMatch(/\.featured-card[^{]*\.status-pill|\.featured-(crests?|crest-vs|scope|when|window)\b|\.club-crest/);
    expect(rule(".game-tile .status-pill")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.55\)/);
    expect(rule(".art-card .status-featured")).toMatch(/color:\s*var\(--exp-purple-soft\)/);
    expect(css).toMatch(/--exp-purple-soft:\s*#b57cff/i);
  });

  it("no informational card is faded: its state is carried by its pill and words, and its text keeps at least AA contrast on the card", () => {
    expect(rule(".exp-card.is-locked")).not.toMatch(/opacity/);
    expect(css).not.toMatch(/\.(?:art-card|game-tile|exp-card)\.is-locked\s*\{[^}]*opacity/);
    // WCAG 2 contrast of the three colours the plain informational cards use, against the card background.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const card = css.match(/--bg-card:\s*(#[0-9a-f]{6})/i)![1];
    const title = css.match(/\.exp-card\.is-locked:not\(\.art-card\):not\(\.game-tile\) h3\s*\{\s*color:\s*(#[0-9a-f]{6})/i)![1];
    const sub = css.match(/\.exp-card\.is-locked:not\(\.art-card\):not\(\.game-tile\) \.exp-sub\s*\{\s*color:\s*(#[0-9a-f]{6})/i)![1];
    const action = css.match(/\.exp-card\.is-locked \.exp-action\s*\{\s*color:\s*(#[0-9a-f]{6})/i)![1];
    for (const [name, color] of [["title", title], ["text", sub], ["action", action]] as const) expect(contrast(color, card), name).toBeGreaterThanOrEqual(4.5);
    const status = css.match(/--muted:\s*(#[0-9a-f]{6})/i)![1]; // the "Próximamente" pill text
    expect(contrast(status, card)).toBeGreaterThanOrEqual(4.5);
  });

  it("the grids never scroll sideways: no carousel is left, every card can shrink, and the cards stack on a phone", () => {
    expect(css).not.toMatch(/\.carousel\b/);
    expect(rule(".exp-card")).not.toMatch(/scroll-snap|flex:\s*0 0 auto/);
    expect(rule(".exp-card")).toMatch(/min-width:\s*0/);
    expect(rule(".exp-card")).not.toMatch(/\bwidth:\s*230px/);
    expect(rule(".games-grid")).toMatch(/minmax\(0,\s*1fr\)/);
    expect(rule(".experiences-grid, .organizers-grid")).toMatch(/repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.experiences-grid,\s*\.organizers-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}\s*\}/);
    expect(phone).toMatch(/\.minigames-grid\s*\{\s*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\);\s*\}/);
    // Experiences holds only URBANO Poker now (the Halloween announcement is its own card near the top): a lone card spans the row, so the
    // grid never shows an empty half; with a second experience the two-column rule above applies again
    expect(rule(".experiences-grid > .exp-card:only-child")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("the score card's art is the pitch drawn in code and the trivia card's art is its own motif, both as CSS backgrounds (never elements)", () => {
    expect(css).toMatch(/\.featured-card\.art-card::before\s*\{[^}]*url\("\/assets\/home\/urbano-score-pitch\.svg"\)/);
    expect(css).not.toMatch(/stadium/i);
    expect(css).toMatch(/\.art-trivia::before\s*\{[^}]*url\("\/assets\/home\/trivia-card\.svg"\)/);
    expect(css).toMatch(/\.art-trivia::after\s*\{[^}]*var\(--art-scrim\)/);
    expect(css).not.toMatch(/soccer-predictions\.webp|sports-discovery/);
  });

  it("the structures that carry the historical ids are still where the other tests expect them, in the Founder's order", () => {
    for (const id of ["experiences-carousel", "games-carousel", "minigames-grid", "organizers-grid"]) expect(INDEX_HTML).toContain(`id="${id}"`);
    expect(INDEX_HTML).toMatch(/class="card-grid experiences-grid" id="experiences-carousel"/);
    expect(INDEX_HTML).toMatch(/class="card-grid games-grid" id="games-carousel"/);
    expect(INDEX_HTML).toMatch(/class="card-grid organizers-grid" id="organizers-grid"/);
    const order = ['id="halloween"', "featured-predictions", 'id="experiences"', 'id="play"', 'id="minigames"', 'id="organizers"'].map((marker) => INDEX_HTML.indexOf(marker));
    expect([...order].sort((x, y) => x - y)).toEqual(order); // the Halloween announcement, Score, Experiences, Trivia, Minigames, Organizers
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it("the announcement's own rules: its title is as large as a picture card's, its lines are ivory with a shadow over the photograph, and nothing in it can overflow", () => {
    // the h2 takes exactly the place of a picture card's h3 (same size, weight and measure), on desktop and on a phone
    expect(css).toMatch(/\.art-card h3,\s*\.art-halloween h2\s*\{[^}]*font-size:\s*26px[^}]*line-height:\s*1\.15[^}]*font-weight:\s*800[^}]*max-width:\s*16ch/);
    expect(phone).toMatch(/\.art-card h3,\s*\.art-halloween h2\s*\{\s*font-size:\s*24px;\s*\}/);
    expect(css).toMatch(/\.art-halloween h2\s*\{[^}]*margin:\s*0/);
    // the event chip has the same deep fill as the status pill (measured: with the lighter chip its purple text fell to 2.9:1 over the candles)
    expect(css).toMatch(/\.art-halloween \.art-kicker\s*\{\s*background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\);\s*\}/);
    // the date and the availability line sit on the photograph: ivory, with the same shadow as the card's other lines, at a readable size
    for (const selector of [".halloween-date", ".halloween-availability"]) {
      const body = rule(selector);
      expect(body, selector).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.9\d?\)/);
      expect(body, selector).toMatch(/text-shadow/);
      expect(body, selector).toMatch(/font-size:\s*1[3-4]px/);
      expect(body, selector).toMatch(/margin:/);
      expect(body, selector).not.toMatch(/opacity|position:\s*absolute/);
    }
    // the announcement has room above the featured card and does not stretch the page sideways
    expect(css).toMatch(/#halloween\s*\{[^}]*margin-top:\s*\d+px/);
    expect(css.slice(0, css.indexOf("@media (max-width: 640px)")).match(/(?:^|\n)\s*\.art-halloween\s*\{/)).toBeNull(); // (on desktop the shared rule `.art-poker, .art-halloween` sizes it: no card of its own width)
    expect(css).toMatch(/\.art-poker,\s*\.art-halloween\s*\{\s*min-height:\s*300px;\s*padding:\s*24px;\s*\}/);
    expect(css).not.toMatch(/#halloween[^{]*\{[^}]*(?:width:\s*\d{3,}px|min-width|white-space:\s*nowrap)/);
  });

  it("on a phone the announcement's words sit below a clear band of the photograph, with its own scrim that is dark from where the title begins (the shared scrim is untouched)", () => {
    // Measured in a real browser: with the shared phone scrim the title lay over bright candles (contrast 1.1:1 at worst), because this card has
    // more words than the others. The card's own scrim is a top-to-bottom layer: clear at the top, deep before the first line of text.
    const own = phone.match(/\.art-halloween\s*\{\s*--art-photo-scrim:\s*([^;]+);\s*\}/);
    expect(own, "the card's own phone scrim").not.toBeNull();
    const layers = photoStops(own![1]);
    expect(layers.map((layer) => layer.direction)).toEqual(["180deg"]);
    const stops = layers[0].stops;
    expect(stops[0].alpha).toBe(0); // the top of the photograph is clear (the chips carry their own dark background)
    for (let i = 1; i < stops.length; i++) expect(stops[i].alpha).toBeGreaterThanOrEqual(stops[i - 1].alpha); // it only gets darker going down
    expect(stops[stops.length - 1].alpha).toBeGreaterThanOrEqual(0.95);
    const deep = stops.find((stop) => stop.alpha >= 0.9)!;
    expect(parseInt(deep.position, 10)).toBeLessThanOrEqual(140); // deep before the title, which begins about 140 px down
    // the gap that makes the clear band, and the shared phone scrim still exactly as the other pins state it
    expect(phone).toMatch(/\.art-halloween \.exp-card-top\s*\{\s*margin-bottom:\s*84px;\s*flex-wrap:\s*wrap;\s*row-gap:\s*6px;\s*\}/);
    // the event chip is one label: never broken in the middle on a phone (the pill drops to its own row where they do not fit together)
    expect(phone).toMatch(/\.art-halloween \.art-kicker\s*\{\s*letter-spacing:\s*0\.08em;\s*white-space:\s*nowrap;\s*\}/);
    expect(phone.match(/--art-photo-scrim:\s*([^;]+);/)![1]).toMatch(/^linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)\s*0%/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: each protection is removed from a COPY of the page and the violation it prevents must then appear.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — negative controls", () => {
  function mutated(from: string, to: string): string {
    expect(INDEX_HTML.split(from).length - 1, `mutation anchor: ${from}`).toBe(1);
    return INDEX_HTML.replace(from, to);
  }

  // The announcement's own section, changed in a COPY of the page. (Its Spanish words also appear once more in the generated fallback
  // table, so these mutations work on the section, never on the whole page.)
  const SECTION = /<div class="section" id="halloween">[\s\S]*?\n<\/div>\n/;
  function mutatedSection(change: (section: string) => string): string {
    const found = INDEX_HTML.match(SECTION);
    expect(found, "the announcement section").not.toBeNull();
    const changed = change(found![0]);
    expect(changed, "the mutation changed something").not.toBe(found![0]);
    return INDEX_HTML.replace(found![0], changed);
  }

  it("the Halloween announcement given a link, a button or a vote is caught", async () => {
    const withLink = mutatedSection((s) => s.replace('<p class="halloween-availability"', '<a class="halloween-vote" href="/vote.html">Votar</a><p class="halloween-availability"'));
    expect(halloweenViolations((await loadHome(withLink)).doc, HALLOWEEN.es).join("|")).toMatch(/interactive element/);
    expect(violations(await loadHome(withLink)).join("|")).toMatch(/Concurso de disfraces gained an operational element/);
    const withButton = mutatedSection((s) => s.replace('<p class="halloween-availability"', '<button type="button">Inscribirme</button><p class="halloween-availability"'));
    expect(halloweenViolations((await loadHome(withButton)).doc, HALLOWEEN.es).join("|")).toMatch(/interactive element/);
    const focusable = mutatedSection((s) => s.replace('class="exp-card art-card art-halloween is-locked"', 'class="exp-card art-card art-halloween is-locked" tabindex="0"'));
    expect(halloweenViolations((await loadHome(focusable)).doc, HALLOWEEN.es).join("|")).toMatch(/interactive element/);
  });

  // Words are checked on the FIRST PAINT (the HTML with no script run): once the language module runs, it writes the dictionary's words over
  // the markup's, so a changed word in the markup is only visible there (and the drift tests in i18nModuleFailure.test.ts pin that the markup
  // and the dictionary are the same words).
  const firstPaint = (html: string) => { const dom = new JSDOM(html); closers.push(() => dom.window.close()); return dom.window.document; };

  it("the Halloween announcement turned into an actionable card, or made to promise a prize, a number or other words, is caught", () => {
    const actionable = mutatedSection((s) => s.replace("art-halloween is-locked", "art-halloween is-actionable"));
    expect(halloweenViolations(firstPaint(actionable), HALLOWEEN.es).join("|")).toMatch(/not informational/);
    const prize = mutatedSection((s) => s.replace("Mostrá tu disfraz y preparate para elegir tus favoritos.", "Mostrá tu disfraz y ganá un premio de L 500."));
    expect(halloweenViolations(firstPaint(prize), HALLOWEEN.es).join("|")).toMatch(/prize, sponsor, capacity or price claim/);
    const open = mutatedSection((s) => s.replace("Las inscripciones y la votación todavía no están disponibles.", "Inscribite ya y votá por tu favorito."));
    expect(halloweenViolations(firstPaint(open), HALLOWEEN.es).join("|")).toMatch(/other than the approved words/);
    const seats = mutatedSection((s) => s.replace("Sábado 31 de octubre", "Sábado 31 de octubre, 40 cupos"));
    expect(halloweenViolations(firstPaint(seats), HALLOWEEN.es).join("|")).toMatch(/capacity or price claim/);
    const hour = mutatedSection((s) => s.replace("Sábado 31 de octubre", "Sábado 31 de octubre, 8:00 p. m."));
    expect(halloweenViolations(firstPaint(hour), HALLOWEEN.es).join("|")).toMatch(/number other than the date/);
    const sponsor = mutatedSection((s) => s.replace("Halloween · Beer Box</span>", "Halloween · Beer Box, patrocinado por una marca</span>"));
    expect(halloweenViolations(firstPaint(sponsor), HALLOWEEN.es).join("|")).toMatch(/sponsor|other than the approved words/);
  });

  it("the Halloween announcement's photograph announced, eager or unsized is caught, like every other art image", async () => {
    const announced = mutatedSection((s) => s.replace('alt=""', 'alt="Calabaza"'));
    expect(violations(await loadHome(announced)).join("|")).toMatch(/not decorative/);
    const eager = mutatedSection((s) => s.replace(' loading="lazy"', ""));
    expect(violations(await loadHome(eager)).join("|")).toMatch(/not lazy-loaded/);
    const unsized = mutatedSection((s) => s.replace(' width="1280" height="720"', ""));
    expect(violations(await loadHome(unsized)).join("|")).toMatch(/no intrinsic size/);
    const unscrimmed = mutatedSection((s) => s.replace('class="art-scrim" aria-hidden="true"', 'class="art-scrim"'));
    expect(violations(await loadHome(unscrimmed)).join("|")).toMatch(/scrim is announced/);
    const wrongPhoto = mutatedSection((s) => s.replace("halloween-community.webp", "halloween-voting.png"));
    expect(violations(await loadHome(wrongPhoto)).join("|")).toMatch(/does not come from \/assets\/home/);
  });

  it("the Halloween announcement removed from the page's first paint is caught", () => {
    const html = INDEX_HTML.replace(SECTION, "");
    expect(html).not.toBe(INDEX_HTML); // the pattern found the announcement
    expect(halloweenViolations(firstPaint(html), HALLOWEEN.es)).toEqual(["the Halloween card is missing"]);
  });

  it("a Rutas tile that links anywhere is caught", async () => {
    const html = mutated('title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "soon",', 'title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "playtest", href: "/rutas.html",');
    expect(violations(await loadHome(html)).join("|")).toMatch(/URBANO Rutas is not informational|link points at Rutas/);
  });

  it("an art image that is announced, eager or unsized is caught", async () => {
    // (the anchors are the script's own image template: the Halloween announcement carries the same attributes as static markup, and has its own controls below)
    const template = 'src="${item.art.src}" alt="" width="1280" height="720" loading="lazy" decoding="async">';
    expect(violations(await loadHome(mutated(template, 'src="${item.art.src}" alt="Poker table" width="1280" height="720" loading="lazy" decoding="async">'))).join("|")).toMatch(/not decorative/);
    expect(violations(await loadHome(mutated(template, 'src="${item.art.src}" alt="" width="1280" height="720" decoding="async">'))).join("|")).toMatch(/not lazy-loaded/);
    expect(violations(await loadHome(mutated(template, 'src="${item.art.src}" alt="" loading="lazy" decoding="async">'))).join("|")).toMatch(/no intrinsic size/);
    expect(violations(await loadHome(mutated('<span class="art-scrim" aria-hidden="true"></span>`', '<span class="art-scrim"></span>`'))).join("|")).toMatch(/scrim is announced/);
  });

  it("a Poker card whose destination or Playtest label changed is caught", async () => {
    expect(violations(await loadHome(mutated('href: "/host.html?experience=poker",', 'href: "/poker-host.html",'))).join("|")).toMatch(/poker access/);
    expect(violations(await loadHome(mutated('title: "URBANO Poker",\n      subKey: "home.poker.sub",\n      status: "playtest",', 'title: "URBANO Poker",\n      subKey: "home.poker.sub",\n      status: "featured",'))).join("|")).toMatch(/poker access/);
  });

  it("a Trivia card that loses its destination, or gains an element image, is caught", async () => {
    expect(violations(await loadHome(mutated('href: "/trivia-playtest.html",', 'href: "/quiz-playtest.html",'))).join("|")).toMatch(/trivia access|Quiz/);
    expect(violations(await loadHome(mutated('art: { className: "art-trivia" },', 'art: { src: "/assets/home/urbano-poker.webp", className: "art-trivia" },'))).join("|")).toMatch(/Trivia card carries an element image|expected exactly 2 art images/);
  });

  it("a URBANO Competitions card that becomes a link is caught", async () => {
    const html = mutated('title: "URBANO Competitions",\n        subKey: "home.competitions.sub",\n        status: "soon",', 'title: "URBANO Competitions",\n        subKey: "home.competitions.sub",\n        status: "playtest", href: "/competitions.html",');
    expect(violations(await loadHome(html)).join("|")).toMatch(/URBANO Competitions is not informational|link points at/);
  });

  it("a photograph placed inside the Predictions card as an element is caught", async () => {
    const html = mutated('<h2 id="featured-title">URBANO Score</h2>', '<img src="/assets/home/urbano-score-pitch.svg" alt=""><h2 id="featured-title">URBANO Score</h2>');
    expect(violations(await loadHome(html)).join("|")).toMatch(/featured card contains an element image/);
    expect(scoreEntryViolations(staticDoc(html)).join("|")).toMatch(/gained a status, a moment, a crest, a match line or an image/);
  });

  // The Score entry's own section, changed in a COPY of the page (checked on the first paint, where the markup's own words show).
  const SCORE_ENTRY = /<div class="featured-card art-card" id="featured-predictions">[\s\S]*?\n  <\/div>\n/;
  function mutatedEntry(change: (entry: string) => string): Document {
    const found = INDEX_HTML.match(SCORE_ENTRY);
    expect(found, "the Score entry").not.toBeNull();
    const changed = change(found![0]);
    expect(changed, "the mutation changed something").not.toBe(found![0]);
    return staticDoc(INDEX_HTML.replace(found![0], changed));
  }

  it("the Score entry given back the expired promotion — the pill, the match, the crests, the venue, the date, the window or the old action — is caught", () => {
    expect(scoreEntryViolations(staticDoc(INDEX_HTML))).toEqual([]); // the control: the real page is clean
    const pill = mutatedEntry((s) => s.replace('<h2 id="featured-title">', '<span class="status-pill status-soon" id="featured-status">Próximo partido</span>\n    <h2 id="featured-title">'));
    expect(scoreEntryViolations(pill).join("|")).toMatch(/gained a status/);
    expect(scoreEntryViolations(pill).join("|")).toMatch(/other than its name, descriptor and link/);
    const crests = mutatedEntry((s) => s.replace('<p class="featured-descriptor"', '<div class="featured-crests" aria-hidden="true"><span class="featured-crest" data-club="FC Barcelona"></span></div>\n    <p class="featured-descriptor"'));
    expect(scoreEntryViolations(crests).join("|")).toMatch(/gained a status, a moment, a crest/);
    const matchup = mutatedEntry((s) => s.replace("Tus predicciones deportivas", "El Clásico: FC Barcelona vs. Real Madrid CF"));
    expect(scoreEntryViolations(matchup).join("|")).toMatch(/other than its name, descriptor and link/);
    const venue = mutatedEntry((s) => s.replace('<a class="featured-play"', '<p class="featured-scope">Vivilo en The Pub by Beer Box</p>\n    <a class="featured-play"'));
    expect(scoreEntryViolations(venue).join("|")).toMatch(/gained a status, a moment, a crest, a match line|other than its name/);
    const moment = mutatedEntry((s) => s.replace('<a class="featured-play"', '<p class="featured-when"><time datetime="2026-10-25T20:00:00Z">Domingo 25 de octubre · 2:00 p. m.</time></p>\n    <a class="featured-play"'));
    expect(scoreEntryViolations(moment).join("|")).toMatch(/gained a status, a moment/);
    expect(scoreEntryViolations(moment).join("|")).toMatch(/carries a number/);
    const windowLine = mutatedEntry((s) => s.replace('<a class="featured-play"', '<p class="featured-window">Ventana de participación prevista: de 12:30 p. m. a 2:00 p. m.</p>\n    <a class="featured-play"'));
    expect(scoreEntryViolations(windowLine).join("|")).toMatch(/gained a status|carries a number/);
    const oldAction = mutatedEntry((s) => s.replace("Abrir URBANO Score", "Jugar ahora"));
    expect(scoreEntryViolations(oldAction).join("|")).toMatch(/other than its name, descriptor and link/);
  });

  it("the Score entry given a second link, a control, a different destination, or removed, is caught", () => {
    const second = mutatedEntry((s) => s.replace('<a class="featured-play"', '<a class="featured-history" href="/profile.html">Historial</a>\n    <a class="featured-play"'));
    expect(scoreEntryViolations(second).join("|")).toMatch(/exactly one link/);
    const elsewhere = mutatedEntry((s) => s.replace('href="/soccer-predictions.html"', 'href="/trivia-playtest.html"'));
    expect(scoreEntryViolations(elsewhere).join("|")).toMatch(/exactly one link/);
    const control = mutatedEntry((s) => s.replace('<a class="featured-play"', '<button type="button">Participar</button>\n    <a class="featured-play"'));
    expect(scoreEntryViolations(control).join("|")).toMatch(/gained a control/);
    const noLink = mutatedEntry((s) => s.replace(/<a class="featured-play"[\s\S]*?<\/a>/, ""));
    expect(scoreEntryViolations(noLink).join("|")).toMatch(/exactly one link/);
    expect(scoreEntryViolations(staticDoc(INDEX_HTML.replace(SCORE_ENTRY, "")))).toEqual(["the Score entry is missing"]);
  });
});
