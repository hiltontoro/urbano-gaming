import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The pictures of the Home's experience panels.
 *
 * What this pins: (1) the five photographs (Halloween on the featured card, then Voting, Score, Trivia and Poker in the panels) are the only pictures, small local
 * WebP derivatives of the reviewed artwork, each pinned by hash and weight, and none is a drawing made in code; (2) the page references exactly these five files,
 * each once, and nothing else (no remote image, no preload, no stadium photograph, no Level 33 art), and loads no script it does not need.
 *
 * Update of 2026-10-31 (Founder direction: the Home shows four experiences): the Home's panels replaced the editorial cards this file used to test
 * (the featured Score card with its list of coming matches, the Poker / Trivia / Rutas / Towers / Host / Competitions cards, the Halloween announcement).
 * The tests of THOSE cards (their availability, their wording, their CSS, their negative controls) were retired with them; they are in git history at
 * 98bb902, and the old Home is kept in archive/home.score-card-2026-10-29.html. What the cards' CSS tests protected, and still applies to the
 * panels (a dark scrim between a picture and its words, pictures shown at their own brightness, ivory words with a shadow over a picture, dark chips,
 * nothing faded, nothing that scrolls sideways), is pinned for the panels in __tests__/experienceHome.test.ts. The assets, and their provenance, stay here.
 *
 * Limits, stated plainly: jsdom does not lay a page out or paint it. Legibility over the pictures is measured in a real browser, not here.
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
// The page without its explanatory comments: they may legitimately name the mockup or the retired Level 33 card.
const CODE = INDEX_HTML.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
const ASSET_DIR = path.join(ROOT, "public/assets/home");

// Provenance.
//  - Poker and Halloween: derivatives of original images generated for URBANO Gaming and archived with their prompt and hash in the
//    Founder Design Review package (Assets/Artwork, "Artwork prompts and provenance.json", status PROPOSED_EDITORIAL_ART_NOT_PRODUCT_RULES):
//    the source resized to 1280x720 and encoded as lossy WebP (quality 72). "Level 33 board.png" is deliberately NOT here.
//  - URBANO Score and URBANO Trivia (Founder, 2026-10-31): derivatives of the Founder's photographs "URBANO Score Multisport v2.png" and "URBANO Trivia Mobile v2.png",
//    made with OpenAI image generation from the v1 originals ("URBANO Score.png", "URBANO Trivia.png"); the originals, and the prompts ("Generation prompts.txt",
//    "Revision prompts v2.txt"), are kept in Product/AI Photos/2026-10-31/. Same recipe as the two above: 1280x720, lossy WebP (quality 72), simple "VP8 " container.
//    They REPLACE the two drawings made in code (a schematic pitch, a line motif), which were removed from the tree; the stadium photograph without provenance
//    stays unpublished, and this file pins that it is not in the tree.
//  - URBANO Voting (Founder, 2026-10-31): derivative of the Founder's photograph "URBANO Voting.png" (a live-music audience choosing on their phones), made with OpenAI
//    image generation; the original and its prompt ("Voting generation prompt.txt") are kept in Product/AI Photos/2026-10-31/. It is a conceptual promotional
//    photograph, NOT a screenshot of an implemented interface (the portraits on the phone are not the screen of any URBANO page). Same recipe as the others: 1280x720,
//    lossy WebP (quality 72), simple "VP8 " container. It REPLACES a drawing made in code (a podium and a ballot) that stood in for it and was removed from the tree.
//    The Halloween photograph is NOT used for Voting (it belongs to the featured card, and no picture appears twice on the Home).
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
  "urbano-score.webp": {
    sourceSha256: "2a60fcc93fcdb58deb2e77cf7310104a10bc254666ac3af174795c3ac6451fad", // "URBANO Score Multisport v2.png"
    sha256: "35fd56c117e25605ca578392881b12e86e3cc41d9d28db0f7b31448be457b3e9",
    maxBytes: 100_000, width: 1280, height: 720,
  },
  "urbano-trivia.webp": {
    sourceSha256: "fb9618a642d3d6367bc71b4ead359626356b63b17b4de7b7714372e97732e051", // "URBANO Trivia Mobile v2.png"
    sha256: "cf7c000d1908efb3ca1cbda12fd689281d275d9ee176ace7d2c4a2b284ae7d31",
    maxBytes: 70_000, width: 1280, height: 720,
  },
  "urbano-voting.webp": {
    sourceSha256: "bfa247d20cbf67273525618b75b62eb69019d8459a5432e3f24c592b694a861c", // "URBANO Voting.png"
    sha256: "497af051ff770b208424bf6618f5e7a234f1dd8849fb5ecb98cd9af177c454d9",
    maxBytes: 70_000, width: 1280, height: 720,
  },
};
const PHOTOS = Object.keys(ASSETS).filter((n) => n.endsWith(".webp"));
const DRAWINGS = Object.keys(ASSETS).filter((n) => n.endsWith(".svg"));
const TOTAL_PHOTO_BUDGET_BYTES = 300_000;

describe("Home art — the five photographs", () => {
  it("public/assets/home holds exactly the reviewed assets: five photographs and nothing else; no drawing, no Level 33 art, no stadium photograph, no PNG original", () => {
    expect(readdirSync(ASSET_DIR).sort()).toEqual(Object.keys(ASSETS).sort());
    expect(readdirSync(path.join(ROOT, "public/assets")).sort()).toEqual(["clubs", "home"]); // clubs: the crests of the ten teams, covered by clubCrests.test.ts
    expect(readdirSync(ASSET_DIR).join(" ")).not.toMatch(/level|soccer-predictions|sports|stadium/i);
    expect(PHOTOS).toEqual(["halloween-community.webp", "urbano-poker.webp", "urbano-score.webp", "urbano-trivia.webp", "urbano-voting.webp"]);
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

  it("no picture of the Home is a drawing made in code any more; if one is ever added it must be a tiny, self-contained, decorative SVG: no script, no external reference, no text, no embedded image, hidden from assistive technology", () => {
    expect(DRAWINGS).toEqual([]);
    expect(readdirSync(ASSET_DIR).filter((n) => /\.svg$/i.test(n))).toEqual([]);
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

  it("the page references exactly these five, each once, and nothing else: no other image file, no remote image, no preload", () => {
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

  it("brings nothing from the prototype: no illustrative data, no mockup class or navigation hook, and no external script besides the language module, the club crests module, the featured card's module and the shared sign-in", () => {
    expect(Array.from(INDEX_HTML.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1])).toEqual(["/urbanoI18n.js", "/urbanoClubCrests.js", "/featuredContest.js", "/urbanoAuth.js"]);
    expect(CODE).not.toMatch(/\bug-[a-z-]+|data-jump|data-view|data-panel|Founder Design Review|DESIGN PROTOTYPE|Illustrative data|ACRE8M|Community Cup|Community Soccer/);
  });
});
