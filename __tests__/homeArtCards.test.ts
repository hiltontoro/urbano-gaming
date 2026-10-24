import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The Home's editorial cards (Founder Design Review composition): URBANO Score as the featured art card (a static announcement over an
 * original pitch drawn in code), URBANO Poker and Halloween / Community as art cards, Trivia as a visual card of its own, and Rutas /
 * Towers as recognizable Minigame tiles.
 *
 * What this pins: (1) the two photographs (Poker, Halloween) are the only photographs, small local WebP derivatives of the reviewed
 * artwork, each pinned by hash and weight; the two other images are original SVG drawings made in code, also pinned by hash and weight; (2) the art is decoration only, so no card gains an operational action, an availability claim, a reward or an event
 * from the mockup; (3) availability stays exactly what it was (Poker keeps its destination and its Playtest label; everything else that
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
  for (const title of ["Halloween", "URBANO Rutas", "URBANO Towers", "Ser anfitrión", "URBANO Competitions"]) {
    if (title === "Ser anfitrión" && !card(title)) continue; // (Become a Host is named in English in the English page; its own tests pin it)
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

// ---------------------------------------------------------------------------------------------------------------------------------
// The photographs
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — the photographs and the Trivia motif", () => {
  it("public/assets/home holds exactly the reviewed assets: two photographs and two code-drawn motifs; no Level 33 art, no stadium photograph, no multi-sport photograph, no PNG original", () => {
    expect(readdirSync(ASSET_DIR).sort()).toEqual(Object.keys(ASSETS).sort());
    expect(readdirSync(path.join(ROOT, "public/assets"))).toEqual(["home"]);
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
    expect(INDEX_HTML).not.toMatch(/stadium/i);
    expect(I18N_SOURCE).not.toMatch(/stadium/i);
    for (const file of ["public/profile.html", "public/soccer-predictions.html"]) expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(/urbano-score-stadium|stadium/i);
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

  it("brings nothing from the prototype: no script, no illustrative data, no mockup class or navigation hook, no external script besides the three this page already loaded", () => {
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

  it("Halloween / Community: art and a Próximamente state, with no link, no action and no date, venue, reward or vote count", async () => {
    const page = await loadHome();
    const halloween = page.card("Halloween")!;
    expect(halloween.className).toContain("art-card");
    expect(halloween.tagName).toBe("DIV");
    expect(halloween.querySelector(".art-kicker")!.textContent).toBe("Comunidad");
    expect(halloween.querySelector(".status-pill")!.textContent).toBe("Próximamente");
    expect(halloween.querySelector(".exp-action")!.textContent).toBe("Próximamente");
    expect(halloween.querySelector("a, button, [tabindex]")).toBeNull();
    expect(halloween.textContent).not.toMatch(/\d/); // no date, time, count or reward
    expect(halloween.querySelector("img")!.getAttribute("src")).toBe("/assets/home/halloween-community.webp");
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

  it("the Predictions card keeps its art, never gains an element image, and the public matches list cannot change it (the announcement is static)", async () => {
    const none = await loadHome();
    expect(none.doc.getElementById("featured-predictions")!.className).toContain("art-card");
    expect(none.doc.querySelector("#featured-action")).toBeNull();
    const kickoff = new Date(Date.now() + 3 * 3600_000).toISOString();
    const open = await loadHome(INDEX_HTML, {
      matches: [{ matchId: "m1", competition: "Liga", cancelledAt: null, finalized: false, kickoffAt: kickoff, homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, venueActivations: [{ enabled: true, venue: { active: true } }] }],
    });
    expect(open.doc.getElementById("featured-predictions")!.className).toContain("art-card");
    expect(open.doc.querySelector("#featured-predictions img, #featured-predictions svg")).toBeNull();
    expect(open.doc.querySelector("#featured-predictions a:not(#featured-history)")).toBeNull();
    expect(open.doc.getElementById("featured-predictions")!.outerHTML).toBe(none.doc.getElementById("featured-predictions")!.outerHTML);
    expect(open.text("#featured-status")).toBe("Próximamente");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Both languages
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Home art — Spanish and English", () => {
  it("every new word follows the selector, in place: the cards are redrawn, never duplicated", async () => {
    const page = await loadHome();
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
    expect(page.card("Halloween")!.querySelector(".art-kicker")!.textContent).toBe("Comunidad");
    (page.doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(page.text("#minigames .section-label")).toBe("Minigames");
    expect(page.card("Halloween")!.querySelector(".art-kicker")!.textContent).toBe("Community");
    expect(page.card("Halloween")!.querySelector(".status-pill")!.textContent).toBe("Coming Soon");
    expect(page.card("URBANO Poker")!.querySelector(".status-pill")!.textContent).toBe("Playtest");
    expect(page.card("URBANO Poker")!.querySelector(".exp-action")!.textContent).toBe("Host →");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
    expect(page.doc.querySelectorAll("#minigames-grid .exp-card")).toHaveLength(2);
    expect(violations(page)).toEqual([]);
    (page.doc.querySelector('[data-lang="es"]') as HTMLElement).click();
    expect(page.text("#minigames .section-label")).toBe("Minijuegos");
    expect(page.doc.querySelectorAll("img.art-img")).toHaveLength(2);
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

  it("a dark scrim sits between every photograph and its text: strongest where the text is, on desktop and on a phone", () => {
    const desktop = css.match(/--art-scrim:\s*([^;]+);/)![1];
    expect(desktop).toMatch(/linear-gradient\(90deg,\s*rgba\(10,\s*10,\s*10,\s*0\.9\)/); // darkest on the text side
    const mobile = phone.match(/--art-scrim:\s*([^;]+);/)![1];
    expect(mobile).toMatch(/linear-gradient\(0deg,\s*rgba\(10,\s*10,\s*10,\s*0\.96\)/); // text sits low on a narrow card: darkest at the bottom
    expect(rule(".art-scrim")).toMatch(/background:\s*var\(--art-scrim\)/);
    expect(css).toMatch(/\.featured-card\.art-card::after\s*\{[^}]*var\(--art-scrim\)/);
    for (const selector of [".art-scrim", ".art-img"]) expect(rule(selector), selector).toMatch(/pointer-events:\s*none/);
  });

  it("text on a photograph is ivory with a shadow, pills are dark chips, and the Predictions pill uses the lighter purple (the contrast measurement depended on these)", () => {
    expect(rule(".art-card .exp-sub")).toMatch(/color:\s*rgba\(245,\s*241,\s*232,\s*0\.92\)/);
    expect(rule(".art-card .exp-sub")).toMatch(/text-shadow/);
    expect(css).toMatch(/\.featured-card\.art-card \.featured-note\s*\{[^}]*rgba\(245,\s*241,\s*232,\s*0\.92\)[^}]*text-shadow/);
    expect(rule(".art-card .status-pill")).toMatch(/background:\s*rgba\(10,\s*10,\s*10,\s*0\.72\)/);
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

  it("Halloween turned into an actionable card is caught", async () => {
    const html = mutated(
      'art: { src: "/assets/home/halloween-community.webp", className: "art-halloween", kickerKey: "home.art.community" },\n      title: "Halloween",\n      subKey: "home.halloween.sub",\n      status: "soon",',
      'art: { src: "/assets/home/halloween-community.webp", className: "art-halloween", kickerKey: "home.art.community" },\n      title: "Halloween",\n      subKey: "home.halloween.sub",\n      status: "playtest", href: "/rutas.html",'
    );
    const found = violations(await loadHome(html));
    expect(found.join("|")).toMatch(/Halloween is not informational|link points at Rutas/);
  });

  it("a Rutas tile that links anywhere is caught", async () => {
    const html = mutated('title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "soon",', 'title: "URBANO Rutas",\n      subKey: "home.rutas.sub",\n      status: "playtest", href: "/rutas.html",');
    expect(violations(await loadHome(html)).join("|")).toMatch(/URBANO Rutas is not informational|link points at Rutas/);
  });

  it("an art image that is announced, eager or unsized is caught", async () => {
    expect(violations(await loadHome(mutated('alt="" width="1280" height="720" loading="lazy" decoding="async"', 'alt="Poker table" width="1280" height="720" loading="lazy" decoding="async"'))).join("|")).toMatch(/not decorative/);
    expect(violations(await loadHome(mutated('alt="" width="1280" height="720" loading="lazy" decoding="async"', 'alt="" width="1280" height="720" decoding="async"'))).join("|")).toMatch(/not lazy-loaded/);
    expect(violations(await loadHome(mutated('alt="" width="1280" height="720" loading="lazy" decoding="async"', 'alt="" loading="lazy" decoding="async"'))).join("|")).toMatch(/no intrinsic size/);
    expect(violations(await loadHome(mutated('<span class="art-scrim" aria-hidden="true"></span>', '<span class="art-scrim"></span>'))).join("|")).toMatch(/scrim is announced/);
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
});
