import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * Application Shell Convergence Slice 001 — Home and Discovery.
 *
 * The shipped public/index.html is parsed and run whole in jsdom (with the real shared Host-availability reader), so every statement
 * below is about the page that is actually served. The Host availability seam's fail-closed behavior and negative controls live in
 * hostAvailability.test.ts; this file pins the Home's discovery contract: what is linked, what is labeled, what is deliberately not
 * offered, which local assets it uses, and the accessibility / responsive provisions that jsdom can verify statically. Layout,
 * overflow, focus order in a real browser and reduced-motion rendering are validated in a real browser (see the implementation record).
 */

const ROOT = process.cwd();
const INDEX_HTML = readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const READER_SOURCE = readFileSync(path.join(ROOT, "public/hostAvailability.js"), "utf8");
const CSS = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Frozen Product & Experience Design baseline, bb5d1bd8 (manifest SHA-256 values). The copies in public/assets must be byte-identical.
const FROZEN_ASSETS: Record<string, string> = {
  "public/assets/brand/urbano-gaming-lockup-digital-glow.svg": "fd3d54590a7486e68b4a45cc6e2856079b4a80dee4a6f533e795cf3aeb9c61c6",
  "public/assets/brand/urbano-gaming-lockup-structural.svg": "b15b7d4e70d992b4c4e4030680e2957eb3c77e2f4f3c64376453fa85e50da2cb",
  "public/assets/brand/urbano-gaming-symbol-optical-small.svg": "708a69e652701ef6396a6fc860d106a8eda9065ff17df048376924cc0e0eafa0",
  "public/assets/fonts/Montserrat-Variable.ttf": "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
  "public/assets/fonts/OFL.txt": "8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e",
  "public/assets/fonts/PROVENANCE.json": "2d9cb6610e6e86753d5edb81453e19f1225fbf65d3652eee71e1c928c36c19c1",
};

// Every link the Home may contain. Become a Host's application page is deliberately NOT here: it exists only after the server says open.
const ALLOWED_HREFS = new Set([
  "/", "#main", "#play", "#experiences", "#host",
  "/participant.html", "/rutas.html", "/towers.html", "/trivia-playtest.html", "/quiz-playtest.html",
  "/soccer-predictions.html", "/poker-table.html", "/competitions.html", "/host.html", "/host.html?experience=poker",
]);

interface FetchCall { url: string; init: Record<string, any> }

async function loadHome(opts: { available?: boolean; html?: string } = {}) {
  const calls: FetchCall[] = [];
  const dom = new JSDOM(opts.html ?? INDEX_HTML, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = { attachSignInButton: () => {} };
      w.fetch = async (url: string, init: Record<string, any> = {}) => {
        calls.push({ url: String(url), init });
        return { status: 200, json: async () => ({ available: opts.available === true }) };
      };
      window.eval(READER_SOURCE);
    },
  });
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 40));
  const strip = () => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script").forEach((s) => s.remove()); return c; };
  return {
    win: dom.window, doc, calls,
    text: () => (strip().textContent ?? "").replace(/\s+/g, " "),
    hrefs: () => Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") as string),
    /** The .exp-card whose title heading (h3 or h4) is exactly `title`. */
    card: (title: string) => Array.from(doc.querySelectorAll(".exp-card")).find((c) => (c.querySelector("h3, h4")?.textContent ?? "") === title) as HTMLElement | undefined,
    /** The same, restricted to the section `#sectionId` (a title such as `Competitions` may legitimately appear in more than one section). */
    cardIn: (sectionId: string, title: string) => Array.from(doc.querySelectorAll(`#${sectionId} .exp-card`)).find((c) => (c.querySelector("h3, h4")?.textContent ?? "") === title) as HTMLElement | undefined,
  };
}

/** Raw markup with <script> and <style> blocks removed, for text-level assertions on the static page. */
const STATIC_MARKUP = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — document structure and landmarks", () => {
  it("is a language-tagged, titled, responsive document with one main, one h1 and the standard landmarks", async () => {
    const { doc } = await loadHome();
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    expect(doc.title).toBe("URBANO Gaming");
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe("width=device-width, initial-scale=1");
    expect(doc.querySelectorAll("main").length).toBe(1);
    expect(doc.querySelector("main")?.getAttribute("id")).toBe("main");
    expect(doc.querySelectorAll("h1").length).toBe(1);
    expect(doc.querySelectorAll("header").length).toBe(1);
    expect(doc.querySelectorAll("footer").length).toBe(1);
    expect(doc.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
  });

  it("has a coherent heading hierarchy: starts at h1, never skips a level; the hero is named by the h1 and every other section by its own h2", async () => {
    const { doc } = await loadHome();
    const levels = Array.from(doc.querySelectorAll("h1, h2, h3, h4")).map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i], `heading ${i} jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(levels[i - 1] + 1);
    for (const section of Array.from(doc.querySelectorAll("main > section"))) {
      const labelId = section.getAttribute("aria-labelledby");
      expect(labelId, `section #${section.id} must be labelled`).toBeTruthy();
      expect(doc.getElementById(labelId!)?.tagName).toBe(section.classList.contains("hero") ? "H1" : "H2");
    }
  });

  it("offers a skip link as the first focusable element, targeting the main landmark", async () => {
    const { doc } = await loadHome();
    const first = doc.querySelector("a[href], button");
    expect(first?.classList.contains("skip-link")).toBe(true);
    expect(first?.getAttribute("href")).toBe("#main");
    expect(doc.getElementById("main")).toBeTruthy();
  });

  it("gives every image an alt attribute; the lockup is named, the compact symbol is decorative next to real visible text", async () => {
    const { doc } = await loadHome();
    for (const img of Array.from(doc.querySelectorAll("img"))) expect(img.hasAttribute("alt"), img.getAttribute("src") ?? "").toBe(true);
    expect(doc.querySelector(".brand-lockup-img")?.getAttribute("alt")).toBe("URBANO Gaming");
    expect(doc.querySelector(".brand-symbol")?.getAttribute("alt")).toBe("");
    expect(doc.querySelector(".brand-compact-name")?.textContent?.replace(/\s+/g, " ").trim()).toBe("URBANOGAMING");
  });

  it("uses inline decorative SVG icons (hidden from assistive technology) and no emoji", async () => {
    const { doc } = await loadHome();
    const icons = Array.from(doc.querySelectorAll("svg"));
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.getAttribute("aria-hidden"), "decorative icon").toBe("true");
      expect(icon.getAttribute("focusable")).toBe("false");
    }
    expect(INDEX_HTML).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("keeps the static first-paint hide on the sign-in control (no flash of the signed-out label)", () => {
    expect(INDEX_HTML).toContain('<button class="signin-btn" id="btn-signin" style="visibility:hidden">Sign in with URBANO</button>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — navigation and stable anchors", () => {
  it("is bounded to exactly Home, Play, Experiences, Competitions and Host", async () => {
    const { doc } = await loadHome();
    const links = Array.from(doc.querySelectorAll("nav.primary-nav a")).map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Home", "/"],
      ["Play", "#play"],
      ["Experiences", "#experiences"],
      ["Competitions", "/competitions.html"],
      ["Host", "#host"],
    ]);
    expect(doc.querySelector('nav.primary-nav a[aria-current="page"]')?.textContent).toBe("Home");
  });

  it("provides the stable in-page anchors #play, #experiences and #host, and every in-page link resolves", async () => {
    const { doc, hrefs } = await loadHome();
    for (const id of ["play", "experiences", "host"]) {
      const section = doc.getElementById(id);
      expect(section?.tagName, `#${id}`).toBe("SECTION");
    }
    for (const href of hrefs().filter((h) => h.startsWith("#"))) expect(doc.getElementById(href.slice(1)), href).toBeTruthy();
  });

  it("does not offer Profile anywhere", async () => {
    const { text, hrefs } = await loadHome();
    expect(text()).not.toMatch(/\bprofile\b/i);
    expect(hrefs().some((h) => /profile/i.test(h))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — link inventory is closed and same-origin", () => {
  it("contains only the allowed links while Become a Host is closed (every one a same-origin path or in-page anchor)", async () => {
    const { hrefs } = await loadHome();
    for (const href of hrefs()) {
      expect(ALLOWED_HREFS.has(href), `unexpected link: ${href}`).toBe(true);
      expect(href.startsWith("/") || href.startsWith("#"), href).toBe(true);
      expect(href.startsWith("//"), href).toBe(false);
    }
  });

  it("links only to pages that exist in this repository", async () => {
    const { hrefs } = await loadHome();
    for (const href of hrefs()) {
      if (href.startsWith("#") || href === "/") continue;
      const file = href.split("?")[0].replace(/^\//, "");
      expect(existsSync(path.join(ROOT, "public", file)), href).toBe(true);
    }
  });

  it("never links an admin console, a contained product, or a sibling page outside the bounded Home", async () => {
    const { hrefs } = await loadHome();
    for (const href of hrefs()) {
      expect(href, href).not.toMatch(/admin|race|pulse|rebote|poker-host|leaderboards|rewards|become-a-host/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — Competitions discovery contract", () => {
  it("shows one entry in the Competitions section with the exact visible label `Competitions`, linking to exactly the bare `/competitions.html`", async () => {
    const { cardIn, doc } = await loadHome();
    const entry = cardIn("competitions", "Competitions");
    expect(entry, "the Competitions card").toBeTruthy();
    expect(entry!.tagName).toBe("A");
    expect(entry!.getAttribute("href")).toBe("/competitions.html");
    expect(entry!.querySelector("h3")?.textContent).toBe("Competitions");
    expect(doc.querySelectorAll("#competitions .exp-card").length).toBe(1);
  });

  it("titles exactly two cards `Competitions` — the Competitions section's and the Host section's — and no card `Competition Organizer`", async () => {
    const { doc } = await loadHome();
    const titled = Array.from(doc.querySelectorAll(".exp-card h3, .exp-card h4")).filter((h) => h.textContent === "Competitions");
    expect(titled.map((h) => h.closest("section")?.id)).toEqual(["competitions", "host"]);
    expect(INDEX_HTML).not.toMatch(/Competition Organizer/i);
  });

  it("every Home link to Competitions (navigation, the Competitions card and the Host section's Competitions card) is the same bare, same-origin path — no query, fragment or appended context", async () => {
    const { doc } = await loadHome();
    const links = Array.from(doc.querySelectorAll("a")).filter((a) => /competition/i.test(a.getAttribute("href") ?? ""));
    expect(links.length).toBe(3); // navigation, the Competitions card, the Host section's Competitions card
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/competitions.html");
      expect((link as HTMLAnchorElement).origin).toBe("http://localhost");
      expect((link as HTMLAnchorElement).search).toBe("");
      expect((link as HTMLAnchorElement).hash).toBe("");
    }
  });

  it("carries no competition context: no names, counts, statuses, invitation parameters, team or participant data, and no admin console", async () => {
    const { cardIn } = await loadHome();
    for (const section of ["competitions", "host"]) {
      const entry = cardIn(section, "Competitions")!;
      expect(entry.textContent, section).not.toMatch(/\d/);
      expect(entry.textContent, section).not.toMatch(/invit|team|registration|fixture|standing|pilot|roster|captain|score|padel|soccer|football|open for|closed|draft|status/i);
    }
    expect(INDEX_HTML).not.toMatch(/competitions-admin|competitionId|competitionTeamId|[?&]c=|[?&]t=|publicCode|public_code/);
    expect(INDEX_HTML).not.toMatch(/\/api\/gaming\/competitions/);
  });

  it("does not fall through to Become a Host, and does not touch the destination's own invitation handling", async () => {
    const { cardIn } = await loadHome();
    for (const section of ["competitions", "host"]) expect(cardIn(section, "Competitions")!.getAttribute("href"), section).not.toMatch(/host/i);
    expect(INDEX_HTML).not.toMatch(/competitionsIntent|CompetitionsIntent|history\.(replace|push)State/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// UG Code Review — Competitions: ACCEPT_WITH_COPY_CORRECTION. The Host section's Competition card is a member-facing link to
// Competitions. Organizer authority is a separate approval, through Become a Host, which the card names only in words: it must not
// claim the member already holds that authority, and it must not claim Become a Host is open.
const HOST_COMPETITIONS = {
  title: "Competitions",
  copy: "Explore competitions as a member. Organizing a competition requires separate approval through Become a Host.",
  action: "Explore Competitions",
  href: "/competitions.html",
} as const;

/**
 * Everything wrong with the Host section's Competitions card, and with any Competitions-related link on the page, as named categories,
 * read from the STATIC markup (scripts are not run): exactly what a closed, first-paint or no-script visitor is served. The shipped
 * page must return []; each deliberately broken copy in the controls below must return the category it breaks.
 */
function hostCompetitionsViolations(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  const found = new Set<string>();
  const card = doc.querySelectorAll("#host-entries > li")[2]?.querySelector(".exp-card") ?? null;
  if (!card) return ["card-missing"];
  const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
  const href = card.getAttribute("href") ?? "";
  if (card.querySelector("h3")?.textContent !== HOST_COMPETITIONS.title) found.add("title");
  if (card.querySelector(".exp-sub")?.textContent !== HOST_COMPETITIONS.copy) found.add("copy");
  if (card.querySelector(".exp-action")?.textContent !== HOST_COMPETITIONS.action) found.add("action");
  if (href !== HOST_COMPETITIONS.href) found.add("destination");
  if (card.tagName !== "A" || card.querySelectorAll("a").length > 0) found.add("card-shape");
  if (/organi[sz]er|you (are|have|can|may)|your (competition|team)|manage|administer|admin\b|console|permission|authority|authori[sz]ed|granted|approved/i.test(text)) found.add("authority-language");
  if (/\d|invit|team|fixture|standing|roster|captain|pilot|registration/i.test(text)) found.add("competition-context");
  if (/\bapply\b|available|open now/i.test(text)) found.add("availability-claim");
  if (/Competition Organizer/i.test(doc.body.textContent ?? "")) found.add("title");
  for (const link of Array.from(doc.querySelectorAll("a[href]"))) {
    const target = link.getAttribute("href") ?? "";
    if (/admin|console|organizer/i.test(target)) found.add("console-or-admin-link");
    if (/become-a-host/i.test(target)) found.add("application-link");
    if (/competition/i.test(target) && /[?#]/.test(target)) found.add("query-or-fragment");
    else if (/competition/i.test(target) && target !== "/competitions.html") found.add("destination");
  }
  return Array.from(found).sort();
}

describe("Home — the Host section's Competitions card carries the accepted copy and nothing that implies authority or availability", () => {
  it("has exactly the accepted title, explanatory copy, action label and destination", async () => {
    const { cardIn } = await loadHome();
    const entry = cardIn("host", "Competitions")!;
    expect(entry, "the Host section's Competitions card").toBeTruthy();
    expect(entry.tagName).toBe("A");
    expect(entry.querySelector("h3")?.textContent).toBe(HOST_COMPETITIONS.title);
    expect(entry.querySelector(".exp-sub")?.textContent).toBe(HOST_COMPETITIONS.copy);
    expect(entry.querySelector(".exp-action")?.textContent).toBe(HOST_COMPETITIONS.action);
    expect(entry.getAttribute("href")).toBe(HOST_COMPETITIONS.href);
    expect(entry.closest("#host-entries")).toBeTruthy();
  });

  it("renders the shared decorative arrow through CSS, so the action label's own text is exactly the accepted label", () => {
    expect(CSS).toMatch(/\.exp-action-arrow::after\s*\{[^}]*content:\s*" →";\s*content:\s*" →" \/ "";/);
    expect(STATIC_MARKUP.match(/<span class="exp-action exp-action-arrow">Explore Competitions<\/span>/g)?.length).toBe(1);
  });

  it("is the page-level truth in every state: the shipped markup has no violation, closed or open", async () => {
    expect(hostCompetitionsViolations(INDEX_HTML)).toEqual([]);
    for (const available of [false, true]) {
      const { cardIn, doc } = await loadHome({ available });
      const entry = cardIn("host", "Competitions")!;
      expect(entry.querySelector(".exp-sub")?.textContent, `available=${available}`).toBe(HOST_COMPETITIONS.copy);
      expect(entry.getAttribute("href"), `available=${available}`).toBe(HOST_COMPETITIONS.href);
      expect(doc.querySelectorAll('a[href="/become-a-host.html"]').length, `available=${available}`).toBe(available ? 1 : 0);
    }
  });

  it("does not imply the member holds organizer authority, that Become a Host is open, or that anything is approved or granted", async () => {
    const { cardIn } = await loadHome();
    const text = (cardIn("host", "Competitions")!.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).not.toMatch(/organi[sz]er|you (are|have|can|may)|your (competition|team)|manage|administer|admin\b|console|permission|authority|authori[sz]ed|granted|approved/i);
    expect(text).not.toMatch(/\bapply\b|available|open now|now open|apply now/i);
    expect(text.replace(HOST_COMPETITIONS.copy, "")).not.toMatch(/become/i); // Become a Host appears only inside the accepted sentence, in words
  });

  it("keeps the four Host concepts apart in meaning: the member-facing Competitions card is not the Session Host, Poker Host or application entry", async () => {
    const { cardIn } = await loadHome();
    const entries = ["Session Host", "Poker Host", "Competitions", "Become a Host"].map((title) => cardIn("host", title)!);
    expect(new Set(entries.map((e) => e.querySelector(".exp-sub")?.textContent)).size).toBe(4);
    expect(entries[2].getAttribute("href")).not.toMatch(/host\.html|become-a-host/);
    for (const other of [0, 1, 3]) expect(entries[other].getAttribute("href") ?? "").not.toBe("/competitions.html");
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // The suite must REJECT each of these. Each is a COPY of the shipped page with one defect introduced; a check that still passed
  // against it would prove nothing.
  // -------------------------------------------------------------------------------------------------------------------------------
  const HOST_AT = INDEX_HTML.indexOf('id="host-entries"');

  function mutate(from: string, to: string, scope: "page" | "host" = "host"): string {
    const base = scope === "host" ? INDEX_HTML.slice(HOST_AT) : INDEX_HTML;
    expect(base.split(from).length - 1, `mutation anchor must exist exactly once (${scope}): ${from.slice(0, 54)}`).toBe(1);
    const html = scope === "host" ? INDEX_HTML.slice(0, HOST_AT) + base.replace(from, () => to) : INDEX_HTML.replace(from, () => to);
    expect(html).not.toBe(INDEX_HTML);
    return html;
  }

  /** For markup that legitimately appears twice (the two Competitions cards open identically): change only the first, which must be the Competitions section's. */
  function mutateSectionCard(from: string, to: string): string {
    expect(INDEX_HTML.split(from).length - 1, `anchor must exist exactly twice: ${from.slice(0, 54)}`).toBe(2);
    expect(INDEX_HTML.indexOf(from), "the first occurrence is the Competitions section's").toBeLessThan(HOST_AT);
    return INDEX_HTML.replace(from, () => to);
  }

  const TITLE = '<h3 class="exp-title">Competitions</h3>';
  const HREF = 'href="/competitions.html"';
  const ACTION = "Explore Competitions</span>";

  // Built lazily: if the shipped page changes so that an anchor disappears, only that control fails (and says so) instead of the whole file failing to load.
  const CONTROLS: Array<[string, () => string, string[]]> = [
    ["the title `Competition Organizer`", () => mutate(TITLE, '<h3 class="exp-title">Competition Organizer</h3>'), ["title"]],
    ["organizer-authority copy: 'You are a competition organizer…'", () => mutate(HOST_COMPETITIONS.copy, "You are a competition organizer. Manage your competition from the organizer console."), ["authority-language", "copy"]],
    ["organizer-authority copy: 'You have organizer permission…'", () => mutate(HOST_COMPETITIONS.copy, "Explore competitions as a member. You have organizer permission to run competitions."), ["authority-language", "copy"]],
    ["the previous (pre-correction) copy", () => mutate(HOST_COMPETITIONS.copy, "Organizing a competition requires its own scoped permission. Start from Competitions."), ["authority-language", "copy"]],
    ["the previous (pre-correction) action label", () => mutate(ACTION, "Explore competitions →</span>"), ["action"]],
    ["a copy that claims Become a Host is open", () => mutate(HOST_COMPETITIONS.copy, "Explore competitions as a member. Become a Host applications are open now."), ["availability-claim", "copy"]],
    ["a copy carrying Competition context (a count and an invitation)", () => mutate(HOST_COMPETITIONS.copy, `${HOST_COMPETITIONS.copy} 3 open competitions, 1 team invitation.`), ["competition-context", "copy"]],
    ["a direct admin destination", () => mutate(HREF, 'href="/competitions-admin.html"'), ["console-or-admin-link", "destination"]],
    ["a direct organizer-console destination", () => mutate(HREF, 'href="/organizer-console.html"'), ["console-or-admin-link", "destination"]],
    ["a query string with Competition context (?c=&t=)", () => mutate(HREF, 'href="/competitions.html?c=abc&t=xyz"'), ["query-or-fragment", "destination"]],
    ["a fragment", () => mutate(HREF, 'href="/competitions.html#registration"'), ["query-or-fragment", "destination"]],
    ["the card falling through to the Become a Host application", () => mutate(HREF, 'href="/become-a-host.html"'), ["application-link", "destination"]],
    ["a Become a Host application link added inside the card while closed", () => mutate(HOST_COMPETITIONS.copy, `${HOST_COMPETITIONS.copy} <a href="/become-a-host.html">Apply now</a>`), ["application-link"]], // (a nested anchor makes the HTML parser close the card, so only the link itself is a stable signal)
    ["a direct admin link elsewhere in the Host section", () => mutate('<span class="exp-action">Host a Session →</span>', '<span class="exp-action">Host a Session →</span><a href="/competitions-admin.html">Console</a>'), ["console-or-admin-link", "destination"]],
    ["the navigation Competitions link gaining a query", () => mutate('<a class="nav-link" href="/competitions.html">Competitions</a>', '<a class="nav-link" href="/competitions.html?c=abc">Competitions</a>', "page"), ["query-or-fragment"]],
    ["the Competitions section card gaining a fragment", () => mutateSectionCard('<a class="exp-card is-actionable" href="/competitions.html">', '<a class="exp-card is-actionable" href="/competitions.html#t=1">'), ["query-or-fragment"]],
  ];

  it.each(CONTROLS)("rejects %s", (_label, build, expected) => {
    const violations = hostCompetitionsViolations(build());
    for (const category of expected) expect(violations, `expected category ${category}`).toContain(category);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("rejects a Become a Host application link while availability is closed (a closed entry that carries the application href)", async () => {
    const closedLinks = async (html?: string) => {
      const { doc } = await loadHome({ available: false, html });
      return doc.querySelectorAll('a[href="/become-a-host.html"]').length;
    };
    expect(await closedLinks()).toBe(0);
    const leaky = mutate('pill: "Not open yet",', 'pill: "Not open yet", href: "/become-a-host.html",', "page");
    expect(await closedLinks(leaky)).toBeGreaterThan(0); // the very predicate asserted above fails on this copy
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — Poker the Dedicated Experience is separate from Poker Host", () => {
  it("presents Poker as a Dedicated Experience / Playtest entry in Experiences, with the player-side route", async () => {
    const { card, doc } = await loadHome();
    const poker = card("Poker")!;
    expect(poker).toBeTruthy();
    expect(poker.closest("#experiences")).toBeTruthy();
    expect(poker.closest("#host")).toBeNull();
    expect(poker.tagName).toBe("A");
    expect(poker.getAttribute("href")).toBe("/poker-table.html");
    expect(poker.textContent).toContain("Dedicated Experience");
    expect(poker.querySelector(".pill")?.textContent).toBe("Playtest");
    expect(Array.from(doc.querySelectorAll("h3, h4")).filter((h) => h.textContent === "Poker").length).toBe(1);
  });

  it("presents Poker Host separately, inside Host, with the hosting route and its own explanation", async () => {
    const { card } = await loadHome();
    const host = card("Poker Host")!;
    expect(host).toBeTruthy();
    expect(host.closest("#host")).toBeTruthy();
    expect(host.closest("#experiences")).toBeNull();
    expect(host.getAttribute("href")).toBe("/host.html?experience=poker");
    expect(host.textContent).not.toContain("Dedicated Experience");
  });

  it("keeps the two as different items: different elements, routes and copy; neither is the other", async () => {
    const { card } = await loadHome();
    const poker = card("Poker")!;
    const host = card("Poker Host")!;
    expect(poker).not.toBe(host);
    expect(poker.getAttribute("href")).not.toBe(host.getAttribute("href"));
    expect(poker.querySelector(".exp-sub")?.textContent).not.toBe(host.querySelector(".exp-sub")?.textContent);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — status truthfulness", () => {
  it("shows Duel as informational only: not a link, not focusable, with the exact hosted-Sessions meaning", async () => {
    const { card } = await loadHome();
    const duel = card("Duel")!;
    expect(duel.tagName).toBe("DIV");
    expect(duel.classList.contains("is-locked")).toBe(true);
    expect(duel.hasAttribute("href")).toBe(false);
    expect(duel.hasAttribute("tabindex")).toBe(false);
    expect(duel.querySelector("a")).toBeNull();
    expect(duel.textContent).toContain("Available inside hosted Sessions — no standalone play.");
  });

  it("labels Rutas and Towers `Playtest` — never Available — and links their pages", async () => {
    const { card } = await loadHome();
    for (const [title, href] of [["URBANO Rutas", "/rutas.html"], ["URBANO Towers", "/towers.html"]] as const) {
      const entry = card(title)!;
      expect(entry.tagName, title).toBe("A");
      expect(entry.getAttribute("href"), title).toBe(href);
      expect(entry.querySelector(".pill")?.textContent, title).toBe("Playtest");
      expect(entry.textContent, title).not.toMatch(/available|production|proven|live/i);
    }
  });

  it("keeps Trivia and Quiz as the existing Playtest entries", async () => {
    const { card } = await loadHome();
    expect(card("Trivia")!.getAttribute("href")).toBe("/trivia-playtest.html");
    expect(card("Quiz")!.getAttribute("href")).toBe("/quiz-playtest.html");
    expect(card("Trivia")!.querySelector(".pill")?.textContent).toBe("Playtest");
    expect(card("Quiz")!.querySelector(".pill")?.textContent).toBe("Playtest");
  });

  it("keeps Community Voting and Level 33 non-actionable future concepts", async () => {
    const { card } = await loadHome();
    for (const title of ["Community Voting", "Level 33"]) {
      const entry = card(title)!;
      expect(entry.tagName, title).toBe("DIV");
      expect(entry.hasAttribute("href"), title).toBe(false);
      expect(entry.hasAttribute("tabindex"), title).toBe(false);
      expect(entry.querySelector("a"), title).toBeNull();
      expect(entry.querySelector(".pill")?.textContent, title).toBe("Future");
    }
    expect(card("Level 33")!.textContent).toContain("Orchestrator Experience");
    expect(card("Level 33")!.textContent).toContain("Not playable or hostable");
  });

  it("describes Soccer Predictions without any match, date, time or availability claim", async () => {
    const { card } = await loadHome();
    const soccer = card("Soccer Predictions")!;
    expect(soccer.getAttribute("href")).toBe("/soccer-predictions.html");
    expect(soccer.textContent).not.toMatch(/\d|live now|today|tonight|tomorrow|kickoff|vs\.?\b/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — what is deliberately not offered", () => {
  it("exposes none of Pulse, Race, Rebote, Daily, matchmaking, other sports, Gaming XP/rewards, Profile or Venue Operations", async () => {
    const { text } = await loadHome();
    const everything = `${text()} ${STATIC_MARKUP}`;
    expect(everything).not.toMatch(/\bpulse\b|\brace\b|\brebote\b|\bdaily\b|matchmak|find an opponent|\bprofile\b|\bxp\b|gaming xp|\brewards?\b|leaderboard|venue operations|karaoke|\bchess\b|\bcheckers\b|\bpool\b|american football|basketball|baseball|padel/i);
  });

  it("has removed the stale hard-coded soccer fixture and does not replace it with another dated or live-looking one", async () => {
    const { text } = await loadHome();
    expect(INDEX_HTML).not.toMatch(/Espanyol|Real Madrid|LaLiga|RCDE|Barcelona|Tegucigalpa|Aug(ust)?\s+\d|Sat,|Live now|match-track|match-slide|featured-note/i);
    expect(text()).not.toMatch(/\b\d{1,2}:\d{2}\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,|\b20\d{2}\b/i);
  });

  it("makes no data-driven request of its own: its only request is the credential-free Host availability check", async () => {
    const { calls } = await loadHome();
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.credentials).toBe("omit");
    expect(INDEX_HTML).not.toMatch(/\/api\/gaming\/(predictions|competitions|leaderboard|rutas|towers|poker|race)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — Host section keeps four distinct concepts", () => {
  it("renders Session Host, Poker Host, Competitions and Become a Host, in that order, each with its own copy", async () => {
    const { doc } = await loadHome();
    const cards = Array.from(doc.querySelectorAll("#host-entries .exp-card"));
    expect(cards.map((c) => c.querySelector("h3")?.textContent)).toEqual(["Session Host", "Poker Host", "Competitions", "Become a Host"]);
    expect(new Set(cards.map((c) => c.querySelector(".exp-sub")?.textContent)).size).toBe(4);
    expect(doc.querySelector("#host-entries")?.closest("#host")).toBeTruthy();
  });

  it("is closed on first paint and without an answer: Become a Host is informational with no application link", async () => {
    const { card, doc } = await loadHome({ available: false });
    const entry = card("Become a Host")!;
    expect(entry.tagName).toBe("DIV");
    expect(entry.hasAttribute("href")).toBe(false);
    expect(entry.textContent).toContain("Host applications are not open yet.");
    expect(doc.querySelectorAll('a[href="/become-a-host.html"]').length).toBe(0);
  });

  it("becomes a link only on an explicit server `available: true`", async () => {
    const { card } = await loadHome({ available: true });
    const entry = card("Become a Host")!;
    expect(entry.tagName).toBe("A");
    expect(entry.getAttribute("href")).toBe("/become-a-host.html");
  });

  it("offers a no-script fallback that lists Become a Host as not open, without any application link", () => {
    const noscript = INDEX_HTML.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";
    expect(noscript).toContain("Become a Host");
    expect(noscript).toContain("Host applications are not open yet.");
    expect(noscript).not.toMatch(/href|become-a-host|Apply/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — local fonts and assets; no external dependency to render", () => {
  it("references no external host at all (the SVG namespace URI is not a network request)", () => {
    expect(INDEX_HTML.split(SVG_NAMESPACE).join("")).not.toMatch(/https?:\/\//i);
    expect(INDEX_HTML).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|jsdelivr|unpkg|cloudflare|@import/i);
    expect(INDEX_HTML).not.toMatch(/<link[^>]+rel=["']?(stylesheet|preconnect|preload|dns-prefetch)/i);
  });

  it("loads only same-origin scripts, and only the two shared ones", async () => {
    const { doc } = await loadHome();
    expect(Array.from(doc.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))).toEqual(["/urbanoAuth.js", "/hostAvailability.js"]);
  });

  it("serves Montserrat from /assets/fonts, with a system fallback stack", () => {
    expect(CSS).toMatch(/@font-face\s*\{[^}]*font-family:\s*"Montserrat"[^}]*url\("\/assets\/fonts\/Montserrat-Variable\.ttf"\)\s*format\("truetype"\)[^}]*font-weight:\s*100 900[^}]*font-display:\s*swap/);
    expect(CSS).toMatch(/font-family:\s*"Montserrat",\s*-apple-system/);
  });

  it("uses only the expected local asset paths", async () => {
    const referenced = new Set<string>();
    for (const m of INDEX_HTML.matchAll(/(?:src|srcset)="(\/assets\/[^"]+)"/g)) referenced.add(m[1]);
    for (const m of CSS.matchAll(/url\("(\/assets\/[^"]+)"\)/g)) referenced.add(m[1]);
    expect(Array.from(referenced).sort()).toEqual([
      "/assets/brand/urbano-gaming-lockup-digital-glow.svg",
      "/assets/brand/urbano-gaming-lockup-structural.svg",
      "/assets/brand/urbano-gaming-symbol-optical-small.svg",
      "/assets/fonts/Montserrat-Variable.ttf",
    ]);
    for (const asset of referenced) expect(existsSync(path.join(ROOT, "public", asset.replace(/^\//, ""))), asset).toBe(true);
  });

  it("ships the frozen baseline assets byte-for-byte (SHA-256 equals the frozen manifest), with the license and provenance", () => {
    for (const [file, expected] of Object.entries(FROZEN_ASSETS)) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex"), file).toBe(expected);
    }
  });

  it("ships none of the editorial artwork", () => {
    for (const name of ["Sports discovery", "Halloween voting", "Poker table", "Level 33 board"]) {
      expect(existsSync(path.join(ROOT, "public/assets", `${name}.png`)), name).toBe(false);
    }
    expect(INDEX_HTML).not.toMatch(/\.(png|jpe?g|webp|gif)\b/i);
    expect(existsSync(path.join(ROOT, "public/assets/art"))).toBe(false);
  });

  it("keeps the shared pages' own mark untouched: the Home no longer uses urbano-mark.svg, the siblings still do", () => {
    expect(INDEX_HTML).not.toContain("urbano-mark.svg");
    expect(readFileSync(path.join(ROOT, "public/leaderboards.html"), "utf8")).toContain("/urbano-mark.svg");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — brand lockup selection", () => {
  it("uses the digital-glow lockup by default, the structural lockup under reduced motion, and the optical symbol at constrained sizes", async () => {
    const { doc } = await loadHome();
    const picture = doc.querySelector("picture.brand-lockup")!;
    expect(picture.querySelector("source")?.getAttribute("media")).toBe("(prefers-reduced-motion: reduce)");
    expect(picture.querySelector("source")?.getAttribute("srcset")).toBe("/assets/brand/urbano-gaming-lockup-structural.svg");
    expect(picture.querySelector("img")?.getAttribute("src")).toBe("/assets/brand/urbano-gaming-lockup-digital-glow.svg");
    expect(doc.querySelector(".brand-symbol")?.getAttribute("src")).toBe("/assets/brand/urbano-gaming-symbol-optical-small.svg");
    expect(CSS).toMatch(/@media \(max-width: 820px\)\s*\{[^@]*\.brand-lockup\s*\{\s*display:\s*none;\s*\}[^@]*\.brand-compact\s*\{\s*display:\s*inline-flex;\s*\}/);
    expect(CSS).toMatch(/\.brand-compact\s*\{\s*display:\s*none;/);
  });

  it("never inlines the frozen SVGs (their internal 'proposed' metadata must not become an accessible name)", () => {
    expect(INDEX_HTML).not.toMatch(/<svg[^>]*aria-label=["'][^"']*proposed/i);
    expect(STATIC_MARKUP).not.toMatch(/PROPOSED/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — accessibility provisions", () => {
  it("shows a visible, high-contrast keyboard focus ring on links and buttons, and removes none", () => {
    expect(CSS).toMatch(/a:focus-visible,\s*button:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--purple-2\);[^}]*outline-offset:\s*3px/);
    const removals = CSS.match(/outline:\s*none/g) ?? [];
    expect(removals.length).toBe(1);
    expect(CSS).toMatch(/main:focus\s*\{\s*outline:\s*none;\s*\}/); // the programmatic skip-link target only, never a control
  });

  it("reveals the skip link on focus", () => {
    expect(CSS).toMatch(/\.skip-link\s*\{[^}]*top:\s*-120px/);
    expect(CSS).toMatch(/\.skip-link:focus\s*\{\s*top:\s*12px;\s*\}/);
  });

  it("honors reduced motion: no animation, transition or smooth scrolling, and smooth scrolling is opt-in only", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*animation:\s*none !important;[^@]*transition:\s*none !important;[^@]*scroll-behavior:\s*auto !important/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*html\s*\{\s*scroll-behavior:\s*smooth;/);
    const smooth = CSS.match(/scroll-behavior:\s*smooth/g) ?? [];
    expect(smooth.length).toBe(1); // only inside the no-preference block
    expect(CSS).not.toMatch(/@keyframes|animation(-name)?:(?!\s*none)/); // the only animation declaration is the reduced-motion `none`
  });

  it("gives primary controls a 44 px minimum target", () => {
    for (const selector of [".nav-link", ".btn"]) {
      expect(CSS, selector).toMatch(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*min-height:\\s*44px`));
    }
    expect(CSS).toMatch(/@media \(max-width: 640px\)\s*\{[^@]*\.signin-btn\s*\{[^}]*min-height:\s*44px/);
  });

  it("keeps non-actionable cards non-interactive and visibly distinct from links without relying on color alone", () => {
    expect(CSS).toMatch(/\.exp-card\.is-locked\s*\{[^}]*border-style:\s*dashed/);
    expect(CSS).not.toMatch(/\.is-locked\s*\{[^}]*opacity/); // no opacity dimming that would reduce text contrast
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
function channel(v: number) { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function luminance([r, g, b]: number[]) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function hex(value: string) { return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)); }
function blend(fg: number[], bg: number[], alpha: number) { return fg.map((v, i) => Math.round(alpha * v + (1 - alpha) * bg[i])); }
function contrast(a: number[], b: number[]) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

describe("Home — palette and contrast", () => {
  const CHARCOAL = hex("#0a0a0a");
  const SURFACE = hex("#1a1a1a");
  const IVORY = hex("#f5f1e8");
  const PURPLE_2 = hex("#b57cff");

  it("uses only the six Gaming Brandbook colors (plus the two game-art tints, as alpha) — no other color literal", () => {
    const hexes = new Set((CSS.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()));
    expect(Array.from(hexes).sort()).toEqual(["#0a0a0a", "#1a1a1a", "#7c3aed", "#b57cff", "#d4af37", "#f5f1e8"]);
    const triplets = new Set(Array.from(CSS.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),/g)).map((m) => `${m[1]},${m[2]},${m[3]}`));
    expect(Array.from(triplets).sort()).toEqual(["124,58,237", "193,139,73", "245,241,232", "79,134,255"]);
  });

  it("never sets the primary purple as small text (it is 3.47:1 on charcoal); text uses ivory, the secondary purple or the muted ivory", () => {
    expect(CSS).not.toMatch(/[^-]color:\s*var\(--purple\)/);
    expect(CSS).not.toMatch(/[^-]color:\s*#7c3aed/i);
    expect(contrast(hex("#7c3aed"), CHARCOAL)).toBeLessThan(4.5); // the reason for the rule above
  });

  it("meets 4.5:1 for every text and background pair the page uses", () => {
    const mutedOnCharcoal = blend(IVORY, CHARCOAL, 0.76);
    const mutedOnSurface = blend(IVORY, SURFACE, 0.76);
    const pairs: Array<[string, number[], number[]]> = [
      ["ivory on charcoal", IVORY, CHARCOAL],
      ["ivory on surface", IVORY, SURFACE],
      ["muted ivory on charcoal", mutedOnCharcoal, CHARCOAL],
      ["muted ivory on surface", mutedOnSurface, SURFACE],
      ["secondary purple on charcoal", PURPLE_2, CHARCOAL],
      ["secondary purple on surface", PURPLE_2, SURFACE],
      ["charcoal on ivory (primary button)", CHARCOAL, IVORY],
    ];
    for (const [label, fg, bg] of pairs) expect(contrast(fg, bg), label).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the strong border (interactive card and button boundaries) at 3:1 or better against the page and the surface", () => {
    const border = (bg: number[]) => blend(IVORY, bg, 0.45);
    expect(contrast(border(CHARCOAL), CHARCOAL)).toBeGreaterThanOrEqual(3);
    expect(contrast(border(SURFACE), SURFACE)).toBeGreaterThanOrEqual(3);
    expect(contrast(PURPLE_2, CHARCOAL)).toBeGreaterThanOrEqual(3); // the focus ring
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("Home — responsive document structure", () => {
  it("defines the narrow-screen breakpoints, a fluid card grid and bounded containers", () => {
    for (const query of ["max-width: 820px", "max-width: 640px", "max-width: 560px", "max-width: 374px"]) expect(CSS, query).toContain(`@media (${query})`);
    expect(CSS).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*230px\),\s*1fr\)\)/);
    expect(CSS).toMatch(/\.shell-header\s*\{[^}]*max-width:\s*1080px/);
    expect(CSS).toMatch(/\.section\s*\{[^}]*max-width:\s*1080px/);
    expect(CSS).toMatch(/\*\s*\{\s*box-sizing:\s*border-box;/);
  });

  it("lets the brand shrink, the navigation wrap and long titles break, so nothing forces horizontal scrolling", () => {
    expect(CSS).toMatch(/\.brand-lockup-img\s*\{[^}]*max-width:\s*100%/);
    expect(CSS).toMatch(/\.primary-nav\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(CSS).toMatch(/\.exp-title\s*\{[^}]*overflow-wrap:\s*break-word/);
    expect(CSS).toMatch(/\.card-grid > li\s*\{[^}]*min-width:\s*0/);
    expect(CSS).not.toMatch(/overflow-x:\s*(auto|scroll)/); // no horizontally scrolling carousels
  });

  it("lets a card's status pill wrap below the icon and never exceed its card (found in a real browser at a 195 CSS px viewport simulation: `Not open yet` overflowed by 17 px)", () => {
    expect(CSS).toMatch(/\.exp-card-top\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(CSS).toMatch(/\.pill\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
  });

  it("declares intrinsic sizes on every image so the layout does not shift", async () => {
    const { doc } = await loadHome();
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      expect(img.getAttribute("width"), img.getAttribute("src") ?? "").toBeTruthy();
      expect(img.getAttribute("height"), img.getAttribute("src") ?? "").toBeTruthy();
    }
  });
});
