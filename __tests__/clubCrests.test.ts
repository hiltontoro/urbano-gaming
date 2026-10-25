import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * CLUB CRESTS — the two official crests the Founder authorised for the LOCAL candidate (FC Barcelona and Real Madrid CF), and the module that
 * is the only place that knows them. This is not a licence from either club and nothing here implies one; what it proves is the shape the
 * Founder asked for: provenance written down, everything in ONE central place so a crest can be replaced or withdrawn by changing that
 * place, no crest ever the only way a team is identified (the name is always text), and nothing but crests (no photograph of a player).
 */

const ROOT = process.cwd();
const MODULE_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const CLUBS_DIR = path.join(ROOT, "public/assets/clubs");
const PAGES = ["index.html", "soccer-predictions.html", "profile.html"].map((file) => [file, readFileSync(path.join(ROOT, "public", file), "utf8")] as const);

/** A minimal decoder for what the crest file is (non-interlaced, 8-bit RGBA): enough to read its pixels without a dependency. */
function decodePng(buffer: Buffer) {
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); const type = buffer.toString("latin1", offset + 4, offset + 8); const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12]; }
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) return { width, height, bitDepth, colorType, data: Buffer.alloc(width * height * 4) };
  const raw = inflateSync(Buffer.concat(idat)); const stride = width * 4; const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? data[y * stride + x - 4] : 0, up = y > 0 ? data[(y - 1) * stride + x] : 0, upLeft = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4] : 0;
      let value = row[x];
      if (filter === 1) value += left; else if (filter === 2) value += up; else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      data[y * stride + x] = value & 255;
    }
  }
  return { width, height, bitDepth, colorType, data };
}

function loadModule(source = MODULE_SOURCE) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
  dom.window.eval(source);
  const crests = (dom.window as unknown as { UrbanoClubCrests: any }).UrbanoClubCrests;
  return { dom, doc: dom.window.document, crests };
}

describe("which team gets which crest", () => {
  const { crests } = loadModule();

  it.each([
    ["FC Barcelona", "fc-barcelona"],
    ["fc barcelona", "fc-barcelona"],
    ["  FC   Barcelona ", "fc-barcelona"],
    ["Barcelona", "fc-barcelona"],
    ["Real Madrid CF", "real-madrid-cf"],
    ["REAL MADRID", "real-madrid-cf"],
    ["Real Madrid C.F.", null], // not guessed: an unlisted spelling shows no crest rather than a wrong one
  ])("%s → %s", (name, key) => {
    expect(crests.forTeam(name)?.key ?? null).toBe(key);
  });

  it("matches the whole name only: a team that merely contains a club's word (a test fixture, another club) has no crest", () => {
    for (const name of ["Barcelona c54ae13a", "Real Madrid 3232428e", "Barcelona SC", "Real Madrid Castilla", "Deportivo Barcelona", "", "   ", null, undefined]) {
      expect(crests.forTeam(name), String(name)).toBeNull();
    }
  });
});

describe("the crest element", () => {
  it("is decoration: an image with no alternative text of its own, hidden from assistive technology, because the team's name is written beside it", () => {
    const { crests } = loadModule();
    const img = crests.element("FC Barcelona") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("src")).toBe("/assets/clubs/fc-barcelona.svg");
    expect(img.className).toBe("club-crest");
    expect(img.getAttribute("width")).toBe("24");
    expect(img.getAttribute("height")).toBe("24");
  });

  it("removes itself when its file cannot be loaded, leaving only the name: the text is the fallback", () => {
    const { crests, doc, dom } = loadModule();
    const holder = doc.createElement("span");
    holder.textContent = "Real Madrid CF";
    const img = crests.element("Real Madrid CF") as HTMLImageElement;
    holder.insertBefore(img, holder.firstChild);
    doc.body.appendChild(holder);
    expect(holder.querySelectorAll("img")).toHaveLength(1);
    img.dispatchEvent(new dom.window.Event("error"));
    expect(holder.querySelectorAll("img")).toHaveLength(0);
    expect(holder.textContent).toBe("Real Madrid CF");
  });

  it("gives nothing for a team without a crest", () => {
    expect(loadModule().crests.element("Alpha FC")).toBeNull();
  });
});

describe("decorating a page", () => {
  it("puts the crest in front of the text of each [data-club] element, once, and leaves the text and every other element exactly as they were", () => {
    const { crests, doc } = loadModule();
    doc.body.innerHTML = `<p><span id="a" data-club="FC Barcelona">FC Barcelona</span> vs <span id="b" data-club="Real Madrid CF">Real Madrid CF</span> and <span id="c" data-club="Alpha FC">Alpha FC</span></p>`;
    expect(crests.decorate(doc)).toBe(2);
    expect(crests.decorate(doc)).toBe(0); // again: nothing is added twice
    const [a, b, c] = ["a", "b", "c"].map((id) => doc.getElementById(id)!);
    expect(a.firstElementChild?.getAttribute("data-crest")).toBe("fc-barcelona");
    expect(b.firstElementChild?.getAttribute("data-crest")).toBe("real-madrid-cf");
    expect(c.querySelector("img")).toBeNull();
    expect([a, b, c].map((node) => node.textContent)).toEqual(["FC Barcelona", "Real Madrid CF", "Alpha FC"]);
    expect(doc.querySelectorAll("img.club-crest")).toHaveLength(2);
  });
});

describe("withdrawing the crests", () => {
  it("is one switch: with ENABLED false the module gives no crest to anybody and decorates nothing", () => {
    expect(MODULE_SOURCE.match(/var ENABLED = true;/g)).toHaveLength(1);
    const { crests, doc } = loadModule(MODULE_SOURCE.replace("var ENABLED = true;", "var ENABLED = false;"));
    expect(crests.enabled()).toBe(false);
    expect(crests.forTeam("FC Barcelona")).toBeNull();
    expect(crests.element("Real Madrid CF")).toBeNull();
    doc.body.innerHTML = `<span data-club="FC Barcelona">FC Barcelona</span>`;
    expect(crests.decorate(doc)).toBe(0);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.body.textContent).toBe("FC Barcelona");
  });

  it("no page names a crest file: only the central module does, so replacing or removing a crest is a change in that one place", () => {
    for (const [file, html] of PAGES) {
      expect(html, file).not.toMatch(/assets\/clubs/);
      expect(html, file).not.toMatch(/fc-barcelona|real-madrid-cf/);
    }
    expect(MODULE_SOURCE.match(/\/assets\/clubs\//g)).toHaveLength(2);
  });

  it("every page that draws crests degrades to text without the module: it asks for the module only if it is there", () => {
    for (const [file, html] of PAGES) {
      expect(html, file).toMatch(/<script src="\/urbanoClubCrests\.js"><\/script>/);
      expect(html, file).toMatch(/if \(window\.UrbanoClubCrests\)|window\.UrbanoClubCrests\s*&&/);
    }
  });
});

describe("the files and where they came from", () => {
  const { crests } = loadModule();
  const entries = crests.all() as Array<{ key: string; src: string; provenance: Record<string, string> }>;

  it("are exactly two files under public/assets/clubs — FC Barcelona's vector and Real Madrid's full-colour PNG — crests only, no photograph of a player, no kit, no other club asset", () => {
    expect(readdirSync(CLUBS_DIR).sort()).toEqual(["fc-barcelona.svg", "real-madrid-cf.png"]);
    expect(entries.map((e) => path.basename(e.src)).sort()).toEqual(["fc-barcelona.svg", "real-madrid-cf.png"]);
    expect(statSync(path.join(CLUBS_DIR, "fc-barcelona.svg")).size).toBeLessThan(12_000);
    expect(statSync(path.join(CLUBS_DIR, "real-madrid-cf.png")).size).toBeLessThan(100_000); // a crest, not a poster: it is drawn at 24–34 px
  });

  it("are the files whose provenance is written down: each one's hash is the one recorded, the source and its date are stated, and Real Madrid's records the terms its source states", () => {
    for (const entry of entries) {
      const file = readFileSync(path.join(ROOT, "public", entry.src));
      expect(createHash("sha256").update(file).digest("hex"), entry.key).toBe(entry.provenance.fileSha256);
      expect(entry.provenance.sourceSha256, entry.key).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.provenance.retrievedAtUtc, entry.key).toMatch(/^2026-10-2\dT\d{2}:\d{2}:\d{2}Z$/);
      expect(entry.provenance.what.length, entry.key).toBeGreaterThan(20);
    }
    const fcb = entries.find((e) => e.key === "fc-barcelona")!;
    const rm = entries.find((e) => e.key === "real-madrid-cf")!;
    expect(new URL(fcb.provenance.from).hostname).toBe("www.fcbarcelona.es");
    expect(new URL(rm.provenance.from).hostname).toBe("pngdownload.io");
    expect(new URL(rm.provenance.page).hostname).toBe("pngdownload.io");
    // honest about what the source is and says: a third-party site, whose label is its own and grants nothing over the club's mark
    expect(rm.provenance.what).toMatch(/third-party image site that the Founder named/);
    expect(rm.provenance.siteTerms).toMatch(/Creative Commons 4\.0 BY-NC/);
    expect(rm.provenance.siteTerms).toMatch(/cannot grant rights over the club's mark/);
    expect(rm.provenance.siteTerms).toMatch(/non-commercial/);
    // the file used derives from the original download only by cropping its empty margin and reducing it: its hash differs, the original's is kept
    expect(rm.provenance.sourceSha256).not.toBe(rm.provenance.fileSha256);
    expect(rm.provenance.sourceSha256).toBe("c253e59f64d3769500d50d1fee8194cf84d38438cf71cf5dfc403d27f1796a06");
  });

  it("the SVG is an inert vector image: no script, no event handler, no external reference, no embedded raster, no style or foreign object", () => {
    for (const entry of entries.filter((e) => e.src.endsWith(".svg"))) {
      const svg = readFileSync(path.join(ROOT, "public", entry.src), "utf8");
      expect(svg.trimStart().startsWith("<svg"), entry.key).toBe(true);
      expect(svg, entry.key).toMatch(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg, entry.key).not.toMatch(/<script|\son[a-z]+\s*=|href\s*=|<image|<foreignObject|<style|@import|url\(\s*["']?https?:|data:/i);
    }
  });

  describe("Real Madrid's PNG is the whole crest in colour, with real transparency, readable on the dark pages", () => {
    const png = decodePng(readFileSync(path.join(CLUBS_DIR, "real-madrid-cf.png")));
    const pixels = png.width * png.height;
    const at = (x: number, y: number) => { const i = (y * png.width + x) * 4; return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] }; };
    const opaque: Array<{ r: number; g: number; b: number }> = [];
    for (let i = 0; i < pixels; i++) if (png.data[i * 4 + 3] >= 200) opaque.push({ r: png.data[i * 4], g: png.data[i * 4 + 1], b: png.data[i * 4 + 2] });
    const hue = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return { h: 0, s: 0, v: max / 255 };
      const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return { h: h * 60, s: d / max, v: max / 255 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const share = (test: (c: { h: number; s: number; v: number }) => boolean) => opaque.filter((c) => test(hue(c))).length / opaque.length;

    it("is an 8-bit RGBA image with transparent corners: a real alpha channel, not a background painted white or a checkerboard", () => {
      expect(png.colorType).toBe(6);
      expect(png.bitDepth).toBe(8);
      for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) expect(at(x, y).a, `corner ${x},${y}`).toBe(0);
      const transparent = (() => { let n = 0; for (let i = 0; i < pixels; i++) if (png.data[i * 4 + 3] === 0) n++; return n / pixels; })();
      expect(transparent).toBeGreaterThan(0.2);
      expect(transparent).toBeLessThan(0.4); // the crest fills most of the file: the margin was cropped
    });

    it("keeps the proportion of the crest as the source has it (width / height of the original's crest is 0.7444) and is not squeezed into a square", () => {
      expect(png.width / png.height).toBeGreaterThan(0.74);
      expect(png.width / png.height).toBeLessThan(0.75);
      expect(png.height).toBe(256);
    });

    it("is the crest in colour, not a silhouette: gold, blue, white and the red of the crown are all there, in the proportions of the crest", () => {
      expect(share((c) => c.h > 35 && c.h < 55 && c.s > 0.7 && c.v > 0.7)).toBeGreaterThan(0.3); // the gold ring, letters and crown
      expect(share((c) => c.h > 200 && c.h < 230 && c.s > 0.7 && c.v > 0.3)).toBeGreaterThan(0.2); // the blue band and outline
      expect(share((c) => c.s < 0.12 && c.v > 0.9)).toBeGreaterThan(0.15); // the white of the shield
      expect(share((c) => (c.h < 15 || c.h > 340) && c.s > 0.6 && c.v > 0.6)).toBeGreaterThan(0.015); // the red of the crown
      // a silhouette would be one colour: here no single hue family holds more than half of the opaque pixels
      expect(Math.max(share((c) => c.h > 35 && c.h < 55), share((c) => c.h > 200 && c.h < 230))).toBeLessThan(0.5);
    });

    it("is readable on the dark of the pages: most of what is drawn is light (gold and white) against #161616, and the edge has no white halo", () => {
      const dark = luminance({ r: 0x16, g: 0x16, b: 0x16 });
      const light = opaque.filter((c) => (luminance(c) + 0.05) / (dark + 0.05) >= 4.5).length / opaque.length;
      expect(light).toBeGreaterThan(0.55); // gold and white clear 4.5:1 against the card; the blue outline is the crest's own and is kept as it is
      let edge = 0, whiteEdge = 0;
      for (let i = 0; i < pixels; i++) { const a = png.data[i * 4 + 3]; if (a > 0 && a < 255) { edge++; if (png.data[i * 4] > 230 && png.data[i * 4 + 1] > 230 && png.data[i * 4 + 2] > 230) whiteEdge++; } }
      expect(whiteEdge / edge).toBeLessThan(0.15);
    });
  });

  it("nothing in any page turns a crest into a silhouette or dims it: no filter, blend mode, mask, clip or opacity on a crest or its holders", () => {
    for (const [file, html] of PAGES) {
      const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
      const rules = [...css.matchAll(/([^{}]*(?:club-crest|featured-crest|part-crests)[^{}]*)\{([^}]*)\}/g)];
      expect(rules.length, `${file} styles its crests`).toBeGreaterThan(0);
      for (const [, selector, body] of rules) expect(body, `${file}: ${selector.trim()}`).not.toMatch(/(^|[;\s])(filter|backdrop-filter|mix-blend-mode|mask|-webkit-mask|clip-path|opacity)\s*:/i);
    }
    expect(MODULE_SOURCE).not.toMatch(/\.style\.(filter|opacity|mixBlendMode)|setAttribute\(\s*["']style["']/);
  });

  it("are not presented as licensed, authorised, sponsored or affiliated: the module says they are trademarks shown only to identify the teams and that nothing implies a licence or a relationship", () => {
    const words = MODULE_SOURCE.replace(/\s*\n\s*\*?\s*/g, " "); // the header comment as running text
    expect(words).toMatch(/trademarks of their clubs/i);
    expect(words).toMatch(/only to identify the two teams of the match/i);
    expect(words).toMatch(/Nothing in URBANO implies a licence from, or any sponsorship, partnership or affiliation with, either club/i);
    expect(words).not.toMatch(/official partner|licensed by|authori[sz]ed by|in partnership with|endorsed by|sponsored by/i);
    expect(words).toMatch(/no photograph of a player/i);
  });

  it("the home card draws the two crests home team first as decoration (aria-hidden), and names both teams in text beside them", () => {
    const index = PAGES.find(([file]) => file === "index.html")![1];
    const card = new JSDOM(index).window.document.querySelector("#featured-predictions")!;
    const holders = [...card.querySelectorAll(".featured-crests [data-club]")].map((node) => node.getAttribute("data-club"));
    expect(holders).toEqual(["FC Barcelona", "Real Madrid CF"]);
    expect(card.querySelector(".featured-crests")!.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector(".featured-descriptor")!.textContent).toBe("El Clásico: FC Barcelona vs. Real Madrid CF");
  });
});
