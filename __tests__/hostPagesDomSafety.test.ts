import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-088 — proves, against the ACTUAL shipped pages (parsed and run
 * whole in jsdom, not reimplemented), that:
 *   - hostile applicant / reviewer / competition text renders as literal text and
 *     can never inject a live element or an event handler (test 21);
 *   - no raw identifier, token, email or application text reaches the markup, the
 *     URL or browser storage (test 22);
 *   - every phase the applicant can be in is shown truthfully and distinctly;
 *   - signed-out visitors can read the program but nothing is fetched or submitted
 *     (test 1), and an outage or refusal is never mistaken for "no application".
 * Real layout at 320 / 375 / 768 / 1280 px is verified in a real browser by the
 * report's responsive checks; the CSS rules those depend on are asserted here.
 */

const BECOME_HTML = readFileSync(path.join(process.cwd(), "public/become-a-host.html"), "utf8");
const REVIEW_HTML = readFileSync(path.join(process.cwd(), "public/host-applications-admin.html"), "utf8");
// The shared server-authoritative readiness reader (UG-CR-GATE-091). jsdom does not load external scripts, so the REAL shipped file is
// evaluated into each page's window; the application page cannot start its journey without it.
const HOST_AVAILABILITY_SOURCE = readFileSync(path.join(process.cwd(), "public/hostAvailability.js"), "utf8");
const AVAILABILITY_URL = "/api/gaming/host/availability";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TOKEN_VALUE = "stub-access-token-value-12345";
const CODE = "AbCdEfGhIjKlMnOpQrStUv"; // a well-formed 22-character opaque application code

const HOSTILE_PAYLOADS: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: '<img src=x onerror="window.__xss=(window.__xss||0)+1">' },
  { label: "attribute-breakout script", value: '"><script>window.__xss=(window.__xss||0)+1</script>' },
  { label: "svg onload", value: '<svg onload="window.__xss=(window.__xss||0)+1">' },
  { label: "benign tag", value: "<b>bold</b>" },
  { label: "bare attribute-breakout", value: '" onmouseover="window.__xss=(window.__xss||0)+1" autofocus="' },
  { label: "javascript url", value: "javascript:window.__xss=(window.__xss||0)+1" },
];

type AuthState =
  | { status: "unauthenticated" }
  | { status: "profile_incomplete"; email: string }
  | { status: "authenticated"; email: string; gamingMemberId: string; displayName: string };

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type Responder = (call: FetchCall) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>;

function authenticated(displayName = "Alex Applicant"): AuthState {
  return { status: "authenticated", email: "alex@example.com", gamingMemberId: "11111111-2222-3333-4444-555555555555", displayName };
}

async function loadPage(html: string, opts: { auth: AuthState; respond?: Responder; completeProfile?: (name: string) => Promise<unknown> }) {
  const calls: FetchCall[] = [];
  const respond: Responder = opts.respond ?? (() => ({ status: 404, json: { error: "unexpected" } }));
  let authState: AuthState = opts.auth;
  const listeners: Array<() => void> = [];
  const signInClicks = { count: 0 };
  const dom = new JSDOM(html, {
    url: "http://localhost/page.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = {
        // A faithful emulation of urbanoAuth.js's panel: the header button TOGGLES it, and a click anywhere outside the panel
        // and outside that button closes it (the real library's document-level handler). A trigger that does not stop its click
        // from reaching the document would therefore open and shut the panel in one gesture — a bug jsdom only catches if the
        // stub behaves like this.
        attachSignInButton: (btn: HTMLElement) => {
          const doc = btn.ownerDocument;
          const panel = doc.createElement("div");
          panel.style.display = "none";
          panel.innerHTML = '<input data-email type="email" />';
          btn.insertAdjacentElement("afterend", panel);
          let open = false;
          btn.addEventListener("click", () => {
            signInClicks.count += 1;
            open = !open;
            panel.style.display = open ? "block" : "none";
          });
          doc.addEventListener("click", (e) => {
            if (open && !panel.contains(e.target as Node) && e.target !== btn) {
              open = false;
              panel.style.display = "none";
            }
          });
        },
        getState: async () => authState,
        getAccessToken: async () => TOKEN_VALUE,
        onAuthStateChange: async (cb: () => void) => { listeners.push(cb); return () => {}; },
        completeProfile: opts.completeProfile ?? (async (name: string) => {
          authState = authenticated(name);
          return authState;
        }),
      };
      w.fetch = async (url: string, init: any = {}) => {
        // The page-level tests below are about an OPEN program, so readiness is answered "open" here and kept out of `calls`
        // (those assert exactly which APPLICATION requests the page makes). Readiness itself — closed, failing, malformed,
        // delayed — is tested in hostDirectPageReadiness.test.ts.
        if (String(url) === AVAILABILITY_URL) return { status: 200, json: async () => ({ available: true }) };
        const call: FetchCall = {
          url: String(url),
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(init.body) : undefined,
          headers: init.headers ?? {},
        };
        calls.push(call);
        const out = await respond(call);
        return { status: out.status, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; } };
      };
      window.eval(HOST_AVAILABILITY_SOURCE); // the real shared reader, exactly as /hostAvailability.js would define it
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const api = {
    win, doc, calls, signInClicks,
    setAuth(next: AuthState) { authState = next; },
    /** Fires the page's onAuthStateChange subscribers, as a token refresh or a second session event would. */
    fireAuthEvent() { for (const l of listeners) l(); },
    async settle(predicate?: () => boolean, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      // Let queued microtasks and zero-delay timers run until the page is idle.
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        const busy = doc.getElementById("app")?.getAttribute("aria-busy") === "true";
        if (predicate ? predicate() : !busy) { await new Promise((r) => setTimeout(r, 0)); return; }
        if (Date.now() > deadline) throw new Error("page did not settle: " + (doc.getElementById("app")?.textContent ?? "").slice(0, 200));
      }
    },
    /** Rendered text only: the page's own script source is not content. */
    text: () => doc.getElementById("main")?.textContent ?? "",
    /** Rendered markup only (scripts removed), for leak scans. */
    markup: () => {
      const clone = doc.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script").forEach((s) => s.remove());
      return clone.innerHTML;
    },
    button(label: string): HTMLButtonElement {
      const b = Array.from(doc.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === label);
      if (!b) throw new Error(`no button "${label}" in: ${(doc.getElementById("app")?.textContent ?? "").slice(0, 300)}`);
      return b as HTMLButtonElement;
    },
    submit(form: Element) {
      form.dispatchEvent(new (win as any).Event("submit", { bubbles: true, cancelable: true }));
    },
    close() { win.close(); },
  };
  return api;
}

/** The scripts each shipped page authors, by source (null = inline). Nothing may add another. */
const APPLICATION_PAGE_SCRIPTS = ["/urbanoAuth.js", "/hostAvailability.js", null]; // sign-in module, shared readiness reader, the page's own script
const REVIEW_PAGE_SCRIPTS = ["/urbanoAuth.js", null];

function assertNoLiveInjection(doc: Document, authoredScripts: Array<string | null> = APPLICATION_PAGE_SCRIPTS) {
  expect(doc.querySelectorAll("script"), "an injected <script>").toHaveLength(authoredScripts.length);
  expect(Array.from(doc.querySelectorAll("script")).map((x) => x.getAttribute("src"))).toEqual(authoredScripts);
  const main = doc.getElementById("main")!;
  const all = [main, ...Array.from(main.querySelectorAll("*"))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes || [])) {
      expect(attr.name.toLowerCase().startsWith("on"), `${el.tagName} carries ${attr.name}`).toBe(false);
    }
  }
  // Only the markup this page authored may exist in the dynamic region: no injected img/svg/iframe/object/embed/link/style.
  for (const tag of ["img", "svg", "iframe", "object", "embed", "link", "meta", "style", "script", "form input[type=hidden]"]) {
    expect(doc.querySelectorAll(`#app ${tag}`), `unexpected <${tag}> inside the dynamic region`).toHaveLength(0);
  }
  // No link in the dynamic region may point anywhere but a site-relative page this page chose.
  for (const a of Array.from(doc.querySelectorAll("#app a"))) {
    expect(a.getAttribute("href")).toBe("/competitions-admin.html");
  }
}

const APPLICATION = {
  publicCode: CODE,
  state: "PENDING",
  venueName: "Riverside Five-a-Side",
  cityArea: "Riverside District",
  playingFields: 3,
  venueDescription: "We run two small leagues at our venue each season.",
  expectedWindow: "weekend of 14 November",
  expectedTeamCount: 6,
  submittedAt: "2026-10-07T12:00:00.000Z",
  decidedAt: null,
  withdrawnAt: null,
  capabilityState: null,
  competitionName: null,
  competitionPublicCode: null,
  competitionState: null,
};

function statusResponse(phase: string, application: Record<string, unknown> | null) {
  return { status: 200, json: { phase, application } };
}

const VALID_FORM_VALUES: Record<string, string> = {
  venueName: "Riverside Five-a-Side",
  cityArea: "Riverside District",
  playingFields: "3",
  venueDescription: "We run two small leagues at our venue each season and host a charity cup.",
  expectedWindow: "weekend of 14 November",
  expectedTeamCount: "6",
};

function fillForm(doc: Document, overrides: Record<string, string> = {}, confirm = true) {
  const values = { ...VALID_FORM_VALUES, ...overrides };
  for (const [key, value] of Object.entries(values)) {
    (doc.getElementById("f-" + key) as HTMLInputElement | HTMLTextAreaElement).value = value;
  }
  for (const key of ["confirmAllAdults", "confirmIndependentScorekeepers", "confirmPilotExclusions"]) {
    (doc.getElementById("c-" + key) as HTMLInputElement).checked = confirm;
  }
}

describe("become-a-host.html — the program information (test 1: anyone can read it)", () => {
  it("states every required fact in the static markup, before any script runs", () => {
    const dom = new JSDOM(BECOME_HTML);
    const info = dom.window.document.getElementById("program-info")!.textContent!.replace(/\s+/g, " ");
    expect(info).toMatch(/by application, not automatic/i);
    expect(info).toMatch(/one private, invite-only pilot competition/i);
    expect(info).toMatch(/Known adults only/i);
    expect(info).toMatch(/Four teams with at least four players each/i);
    expect(info).toMatch(/Two semifinals and one final/i);
    expect(info).toMatch(/Independent scorekeepers/i);
    expect(info).toMatch(/invitation links yourself, by hand/i);
    for (const excluded of ["entry fees", "prizes", "sponsorships", "minors", "public statistics", "automated invitations", "open registration"]) {
      expect(info).toContain(excluded);
    }
    expect(info).toMatch(/discretion and may be revoked/i);
    expect(info).toMatch(/not make you an URBANO employee, partner, or certified organizer/i);
    expect(info).toMatch(/not a permanent affiliation/i);
    expect(info).toMatch(/sign in with URBANO and have a display name/i);
    dom.window.close();
  });

  it("a signed-out visitor sees the program and a sign-in prompt, and NOTHING is fetched", async () => {
    const page = await loadPage(BECOME_HTML, { auth: { status: "unauthenticated" } });
    await page.settle();
    expect(page.text()).toMatch(/Sign in to apply/);
    expect(page.doc.getElementById("host-form")).toBeNull();
    expect(page.calls).toEqual([]);
    expect(page.doc.getElementById("program-info")!.hasAttribute("open")).toBe(true);
    page.button("Sign in with URBANO to apply").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(page.signInClicks.count).toBe(1);
    // The panel stays OPEN (the trigger's own click must not reach the library's outside-click closer) and takes focus.
    const panel = page.doc.getElementById("btn-signin")!.nextElementSibling as HTMLElement;
    expect(panel.style.display).toBe("block");
    expect(page.doc.activeElement?.hasAttribute("data-email")).toBe(true);
    // Pressing the page's button again does not toggle the panel shut: it only opens and focuses.
    page.button("Sign in with URBANO to apply").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(panel.style.display).toBe("block");
    expect(page.signInClicks.count).toBe(1);
    page.close();
  });

  it("a signed-in member who has no display name yet gets the page's own display-name step, then the form", async () => {
    const page = await loadPage(BECOME_HTML, {
      auth: { status: "profile_incomplete", email: "new@example.com" },
      respond: (call) => (call.url.endsWith("/status") ? statusResponse("NOT_APPLIED", null) : { status: 404 }),
    });
    await page.settle();
    expect(page.text()).toMatch(/Choose your display name/);
    expect(page.calls).toEqual([]);
    (page.doc.getElementById("display-name") as HTMLInputElement).value = "New Person";
    page.submit(page.doc.getElementById("profile-form")!);
    await page.settle(() => !!page.doc.getElementById("host-form"));
    expect(page.doc.getElementById("host-form")).not.toBeNull();
    expect(page.text()).toMatch(/Applying as New Person/);
    page.close();
  });

  it("an empty display name is refused with an associated error and no call", async () => {
    const completeProfile = vi.fn();
    const page = await loadPage(BECOME_HTML, { auth: { status: "profile_incomplete", email: "new@example.com" }, completeProfile });
    await page.settle();
    (page.doc.getElementById("display-name") as HTMLInputElement).value = "   ";
    page.submit(page.doc.getElementById("profile-form")!);
    await page.settle(() => true);
    expect(completeProfile).not.toHaveBeenCalled();
    const input = page.doc.getElementById("display-name")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(page.doc.getElementById("err-display-name")!.hidden).toBe(false);
    expect(input.getAttribute("aria-describedby")).toContain("err-display-name");
    page.close();
  });
});

describe("become-a-host.html — the application form (tests 2, 3)", () => {
  async function formPage(extra?: Responder) {
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/api/gaming/host/status")) return statusResponse("NOT_APPLIED", null);
        return extra ? extra(call) : { status: 500 };
      },
    });
    await page.settle();
    return page;
  }

  it("collects only the specified fields, each with a visible label, a hint, and an error slot wired by aria-describedby", async () => {
    const page = await formPage();
    const form = page.doc.getElementById("host-form")!;
    const controls = Array.from(form.querySelectorAll("input, textarea")) as Array<HTMLInputElement | HTMLTextAreaElement>;
    expect(controls.map((c) => c.name).sort()).toEqual(
      ["cityArea", "confirmAllAdults", "confirmIndependentScorekeepers", "confirmPilotExclusions", "expectedTeamCount", "expectedWindow", "playingFields", "venueDescription", "venueName"].sort()
    );
    for (const control of controls) {
      const label = form.querySelector(`label[for="${control.id}"]`);
      expect(label, `label for ${control.name}`).not.toBeNull();
      expect((label!.textContent ?? "").trim().length).toBeGreaterThan(5);
      if (control.type !== "checkbox") {
        const described = (control.getAttribute("aria-describedby") ?? "").split(" ");
        expect(described).toEqual(expect.arrayContaining([`hint-${control.name}`, `err-${control.name}`]));
        for (const id of described) expect(page.doc.getElementById(id), id).not.toBeNull();
      }
    }
    // Nothing that is not needed to evaluate a pilot.
    expect(form.querySelector('input[type="email"], input[type="tel"], input[type="file"], input[type="password"], input[type="date"]')).toBeNull();
    expect(form.textContent).not.toMatch(/phone|passport|bank|card number|social security|date of birth|roster|medical/i);
    expect(page.text()).toMatch(/Applying as Alex Applicant/);
    page.close();
  });

  it("submitting an empty form shows an error for every problem, moves focus to the first one, and sends nothing", async () => {
    const page = await formPage();
    const form = page.doc.getElementById("host-form")!;
    page.submit(form);
    await page.settle(() => true);
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    const summary = page.doc.getElementById("form-error")!;
    expect(summary.hidden).toBe(false);
    expect(summary.getAttribute("role")).toBe("alert");
    for (const key of ["venueName", "cityArea", "playingFields", "venueDescription", "expectedWindow", "expectedTeamCount"]) {
      expect(page.doc.getElementById("err-" + key)!.hidden, key).toBe(false);
      expect(page.doc.getElementById("f-" + key)!.getAttribute("aria-invalid"), key).toBe("true");
    }
    expect(page.doc.getElementById("err-confirmations")!.hidden).toBe(false);
    expect(page.doc.activeElement?.id).toBe("f-venueName");
    page.close();
  });

  it("each rule is enforced client-side at its boundary (the server and database check again)", async () => {
    const page = await formPage();
    const form = page.doc.getElementById("host-form")!;
    const invalid: Array<[string, string]> = [
      ["venueName", "a"], ["cityArea", "a"], ["playingFields", "0"], ["playingFields", "51"], ["playingFields", "2.5"],
      ["venueDescription", "x".repeat(19)], ["venueDescription", "x".repeat(801)], ["expectedWindow", "ab"], ["expectedTeamCount", "3"], ["expectedTeamCount", "17"],
    ];
    for (const [key, value] of invalid) {
      fillForm(page.doc, { [key]: value });
      page.submit(form);
      await page.settle(() => true);
      expect(page.doc.getElementById("err-" + key)!.hidden, `${key}=${value.slice(0, 5)}`).toBe(false);
    }
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    page.close();
  });

  it("all three confirmations are required", async () => {
    const page = await formPage();
    fillForm(page.doc, {}, false);
    (page.doc.getElementById("c-confirmAllAdults") as HTMLInputElement).checked = true;
    (page.doc.getElementById("c-confirmIndependentScorekeepers") as HTMLInputElement).checked = true;
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => true);
    expect(page.doc.getElementById("err-confirmations")!.hidden).toBe(false);
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    page.close();
  });

  it("a valid submission POSTs exactly the nine collected fields — no identity, no state, no email — then shows the pending state", async () => {
    let submitted = false;
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/api/gaming/host/status")) return submitted ? statusResponse("UNDER_REVIEW", APPLICATION) : statusResponse("NOT_APPLIED", null);
        if (call.url.endsWith("/api/gaming/host/applications") && call.method === "POST") { submitted = true; return { status: 201, json: { application: { publicCode: CODE, state: "PENDING", submittedAt: "x" } } }; }
        return { status: 500 };
      },
    });
    await page.settle();
    fillForm(page.doc, { venueName: "  Riverside Five-a-Side  " });
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => /Application under review/.test(page.text()));
    const post = page.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/gaming/host/applications");
    expect(Object.keys(post.body as object).sort()).toEqual(
      ["cityArea", "confirmAllAdults", "confirmIndependentScorekeepers", "confirmPilotExclusions", "expectedTeamCount", "expectedWindow", "playingFields", "venueDescription", "venueName"].sort()
    );
    expect(post.body).toMatchObject({ venueName: "Riverside Five-a-Side", playingFields: 3, expectedTeamCount: 6, confirmAllAdults: true });
    expect(typeof (post.body as any).playingFields).toBe("number");
    expect(JSON.stringify(post.body)).not.toMatch(/alex@example|11111111-2222|stub-access/);
    page.close();
  });

  it("a double click cannot send two submissions", async () => {
    let posts = 0;
    const page = await formPage((call) => {
      if (call.method === "POST") { posts += 1; return { status: 201, json: {} }; }
      return statusResponse("NOT_APPLIED", null);
    });
    fillForm(page.doc);
    const form = page.doc.getElementById("host-form")!;
    page.submit(form);
    page.submit(form);
    page.submit(form);
    await page.settle(() => true);
    expect(posts).toBe(1);
    page.close();
  });

  it("a server 400 naming a field attaches the message to that field and focuses it; a 409 shows the truthful current state", async () => {
    let conflict = false;
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/status")) return conflict ? statusResponse("UNDER_REVIEW", APPLICATION) : statusResponse("NOT_APPLIED", null);
        if (conflict) return { status: 409, json: { error: "You already have a host application that is under review or approved." } };
        conflict = false;
        return { status: 400, json: { error: "The host application is not valid: venueName.", field: "venueName" } };
      },
    });
    await page.settle();
    fillForm(page.doc);
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => !page.doc.getElementById("submit-btn")?.hasAttribute("disabled") && !page.doc.getElementById("err-venueName")!.hidden);
    expect(page.doc.getElementById("err-venueName")!.hidden).toBe(false);
    expect(page.doc.activeElement?.id).toBe("f-venueName");
    expect(page.text()).not.toMatch(/The host application is not valid: venueName/);

    conflict = true;
    fillForm(page.doc);
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => /Application under review/.test(page.text()));
    expect(page.text()).toMatch(/Application under review/);
    page.close();
  });

  it("an outage or refusal is never shown as an empty form: 503, 401, 500 and a dropped connection each get a truthful message", async () => {
    for (const [res, expected] of [
      [{ status: 503, json: { error: "Become a Host is not open yet." } }, /Become a Host is not open yet/],
      [{ status: 401, json: { error: "A valid Authorization header for an authenticated Gaming Member is required." } }, /Please sign in again/],
      [{ status: 500, json: { error: "Failed" } }, /could not load your host application/],
    ] as const) {
      const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => res });
      await page.settle();
      expect(page.text()).toMatch(expected);
      expect(page.doc.getElementById("host-form")).toBeNull();
      expect(page.text()).not.toMatch(/Authorization header/);
      page.close();
    }
    const dropped = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => { throw new Error("network down"); } });
    await dropped.settle();
    expect(dropped.text()).toMatch(/could not reach URBANO/i);
    expect(dropped.doc.getElementById("host-form")).toBeNull();
    dropped.close();
  });
});

describe("become-a-host.html — every phase is shown distinctly and truthfully", () => {
  const PHASES: Array<{ phase: string; application: Record<string, unknown>; heading: RegExp; pill: string; extra?: (page: Awaited<ReturnType<typeof loadPage>>) => void }> = [
    { phase: "UNDER_REVIEW", application: { ...APPLICATION }, heading: /Application under review/, pill: "Under review" },
    { phase: "APPROVED_READY", application: { ...APPLICATION, state: "APPROVED", capabilityState: "AVAILABLE", decidedAt: "2026-10-08T09:00:00Z" }, heading: /Your host application was approved/, pill: "Approved" },
    {
      phase: "PILOT_CREATED",
      application: { ...APPLICATION, state: "APPROVED", capabilityState: "CONSUMED", competitionName: "Riverside Pilot Cup", competitionState: "DRAFT" },
      heading: /Your approved pilot has already been created/, pill: "Pilot created",
    },
    { phase: "NOT_APPROVED", application: { ...APPLICATION, state: "REJECTED" }, heading: /Your application was not approved/, pill: "Not approved" },
    { phase: "WITHDRAWN", application: { ...APPLICATION, state: "WITHDRAWN" }, heading: /You withdrew your application/, pill: "Withdrawn" },
    {
      phase: "ACCESS_REVOKED",
      application: { ...APPLICATION, state: "APPROVED", capabilityState: "REVOKED", competitionName: "Riverside Pilot Cup" },
      heading: /Your hosting access has been revoked/, pill: "Access revoked",
    },
  ];

  for (const { phase, application, heading, pill } of PHASES) {
    it(`${phase}: the heading, a text status pill (never colour alone), and nothing from another phase`, async () => {
      const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse(phase, application) });
      await page.settle();
      const h = page.doc.getElementById("status-title")!;
      expect(h.textContent).toMatch(heading);
      expect(page.doc.querySelector(".status-pill")!.textContent).toBe(pill);
      expect(h.getAttribute("tabindex")).toBe("-1");
      expect(page.doc.activeElement).toBe(h);
      const others = PHASES.filter((p) => p.phase !== phase).map((p) => p.heading);
      for (const other of others) expect(page.doc.getElementById("app")!.textContent).not.toMatch(other);
      // The applicant never sees authority-system terminology.
      expect(page.doc.getElementById("app")!.textContent).not.toMatch(/PRODUCT_GOVERNANCE|OPERATIONAL|CONSEQUENTIAL_FINALIZER|capability|authority class/i);
      page.close();
    });
  }

  it("the approved state clearly says approval is not employment, partnership, certification or permanent, and may be revoked", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("APPROVED_READY", PHASES[1].application) });
    await page.settle();
    const text = page.doc.getElementById("app")!.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/does not make you an URBANO employee, partner, or certified organizer/);
    expect(text).toMatch(/URBANO may revoke it/);
    expect(text).toMatch(/cannot be replaced/);
    page.close();
  });

  it("a rejected applicant never sees an internal reason, even if the server sent one by mistake", async () => {
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: () => statusResponse("NOT_APPROVED", { ...APPLICATION, state: "REJECTED", decisionReason: "INTERNAL-ONLY venue too small", decidedByDisplayName: "Riley Reviewer" }),
    });
    await page.settle();
    expect(page.markup()).not.toMatch(/INTERNAL-ONLY|Riley Reviewer/);
    page.close();
  });

  it("after a rejection or withdrawal the member can open a fresh form; the old pending state does not return", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("NOT_APPROVED", { ...APPLICATION, state: "REJECTED" }) });
    await page.settle();
    page.button("Submit a new application").click();
    await page.settle(() => !!page.doc.getElementById("host-form"));
    expect(page.doc.getElementById("host-form")).not.toBeNull();
    page.close();
  });

  it("an approved-then-revoked host is offered no way to apply again or create anything", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("ACCESS_REVOKED", PHASES[5].application) });
    await page.settle();
    expect(page.doc.getElementById("host-form")).toBeNull();
    expect(page.doc.getElementById("pilot-form")).toBeNull();
    expect(page.doc.querySelector("#app a")).toBeNull();
    page.close();
  });

  it("withdrawing: a two-step confirmation, Escape cancels and restores focus, confirming POSTs to the encoded code only", async () => {
    let withdrawn = false;
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/status")) return withdrawn ? statusResponse("WITHDRAWN", { ...APPLICATION, state: "WITHDRAWN" }) : statusResponse("UNDER_REVIEW", APPLICATION);
        if (call.url.endsWith("/withdraw")) { withdrawn = true; return { status: 200, json: { application: { state: "WITHDRAWN" } } }; }
        return { status: 500 };
      },
    });
    await page.settle();
    const withdraw = page.button("Withdraw application");
    withdraw.click();
    expect(page.doc.querySelector(".confirm-panel")).not.toBeNull();
    expect(page.doc.activeElement?.textContent).toBe("Yes, withdraw");
    page.doc.querySelector(".confirm-panel")!.dispatchEvent(new (page.win as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.doc.querySelector(".confirm-panel")).toBeNull();
    expect(page.doc.activeElement).toBe(withdraw);
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);

    withdraw.click();
    const confirm = page.button("Yes, withdraw");
    confirm.click();
    confirm.click();
    await page.settle(() => /You withdrew your application/.test(page.text()));
    const posts = page.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/api/gaming/host/applications/${CODE}/withdraw`);
    page.close();
  });

  it("creating the pilot: validates the name, POSTs only the name, then shows the created state", async () => {
    let created = false;
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/status")) return created ? statusResponse("PILOT_CREATED", PHASES[2].application) : statusResponse("APPROVED_READY", PHASES[1].application);
        if (call.url.endsWith("/api/gaming/host/competition")) { created = true; return { status: 201, json: { competition: {} } }; }
        return { status: 500 };
      },
    });
    await page.settle();
    const form = page.doc.getElementById("pilot-form")!;
    (page.doc.getElementById("pilot-name") as HTMLInputElement).value = "ab";
    page.submit(form);
    await page.settle(() => true);
    expect(page.doc.getElementById("err-pilot-name")!.hidden).toBe(false);
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);

    (page.doc.getElementById("pilot-name") as HTMLInputElement).value = "  Riverside Pilot Cup  ";
    page.submit(form);
    page.submit(form);
    await page.settle(() => /already been created/.test(page.text()));
    const posts = page.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ name: "Riverside Pilot Cup" });
    const link = page.doc.querySelector("#app a")!;
    expect(link.getAttribute("href")).toBe("/competitions-admin.html");
    page.close();
  });

  it("a 409/403 on creating (already created, or access changed) refreshes to the truthful state instead of an error", async () => {
    let state = "APPROVED_READY";
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/status")) return state === "APPROVED_READY" ? statusResponse(state, PHASES[1].application) : statusResponse("PILOT_CREATED", PHASES[2].application);
        state = "PILOT_CREATED";
        return { status: 409, json: { error: "Your approved pilot has already been created." } };
      },
    });
    await page.settle();
    (page.doc.getElementById("pilot-name") as HTMLInputElement).value = "Riverside Pilot Cup";
    page.submit(page.doc.getElementById("pilot-form")!);
    await page.settle(() => /already been created/.test(page.text()));
    expect(page.doc.getElementById("status-title")!.textContent).toMatch(/already been created/);
    page.close();
  });
});

describe("become-a-host.html — hostile text renders literally (test 21)", () => {
  for (const { label, value } of HOSTILE_PAYLOADS) {
    it(`a hostile ${label} in the display name, the application and the competition name is plain text`, async () => {
      const hostile = { ...APPLICATION, venueName: value, cityArea: value, venueDescription: value, expectedWindow: value, competitionName: value };
      for (const phase of ["UNDER_REVIEW", "PILOT_CREATED", "ACCESS_REVOKED"]) {
        const application = phase === "UNDER_REVIEW" ? hostile : { ...hostile, state: "APPROVED", capabilityState: phase === "PILOT_CREATED" ? "CONSUMED" : "REVOKED" };
        const page = await loadPage(BECOME_HTML, { auth: authenticated(value), respond: () => statusResponse(phase, application) });
        await page.settle();
        const app = page.doc.getElementById("app")!;
        assertNoLiveInjection(page.doc);
        expect(page.win.__xss).toBeUndefined();
        if (phase === "UNDER_REVIEW") {
          // The five application values are present verbatim as text, in <dd> elements with no children.
          const dds = Array.from(app.querySelectorAll("dd"));
          expect(dds.some((dd) => dd.textContent === value)).toBe(true);
          for (const dd of dds) expect(dd.children).toHaveLength(0);
        }
        expect(app.innerHTML).not.toContain("<img");
        expect(app.innerHTML).not.toContain("<svg");
        page.close();
      }
    });
  }

  it("a hostile display name in the form's \"Applying as\" line is text", async () => {
    for (const { value } of HOSTILE_PAYLOADS) {
      const page = await loadPage(BECOME_HTML, { auth: authenticated(value), respond: () => statusResponse("NOT_APPLIED", null) });
      await page.settle();
      const line = page.doc.querySelector(".applying-as")!;
      expect(line.children).toHaveLength(0);
      expect(line.textContent).toContain(value);
      assertNoLiveInjection(page.doc);
      expect(page.win.__xss).toBeUndefined();
      page.close();
    }
  });

  it("a hostile server error message is shown as text and never parsed", async () => {
    for (const { value } of HOSTILE_PAYLOADS) {
      const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => ({ status: 403, json: { error: value } }) });
      await page.settle();
      assertNoLiveInjection(page.doc);
      const message = page.doc.querySelector("#app .empty-state p")!;
      expect(message.children).toHaveLength(0);
      expect(message.textContent).toContain(value);
      expect(page.win.__xss).toBeUndefined();
      page.close();
    }
  });

  it("hostile text typed into the form is POSTed verbatim as data, and never executed on the way", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => (call.url.endsWith("/status") ? statusResponse("NOT_APPLIED", null) : { status: 400, json: { error: "x", field: "cityArea" } }),
    });
    await page.settle();
    fillForm(page.doc, { venueName: hostile, cityArea: hostile });
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => page.calls.some((c) => c.method === "POST"));
    const post = page.calls.find((c) => c.method === "POST")!;
    expect((post.body as any).venueName).toBe(hostile);
    expect(page.win.__xss).toBeUndefined();
    assertNoLiveInjection(page.doc);
    page.close();
  });
});

describe("become-a-host.html — nothing sensitive reaches the markup, the URL or storage (test 22)", () => {
  it("across every phase the DOM holds no UUID, token, email or application code", async () => {
    for (const [phase, application] of [
      ["NOT_APPLIED", null],
      ["UNDER_REVIEW", APPLICATION],
      ["APPROVED_READY", { ...APPLICATION, state: "APPROVED", capabilityState: "AVAILABLE" }],
      ["PILOT_CREATED", { ...APPLICATION, state: "APPROVED", capabilityState: "CONSUMED", competitionName: "Riverside Pilot Cup" }],
      ["NOT_APPROVED", { ...APPLICATION, state: "REJECTED" }],
      ["WITHDRAWN", { ...APPLICATION, state: "WITHDRAWN" }],
      ["ACCESS_REVOKED", { ...APPLICATION, state: "APPROVED", capabilityState: "REVOKED" }],
    ] as const) {
      const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse(phase, application as any) });
      await page.settle();
      const html = page.markup();
      expect(html, phase).not.toMatch(UUID_PATTERN);
      expect(html, phase).not.toContain(TOKEN_VALUE);
      expect(html, phase).not.toContain("alex@example.com");
      expect(html, phase).not.toContain(CODE);
      expect(page.win.location.href, phase).toBe("http://localhost/page.html");
      expect(page.win.localStorage.length, phase).toBe(0);
      expect(page.win.sessionStorage.length, phase).toBe(0);
      expect(page.win.document.cookie, phase).toBe("");
      page.close();
    }
  });

  it("the bearer token travels only in the Authorization header: never the URL, a query string, or a body", async () => {
    let submitted = false;
    const page = await loadPage(BECOME_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("/status")) return submitted ? statusResponse("UNDER_REVIEW", APPLICATION) : statusResponse("NOT_APPLIED", null);
        submitted = true;
        return { status: 201, json: {} };
      },
    });
    await page.settle();
    fillForm(page.doc);
    page.submit(page.doc.getElementById("host-form")!);
    await page.settle(() => /Application under review/.test(page.text()));
    for (const call of page.calls) {
      expect(call.url).not.toContain(TOKEN_VALUE);
      expect(call.url).not.toMatch(/[?&#]/);
      expect(JSON.stringify(call.body ?? "")).not.toContain(TOKEN_VALUE);
      expect(call.headers.authorization).toBe("Bearer " + TOKEN_VALUE);
    }
    page.close();
  });

  it("the source never touches storage, cookies, history, or location, and never interpolates data into innerHTML", () => {
    for (const [name, html] of [["become-a-host.html", BECOME_HTML], ["host-applications-admin.html", REVIEW_HTML]] as const) {
      const script = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
      expect(script, name).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(search|hash|href\s*=)|window\.open|eval\(|new Function|document\.write|insertAdjacentHTML|outerHTML\s*=/);
      // Every el(`...`) template is a static shell with no interpolation at all.
      for (const match of script.matchAll(/\bel\(`([\s\S]*?)`\)/g)) {
        expect(match[1], `${name}: el() template with interpolation`).not.toContain("${");
      }
      // The only innerHTML assignment is the el() helper's own.
      const assignments = [...script.matchAll(/\.innerHTML\s*=/g)];
      expect(assignments, name).toHaveLength(1);
      expect(script, name).toMatch(/div\.innerHTML = html\.trim\(\);/);
    }
  });
});

describe("accessibility and responsive foundations of the new pages", () => {
  for (const [name, html] of [["become-a-host.html", BECOME_HTML], ["host-applications-admin.html", REVIEW_HTML]] as const) {
    it(`${name}: language, landmarks, viewport, focus ring, reduced layout rules`, () => {
      expect(html).toMatch(/<html lang="en">/);
      expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
      expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
      expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
      expect(html).toMatch(/:focus-visible\s*\{\s*outline:\s*3px solid/);
      expect(html).not.toMatch(/outline:\s*(none|0)\b/);
      expect(html).toMatch(/@media \(max-width: 640px\)/);
      expect(html).toMatch(/overflow-wrap:\s*anywhere/);
      expect(html).toMatch(/aria-live="polite"/);
      // Interactive targets are at least 44px tall.
      for (const match of html.matchAll(/(\.btn-primary|\.btn-secondary|\.btn-danger|\.signin-btn|\.tab-btn)\s*\{[^}]*?min-height:\s*(\d+)px/g)) {
        expect(Number(match[2]), `${name} ${match[1]}`).toBeGreaterThanOrEqual(44);
      }
    });
  }

  it("the application page has no horizontally-scrolling construct: no fixed widths wider than a 320px phone", () => {
    expect(BECOME_HTML).not.toMatch(/[^-]width:\s*(\d{3,})px/);
    expect(REVIEW_HTML).not.toMatch(/[^-]width:\s*(\d{3,})px/);
    // The one place text is not allowed to wrap is the short sign-in button; nothing that holds user text may use nowrap.
    for (const html of [BECOME_HTML, REVIEW_HTML]) {
      for (const rule of html.matchAll(/([^{}]+)\{([^{}]*white-space:\s*nowrap[^{}]*)\}/g)) {
        expect(rule[1].trim(), "a nowrap rule on something other than the sign-in button").toBe(".signin-btn");
      }
    }
  });

  it("the form's inputs are at least 16px so mobile browsers do not zoom on focus", () => {
    expect(BECOME_HTML).toMatch(/\.field input, \.field textarea \{[^}]*font-size: 16px/);
    expect(REVIEW_HTML).toMatch(/\.field textarea \{[^}]*font-size: 16px/);
  });

  it("the review page is not indexed", () => {
    expect(REVIEW_HTML).toMatch(/<meta name="robots" content="noindex" \/>/);
  });
});

// ---------------------------------------------------------------------------

const PENDING_ROW = {
  publicCode: CODE, state: "PENDING", applicantDisplayName: "Alex Applicant", venueName: "Riverside Five-a-Side", cityArea: "Riverside District",
  playingFields: 3, venueDescription: "We run two small leagues at our venue each season.", expectedWindow: "weekend of 14 November", expectedTeamCount: 6,
  submittedAt: "2026-10-07T12:00:00Z", decidedAt: null, decidedByDisplayName: null, decisionReason: null, withdrawnAt: null,
  capabilityState: null, capabilityGrantedAt: null, capabilityConsumedAt: null, capabilityRevokedAt: null, capabilityRevokeReason: null,
  competitionName: null, competitionState: null,
};

describe("host-applications-admin.html — the internal review page", () => {
  it("signed out: a sign-in prompt, and nothing is fetched (knowing the address grants nothing)", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: { status: "unauthenticated" } });
    await page.settle();
    expect(page.text()).toMatch(/Sign in to review/);
    expect(page.calls).toEqual([]);
    page.doc.getElementById("signin-to-review")!.dispatchEvent(new (page.win as any).MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    const panel = page.doc.getElementById("btn-signin")!.nextElementSibling as HTMLElement;
    expect(panel.style.display).toBe("block");
    page.close();
  });

  it("a signed-in member without review access gets a plain refusal and no list; no authority-system terms leak (test 6)", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 403, json: { error: "You are not authorized to review host applications." } }) });
    await page.settle();
    expect(page.text()).toMatch(/You do not have access to review host applications\./);
    expect(page.doc.querySelector("article")).toBeNull();
    expect(page.text()).not.toMatch(/PRODUCT_GOVERNANCE|OPERATIONAL|No applications are waiting/);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0].url).toBe("/api/gaming/host/review?view=PENDING");
    page.close();
  });

  it("an outage is never shown as an empty queue", async () => {
    for (const status of [503, 500, 0]) {
      const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => { if (status === 0) throw new Error("down"); return { status, json: { error: "x" } }; } });
      await page.settle();
      expect(page.text()).not.toMatch(/No applications are waiting/);
      expect(page.doc.querySelector("article")).toBeNull();
      page.close();
    }
  });

  it("an empty queue and a non-empty queue both render, with a Pending / History switch that reports its state in text", async () => {
    const empty = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [] } }) });
    await empty.settle();
    expect(empty.text()).toMatch(/No applications are waiting for review/);
    expect(empty.button("Pending").getAttribute("aria-pressed")).toBe("true");
    expect(empty.button("Active hosts").getAttribute("aria-pressed")).toBe("false");
    expect(empty.button("History").getAttribute("aria-pressed")).toBe("false");
    empty.button("Active hosts").click();
    await empty.settle(() => /No hosts have active access/.test(empty.text()));
    expect(empty.calls[empty.calls.length - 1].url).toBe("/api/gaming/host/review?view=ACTIVE");
    empty.button("History").click();
    await empty.settle(() => /No decisions in the history yet/.test(empty.text()));
    expect(empty.calls[empty.calls.length - 1].url).toBe("/api/gaming/host/review?view=HISTORY");
    empty.close();
  });

  it("shows the applicant by name with their application text and no identifier of any kind", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [PENDING_ROW] } }) });
    await page.settle();
    const card = page.doc.querySelector("article")!;
    expect(card.querySelector(".who")!.textContent).toBe("Alex Applicant");
    expect(card.querySelector(".where")!.textContent).toBe("Riverside Five-a-Side — Riverside District");
    expect(card.querySelector(".status-pill")!.textContent).toBe("Pending");
    const html = page.markup();
    expect(html).not.toMatch(UUID_PATTERN);
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(TOKEN_VALUE);
    expect(page.win.location.href).toBe("http://localhost/page.html");
    page.close();
  });

  for (const { label, value } of HOSTILE_PAYLOADS) {
    it(`hostile applicant text (${label}) renders as literal text on every card`, async () => {
      const rows = [
        { ...PENDING_ROW, applicantDisplayName: value, venueName: value, cityArea: value, venueDescription: value, expectedWindow: value },
        { ...PENDING_ROW, state: "APPROVED", applicantDisplayName: value, decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: value, decisionReason: value, capabilityState: "CONSUMED", competitionName: value, competitionState: "DRAFT" },
        { ...PENDING_ROW, state: "APPROVED", applicantDisplayName: value, decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: value, capabilityState: "REVOKED", capabilityRevokedAt: "2026-10-09T09:00:00Z", capabilityRevokeReason: value },
        { ...PENDING_ROW, state: "REJECTED", applicantDisplayName: value, decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: value, decisionReason: value },
      ];
      const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: rows } }) });
      await page.settle();
      expect(page.doc.querySelectorAll("article")).toHaveLength(4);
      assertNoLiveInjection(page.doc, REVIEW_PAGE_SCRIPTS);
      expect(page.win.__xss).toBeUndefined();
      expect(page.doc.querySelector("article .who")!.textContent).toBe(value);
      for (const dd of Array.from(page.doc.querySelectorAll("dd"))) expect(dd.children).toHaveLength(0);
      // Accessible names carry the applicant's text inside ATTRIBUTE values; those are inert. What must not exist is an element.
      expect(page.doc.querySelectorAll("#app img, #app svg, #app script, #app iframe")).toHaveLength(0);
      for (const button of Array.from(page.doc.querySelectorAll("#app button[aria-label]"))) expect(button.getAttribute("aria-label")!.length).toBeGreaterThan(5);
      page.close();
    });
  }

  it("approving: a confirmation step, then a POST of the decision only, to the encoded application code", async () => {
    let decided = false;
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.method === "POST") { decided = true; return { status: 200, json: { application: { state: "APPROVED", alreadyDecided: false } } }; }
        return { status: 200, json: { applications: decided ? [] : [PENDING_ROW] } };
      },
    });
    await page.settle();
    const approve = page.button("Approve");
    approve.click();
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(page.doc.querySelector(".panel")!.textContent).toMatch(/one private pilot competition/);
    expect(page.doc.activeElement?.textContent).toBe("Yes, approve");
    const confirm = page.button("Yes, approve");
    confirm.click();
    confirm.click();
    await page.settle(() => /Application approved\./.test(page.text()));
    const posts = page.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/api/gaming/host/review/${CODE}/decide`);
    expect(posts[0].body).toEqual({ decision: "APPROVE" });
    page.close();
  });

  it("rejecting: an internal reason is required (nothing is sent without one), then the POST carries decision and reason only", async () => {
    let decided = false;
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.method === "POST") { decided = true; return { status: 200, json: { application: { state: "REJECTED" } } }; }
        return { status: 200, json: { applications: decided ? [] : [PENDING_ROW] } };
      },
    });
    await page.settle();
    page.button("Reject").click();
    const textarea = page.doc.querySelector(".panel textarea") as HTMLTextAreaElement;
    expect(textarea.required).toBe(true);
    expect(textarea.maxLength).toBe(500);
    expect(page.doc.querySelector(`label[for="${textarea.id}"]`)!.textContent).toMatch(/Internal reason \(required\)/);
    expect(page.doc.activeElement).toBe(textarea);
    page.button("Yes, reject").click();
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(page.doc.getElementById(textarea.id + "-err")!.hidden).toBe(false);
    expect(textarea.getAttribute("aria-describedby")).toBe(textarea.id + "-err");

    textarea.value = "  Venue does not fit the pilot.  ";
    page.button("Yes, reject").click();
    await page.settle(() => /Application rejected\./.test(page.text()));
    const posts = page.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ decision: "REJECT", reason: "Venue does not fit the pilot." });
    page.close();
  });

  it("Escape and Cancel close a confirmation, restore focus to the control that opened it, and send nothing", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [PENDING_ROW] } }) });
    await page.settle();
    const reject = page.button("Reject");
    reject.click();
    page.doc.querySelector(".panel")!.dispatchEvent(new (page.win as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.doc.querySelector(".panel")).toBeNull();
    expect(page.doc.activeElement).toBe(reject);
    expect(reject.disabled).toBe(false);
    page.button("Approve").click();
    page.button("Cancel").click();
    expect(page.doc.querySelector(".panel")).toBeNull();
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    page.close();
  });

  it("a decision refused because the application changed (409) refreshes the list instead of leaving a stale card with live buttons", async () => {
    let decided = false;
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.method === "POST") { decided = true; return { status: 409, json: { error: "This application is no longer waiting for a decision." } }; }
        return { status: 200, json: { applications: decided ? [] : [PENDING_ROW] } };
      },
    });
    await page.settle();
    page.button("Approve").click();
    page.button("Yes, approve").click();
    await page.settle(() => /no longer waiting for a decision/.test(page.text()));
    expect(page.doc.getElementById("page-status")!.className).toContain("error");
    expect(page.doc.querySelector("article")).toBeNull();
    expect(page.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    page.close();
  });

  it("a decision that FAILS (500) keeps the confirmation open with a truthful error and allows a retry", async () => {
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => (call.method === "POST" ? { status: 500, json: { error: "Failed" } } : { status: 200, json: { applications: [PENDING_ROW] } }),
    });
    await page.settle();
    page.button("Approve").click();
    page.button("Yes, approve").click();
    await page.settle(() => /could not save that/.test(page.text()));
    expect(page.doc.querySelector(".card-status")!.className).toContain("error");
    expect(page.button("Yes, approve").disabled).toBe(false);
    page.close();
  });

  it("revoking: offered only on an approved application that is not already revoked, reason required, POST carries the reason only", async () => {
    const approved = { ...PENDING_ROW, state: "APPROVED", decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: "Riley Reviewer", capabilityState: "CONSUMED", competitionName: "Riverside Pilot Cup", competitionState: "DRAFT" };
    const revoked = { ...approved, publicCode: "ZyXwVuTsRqPoNmLkJiHgFe", capabilityState: "REVOKED", capabilityRevokedAt: "2026-10-09T09:00:00Z", capabilityRevokeReason: "Rules were not followed." };
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => (call.method === "POST" ? { status: 200, json: { application: { capabilityState: "REVOKED" } } } : { status: 200, json: { applications: [approved, revoked, { ...PENDING_ROW, state: "REJECTED" }] } }),
    });
    await page.settle();
    expect(Array.from(page.doc.querySelectorAll("button")).filter((b) => b.textContent === "Revoke hosting access")).toHaveLength(1);
    expect(page.button("Revoke hosting access").getAttribute("aria-label")).toMatch(/^Revoke hosting access — application from /);
    page.button("Revoke hosting access").click();
    page.button("Yes, revoke access").click();
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    (page.doc.querySelector(".panel textarea") as HTMLTextAreaElement).value = "Rules were not followed.";
    page.button("Yes, revoke access").click();
    await page.settle(() => /Hosting access revoked\./.test(page.text()));
    const posts = page.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/api/gaming/host/review/${CODE}/revoke`);
    expect(posts[0].body).toEqual({ reason: "Rules were not followed." });
    page.close();
  });

  it("history shows the decision, who decided and when, and the internal reasons — to reviewers only", async () => {
    const rejected = { ...PENDING_ROW, state: "REJECTED", decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: "Riley Reviewer", decisionReason: "Venue does not fit the pilot." };
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [rejected] } }) });
    await page.settle();
    const text = page.text();
    expect(text).toMatch(/Decided/);
    expect(text).toMatch(/Riley Reviewer/);
    expect(text).toMatch(/Internal reason/);
    expect(text).toMatch(/Venue does not fit the pilot\./);
    expect(page.doc.querySelector("article .status-pill")!.textContent).toBe("Rejected");
    page.close();
  });

  it("the stack of cards works with long unbroken text at narrow widths (CSS wraps it)", () => {
    expect(REVIEW_HTML).toMatch(/overflow-wrap:\s*anywhere/);
    expect(REVIEW_HTML).toMatch(/dl\.facts dd \{[^}]*white-space: pre-wrap/);
  });
});

describe("host-applications-admin.html — revocation is always reachable, and the page keeps what the reviewer is typing", () => {
  const ACTIVE_ROW = { ...PENDING_ROW, state: "APPROVED", decidedAt: "2026-10-08T09:00:00Z", decidedByDisplayName: "Rita Reviewer", capabilityState: "CONSUMED", competitionName: "Riverside Pilot Cup", competitionState: "DRAFT" };

  it("Active hosts is its own view: a live host is revocable from it, and History offers no revoke", async () => {
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("view=ACTIVE")) return { status: 200, json: { applications: [ACTIVE_ROW] } };
        if (call.url.endsWith("view=HISTORY")) return { status: 200, json: { applications: [{ ...ACTIVE_ROW, capabilityState: "REVOKED", capabilityRevokedAt: "2026-10-09T09:00:00Z", capabilityRevokeReason: "x" }, { ...PENDING_ROW, state: "REJECTED" }] } };
        return { status: 200, json: { applications: [] } };
      },
    });
    await page.settle();
    page.button("Active hosts").click();
    await page.settle(() => !!page.doc.querySelector("article"));
    expect(page.button("Revoke hosting access")).toBeTruthy();
    page.button("History").click();
    await page.settle(() => page.doc.querySelectorAll("article").length === 2);
    expect(Array.from(page.doc.querySelectorAll("button")).some((b) => b.textContent === "Revoke hosting access")).toBe(false);
    page.close();
  });

  it("every card is a named region and every repeated action names whose application it acts on", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [PENDING_ROW, { ...PENDING_ROW, applicantDisplayName: "Sam Second" }] } }) });
    await page.settle();
    const articles = Array.from(page.doc.querySelectorAll("article"));
    expect(articles).toHaveLength(2);
    for (const a of articles) {
      const labelledBy = a.getAttribute("aria-labelledby")!;
      expect(page.doc.getElementById(labelledBy)!.textContent).toMatch(/Alex Applicant|Sam Second/);
    }
    const labels = Array.from(page.doc.querySelectorAll("button[aria-label]")).map((b) => b.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(labels.length); // no two actions share a name
    expect(labels).toContain("Approve — application from Sam Second");
    page.close();
  });

  it("a reason being typed survives a background auth event (a token refresh must not wipe it)", async () => {
    const page = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 200, json: { applications: [PENDING_ROW] } }) });
    await page.settle();
    page.button("Reject").click();
    const box = page.doc.querySelector(".panel textarea") as HTMLTextAreaElement;
    box.value = "Half-typed internal reason";
    const callsBefore = page.calls.length;
    page.fireAuthEvent();
    page.fireAuthEvent();
    await new Promise((r) => setTimeout(r, 50));
    await page.settle();
    expect(page.doc.querySelector(".panel textarea")).toBe(box);
    expect(box.value).toBe("Half-typed internal reason");
    expect(page.calls.length).toBe(callsBefore); // and no needless reload either
    page.close();
  });

  it("a slow answer for a tab the reviewer has already left cannot overwrite the tab they are on", async () => {
    let releasePending: (v: { status: number; json: unknown }) => void = () => {};
    const slowPending = new Promise<{ status: number; json: unknown }>((res) => { releasePending = res; });
    let first = true;
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: (call) => {
        if (call.url.endsWith("view=PENDING") && first) { first = false; return slowPending; }
        if (call.url.endsWith("view=HISTORY")) return { status: 200, json: { applications: [] } };
        return { status: 200, json: { applications: [PENDING_ROW] } };
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    // Switch tabs before the first (slow) request answers: the toolbar does not exist yet, so drive the request directly.
    await page.win.eval(`currentView = "HISTORY"; loadList();`);
    await page.settle(() => /No decisions in the history yet/.test(page.text()));
    releasePending({ status: 200, json: { applications: [PENDING_ROW] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(page.text()).toMatch(/No decisions in the history yet/);
    expect(page.doc.querySelector("article")).toBeNull();
    page.close();
  });

  it("a failed or unreachable list offers Try again; a refusal does not (retrying a 403 is pointless)", async () => {
    let healthy = false;
    const page = await loadPage(REVIEW_HTML, {
      auth: authenticated(),
      respond: () => (healthy ? { status: 200, json: { applications: [PENDING_ROW] } } : { status: 503, json: { error: "x" } }),
    });
    await page.settle();
    expect(page.text()).toMatch(/not open yet/);
    healthy = true;
    page.button("Try again").click();
    await page.settle(() => !!page.doc.querySelector("article"));
    page.close();
    const refused = await loadPage(REVIEW_HTML, { auth: authenticated(), respond: () => ({ status: 403, json: { error: "x" } }) });
    await refused.settle();
    expect(Array.from(refused.doc.querySelectorAll("button")).some((b) => b.textContent === "Try again")).toBe(false);
    refused.close();
  });
});

describe("become-a-host.html — background events never wipe what the applicant is typing", () => {
  it("the display-name form is not re-mounted by the sign-in poll: the same input, with its text, a second later", async () => {
    const page = await loadPage(BECOME_HTML, { auth: { status: "profile_incomplete", email: "new@example.com" } });
    await page.settle();
    const input = page.doc.getElementById("display-name") as HTMLInputElement;
    input.value = "Typed so far";
    await new Promise((r) => setTimeout(r, 1300)); // longer than two poll intervals
    expect(page.doc.getElementById("display-name")).toBe(input);
    expect(input.value).toBe("Typed so far");
    page.close();
  });

  it("a half-filled application survives auth events (a token refresh) and is not re-fetched into a blank form", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("NOT_APPLIED", null) });
    await page.settle();
    fillForm(page.doc, { venueName: "Half-typed venue" });
    const form = page.doc.getElementById("host-form");
    page.fireAuthEvent();
    page.fireAuthEvent();
    await new Promise((r) => setTimeout(r, 80));
    await page.settle();
    expect(page.doc.getElementById("host-form")).toBe(form);
    expect((page.doc.getElementById("f-venueName") as HTMLInputElement).value).toBe("Half-typed venue");
    page.close();
  });

  it("a pilot name being typed survives an auth event too", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("APPROVED_READY", { ...APPLICATION, state: "APPROVED", capabilityState: "AVAILABLE" }) });
    await page.settle();
    const input = page.doc.getElementById("pilot-name") as HTMLInputElement;
    input.value = "Half-typed pilot";
    page.fireAuthEvent();
    await new Promise((r) => setTimeout(r, 80));
    await page.settle();
    expect(page.doc.getElementById("pilot-name")).toBe(input);
    expect(input.value).toBe("Half-typed pilot");
    page.close();
  });

  it("a REAL change of state still re-draws: when the reviewer approves while the page is open, the next event shows it", async () => {
    let phase = "UNDER_REVIEW";
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse(phase, phase === "UNDER_REVIEW" ? APPLICATION : { ...APPLICATION, state: "APPROVED", capabilityState: "AVAILABLE" }) });
    await page.settle();
    expect(page.text()).toMatch(/Application under review/);
    phase = "APPROVED_READY";
    page.fireAuthEvent();
    await page.settle(() => /Your host application was approved/.test(page.text()));
    page.close();
  });

  it("a failed status load offers Try again and recovers", async () => {
    let healthy = false;
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => (healthy ? statusResponse("NOT_APPLIED", null) : { status: 500, json: { error: "x" } }) });
    await page.settle();
    expect(page.text()).toMatch(/could not load your host application/i);
    healthy = true;
    page.button("Try again").click();
    await page.settle(() => !!page.doc.getElementById("host-form"));
    page.close();
  });

  it("the form says up front that every field is required", async () => {
    const page = await loadPage(BECOME_HTML, { auth: authenticated(), respond: () => statusResponse("NOT_APPLIED", null) });
    await page.settle();
    expect(page.text()).toMatch(/All fields are required\./);
    for (const input of Array.from(page.doc.querySelectorAll("#host-form input:not([type=checkbox]), #host-form textarea")) as HTMLInputElement[]) expect(input.required).toBe(true);
    page.close();
  });

  it("the library's injected Sign out link is styled only while it is shown (display:inline), never forced visible after sign-out", () => {
    for (const html of [BECOME_HTML, REVIEW_HTML]) {
      expect(html).toMatch(/a\[data-urbano-signout\]\[style\*="display: inline"\]/);
      expect(html).not.toMatch(/a\[data-urbano-signout\]\s*\{[^}]*display:\s*inline-flex\s*!important/);
    }
  });

  it("control borders are strong enough to see (at least 3:1 against the card)", () => {
    for (const html of [BECOME_HTML, REVIEW_HTML]) {
      const border = (html.match(/--line-strong:\s*(#[0-9a-f]{6})/i) ?? [])[1];
      const surface = (html.match(/--bg-card:\s*(#[0-9a-f]{6})/i) ?? [])[1];
      const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (lum(border) + 0.05) / (lum(surface) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });
});
