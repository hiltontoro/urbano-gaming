import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Home page's Soccer Predictions entry tells the truth about availability.
 *
 * The shipped landing page (public/index.html) is parsed and run whole in jsdom. Its entry used to be a hardcoded historical fixture
 * ("Live now", a past LaLiga match, a play button). It now starts as "Próximamente / Coming Soon" with no play button and is upgraded
 * only when the EXISTING public matches list (GET /api/gaming/predictions/matches) shows a match that is open for predictions: not
 * cancelled, no final result, both teams present, kickoff in the future, and at least one enabled Venue Activation at an active Venue.
 * Anything else (no match, a missing field, a malformed answer, a failed or slow read) stays unavailable. A link to the member's
 * historical predictions and results is always present.
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
const MATCHES_URL = "/api/gaming/predictions/matches";
const PREDICTIONS_PAGE = "/soccer-predictions.html";

type Reply = { status: number; json?: unknown; jsonThrows?: boolean } | "reject" | "hang";

interface Call { url: string; init: Record<string, any> }

async function loadHome(reply: () => Reply, opts: { compressTimeout?: boolean } = {}) {
  const calls: Call[] = [];
  let aborted = false;
  const dom = new JSDOM(INDEX_HTML, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = { attachSignInButton: () => {} };
      if (opts.compressTimeout) {
        const realSetTimeout = window.setTimeout.bind(window);
        // Only the page's own 6 s matches timeout is compressed, so the timeout path runs in milliseconds.
        w.setTimeout = (fn: TimerHandler, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 6000 ? 25 : ms, ...rest);
      }
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        calls.push({ url: String(url), init });
        return (async () => {
          const out = reply();
          if (out === "reject") throw new TypeError("network failure");
          if (out === "hang") {
            return new Promise((_resolve, rejectPromise) => {
              init.signal?.addEventListener("abort", () => { aborted = true; rejectPromise(new DOMException("aborted", "AbortError")); });
            });
          }
          return {
            status: out.status,
            json: async () => {
              if (out.jsonThrows || out.json === undefined) throw new SyntaxError("Unexpected token");
              return out.json;
            },
          };
        })();
      };
    },
  });
  const doc = dom.window.document;
  const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  return {
    win: dom.window,
    doc,
    calls,
    wasAborted: () => aborted,
    settle: async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); },
    status: () => q("#featured-status")?.textContent ?? "",
    note: () => q("#featured-note")?.textContent ?? "",
    cta: () => q("#featured-action a") as HTMLAnchorElement | null,
    history: () => q("#featured-history") as HTMLAnchorElement | null,
    matchHidden: () => (q("#featured-match") as HTMLElement).hidden,
    cardText: () => (q("#featured-predictions")?.textContent ?? "").replace(/\s+/g, " "),
    card: () => q("#featured-predictions") as HTMLElement,
  };
}

const HOUR = 3_600_000;
function match(overrides: Record<string, unknown> = {}) {
  return {
    matchId: "match-1",
    homeTeam: { teamId: "t1", name: "Rojo FC", players: [] },
    awayTeam: { teamId: "t2", name: "Azul FC", players: [] },
    competition: "Copa Barrio",
    kickoffAt: new Date(Date.now() + 36 * HOUR).toISOString(),
    cancelledAt: null,
    finalized: false,
    finalResult: null,
    venueActivations: [{ venueActivationId: "va-1", enabled: true, venue: { venueId: "v1", name: "Sede 1", latitude: 14.1, longitude: -87.2, radiusMeters: 150, active: true }, prizeTiers: [] }],
    ...overrides,
  };
}
const list = (...matches: unknown[]): Reply => ({ status: 200, json: { matches } });

function expectUnavailable(page: Awaited<ReturnType<typeof loadHome>>) {
  expect(page.status()).toBe("Próximamente / Coming Soon");
  expect(page.cta()).toBeNull();
  expect(page.cardText()).not.toMatch(/Enter Soccer Predictions|Live now|Open for predictions|Predictions are open/); // case-sensitive: the unavailable note itself says "No match is open for predictions"
  expect(page.matchHidden()).toBe(true);
  expect(page.history()?.getAttribute("href")).toBe(PREDICTIONS_PAGE); // historical predictions and results stay reachable
}

describe("first paint and static markup: no fixture, no Live now, no play button", () => {
  it("is Próximamente / Coming Soon synchronously, before any request has answered, even for a server that will say a match is open", async () => {
    const page = await loadHome(() => list(match()));
    expectUnavailable(page); // before a single microtask
    await page.settle();
  });

  it("the markup itself carries no historical fixture, no Live now copy and no play button", () => {
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).not.toMatch(/Live now|Espanyol|Real Madrid|LaLiga|RCDE|Aug 22|Featured Match/i);
    expect(withoutScripts).not.toContain("Enter Soccer Predictions");
    expect(INDEX_HTML).not.toMatch(/Espanyol|Real Madrid|LaLiga|RCDE/);
    expect(withoutScripts).toContain("Próximamente / Coming Soon");
  });

  it("always offers the member's history: one link to the Predictions page, labelled for predictions and results, never as a play button", async () => {
    const page = await loadHome(() => list());
    await page.settle();
    const history = page.history()!;
    expect(history.getAttribute("href")).toBe(PREDICTIONS_PAGE);
    expect(history.textContent).toMatch(/predictions and results/i);
    expect(history.className).not.toContain("featured-cta");
  });
});

describe("an open match upgrades the entry; nothing else does", () => {
  it("shows the match and a play button only when the public list has a match open for predictions", async () => {
    const page = await loadHome(() => list(match()));
    await page.settle();
    expect(page.status()).toBe("Open for predictions");
    expect(page.cta()?.getAttribute("href")).toBe(PREDICTIONS_PAGE);
    expect(page.cta()?.textContent).toBe("Enter Soccer Predictions →");
    expect(page.matchHidden()).toBe(false);
    expect(page.cardText()).toContain("Rojo FC");
    expect(page.cardText()).toContain("Azul FC");
    expect(page.cardText()).toContain("Copa Barrio");
    expect(page.cardText()).toContain("Tegucigalpa");
    expect(page.note()).toMatch(/open until kickoff/);
    expect(page.cardText()).not.toMatch(/Live now/i);
    expect(page.history()?.getAttribute("href")).toBe(PREDICTIONS_PAGE);
  });

  it("asks the existing endpoint exactly once: a credential-free GET that is never cached", async () => {
    const page = await loadHome(() => list(match()));
    await page.settle();
    expect(page.calls).toHaveLength(1);
    const [call] = page.calls;
    expect(call.url).toBe(MATCHES_URL);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expect(call.init.credentials).toBe("omit");
    expect(call.init.cache).toBe("no-store");
    expect(JSON.stringify(call.init.headers ?? {})).not.toMatch(/authorization|bearer|apikey/i);
  });

  it("features the soonest open match and ignores earlier matches that are not open", async () => {
    const page = await loadHome(() => list(
      match({ matchId: "past", homeTeam: { name: "Pasado Uno" }, awayTeam: { name: "Pasado Dos" }, kickoffAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
      match({ matchId: "later", homeTeam: { name: "Tarde Uno" }, awayTeam: { name: "Tarde Dos" }, kickoffAt: new Date(Date.now() + 72 * HOUR).toISOString() }),
      match({ matchId: "cancelled-sooner", homeTeam: { name: "Cancelado Uno" }, awayTeam: { name: "Cancelado Dos" }, kickoffAt: new Date(Date.now() + 2 * HOUR).toISOString(), cancelledAt: new Date().toISOString() }),
      match({ matchId: "soonest", homeTeam: { name: "Pronto Uno" }, awayTeam: { name: "Pronto Dos" }, kickoffAt: new Date(Date.now() + 6 * HOUR).toISOString() }),
    ));
    await page.settle();
    expect(page.cardText()).toContain("Pronto Uno");
    expect(page.cardText()).not.toMatch(/Pasado|Tarde|Cancelado/);
  });
});

describe("missing or contrary eligibility evidence keeps the entry unavailable", () => {
  const venue = { venueId: "v1", name: "Sede", latitude: 1, longitude: 1, radiusMeters: 100, active: true };
  const activation = (o: Record<string, unknown> = {}) => ({ venueActivationId: "va", enabled: true, venue, prizeTiers: [], ...o });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["cancelled", { cancelledAt: new Date().toISOString() }],
    ["cancellation evidence missing", { cancelledAt: undefined }],
    ["finalized", { finalized: true }],
    ["finalized evidence missing", { finalized: undefined }],
    ["kickoff in the past", { kickoffAt: new Date(Date.now() - HOUR).toISOString() }],
    ["kickoff unparseable", { kickoffAt: "next weekend" }],
    ["kickoff missing", { kickoffAt: undefined }],
    ["kickoff not a string", { kickoffAt: 1893456000000 }],
    ["no home team", { homeTeam: null }],
    ["no away team", { awayTeam: null }],
    ["blank team name", { awayTeam: { name: "   " } }],
    ["team name not a string", { homeTeam: { name: 7 } }],
    ["no activations", { venueActivations: [] }],
    ["activations missing", { venueActivations: undefined }],
    ["activations not an array", { venueActivations: { enabled: true } }],
    ["activation disabled", { venueActivations: [activation({ enabled: false })] }],
    ["activation enabled is not exactly true", { venueActivations: [activation({ enabled: "true" })] }],
    ["activation without a venue", { venueActivations: [activation({ venue: null })] }],
    ["venue inactive", { venueActivations: [activation({ venue: { ...venue, active: false } })] }],
    ["venue active flag missing", { venueActivations: [activation({ venue: { name: "Sede" } })] }],
    ["match id missing", { matchId: undefined }],
    ["match id blank", { matchId: "" }],
  ];
  it.each(cases)("%s", async (_label, overrides) => {
    const page = await loadHome(() => list(match(overrides)));
    await page.settle();
    expectUnavailable(page);
  });

  it("no matches, or a body that is not a matches list, stays unavailable", async () => {
    for (const reply of [list(), { status: 200, json: { matches: "none" } }, { status: 200, json: {} }, { status: 200, json: null }, { status: 200, json: [match()] }, { status: 200, json: "ok" }, { status: 200, json: { available: true } }] as Reply[]) {
      const page = await loadHome(() => reply);
      await page.settle();
      expectUnavailable(page);
      page.win.close();
    }
  });

  it("one open match among unusable rows still opens the entry, and a null or non-object row cannot break the read", async () => {
    const page = await loadHome(() => ({ status: 200, json: { matches: [null, 3, "x", match({ finalized: true }), match()] } }));
    await page.settle();
    expect(page.status()).toBe("Open for predictions");
  });
});

describe("a failed or slow read fails closed", () => {
  it("network failure, non-200 answers and unreadable JSON all stay unavailable", async () => {
    const failures: Reply[] = ["reject", { status: 500, json: { matches: [match()] } }, { status: 503, json: { matches: [match()] } }, { status: 404, json: { matches: [match()] } }, { status: 401, json: { matches: [match()] } }, { status: 302, json: { matches: [match()] } }, { status: 200, jsonThrows: true }];
    for (const failure of failures) {
      const page = await loadHome(() => failure);
      await page.settle(40);
      expectUnavailable(page);
      page.win.close();
    }
  });

  it("a request that never answers times out, is aborted, and stays unavailable", async () => {
    const page = await loadHome(() => "hang", { compressTimeout: true });
    expectUnavailable(page);
    await page.settle(150);
    expect(page.wasAborted()).toBe(true);
    expectUnavailable(page);
  });
});

describe("team and competition names are text, never markup", () => {
  it("renders hostile names inertly", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const page = await loadHome(() => list(match({ homeTeam: { name: hostile }, awayTeam: { name: "Azul" }, competition: hostile })));
    await page.settle();
    expect(page.status()).toBe("Open for predictions");
    expect(page.card().querySelectorAll("img, script, svg, iframe").length).toBe(0);
    expect(page.cardText()).toContain("<img src=x");
    expect((page.win as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe("the rest of Home is unchanged", () => {
  it("keeps every other catalog entry exactly as it was, and Become a Host closed by default", async () => {
    const page = await loadHome(() => list());
    await page.settle();
    const titles = Array.from(page.doc.querySelectorAll(".exp-card h3")).map((h) => h.textContent);
    expect(titles).toEqual(["Poker", "Trivia", "Quiz", "Duel", "Become a Host", "Community Voting", "Level 33"]);
    const byTitle = (t: string) => Array.from(page.doc.querySelectorAll(".exp-card")).find((c) => c.querySelector("h3")?.textContent === t) as HTMLElement;
    for (const [title, href] of [["Trivia", "/trivia-playtest.html"], ["Quiz", "/quiz-playtest.html"], ["Poker", "/host.html?experience=poker"]] as const) {
      expect(byTitle(title).getAttribute("href"), title).toBe(href);
      expect(byTitle(title).className).toContain("is-actionable");
    }
    for (const title of ["Duel", "Become a Host", "Community Voting", "Level 33"]) expect(byTitle(title).className, title).toContain("is-locked");
    expect(byTitle("Duel").textContent).toMatch(/In development/i);
    expect(page.doc.querySelector('a[href="/become-a-host.html"]')).toBeNull();
  });

  it("does not touch the entries of other products: no Race, Pulse, Competitions or Host request is made", async () => {
    const page = await loadHome(() => list(match()));
    await page.settle();
    expect(page.calls.map((c) => c.url)).toEqual([MATCHES_URL]);
  });
});
