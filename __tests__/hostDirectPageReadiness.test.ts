import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-091 Correction C — /become-a-host.html stays closed unless the SERVER says Become a Host is open.
 *
 * The shipped page and the shipped shared reader (public/hostAvailability.js) are parsed and run whole in jsdom; several tests wire the
 * page's fetch straight to the REAL availability route, so "environment value -> server answer -> what a visitor can do" is proven end to
 * end. While the answer is not exactly open — absent, false, malformed, pending, failed, timed out, malformed response, missing reader —
 * the page may explain the program, but it must not show an actionable sign-in-to-apply button, must never open the OTP panel, must not
 * show an application form, must say plainly that applications are not open yet, and must not make a single application request.
 * Readiness is read by the one shared reader; the page holds no readiness logic of its own.
 */

const PAGE_HTML = readFileSync(path.join(process.cwd(), "public/become-a-host.html"), "utf8");
const READER_SOURCE = readFileSync(path.join(process.cwd(), "public/hostAvailability.js"), "utf8");

const HOST_FLAG = "BECOME_A_HOST_SCHEMA_READY";
const AVAILABILITY_URL = "/api/gaming/host/availability";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TOKEN_VALUE = "stub-access-token-value-12345";
const CLOSED_HEADING = "Applications to host competitions are not open yet";

type AuthState =
  | { status: "unauthenticated" }
  | { status: "profile_incomplete"; email: string }
  | { status: "authenticated"; email: string; gamingMemberId: string; displayName: string };

const signedOut: AuthState = { status: "unauthenticated" };
const signedIn: AuthState = { status: "authenticated", email: "alex@example.com", gamingMemberId: "11111111-2222-3333-4444-555555555555", displayName: "Alex Applicant" };
const noName: AuthState = { status: "profile_incomplete", email: "alex@example.com" };

interface Call { url: string; init: Record<string, any> }
type Reply = { status: number; json?: unknown; jsonThrows?: boolean } | "reject" | "hang" | Promise<{ status: number; json?: unknown }>;

const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => { SAVED_ENV[HOST_FLAG] = process.env[HOST_FLAG]; delete process.env[HOST_FLAG]; });
afterEach(() => { if (SAVED_ENV[HOST_FLAG] === undefined) delete process.env[HOST_FLAG]; else process.env[HOST_FLAG] = SAVED_ENV[HOST_FLAG]; });

/** The server's real answer for the environment as it is right now. */
async function realRouteReply(): Promise<Reply> {
  const { GET } = await import("../app/api/gaming/host/availability/route");
  const res = await GET();
  return { status: res.status, json: await res.json() };
}

interface LoadOptions {
  auth?: AuthState;
  availability?: () => Reply | Promise<Reply>;
  /** Answers every request that is NOT the availability check (the page's application requests). */
  respond?: (call: Call) => { status: number; json?: unknown };
  compressTimeout?: boolean;
  html?: string;
  /** `null` models a page whose /hostAvailability.js failed to load. */
  readerSource?: string | null;
}

async function loadPage(opts: LoadOptions = {}) {
  const calls: Call[] = [];
  const availabilityCalls: Call[] = [];
  const attachCalls: Array<{ button: HTMLElement | null }> = [];
  const listeners: Array<() => void> = [];
  const stats = { getState: 0, getAccessToken: 0, panelOpens: 0, headerClicks: 0 };
  let authState: AuthState = opts.auth ?? signedOut;
  const availability = opts.availability ?? realRouteReply;
  const dom = new JSDOM(opts.html ?? PAGE_HTML, {
    url: "http://localhost/become-a-host.html", // a direct navigation, not a click from the landing page
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      if (opts.compressTimeout) {
        const realSetTimeout = window.setTimeout.bind(window);
        w.setTimeout = (fn: TimerHandler, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 4000 ? 25 : ms, ...rest);
      }
      // A faithful emulation of urbanoAuth.js's panel: attaching wires the HEADER button, and a click on it opens the one-time-code panel.
      w.UrbanoAuth = {
        attachSignInButton: (btn: HTMLElement) => {
          attachCalls.push({ button: btn });
          const doc = btn.ownerDocument;
          const panel = doc.createElement("div");
          panel.setAttribute("data-urbano-signin-panel", "");
          panel.style.display = "none";
          panel.innerHTML = '<input data-email type="email" />';
          btn.insertAdjacentElement("afterend", panel);
          let open = false;
          btn.style.visibility = "";
          btn.addEventListener("click", () => {
            stats.headerClicks += 1;
            open = !open;
            if (open) stats.panelOpens += 1;
            panel.style.display = open ? "block" : "none";
          });
          doc.addEventListener("click", (e) => { if (open && !panel.contains(e.target as Node) && e.target !== btn) { open = false; panel.style.display = "none"; } });
        },
        getState: async () => { stats.getState += 1; return authState; },
        getAccessToken: async () => { stats.getAccessToken += 1; return TOKEN_VALUE; },
        onAuthStateChange: async (cb: () => void) => { listeners.push(cb); return () => {}; },
        completeProfile: async (name: string) => { authState = { status: "authenticated", email: "alex@example.com", gamingMemberId: "11111111-2222-3333-4444-555555555555", displayName: name }; return authState; },
      };
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        const call: Call = { url: String(url), init };
        if (call.url === AVAILABILITY_URL) {
          availabilityCalls.push(call);
          return (async () => {
            const out = await availability();
            if (out === "reject") throw new TypeError("network failure");
            if (out === "hang") return new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
            const reply = out as { status: number; json?: unknown; jsonThrows?: boolean };
            return { status: reply.status, json: async () => { if (reply.jsonThrows || reply.json === undefined) throw new SyntaxError("Unexpected token"); return reply.json; } };
          })();
        }
        calls.push(call);
        const out = (opts.respond ?? (() => ({ status: 404, json: { error: "unexpected" } })))(call);
        return Promise.resolve({ status: out.status, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; } });
      };
      if (opts.readerSource !== null) window.eval(opts.readerSource ?? READER_SOURCE);
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const $ = (sel: string) => doc.querySelector(sel);
  const main = () => doc.getElementById("main")!;
  return {
    win, doc, calls, availabilityCalls, attachCalls, listeners, stats, $,
    setAuth(next: AuthState) { authState = next; },
    fireAuthEvent() { for (const l of listeners) l(); },
    async settle(ms = 80) { await new Promise((r) => setTimeout(r, ms)); },
    async until(predicate: () => boolean, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        if (predicate()) return;
        if (Date.now() > deadline) throw new Error("page did not reach the expected state: " + (doc.getElementById("app")?.textContent ?? "").slice(0, 200));
      }
    },
    /** Rendered text only: the page's own script source is not content. */
    text: () => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script").forEach((x) => x.remove()); return (c.textContent ?? "").replace(/\s+/g, " "); },
    markup: () => { const c = doc.body.cloneNode(true) as HTMLElement; c.querySelectorAll("script").forEach((x) => x.remove()); return c.innerHTML; },
    main,
    headerButton: () => doc.getElementById("btn-signin") as HTMLButtonElement,
  };
}
type Page = Awaited<ReturnType<typeof loadPage>>;

/** Everything that would invite an application, and every request that would start one. None may exist while the program is not open. */
function expectNothingActionable(page: Page) {
  const app = page.doc.getElementById("app")!;
  // No sign-in-to-apply button, no application / profile / pilot form, no field, no checkbox, no button of any kind inside the app region.
  expect(page.doc.getElementById("signin-to-apply")).toBeNull();
  expect(page.doc.getElementById("host-form")).toBeNull();
  expect(page.doc.getElementById("profile-form")).toBeNull();
  expect(page.doc.getElementById("pilot-form")).toBeNull();
  expect(app.querySelectorAll("button, input, textarea, select, a[href], form").length).toBe(0);
  expect(page.main().querySelectorAll("form, input, textarea, select").length).toBe(0);
  expect(page.text()).not.toMatch(/Sign in with URBANO to apply|Sign in to apply|Apply to host|Submit application|Choose your display name/);
  // The header sign-in control is neither visible nor wired: it cannot open the one-time-code panel.
  expect(page.headerButton().hidden).toBe(true);
  expect(page.attachCalls).toHaveLength(0);
  expect(page.doc.querySelector("[data-urbano-signin-panel]")).toBeNull();
  expect(page.doc.querySelector("[data-email], [data-code], [data-display-name]")).toBeNull();
  expect(page.stats.panelOpens).toBe(0);
  // Nothing about the visitor's session is read and no application request is made.
  expect(page.calls).toEqual([]);
  expect(page.stats.getState).toBe(0);
  expect(page.stats.getAccessToken).toBe(0);
  expect(page.listeners).toHaveLength(0);
}

function expectTruthfulClosedState(page: Page) {
  expect(page.doc.getElementById("closed-title")?.textContent).toBe(CLOSED_HEADING);
  expect(page.text()).toContain(CLOSED_HEADING);
  expect(page.doc.getElementById("app")!.getAttribute("aria-busy")).toBe("false");
  expect(page.doc.getElementById("checking-state")).toBeNull();
  // The program may still be explained.
  expect(page.doc.getElementById("program-info")).toBeTruthy();
  expect((page.doc.getElementById("program-info") as HTMLDetailsElement).open).toBe(true);
  expect(page.text()).toContain("About the pilot program");
  expect(page.text()).toContain("one private, invite-only pilot competition");
  // The sentence that tells a reader what to do to apply is not shown while applications are closed.
  expect(page.doc.getElementById("apply-requirements")!.hidden).toBe(true);
}

function expectOpenJourneyForSignedOut(page: Page) {
  expect(page.doc.getElementById("signin-to-apply")).toBeTruthy();
  expect(page.doc.getElementById("closed-title")).toBeNull();
  expect(page.attachCalls).toHaveLength(1);
  expect(page.headerButton().hidden).toBe(false);
  expect(page.doc.getElementById("apply-requirements")!.hidden).toBe(false);
}

// -----------------------------------------------------------------------------------------------------------------------------
// Closed — through the real route
// -----------------------------------------------------------------------------------------------------------------------------

describe("direct navigation while Become a Host is CLOSED", () => {
  it("flag ABSENT: the program is explained, the page says applications are not open yet, and nothing invites or starts an application", async () => {
    delete process.env[HOST_FLAG];
    const page = await loadPage();
    await page.settle();
    expectTruthfulClosedState(page);
    expectNothingActionable(page);
    expect(page.availabilityCalls).toHaveLength(1);
  });

  it("flag `false`: closed", async () => {
    process.env[HOST_FLAG] = "false";
    const page = await loadPage();
    await page.settle();
    expectTruthfulClosedState(page);
    expectNothingActionable(page);
  });

  it("every MALFORMED flag value, through the real route: closed", async () => {
    for (const value of ["", " ", "TRUE", "True", " true", "true ", "1", "yes", "on", "null"]) {
      process.env[HOST_FLAG] = value;
      const page = await loadPage();
      await page.settle(30);
      expectTruthfulClosedState(page);
      expectNothingActionable(page);
      page.win.close();
    }
  });

  it("closed + a SIGNED-OUT visitor: no sign-in button in the page, and a click on the (hidden) header control cannot open the one-time-code panel", async () => {
    const page = await loadPage({ auth: signedOut });
    await page.settle();
    expectNothingActionable(page);
    page.headerButton().click(); // even a scripted click reaches no handler: it was never attached
    await page.settle(20);
    expect(page.stats.headerClicks).toBe(0);
    expect(page.stats.panelOpens).toBe(0);
    expect(page.doc.querySelector("[data-urbano-signin-panel]")).toBeNull();
  });

  it("closed + an ALREADY-AUTHENTICATED visitor: the page does not read their session, request their status, or show a form or a pilot step", async () => {
    for (const auth of [signedIn, noName]) {
      const page = await loadPage({ auth, respond: () => ({ status: 200, json: { phase: "NOT_APPLIED" } }) });
      await page.settle();
      expectTruthfulClosedState(page);
      expectNothingActionable(page); // calls: [] — no /host/status, no /host/applications, no /host/competition; getState never called
      page.win.close();
    }
  });

  it("closed pages ignore later sign-in events: nothing re-renders, nothing is subscribed", async () => {
    const page = await loadPage({ auth: signedOut });
    await page.settle();
    const before = page.markup();
    page.setAuth(signedIn);
    page.fireAuthEvent();
    await page.settle(40);
    expect(page.markup()).toBe(before);
    expectNothingActionable(page);
  });
});

// -----------------------------------------------------------------------------------------------------------------------------
// Failure and malformed answers fail closed
// -----------------------------------------------------------------------------------------------------------------------------

describe("direct navigation when readiness CANNOT be established", () => {
  it("a readiness-route failure fails closed: network error, 500, 503, 404, 401, 302, 201, 204", async () => {
    const failures: Reply[] = ["reject", { status: 500, json: { available: true } }, { status: 503, json: { available: true } }, { status: 404, json: { available: true } }, { status: 401, json: { available: true } }, { status: 302, json: { available: true } }, { status: 201, json: { available: true } }, { status: 204 }];
    for (const failure of failures) {
      const page = await loadPage({ availability: () => failure });
      await page.settle(30);
      expectTruthfulClosedState(page);
      expectNothingActionable(page);
      page.win.close();
    }
  });

  it("a request that never answers times out, is aborted, and leaves the page closed", async () => {
    let aborted = false;
    const page = await loadPage({ availability: () => "hang", compressTimeout: true });
    (page.availabilityCalls[0].init.signal as AbortSignal).addEventListener("abort", () => { aborted = true; });
    await page.until(() => page.doc.getElementById("closed-title") !== null);
    expect(aborted).toBe(true);
    expectTruthfulClosedState(page);
    expectNothingActionable(page);
  });

  it("a MALFORMED readiness response fails closed — whatever it holds, even when it holds `true`", async () => {
    const malformed: Reply[] = [
      { status: 200, jsonThrows: true }, { status: 200, json: null }, { status: 200, json: [] }, { status: 200, json: [{ available: true }] },
      { status: 200, json: "true" }, { status: 200, json: true }, { status: 200, json: 1 }, { status: 200, json: {} },
      { status: 200, json: { available: "true" } }, { status: 200, json: { available: 1 } }, { status: 200, json: { available: "yes" } },
      { status: 200, json: { available: null } }, { status: 200, json: { available: false } }, { status: 200, json: { Available: true } },
      { status: 200, json: { ready: true } }, { status: 200, json: { available: true, extra: "anything" } },
      { status: 200, json: { available: [true] } }, { status: 200, json: { available: { value: true } } },
    ];
    for (const reply of malformed) {
      const page = await loadPage({ availability: () => reply });
      await page.settle(30);
      expectTruthfulClosedState(page);
      expectNothingActionable(page);
      page.win.close();
    }
  });

  it("a page whose shared reader failed to load fails closed — it never opens on its own, and asks the server nothing", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage({ readerSource: null });
    await page.settle(60);
    expectTruthfulClosedState(page);
    expectNothingActionable(page);
    expect(page.availabilityCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------------------------------------
// Pending — no flash of actionable content
// -----------------------------------------------------------------------------------------------------------------------------

describe("before readiness resolves nothing actionable is ever shown", () => {
  it("while the request is PENDING the page shows a neutral checking state: no button, no form, no panel, no session read", async () => {
    const page = await loadPage({ availability: () => "hang" });
    await page.settle(60);
    expect(page.doc.getElementById("checking-state")?.textContent).toBe("Checking whether applications to host competitions are open…");
    expect(page.doc.getElementById("app")!.getAttribute("aria-busy")).toBe("true");
    expect(page.doc.getElementById("closed-title")).toBeNull(); // not claiming "closed" before it knows
    expect(page.headerButton().style.visibility).toBe("hidden");
    expect(page.attachCalls).toHaveLength(0);
    expect(page.doc.getElementById("app")!.querySelectorAll("button, input, form, a[href]").length).toBe(0);
    expect(page.calls).toEqual([]);
    expect(page.stats.getState).toBe(0);
    expect(page.doc.getElementById("apply-requirements")!.hidden).toBe(true);
  });

  it("the very first paint — synchronously after the scripts run — holds nothing actionable, even for a server that will say yes", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage();
    // No microtask has run: the answer cannot have arrived.
    expect(page.doc.getElementById("signin-to-apply")).toBeNull();
    expect(page.doc.getElementById("host-form")).toBeNull();
    expect(page.doc.getElementById("profile-form")).toBeNull();
    expect(page.doc.getElementById("app")!.querySelectorAll("button, input, form, a[href]").length).toBe(0);
    expect(page.attachCalls).toHaveLength(0);
    expect(page.stats.getState).toBe(0);
    await page.settle();
  });

  it("DELAYED answers: a slow `closed` ends closed, a slow `open` becomes the journey — and nothing actionable existed in between", async () => {
    for (const [answer, finalOpen] of [[{ available: false }, false], [{ available: true }, true]] as const) {
      let release!: (v: { status: number; json: unknown }) => void;
      const slow = new Promise<{ status: number; json: unknown }>((resolve) => { release = resolve; });
      const page = await loadPage({ availability: () => slow });
      await page.settle(80); // the answer is still outstanding
      expect(page.doc.getElementById("app")!.querySelectorAll("button, input, form, a[href]").length).toBe(0);
      expect(page.attachCalls).toHaveLength(0);
      release({ status: 200, json: answer });
      if (finalOpen) await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
      else await page.until(() => page.doc.getElementById("closed-title") !== null);
      if (finalOpen) expectOpenJourneyForSignedOut(page);
      else { expectTruthfulClosedState(page); expectNothingActionable(page); }
      page.win.close();
    }
  });
});

// -----------------------------------------------------------------------------------------------------------------------------
// Open — the existing journey is available only now
// -----------------------------------------------------------------------------------------------------------------------------

describe("direct navigation when Become a Host is OPEN (exact `true`, through the real route)", () => {
  it("a SIGNED-OUT visitor gets the sign-in-to-apply button, and it opens the one-time-code panel", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage({ auth: signedOut });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
    expectOpenJourneyForSignedOut(page);
    expect(page.availabilityCalls).toHaveLength(1);
    expect(page.text()).not.toContain(CLOSED_HEADING);
    expect(page.text()).toMatch(/To apply you need to sign in with URBANO/);
    (page.doc.getElementById("signin-to-apply") as HTMLButtonElement).click();
    await page.settle(20);
    expect(page.stats.panelOpens).toBe(1);
    expect((page.doc.querySelector("[data-urbano-signin-panel]") as HTMLElement).style.display).toBe("block");
  });

  it("an ALREADY-AUTHENTICATED visitor gets their real status and the application form (the existing journey)", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage({ auth: signedIn, respond: (call) => (call.url === "/api/gaming/host/status" ? { status: 200, json: { phase: "NOT_APPLIED" } } : { status: 404, json: {} }) });
    await page.until(() => page.doc.getElementById("host-form") !== null);
    expect(page.calls.map((c) => c.url)).toEqual(["/api/gaming/host/status"]);
    expect(page.attachCalls).toHaveLength(1);
    expect(page.listeners).toHaveLength(1);
    expect(page.doc.getElementById("closed-title")).toBeNull();
  });

  it("a visitor with no display name yet gets the display-name step", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage({ auth: noName });
    await page.until(() => page.doc.getElementById("profile-form") !== null);
    expect(page.doc.getElementById("signin-to-apply")).toBeNull();
    expect(page.calls).toEqual([]);
  });

  it("a later sign-in event re-renders an OPEN page, as before", async () => {
    process.env[HOST_FLAG] = "true";
    const page = await loadPage({ auth: signedOut, respond: () => ({ status: 200, json: { phase: "NOT_APPLIED" } }) });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
    page.setAuth(signedIn);
    page.fireAuthEvent();
    await page.until(() => page.doc.getElementById("host-form") !== null);
  });
});

// -----------------------------------------------------------------------------------------------------------------------------
// Disclosure
// -----------------------------------------------------------------------------------------------------------------------------

describe("what the browser can see", () => {
  it("no environment value, variable name or internal identifier appears in the closed or the open page, or in the one readiness request", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-value-that-must-never-appear";
    for (const flag of [undefined, "false", "true"]) {
      if (flag === undefined) delete process.env[HOST_FLAG];
      else process.env[HOST_FLAG] = flag;
      const page = await loadPage({ auth: signedOut });
      await page.settle();
      const rendered = `${page.markup()}\n${page.text()}`;
      expect(rendered).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|SUPABASE|service-role|127\.0\.0\.1/i);
      expect(rendered).not.toMatch(UUID_PATTERN);
      expect(rendered).not.toContain(TOKEN_VALUE);
      expect(page.availabilityCalls).toHaveLength(1);
      const [call] = page.availabilityCalls;
      expect(call.init.method).toBe("GET");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.cache).toBe("no-store");
      expect(call.init.body).toBeUndefined();
      expect(JSON.stringify(call.init.headers ?? {})).not.toMatch(/authorization|bearer|apikey/i);
      page.win.close();
    }
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(PAGE_HTML).not.toMatch(/BECOME_A_HOST|SCHEMA_READY|process\.env/);
  });

  it("the page holds no readiness logic of its own: it asks the shared reader, and the only place that names the endpoint is that reader", () => {
    expect(PAGE_HTML).toContain('<script src="/hostAvailability.js"></script>');
    expect(PAGE_HTML).not.toContain(AVAILABILITY_URL);
    expect(PAGE_HTML).not.toMatch(/body\.available|Object\.keys\(body\)|\.available\s*===/);
    const script = PAGE_HTML.slice(PAGE_HTML.indexOf("(async function start()"), PAGE_HTML.indexOf("</script>", PAGE_HTML.indexOf("(async function start()")));
    expect(script).toMatch(/window\.HostAvailability/);
    expect(script).toMatch(/if \(open === true\) startJourney\(\);\s*else showClosed\(\);/);
    expect(script).not.toMatch(/localStorage|sessionStorage|location\.(search|hash|href)|URLSearchParams|document\.cookie|NEXT_PUBLIC/);
    // Nothing runs before the answer: the header control is attached, the sign-in events are subscribed and the first render happens
    // only inside startJourney(), which start() calls only for an exact `open`.
    expect((PAGE_HTML.match(/UrbanoAuth\.attachSignInButton\(/g) ?? []).length).toBe(1);
    expect((PAGE_HTML.match(/UrbanoAuth\.onAuthStateChange\(/g) ?? []).length).toBe(1);
    expect(PAGE_HTML).not.toMatch(/^renderApp\(true\);/m); // no unconditional first render at the top level
    const startJourneyBody = PAGE_HTML.slice(PAGE_HTML.indexOf("function startJourney()"), PAGE_HTML.indexOf("(async function start()"));
    expect(startJourneyBody).toContain("UrbanoAuth.attachSignInButton(");
    expect(startJourneyBody).toContain("UrbanoAuth.onAuthStateChange(");
    expect(startJourneyBody).toContain("renderApp(true);");
  });
});

// -----------------------------------------------------------------------------------------------------------------------------
// Negative controls — each protection removed from a COPY of the shipped page / reader
// -----------------------------------------------------------------------------------------------------------------------------

describe("negative controls — removing any protection makes the closed page invite an application", () => {
  function mutatedPage(from: string, to: string): string {
    expect(PAGE_HTML.split(from).length - 1, `page mutation anchor must exist exactly once: ${from.slice(0, 60)}`).toBe(1);
    const html = PAGE_HTML.replace(from, to);
    expect(html).not.toBe(PAGE_HTML);
    return html;
  }
  function mutatedReader(from: string, to: string): string {
    expect(READER_SOURCE.split(from).length - 1, `reader mutation anchor must exist exactly once: ${from.slice(0, 60)}`).toBe(1);
    const source = READER_SOURCE.replace(from, to);
    expect(source).not.toBe(READER_SOURCE);
    return source;
  }
  const closedAnswer = () => ({ status: 200, json: { available: false } });

  it("control 1 — the header sign-in control attached at load (the previous order): a CLOSED page can still open the one-time-code panel", async () => {
    const html = mutatedPage('const signInButton = document.getElementById("btn-signin");', 'const signInButton = document.getElementById("btn-signin");\nUrbanoAuth.attachSignInButton(signInButton, document.getElementById("signin-status"));');
    const page = await loadPage({ html, availability: closedAnswer });
    await page.settle();
    expect(page.attachCalls.length).toBeGreaterThan(0);
    page.headerButton().hidden = false;
    page.headerButton().click();
    expect(page.stats.panelOpens).toBe(1); // the OTP panel a closed page must never open
  });

  it("control 2 — the server's answer ignored: a CLOSED server still gets the sign-in-to-apply journey", async () => {
    const html = mutatedPage("if (open === true) startJourney();\n  else showClosed();", "startJourney();");
    const page = await loadPage({ html, availability: closedAnswer });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
  });

  it("control 3 — the journey started before the answer (a flash): an actionable button exists while the request is still pending", async () => {
    const html = mutatedPage("(async function start() {", "renderApp(true);\n(async function start() {");
    const page = await loadPage({ html, availability: () => "hang" });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
  });

  it("control 4 — the reader loosened to `truthy`: a malformed { available: \"true\" } opens the application page", async () => {
    const readerSource = mutatedReader('return keys.length === 1 && keys[0] === "available" && body.available === true;', "return !!body.available;");
    const page = await loadPage({ readerSource, availability: () => ({ status: 200, json: { available: "true" } }) });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
  });

  it("control 5 — a missing reader treated as open: the page whose reader failed to load opens the journey", async () => {
    const html = mutatedPage("(await reader.resolve()) === true : false;", "(await reader.resolve()) === true : true;");
    const page = await loadPage({ html, readerSource: null, availability: closedAnswer });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
  });

  it("control 6 — failure treated as open (reader): a network error opens the application page", async () => {
    const readerSource = mutatedReader("} catch (_) {\n      return false;", "} catch (_) {\n      return true;");
    const page = await loadPage({ readerSource, availability: () => "reject" });
    await page.until(() => page.doc.getElementById("signin-to-apply") !== null);
  });

  it("control 7 — an authenticated visitor on a closed page, with the answer ignored, hits the application API: the closed page is what keeps /host/status unasked", async () => {
    const html = mutatedPage("if (open === true) startJourney();\n  else showClosed();", "startJourney();");
    const page = await loadPage({ html, auth: signedIn, availability: closedAnswer, respond: () => ({ status: 200, json: { phase: "NOT_APPLIED" } }) });
    await page.until(() => page.calls.length > 0);
    expect(page.calls[0].url).toBe("/api/gaming/host/status");
  });

  it("the controls changed only their own copies: the shipped page, closed, still invites nothing", async () => {
    const page = await loadPage({ availability: closedAnswer });
    await page.settle();
    expectTruthfulClosedState(page);
    expectNothingActionable(page);
  });
});
