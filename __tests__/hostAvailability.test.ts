import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-090 Correction A — the landing page's Become a Host entry fails closed.
 *
 * Two real artifacts are exercised, not reimplemented: the server route (app/api/gaming/host/availability/route.ts) and the
 * shipped landing page (public/index.html, parsed and run whole in jsdom). Several tests wire the page's fetch straight to the real
 * route handler, so "environment value -> server answer -> card state" is proven end to end. The numbers match the Founder's list:
 *
 *  1 flag absent   2 `false`   3 malformed values   4 exact `true`   5 readiness endpoint failure   6 malformed readiness response
 *  7 no actionable CTA before resolution   8 CTA visible and usable only when ready   9 no environment value or internal
 *    identifier in browser output
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
const ROUTE_SOURCE = readFileSync(path.join(process.cwd(), "app/api/gaming/host/availability/route.ts"), "utf8");
// The ONE browser-side reader of the server's answer, shared by the landing card and the application page (UG-CR-GATE-091).
const READER_SOURCE = readFileSync(path.join(process.cwd(), "public/hostAvailability.js"), "utf8");

const HOST_FLAG = "BECOME_A_HOST_SCHEMA_READY";
const AVAILABILITY_URL = "/api/gaming/host/availability";
// The Home page's separate Soccer Predictions entry reads the public matches list (covered by __tests__/homePredictionsEntry.test.ts).
// It is answered here with "no matches" so these Become a Host tests keep counting only the host availability requests.
const MATCHES_URL = "/api/gaming/predictions/matches";
const BECOME_A_HOST_PAGE = "/become-a-host.html";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Mutable so one test can make the gate itself throw while every other test uses the real gate.
let gateThrows = false;
vi.mock("@/lib/gaming/host/httpAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gaming/host/httpAuth")>();
  return {
    ...actual,
    isBecomeAHostSchemaReady: () => {
      if (gateThrows) throw new Error("gate failure");
      return actual.isBecomeAHostSchemaReady();
    },
  };
});

const SAVED_ENV: Record<string, string | undefined> = {};
const TOUCHED_ENV = [HOST_FLAG, "RACE_SCHEMA_READY", "COMPETITIONS_SCHEMA_READY", "PULSE_PRODUCTION_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

beforeEach(() => {
  gateThrows = false;
  for (const k of TOUCHED_ENV) SAVED_ENV[k] = process.env[k];
  for (const k of TOUCHED_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

async function callRoute(): Promise<Response> {
  const { GET } = await import("../app/api/gaming/host/availability/route");
  return GET();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The shipped landing page in jsdom
// ---------------------------------------------------------------------------------------------------------------------------------

interface FetchCall { url: string; init: Record<string, any> }
type Reply = Response | { status: number; json?: unknown; jsonThrows?: boolean } | "reject" | "hang";

/** Page-side answer to a request: either a stand-in reply, or the REAL route handler's answer for the environment as it is right now. */
async function realRouteReply(): Promise<Reply> {
  const res = await callRoute();
  return { status: res.status, json: await res.json() };
}

/** `readerSource: null` models a page whose /hostAvailability.js failed to load. */
async function loadLanding(reply: () => Reply | Promise<Reply>, opts: { compressTimeout?: boolean; html?: string; readerSource?: string | null } = {}) {
  const calls: FetchCall[] = [];
  const matchCalls: FetchCall[] = [];
  const dom = new JSDOM(opts.html ?? INDEX_HTML, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = { attachSignInButton: () => {} };
      if (opts.compressTimeout) {
        const realSetTimeout = window.setTimeout.bind(window);
        // Only the page's own 4 s readiness timeout is compressed, so the timeout path can run in a few milliseconds.
        w.setTimeout = (fn: TimerHandler, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 4000 ? 25 : ms, ...rest);
      }
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        if (String(url) === MATCHES_URL) {
          matchCalls.push({ url: String(url), init });
          return Promise.resolve({ status: 200, json: async () => ({ matches: [] }) });
        }
        calls.push({ url: String(url), init });
        return (async () => {
          const out = await reply();
          if (out === "reject") throw new TypeError("network failure");
          if (out === "hang") {
            return new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
          }
          return {
            status: (out as any).status,
            json: async () => {
              if ((out as any).jsonThrows || (out as any).json === undefined) throw new SyntaxError("Unexpected token");
              return (out as any).json;
            },
          };
        })();
      };
      // jsdom does not load external scripts, so the REAL shipped reader is evaluated into the window, exactly as the script tag would.
      if (opts.readerSource !== null) window.eval(opts.readerSource ?? READER_SOURCE);
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const card = () => Array.from(doc.querySelectorAll("#experiences-carousel .exp-card")).find((c) => (c.querySelector("h3")?.textContent ?? "") === "Become a Host") as HTMLElement | undefined;
  const settle = async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); };
  return {
    win, doc, calls, matchCalls, card, settle,
    markup: () => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script").forEach((s) => s.remove()); return c.innerHTML; },
    /** Rendered text only: the page's own script source is not content. */
    text: () => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script").forEach((x) => x.remove()); return (c.textContent ?? "").replace(/\s+/g, " "); },
  };
}

function expectClosedCard(card: HTMLElement | undefined) {
  expect(card, "the Become a Host card must always be present").toBeTruthy();
  expect(card!.tagName).toBe("DIV");
  expect(card!.classList.contains("is-locked")).toBe(true);
  expect(card!.classList.contains("is-actionable")).toBe(false);
  expect(card!.hasAttribute("href")).toBe(false);
  expect(card!.textContent).toContain("Host applications are not open yet.");
  expect(card!.textContent).not.toMatch(/Apply/);
}

function expectOpenCard(card: HTMLElement | undefined) {
  expect(card).toBeTruthy();
  expect(card!.tagName).toBe("A");
  expect(card!.classList.contains("is-actionable")).toBe(true);
  expect(card!.getAttribute("href")).toBe(BECOME_A_HOST_PAGE);
  expect(card!.textContent).toContain("Apply →");
  expect(card!.textContent).toContain("private, invite-only tournament");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The server's answer
// ---------------------------------------------------------------------------------------------------------------------------------

describe("GET /api/gaming/host/availability — the server's bounded answer", () => {
  it("[1] the flag ABSENT is unavailable", async () => {
    delete process.env[HOST_FLAG];
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("[2] the flag `false` is unavailable", async () => {
    process.env[HOST_FLAG] = "false";
    expect(await (await callRoute()).json()).toEqual({ available: false });
  });

  it("[3] every malformed value is unavailable — only the exact string `true` is ever open", async () => {
    const malformed = ["", " ", "FALSE", "TRUE", "True", " true", "true ", "true\n", "\ttrue", "1", "0", "yes", "on", "enabled", "null", "undefined", "tru", "truee", "t", '"true"', "{\"available\":true}", "true;", "true,false", "\u0000true"];
    for (const value of malformed) {
      process.env[HOST_FLAG] = value;
      expect(await (await callRoute()).json(), JSON.stringify(value)).toEqual({ available: false });
    }
  });

  it("[4] the exact string `true` is available — and only then", async () => {
    process.env[HOST_FLAG] = "true";
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  it("is read on EVERY request, never frozen: closing the gate closes the answer immediately, and so does reopening it", async () => {
    process.env[HOST_FLAG] = "true";
    expect(await (await callRoute()).json()).toEqual({ available: true });
    delete process.env[HOST_FLAG];
    expect(await (await callRoute()).json()).toEqual({ available: false });
    process.env[HOST_FLAG] = "true";
    expect(await (await callRoute()).json()).toEqual({ available: true });
    expect(ROUTE_SOURCE).toMatch(/export const dynamic = "force-dynamic";/);
  });

  it("fails closed on the server too: if reading the gate throws, the answer is unavailable (never a 500, never open)", async () => {
    process.env[HOST_FLAG] = "true";
    gateThrows = true;
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("is not cacheable by any shared cache", async () => {
    process.env[HOST_FLAG] = "true";
    const cacheControl = (await callRoute()).headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
  });

  it("[9] discloses ONLY the boolean: exactly one key, and no variable name or value, project, schema, provider, configuration or identifier", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54421";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-value-that-must-never-appear";
    for (const value of [undefined, "false", "true", "garbage"]) {
      if (value === undefined) delete process.env[HOST_FLAG];
      else process.env[HOST_FLAG] = value;
      const res = await callRoute();
      const raw = await res.text();
      const body = JSON.parse(raw);
      expect(Object.keys(body)).toEqual(["available"]);
      expect(typeof body.available).toBe("boolean");
      expect(raw).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|SUPABASE|service-role|127\.0\.0\.1|localhost|garbage|migration|schema|provider|vercel|postgres|database|table|function/i);
      expect(raw).not.toMatch(UUID_PATTERN);
      expect(raw.length).toBeLessThan(30);
      const headerText = JSON.stringify(Array.from(res.headers.entries()));
      expect(headerText).not.toMatch(/BECOME_A_HOST|SUPABASE|service-role|garbage/i);
    }
  });

  it("accepts no mutation and no input: GET is the only handler, and the route reads no credentials, session, body, query or database", () => {
    expect(Array.from(ROUTE_SOURCE.matchAll(/export (?:async )?function (\w+)/g)).map((m) => m[1])).toEqual(["GET"]);
    expect(ROUTE_SOURCE).not.toMatch(/export (?:async )?function (POST|PUT|PATCH|DELETE)\b/);
    const code = ROUTE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["getSupabaseCredentials", "requireGamingMember", "buildHostRepo", "request.json", "searchParams", "headers.get", "process.env", "createClient", "SUPABASE"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("isBecomeAHostSchemaReady");
  });

  it("[independence] Race, Pulse and Competitions readiness neither open nor close it, and it changes none of them", async () => {
    const race = await import("../lib/gaming/race/schemaAvailability");
    const comps = await import("../lib/gaming/competitions/httpAuth");
    // Everything else open, host closed -> closed.
    process.env.RACE_SCHEMA_READY = "true";
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    process.env.PULSE_PRODUCTION_SCHEMA_READY = "true";
    delete process.env[HOST_FLAG];
    expect(await (await callRoute()).json()).toEqual({ available: false });
    // Host open, everything else closed -> open, and the others stay closed.
    delete process.env.RACE_SCHEMA_READY;
    delete process.env.COMPETITIONS_SCHEMA_READY;
    delete process.env.PULSE_PRODUCTION_SCHEMA_READY;
    process.env[HOST_FLAG] = "true";
    expect(await (await callRoute()).json()).toEqual({ available: true });
    expect(race.isRaceSchemaReady()).toBe(false);
    expect(comps.requireCompetitionsSchemaReady()?.status).toBe(503);
    // And the reverse: the host flag never opens Race.
    expect(ROUTE_SOURCE).not.toMatch(/RACE_SCHEMA_READY|PULSE|COMPETITIONS_SCHEMA_READY/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The shipped landing page
// ---------------------------------------------------------------------------------------------------------------------------------

describe("public/index.html — the Become a Host card fails closed", () => {
  it("[7] before the answer arrives the card is NOT actionable — not at first paint, and not while the request is still pending", async () => {
    const page = await loadLanding(() => "hang");
    // Synchronously after the scripts ran, before a single microtask: the closed card is already there.
    expectClosedCard(page.card());
    expect(page.doc.querySelectorAll(`a[href="${BECOME_A_HOST_PAGE}"]`).length).toBe(0);
    await page.settle(80);
    expectClosedCard(page.card()); // still pending: still closed
    expect(page.calls).toHaveLength(1);
  });

  it("[7] the very first paint contains no link to the application and no `Apply` text, even for a server that will say yes", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadLanding(realRouteReply);
    expect(page.markup()).not.toContain(BECOME_A_HOST_PAGE); // synchronously, before the open card could have been rendered
    expect(page.text()).not.toMatch(/Apply/);
    await page.settle();
  });

  it("[1] flag ABSENT: the real route says closed, and the card stays informational with no application link", async () => {
    delete process.env[HOST_FLAG];
    const page = await loadLanding(realRouteReply);
    await page.settle();
    expectClosedCard(page.card());
    expect(page.markup()).not.toContain(BECOME_A_HOST_PAGE);
  });

  it("[2] flag `false`: closed", async () => {
    process.env[HOST_FLAG] = "false";
    const page = await loadLanding(realRouteReply);
    await page.settle();
    expectClosedCard(page.card());
  });

  it("[3] every malformed flag value, through the real route: closed", async () => {
    for (const value of ["", " ", "TRUE", "True", " true", "true ", "1", "yes", "on", "null"]) {
      process.env[HOST_FLAG] = value;
      const page = await loadLanding(realRouteReply);
      await page.settle(30);
      expectClosedCard(page.card());
      page.win.close();
    }
  });

  it("[4, 8] exact `true`, through the real route: the card becomes a real, usable link to the application page — and only then", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadLanding(realRouteReply);
    await page.settle();
    const card = page.card();
    expectOpenCard(card);
    // Usable: a real anchor, focusable, with the application page as its destination, in the same carousel as before.
    expect((card as HTMLAnchorElement).href).toBe(`http://localhost${BECOME_A_HOST_PAGE}`);
    expect(card!.getAttribute("tabindex")).not.toBe("-1");
    expect(card!.closest("#experiences-carousel")).toBeTruthy();
    expect(page.doc.querySelectorAll(`a[href="${BECOME_A_HOST_PAGE}"]`).length).toBe(1);
    // The sibling cards are untouched.
    const titles = Array.from(page.doc.querySelectorAll("#experiences-carousel h3")).map((h) => h.textContent);
    expect(titles).toEqual(["Become a Host", "Community Voting", "Level 33"]);
  });

  it("[8] the readiness answer is acted on only once: after it resolves open the card is open, and an unrelated later event cannot make a closed card open", async () => {
    // Closed page stays closed no matter how long we wait.
    process.env[HOST_FLAG] = "false";
    const closed = await loadLanding(realRouteReply);
    await closed.settle(120);
    expectClosedCard(closed.card());
    expect(closed.calls).toHaveLength(1);
  });

  it("[5] readiness endpoint FAILURE fails closed: network error, 500, 503, 404, 401, and a redirect-style status", async () => {
    const failures: Reply[] = ["reject", { status: 500, json: { available: true } }, { status: 503, json: { available: true } }, { status: 404, json: { available: true } }, { status: 401, json: { available: true } }, { status: 302, json: { available: true } }, { status: 201, json: { available: true } }, { status: 204 }];
    for (const failure of failures) {
      const page = await loadLanding(() => failure);
      await page.settle(30);
      expectClosedCard(page.card());
      page.win.close();
    }
  });

  it("[5] a request that never answers times out and stays closed — and aborts the request", async () => {
    let aborted = false;
    const page = await loadLanding(() => "hang", { compressTimeout: true });
    const signal = page.calls[0].init.signal as AbortSignal;
    signal.addEventListener("abort", () => { aborted = true; });
    await page.settle(150);
    expect(aborted).toBe(true);
    expectClosedCard(page.card());
  });

  it("[6] a MALFORMED readiness response fails closed — whatever it contains, even when it contains `true`", async () => {
    const malformed: Reply[] = [
      { status: 200, jsonThrows: true },                       // not JSON
      { status: 200, json: null },
      { status: 200, json: [] },
      { status: 200, json: [{ available: true }] },
      { status: 200, json: "true" },
      { status: 200, json: true },
      { status: 200, json: 1 },
      { status: 200, json: {} },
      { status: 200, json: { available: "true" } },
      { status: 200, json: { available: 1 } },
      { status: 200, json: { available: "yes" } },
      { status: 200, json: { available: null } },
      { status: 200, json: { available: false } },
      { status: 200, json: { Available: true } },
      { status: 200, json: { ready: true } },
      { status: 200, json: { available: true, extra: "anything" } }, // not the bounded shape
      { status: 200, json: { available: [true] } },
      { status: 200, json: { available: { value: true } } },
    ];
    for (const reply of malformed) {
      const page = await loadLanding(() => reply);
      await page.settle(30);
      expectClosedCard(page.card());
      page.win.close();
    }
  });

  it("[8] only the exact bounded shape opens the card: HTTP 200 with a body of exactly { available: true }", async () => {
    const page = await loadLanding(() => ({ status: 200, json: { available: true } }));
    await page.settle();
    expectOpenCard(page.card());
  });

  it("makes exactly one request to the availability endpoint — a credential-free GET that is never cached — and no other host, Race or Pulse request", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadLanding(realRouteReply);
    await page.settle();
    expect(page.calls).toHaveLength(1);
    const [call] = page.calls;
    expect(call.url).toBe(AVAILABILITY_URL);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expect(call.init.credentials).toBe("omit");
    expect(call.init.cache).toBe("no-store");
    expect(JSON.stringify(call.init.headers ?? {})).not.toMatch(/authorization|bearer|apikey/i);
    expect(page.calls.some((c) => /race|pulse|\/host\/status|\/host\/applications|\/host\/review/i.test(c.url))).toBe(false);
  });

  it("[9] no environment value, variable name or internal identifier ever appears in what the browser receives or renders", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54421";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-value-that-must-never-appear";
    for (const flag of [undefined, "false", "true"]) {
      if (flag === undefined) delete process.env[HOST_FLAG];
      else process.env[HOST_FLAG] = flag;
      const page = await loadLanding(realRouteReply);
      await page.settle();
      const rendered = `${page.markup()}\n${page.text()}`;
      expect(rendered).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|SUPABASE|service-role|127\.0\.0\.1:54421/i);
      expect(rendered).not.toMatch(UUID_PATTERN);
    }
    // The file the browser downloads never names the variable and never touches the server's environment.
    expect(INDEX_HTML).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|process\.env/);
    expect(READER_SOURCE).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|process\.env/);
  });

  it("a page whose shared reader failed to load fails closed — it never opens the card on its own", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadLanding(realRouteReply, { readerSource: null });
    await page.settle(80);
    expectClosedCard(page.card());
    expect(page.calls).toHaveLength(0); // nothing asked the server anything: there is no reader to ask
  });

  it("the strict reading of the server's answer exists in exactly ONE place (public/hostAvailability.js), which both pages load", () => {
    const BECOME_HTML = readFileSync(path.join(process.cwd(), "public/become-a-host.html"), "utf8");
    for (const [name, html] of [["index.html", INDEX_HTML], ["become-a-host.html", BECOME_HTML]] as const) {
      expect(html, name).toContain('<script src="/hostAvailability.js"></script>');
      // The reader is loaded before the page's own inline script, so it exists by the time the page asks.
      expect(html.indexOf('<script src="/hostAvailability.js"></script>'), name).toBeLessThan(html.indexOf("<script>"));
      expect(html, name).not.toContain(AVAILABILITY_URL); // the URL is the reader's, not the page's
      expect(html, name).not.toMatch(/body\.available|Object\.keys\(body\)|\.available\s*===/);
      expect(html, name).toContain("HostAvailability");
    }
    expect(READER_SOURCE).toContain(AVAILABILITY_URL);
    expect(READER_SOURCE).toMatch(/keys\.length === 1 && keys\[0\] === "available" && body\.available === true/);
    expect(READER_SOURCE).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|process\.env|localStorage|sessionStorage|document\.cookie|NEXT_PUBLIC/);
  });

  it("there is no client-side readiness switch: the open card cannot be reached except through the server's answer", () => {
    // The application link exists in exactly one place in the script (the open variant) and nowhere in the static markup.
    const withoutScripts = INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).not.toContain(BECOME_A_HOST_PAGE);
    expect(INDEX_HTML.split(BECOME_A_HOST_PAGE).length - 1).toBe(1);
    // Nothing hardcodes "open", reads storage or the URL to decide, or infers readiness from anything else.
    const script = INDEX_HTML.slice(INDEX_HTML.indexOf("const HOST_ENTRY_CLOSED"), INDEX_HTML.indexOf("</script>", INDEX_HTML.indexOf("const HOST_ENTRY_CLOSED")));
    expect(script).not.toMatch(/localStorage|sessionStorage|location\.(search|hash|href)|URLSearchParams|document\.cookie|NEXT_PUBLIC|hostOpen\s*=\s*true|=\s*true;\s*\/\/\s*open/);
    expect(script).toMatch(/experiencesCatalog\(false\)/); // first paint is always the closed card
    expect(script).toMatch(/if \(open === true\) renderCatalog\(experiencesCatalog\(true\)/);
  });

  it("the rest of the landing page is unchanged: the skill-game cards and the other experience cards render exactly as before", async () => {
    const page = await loadLanding(() => "reject");
    await page.settle(30);
    const games = Array.from(page.doc.querySelectorAll("#games-carousel h3")).map((h) => h.textContent);
    expect(games).toEqual(["Poker", "Trivia", "Quiz", "Duel"]);
    const experiences = Array.from(page.doc.querySelectorAll("#experiences-carousel h3")).map((h) => h.textContent);
    expect(experiences).toEqual(["Become a Host", "Community Voting", "Level 33"]);
    expect(page.doc.querySelectorAll("#experiences-carousel .exp-card.is-locked").length).toBe(3); // all three informational while closed
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: each protection is removed from a COPY of the shipped page, and the very scenario its test guards is shown to
// then produce an actionable Become a Host card. A test that still passed against these copies would prove nothing.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("negative controls — removing any fail-closed protection makes the CTA actionable when it must not be", () => {
  function mutated(from: string, to: string): string {
    expect(INDEX_HTML.split(from).length - 1, `mutation anchor must exist exactly once: ${from.slice(0, 50)}`).toBe(1);
    const html = INDEX_HTML.replace(from, to);
    expect(html).not.toBe(INDEX_HTML);
    return html;
  }
  /** The same, for the shared reader (the strict reading of the server's answer lives there, not in the page). */
  function mutatedReader(from: string, to: string): string {
    expect(READER_SOURCE.split(from).length - 1, `reader mutation anchor must exist exactly once: ${from.slice(0, 50)}`).toBe(1);
    const source = READER_SOURCE.replace(from, to);
    expect(source).not.toBe(READER_SOURCE);
    return source;
  }
  const actionable = (page: Awaited<ReturnType<typeof loadLanding>>) => page.doc.querySelectorAll(`a[href="${BECOME_A_HOST_PAGE}"]`).length > 0;

  it("control 1 — first paint rendered open: the CTA is actionable while the request is still pending", async () => {
    const page = await loadLanding(() => "hang", { html: mutated('renderCatalog(experiencesCatalog(false), "experiences-carousel");', 'renderCatalog(experiencesCatalog(true), "experiences-carousel");') });
    expect(actionable(page)).toBe(true); // the flash the real page prevents
  });

  it("control 2 — shape check loosened to `truthy`: a malformed { available: \"true\" } opens the CTA", async () => {
    const readerSource = mutatedReader('return keys.length === 1 && keys[0] === "available" && body.available === true;', "return !!body.available;");
    const page = await loadLanding(() => ({ status: 200, json: { available: "true" } }), { readerSource });
    await page.settle(30);
    expect(actionable(page)).toBe(true);
  });

  it("control 3 — status check removed: a 500 response carrying { available: true } opens the CTA", async () => {
    const readerSource = mutatedReader("if (!res || res.status !== 200) return false;", "if (!res) return false;");
    const page = await loadLanding(() => ({ status: 500, json: { available: true } }), { readerSource });
    await page.settle(30);
    expect(actionable(page)).toBe(true);
  });

  it("control 4 — failure treated as open: a network error opens the CTA", async () => {
    const readerSource = mutatedReader("} catch (_) {\n      return false;", "} catch (_) {\n      return true;");
    const page = await loadLanding(() => "reject", { readerSource });
    await page.settle(30);
    expect(actionable(page)).toBe(true);
  });

  it("control 5 — the server's answer ignored: a server that says closed still gets an actionable CTA", async () => {
    process.env[HOST_FLAG] = "false";
    const html = mutated("hostOpen === true ? HOST_ENTRY_OPEN : HOST_ENTRY_CLOSED", "HOST_ENTRY_OPEN");
    const page = await loadLanding(realRouteReply, { html });
    await page.settle(30);
    expect(actionable(page)).toBe(true);
  });

  it("control 6 — timeout removed: a request that never answers is never aborted (nothing ends the wait)", async () => {
    const readerSource = mutatedReader("if (controller) timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);", "");
    let aborted = false;
    const page = await loadLanding(() => "hang", { readerSource, compressTimeout: true });
    (page.calls[0].init.signal as AbortSignal | undefined)?.addEventListener("abort", () => { aborted = true; });
    await page.settle(150);
    expect(aborted).toBe(false); // the real page aborts here (see the timeout test above)
  });

  it("the controls changed only their own copies: the shipped page still fails closed", async () => {
    const page = await loadLanding(() => "hang");
    expect(actionable(page)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-091 Correction D — the 320 px landing header. jsdom does not lay anything out, so these pin the RULES that produce the
// measured result (real-browser numbers at 320 / 375 / 768 / 1280 px are in UG-CR-RPT-091); the rules are what must not silently regress.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("landing header — the 320 px overflow fix is pinned", () => {
  const css = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));
  const rule = (selector: string, source = css) => {
    const m = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : "";
  };
  const media = (query: string) => {
    const start = css.indexOf(`@media (${query})`);
    if (start < 0) return "";
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
    }
    return "";
  };

  it("below 375 px the header may wrap, so the sign-in control drops to its own row instead of overflowing the page", () => {
    const narrow = media("max-width: 374px");
    expect(narrow).toMatch(/\.shell-header\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(narrow).toMatch(/row-gap:\s*8px/);
  });

  it("at 375 px and wider the header is NOT wrapping (that layout is unchanged), and no other width-specific wrap exists", () => {
    expect(rule(".shell-header")).not.toMatch(/flex-wrap/);
    expect((css.match(/flex-wrap:\s*wrap/g) ?? []).length).toBeGreaterThanOrEqual(1);
    for (const query of ["max-width: 640px"]) expect(media(query)).not.toMatch(/\.shell-header\s*\{[^}]*flex-wrap/);
  });

  it("the sign-in control keeps its label on one line (never broken mid-word), keeps its natural width, and is never wider than the header", () => {
    const btn = rule(".signin-btn");
    expect(btn).toMatch(/white-space:\s*nowrap/);
    expect(btn).toMatch(/flex-shrink:\s*0/);
    expect(btn).toMatch(/max-width:\s*100%/);
    expect(btn).toMatch(/text-overflow:\s*ellipsis/);
    expect(btn).not.toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-(all|word)|hyphens:\s*auto/);
  });

  it("on phones the sign-in control has a 44 px touch target, and the 768 / 1280 px layouts are left alone", () => {
    expect(media("max-width: 640px")).toMatch(/\.signin-btn\s*\{[^}]*min-height:\s*44px/);
    expect(rule(".signin-btn")).not.toMatch(/min-height/); // not applied at tablet/desktop widths
  });
});
