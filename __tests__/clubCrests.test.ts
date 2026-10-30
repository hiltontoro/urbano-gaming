import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * CLUB CRESTS — the crests of the TEN teams the Founder decided (2026-10-29) must be kept in the design of Home, and the module that is the only
 * place that knows them. Two crests (FC Barcelona, Real Madrid CF) were already in production; the other eight are "founder-directed": drawn
 * because the Founder decided it, WITHOUT any preview flag. That is a visual decision, not a licence: no licence from any club is on record for any
 * of the ten and nothing here implies one. What this proves is the shape the Founder asked for: provenance written down for every file (the
 * recorded hash is the file's real hash), everything in ONE central place so a crest can be replaced or withdrawn by changing that place (the
 * "preview-only" status still holds a crest back, although no entry uses it today), no crest ever the only way a team is identified (the name is
 * always text, and the Home strip names each team), and nothing but crests (no photograph of a player).
 */

const ROOT = process.cwd();
const MODULE_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const CLUBS_DIR = path.join(ROOT, "public/assets/clubs");
const PAGES = ["index.html", "soccer-predictions.html", "profile.html"].map((file) => [file, readFileSync(path.join(ROOT, "public", file), "utf8")] as const);
const INDEX_HTML = PAGES.find(([file]) => file === "index.html")![1];
const UPCOMING_DATA_SOURCE = readFileSync(path.join(ROOT, "public/homeUpcomingData.js"), "utf8");

/** The ten teams, in the order the Founder named them and the Home strip draws them, each with the registry key and the file that crest lives in. */
const TEN_TEAMS = [
  { team: "Real Madrid", key: "real-madrid-cf", file: "real-madrid-cf.png" },
  { team: "FC Barcelona", key: "fc-barcelona", file: "fc-barcelona.svg" },
  { team: "Manchester City", key: "manchester-city", file: "manchester-city.png" },
  { team: "Manchester United", key: "manchester-united", file: "manchester-united.png" },
  { team: "Arsenal", key: "arsenal", file: "arsenal.png" },
  { team: "Olimpia", key: "olimpia", file: "olimpia.png" },
  { team: "Motagua", key: "motagua", file: "motagua.png" },
  { team: "Inter de Milán", key: "inter", file: "inter.png" },
  { team: "Bayern Múnich", key: "bayern-munchen", file: "bayern-munchen.png" },
  { team: "Paris Saint-Germain", key: "paris-saint-germain", file: "paris-saint-germain.png" },
] as const;
/** In production before the Founder's decision: no status. */
const IN_PRODUCTION = ["fc-barcelona", "real-madrid-cf"];
/** Drawn by decision of the Founder (2026-10-29): status "founder-directed". */
const FOUNDER_DIRECTED = TEN_TEAMS.map((t) => t.key).filter((key) => !IN_PRODUCTION.includes(key)).sort();

type CrestEntry = { key: string; status?: string; names: string[]; src: string; provenance: Record<string, string> };

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

/** Evaluates a copy of the shipped module in a jsdom window. `preview` sets window.URBANO_CRESTS_PREVIEW BEFORE the script runs, as a preview harness would. */
function loadModule(source = MODULE_SOURCE, options: { preview?: unknown } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
  if ("preview" in options) (dom.window as unknown as { URBANO_CRESTS_PREVIEW: unknown }).URBANO_CRESTS_PREVIEW = options.preview;
  dom.window.eval(source);
  const crests = (dom.window as unknown as { UrbanoClubCrests: any }).UrbanoClubCrests;
  return { dom, doc: dom.window.document, crests };
}

/** A modified COPY of the shipped source in which the given "founder-directed" entries are held back ("preview-only") or switched to another status. */
function withStatus(keys: string[], status: string, source = MODULE_SOURCE) {
  let out = source;
  for (const key of keys) {
    const entry = new RegExp(`(key: "${key}",\\s*status: )"founder-directed"`);
    expect(out, `${key} is a founder-directed entry in the shipped source`).toMatch(entry);
    out = out.replace(entry, `$1"${status}"`);
  }
  expect(out).not.toBe(source);
  return out;
}

/** The Home page as a browser has it after the page script decorates the document: the markup, plus (per `crests`) the real module, the module with ENABLED off, or no module at all. */
function loadHome(crests: "module" | "withdrawn" | "absent", moduleSource = MODULE_SOURCE) {
  const dom = new JSDOM(INDEX_HTML, { url: "http://localhost/", runScripts: "outside-only" });
  const win = dom.window as unknown as { UrbanoClubCrests?: { decorate(root: Document): number } };
  if (crests === "module") dom.window.eval(moduleSource);
  if (crests === "withdrawn") dom.window.eval(moduleSource.replace("var ENABLED = true;", "var ENABLED = false;"));
  if (win.UrbanoClubCrests) win.UrbanoClubCrests.decorate(dom.window.document); // exactly what the Home script does: `if (window.UrbanoClubCrests) ...decorate(document)`
  const doc = dom.window.document;
  return { dom, doc, chips: [...doc.querySelectorAll<HTMLElement>("#featured-predictions ul.ten-crests > li.crest-chip")] };
}

/** The rules of the first <style> block of a page: selector text (with whatever comment precedes it) and body. */
function cssRules(html: string) {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body }));
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
    // the other eight, by the names the Founder used and by the common spellings of the same club
    ["Manchester City", "manchester-city"],
    ["Man City", "manchester-city"],
    ["Manchester United", "manchester-united"],
    ["MAN UNITED", "manchester-united"],
    ["Arsenal", "arsenal"],
    ["Olimpia", "olimpia"],
    ["CD Olimpia", "olimpia"],
    ["Motagua", "motagua"],
    ["FC Motagua", "motagua"],
    ["Inter de Milán", "inter"],
    ["Inter de Milan", "inter"],
    ["Inter Milan", "inter"],
    ["Inter", "inter"],
    ["Bayern Múnich", "bayern-munchen"],
    ["Bayern München", "bayern-munchen"],
    ["Bayern Munich", "bayern-munchen"],
    ["Paris Saint-Germain", "paris-saint-germain"],
    ["Paris Saint Germain", "paris-saint-germain"],
    ["PSG", "paris-saint-germain"],
  ])("%s → %s", (name, key) => {
    expect(crests.forTeam(name)?.key ?? null).toBe(key);
  });

  it("gives each of the ten teams (by the name the Home strip writes) its own crest, and no two teams share one", () => {
    const keys = TEN_TEAMS.map((t) => crests.forTeam(t.team)?.key ?? null);
    expect(keys).toEqual(TEN_TEAMS.map((t) => t.key));
    expect(new Set(keys).size).toBe(10);
    expect((crests.all() as CrestEntry[]).map((e) => e.key).sort()).toEqual(TEN_TEAMS.map((t) => t.key).sort());
  });

  it("matches the whole name only: a team that merely contains a club's word (a test fixture, another club) has no crest", () => {
    for (const name of [
      "Barcelona c54ae13a", "Real Madrid 3232428e", "Barcelona SC", "Real Madrid Castilla", "Deportivo Barcelona", "", "   ", null, undefined,
      "Inter Miami", "Arsenal Tula", "Bayern 4f2a9c", "Manchester City Women", "Manchester", "Olimpia Ljubljana", "Motagua 11aa22bb", "Paris FC", "Paris Saint",
    ]) {
      expect(crests.forTeam(name), String(name)).toBeNull();
    }
  });

  it("the teams of the preselection that are not among the ten are shown by their name alone: no crest is guessed for them", () => {
    const dom = new JSDOM("", { runScripts: "outside-only" });
    dom.window.eval(UPCOMING_DATA_SOURCE);
    const matches = (dom.window as unknown as { UrbanoUpcomingData: { matches: Array<{ home: string; away: string }> } }).UrbanoUpcomingData.matches;
    const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))];
    const without = teams.filter((name) => crests.forTeam(name) === null).sort();
    expect(without).toEqual(["Atlético de Madrid", "Liverpool", "Valencia"]);
    for (const name of teams.filter((n) => !without.includes(n))) expect(TEN_TEAMS.map((t) => crests.forTeam(t.team)!.key), name).toContain(crests.forTeam(name)!.key);
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
  it("is one switch: with ENABLED false the module gives no crest to anybody (not one of the ten) and decorates nothing", () => {
    expect(MODULE_SOURCE.match(/var ENABLED = true;/g)).toHaveLength(1);
    const { crests, doc } = loadModule(MODULE_SOURCE.replace("var ENABLED = true;", "var ENABLED = false;"));
    expect(crests.enabled()).toBe(false);
    expect(crests.forTeam("FC Barcelona")).toBeNull();
    expect(crests.element("Real Madrid CF")).toBeNull();
    for (const { team } of TEN_TEAMS) { expect(crests.forTeam(team), team).toBeNull(); expect(crests.element(team), team).toBeNull(); }
    doc.body.innerHTML = `<span data-club="FC Barcelona">FC Barcelona</span><span data-club="Arsenal">Arsenal</span>`;
    expect(crests.decorate(doc)).toBe(0);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.body.textContent).toBe("FC BarcelonaArsenal");
  });

  it("no page names a crest file: only the central module does, so replacing or removing a crest is a change in that one place", () => {
    for (const [file, html] of PAGES) {
      expect(html, file).not.toMatch(/assets\/clubs/);
      for (const { key } of TEN_TEAMS.filter((t) => t.key.includes("-"))) expect(html, `${file} must not name the registry key ${key}`).not.toContain(key);
      for (const { file: crestFile } of TEN_TEAMS) expect(html, `${file} must not name ${crestFile}`).not.toContain(crestFile);
    }
    expect(MODULE_SOURCE.match(/\/assets\/clubs\//g)).toHaveLength(10); // one file per team of the ten, all named only here
    for (const { file: crestFile } of TEN_TEAMS) expect(MODULE_SOURCE, crestFile).toContain(`/assets/clubs/${crestFile}"`);
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
  const entries = crests.all() as CrestEntry[];
  const founderDirectedFiles = TEN_TEAMS.filter((t) => FOUNDER_DIRECTED.includes(t.key)).map((t) => t.file);

  it("are exactly ten files under public/assets/clubs — the two already in production (FC Barcelona's vector, Real Madrid's full-colour PNG) and eight founder-directed crests — crests only, no photograph of a player, no kit, no other club asset", () => {
    const inUse = ["fc-barcelona.svg", "real-madrid-cf.png"];
    expect(founderDirectedFiles.sort()).toEqual(["arsenal.png", "bayern-munchen.png", "inter.png", "manchester-city.png", "manchester-united.png", "motagua.png", "olimpia.png", "paris-saint-germain.png"]);
    expect(readdirSync(CLUBS_DIR).sort()).toEqual([...inUse, ...founderDirectedFiles].sort());
    expect(entries.map((e) => path.basename(e.src)).sort()).toEqual([...inUse, ...founderDirectedFiles].sort());
    expect(statSync(path.join(CLUBS_DIR, "fc-barcelona.svg")).size).toBeLessThan(12_000);
    expect(statSync(path.join(CLUBS_DIR, "real-madrid-cf.png")).size).toBeLessThan(100_000); // a crest, not a poster: it is drawn at 20–34 px
    for (const file of founderDirectedFiles) expect(statSync(path.join(CLUBS_DIR, file)).size, file).toBeLessThan(60_000);
  });

  it("are the files whose provenance is written down: for ALL TEN the hash recorded is the real SHA-256 of the file under public/assets/clubs, and the source, its hash and its date are stated; Real Madrid's records the terms its source states", () => {
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      const file = readFileSync(path.join(ROOT, "public", entry.src));
      expect(entry.src, entry.key).toMatch(/^\/assets\/clubs\/[a-z-]+\.(png|svg)$/);
      expect(entry.provenance.club, entry.key).toBeTruthy();
      expect(() => new URL(entry.provenance.from), `${entry.key} names the URL it came from`).not.toThrow();
      expect(createHash("sha256").update(file).digest("hex"), entry.key).toBe(entry.provenance.fileSha256);
      expect(entry.provenance.fileSha256, entry.key).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.provenance.sourceSha256, entry.key).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.provenance.retrievedAtUtc, entry.key).toMatch(/^2026-10-2\dT\d{2}:\d{2}:\d{2}Z$/);
      expect(entry.provenance.what.length, entry.key).toBeGreaterThan(20);
    }
    // no two crests share a file or a recorded hash
    expect(new Set(entries.map((e) => e.provenance.fileSha256)).size).toBe(10);
    expect(new Set(entries.map((e) => e.src)).size).toBe(10);
    // the eight come from UEFA's and Concacaf's image servers and each converts the source it records (so the two hashes differ)
    const sources: Record<string, string> = { "manchester-city": "img.uefa.com", "manchester-united": "img.uefa.com", arsenal: "img.uefa.com", "bayern-munchen": "img.uefa.com", "paris-saint-germain": "img.uefa.com", inter: "img.uefa.com", olimpia: "media-sdp.concacaf.com", motagua: "media-sdp.concacaf.com" };
    for (const key of FOUNDER_DIRECTED) {
      const entry = entries.find((e) => e.key === key)!;
      expect(new URL(entry.provenance.from).hostname, key).toBe(sources[key]);
      expect(entry.provenance.sourceSha256, key).not.toBe(entry.provenance.fileSha256);
      expect(entry.provenance.retrievedAtUtc, key).toMatch(/^2026-10-29T/);
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

  it("each of the eight founder-directed PNGs is what its provenance says: a 160 px square 8-bit RGBA image with real transparency (clear corners, a crest that fills most of the file)", () => {
    for (const file of founderDirectedFiles) {
      const png = decodePng(readFileSync(path.join(CLUBS_DIR, file)));
      expect([png.width, png.height], file).toEqual([160, 160]);
      expect([png.bitDepth, png.colorType], `${file}: 8-bit RGBA`).toEqual([8, 6]);
      const pixels = png.width * png.height;
      let transparent = 0, opaque = 0;
      for (let i = 0; i < pixels; i++) { const alpha = png.data[i * 4 + 3]; if (alpha === 0) transparent++; if (alpha >= 200) opaque++; }
      for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) expect(png.data[(y * png.width + x) * 4 + 3], `${file} corner ${x},${y}`).toBe(0);
      expect(transparent / pixels, `${file}: a real alpha channel, not a painted background`).toBeGreaterThan(0.1);
      expect(transparent / pixels, `${file}: the crest fills most of the file`).toBeLessThan(0.5);
      expect(opaque / pixels, file).toBeGreaterThan(0.4);
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

  it("nothing in any page turns a crest into a silhouette or dims it: no filter, blend mode, mask, clip-path or opacity on a crest, the strip of ten or its chips", () => {
    for (const [file, html] of PAGES) {
      const rules = cssRules(html).filter((rule) => /club-crest|ten-crests|crest-chip|part-crests/.test(rule.selector));
      expect(rules.length, `${file} styles its crests`).toBeGreaterThan(0);
      for (const { selector, body } of rules) expect(body, `${file}: ${selector}`).not.toMatch(/(^|[;\s])(filter|backdrop-filter|mix-blend-mode|mask|-webkit-mask|clip-path|opacity)\s*:/i);
    }
    expect(MODULE_SOURCE).not.toMatch(/\.style\.(filter|opacity|mixBlendMode)|setAttribute\(\s*["']style["']/);
  });

  it("a crest is decoration with a bounded size: every page sizes it (never above 40 px) and gives it no pointer behaviour (no cursor, no pointer-events), and the element carries no interactive attribute", () => {
    for (const [file, html] of PAGES) {
      const rules = cssRules(html).filter((rule) => /club-crest|ten-crests|crest-chip|crest-name|part-crests/.test(rule.selector));
      const sized = rules.filter((rule) => /club-crest/.test(rule.selector) && !/crest-name/.test(rule.selector));
      const sizes = sized.flatMap((rule) => [...rule.body.matchAll(/(?:^|[;\s])(?:width|height|max-width|max-height)\s*:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1])));
      expect(sizes.length, `${file} sizes its crests`).toBeGreaterThan(0);
      for (const size of sizes) expect(size, `${file}: a crest is never drawn larger than 40 px`).toBeLessThanOrEqual(40);
      for (const { selector, body } of rules) expect(body, `${file}: ${selector}`).not.toMatch(/(^|[;\s])(cursor|pointer-events)\s*:/i);
    }
    const { crests } = loadModule();
    const img = crests.element("FC Barcelona") as HTMLImageElement;
    for (const attribute of ["tabindex", "role", "onclick", "href", "title"]) expect(img.hasAttribute(attribute), attribute).toBe(false);
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["24", "24"]);
    expect(MODULE_SOURCE).not.toMatch(/addEventListener\(\s*["'](click|keydown|keyup|pointer\w*|mouse\w*|touch\w*)["']/);
  });

  it("are not presented as licensed, authorised, sponsored or affiliated: the module says they are trademarks shown only to identify the teams, that nothing implies a licence or a relationship, and that no licence is on record for any of the ten", () => {
    const words = MODULE_SOURCE.replace(/\s*\n\s*\*?\s*/g, " "); // the header comment as running text
    expect(words).toMatch(/Club crests are trademarks of their clubs/i);
    expect(words).toMatch(/shown here only to identify the teams/i);
    expect(words).toMatch(/Nothing in URBANO implies a licence from, or any sponsorship, partnership or affiliation with, any club, league or competition/i);
    expect(words).toMatch(/no status below means that a licence exists: no licence is on record for any of the ten/i);
    expect(words).not.toMatch(/official partner|licensed by|authori[sz]ed by|in partnership with|endorsed by|sponsored by/i);
    expect(words).toMatch(/no photograph of a player/i);
    // the header documents the three statuses, and says that the Founder's decision is visual and establishes no licence
    expect(words).toMatch(/\(no status\)\s+already in use in production/i);
    expect(words).toMatch(/"founder-directed"\s+drawn because the Founder decided on 2026-10-29 that the crests of ALL TEN teams must be kept in the design of Home/i);
    expect(words).toMatch(/The decision is visual: it does not establish a licence/i);
    expect(words).toMatch(/"preview-only"\s+NOT drawn unless the page that is drawing a preview sets window\.URBANO_CRESTS_PREVIEW = true/i);
    expect(words).toMatch(/Nothing uses it today/i);
  });
});

describe("the Home card: the strip of the ten crests (the Founder's decision of 2026-10-29)", () => {
  const names = TEN_TEAMS.map((t) => t.team);

  it("is a ul.ten-crests of ten li.crest-chip in the Founder's order, each naming its team in text (span.crest-name), labelled by the visible heading of the strip — and nothing is left of the old two-crest strip", () => {
    const { doc, chips } = loadHome("absent");
    const card = doc.querySelector("#featured-predictions")!;
    const strips = card.querySelectorAll("ul.ten-crests");
    expect(strips).toHaveLength(1);
    const strip = strips[0];
    expect(strip.closest("#featured-teams")).not.toBeNull();
    expect(strip.querySelectorAll(":scope > li")).toHaveLength(10);
    expect(chips).toHaveLength(10);
    expect(chips.map((chip) => chip.getAttribute("data-club"))).toEqual(names);
    expect(chips.map((chip) => chip.querySelector(":scope > span.crest-name")?.textContent)).toEqual(names);
    expect(chips.map((chip) => chip.textContent)).toEqual(names); // every team is named in text: the crest is never the only way it is identified
    const label = doc.getElementById(strip.getAttribute("aria-labelledby") ?? "");
    expect(label?.id).toBe("featured-teams-label");
    expect(label?.getAttribute("data-i18n")).toBe("home.upcoming.teamsLabel");
    expect(label?.textContent).toBe("Equipos que podrían aparecer en URBANO Score"); // not "that we follow": the strip does not say these teams are playing
    expect(strip.getAttribute("role")).toBe("list"); // the grid keeps its list semantics (a styled list can lose them in some screen readers)
    expect(card.querySelector(".featured-crests, .featured-crest, .featured-crest-vs")).toBeNull();
    expect(INDEX_HTML).not.toMatch(/featured-crest/);
    expect(card.querySelector("img")).toBeNull(); // the markup carries no image: the crests are drawn by the central module only
  });

  it("with the module, each chip gets its own crest in front of its name: img.club-crest, aria-hidden, empty alt, the registry's key and file, nothing interactive; the name stays beside it as text", () => {
    const { doc, chips } = loadHome("module");
    expect(chips).toHaveLength(10);
    chips.forEach((chip, index) => {
      const { team, key, file } = TEN_TEAMS[index];
      expect(chip.querySelectorAll("img"), team).toHaveLength(1);
      const img = chip.firstElementChild as HTMLImageElement;
      expect(img.tagName, team).toBe("IMG");
      expect(img.className, team).toBe("club-crest");
      expect(img.getAttribute("aria-hidden"), team).toBe("true");
      expect(img.getAttribute("alt"), team).toBe("");
      expect(img.getAttribute("data-crest"), team).toBe(key);
      expect(img.getAttribute("src"), team).toBe(`/assets/clubs/${file}`);
      for (const attribute of ["tabindex", "role", "onclick", "href"]) expect(img.hasAttribute(attribute), `${team} ${attribute}`).toBe(false);
      expect(img.closest("a, button"), team).toBeNull();
      expect(img.nextElementSibling?.className, team).toBe("crest-name");
      expect(chip.textContent, team).toBe(team);
    });
    expect(doc.querySelectorAll("#featured-predictions ul.ten-crests img.club-crest")).toHaveLength(10);
    expect(new Set([...doc.querySelectorAll("ul.ten-crests img.club-crest")].map((img) => img.getAttribute("data-crest"))).size).toBe(10);
  });

  it("each crest-name is the accessible name of its team: hidden visually ONLY by the rule '.ten-crests .club-crest + .crest-name', so it is hidden while its crest image is drawn and visible as a label when it is not", () => {
    const rules = cssRules(INDEX_HTML).filter((rule) => /crest-name/.test(rule.selector));
    expect(rules.map((rule) => rule.selector).sort()).toEqual([".ten-crests .club-crest + .crest-name", ".ten-crests .crest-name"]);
    const hide = rules.find((rule) => rule.selector === ".ten-crests .club-crest + .crest-name")!;
    expect(hide.body).toMatch(/position:\s*absolute/);
    expect(hide.body).toMatch(/width:\s*1px/);
    expect(hide.body).toMatch(/height:\s*1px/);
    expect(hide.body).toMatch(/overflow:\s*hidden/);
    expect(hide.body).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(hide.body).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/); // visually hidden, still read by assistive technology
    const base = rules.find((rule) => rule.selector === ".ten-crests .crest-name")!;
    expect(base.body).not.toMatch(/position\s*:\s*absolute|clip|display\s*:\s*none|visibility\s*:\s*hidden|opacity|(^|[;\s])width\s*:\s*1px|font-size\s*:\s*0\b/);
    expect(base.body).toMatch(/font-size:\s*11px/); // readable text when it is the label

    // with the crests drawn: the hide rule matches every name, which is where the visible name is replaced by the image
    const drawn = loadHome("module").doc;
    expect(drawn.querySelectorAll(".ten-crests .club-crest + .crest-name")).toHaveLength(10);
    for (const name of drawn.querySelectorAll(".ten-crests .crest-name")) {
      const style = (drawn.defaultView as Window).getComputedStyle(name);
      expect([style.position, style.width], name.textContent ?? "").toEqual(["absolute", "1px"]);
    }
    // with the module absent or withdrawn there is no crest image, so the hide rule matches NO name: the ten names are the visible labels
    for (const mode of ["absent", "withdrawn"] as const) {
      const { doc, chips } = loadHome(mode);
      expect(doc.querySelectorAll(".ten-crests .club-crest")).toHaveLength(0);
      expect(doc.querySelectorAll(".ten-crests .club-crest + .crest-name"), mode).toHaveLength(0);
      expect(chips.map((chip) => chip.textContent), mode).toEqual(names);
      for (const chip of chips) {
        const style = (chip.ownerDocument.defaultView as Window).getComputedStyle(chip.querySelector(".crest-name")!);
        expect(style.position, `${mode}: ${chip.textContent}`).not.toBe("absolute");
        expect(style.display, `${mode}: ${chip.textContent}`).not.toBe("none");
      }
    }
  });

  it("when no crest is drawn the strip gives the names their own layout: a rule that applies only to a strip with no .club-crest in it (auto-fit columns wide enough for a name), and none that hides or dims anything", () => {
    const rules = cssRules(INDEX_HTML).filter((rule) => rule.selector === ".ten-crests:not(:has(.club-crest))");
    expect(rules).toHaveLength(1);
    const body = rules[0].body;
    expect(body).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/);
    const minimum = Number(/minmax\((\d+)px/.exec(body)![1]);
    expect(minimum).toBeGreaterThanOrEqual(100); // the longest name, "Paris Saint-Germain", at 11 px needs about 110 px: columns of 34 px would run the names into each other
    expect(body).toMatch(/justify-items:\s*start/);
    expect(body).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden|opacity|(^|[;\s])(width|height)\s*:\s*1px|font-size\s*:\s*0\b|clip/);
    // it is declared after the strip's own columns (and wins over the phone's five columns by specificity: a class plus a pseudo-class beats a class)
    const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
    expect(css.indexOf(".ten-crests:not(:has(.club-crest))")).toBeGreaterThan(css.indexOf(".ten-crests { list-style"));
    // the selector means what it says on the real page: with the crests drawn the strip does not match, without them it does
    const withCrests = loadHome("module").doc.querySelector("ul.ten-crests")!;
    const without = loadHome("absent").doc.querySelector("ul.ten-crests")!;
    expect(withCrests.querySelector(".club-crest")).not.toBeNull();
    expect(without.querySelector(".club-crest")).toBeNull();
    expect(without.matches(".ten-crests:not(:has(.club-crest))")).toBe(true);
    expect(withCrests.matches(".ten-crests:not(:has(.club-crest))")).toBe(false);
  });

  it("the small texts of the card are readable: the label of the strip and the legal sentence are 12 px, and the legal sentence is not dimmer than 0.8 alpha", () => {
    const rules = cssRules(INDEX_HTML);
    const label = rules.find((rule) => rule.selector === ".featured-teams-label")!;
    const legal = rules.find((rule) => rule.selector === ".featured-legal")!;
    expect(label.body).toMatch(/font-size:\s*12px/);
    expect(legal.body).toMatch(/font-size:\s*12px/);
    expect(Number(/color:\s*rgba\(245,\s*241,\s*232,\s*([\d.]+)\)/.exec(legal.body)![1])).toBeGreaterThanOrEqual(0.8);
    for (const rule of [label, legal]) expect(rule.body).not.toMatch(/(^|[;\s])(opacity|filter)\s*:/i);
  });

  it("the row of a match keeps its crests in the new markup: each team is a span.upcoming-team with data-club (the away team inside span.upcoming-away, after the 'vs'), and decorating draws a crest in front of the name of every team that has one", () => {
    const dom = new JSDOM(INDEX_HTML, { url: "http://localhost/", runScripts: "outside-only" });
    dom.window.eval(MODULE_SOURCE);
    dom.window.eval(UPCOMING_DATA_SOURCE);
    dom.window.eval(readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8"));
    dom.window.eval(readFileSync(path.join(ROOT, "public/homeUpcoming.js"), "utf8"));
    const win = dom.window as unknown as { UrbanoHomeUpcoming: { init(options: Record<string, unknown>): { stop(): void } | null } };
    const host = dom.window.document.getElementById("upcoming-list")!;
    const handle = win.UrbanoHomeUpcoming.init({ host, serverMatches: [], now: () => Date.parse("2026-10-29T15:00:00Z"), refreshMs: 0 });
    const rows = [...host.querySelectorAll("li.upcoming-item")];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const teams = row.querySelector(":scope > .upcoming-teams")!;
      const [home, away] = [teams.querySelector(":scope > .upcoming-team")!, teams.querySelector(":scope > .upcoming-away > .upcoming-team")!];
      expect(home.getAttribute("data-club")).toBeTruthy();
      expect(away.getAttribute("data-club")).toBeTruthy();
      expect(teams.querySelector(":scope > .upcoming-away > .upcoming-vs")?.nextElementSibling).toBe(away);
      for (const team of [home, away]) {
        const name = team.getAttribute("data-club")!;
        const crest = team.querySelector("img.club-crest");
        const expected = loadModule().crests.forTeam(name);
        if (expected) { expect(crest?.getAttribute("data-crest"), name).toBe(expected.key); expect(team.firstElementChild, name).toBe(crest); }
        else expect(crest, name).toBeNull();
        expect(team.textContent, name).toBe(name); // the name is text, crest or not
      }
    }
    // Valencia, Atlético de Madrid and Liverpool have no crest: shown by name alone; the other seven teams of the five matches do
    expect(host.querySelectorAll("img.club-crest")).toHaveLength(7);
    handle?.stop();
  });

  it("when one crest file cannot be loaded its image removes itself and ONLY that name becomes visible (the hide rule no longer matches it); the other nine are unaffected", () => {
    const { dom, doc, chips } = loadHome("module");
    const broken = chips[7]; // Inter de Milán
    broken.querySelector("img")!.dispatchEvent(new dom.window.Event("error"));
    expect(broken.querySelector("img")).toBeNull();
    expect(broken.textContent).toBe("Inter de Milán");
    expect(broken.querySelector(".club-crest + .crest-name")).toBeNull();
    expect(doc.querySelectorAll(".ten-crests .club-crest + .crest-name")).toHaveLength(9);
    expect(chips.filter((chip) => chip !== broken).every((chip) => chip.querySelector(".club-crest + .crest-name") !== null)).toBe(true);
  });

  it("taking back the eight founder-directed crests by their status (or all by ENABLED) leaves the ten names in place, with only the two in-production crests drawn (none when withdrawn)", () => {
    const { doc, chips } = loadHome("module", withStatus(FOUNDER_DIRECTED, "preview-only"));
    expect(chips.map((chip) => chip.textContent)).toEqual(names);
    expect([...doc.querySelectorAll("ul.ten-crests img.club-crest")].map((img) => img.getAttribute("data-crest")).sort()).toEqual(IN_PRODUCTION);
    expect(doc.querySelectorAll(".ten-crests .club-crest + .crest-name")).toHaveLength(2);
    expect(loadHome("withdrawn").doc.querySelectorAll("ul.ten-crests img")).toHaveLength(0);
  });

  it("is never hidden by CSS at any width (no display:none, visibility:hidden or opacity 0 on the strip, its chips or its holder), and the page asks the module to decorate the whole document after loading it", () => {
    const rules = cssRules(INDEX_HTML).filter((rule) => /ten-crests|crest-chip|featured-teams/.test(rule.selector));
    expect(rules.length).toBeGreaterThan(0);
    for (const { selector, body } of rules) expect(body, selector).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0\b/);
    expect(INDEX_HTML).toMatch(/if \(window\.UrbanoClubCrests\) window\.UrbanoClubCrests\.decorate\(document\);/);
    expect(INDEX_HTML.indexOf('<script src="/urbanoClubCrests.js"></script>')).toBeGreaterThan(0);
    expect(INDEX_HTML.indexOf('<script src="/urbanoClubCrests.js"></script>')).toBeLessThan(INDEX_HTML.indexOf('<script src="/homeUpcoming.js"></script>')); // the list asks the registry for the club names
  });

  it("does not present the crests as licensed: the card says they only identify the teams and that URBANO is not affiliated with, sponsored by or endorsed by the clubs, leagues or competitions, says nothing about prizes, and promises nothing of the kind", () => {
    const { doc } = loadHome("absent");
    const card = doc.querySelector("#featured-predictions")!;
    const legal = card.querySelector(".featured-legal")!;
    // the sentence is the shared one (key upcoming.disclaimer, also drawn at the foot of the Score page); it no longer lives under home.
    expect(legal.getAttribute("data-i18n")).toBe("upcoming.disclaimer");
    expect(INDEX_HTML).not.toContain("home.upcoming.disclaimer");
    expect(legal.textContent).toBe("Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.");
    expect(legal.textContent).not.toMatch(/premio/i); // the card makes no statement about prizes
    // nothing else on the card claims a licence or a relationship: the only mention of "afiliado" / "patrocinio" is the denial in the legal sentence itself
    const rest = (card.textContent ?? "").replace(legal.textContent ?? "", "");
    expect(rest).not.toMatch(/licenciad|oficial|patrocin|en alianza con|socio de|afiliad|respald/i);
  });
});

describe("the status of each crest: in production (none), founder-directed, or held back (preview-only)", () => {
  const all = () => loadModule().crests.all() as CrestEntry[];

  it("the two crests already in production have no status, the other eight are founder-directed, and NO entry is preview-only today", () => {
    expect(all().filter((entry) => entry.status === undefined).map((entry) => entry.key).sort()).toEqual(IN_PRODUCTION);
    expect(all().filter((entry) => entry.status === "founder-directed").map((entry) => entry.key).sort()).toEqual(FOUNDER_DIRECTED);
    expect(all().filter((entry) => entry.status === "preview-only")).toEqual([]);
    expect(all().every((entry) => entry.status === undefined || entry.status === "founder-directed")).toBe(true);
    expect(MODULE_SOURCE.match(/^\s*status: "founder-directed",$/gm)).toHaveLength(8);
    expect(MODULE_SOURCE).not.toMatch(/status:\s*"preview-only"/); // the status exists in the mechanism and the header, on no entry
  });

  it("every founder-directed entry says in its provenance that the licence is NOT established and that it is drawn by the Founder's decision of 2026-10-29; none claims a licence", () => {
    const directed = all().filter((entry) => entry.status === "founder-directed");
    expect(directed).toHaveLength(8);
    for (const entry of directed) {
      expect(entry.provenance.what, entry.key).toMatch(/licence NOT established/);
      expect(entry.provenance.what, entry.key).toMatch(/drawn by decision of the Founder \(2026-10-29\)/);
    }
    for (const entry of all()) expect(entry.provenance.what, entry.key).not.toMatch(/licen[cs]ed|licence (is )?granted|authori[sz]ed|official partner/i);
  });

  it("the eight founder-directed crests are drawn WITHOUT any preview flag (not set, or false), and so are the two in production: all ten teams get a crest and a page decorates all ten", () => {
    for (const options of [{}, { preview: false }, { preview: true }]) {
      const { crests, doc } = loadModule(MODULE_SOURCE, options);
      for (const { team, key, file } of TEN_TEAMS) {
        expect(crests.forTeam(team)?.key, `${team} ${JSON.stringify(options)}`).toBe(key);
        const img = crests.element(team, doc) as HTMLImageElement;
        expect(img.getAttribute("src"), team).toBe(`/assets/clubs/${file}`);
        expect([img.getAttribute("alt"), img.getAttribute("aria-hidden")], team).toEqual(["", "true"]);
      }
      doc.body.innerHTML = TEN_TEAMS.map(({ team }) => `<span data-club="${team}">${team}</span>`).join("");
      expect(crests.decorate(doc), JSON.stringify(options)).toBe(10);
      expect(doc.querySelectorAll("img.club-crest")).toHaveLength(10);
    }
  });

  it("no shipped page sets the preview flag: it is for a preview harness only", () => {
    for (const [file, html] of PAGES) expect(html, file).not.toMatch(/URBANO_CRESTS_PREVIEW/);
    for (const file of readdirSync(path.join(ROOT, "public")).filter((name) => /\.(html|js)$/.test(name) && name !== "urbanoClubCrests.js")) {
      expect(readFileSync(path.join(ROOT, "public", file), "utf8"), file).not.toMatch(/URBANO_CRESTS_PREVIEW\s*=\s*true/);
    }
  });
});

describe("the preview-only status still holds a crest back (proven on a modified copy of the shipped module, since no entry uses it today)", () => {
  const tenSpans = TEN_TEAMS.map(({ team }) => `<span data-club="${team}">${team}</span>`).join("");

  it("a copy with ONE entry set to preview-only (Arsenal): it is not drawn for anybody without window.URBANO_CRESTS_PREVIEW === true, it is drawn with it, and the other nine are unaffected either way", () => {
    const held = withStatus(["arsenal"], "preview-only");
    expect(held).not.toBe(MODULE_SOURCE);
    for (const [label, options] of [["flag not set", {}], ["flag false", { preview: false }], ["flag 'true' (a string)", { preview: "true" }], ["flag 1", { preview: 1 }]] as const) {
      const { crests, doc } = loadModule(held, options);
      expect(crests.forTeam("Arsenal"), label).toBeNull();
      expect(crests.element("Arsenal", doc), label).toBeNull();
      doc.body.innerHTML = tenSpans;
      expect(crests.decorate(doc), label).toBe(9);
      expect(doc.querySelector('[data-club="Arsenal"] img'), label).toBeNull();
      expect(doc.querySelector('[data-club="Arsenal"]')!.textContent, `${label}: the team is shown by its name alone`).toBe("Arsenal");
      for (const { team, key } of TEN_TEAMS.filter((t) => t.key !== "arsenal")) expect(crests.forTeam(team)?.key, `${label}: ${team}`).toBe(key);
    }
    const { crests, doc } = loadModule(held, { preview: true });
    expect(crests.forTeam("Arsenal")?.key).toBe("arsenal");
    expect((crests.element("Arsenal", doc) as HTMLImageElement).getAttribute("src")).toBe("/assets/clubs/arsenal.png");
    doc.body.innerHTML = tenSpans;
    expect(crests.decorate(doc)).toBe(10);
    for (const { team, key } of TEN_TEAMS) expect(crests.forTeam(team)?.key, team).toBe(key);
    expect(crests.forTeam("Arsenal Tula")).toBeNull(); // still the whole name only
  });

  it("holding back all eight founder-directed crests at once (the documented way to take them back) leaves only FC Barcelona and Real Madrid drawn, for every page at once, unless a preview says otherwise", () => {
    const held = withStatus(FOUNDER_DIRECTED, "preview-only");
    const { crests, doc } = loadModule(held);
    doc.body.innerHTML = tenSpans;
    expect(crests.decorate(doc)).toBe(2);
    expect([...doc.querySelectorAll("img.club-crest")].map((img) => img.getAttribute("data-crest")).sort()).toEqual(IN_PRODUCTION);
    expect(doc.body.textContent).toBe(TEN_TEAMS.map((t) => t.team).join(""));
    for (const { team } of TEN_TEAMS.filter((t) => FOUNDER_DIRECTED.includes(t.key))) expect(crests.forTeam(team), team).toBeNull();
    const preview = loadModule(held, { preview: true });
    for (const { team, key } of TEN_TEAMS) expect(preview.crests.forTeam(team)?.key, team).toBe(key);
  });

  it("ENABLED false still wins over everything: not even a preview flag draws a crest", () => {
    const { crests } = loadModule(MODULE_SOURCE.replace("var ENABLED = true;", "var ENABLED = false;"), { preview: true });
    for (const { team } of TEN_TEAMS) expect(crests.forTeam(team), team).toBeNull();
  });
});
