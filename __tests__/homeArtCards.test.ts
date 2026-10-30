import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The Home's editorial cards (Founder Design Review composition): URBANO Score as the featured art card ("Próximos partidos": an
 * informational preselection over an original pitch drawn in code, with the crests of the ten teams), URBANO Poker and Halloween /
 * Community as art cards, Trivia as a visual card of its own, and Rutas / Towers as recognizable Minigame tiles.
 *
 * What this pins: (1) the two photographs (Poker, Halloween) are the only photographs, small local WebP derivatives of the reviewed
 * artwork, each pinned by hash and weight; the two other images are original SVG drawings made in code, also pinned by hash and weight; (2) the art is decoration only, so no card gains an operational action, an availability claim, a reward or an event
 * from the mockup; (3) availability stays exactly what it was (Poker keeps its destination and its Playtest label; everything else that
 * was informational stays informational), and the Score card offers no way to play: two informational links in a fixed order, no call
 * to action, and the crests of the ten teams as decoration that never replaces the written name; (4) the CSS contract that keeps text legible over a photograph and the page free of sideways
 * scrolling; (5) both languages.
 *
 * Limits, stated plainly: jsdom does not lay a page out or paint it. Legibility over the photographs was MEASURED in a real browser (WCAG
 * contrast of every text run on an art card or tile against the real rendered background, at 1280, 800 and 500 px, in both languages,
 * with and without an open match; see the candidate package), and the CSS values that measurement depended on are pinned below.
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const CRESTS_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const UPCOMING_DATA_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcomingData.js"), "utf8");
const UPCOMING_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcoming.js"), "utf8");
// The page without its explanatory comments: they may legitimately name the mockup or the retired Level 33 card.
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
const ASSET_DIR = path.join(ROOT, "public/assets/home");
const MATCHES_URL = "/api/gaming/predictions/matches";
/** The ten teams of the strip on the Score card, in the Founder's order (2026-10-29): their crests are mandatory, as decoration. */
const TEN_TEAMS = ["Real Madrid", "FC Barcelona", "Manchester City", "Manchester United", "Arsenal", "Olimpia", "Motagua", "Inter de Milán", "Bayern Múnich", "Paris Saint-Germain"];
/** The page's clock in these tests: the day of the Founder's decisions. The editorial list is real data that leaves the card as its matches
 *  pass, so nothing here may depend on today's date. */
const HOME_NOW = "2026-10-29T15:00:00Z";

// The Halloween costume-contest announcement: the exact public words, in the order the card reads. The Spanish is the Founder's text
// (gate of 2026-10-29) and the English is its faithful rendering, approved. It announces that the contest exists and that nothing about it can
// be done yet: no registration, no voting, no rules, no prize, no sponsor, no capacity, no fee. Every assertion about it below is BOUNDED to its
// own section (#halloween): the Home legitimately carries dates, team names, numbers and a matches request elsewhere (the Score card).
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

/** The page's own clock, fixed at `iso` and ticking from there. */
function fixClock(window: any, iso: string) {
  const RealDate = window.Date;
  const offset = Date.parse(iso) - RealDate.now();
  function FakeDate(...args: unknown[]) { return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset); }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
}

async function loadHome(html: string = INDEX_HTML, opts: { matches?: unknown[]; stored?: "es" | "en"; now?: string; fetchMatches?: () => Promise<unknown>; consoleErrors?: unknown[][]; breakList?: boolean } = {}) {
  const dom = new JSDOM(html, {
    url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      fixClock(w, opts.now ?? HOME_NOW);
      if (opts.stored) w.localStorage.setItem("urbano.lang", opts.stored);
      Object.defineProperty(w.navigator, "language", { value: "en-US", configurable: true });
      Object.defineProperty(w.navigator, "languages", { value: ["en-US"], configurable: true });
      w.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped scripts are evaluated, in the order of the page's script tags
      w.eval(CRESTS_SOURCE); // the crests of the ten teams are decoration drawn by this module
      w.eval(UPCOMING_DATA_SOURCE); // the card's editorial list and its logic
      w.eval(UPCOMING_SOURCE);
      // a malformed editorial container: reading its matches throws (the list is informational: the page must not depend on it)
      if (opts.breakList) Object.defineProperty(w.UrbanoUpcomingData, "matches", { get() { throw new Error("malformed editorial list"); }, configurable: true });
      w.UrbanoAuth = { attachSignInButton: () => {} };
      // the public matches list: a good answer by default; `fetchMatches` replaces ONLY that answer (a failure, a bad body, an answer that never comes)
      w.fetch = async (url: string) => (String(url) === MATCHES_URL ? (opts.fetchMatches ? opts.fetchMatches() : { status: 200, json: async () => ({ matches: opts.matches ?? [] }) }) : { status: 404, json: async () => ({}) });
      if (opts.consoleErrors) w.console.error = (...args: unknown[]) => { opts.consoleErrors!.push(args); };
    },
  });
  closers.push(() => dom.window.close());
  await tick();
  const win = dom.window as any;
  const doc = win.document as Document;
  const card = (title: string) => Array.from(doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h3")?.textContent === title) as HTMLElement | undefined;
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
  // The Halloween announcement is a static section of its own (not a catalog card): it must be there, informational and without a control. Its words
  // are judged by halloweenViolations (they depend on the language); here only its nature, so every language of every page state is covered.
  const hallo = doc.querySelector("#halloween .exp-card") as HTMLElement | null;
  if (!hallo) out.push("the Halloween announcement is missing");
  else if (hallo.tagName !== "DIV" || !hallo.className.includes("is-locked") || hallo.hasAttribute("href") || hallo.querySelector("a, button, [tabindex], [onclick], input, form")) out.push("the Halloween announcement is not informational");
  for (const title of ["URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]) {
    if (title === "Ser anfitrión" && !card(title)) continue; // (named in English in the English page; the Spanish tests pin it)
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
  if (doc.querySelector("#featured-predictions img:not(.club-crest), #featured-predictions svg")) out.push("the featured card contains an element image");
  // The Score card is information, not an invitation: exactly two links (the way to earlier participations and prizes FIRST, then the lineup), no
  // call to action, and the ten teams in the Founder's order, each named in text (a crest is only an addition to the name).
  const featured = doc.getElementById("featured-predictions");
  if (!featured) out.push("the featured card is missing");
  else {
    const links = Array.from(featured.querySelectorAll("a")).map((a) => `${a.getAttribute("id")} ${a.getAttribute("href")}`);
    if (links.join(" | ") !== "featured-past /soccer-predictions.html#historial | featured-lineup /soccer-predictions.html") out.push(`the featured card's links are not the two informational ones, in order: ${links.join(" | ")}`);
    if (featured.querySelector("#featured-play, .featured-play, #featured-action, button, form, input, select") || /Jugar ahora|Play now/i.test(featured.textContent ?? "")) out.push("the featured card invites to play");
    const chips = Array.from(featured.querySelectorAll("ul.ten-crests > li.crest-chip"));
    const clubs = chips.map((li) => li.getAttribute("data-club"));
    if (clubs.join("|") !== TEN_TEAMS.join("|")) out.push(`the strip of ten teams changed: ${clubs.join(", ")}`);
    for (const li of chips) if ((li.querySelector(".crest-name")?.textContent ?? "") !== li.getAttribute("data-club")) out.push(`${li.getAttribute("data-club")} lost its written name`);
    for (const img of Array.from(featured.querySelectorAll("img"))) {
      if (!img.classList.contains("club-crest") || img.getAttribute("alt") !== "" || img.getAttribute("aria-hidden") !== "true") out.push("a crest is not decorative (empty alt, hidden from assistive technology)");
    }
    // the card makes no statement about prizes: the only words about them are the link to the person's own earlier prizes and the note under it
    const prizeWords = Array.from(featured.querySelectorAll("*")).filter((el) => el.children.length === 0 && /premio|prize/i.test(el.textContent ?? "")).map((el) => el.id || el.className);
    if (prizeWords.join("|") !== "featured-past|featured-access-note") out.push(`the featured card says something about prizes beyond the way to the person's own: ${prizeWords.join(", ")}`);
    for (const list of Array.from(featured.querySelectorAll("ul.ten-crests, ul#upcoming-list"))) if (list.getAttribute("role") !== "list") out.push("a list of the card lost its role");
    for (const row of Array.from(featured.querySelectorAll("#upcoming-list .upcoming-item[data-time='tbc']"))) {
      const time = row.querySelector("time");
      if (!/Horario por confirmar|Time to be confirmed/.test(time?.textContent ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(time?.getAttribute("datetime") ?? "")) out.push("a match without a confirmed hour does not say so");
      if (row.getAttribute("data-state") !== "next" || row.querySelector(".upcoming-opens")) out.push("a match without a confirmed hour is not just announced");
    }
  }
  if (Array.from(doc.querySelectorAll("a[href]")).some((a) => /rutas|towers|race|pulse|competitions|quiz/i.test(a.getAttribute("href") ?? ""))) out.push("a link points at Rutas, Towers, Race, Pulse, Competitions or Quiz");
  const trivia = card("Trivia");
  if (!trivia || trivia.tagName !== "A" || trivia.getAttribute("href") !== "/trivia-playtest.html" || !/Playtest/i.test(trivia.textContent ?? "")) out.push("trivia access or Playtest label changed");
  if (trivia && trivia.querySelector("img, svg")) out.push("the Trivia card carries an element image (its art is a CSS background)");
  return out;
}

// What must stay true of the Halloween announcement, as a list of violations (empty = honest), for the words of one language. Bounded to the
// section: only what is INSIDE #halloween is judged (the Score card above or below it has its own contract and its own legitimate numbers).
function halloweenViolations(doc: Document, words: HalloweenWords): string[] {
  const out: string[] = [];
  const card = doc.querySelector("#halloween .exp-card") as HTMLElement | null;
  if (!card) return ["the Halloween card is missing"];
  if (card.tagName !== "DIV" || !card.className.includes("is-locked") || card.hasAttribute("href")) out.push("the Halloween card is not informational");
  // (the card itself is checked too: a card that became focusable, clickable or a link is as interactive as one that holds a button)
  const interactive = "a, button, input, select, textarea, form, label, [href], [tabindex], [onclick], [role], [contenteditable], summary, details, audio, video, iframe";
  if (card.matches(interactive) || card.querySelector(interactive)) out.push("the Halloween card gained an interactive element");
  if (Array.from(card.querySelectorAll("*")).concat(card).some((e) => Array.from(e.attributes).some((a) => /^on/i.test(a.name)))) out.push("the Halloween card carries an inline event handler");
  if (card.querySelector("time, progress, meter, canvas, [aria-live]")) out.push("the Halloween card carries a countdown, a live region or a moment");
  const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text !== [words.event, words.status, words.title, words.date, words.sub, words.availability].join(" ")) out.push("the Halloween card says something other than the approved words");
  if (/premio|prize|ganad|ganá|winner|\bwins?\b|conquist|patrocin|sponsor|cupo|capacity|gratis|\bfree\b|\$|\bL\.?\s?\d|HNL|USD|entrada|ticket/i.test(text)) out.push("the Halloween card makes a prize, sponsor, capacity or price claim");
  if ((text.match(/\d+/g) ?? []).join(",") !== "31") out.push("the Halloween card carries a number other than the date");
  return out;
}

// A page's first paint: its HTML parsed with no script run (the words the markup itself carries).
function staticDoc(html: string): Document {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  closers.push(() => dom.window.close());
  return dom.window.document;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The photographs
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — the photographs and the Trivia motif", () => {
  it("public/assets/home holds exactly the reviewed assets: two photographs and two code-drawn motifs; no Level 33 art, no stadium photograph, no multi-sport photograph, no PNG original", () => {
    expect(readdirSync(ASSET_DIR).sort()).toEqual(Object.keys(ASSETS).sort());
    expect(readdirSync(path.join(ROOT, "public/assets")).sort()).toEqual(["clubs", "home"]); // clubs: the crests of the ten teams, covered by clubCrests.test.ts
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
    // The WORD may appear as text; what must not appear is any reference to a stadium image: no asset path, no image file, no background.
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

  it("brings nothing from the prototype: no script, no illustrative data, no mockup class or navigation hook, no external script besides the three this page already loaded, the club crests module and the two of the \"Próximos partidos\" card", () => {
    expect(Array.from(INDEX_HTML.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1])).toEqual(["/urbanoI18n.js", "/urbanoClubCrests.js", "/homeUpcomingData.js", "/homeUpcoming.js", "/urbanoAuth.js", "/hostAvailability.js"]);
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

  // (Halloween is no longer a catalog card: its announcement is the static section tested in "the Halloween announcement" below.)

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

  it("the Predictions card keeps its art, never gains an element image of its own, and a server match that is not one of the announced matches cannot change it", async () => {
    const none = await loadHome();
    const featured = (page: Page) => page.doc.getElementById("featured-predictions")!;
    expect(featured(none).className).toContain("art-card");
    expect(none.doc.querySelector("#featured-action")).toBeNull();
    // five announced matches, every one only a preselection (the chip never says a match is NOT open); once the server's list has been READ and holds
    // no match that accepts participation, the one sentence under the list says that nothing is open
    expect(none.doc.querySelectorAll("#featured-predictions .upcoming-item")).toHaveLength(5);
    expect(Array.from(none.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent)).toEqual(Array(5).fill("Preselección"));
    expect(none.text("#upcoming-status")).toBe("Todavía no hay partidos abiertos para participar.");
    expect((none.doc.getElementById("upcoming-status") as HTMLElement).hidden).toBe(false);
    const kickoff = new Date(Date.parse(HOME_NOW) + 3 * 3600_000).toISOString(); // three hours after the page's own clock (not the host's)
    const open = await loadHome(INDEX_HTML, {
      matches: [{ matchId: "m1", competition: "Liga", cancelledAt: null, finalized: false, kickoffAt: kickoff, homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: true } }] }],
    });
    expect(featured(open).className).toContain("art-card");
    expect(open.doc.querySelector("#featured-predictions img:not(.club-crest), #featured-predictions svg")).toBeNull(); // the only images are the decorative crests
    expect(Array.from(open.doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("id"))).toEqual(["featured-past", "featured-lineup"]);
    // the sentence follows the SERVER's list, not the rows: a match that accepts participation but is none of the announced ones changes the sentence and
    // nothing else (not one row, chip, link or word of the card)
    expect(open.text("#upcoming-status")).toBe("Hay partidos abiertos para participar. Los ves en la cartelera de Score.");
    expect((open.doc.getElementById("upcoming-status") as HTMLElement).hidden).toBe(false);
    const withoutSentence = (page: Page) => { const copy = featured(page).cloneNode(true) as HTMLElement; const status = copy.querySelector("#upcoming-status")!; status.textContent = ""; status.removeAttribute("hidden"); return copy.outerHTML; };
    expect(withoutSentence(open)).toBe(withoutSentence(none));
    expect(open.text("#featured-status")).toBe("Próximos partidos");
    expect(Array.from(open.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent)).toEqual(Array(5).fill("Preselección"));
    expect(violations(none)).toEqual([]);
    expect(violations(open)).toEqual([]);
  });

  it("a match is opened only by the server's word, and even then the card offers no way to play; a match without a confirmed hour can never be opened", async () => {
    const listed = (over: Record<string, unknown>) => ({ matchId: "s1", competition: "LaLiga", cancelledAt: null, finalized: false, venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: true } }], ...over });
    const valencia = listed({ kickoffAt: "2026-11-07T20:00:00.000Z", homeTeam: { name: "Valencia" }, awayTeam: { name: "Real Madrid" } });
    // the same two teams as the match with no hour, on that day, with an hour of the database's choosing: there is no instant to compare, so it is not the same match
    const motagua = listed({ matchId: "s2", kickoffAt: "2026-11-20T01:00:00.000Z", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" } });
    const page = await loadHome(INDEX_HTML, { matches: [valencia, motagua] });
    const rows = Array.from(page.doc.querySelectorAll("#upcoming-list .upcoming-item"));
    expect(rows.map((r) => [r.getAttribute("data-match"), r.getAttribute("data-state"), r.getAttribute("data-time")])).toEqual([
      ["N26-26", "open", "set"], ["N26-27", "next", "set"], ["N26-46", "next", "tbc"], ["N26-22", "next", "set"], ["N26-24", "next", "set"],
    ]);
    expect(rows.map((r) => r.querySelector(".upcoming-chip")!.textContent)).toEqual(["Abierto para participar", "Preselección", "Preselección", "Preselección", "Preselección"]);
    expect(rows[2].querySelector(".upcoming-time")!.textContent).toBe("jue 19 nov · Horario por confirmar");
    expect(page.doc.querySelector("#upcoming-list .upcoming-opens")).toBeNull(); // no window hour: the server reported none
    expect(page.text("#upcoming-status")).toBe("Hay partidos abiertos para participar. Los ves en la cartelera de Score.");
    // what is said is said; nothing is offered: the same two informational links and no call to action, in either language
    expect(violations(page)).toEqual([]);
    expect(Array.from(page.doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("href"))).toEqual(["/soccer-predictions.html#historial", "/soccer-predictions.html"]);
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    // (the list is redrawn in place for the new language: the rows are read again)
    expect(Array.from(page.doc.querySelectorAll("#upcoming-list .upcoming-chip")).map((c) => c.textContent)).toEqual(["Open to participate", "Shortlisted", "Shortlisted", "Shortlisted", "Shortlisted"]);
    expect(page.text("#upcoming-status")).toBe("Some matches are open for participation. You can see them in the Score fixtures.");
    expect(violations(page)).toEqual([]);
  });

  it("the list is informational: if it cannot start (a malformed editorial container), the card keeps its access links and ten crests, the failure is logged, and every catalog of the page still renders", async () => {
    const errors: unknown[][] = [];
    const broken = await loadHome(INDEX_HTML, { breakList: true, consoleErrors: errors });
    const whole = await loadHome();
    expect(errors.some((args) => String(args[0]).includes("the list of upcoming matches did not start"))).toBe(true);
    // the catalogs after the list in the page's script are the same as on a page whose list works
    for (const id of ["experiences-carousel", "games-carousel", "minigames-grid", "organizers-grid"]) {
      expect(broken.doc.getElementById(id)!.children.length, id).toBeGreaterThan(0);
      expect(broken.doc.getElementById(id)!.innerHTML, id).toBe(whole.doc.getElementById(id)!.innerHTML);
    }
    expect(Array.from(broken.doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("href"))).toEqual(["/soccer-predictions.html#historial", "/soccer-predictions.html"]);
    expect(broken.doc.querySelectorAll("#featured-teams li.crest-chip")).toHaveLength(10);
    expect(broken.doc.querySelectorAll("#upcoming-list .upcoming-item")).toHaveLength(0);
    expect((broken.doc.getElementById("upcoming-status") as HTMLElement).hidden).toBe(true); // no list, so no sentence either
    // the language selector still works on the rest of the page
    (broken.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(broken.text("#minigames .section-label")).toBe("Minigames");
    expect(broken.text("#featured-past")).toBe("My participations and prizes");
  });

  it("the ten crests are decoration in the Founder's order: each team is named in text, its crest is an empty-alt image hidden from assistive technology, and the file exists", async () => {
    for (const stored of ["es", "en"] as const) {
      const page = await loadHome(INDEX_HTML, { stored });
      const chips = Array.from(page.doc.querySelectorAll("#featured-teams ul.ten-crests > li.crest-chip")) as HTMLElement[];
      expect(chips.map((li) => li.getAttribute("data-club")), stored).toEqual(TEN_TEAMS);
      expect(page.doc.getElementById("featured-teams")!.querySelector("ul.ten-crests")!.getAttribute("aria-labelledby")).toBe("featured-teams-label");
      expect(page.text("#featured-teams-label")).toBe(stored === "es" ? "Equipos que podrían aparecer en URBANO Score" : "Teams that may appear in URBANO Score"); // "may appear": the strip promises no match
      for (const li of chips) {
        const club = li.getAttribute("data-club")!;
        expect(li.querySelector(".crest-name")!.textContent, club).toBe(club); // the written name is the accessible name, in both languages
        const crest = li.querySelector("img.club-crest") as HTMLImageElement | null;
        expect(crest, `${club} has its crest`).not.toBeNull(); // all ten are mandatory
        expect(crest!.getAttribute("alt"), club).toBe("");
        expect(crest!.getAttribute("aria-hidden"), club).toBe("true");
        expect(crest!.getAttribute("src"), club).toMatch(/^\/assets\/clubs\/[a-z-]+\.(?:svg|png)$/);
        expect(existsSync(path.join(ROOT, "public", crest!.getAttribute("src")!)), `${club} file`).toBe(true);
        expect(li.firstElementChild, club).toBe(crest); // the crest comes before the name, which only the stylesheet hides while the crest is drawn
      }
      expect(new Set(chips.map((li) => li.querySelector("img")!.getAttribute("data-crest"))).size).toBe(10); // ten different crests
    }
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
    expect(halloweenViolations(page.doc, HALLOWEEN.en)).toEqual([]); // the announcement is redrawn in English, in place, and is not enabled in either language
    expect(page.doc.querySelectorAll("#halloween")).toHaveLength(1);
    expect(page.card("URBANO Poker")!.querySelector(".status-pill")!.textContent).toBe("Playtest");
    expect(page.card("URBANO Poker")!.querySelector(".exp-action")!.textContent).toBe("Host →");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
    expect(page.doc.querySelectorAll("#minigames-grid .exp-card")).toHaveLength(2);
    expect(violations(page)).toEqual([]);
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
  });

  it("the Score card says the same in both languages: five matches, Honduras time, 'Horario por confirmar' where there is no hour, the separate way to earlier participations and prizes, and no way to play", async () => {
    const page = await loadHome();
    const rows = () => Array.from(page.doc.querySelectorAll("#upcoming-list .upcoming-item")).map((r) => ({
      id: r.getAttribute("data-match"), time: r.getAttribute("data-time"), datetime: r.querySelector("time")!.getAttribute("datetime"), when: r.querySelector(".upcoming-time")!.textContent,
      teams: Array.from(r.querySelectorAll(".upcoming-team")).map((t) => t.textContent), competition: r.querySelector(".upcoming-comp")!.textContent,
    }));
    expect(page.text("#featured-status")).toBe("Próximos partidos");
    expect(page.text(".featured-descriptor")).toBe("Preselección de los próximos partidos de URBANO Score.");
    expect(page.text("#featured-past")).toBe("Mis participaciones y premios");
    expect(page.text(".featured-access-note")).toBe("Tus participaciones en partidos finalizados y el estado de tus premios.");
    expect(page.text("#featured-lineup")).toBe("Ver cartelera de Score");
    expect(page.text("#featured-note")).toBe("Fechas y horarios informativos: pueden cambiar. Hora de Honduras.");
    expect((page.doc.getElementById("featured-note") as HTMLElement).hidden).toBe(false); // there are rows to which the note belongs
    expect(page.doc.getElementById("featured-note")!.className).toBe("featured-note");
    expect(page.text(".featured-legal")).toBe("Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.");
    expect(page.doc.getElementById("upcoming-list")!.getAttribute("aria-label")).toBe("Lista de próximos partidos");
    expect(rows()).toEqual([
      { id: "N26-26", time: "set", datetime: "2026-11-07T20:00:00Z", when: "sáb 7 nov · 🇭🇳 2:00 p. m.", teams: ["Valencia", "Real Madrid"], competition: "LaLiga" },
      { id: "N26-27", time: "set", datetime: "2026-11-08T20:00:00Z", when: "dom 8 nov · 🇭🇳 2:00 p. m.", teams: ["Atlético de Madrid", "FC Barcelona"], competition: "LaLiga" },
      { id: "N26-46", time: "tbc", datetime: "2026-11-19", when: "jue 19 nov · Horario por confirmar", teams: ["Motagua", "Olimpia"], competition: "Liga Nacional" },
      { id: "N26-22", time: "set", datetime: "2026-11-22T16:30:00Z", when: "dom 22 nov · 🇭🇳 10:30 a. m.", teams: ["Liverpool", "Manchester United"], competition: "Premier League" },
      { id: "N26-24", time: "set", datetime: "2026-11-29T16:30:00Z", when: "dom 29 nov · 🇭🇳 10:30 a. m.", teams: ["Arsenal", "Manchester City"], competition: "Premier League" },
    ]);
    expect(violations(page)).toEqual([]);
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.text("#featured-status")).toBe("Upcoming matches");
    expect(page.text(".featured-descriptor")).toBe("Shortlist of the upcoming URBANO Score matches.");
    expect(page.text("#featured-past")).toBe("My participations and prizes");
    expect(page.text(".featured-access-note")).toBe("Your participations in finished matches and the status of your prizes.");
    expect(page.text("#featured-lineup")).toBe("See the Score fixtures");
    expect(page.text("#featured-note")).toBe("Dates and times are informational and may change. Honduras time.");
    expect(page.doc.getElementById("upcoming-list")!.getAttribute("aria-label")).toBe("List of upcoming matches");
    expect(rows().map((r) => r.when)).toEqual(["Sat, Nov 7 · 🇭🇳 2:00 p.m.", "Sun, Nov 8 · 🇭🇳 2:00 p.m.", "Thu, Nov 19 · Time to be confirmed", "Sun, Nov 22 · 🇭🇳 10:30 a.m.", "Sun, Nov 29 · 🇭🇳 10:30 a.m."]);
    expect(rows().map((r) => r.datetime)).toEqual(["2026-11-07T20:00:00Z", "2026-11-08T20:00:00Z", "2026-11-19", "2026-11-22T16:30:00Z", "2026-11-29T16:30:00Z"]); // the machine-readable time never depends on the language
    expect(page.text("#upcoming-status")).toBe("No match is open for participation yet.");
    expect(page.text(".featured-legal")).toBe("Crests only identify the teams. URBANO is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here.");
    expect(violations(page)).toEqual([]);
  });

  it("the Score card has no state to show before there is something to say: with no match left in the list it says so and stays quiet, and the access to earlier participations remains", async () => {
    const page = await loadHome(INDEX_HTML, { now: "2026-12-30T00:00:00Z" }); // every announced match has passed
    expect(page.doc.querySelectorAll("#upcoming-list .upcoming-item")).toHaveLength(0);
    expect(page.text("#upcoming-list .upcoming-none")).toBe("Estamos preparando los próximos partidos.");
    expect((page.doc.getElementById("upcoming-status") as HTMLElement).hidden).toBe(true);
    expect((page.doc.getElementById("featured-note") as HTMLElement).hidden).toBe(true); // a note about the dates of the rows has nothing to say about no rows
    expect(page.text("#featured-past")).toBe("Mis participaciones y premios");
    expect(page.doc.querySelectorAll("#featured-teams li.crest-chip")).toHaveLength(10);
    expect(violations(page)).toEqual([]);
  });

  it("the English card says 'Shortlist': the descriptor and the chips use it, the old English word 'Preselection' and the old chip 'Not open yet' are gone, and so is their Spanish twin 'Aún no abierto'", async () => {
    const page = await loadHome(INDEX_HTML, { stored: "en" });
    expect(page.text("#featured-status")).toBe("Upcoming matches"); // the pill names the card; the descriptor and the chips say what the matches are
    expect(page.text(".featured-descriptor")).toMatch(/^Shortlist of the upcoming URBANO Score matches\.$/);
    expect(Array.from(page.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent)).toEqual(Array(5).fill("Shortlisted"));
    const featured = (p: Page) => (p.doc.getElementById("featured-predictions")!.textContent ?? "").replace(/\s+/g, " "); // (the Become a Host card says, about itself, that applications are "not open yet")
    expect(featured(page)).not.toMatch(/Preselection|Not open yet|Aún no abierto/i);
    // the same in Spanish after the switch back, in place
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(Array.from(page.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent)).toEqual(Array(5).fill("Preselección"));
    expect(featured(page)).not.toMatch(/Aún no abierto|Shortlist/);
    // no chip, in any state, says that a match is NOT open: the dictionary's own words
    const dictionary = page.win.UrbanoI18n.dictionary() as { es: Record<string, string>; en: Record<string, string> };
    for (const lang of ["es", "en"] as const) for (const key of Object.keys(dictionary[lang]).filter((k) => k.startsWith("upcoming.state."))) expect(dictionary[lang][key], `${lang} ${key}`).not.toMatch(/no abierto|not open/i);
  });

  it("the card makes no statement about prizes: the sentence that said prizes are shown only when confirmed is gone from the page and from the language table, and the only words about prizes are the way to the person's own earlier prizes", async () => {
    const REMOVED = ["Los premios de cada partido se muestran en URBANO Score solo cuando están confirmados", "The prizes of each match are shown in URBANO Score only when they are confirmed"];
    expect(INDEX_HTML).not.toMatch(/premios de cada partido|prizes of each match|solo cuando están confirmados|only when they are confirmed/i);
    expect(I18N_SOURCE).not.toMatch(/premios de cada partido|prizes of each match|solo cuando están confirmados|only when they are confirmed/i);
    for (const stored of ["es", "en"] as const) {
      const page = await loadHome(INDEX_HTML, { stored });
      // no element of the page carries the removed sentence, whole or in part
      const all = Array.from(page.doc.body.querySelectorAll("*")).filter((el) => !["SCRIPT", "STYLE"].includes(el.tagName));
      for (const sentence of REMOVED) {
        const carrying = all.filter((el) => (el.textContent ?? "").replace(/\s+/g, " ").includes(sentence));
        expect(carrying.map((el) => el.tagName + (el.id ? "#" + el.id : "")), `${stored}: ${sentence}`).toEqual([]);
      }
      // inside the card, an element that speaks of prizes is one of the two that lead to the person's own earlier prizes (the link and the note under it)
      const featured = page.doc.getElementById("featured-predictions")!;
      const speaking = Array.from(featured.querySelectorAll("*")).filter((el) => el.children.length === 0 && /premio|prize/i.test(el.textContent ?? ""));
      expect(speaking.map((el) => el.id || el.className), stored).toEqual(["featured-past", "featured-access-note"]);
      // and the legal line, in particular, speaks of crests, clubs and leagues only
      expect(page.text(".featured-legal"), stored).not.toMatch(/premio|prize/i);
    }
  });

  it("the lists on the card are announced as lists (role=\"list\", so a list style that removes the bullets does not take the structure away from assistive technology), and the access arrow is decoration that never reaches a link's name", async () => {
    for (const stored of ["es", "en"] as const) {
      const page = await loadHome(INDEX_HTML, { stored });
      const crests = page.doc.querySelector("#featured-teams ul.ten-crests")!;
      const upcoming = page.doc.getElementById("upcoming-list")!;
      expect([crests.tagName, crests.getAttribute("role")], stored).toEqual(["UL", "list"]);
      expect([upcoming.tagName, upcoming.getAttribute("role")], stored).toEqual(["UL", "list"]);
      expect(crests.getAttribute("aria-labelledby")).toBe("featured-teams-label");
      expect(upcoming.getAttribute("aria-label")).toBe(stored === "es" ? "Lista de próximos partidos" : "List of upcoming matches");
      // it stays a list of list items after every redraw (a language change is one)
      for (const item of Array.from(upcoming.children)) expect(item.tagName, stored).toBe("LI");
      for (const item of Array.from(crests.children)) expect(item.tagName, stored).toBe("LI");
      // the arrow is not in the document at all (it is CSS content with an empty alternative text): neither the text nor any label of the access links carries it
      for (const link of Array.from(page.doc.querySelectorAll("#featured-predictions a"))) {
        expect(link.textContent, `${stored} ${link.id}`).not.toMatch(/[→›»>]/);
        expect(link.getAttribute("aria-label"), `${stored} ${link.id}`).toBeNull(); // the name is the visible text, as written
        expect(link.querySelector("svg, img, [aria-hidden]"), `${stored} ${link.id}`).toBeNull();
      }
      (page.doc.querySelector(`[data-lang="${stored === "es" ? "en" : "es"}"]`) as HTMLElement).click();
      expect(page.doc.getElementById("upcoming-list")!.getAttribute("role")).toBe("list");
      expect(page.doc.querySelector("#featured-teams ul.ten-crests")!.getAttribute("role")).toBe("list");
    }
  });

  it("each row keeps its words in a fixed order and its 'vs' and away team together: teams (home, then 'vs' with the away team), then competition and time, then the state chip", async () => {
    for (const stored of ["es", "en"] as const) {
      const page = await loadHome(INDEX_HTML, { stored });
      for (const li of Array.from(page.doc.querySelectorAll("#upcoming-list > li.upcoming-item"))) {
        expect(Array.from(li.children).map((c) => c.className.split(" ")[0]), `${stored} ${li.getAttribute("data-match")}`).toEqual(["upcoming-teams", "upcoming-meta", "upcoming-chip"]);
        const teams = li.querySelector(".upcoming-teams")!;
        expect(Array.from(teams.children).map((c) => c.className), stored).toEqual(["upcoming-team", "upcoming-away"]);
        expect(Array.from(teams.querySelector(".upcoming-away")!.children).map((c) => c.className), stored).toEqual(["upcoming-vs", "upcoming-team"]);
        expect(teams.querySelector(".upcoming-vs")!.textContent, stored).toBe("vs"); // the same word in both languages, without a full stop
        const names = Array.from(teams.querySelectorAll(".upcoming-team")).map((t) => t.textContent);
        expect(names, stored).toHaveLength(2);
        expect(names.every((n) => !!n && n.trim() === n), stored).toBe(true);
        // every word of the block is one of the three (a name, "vs", a name); the descendant selectors the older tests use still find them
        expect(teams.textContent, stored).toBe(names[0] + "vs" + names[1]);
      }
    }
  });

  it("the sentence under the list is shown only for a list the server really gave: while the read is pending, and when it fails in ANY way (an error status, a refused sign-in, no list in the body, an unreadable body, a network error), it is empty and hidden, and the rows stay a preselection", async () => {
    const answers: Record<string, () => Promise<unknown>> = {
      "never answers": () => new Promise(() => {}),
      "HTTP 500": async () => ({ status: 500, json: async () => ({ matches: [] }) }),
      "HTTP 401": async () => ({ status: 401, json: async () => ({ matches: [] }) }),
      "a body that is not a list": async () => ({ status: 200, json: async () => ({ matches: "none" }) }),
      "a body without the list": async () => ({ status: 200, json: async () => ({}) }),
      "no body at all": async () => ({ status: 200, json: async () => null }),
      "a body that is not JSON": async () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      "no answer object": async () => undefined,
      "a network error": async () => { throw new TypeError("Failed to fetch"); },
    };
    for (const [name, fetchMatches] of Object.entries(answers)) {
      const page = await loadHome(INDEX_HTML, { stored: "es", fetchMatches });
      const status = page.doc.getElementById("upcoming-status") as HTMLElement;
      const quiet = (lang: "es" | "en") => {
        expect(status.textContent, `${name} (${lang})`).toBe("");
        expect(status.hidden, `${name} (${lang})`).toBe(true);
        const visible = page.doc.body.cloneNode(true) as HTMLElement;
        visible.querySelectorAll("script, style").forEach((n) => n.remove()); // the page's own source holds the dictionary
        expect(visible.textContent, `${name} (${lang})`).not.toMatch(/Todavía no hay partidos abiertos para participar|No match is open for participation|partidos abiertos para participar|matches are open for participation/);
        // the card itself is the same: five rows, each a preselection, with the two informational links and the ten crests
        expect(Array.from(page.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent), `${name} (${lang})`).toEqual(Array(5).fill(lang === "es" ? "Preselección" : "Shortlisted"));
        expect(page.doc.querySelectorAll("#featured-teams li.crest-chip"), name).toHaveLength(10);
        expect(violations(page), name).toEqual([]);
      };
      quiet("es");
      (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click(); // a change of language redraws the list and keeps it quiet
      quiet("en");
    }
  }, 30_000);

  it("a list that WAS read and holds an open match shows the 'open' sentence even when that match is not one of the rows; a list read without any open match (cancelled, finished, started, window not yet open, activation off, venue off, offer gone) shows the 'none' sentence", async () => {
    const at = (hours: number) => new Date(Date.parse(HOME_NOW) + hours * 3600_000).toISOString();
    const base = { matchId: "x1", competition: "Liga", cancelledAt: null, finalized: false, participationOpensAt: null, kickoffAt: at(3), homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: true } }] };
    const NONE = "Todavía no hay partidos abiertos para participar.";
    const OPEN = "Hay partidos abiertos para participar. Los ves en la cartelera de Score.";
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["open", {}, OPEN],
      ["open with a window that has opened", { participationOpensAt: at(-1) }, OPEN],
      ["cancelled", { cancelledAt: at(-5) }, NONE],
      ["finalized", { finalized: true }, NONE],
      ["already started", { kickoffAt: at(-1) }, NONE],
      ["window not yet open", { participationOpensAt: at(1) }, NONE],
      ["activation off", { venueActivations: [{ enabled: false, venue: { active: true }, offer: { available: true } }] }, NONE],
      ["venue not active", { venueActivations: [{ enabled: true, venue: { active: false }, offer: { available: true } }] }, NONE],
      ["offer not available", { venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: false } }] }, NONE],
      ["no activation", { venueActivations: [] }, NONE],
    ];
    for (const [name, over, expected] of cases) {
      const page = await loadHome(INDEX_HTML, { matches: [{ ...base, ...over }] });
      expect(page.text("#upcoming-status"), name).toBe(expected);
      expect((page.doc.getElementById("upcoming-status") as HTMLElement).hidden, name).toBe(false);
      expect(Array.from(page.doc.querySelectorAll(".upcoming-chip")).map((c) => c.textContent), name).toEqual(Array(5).fill("Preselección")); // none of these is one of the rows
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// CSS contract: legibility over a photograph, no sideways scrolling
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — CSS contract", () => {
  const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (max-width: 339px)"));
  const narrow = css.slice(css.indexOf("@media (max-width: 339px)"), css.indexOf("@media (max-width: 374px)")); // a 320 px phone
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

  it("text on a photograph is ivory with a shadow, pills are dark chips, and the Predictions pill uses the lighter purple (the contrast measurement depended on these)", () => {
    expect(rule(".art-card .exp-sub")).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.92\)/);
    expect(rule(".art-card .exp-sub")).toMatch(/text-shadow/);
    // the lines of the "Próximos partidos" card that sit directly on the picture (the descriptor, the note on the dates, the note
    // under the access to earlier participations, the label of the ten crests, the sentence under the list)
    for (const [selector, alpha] of [[".featured-descriptor", "0\\.95"], [".featured-note", "0\\.88"], [".featured-access-note", "0\\.86"], [".featured-teams-label", "0\\.78"], [".upcoming-status", "0\\.95"]] as const) {
      expect(rule(selector), selector).toMatch(new RegExp(`color:\\s*rgba\\(245,\\s*241,\\s*232,\\s*${alpha}\\)`));
      expect(rule(selector), selector).toMatch(/text-shadow:\s*0 1px 4px rgba\(0,\s*0,\s*0,\s*0\.8\)/);
    }
    // the rows of the list and the link to earlier participations are dark chips under ivory ink, so their text never depends on the picture
    expect(rule(".upcoming-item")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.74\)/);
    expect(rule(".upcoming-teams")).toMatch(/color:\s*var\(--ink\)/);
    expect(rule(".featured-access-link")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.78\)/);
    expect(rule(".featured-access-link")).toMatch(/color:\s*var\(--ink\)/);
    expect(rule(".art-card .status-pill")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\)/); // a deeper chip: the picture behind it is no longer dimmed
    expect(css).toMatch(/\.featured-card\.art-card \.status-pill\s*\{[^}]*background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\)/);
    expect(rule(".game-tile .status-pill")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.55\)/);
    expect(rule(".art-card .status-featured")).toMatch(/color:\s*var\(--exp-purple-soft\)/);
    expect(css).toMatch(/--exp-purple-soft:\s*#b57cff/i);
  });

  it("the rules added by the review: the note is .featured-note (the old classes are gone), the access arrow is decoration with an empty alternative text, 'vs' and the away team stay together, a row without an hour may wrap, the legal line and the label stay legible, the names have a layout of their own when no crest is drawn, and on a phone the pitch keeps its drawn size under an even dark layer", () => {
    // the renamed note, and the classes that left
    expect(rule(".featured-note")).not.toBe("");
    expect(css).not.toMatch(/\.featured-(?:window|scope|when)\b/);
    expect(CODE).not.toMatch(/featured-(?:window|scope|when)\b/);
    expect(INDEX_HTML).toMatch(/<p class="featured-note" id="featured-note" data-i18n="home\.upcoming\.note">/);
    // the arrow of the access link: a plain arrow first (for an engine that does not read the second declaration), then the same arrow with an EMPTY alternative text, so it is not part of the name
    expect(rule(".featured-access-link::after")).toMatch(/content:\s*"→";\s*content:\s*"→"\s*\/\s*"";/);
    expect(rule(".featured-access-link::after")).not.toMatch(/attr\(/);
    // "vs" and the away team do not come apart when the pair wraps; a match with a set hour never breaks its time, one without may
    expect(rule(".upcoming-away")).toMatch(/display:\s*inline-flex/);
    expect(rule(".upcoming-away")).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule(".upcoming-teams")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".upcoming-time")).toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/\.upcoming-item\[data-time="tbc"\] \.upcoming-time\s*\{[^}]*white-space:\s*normal/);
    // the small print is still readable: the legal line at least 12 px and alpha 0.8 (ivory on the dark card), the label of the ten crests 12 px
    const legal = rule(".featured-legal");
    expect(Number(legal.match(/font-size:\s*([\d.]+)px/)![1])).toBeGreaterThanOrEqual(12);
    expect(Number(legal.match(/color:\s*rgba\(245,\s*241,\s*232,\s*([\d.]+)\)/)![1])).toBeGreaterThanOrEqual(0.8);
    expect(rule(".featured-teams-label")).toMatch(/font-size:\s*12px/);
    // the safety net: with no crest drawn, the names flow in columns of their own instead of running into each other
    expect(rule(".ten-crests:not(:has(.club-crest))")).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(112px,\s*1fr\)\)/);
    // a phone: the drawing is not stretched to the height of the (tall) card, and the layer over it is even: it does NOT fall away to nothing like the bottom-up scrim of the other picture cards
    const before = Array.from(phone.matchAll(/\.featured-card\.art-card::before\s*\{([^}]*)\}/g)).map((m) => m[1]).join(" ");
    expect(before).toMatch(/background-size:\s*auto min\(100%,\s*460px\)/);
    expect(before).toMatch(/background-position:\s*right top/);
    const after = phone.match(/\.featured-card\.art-card::after\s*\{([^}]*)\}/)![1];
    expect(after).not.toMatch(/var\(--art-photo-scrim\)/);
    const [layer, ...others] = photoStops(after.match(/background:\s*([^;]+);?/)![1]);
    expect(others).toEqual([]);
    expect(layer.direction).toBe("0deg");
    expect(layer.stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of layer.stops) expect(stop.alpha).toBeGreaterThanOrEqual(0.8); // the least dark point is still dark: no line of the drawing crosses a line of text
    const scrim = photoStops(phone.match(/--art-photo-scrim:\s*([^;]+);/)![1])[0];
    expect(scrim.stops[scrim.stops.length - 1].alpha).toBe(0); // (the scrim the other picture cards keep on a phone does fall to nothing: the Score card must not use it)
  });

  it("the way into the lineup is an OUTLINED link, not the filled button an action gets: it informs, it does not invite (and the old 'Jugar ahora' button is gone from the stylesheet, the markup and the language table)", () => {
    const lineup = rule(".featured-lineup");
    expect(lineup).not.toBe(""); // the class exists
    expect(lineup).toMatch(/background:\s*transparent/);
    expect(lineup).toMatch(/border:\s*1px solid rgba\(245,\s*241,\s*232,\s*0\.4\)/); // a visible outline
    expect(lineup).toMatch(/color:\s*var\(--ink\)/);
    expect(lineup).not.toMatch(/--primary-fill|--primary-ink/); // not the filled primary pill the other cards use for an action
    expect(lineup).toMatch(/min-height:\s*4[4-9]px/);
    // the other way in (earlier participations and prizes) is a dark chip with a purple outline, not a filled button either
    expect(rule(".featured-access-link")).toMatch(/border:\s*1\.5px solid var\(--exp-purple-soft\)/);
    expect(rule(".featured-access-link")).not.toMatch(/--primary-fill|--primary-ink/);
    expect(rule(".featured-access-link")).toMatch(/min-height:\s*4[4-9]px/);
    // keyboard focus is visible on both
    expect(css).toMatch(/\.featured-lineup:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--gold\)/);
    expect(css).toMatch(/\.featured-access-link:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--gold\)/);
    // the retired button, everywhere it lived
    expect(CODE).not.toMatch(/featured-play|Jugar ahora|Play now/);
    expect(css).not.toMatch(/\.featured-play|\.featured-past\b|\.featured-crests?\b|\.featured-crest-vs/);
    expect(I18N_SOURCE).not.toMatch(/"home\.score\.|home\.upcoming\.pastLabel|Jugar ahora|Play now/);
  });

  it("the ten crests lay out as one row on a desktop and on a phone, and as two rows of five only on a 320 px phone; the written name is hidden only while its crest is drawn (never removed from the accessibility tree)", () => {
    expect(rule(".ten-crests")).toMatch(/grid-template-columns:\s*repeat\(10,\s*1fr\)/);
    expect(phone).toMatch(/\.ten-crests\s*\{[^}]*grid-template-columns:\s*repeat\(10,\s*minmax\(0,\s*1fr\)\)/); // still ONE row of ten on a 375 px phone ...
    expect(narrow).toMatch(/\.ten-crests\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/); // ... and two rows of five below 340 px, where one row would make them about 21 px
    expect(phone).toMatch(/\.ten-crests \.club-crest\s*\{[^}]*max-width:\s*30px/); // never larger than 30 px: the cell decides below that
    const hidden = rule(".ten-crests .club-crest + .crest-name"); // only a name that FOLLOWS a drawn crest is visually hidden
    expect(hidden).toMatch(/position:\s*absolute/);
    expect(hidden).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden|font-size:\s*0/);
    expect(rule(".ten-crests .crest-name")).toMatch(/color:\s*var\(--ink\)/); // without a crest, the name is plainly visible
    expect(rule(".ten-crests .club-crest")).toMatch(/width:\s*34px;\s*height:\s*34px/);
    // on a phone each match is three short lines (state and competition, teams, date and hour) in a grid whose second column may shrink, so nothing pushes the page sideways
    expect(phone).toMatch(/\.upcoming-item\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/);
    expect(phone).toMatch(/\.upcoming-chip\s*\{[^}]*grid-row:\s*1/);
    expect(phone).toMatch(/\.upcoming-meta\s*\{[^}]*display:\s*contents/);
    expect(phone).toMatch(/\.featured-access-note\s*\{[^}]*display:\s*none/); // the link names itself; its explanatory line is not shown on a phone
    expect(rule(".upcoming-list")).toMatch(/max-width:\s*560px/);
    expect(css).toMatch(/\.upcoming-item\[data-time="tbc"\] \.upcoming-time\s*\{[^}]*font-style:\s*italic/); // a match without an hour is set apart by more than colour
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
    const order = ["featured-predictions", 'id="experiences"', 'id="play"', 'id="minigames"', 'id="organizers"'].map((marker) => INDEX_HTML.indexOf(marker));
    expect([...order].sort((x, y) => x - y)).toEqual(order); // Score, Experiences, Trivia, Minigames, Organizers
    expect(order.every((i) => i > 0)).toBe(true);
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

  it("the Halloween announcement made actionable, or removed, is caught by the shared honesty check too", async () => {
    // (its own negative controls, bounded to its markup, are in "the Halloween announcement's negative controls")
    const actionable = mutated('class="exp-card art-card art-halloween is-locked"', 'class="exp-card art-card art-halloween is-actionable" tabindex="0"');
    expect(violations(await loadHome(actionable)).join("|")).toMatch(/Halloween announcement is not informational/);
    const removed = INDEX_HTML.replace(/<div class="section" id="halloween">[\s\S]*?\n<\/div>\n/, "");
    expect(removed).not.toBe(INDEX_HTML);
    expect(violations(await loadHome(removed)).join("|")).toMatch(/Halloween announcement is missing/);
  });

  it("a Rutas tile that links anywhere is caught", async () => {
    const html = mutated('title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "soon",', 'title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "playtest", href: "/rutas.html",');
    expect(violations(await loadHome(html)).join("|")).toMatch(/URBANO Rutas is not informational|link points at Rutas/);
  });

  it("an art image that is announced, eager or unsized is caught", async () => {
    // (the anchors are the catalog renderer's own image template: the Halloween announcement carries the same attributes as static markup, and has its own controls)
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
    const html = mutated('<span class="status-pill status-soon" id="featured-status"', '<img src="/assets/home/urbano-score-pitch.svg" alt=""><span class="status-pill status-soon" id="featured-status"');
    expect(violations(await loadHome(html)).join("|")).toMatch(/featured card contains an element image/);
  });

  it("a restored 'Jugar ahora' button, or the card losing its separate way to earlier participations and prizes, is caught", async () => {
    const play = mutated('<a class="featured-lineup" id="featured-lineup" href="/soccer-predictions.html" data-i18n="home.upcoming.play">Ver cartelera de Score</a>', '<a class="featured-play" id="featured-play" href="/soccer-predictions.html">Jugar ahora</a>');
    expect(violations(await loadHome(play)).join("|")).toMatch(/the featured card's links are not the two informational ones/);
    expect(violations(await loadHome(play)).join("|")).toMatch(/the featured card invites to play/);
    const noPast = mutated('      <a class="featured-access-link" id="featured-past" href="/soccer-predictions.html#historial" data-i18n="home.upcoming.past">Mis participaciones y premios</a>\n', "");
    expect(violations(await loadHome(noPast)).join("|")).toMatch(/the featured card's links are not the two informational ones/);
    const swapped = mutated('<a class="featured-lineup" id="featured-lineup" href="/soccer-predictions.html"', '<a class="featured-lineup" id="featured-lineup" href="/soccer-predictions.html#historial"');
    expect(violations(await loadHome(swapped)).join("|")).toMatch(/the featured card's links are not the two informational ones/);
  });

  it("the removed sentence about prizes restored on the card, or a list that loses its role, is caught", async () => {
    const prize = mutated('<p class="featured-legal" data-i18n="upcoming.disclaimer">', '<p class="featured-prizes">Los premios de cada partido se muestran en URBANO Score solo cuando están confirmados.</p><p class="featured-legal" data-i18n="upcoming.disclaimer">');
    expect(violations(await loadHome(prize)).join("|")).toMatch(/says something about prizes beyond the way to the person's own/);
    const plain = mutated('<ul class="upcoming-list" id="upcoming-list" role="list"', '<ul class="upcoming-list" id="upcoming-list"');
    expect(violations(await loadHome(plain)).join("|")).toMatch(/a list of the card lost its role/);
  });

  it("a strip that loses one of the ten teams, or a crest whose written name is gone, is caught", async () => {
    const noMotagua = mutated('        <li class="crest-chip" data-club="Motagua"><span class="crest-name">Motagua</span></li>\n', "");
    expect(violations(await loadHome(noMotagua)).join("|")).toMatch(/the strip of ten teams changed/);
    const nameless = mutated('<li class="crest-chip" data-club="Olimpia"><span class="crest-name">Olimpia</span></li>', '<li class="crest-chip" data-club="Olimpia"><span class="crest-name"></span></li>');
    expect(violations(await loadHome(nameless)).join("|")).toMatch(/Olimpia lost its written name/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The Halloween announcement: a static section between the hero and the Score card (rebuilt on the released base a619eb6; every assertion
// below is bounded to #halloween — the Score card above/below it keeps its own contract, tested elsewhere in this file and in the other suites)
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — the Halloween announcement (a static section above the Score card)", () => {
  const OPEN_MATCH = () => ({ matchId: "m1", competition: "Liga", cancelledAt: null, finalized: false, kickoffAt: new Date(Date.parse(HOME_NOW) + 3 * 3600_000).toISOString(), homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: true } }] });

  it("is an informational announcement with the approved words, the event and the date — no link, action, form, focusable control, countdown or prize promise", async () => {
    const page = await loadHome();
    const card = page.doc.querySelector("#halloween .exp-card") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.tagName).toBe("DIV");
    for (const cls of ["art-card", "art-halloween", "is-locked"]) expect(card.className).toContain(cls);
    expect(card.querySelector(".art-kicker")!.textContent).toBe("Halloween · Beer Box");
    expect(card.querySelector(".status-pill")!.textContent).toBe("Próximamente"); // shown in capitals by the pill's own style
    expect(card.querySelector("h2")!.textContent).toBe("Concurso de disfraces");
    expect(card.querySelector(".halloween-date")!.textContent).toBe("Sábado 31 de octubre");
    expect(card.querySelector(".exp-sub")!.textContent).toBe(HALLOWEEN.es.sub);
    expect(card.querySelector(".halloween-availability")!.textContent).toBe("Las inscripciones y la votación todavía no están disponibles.");
    expect(card.querySelector("img")!.getAttribute("src")).toBe("/assets/home/halloween-community.webp");
    expect(card.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(halloweenViolations(page.doc, HALLOWEEN.es)).toEqual([]);
    // it is its own section: it holds nothing of the Score card, and the Score card holds nothing of it
    expect(card.closest("#featured-predictions")).toBeNull();
    expect(page.doc.querySelector("#halloween #featured-predictions, #featured-predictions #halloween")).toBeNull();
  });

  it("is in the page's first paint, with no script, no session and no server", () => {
    // The HTML alone, scripts not run: what a visitor sees before anything loads (or with scripts disabled), and what a link preview reads.
    expect(halloweenViolations(staticDoc(INDEX_HTML), HALLOWEEN.es)).toEqual([]);
    // and the section's own markup depends on nothing: no script, no request, no session, no stored state
    const section = CODE.slice(CODE.indexOf('id="halloween"'), CODE.indexOf('<div class="section">', CODE.indexOf('id="halloween"')));
    expect(section.length).toBeGreaterThan(300);
    expect(section).not.toMatch(/<script|fetch\(|UrbanoAuth|localStorage|supabase|data-i18n-vars|\bonclick\b/i);
  });

  it("does not depend on the Score card or on any answer: the same card whether the matches list is empty, has an open match, fails, answers 500 or the editorial list is malformed", async () => {
    const none = await loadHome();
    const variants: Array<[string, Page, number]> = [
      ["no match open", none, 5],
      ["an open match", await loadHome(INDEX_HTML, { matches: [OPEN_MATCH()] }), 5],
      ["the list request fails", await loadHome(INDEX_HTML, { fetchMatches: async () => { throw new Error("offline"); } }), 5],
      ["the list answers HTTP 500", await loadHome(INDEX_HTML, { fetchMatches: async () => ({ status: 500, json: async () => ({ matches: [] }) }) }), 5],
      ["the editorial list is malformed (the Score list cannot start)", await loadHome(INDEX_HTML, { breakList: true }), 0],
    ];
    const reference = none.doc.querySelector("#halloween")!.outerHTML;
    for (const [label, page, rows] of variants) {
      expect(page.doc.querySelector("#halloween")!.outerHTML, label).toBe(reference);
      expect(halloweenViolations(page.doc, HALLOWEEN.es), label).toEqual([]);
      // and the Score card is exactly as its own contract says in each of those states (failure isolation: neither card affects the other)
      expect(page.doc.querySelectorAll("#featured-predictions .upcoming-item"), label).toHaveLength(rows);
      expect(Array.from(page.doc.querySelectorAll("#featured-predictions a")).map((a) => a.getAttribute("href")), label).toEqual(["/soccer-predictions.html#historial", "/soccer-predictions.html"]);
    }
  });

  it("says the same in English, in place, and again in Spanish: the card is redrawn, never duplicated, and starts in English when English is stored", async () => {
    const page = await loadHome();
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.doc.querySelectorAll("#halloween")).toHaveLength(1);
    expect(halloweenViolations(page.doc, HALLOWEEN.en)).toEqual([]);
    expect(page.doc.querySelector("#halloween .status-pill")!.textContent).toBe("Coming Soon");
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(halloweenViolations(page.doc, HALLOWEEN.es)).toEqual([]);
    const stored = await loadHome(INDEX_HTML, { stored: "en" });
    expect(halloweenViolations(stored.doc, HALLOWEEN.en)).toEqual([]);
    expect(stored.doc.querySelectorAll("#halloween")).toHaveLength(1);
  });

  it("every word comes from the language tables: the module's two dictionaries, the Spanish fallback and the markup carry the same Spanish words, and the English is the approved rendering", () => {
    const pick = (key: string) => Array.from(I18N_SOURCE.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`, "g"))).map((m) => m[1]);
    const fallback = INDEX_HTML.match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/)![1];
    for (const [field, key] of [["event", "home.halloween.event"], ["title", "home.halloween.title"], ["date", "home.halloween.date"], ["sub", "home.halloween.sub"], ["availability", "home.halloween.availability"], ["status", "home.status.soon"]] as const) {
      const [es, en] = pick(key);
      expect(pick(key), key).toHaveLength(2); // one entry per language
      expect(es, `${key} (es)`).toBe(HALLOWEEN.es[field]);
      expect(en, `${key} (en)`).toBe(HALLOWEEN.en[field]);
      expect(fallback, `${key} (Spanish fallback)`).toContain(`"${key}": "${HALLOWEEN.es[field]}"`);
      expect(INDEX_HTML, `${key} (markup default)`).toContain(`data-i18n="${key}"`);
    }
  });

  it("comes after the introduction and directly before the Score section; the order of everything else is unchanged and no navigation was removed", async () => {
    const page = await loadHome();
    const at = (selector: string) => page.doc.querySelector(selector)!;
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
    for (const [first, second] of [[".primary-nav", ".hero"], [".hero", "#halloween"], ["#halloween", "#featured-predictions"], ["#featured-predictions", "#experiences"], ["#experiences", "#play"], ["#play", "#minigames"], ["#minigames", "#organizers"]]) {
      expect(before(at(first), at(second)), `${first} comes before ${second}`).toBe(true);
    }
    expect(at(".hero").nextElementSibling).toBe(at("#halloween")); // directly after the hero
    expect(at("#halloween").nextElementSibling).toBe(at("#featured-predictions").closest(".section")); // directly before the Score section
    expect(page.doc.querySelectorAll("#halloween")).toHaveLength(1);
    expect(page.doc.querySelectorAll(".section")).toHaveLength(6); // the announcement + the five sections the page already had
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.getAttribute("href"))).toEqual(["/", "/#play", "/#experiences", "/leaderboards.html", "/rewards.html"]);
  });

  it("reads in the visual order and the title is a real heading, ahead of the Score card's: event, status, title, date, explanation, availability", async () => {
    const page = await loadHome();
    const card = page.doc.querySelector("#halloween .exp-card")!;
    const order = Array.from(card.querySelectorAll(".art-kicker, .status-pill, h2, .halloween-date, .exp-sub, .halloween-availability")).map((e) => (e.textContent ?? "").trim());
    expect(order).toEqual([HALLOWEEN.es.event, HALLOWEEN.es.status, HALLOWEEN.es.title, HALLOWEEN.es.date, HALLOWEEN.es.sub, HALLOWEEN.es.availability]);
    expect(page.doc.querySelectorAll("h1")).toHaveLength(1);
    const h2s = Array.from(page.doc.querySelectorAll("h2")).map((h) => h.textContent);
    expect(h2s.indexOf("Concurso de disfraces")).toBeGreaterThanOrEqual(0);
    expect(h2s.indexOf("Concurso de disfraces")).toBeLessThan(h2s.indexOf("URBANO Score")); // the announcement's heading comes first
    expect(card.querySelector("[tabindex], a, button, input, select, textarea")).toBeNull(); // nothing in it can take focus
  });

  it("the old catalog card, with its prize and voting promise, is gone: Poker is alone in Experiences and spans the row; Poker and Trivia keep their access", async () => {
    const page = await loadHome();
    const experiences = Array.from(page.doc.querySelectorAll("#experiences-carousel > .exp-card"));
    expect(experiences.map((c) => c.querySelector("h3")!.textContent)).toEqual(["URBANO Poker"]);
    expect(page.doc.querySelectorAll("#experiences-carousel .art-halloween")).toHaveLength(0);
    expect(INDEX_HTML).not.toMatch(/titleKey:\s*"home\.halloween\.title"/); // no catalog entry for the contest any more
    // the old promise is in no word the page or its language module ships (the exact old sentences, not a global word ban)
    for (const source of [INDEX_HTML, I18N_SOURCE]) expect(source).not.toMatch(/conquistá los votos|Votá por tu favorito|más votado|se lleva un premio|win the votes|Vote for your favorite|most-voted|wins a prize/);
    // Poker alone on its row: the rule that makes a lone card span both columns (with a second experience the grid is two columns again)
    expect(INDEX_HTML).toMatch(/\.experiences-grid > \.exp-card:only-child\s*\{\s*grid-column:\s*1 \/ -1;\s*\}/);
    const poker = page.card("URBANO Poker")!;
    expect(poker.tagName).toBe("A");
    expect(poker.getAttribute("href")).toBe("/host.html?experience=poker");
    const trivia = page.card("Trivia")!;
    expect(trivia.tagName).toBe("A");
    expect(trivia.getAttribute("href")).toBe("/trivia-playtest.html");
  });
});

describe("Home art — the Halloween announcement's CSS contract", () => {
  const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (max-width: 339px)"));

  it("its own rules: a title as large as a picture card's, lines in ivory with a shadow over the photograph, a deeper chip fill, and nothing that fixes a width", () => {
    expect(css).toMatch(/\.art-card h3,\s*\.art-halloween h2\s*\{[^}]*font-size:\s*26px;[^}]*line-height:\s*1\.15;[^}]*font-weight:\s*800;[^}]*max-width:\s*16ch;/);
    expect(css).toMatch(/\.art-halloween h2\s*\{\s*margin:\s*0;\s*\}/);
    expect(css).toMatch(/#halloween\s*\{\s*margin-top:\s*28px;\s*\}/); // a section without a label needs its own gap under the introduction
    expect(css).toMatch(/\.art-halloween \.art-kicker\s*\{\s*background:\s*rgba\(10,\s*10,\s*10,\s*0\.86\);\s*\}/); // the chip's small text clears 4.5:1 over the candles
    expect(css).toMatch(/\.halloween-date\s*\{[^}]*font-weight:\s*700;[^}]*rgba\(245,\s*241,\s*232,\s*0\.95\)[^}]*text-shadow/);
    expect(css).toMatch(/\.halloween-availability\s*\{[^}]*rgba\(245,\s*241,\s*232,\s*0\.92\)[^}]*text-shadow/);
    expect(css).not.toMatch(/(?:#halloween|\.art-halloween|\.halloween-date|\.halloween-availability)\s*\{[^}]*(?:^|[;\s])width\s*:/m); // no width on it or its lines, so nothing can overflow
    expect(css).not.toMatch(/(?:#halloween|\.art-halloween|\.halloween-date|\.halloween-availability)[^{]*:(?:hover|focus|active)/); // nothing to hover, focus or press
  });

  it("on a phone the words sit below a clear band of the photograph with the card's OWN scrim; the chips never break mid-label; the shared scrim and every other card are untouched", () => {
    expect(phone).toMatch(/\.art-card h3,\s*\.art-halloween h2\s*\{\s*font-size:\s*24px;\s*\}/);
    expect(phone).toMatch(/\.art-halloween\s*\{\s*--art-photo-scrim:\s*linear-gradient\(180deg,\s*rgba\(10,\s*10,\s*10,\s*0\)\s*0,\s*rgba\(10,\s*10,\s*10,\s*0\.12\)\s*50px,\s*rgba\(10,\s*10,\s*10,\s*0\.5\)\s*96px,\s*rgba\(10,\s*10,\s*10,\s*0\.9\)\s*136px,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)\s*100%\);\s*\}/);
    expect(phone).toMatch(/\.art-halloween \.exp-card-top\s*\{\s*margin-bottom:\s*84px;\s*flex-wrap:\s*wrap;\s*row-gap:\s*6px;\s*\}/);
    expect(phone).toMatch(/\.art-halloween \.art-kicker\s*\{\s*letter-spacing:\s*0\.08em;\s*white-space:\s*nowrap;\s*\}/);
    // the shared picture-card scrim on a phone is exactly what it was (the Halloween card overrides it only on itself)
    expect(phone.match(/:root\s*\{[^}]*--art-photo-scrim:\s*([^;]+);/)![1]).toMatch(/^linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)\s*0%/);
    // and the existing shared rules the section relies on are still there, unchanged
    expect(css).toMatch(/\.art-poker,\s*\.art-halloween\s*\{\s*min-height:\s*300px;\s*padding:\s*24px;\s*\}/);
    expect(phone).toMatch(/\.art-poker,\s*\.art-halloween\s*\{\s*min-height:\s*320px;\s*padding:\s*20px 18px;\s*\}/);
    expect(phone).toMatch(/\.art-halloween \.art-img\s*\{\s*object-position:\s*84% center;\s*\}/);
  });
});

describe("Home art — the Halloween announcement's negative controls", () => {
  // The section's own markup, changed in a COPY of the page; checked on the first paint, where the markup's own words show (once the language
  // module runs it writes the dictionary's words over the markup's, and the drift tests pin that the two are the same words).
  const SECTION = /<div class="section" id="halloween">[\s\S]*?\n<\/div>\n/;
  function mutatedSection(change: (section: string) => string): string {
    const found = INDEX_HTML.match(SECTION);
    expect(found, "the announcement section").not.toBeNull();
    const changed = change(found![0]);
    expect(changed, "the mutation changed something").not.toBe(found![0]);
    return INDEX_HTML.replace(found![0], changed);
  }
  const fp = (html: string) => halloweenViolations(staticDoc(html), HALLOWEEN.es);

  it("given a link, a button, a form, a focusable card or an inline handler, it is caught", () => {
    for (const add of ['<a class="halloween-vote" href="/vote.html">Votar</a>', '<button type="button">Inscribirme</button>', '<form action="/x"><input name="n"></form>', '<span tabindex="0">x</span>']) {
      expect(fp(mutatedSection((s) => s.replace('<p class="halloween-availability"', `${add}<p class="halloween-availability"`))).join("|"), add).toMatch(/interactive element/);
    }
    expect(fp(mutatedSection((s) => s.replace('class="exp-card art-card art-halloween is-locked"', 'class="exp-card art-card art-halloween is-locked" tabindex="0"'))).join("|")).toMatch(/interactive element/);
    expect(fp(mutatedSection((s) => s.replace('<h2 ', '<h2 onclick="go()" '))).join("|")).toMatch(/inline event handler/);
  });

  it("turned into an actionable card, or given a countdown, a prize, a price, a capacity, a sponsor, a number or other words, it is caught", () => {
    expect(fp(mutatedSection((s) => s.replace("art-halloween is-locked", "art-halloween is-actionable"))).join("|")).toMatch(/not informational/);
    expect(fp(mutatedSection((s) => s.replace('<p class="halloween-date"', '<time datetime="2026-10-31T20:00:00Z">cuenta regresiva</time><p class="halloween-date"'))).join("|")).toMatch(/countdown, a live region or a moment/);
    expect(fp(mutatedSection((s) => s.replace("Mostrá tu disfraz y preparate para elegir tus favoritos.", "Mostrá tu disfraz y ganá un premio de L 500."))).join("|")).toMatch(/prize, sponsor, capacity or price claim/);
    expect(fp(mutatedSection((s) => s.replace("Sábado 31 de octubre", "Sábado 31 de octubre, 40 cupos"))).join("|")).toMatch(/capacity or price claim/);
    expect(fp(mutatedSection((s) => s.replace("Sábado 31 de octubre", "Sábado 31 de octubre, 8:00 p. m."))).join("|")).toMatch(/number other than the date/);
    expect(fp(mutatedSection((s) => s.replace("Halloween · Beer Box</span>", "Halloween · Beer Box, patrocinado por una marca</span>"))).join("|")).toMatch(/sponsor|other than the approved words/);
    expect(fp(mutatedSection((s) => s.replace("Las inscripciones y la votación todavía no están disponibles.", "Inscribite ya y votá por tu favorito."))).join("|")).toMatch(/other than the approved words/);
  });

  it("its photograph announced, eager or unsized, or the announcement removed or moved out of its place, is caught", () => {
    const img = (change: (tag: string) => string) => staticDoc(mutatedSection((s) => s.replace(/<img [^>]*>/, change)));
    expect(img((t) => t.replace('alt=""', 'alt="Calabaza"')).querySelector("#halloween img")!.getAttribute("alt")).not.toBe("");
    expect(img((t) => t.replace(' loading="lazy"', "")).querySelector("#halloween img")!.getAttribute("loading")).not.toBe("lazy");
    expect(img((t) => t.replace(' width="1280" height="720"', "")).querySelector("#halloween img")!.hasAttribute("width")).toBe(false);
    expect(fp(INDEX_HTML.replace(SECTION, ""))).toEqual(["the Halloween card is missing"]);
    // moved below the Score section, it is no longer where the gate put it
    const moved = staticDoc(mutatedSection((s) => "") .replace(/<div class="section" id="experiences">/, `${INDEX_HTML.match(SECTION)![0]}<div class="section" id="experiences">`));
    expect(moved.querySelector("#halloween")!.nextElementSibling!.id).toBe("experiences");
    expect(moved.querySelector(".hero")!.nextElementSibling!.id).not.toBe("halloween");
  });
});
