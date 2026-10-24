import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Soccer Predictions admin page (public/predictions-admin.html), parsed and run whole in jsdom as shipped, with a stubbed fetch and a
 * stubbed UrbanoAuth: no network, no credentials. Covers the weekend-launch surface used by restaurant staff on a phone:
 *   A. the Prizes table (names, prize labels, status, confirm-then-redeem with visible failures),
 *   B. the per-match classification control (Official default, Trial / test run, 403 and 409 surfaced),
 *   C. the roster paste (parsing, dedupe, cap, confirm, deactivated names, stop on 401/403, summary),
 *   D. activations and prizes of a cancelled match, and the Cancel confirm,
 *   E. unambiguous match and activation labels, and Create Match not double-submitting,
 *   F. the Result form bound to its match: read before saved or finalized, finalized only as reviewed (digest), a lost finalize answer UNKNOWN and settled by reading,
 *      sign-out and identity change clearing the screen, loaders/toggles/forms failing visibly, the bounded sign-in wait, and prizes on hold or already delivered,
 *   G. the prize list: visible outcomes, stale rows, duplicate names, finding a winner,
 *   H. a redeem attempt whose outcome cannot be known (lost answer, 408, 5xx): Status unknown, Check status, no replay, no false "not redeemed",
 *   I. the recovery code itself: a 200 that is not the route's answer, a stalled request, banners that agree with the rows, honest list freshness, quoted labels,
 * and that member- and admin-controlled strings never reach an HTML parser.
 */

const HTML = readFileSync(path.join(process.cwd(), "public/predictions-admin.html"), "utf8");

const API = "/api/gaming/predictions";
const MEMBER_UUID = "1a2b3c4d-1111-4222-8333-444455556666";
const TIER_UUID = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

interface Call { url: string; method: string; body: any; headers: Record<string, string> }
type Reply = { status: number; json?: unknown } | "reject";
type Responder = (call: Call) => Reply | Promise<Reply | undefined> | undefined;

const TEAMS = [
  { teamId: "team-a", name: "Alpha FC" },
  { teamId: "team-b", name: "Beta FC" },
];
const ROSTERS: Record<string, unknown[]> = {
  "team-a": [
    { playerId: "pa1", teamId: "team-a", name: "Ana Díaz", active: true },
    { playerId: "pa2", teamId: "team-a", name: "Bob Stone", active: false },
  ],
  "team-b": [],
};
const MATCHES = [
  { matchId: "m1", homeTeamId: "team-a", awayTeamId: "team-b", competition: "Liga", kickoffAt: "2026-10-24T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null },
  { matchId: "m2", homeTeamId: "team-b", awayTeamId: "team-a", competition: "Liga", kickoffAt: "2026-10-25T20:00:00.000Z", cancelledAt: "2026-10-20T10:00:00.000Z", activityClassification: "OFFICIAL", xpEligible: null },
  { matchId: "m3", homeTeamId: "team-a", awayTeamId: "team-b", competition: "Friendly", kickoffAt: "2026-10-26T20:00:00.000Z", cancelledAt: null, activityClassification: "TRAINING", xpEligible: null },
];
const BEER_BOX = { venueId: "v1", name: "Beer Box" };
// Cancelled match m2 keeps its activation and prize tier: the admin read path does not filter it out the way the public list does.
const ADMIN_ACTIVATIONS = [
  { matchId: "m1", venueActivationId: "act-1", enabled: true, venue: BEER_BOX, prizeTiers: [{ prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: "Free pitcher" }] },
  { matchId: "m2", venueActivationId: "act-2", enabled: true, venue: BEER_BOX, prizeTiers: [{ prizeTierId: "tier-9", correctDimensionCount: 4, prizeLabel: "Jersey" }] },
  { matchId: "m3", venueActivationId: "act-3", enabled: true, venue: BEER_BOX, prizeTiers: [] },
];

function qual(over: Record<string, unknown>) {
  return {
    prizeQualificationId: "q1", evaluationId: "e1", gamingMemberId: "member-1", venueActivationId: "act-1", prizeTierId: "tier-2",
    redeemedAt: null, redeemedByGamingMemberId: null, redeemedPrizeLabel: null, redeemedPrizeLabelBasis: null,
    legacyObservedPrizeLabel: null, lineageOrdinal: null, supersededAt: null,
    replacesPrizeQualificationId: null, fulfilledByPrizeQualificationId: null, holdPriorPrizeQualificationId: null,
    heldAt: null, holdBasis: null, holdReason: null, releasedAt: null, releasedByGamingMemberId: null, releaseReason: null,
    createdAt: "2026-10-24T22:00:00.000Z",
    memberDisplayName: "Maria Lopez", prizeLabel: "Free pitcher", ...over,
  };
}

const DEFAULT_QUALIFICATIONS = [
  qual({ prizeQualificationId: "q-redeemed", memberDisplayName: "Rita Redeemed", prizeLabel: "Burger", redeemedAt: "2026-10-24T23:00:00.000Z" }),
  qual({ prizeQualificationId: "q-superseded", memberDisplayName: "Sam Superseded", prizeLabel: "T-shirt", supersededAt: "2026-10-25T01:00:00.000Z" }),
  qual({ prizeQualificationId: "q-pending", memberDisplayName: "Maria Lopez", prizeLabel: "Free pitcher" }),
  qual({ prizeQualificationId: "q-fallback", gamingMemberId: MEMBER_UUID, prizeTierId: TIER_UUID, memberDisplayName: null, prizeLabel: null }),
];

function jsonReply(status: number, json?: unknown): Reply { return { status, json }; }

const ALL_CLASSES = ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"];

function baseResponder(qualifications: unknown[], access: () => Reply | Promise<Reply>): Responder {
  return (call) => {
    const u = call.url;
    // The access hint the page asks for before it draws anything administrative.
    if (call.method === "GET" && u === `${API}/admin/access`) return access();
    if (call.method === "GET" && u === `${API}/admin/teams`) return jsonReply(200, { teams: TEAMS });
    const roster = u.match(/^\/api\/gaming\/predictions\/admin\/teams\/([^/]+)\/players$/);
    if (roster && call.method === "GET") return jsonReply(200, { players: ROSTERS[roster[1]] ?? [] });
    if (call.method === "GET" && u === `${API}/admin/matches`) return jsonReply(200, { matches: MATCHES, teams: TEAMS });
    if (call.method === "GET" && u === `${API}/admin/venues`) return jsonReply(200, { venues: [{ venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }] });
    if (call.method === "GET" && u === `${API}/admin/activations`) return jsonReply(200, { activations: ADMIN_ACTIVATIONS });
    if (call.method === "GET" && u.startsWith(`${API}/admin/qualifications?`)) return jsonReply(200, { qualifications });
    return undefined;
  };
}

const STAFF_STATE = { status: "authenticated", email: "staff@example.com", gamingMemberId: "staff-1", displayName: "Staff Member" };

async function loadPage(opts: { noWait?: boolean; classes?: string[]; access?: Reply | Promise<Reply>; respond?: Responder; qualifications?: unknown[]; confirm?: boolean; teams?: unknown[]; noActivations?: boolean; captureLongTimers?: boolean } = {}) {
  const calls: Call[] = [];
  // The sign-in client is a real moving part: the page reloads on every sign-in event, and the signed-in admin can change or sign out.
  let authState: Record<string, unknown> = { ...STAFF_STATE };
  let signOuts = 0;
  const signInOpens: Array<Record<string, unknown>> = [];
  const authListeners: Array<() => void> = [];
  let responder: Responder | undefined = opts.respond;
  // With captureLongTimers the page's own timers of 5 s or more are held instead of scheduled, so a request timeout can be fired on demand.
  const longTimers = new Map<number, { ms: number; run: () => void }>();
  let accessAnswer: Reply | Promise<Reply> = opts.access ?? jsonReply(200, { access: true, classes: opts.classes ?? ALL_CLASSES });
  const base = baseResponder(opts.qualifications ?? DEFAULT_QUALIFICATIONS, () => accessAnswer);
  const confirm = vi.fn(() => opts.confirm ?? true);
  const dom = new JSDOM(HTML, {
    url: "http://localhost/predictions-admin.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.confirm = confirm;
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => authState,
        getAccessToken: async () => "stub-token",
        onAuthStateChange: async (callback: () => void) => { authListeners.push(callback); return () => {}; },
        signOut: async () => { signOuts += 1; authState = { status: "unauthenticated" }; },
        openSignIn: (options: Record<string, unknown>) => { signInOpens.push(options); return true; },
      };
      if (opts.captureLongTimers) {
        const realSet = w.setTimeout.bind(w);
        const realClear = w.clearTimeout.bind(w);
        let nextId = 1_000_000;
        w.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          if (typeof ms === "number" && ms >= 5000) {
            const id = nextId++;
            longTimers.set(id, { ms, run: () => fn(...args) });
            return id;
          }
          return realSet(fn, ms, ...args);
        };
        w.clearTimeout = (id: number) => { if (!longTimers.delete(id)) realClear(id); };
      }
      w.fetch = (url: string, init: Record<string, any> = {}) => {
        const call: Call = {
          url: String(url),
          method: (init.method || "GET").toUpperCase(),
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
          headers: init.headers || {},
        };
        calls.push(call);
        const answer = (async () => {
          const out = (await responder?.(call)) ?? (await base(call)) ?? { status: 404, json: { error: "unexpected request: " + call.method + " " + call.url } };
          if (out === "reject") throw new TypeError("network failure");
          // a real response body is serialized: the page can never mutate the fixtures it was given
          return { status: out.status, json: async () => { if (out.json === undefined) throw new SyntaxError("no body"); return JSON.parse(JSON.stringify(out.json)); } };
        })();
        // like a real fetch, a request given an AbortSignal rejects with an AbortError the moment the signal fires
        const signal = init.signal as AbortSignal | undefined;
        if (!signal) return answer;
        return new Promise((resolve, reject) => {
          const abort = () => reject(new w.DOMException("The operation was aborted.", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          answer.then(resolve, reject);
        });
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const until = async (predicate: () => boolean, label = "condition", timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 0));
      if (predicate()) return;
      if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    }
  };
  if (opts.noWait) await new Promise((r) => setTimeout(r, 30));
  else await until(
    () => doc.querySelectorAll("#table-matches tbody tr").length > 0 && (opts.noActivations ? calls.some((c) => c.url === `${API}/admin/activations`) : doc.querySelectorAll("#q-activation option").length > 0),
    "the admin sections to load"
  );
  if (opts.noActivations) await new Promise((r) => setTimeout(r, 20));
  const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    win, doc, calls, confirm, until, text, longTimers, close: () => dom.window.close(),
    setAuth: (state: Record<string, unknown>) => { authState = state; },
    setAccess: (reply: Reply | Promise<Reply>) => { accessAnswer = reply; },
    signOutCount: () => signOuts,
    signInOpens,
    fireAuthEvent: () => { for (const listener of authListeners) listener(); },
    setResponder: (next: Responder) => { responder = next; },
  };
}
type Page = Awaited<ReturnType<typeof loadPage>>;

async function loadQualifications(page: Page) {
  (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
  await page.until(() => page.doc.querySelectorAll("#table-qualifications tbody tr").length > 0, "the prizes table");
}

const rowFor = (page: Page, id: string) => page.doc.querySelector(`#table-qualifications tbody tr[data-qualification="${id}"]`) as HTMLElement;
const redeemButton = (page: Page, id: string) => page.doc.querySelector(`button[data-redeem="${id}"]`) as HTMLButtonElement | null;
const posts = (page: Page, suffix: string) => page.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const checkButton = (page: Page, id: string) => page.doc.querySelector(`button[data-check-status="${id}"]`) as HTMLButtonElement | null;
const qualGets = (page: Page) => page.calls.filter((c) => c.method === "GET" && c.url.startsWith(`${API}/admin/qualifications?`));
const pillOf = (page: Page, id: string) => (rowFor(page, id)?.querySelector(".pill")?.textContent ?? "");
const rowButtons = (page: Page, id: string) => [...rowFor(page, id).querySelectorAll("button")] as HTMLButtonElement[];
const banner = (page: Page) => page.doc.getElementById("msg-prizes")!;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------------------
// A stateful stand-in for the qualifications API. The server state is real: a redeem POST RECORDS the redemption and only then does
// the stub decide how the response behaves (lost, 5xx, 200), and every qualifications GET reflects what was recorded. That is what
// makes "the answer was lost but the server did record it" testable instead of assumed.
// ---------------------------------------------------------------------------------------------------------------------------------

const RECORDED_AT = "2026-10-24T23:30:00.000Z";
type PostMode = "ok" | "commit-lose" | "commit-http" | "lose-uncommitted";
type GetMode = "ok" | "reject" | "http500" | "http403" | "malformed" | "no-body" | "absent";

function statefulServer(opts: { qualifications?: unknown[]; byActivation?: Record<string, unknown[]> } = {}) {
  const base = (opts.qualifications ?? DEFAULT_QUALIFICATIONS) as Array<Record<string, any>>;
  const server = {
    redeemedAt: new Map<string, string>(),
    supersededAt: new Map<string, string>(),
    postMode: "ok" as PostMode,
    postHttp: 500,
    getMode: "ok" as GetMode,
    absentId: "",
    heldGate: null as null | Promise<void>,
    /** The next qualifications GET takes its snapshot now but answers only after the returned function is called. */
    hold() {
      let release!: () => void;
      server.heldGate = new Promise<void>((r) => { release = r; });
      return release;
    },
    view(activationId: string | null): Array<Record<string, any>> {
      const rows = (opts.byActivation && activationId && opts.byActivation[activationId]) || base;
      return (rows as Array<Record<string, any>>).map((q): Record<string, any> => ({
        ...q,
        redeemedAt: server.redeemedAt.get(q.prizeQualificationId) ?? q.redeemedAt,
        supersededAt: server.supersededAt.get(q.prizeQualificationId) ?? q.supersededAt,
      }));
    },
    respond: async (call: Call): Promise<Reply | undefined> => {
      const redeem = call.method === "POST" ? call.url.match(/\/admin\/qualifications\/([^/]+)\/redeem$/) : null;
      if (redeem) {
        const id = decodeURIComponent(redeem[1]);
        // The database answers an already-redeemed row idempotently BEFORE it checks supersession (0124); the stub follows that order.
        const wasRedeemed = server.redeemedAt.has(id) || (base.find((q) => q.prizeQualificationId === id)?.redeemedAt ?? null) !== null;
        if (!wasRedeemed && server.supersededAt.has(id)) return jsonReply(409, { error: "This qualification is no longer supported by the current result." });
        if (server.postMode === "lose-uncommitted") return "reject";
        const already = server.redeemedAt.has(id);
        if (!already) server.redeemedAt.set(id, RECORDED_AT);
        if (server.postMode === "commit-lose") return "reject";
        if (server.postMode === "commit-http") return jsonReply(server.postHttp, { error: "Upstream hiccup." });
        return jsonReply(200, { result: { prizeQualificationId: id, redeemedAt: server.redeemedAt.get(id), alreadyRedeemed: already } });
      }
      if (call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`)) {
        const activationId = new URL(call.url, "http://localhost").searchParams.get("venueActivationId");
        const snapshot = server.view(activationId);
        let reply: Reply;
        switch (server.getMode) {
          case "reject": reply = "reject"; break;
          case "http500": reply = jsonReply(500, { error: "Database unavailable." }); break;
          case "http403": reply = jsonReply(403, { error: "No admin authority." }); break;
          case "malformed": reply = jsonReply(200, { qualifications: "not-a-list" }); break;
          case "no-body": reply = { status: 200 }; break;
          case "absent": reply = jsonReply(200, { qualifications: snapshot.filter((q) => q.prizeQualificationId !== server.absentId) }); break;
          default: reply = jsonReply(200, { qualifications: snapshot });
        }
        if (server.heldGate) {
          const gate = server.heldGate;
          server.heldGate = null;
          await gate;
        }
        return reply;
      }
      return undefined;
    },
  };
  return server;
}
type Server = ReturnType<typeof statefulServer>;

// ---------------------------------------------------------------------------------------------------------------------------------
// A. Prizes
// ---------------------------------------------------------------------------------------------------------------------------------

describe("A. Prizes table", () => {
  it("shows Player, Prize and Status with no raw identifiers, falling back to short ids when the names are null", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    const headers = [...page.doc.querySelectorAll("#table-qualifications thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Player", "Prize", "Status", ""]);

    expect(rowFor(page, "q-pending").textContent).toContain("Maria Lopez");
    expect(rowFor(page, "q-pending").textContent).toContain("Free pitcher");
    expect(rowFor(page, "q-pending").textContent).toContain("Pending");
    expect(rowFor(page, "q-redeemed").textContent).toContain("Redeemed");
    expect(rowFor(page, "q-superseded").textContent).toContain("Superseded");

    // null name and null label fall back to the short form of the ids
    expect(rowFor(page, "q-fallback").textContent).toContain("Member 1a2b3c4d");
    expect(rowFor(page, "q-fallback").textContent).toContain("Tier 9f8e7d6c");
    expect(page.text("#table-qualifications")).not.toMatch(UUID_PATTERN);
    page.close();
  });

  it("offers Mark Redeemed only on pending, non-superseded rows, and lists pending rows first", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    expect(redeemButton(page, "q-pending")).toBeTruthy();
    expect(redeemButton(page, "q-fallback")).toBeTruthy();
    expect(redeemButton(page, "q-redeemed")).toBeNull();
    expect(redeemButton(page, "q-superseded")).toBeNull();
    expect(page.doc.querySelectorAll("#table-qualifications button")).toHaveLength(2);
    expect(redeemButton(page, "q-pending")!.textContent).toBe("Mark Redeemed");

    const order = [...page.doc.querySelectorAll("#table-qualifications tbody tr")].map((tr) => (tr as HTMLElement).dataset.status);
    expect(order).toEqual(["pending", "pending", "redeemed", "superseded"]);
    expect(page.text("#prizes-summary")).toBe("2 pending, 1 redeemed, 1 superseded.");
    page.close();
  });

  it("a superseded row that had already been redeemed says so and offers no button", async () => {
    const page = await loadPage({ qualifications: [qual({ prizeQualificationId: "q-both", redeemedAt: "x", supersededAt: "y" })] });
    await loadQualifications(page);
    expect(rowFor(page, "q-both").textContent).toContain("Superseded (was redeemed)");
    expect(redeemButton(page, "q-both")).toBeNull();
    page.close();
  });

  it("asks for confirmation naming the prize and the player, and a declined confirm makes no request", async () => {
    const page = await loadPage({ confirm: false });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(page.confirm).toHaveBeenCalledTimes(1);
    const prompt = String((page.confirm.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("Free pitcher");
    expect(prompt).toContain("Maria Lopez");
    expect(posts(page, "/redeem")).toHaveLength(0);
    expect(redeemButton(page, "q-pending")!.disabled).toBe(false);
    page.close();
  });

  it("a confirmed redeem POSTs the redeem route with the bearer token, disables the button while in flight, then reloads the table", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let redeemed = false;
    const page = await loadPage({
      respond: async (call) => {
        if (call.method === "POST" && call.url === `${API}/admin/qualifications/q-pending/redeem`) {
          await gate;
          redeemed = true;
          return jsonReply(200, { result: { prizeQualificationId: "q-pending", redeemedAt: "2026-10-24T23:30:00.000Z", alreadyRedeemed: false } });
        }
        if (call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`) && redeemed) {
          return jsonReply(200, { qualifications: DEFAULT_QUALIFICATIONS.map((q) => (q.prizeQualificationId === "q-pending" ? { ...q, redeemedAt: "2026-10-24T23:30:00.000Z" } : q)) });
        }
        return undefined;
      },
    });
    await loadQualifications(page);
    const loadsBefore = page.calls.filter((c) => c.url.startsWith(`${API}/admin/qualifications?`)).length;

    const button = redeemButton(page, "q-pending")!;
    button.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the redeem request");
    expect(button.disabled).toBe(true);
    // a second click while in flight is ignored
    button.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts(page, "/redeem")).toHaveLength(1);

    const request = posts(page, "/redeem")[0];
    expect(request.url).toBe(`${API}/admin/qualifications/q-pending/redeem`);
    expect(request.headers.authorization).toBe("Bearer stub-token");

    release();
    await page.until(() => redeemButton(page, "q-pending") === null, "the reloaded table");
    expect(page.calls.filter((c) => c.url.startsWith(`${API}/admin/qualifications?`)).length).toBe(loadsBefore + 1);
    expect(rowFor(page, "q-pending").textContent).toContain("Redeemed");
    // wording follows CONFIRMED server success: recorded first, handover only after
    expect(page.text("#msg-prizes")).toBe('Recorded on the server as redeemed: "Free pitcher for Maria Lopez". You can hand it over now.');
    expect(page.doc.getElementById("msg-prizes")!.className).toContain("success");
    page.close();
  });

  it("an idempotent repeat redeem is reported as already redeemed", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(200, { result: { prizeQualificationId: "q-pending", redeemedAt: "x", alreadyRedeemed: true } }) : undefined),
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => page.text("#msg-prizes").startsWith("Already redeemed earlier"), "the idempotent message");
    // the server only knows it was recorded before: the screen must not imply it was (or was not) physically handed over
    expect(page.text("#msg-prizes")).toMatch(/cannot tell whether it was physically handed over/);
    expect(page.text("#msg-prizes")).toMatch(/reconcile/i);
    expect(page.text("#msg-prizes")).not.toMatch(/do NOT hand over again/i);
    expect(page.doc.getElementById("msg-prizes")!.className).toContain("warning");
    expect(page.doc.getElementById("msg-prizes")!.className).not.toContain("success");
    page.close();
  });

  it.each([401, 403])("a %i failure says finalizer authority is required, shows the server message, and re-enables the button", async (status) => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(status, { error: "Platform authority CONSEQUENTIAL_FINALIZER required." }) : undefined),
    });
    await loadQualifications(page);
    const button = redeemButton(page, "q-pending")!;
    button.click();
    await page.until(() => page.text("#msg-prizes").length > 0 && !button.disabled, "the failure message");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/finalizer authority/i);
    if (status === 403) expect(message).toContain("Platform authority CONSEQUENTIAL_FINALIZER required.");
    expect(page.doc.getElementById("msg-prizes")!.className).toContain("error");
    // the row is unchanged and can be retried
    expect(rowFor(page, "q-pending").textContent).toContain("Pending");
    page.close();
  });

  // Updated for the redemption-outcome rules: a 5xx is no longer a definitive rejection (the request may have committed), so
  // this test now uses 4xx statuses, which are definitive. The 5xx and network cases are covered in H.
  it("another definitive server refusal shows the server's error text; an unreadable body falls back to the HTTP status", async () => {
    let reply: Reply = jsonReply(400, { error: "Redemption failed on the server." });
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? reply : undefined) });
    await loadQualifications(page);
    const button = redeemButton(page, "q-pending")!;
    button.click();
    await page.until(() => page.text("#msg-prizes").includes("Redemption failed on the server.") && !button.disabled, "the server message");

    reply = jsonReply(404);
    button.click();
    await page.until(() => page.text("#msg-prizes").includes("HTTP 404") && !button.disabled, "the status fallback");
    page.close();
  });

  // Updated: this used to say "Network error" and re-enable the button. A lost answer is an UNKNOWN outcome (see H), never a refusal.
  it("a network failure is shown as an unknown outcome, not swallowed and not as a refusal", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? "reject" : undefined) });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /UNKNOWN/.test(page.text("#msg-prizes")), "the unknown-outcome message");
    expect(page.text("#msg-prizes")).not.toMatch(/not marked redeemed/i);
    expect(redeemButton(page, "q-pending")).toBeNull();
    page.close();
  });

  it("an empty list and a failing load each say so", async () => {
    const empty = await loadPage({ qualifications: [] });
    (empty.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await empty.until(() => empty.text("#msg-prizes").length > 0, "the empty message");
    expect(empty.text("#msg-prizes")).toContain("No prize qualifications yet");
    empty.close();

    const denied = await loadPage({ respond: (call) => (call.url.startsWith(`${API}/admin/qualifications?`) ? jsonReply(403, { error: "No admin authority." }) : undefined) });
    (denied.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await denied.until(() => denied.text("#msg-prizes").length > 0, "the load failure");
    expect(denied.text("#msg-prizes")).toContain("No admin authority.");
    expect(denied.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    denied.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// B. Open-for-predictions control
// ---------------------------------------------------------------------------------------------------------------------------------

const classSelect = (page: Page, matchId: string) => page.doc.querySelector(`select[data-classification-for="${matchId}"]`) as HTMLSelectElement | null;
const classSave = (page: Page, matchId: string) => page.doc.querySelector(`button[data-classification-save="${matchId}"]`) as HTMLButtonElement;
const classMsg = (page: Page, matchId: string) => page.text(`[data-classification-msg="${matchId}"]`);
const classCurrent = (page: Page, matchId: string) => (classSelect(page, matchId)!.closest("td")!.querySelector(".class-current")!.textContent ?? "").trim();
const patches = (page: Page) => page.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/activity-classification"));

describe("B. Match classification control", () => {
  it("offers only Official and Trial / test run, with Official preselected for an unclassified match", async () => {
    const page = await loadPage();
    const select = classSelect(page, "m1")!;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["OFFICIAL", "Official"], ["TRAINING", "Trial / test run"]]);
    expect(select.value).toBe("OFFICIAL");
    expect(classCurrent(page, "m1")).toContain("Not set");
    expect(page.doc.querySelector('option[value="CASUAL"], option[value="RANKED"]')).toBeNull();
    page.close();
  });

  it("shows the current state per match, preselects it, and offers no control for a cancelled match", async () => {
    const page = await loadPage();
    expect(classCurrent(page, "m3")).toBe("Trial / test run");
    expect(classSelect(page, "m3")!.value).toBe("TRAINING");
    expect(classSelect(page, "m2")).toBeNull();
    expect(page.doc.querySelector('button[data-classification-save="m2"]')).toBeNull();
    page.close();
  });

  it("explains that predictions open only when the match is classified AND has an enabled venue activation", async () => {
    const page = await loadPage();
    const help = page.text("#classification-help");
    expect(help).toContain("classified");
    expect(help).toContain("enabled venue activation");
    expect(help).toContain("locks");
    page.close();
  });

  it("PATCHes the activity-classification route with the Official default as the only body field", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "PATCH" ? jsonReply(200, { result: { matchId: "m1", activityClassification: "OFFICIAL", locked: false } }) : undefined),
    });
    classSave(page, "m1").click();
    await page.until(() => classMsg(page, "m1").startsWith("Saved"), "the saved message");

    expect(patches(page)).toHaveLength(1);
    expect(patches(page)[0].url).toBe(`${API}/admin/matches/m1/activity-classification`);
    expect(patches(page)[0].body).toEqual({ activityClassification: "OFFICIAL" });
    expect(patches(page)[0].headers.authorization).toBe("Bearer stub-token");
    expect(classCurrent(page, "m1")).toBe("Official");
    expect(classMsg(page, "m1")).toContain("enabled venue activation");
    page.close();
  });

  it("sends TRAINING when Trial / test run is chosen", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "PATCH" ? jsonReply(200, { result: { matchId: "m1", activityClassification: "TRAINING", locked: false } }) : undefined),
    });
    classSelect(page, "m1")!.value = "TRAINING";
    classSave(page, "m1").click();
    await page.until(() => classMsg(page, "m1").startsWith("Saved"), "the saved message");
    expect(patches(page)[0].body).toEqual({ activityClassification: "TRAINING" });
    expect(classCurrent(page, "m1")).toBe("Trial / test run");
    page.close();
  });

  it("surfaces a 403 with the server message and the finalizer-authority requirement, and leaves the current state alone", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "PATCH" ? jsonReply(403, { error: "Platform authority CONSEQUENTIAL_FINALIZER is required." }) : undefined) });
    classSave(page, "m1").click();
    await page.until(() => classMsg(page, "m1").length > 0 && !classSave(page, "m1").disabled, "the 403 message");
    expect(classMsg(page, "m1")).toContain("Platform authority CONSEQUENTIAL_FINALIZER is required.");
    expect(classMsg(page, "m1")).toMatch(/finalizer authority/i);
    expect(classCurrent(page, "m1")).toContain("Not set");
    page.close();
  });

  it("surfaces a 409 (locked once predictions or results exist) with the server message", async () => {
    const lockedMessage = "This match already has Prediction or Result evidence and its Activity Classification cannot change.";
    const page = await loadPage({ respond: (call) => (call.method === "PATCH" ? jsonReply(409, { error: lockedMessage }) : undefined) });
    classSelect(page, "m3")!.value = "OFFICIAL";
    classSave(page, "m3").click();
    await page.until(() => classMsg(page, "m3").length > 0 && !classSave(page, "m3").disabled, "the 409 message");
    expect(classMsg(page, "m3")).toBe(lockedMessage);
    expect(page.doc.querySelector('[data-classification-msg="m3"]')!.className).toContain("error");
    expect(classCurrent(page, "m3")).toBe("Trial / test run");
    page.close();
  });

  it("disables the control while the request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page = await loadPage({
      respond: async (call) => {
        if (call.method !== "PATCH") return undefined;
        await gate;
        return jsonReply(200, { result: { matchId: "m1", activityClassification: "OFFICIAL", locked: false } });
      },
    });
    classSave(page, "m1").click();
    await page.until(() => patches(page).length === 1, "the request");
    expect(classSave(page, "m1").disabled).toBe(true);
    expect(classSelect(page, "m1")!.disabled).toBe(true);
    release();
    await page.until(() => !classSave(page, "m1").disabled, "the control to re-enable");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C. Roster paste
// ---------------------------------------------------------------------------------------------------------------------------------

const playerPosts = (page: Page, teamId = "team-a") => page.calls.filter((c) => c.method === "POST" && c.url === `${API}/admin/teams/${teamId}/players`);
const bulkText = (page: Page) => (page.doc.getElementById("msg-bulk")!.textContent ?? "").trim();

async function paste(page: Page, text: string, settledWhen = () => (page.doc.getElementById("btn-create-players") as HTMLButtonElement).disabled === false && bulkText(page).length > 0 && !bulkText(page).startsWith("Adding")) {
  (page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value = text;
  (page.doc.getElementById("btn-create-players") as HTMLButtonElement).click();
  await page.until(settledWhen, "the paste to finish");
  // the roster refresh that follows the summary
  await new Promise((r) => setTimeout(r, 20));
}

const created = (): Reply => jsonReply(201, { player: { playerId: "new", teamId: "team-a", name: "x", active: true } });

describe("C. Roster paste", () => {
  it("parses one name per line: trims, drops blanks, strips shirt numbers, and dedupes case-insensitively", async () => {
    const page = await loadPage();
    const parse = (t: string) => JSON.parse(JSON.stringify(page.win.parseRosterPaste(t)));

    expect(parse("  Lionel Messi  \n\n   \n10. Kylian Mbappé\n7 - Cristiano Ronaldo\n9) Erling Haaland\n(11) Neymar\n#5 Rodri\n4 Virgil van Dijk\n")).toEqual({
      names: ["Lionel Messi", "Kylian Mbappé", "Cristiano Ronaldo", "Erling Haaland", "Neymar", "Rodri", "Virgil van Dijk"],
      repeated: 0,
      overflow: 0,
    });
    // dedupe is case-insensitive and the first spelling wins; a shirt number does not make a duplicate distinct
    expect(parse("Pele\nPELE\n10. pele\nGarrincha")).toEqual({ names: ["Pele", "Garrincha"], repeated: 2, overflow: 0 });
    // CRLF and bare CR line endings; inner whitespace collapses; a number that is the whole line is dropped
    expect(parse("Ana  María\r\nLuis\rRoberto\r\n12\n13.\n").names).toEqual(["Ana María", "Luis", "Roberto"]);
    // a name that merely contains or starts with a digit-like token is left alone
    expect(parse("2Pac\n1234 Fan").names).toEqual(["2Pac", "1234 Fan"]);
    expect(parse("").names).toEqual([]);
    page.close();
  });

  it("caps a paste at 60 distinct names and reports the overflow", async () => {
    const page = await loadPage();
    const lines = Array.from({ length: 65 }, (_, i) => `${i + 1}. Player ${i + 1}`).join("\n");
    const parsed = JSON.parse(JSON.stringify(page.win.parseRosterPaste(lines)));
    expect(parsed.names).toHaveLength(60);
    expect(parsed.names[0]).toBe("Player 1");
    expect(parsed.names[59]).toBe("Player 60");
    expect(parsed.overflow).toBe(5);
    page.close();
  });

  it("adds each name sequentially through the existing add-player route and reports Added / Skipped / Failed", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const page = await loadPage({
      respond: async (call) => {
        if (call.method !== "POST" || !call.url.endsWith("/players")) return undefined;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return created();
      },
    });
    await paste(page, "10. Carla Gómez\n7 - Diego Ruiz\nEva Pardo\n");

    expect(playerPosts(page).map((c) => c.body)).toEqual([{ name: "Carla Gómez" }, { name: "Diego Ruiz" }, { name: "Eva Pardo" }]);
    expect(maxInFlight).toBe(1);
    expect(bulkText(page)).toBe("Alpha FC: Added 3, Skipped 0 (already on roster), Failed 0.");
    expect(page.doc.getElementById("msg-bulk")!.className).toContain("success");
    expect((page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value).toBe("");
    page.close();
  });

  it("skips active players already on the selected team's roster (case-insensitive), reports deactivated ones and in-paste repeats separately", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/players") ? created() : undefined) });
    await paste(page, "10. ana díaz\nBOB STONE\nNew Guy\nnew guy\n");

    expect(playerPosts(page).map((c) => c.body)).toEqual([{ name: "New Guy" }]);
    const text = bulkText(page);
    expect(text).toContain("Alpha FC: Added 1, Skipped 1 (already on roster), Failed 0.");
    expect(text).toContain("1 repeated name(s) in the paste were ignored.");
    expect(text).toContain("deactivated");
    expect(text).toContain("Bob Stone");
    expect(page.doc.getElementById("msg-bulk")!.className).toContain("warning");
    page.close();
  });

  it("dedupes against the SELECTED team only, and keeps that team selected after the roster refresh", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/players") ? created() : undefined) });
    const select = page.doc.getElementById("p-team") as HTMLSelectElement;
    select.value = "team-b";
    const rosterLoadsBefore = page.calls.filter((c) => c.method === "GET" && c.url === `${API}/admin/teams/team-b/players`).length;
    await paste(page, "Ana Díaz\n");

    expect(playerPosts(page, "team-b").map((c) => c.body)).toEqual([{ name: "Ana Díaz" }]);
    expect(playerPosts(page, "team-a")).toHaveLength(0);
    expect(bulkText(page)).toContain("Beta FC: Added 1");
    // the roster was re-read, and the admin is still on Beta FC (not flipped back to the first team)
    expect(page.calls.filter((c) => c.method === "GET" && c.url === `${API}/admin/teams/team-b/players`).length).toBeGreaterThan(rosterLoadsBefore);
    expect((page.doc.getElementById("p-team") as HTMLSelectElement).value).toBe("team-b");
    page.close();
  });

  it("processes at most 60 names, says how many were not processed, and keeps the paste for a second batch", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/players") ? created() : undefined) });
    await paste(page, Array.from({ length: 65 }, (_, i) => `${i + 1}. Player ${i + 1}`).join("\n"));

    expect(playerPosts(page)).toHaveLength(60);
    expect(bulkText(page)).toContain("Added 60, Skipped 0 (already on roster), Failed 0.");
    expect(bulkText(page)).toContain("5 more name(s) beyond the 60-name limit were not processed");
    expect(page.doc.getElementById("msg-bulk")!.className).toContain("error");
    expect((page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value).not.toBe("");
    page.close();
  });

  it.each([401, 403])("stops immediately on a %i, says why, and does not try the remaining names", async (status) => {
    let n = 0;
    const page = await loadPage({
      respond: (call) => {
        if (call.method !== "POST" || !call.url.endsWith("/players")) return undefined;
        n += 1;
        return n <= 2 ? created() : jsonReply(status, { error: "Platform authority OPERATIONAL required." });
      },
    });
    await paste(page, "One\nTwo\nThree\nFour\nFive");

    expect(playerPosts(page)).toHaveLength(3);
    const text = bulkText(page);
    expect(text).toContain("Stopped:");
    expect(text).toMatch(/operational authority/i);
    expect(text).toContain("Added 2, Skipped 0 (already on roster), Failed 0.");
    expect(text).toContain("3 name(s) were not added.");
    expect(page.doc.getElementById("msg-bulk")!.className).toContain("error");
    expect((page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value).toContain("Five");
    page.close();
  });

  it("reports failed names without stopping, and the button and textarea are usable again afterwards", async () => {
    const page = await loadPage({
      respond: (call) => {
        if (call.method !== "POST" || !call.url.endsWith("/players")) return undefined;
        if (call.body.name === "Zed") return jsonReply(500);
        if (call.body.name === "Yan") return jsonReply(400, { error: "Invalid player payload." });
        return created();
      },
    });
    await paste(page, "Ann\nYan\nZed\nBea");

    expect(playerPosts(page).map((c) => c.body.name)).toEqual(["Ann", "Yan", "Zed", "Bea"]);
    const text = bulkText(page);
    expect(text).toContain("Added 2, Skipped 0 (already on roster), Failed 2.");
    expect(text).toContain("Yan (Invalid player payload.)");
    expect(text).toContain("Zed (HTTP 500)");
    expect((page.doc.getElementById("btn-create-players") as HTMLButtonElement).disabled).toBe(false);
    expect((page.doc.getElementById("p-bulk") as HTMLTextAreaElement).disabled).toBe(false);
    page.close();
  });

  it("an empty paste makes no request", async () => {
    const page = await loadPage();
    (page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value = "  \n\n12.\n";
    (page.doc.getElementById("btn-create-players") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(playerPosts(page)).toHaveLength(0);
    expect(bulkText(page)).toContain("Paste at least one player name");
    page.close();
  });

  it("keeps the single Add Player control working", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/players") ? created() : undefined) });
    (page.doc.getElementById("p-name") as HTMLInputElement).value = "  Solo Player ";
    (page.doc.getElementById("btn-create-player") as HTMLButtonElement).click();
    await page.until(() => page.text("#msg-player") === "Player added.", "the single add");
    expect(playerPosts(page).map((c) => c.body)).toEqual([{ name: "Solo Player" }]);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Security: no member- or admin-controlled string reaches an HTML parser
// ---------------------------------------------------------------------------------------------------------------------------------

describe("hostile strings render as text and never create an element", () => {
  it("a member display name and a prize label in the Prizes table", async () => {
    const page = await loadPage({ qualifications: [qual({ prizeQualificationId: "q-x", memberDisplayName: HOSTILE, prizeLabel: `"><svg onload="window.__xss=1"> ${HOSTILE}` })] });
    await loadQualifications(page);
    const row = rowFor(page, "q-x");
    expect(row.querySelector("img, svg, script")).toBeNull();
    const cells = row.querySelectorAll("td");
    expect(cells[0].querySelector(".player-name")!.textContent).toBe(HOSTILE);
    expect(cells[1].textContent).toContain(HOSTILE);
    expect(page.doc.querySelector("#table-qualifications img, #table-qualifications svg")).toBeNull();
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  // Updated: the refusal now uses a 4xx (a 5xx is an unknown outcome, tested below with the same hostile text).
  it("the confirm text, server error text and success message carry the hostile name as plain text", async () => {
    const page = await loadPage({
      qualifications: [qual({ prizeQualificationId: "q-x", memberDisplayName: HOSTILE })],
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(400, { error: HOSTILE }) : undefined),
    });
    await loadQualifications(page);
    redeemButton(page, "q-x")!.click();
    await page.until(() => page.text("#msg-prizes").length > 0, "the failure message");
    expect(page.doc.getElementById("msg-prizes")!.textContent).toBe(HOSTILE);
    expect(page.doc.querySelector("#msg-prizes img")).toBeNull();
    expect(String((page.confirm.mock.calls[0] as unknown[])[0])).toContain(HOSTILE);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  it("the unknown-outcome message, the Status unknown row and the Check status messages carry hostile text as plain text", async () => {
    let checking = false;
    const page = await loadPage({
      qualifications: [qual({ prizeQualificationId: "q-x", memberDisplayName: HOSTILE, prizeLabel: HOSTILE })],
      respond: (call) => {
        if (call.method === "POST" && call.url.endsWith("/redeem")) return jsonReply(503, { error: HOSTILE });
        if (call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`) && call.url.includes("act-1") && checking) return jsonReply(500, { error: HOSTILE });
        return undefined;
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-x")!.click();
    await page.until(() => checkButton(page, "q-x") !== null, "the Check status button");
    expect(page.text("#msg-prizes")).toContain(HOSTILE);
    expect(page.doc.querySelector("#msg-prizes img, #table-qualifications img")).toBeNull();

    checking = true;
    checkButton(page, "q-x")!.click();
    await page.until(() => /could not be confirmed/.test(page.text("#msg-prizes")), "the unconfirmed message");
    expect(page.text("#msg-prizes")).toContain(HOSTILE);
    expect(page.doc.querySelector("#msg-prizes img, #table-qualifications img")).toBeNull();
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  it("team, player and competition names in the roster, matches, activations and goal-event tables and selects", async () => {
    const hostileTeams = [{ teamId: "team-a", name: HOSTILE }, { teamId: "team-b", name: "Beta FC" }];
    const page = await loadPage({
      respond: (call) => {
        if (call.method !== "GET") return undefined;
        if (call.url === `${API}/admin/teams`) return jsonReply(200, { teams: hostileTeams });
        if (call.url === `${API}/admin/teams/team-a/players`) return jsonReply(200, { players: [{ playerId: "pa1", teamId: "team-a", name: HOSTILE, active: true }] });
        if (call.url === `${API}/admin/venues`) return jsonReply(200, { venues: [{ venueId: "v1", name: HOSTILE, latitude: 1, longitude: 2, radiusMeters: 3, active: true }] });
        if (call.url === `${API}/admin/activations`) {
          return jsonReply(200, { activations: [{ matchId: "m1", venueActivationId: "act-1", enabled: true, venue: { name: HOSTILE }, prizeTiers: [{ correctDimensionCount: 1, prizeLabel: HOSTILE }] }] });
        }
        return undefined;
      },
    });
    (page.doc.getElementById("r-match") as HTMLSelectElement).value = "m1";
    (page.doc.getElementById("btn-add-goal-event") as HTMLButtonElement).click();
    await page.until(() => page.doc.querySelectorAll("#r-events-list .ge-player option").length > 0, "the goal-event row");

    expect(page.doc.querySelector("#admin-sections img, #admin-sections svg, #admin-sections script")).toBeNull();
    expect(page.doc.querySelector("#table-roster tbody tr")!.textContent).toContain(HOSTILE);
    expect(page.doc.querySelector("#table-matches tbody tr td")!.textContent).toContain(HOSTILE);
    expect(page.doc.querySelector("#table-venues tbody td")!.textContent).toBe(HOSTILE);
    expect(page.doc.querySelector("#table-activations tbody tr")!.textContent).toContain(HOSTILE);
    expect(page.doc.querySelector("#r-events-list .ge-player option")!.textContent).toContain(HOSTILE);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  it("a hostile name in the roster paste is sent as data and shown back as text", async () => {
    let pasted = false;
    const page = await loadPage({
      respond: (call) => {
        if (call.method === "POST" && call.url.endsWith("/players")) { pasted = true; return created(); }
        if (pasted && call.method === "GET" && call.url === `${API}/admin/teams/team-a/players`) return jsonReply(200, { players: [{ playerId: "pz", teamId: "team-a", name: HOSTILE, active: true }] });
        return undefined;
      },
    });
    await paste(page, HOSTILE);
    expect(playerPosts(page).map((c) => c.body)).toEqual([{ name: HOSTILE }]);
    expect(bulkText(page)).toContain("Added 1");
    expect(page.doc.querySelector("#admin-sections img")).toBeNull();
    expect(page.doc.querySelector("#table-roster tbody tr")!.textContent).toContain(HOSTILE);
    page.close();
  });

  it("the script never assigns markup: innerHTML is only ever cleared, and no other HTML-parsing sink is used", () => {
    const script = HTML.slice(HTML.indexOf("<script>"), HTML.lastIndexOf("</script>"));
    const assignments = [...script.matchAll(/\.innerHTML\s*(\+?=)\s*([^;\n)]*)/g)].map((m) => m[1] + m[2].trim());
    expect(assignments.length).toBeGreaterThan(0);
    expect(new Set(assignments)).toEqual(new Set(['=""']));
    expect(script).not.toMatch(/insertAdjacentHTML|outerHTML|document\.write|createContextualFragment|DOMParser|\beval\(/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Phone use and preserved behaviour
// ---------------------------------------------------------------------------------------------------------------------------------

describe("phone layout and preserved surface", () => {
  it("scales to the device width and keeps every table inside its own horizontal scroller", async () => {
    const page = await loadPage();
    expect(page.doc.querySelector('meta[name="viewport"]')!.getAttribute("content")).toContain("width=device-width");
    const tables = [...page.doc.querySelectorAll("table")];
    expect(tables.length).toBe(5);
    for (const table of tables) expect(table.parentElement!.classList.contains("table-wrap"), table.id).toBe(true);
    expect(HTML).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(HTML).toMatch(/textarea\s*\{[^}]*width:\s*100%/);
    expect(HTML).toMatch(/\*\s*\{\s*box-sizing:\s*border-box/);
    expect(HTML).toMatch(/@media \(max-width: 640px\)[^]*min-height:\s*44px/);
    page.close();
  });

  it("the Matches and Prizes tables stack into one card per row on a phone, with labelled cells and the Mark Redeemed button full width", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    for (const id of ["table-matches", "table-qualifications"]) expect(page.doc.getElementById(id)!.classList.contains("stack"), id).toBe(true);
    expect(HTML).toMatch(/@media \(max-width: 640px\)[^]*table\.stack thead \{ display: none; \}/);
    expect(HTML).toMatch(/table\.stack td\[data-label\]::before \{ content: attr\(data-label\)/);
    expect(HTML).toMatch(/#table-qualifications td\.cell-action button \{ width: 100%/);

    const labels = [...rowFor(page, "q-pending").querySelectorAll("td")].map((td) => td.getAttribute("data-label"));
    expect(labels).toEqual([null, "Prize", "Status", null]);
    expect(rowFor(page, "q-pending").querySelector("td")!.classList.contains("cell-primary")).toBe(true);
    expect(rowFor(page, "q-pending").querySelector("td.cell-action button")!.textContent).toBe("Mark Redeemed");
    page.close();
  });

  it("keeps every element id the page exposed before, and still loads the original sections", async () => {
    const page = await loadPage();
    const ids = [
      "btn-signin", "auth-status", "admin-sections", "t-name", "btn-create-team", "msg-team", "p-team", "p-name", "btn-create-player", "msg-player",
      "table-roster", "m-home", "m-away", "m-competition", "m-kickoff", "btn-create-match", "msg-match", "table-matches", "v-name", "v-lat", "v-lng",
      "v-radius", "btn-create-venue", "msg-venue", "table-venues", "a-match", "a-venue", "btn-create-activation", "msg-activation", "table-activations",
      "pt-activation", "pt-count", "pt-label", "btn-create-tier", "msg-tier", "r-match", "btn-load-result", "r-home", "r-away", "r-events-list",
      "btn-add-goal-event", "btn-save-draft", "btn-finalize", "msg-result", "q-activation", "btn-load-qualifications", "table-qualifications",
      "q-filter", "prizes-heading", "prizes-summary", "msg-prizes",
    ];
    for (const id of ids) expect(page.doc.getElementById(id), id).toBeTruthy();

    expect(page.doc.querySelectorAll("#table-roster tbody tr")).toHaveLength(2);
    expect(page.doc.querySelectorAll("#table-matches tbody tr")).toHaveLength(3);
    expect(page.doc.querySelector("#table-venues tbody td")!.textContent).toBe("Beer Box");
    expect(page.doc.querySelector("#table-activations tbody tr")!.textContent).toContain("2/4: Free pitcher");
    expect(page.doc.querySelectorAll("#table-activations tbody tr")).toHaveLength(3);
    expect(page.doc.querySelectorAll("#m-home option")).toHaveLength(2);
    page.close();
  });

  it("deactivating a player and cancelling a match still call their routes", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "PATCH" || call.method === "DELETE" ? jsonReply(200, {}) : undefined) });
    (page.doc.querySelector('button[data-toggle-player="pa1"]') as HTMLButtonElement).click();
    await page.until(() => page.calls.some((c) => c.method === "PATCH" && c.url === `${API}/admin/players/pa1`), "the player toggle");
    expect(page.calls.find((c) => c.url === `${API}/admin/players/pa1`)!.body).toEqual({ active: false });

    (page.doc.querySelector('button[data-cancel="m1"]') as HTMLButtonElement).click();
    await page.until(() => page.calls.some((c) => c.method === "DELETE" && c.url === `${API}/admin/matches/m1`), "the match cancel");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Roster paste: confirm before writing
// ---------------------------------------------------------------------------------------------------------------------------------

describe("C. Roster paste confirm", () => {
  it("names the target team and the number of players before writing, and a declined confirm writes nothing", async () => {
    const page = await loadPage({ confirm: false, respond: (call) => (call.method === "POST" && call.url.endsWith("/players") ? created() : undefined) });
    await paste(page, "Carla Gómez\nDiego Ruiz");
    expect(page.confirm).toHaveBeenCalledTimes(1);
    expect(String((page.confirm.mock.calls[0] as unknown[])[0])).toBe("Add 2 players to Alpha FC?");
    expect(playerPosts(page)).toHaveLength(0);
    expect(bulkText(page)).toContain("no players were added");
    expect((page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value).toContain("Carla");
    expect((page.doc.getElementById("btn-create-players") as HTMLButtonElement).disabled).toBe(false);
    page.close();
  });

  it("does not ask when there is nothing to add", async () => {
    const page = await loadPage();
    await paste(page, "Ana Díaz");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(bulkText(page)).toContain("Added 0, Skipped 1");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// D. Activations and prizes of a cancelled match
// ---------------------------------------------------------------------------------------------------------------------------------

const cancelButton = (page: Page, matchId: string) => page.doc.querySelector(`button[data-cancel="${matchId}"]`) as HTMLButtonElement;
const deletes = (page: Page) => page.calls.filter((c) => c.method === "DELETE");

describe("D. Cancelled matches keep their activations and prizes in the admin page", () => {
  it("reads activations from the admin route, not the public list, so a cancelled match's activation and prizes stay reachable", async () => {
    const page = await loadPage();
    expect(page.calls.some((c) => c.url === `${API}/matches`)).toBe(false);
    expect(page.calls.filter((c) => c.url === `${API}/admin/activations`)).toHaveLength(1);

    const options = [...page.doc.querySelectorAll("#q-activation option")] as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["act-1", "act-2", "act-3"]);
    expect(options.find((o) => o.value === "act-2")!.textContent).toContain("Cancelled");
    expect([...page.doc.querySelectorAll("#pt-activation option")].map((o) => (o as HTMLOptionElement).value)).toContain("act-2");
    expect(page.doc.querySelectorAll("#table-activations tbody tr")).toHaveLength(3);

    (page.doc.getElementById("q-activation") as HTMLSelectElement).value = "act-2";
    await loadQualifications(page);
    expect(page.calls.some((c) => c.url === `${API}/admin/qualifications?venueActivationId=act-2`)).toBe(true);
    page.close();
  });

  it("a failing activations read says so instead of leaving silent empty lists", async () => {
    const page = await loadPage({
      noActivations: true,
      respond: (call) => (call.url === `${API}/admin/activations` ? jsonReply(403, { error: "Nope." }) : undefined),
    });
    expect(page.text("#msg-activation")).toContain("Nope.");
    expect(page.text("#msg-activation")).toContain("admin authority");
    page.close();
  });

  it("Load Qualifications with no activation to choose says why instead of doing nothing", async () => {
    const page = await loadPage({ noActivations: true, respond: (call) => (call.url === `${API}/admin/activations` ? jsonReply(200, { activations: [] }) : undefined) });
    (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await page.until(() => page.text("#msg-prizes").length > 0, "the empty-select message");
    expect(page.text("#msg-prizes")).toContain("No activation to load");
    expect(page.doc.getElementById("msg-prizes")!.className).toContain("error");
    page.close();
  });

  it("Cancel names the match and asks first; a declined confirm makes no request", async () => {
    const page = await loadPage({ confirm: false });
    cancelButton(page, "m1").click();
    await new Promise((r) => setTimeout(r, 30));
    expect(page.confirm).toHaveBeenCalledTimes(1);
    const prompt = String((page.confirm.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("Alpha FC vs Beta FC");
    expect(prompt).toContain("cannot be un-cancelled");
    expect(deletes(page)).toHaveLength(0);
    expect(cancelButton(page, "m1").disabled).toBe(false);
    page.close();
  });

  it("a confirmed Cancel sends the DELETE once; a refusal is shown on the match's own card and the button is usable again", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "DELETE" ? jsonReply(403, { error: "Nope." }) : undefined) });
    const button = cancelButton(page, "m1");
    button.click();
    await page.until(() => (button.closest("td")!.querySelector(".msg")!.textContent ?? "").length > 0 && !button.disabled, "the refusal");
    expect(deletes(page)).toHaveLength(1);
    expect(button.closest("td")!.querySelector(".msg")!.textContent).toContain("Nope.");
    expect(button.closest("td")!.querySelector(".msg")!.textContent).toContain("operational authority");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// E. Labels that tell a trial from the official match
// ---------------------------------------------------------------------------------------------------------------------------------

describe("E. Match and activation labels", () => {
  const twin = (matchId: string, kickoffAt: string, activityClassification: string) => ({
    matchId, homeTeamId: "team-a", awayTeamId: "team-b", competition: "Liga", kickoffAt, cancelledAt: null, activityClassification, xpEligible: null,
  });
  const twins = [twin("t1", "2026-10-24T20:00:00.000Z", "OFFICIAL"), twin("t2", "2026-10-24T18:00:00.000Z", "TRAINING")];
  const twinResponder: Responder = (call) => {
    if (call.method !== "GET") return undefined;
    if (call.url === `${API}/admin/matches`) return jsonReply(200, { matches: twins, teams: TEAMS });
    if (call.url === `${API}/admin/activations`) {
      return jsonReply(200, { activations: twins.map((m, i) => ({ matchId: m.matchId, venueActivationId: `act-t${i + 1}`, enabled: true, venue: BEER_BOX, prizeTiers: [] })) });
    }
    return undefined;
  };

  it("two matches of the same fixture are told apart by kickoff and classification in every picker and in the activations table", async () => {
    const page = await loadPage({ respond: twinResponder });
    for (const selector of ["#r-match", "#a-match", "#pt-activation", "#q-activation"]) {
      const labels = [...page.doc.querySelectorAll(`${selector} option`)].map((o) => o.textContent ?? "");
      expect(labels, selector).toHaveLength(2);
      expect(new Set(labels).size, selector).toBe(2);
      expect(labels.filter((l) => l.includes("Official")), selector).toHaveLength(1);
      expect(labels.filter((l) => l.includes("Trial")), selector).toHaveLength(1);
      expect(labels.every((l) => l.startsWith("Alpha FC vs Beta FC - ")), selector).toBe(true);
    }
    const cells = [...page.doc.querySelectorAll("#table-activations tbody tr td:first-child")].map((td) => td.textContent ?? "");
    expect(new Set(cells).size).toBe(2);
    page.close();
  });

  it("setting a classification relabels the open pickers and the activations table", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "PATCH" ? jsonReply(200, { result: { matchId: "m1", activityClassification: "OFFICIAL", locked: false } }) : undefined),
    });
    const optionText = (selector: string) => page.doc.querySelector(selector)!.textContent ?? "";
    expect(optionText('#r-match option[value="m1"]')).toContain("Not set");
    classSave(page, "m1").click();
    await page.until(() => classMsg(page, "m1").startsWith("Saved"), "the saved message");

    expect(optionText('#r-match option[value="m1"]')).toContain("Official");
    expect(optionText('#a-match option[value="m1"]')).toContain("Official");
    expect(optionText('#q-activation option[value="act-1"]')).toContain("Official");
    expect(optionText('#pt-activation option[value="act-1"]')).toContain("Official");
    expect(optionText('#table-activations td[data-match-id="m1"]')).toContain("Official");
    page.close();
  });

  it("Create Match is disabled while the request is in flight, so a double tap creates one match", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page = await loadPage({
      respond: async (call) => {
        if (call.method === "POST" && call.url === `${API}/admin/matches`) { await gate; return jsonReply(201, { match: {} }); }
        return undefined;
      },
    });
    (page.doc.getElementById("m-home") as HTMLSelectElement).value = "team-a";
    (page.doc.getElementById("m-away") as HTMLSelectElement).value = "team-b";
    (page.doc.getElementById("m-competition") as HTMLInputElement).value = "Liga";
    (page.doc.getElementById("m-kickoff") as HTMLInputElement).value = "2026-10-24T20:00";
    const button = page.doc.getElementById("btn-create-match") as HTMLButtonElement;
    button.click();
    await page.until(() => posts(page, "/admin/matches").length === 1, "the create request");
    expect(button.disabled).toBe(true);
    button.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts(page, "/admin/matches")).toHaveLength(1);
    release();
    await page.until(() => !button.disabled && page.text("#msg-match") === "Match created.", "the created message");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F. Result: bound to its match, read before it is saved or finalized, finalized only as reviewed
// ---------------------------------------------------------------------------------------------------------------------------------

const finalizePosts = (page: Page) => posts(page, "/result/finalize");
const savePosts = (page: Page) => page.calls.filter((c) => c.method === "POST" && /\/admin\/matches\/[^/]+\/result$/.test(c.url));
const resultGets = (page: Page) => page.calls.filter((c) => c.method === "GET" && /\/admin\/matches\/[^/]+\/result$/.test(c.url));
const GOAL = { scorerPlayerId: "pa1", minuteRegulation: 10, minuteStoppage: null, isOwnGoal: false, ordinal: 1 };

interface ResultSnapshot { matchResultId: string; matchId: string; homeScore: number; awayScore: number; supersedesMatchResultId: string | null; goalEvents: Array<Record<string, any>>; contentDigest: string }
type SaveMode = "ok" | "commit-lose" | "http500" | "http400" | "http403" | "201-empty";
type FinalizeMode = "ok" | "commit-lose" | "commit-http" | "lose-uncommitted" | "http409" | "http403" | "http400" | "200-empty" | "http408";
type ResultGetMode = "ok" | "reject" | "http500" | "http403" | "malformed" | "no-body";

/**
 * A stateful stand-in for the result API of ONE match (m1 by default), following the real routes: GET returns the draft, the current finalized
 * result and the save base; a save must carry the base the last read gave; a finalize must name the draft and its digest.
 */
function resultServer(initial: { draft?: Partial<ResultSnapshot> | null; finalized?: Partial<ResultSnapshot> | null; matchId?: string } = {}) {
  const matchId = initial.matchId ?? "m1";
  let counter = 0;
  const make = (over: Partial<ResultSnapshot>): ResultSnapshot => ({
    matchResultId: "r" + ++counter, matchId, homeScore: 2, awayScore: 1, supersedesMatchResultId: null, goalEvents: [], contentDigest: "d" + counter, ...over,
  });
  const server = {
    matchId,
    draft: initial.draft ? make(initial.draft) : (null as ResultSnapshot | null),
    finalized: initial.finalized ? make(initial.finalized) : (null as ResultSnapshot | null),
    getMode: "ok" as ResultGetMode,
    saveMode: "ok" as SaveMode,
    finalizeMode: "ok" as FinalizeMode,
    gate: null as null | Promise<void>,
    saveGate: null as null | Promise<void>,
    finalizeGate: null as null | Promise<void>,
    saveCalls: 0,
    hold() { let release!: () => void; server.gate = new Promise<void>((r) => { release = r; }); return release; },
    holdSave() { let release!: () => void; server.saveGate = new Promise<void>((r) => { release = r; }); return release; },
    holdFinalize() { let release!: () => void; server.finalizeGate = new Promise<void>((r) => { release = r; }); return release; },
    base() { return server.draft ? server.draft.contentDigest : server.finalized ? "FINAL:" + server.finalized.contentDigest : "NONE"; },
    /** Someone else saves a different draft. */
    otherSave(over: Partial<ResultSnapshot> = {}) {
      server.draft = make({ ...over, supersedesMatchResultId: server.finalized ? server.finalized.matchResultId : null, matchResultId: server.draft?.matchResultId ?? "r" + ++counter });
    },
    respond: async (call: Call): Promise<Reply | undefined> => {
      const m = call.url.match(/^\/api\/gaming\/predictions\/admin\/matches\/([^/]+)\/result(\/finalize)?$/);
      if (!m || m[1] !== matchId) return undefined;
      if (call.method === "GET" && !m[2]) {
        const snapshot = { draft: server.draft, currentFinalized: server.finalized, saveBase: server.base() };
        let reply: Reply;
        switch (server.getMode) {
          case "reject": reply = "reject"; break;
          case "http500": reply = jsonReply(500, { error: "Database unavailable." }); break;
          case "http403": reply = jsonReply(403, { error: "No admin authority." }); break;
          case "malformed": reply = jsonReply(200, { draft: "nope" }); break;
          case "no-body": reply = { status: 200 }; break;
          default: reply = jsonReply(200, JSON.parse(JSON.stringify(snapshot)));
        }
        if (server.gate) { const gate = server.gate; server.gate = null; await gate; }
        return reply;
      }
      if (call.method === "POST" && !m[2]) {
        server.saveCalls += 1;
        if (server.saveGate) { const gate = server.saveGate; server.saveGate = null; await gate; }
        if (call.body.saveBase !== server.base()) return jsonReply(409, { error: "The result changed since you loaded it (it was saved, finalized or corrected); reload before saving." });
        if (server.saveMode === "http400") return jsonReply(400, { error: "Regulation-time goal events credit 0 home and 0 away, but the score is 2-1." });
        if (server.saveMode === "http403") return jsonReply(403, { error: "This action requires OPERATIONAL authority." });
        const correction = !!server.finalized;
        server.draft = make({
          matchResultId: server.draft?.matchResultId ?? "r" + ++counter, homeScore: call.body.homeScore, awayScore: call.body.awayScore,
          supersedesMatchResultId: correction ? server.finalized!.matchResultId : null,
          goalEvents: call.body.officialGoalEvents.map((e: any, i: number) => ({ ...e, ordinal: i + 1 })),
        });
        if (server.saveMode === "commit-lose") return "reject";
        if (server.saveMode === "http500") return jsonReply(500, { error: "Failed to save draft result." });
        if (server.saveMode === "201-empty") return { status: 201 };
        return jsonReply(201, { result: { ...server.draft, isCorrection: correction } });
      }
      if (call.method === "POST" && m[2]) {
        if (server.finalizeGate) { const gate = server.finalizeGate; server.finalizeGate = null; await gate; }
        const draft = server.draft;
        if (server.finalizeMode === "http403") return jsonReply(403, { error: "This action requires CONSEQUENTIAL_FINALIZER authority." });
        if (server.finalizeMode === "http400") return jsonReply(400, { error: "A correction requires a reason." });
        if (server.finalizeMode === "lose-uncommitted") return "reject";
        if (!draft || call.body.matchResultId !== draft.matchResultId || call.body.contentDigest !== draft.contentDigest || server.finalizeMode === "http409") {
          return jsonReply(409, { error: "The result changed since it was reviewed. Load it and review it again." });
        }
        server.finalized = draft;
        server.draft = null;
        if (server.finalizeMode === "commit-lose") return "reject";
        if (server.finalizeMode === "commit-http") return jsonReply(503, { error: "Upstream hiccup." });
        if (server.finalizeMode === "http408") return jsonReply(408, { error: "Request timeout." });
        if (server.finalizeMode === "200-empty") return { status: 200 };
        return jsonReply(200, { result: { matchResultId: draft.matchResultId, finalizedAt: "2026-10-25T12:00:00.000Z", alreadyFinalized: false } });
      }
      return undefined;
    },
  };
  return server;
}
type ResultServer = ReturnType<typeof resultServer>;

const setScore = (page: Page, home: string, away: string) => {
  (page.doc.getElementById("r-home") as HTMLInputElement).value = home;
  (page.doc.getElementById("r-away") as HTMLInputElement).value = away;
};
const clickFinalize = (page: Page) => (page.doc.getElementById("btn-finalize") as HTMLButtonElement).click();
const clickSave = (page: Page) => (page.doc.getElementById("btn-save-draft") as HTMLButtonElement).click();
const clickLoadResult = (page: Page) => (page.doc.getElementById("btn-load-result") as HTMLButtonElement).click();
const clickCheck = (page: Page) => (page.doc.getElementById("btn-check-finalize") as HTMLButtonElement).click();
const resultMessage = (page: Page) => page.text("#msg-result");
const setReason = (page: Page, value: string) => { (page.doc.getElementById("r-reason") as HTMLInputElement).value = value; };
const finalizeButtonsEnabled = (page: Page) => !(page.doc.getElementById("btn-finalize") as HTMLButtonElement).disabled && !(page.doc.getElementById("btn-save-draft") as HTMLButtonElement).disabled;

async function loadResultFor(page: Page, expectText: string) {
  const before = resultGets(page).length;
  clickLoadResult(page);
  await page.until(() => resultGets(page).length > before && resultMessage(page).includes(expectText), "the loaded result: " + expectText);
}

describe("F. The Result form is bound to its match and reads before it writes", () => {
  it("sends no result request until the operator presses Load, and refuses to save or finalize before that", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    expect(resultGets(page)).toHaveLength(0);
    expect(page.text("#result-state")).toContain("Press Load");

    setScore(page, "2", "1");
    clickSave(page);
    await page.until(() => resultMessage(page).length > 0, "the save refusal");
    expect(resultMessage(page)).toContain("Press Load first");
    expect(resultMessage(page)).toContain("What you typed is kept");
    expect(savePosts(page)).toHaveLength(0);

    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("Press Load to read and review"), "the finalize refusal");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(finalizePosts(page)).toHaveLength(0);
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("2");
    page.close();
  });

  it("Load shows the saved draft in the form, says what it is, and a correction draft says so", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("2");
    expect(page.doc.querySelectorAll("#r-events-list .goal-event-row")).toHaveLength(1);
    expect(page.text("#result-state")).toContain("Saved draft: Alpha FC 2-1 Beta FC");
    page.close();

    const corrected = resultServer({ finalized: { homeScore: 1, awayScore: 0 } });
    corrected.otherSave({ homeScore: 3, awayScore: 0 });
    const page2 = await loadPage({ respond: corrected.respond });
    await loadResultFor(page2, "Loaded correction draft.");
    expect(page2.text("#result-state")).toContain("Finalized result: Alpha FC 1-0 Beta FC");
    expect(page2.text("#result-state")).toContain("Saved correction draft: Alpha FC 3-0 Beta FC");
    page2.close();
  });

  it("a match with no draft says so, and a match that is already finalized says it can only be corrected", async () => {
    const empty = resultServer();
    const page = await loadPage({ respond: empty.respond });
    await loadResultFor(page, "No draft yet.");
    expect(page.text("#result-state")).toContain("No result saved yet");
    page.close();

    const finalized = resultServer({ finalized: { homeScore: 1, awayScore: 0 } });
    const page2 = await loadPage({ respond: finalized.respond });
    await loadResultFor(page2, "already has a finalized result");
    expect(resultMessage(page2)).toContain("Click Save Draft to start a correction");
    expect((page2.doc.getElementById("r-home") as HTMLInputElement).value).toBe("");
    page2.close();
  });

  it.each(["reject", "http500", "http403", "malformed", "no-body"] as const)("a failed read (%s) never says 'no draft', never wipes what is typed, and keeps saving and finalizing refused", async (mode) => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    server.getMode = mode;
    const page = await loadPage({ respond: server.respond });
    setScore(page, "5", "4");
    addGoalRow(page, "pa1", "33");
    clickLoadResult(page);
    await page.until(() => resultMessage(page).length > 0 && !resultMessage(page).includes("Loading"), "the failure message");
    expect(resultMessage(page)).not.toContain("No draft");
    expect(resultMessage(page)).toContain("left as it is");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("5");
    expect((page.doc.getElementById("r-away") as HTMLInputElement).value).toBe("4");
    expect(page.doc.querySelectorAll("#r-events-list .goal-event-row")).toHaveLength(1);

    clickSave(page);
    await page.until(() => resultMessage(page).includes("Press Load first"), "the save refusal after a failed read");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("Press Load to read and review"), "the finalize refusal after a failed read");
    expect(savePosts(page)).toHaveLength(0);
    expect(finalizePosts(page)).toHaveLength(0);
    page.close();
  });

  it("a slow answer for one match cannot fill the form of the match the operator has since chosen", async () => {
    const server = resultServer({ draft: { matchId: "m1", homeScore: 9, awayScore: 9 } });
    const page = await loadPage({ respond: (call) => server.respond(call) });
    const release = server.hold();
    clickLoadResult(page); // m1, answered late
    await page.until(() => resultGets(page).length === 1, "the first read to start");
    (page.doc.getElementById("r-match") as HTMLSelectElement).value = "m3";
    page.doc.getElementById("r-match")!.dispatchEvent(new page.win.Event("change"));
    release();
    await settle(60);
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("");
    expect(page.text("#msg-result")).not.toContain("Loaded draft");
    expect(page.text("#result-state")).toContain("Press Load");
    page.close();
  });

  it("Load asks before replacing typed input with the saved result; declining keeps what is typed and reads nothing", async () => {
    const server = resultServer({ draft: { homeScore: 2, awayScore: 1, goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    setScore(page, "9", "9"); // typed over the saved draft
    page.confirm.mockImplementation(() => false);
    const reads = resultGets(page).length;
    clickLoadResult(page);
    await page.until(() => page.confirm.mock.calls.length === 1, "the discard question");
    expect(promptOf(page)).toContain("Discard what you typed");
    await settle(30);
    expect(resultGets(page)).toHaveLength(reads);
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("9");

    page.confirm.mockImplementation(() => true);
    clickLoadResult(page);
    await page.until(() => (page.doc.getElementById("r-home") as HTMLInputElement).value === "2", "the saved draft back on screen");
    page.close();
  });

  it("Load of an unchanged saved draft needs no question", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    await loadResultFor(page, "Loaded draft.");
    expect(page.confirm).not.toHaveBeenCalled();
    page.close();
  });

  it("changing the match asks before discarding typed input; declining keeps the match and the input, accepting clears both", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond, confirm: false });
    setScore(page, "4", "4");
    const select = page.doc.getElementById("r-match") as HTMLSelectElement;
    select.value = "m3";
    select.dispatchEvent(new page.win.Event("change"));
    await page.until(() => page.confirm.mock.calls.length === 1, "the discard question");
    expect(promptOf(page)).toContain("Discard the score and goals typed");
    expect(select.value).toBe("m1");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("4");

    page.confirm.mockImplementation(() => true);
    select.value = "m3";
    select.dispatchEvent(new page.win.Event("change"));
    await page.until(() => (page.doc.getElementById("r-home") as HTMLInputElement).value === "", "the cleared form");
    expect(select.value).toBe("m3");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Press Load first"), "the unbound refusal");
    expect(savePosts(page)).toHaveLength(0);
    page.close();
  });

  it("a reload of the lists (a sign-in event for the same admin) keeps the chosen match and what is typed, and a save goes only to that match", async () => {
    const server = resultServer({ matchId: "m3", draft: { matchId: "m3", goalEvents: [] } });
    const page = await loadPage({ respond: server.respond });
    const select = page.doc.getElementById("r-match") as HTMLSelectElement;
    select.value = "m3";
    select.dispatchEvent(new page.win.Event("change"));
    await loadResultFor(page, "Loaded draft.");
    setScore(page, "7", "0");

    const matchGets = page.calls.filter((c) => c.method === "GET" && c.url === `${API}/admin/matches`).length;
    page.fireAuthEvent();
    await page.until(() => page.calls.filter((c) => c.method === "GET" && c.url === `${API}/admin/matches`).length > matchGets, "the lists to reload");
    await settle(40);
    expect(select.value).toBe("m3");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("7");

    clickSave(page);
    await page.until(() => savePosts(page).length === 1, "the save");
    expect(savePosts(page)[0].url).toBe(`${API}/admin/matches/m3/result`);
    expect(savePosts(page)[0].body.homeScore).toBe(7);
    page.close();
  });
});

function addGoalRow(page: Page, playerId: string, minute: string) {
  (page.doc.getElementById("btn-add-goal-event") as HTMLButtonElement).click();
  const rows = page.doc.querySelectorAll("#r-events-list .goal-event-row");
  const row = rows[rows.length - 1];
  (row.querySelector(".ge-player") as HTMLSelectElement).value = playerId;
  (row.querySelector(".ge-minute") as HTMLInputElement).value = minute;
}

describe("F. Save Draft", () => {
  it("sends the scores, the goals and the save base the last read returned; the page reads the draft back and says it was saved", async () => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "1", "0");
    addGoalRow(page, "pa1", "20");
    clickSave(page);
    await page.until(() => resultMessage(page) === "Draft saved.", "the saved message");
    expect(savePosts(page)).toHaveLength(1);
    expect(savePosts(page)[0].body).toEqual({ homeScore: 1, awayScore: 0, saveBase: "NONE", officialGoalEvents: [{ scorerPlayerId: "pa1", minuteRegulation: 20, minuteStoppage: null, isOwnGoal: false }] });
    expect(page.doc.getElementById("msg-result")!.className).toContain("success");
    expect(page.text("#result-state")).toContain("Saved draft: Alpha FC 1-0 Beta FC");
    page.close();
  });

  it("starting a correction of a finalized result says it is a correction and that finalizing it needs a reason", async () => {
    const server = resultServer({ finalized: { homeScore: 1, awayScore: 0 } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "already has a finalized result");
    setScore(page, "2", "0");
    addGoalRow(page, "pa1", "20");
    addGoalRow(page, "pa1", "55");
    clickSave(page);
    await page.until(() => resultMessage(page).startsWith("Correction draft saved"), "the saved correction");
    expect(savePosts(page)[0].body.saveBase).toBe("FINAL:" + server.finalized!.contentDigest);
    expect(resultMessage(page)).toContain("with a reason");
    page.close();
  });

  it("a save over a result that changed since it was loaded is refused: what is typed stays, the page asks for a fresh load, and saving and finalizing wait", async () => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    server.otherSave({ homeScore: 3, awayScore: 3 }); // a colleague saved in the meantime
    setScore(page, "1", "0");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Press Load to see the current result"), "the stale refusal");
    expect(resultMessage(page)).toContain("nothing was saved");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("1");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    clickSave(page);
    await page.until(() => savePosts(page).length >= 1 && resultMessage(page).includes("Press Load first"), "the second attempt refused locally");
    expect(savePosts(page)).toHaveLength(1);
    page.close();
  });

  it("a rejected save (the goals do not add up) shows the server's reason, keeps everything typed, and saves nothing", async () => {
    const server = resultServer();
    server.saveMode = "http400";
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "1");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Regulation-time goal events"), "the server reason");
    expect(resultMessage(page)).toContain("still on screen");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("2");
    expect(server.draft).toBeNull();
    expect(finalizeButtonsEnabled(page)).toBe(true);
    page.close();
  });

  it("a 403 says operational authority is needed", async () => {
    const server = resultServer();
    server.saveMode = "http403";
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "1");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("OPERATIONAL authority"), "the authority message");
    page.close();
  });

  it("an answer that never arrives: the draft may or may not be saved, the typed values stay, and the page insists on a fresh read before anything else", async () => {
    const server = resultServer();
    server.saveMode = "commit-lose";
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "1");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("may or may not have been saved"), "the unknown-save message");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("2");
    expect(finalizeButtonsEnabled(page)).toBe(true);
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Press Load first"), "the refusal to save again blind");
    expect(savePosts(page)).toHaveLength(1);
    page.close();
  });

  it("a 201 without the saved draft's details is not trusted", async () => {
    const server = resultServer();
    server.saveMode = "201-empty";
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "1");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("without the saved draft's details"), "the untrusted answer");
    page.close();
  });

  it("a double press sends one request, even when the second press arrives before the first has disabled the button", async () => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "1");
    const button = page.doc.getElementById("btn-save-draft") as HTMLButtonElement;
    const release = server.holdSave();
    button.click();
    button.disabled = false; // the same-tick second press, as if the first press had not disabled it yet
    button.click();
    await page.until(() => savePosts(page).length >= 1, "the save");
    await settle(30);
    expect(savePosts(page)).toHaveLength(1);
    release();
    await page.until(() => resultMessage(page) === "Draft saved.", "the saved message");
    page.close();
  });

  it.each([
    ["blank scores", "", "", "whole numbers"],
    ["a fractional score", "2.5", "1", "whole numbers"],
    ["a negative score", "-1", "0", "whole numbers"],
  ])("refuses %s before any request", async (_label, home, away, expected) => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, home, away);
    clickSave(page);
    await page.until(() => resultMessage(page).includes(expected), "the validation message");
    expect(savePosts(page)).toHaveLength(0);
    page.close();
  });

  it("refuses a goal with no minute, a minute over 120 or an invalid stoppage before any request", async () => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "1", "0");
    addGoalRow(page, "pa1", "");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Goal 1 needs a whole minute"), "the minute message");
    (page.doc.querySelector(".ge-minute") as HTMLInputElement).value = "121";
    clickSave(page);
    await page.until(() => resultMessage(page).includes("from 1 to 120"), "the range message");
    (page.doc.querySelector(".ge-minute") as HTMLInputElement).value = "45";
    (page.doc.querySelector(".ge-stoppage") as HTMLInputElement).value = "-2";
    clickSave(page);
    await page.until(() => resultMessage(page).includes("invalid stoppage"), "the stoppage message");
    expect(savePosts(page)).toHaveLength(0);
    page.close();
  });

  it("shows which goals count toward the score (up to minute 90, own goals for the other team) and warns when the typed score disagrees", async () => {
    const server = resultServer();
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "No draft yet.");
    setScore(page, "2", "0");
    addGoalRow(page, "pa1", "20");
    addGoalRow(page, "pa1", "105");
    page.doc.getElementById("r-events-list")!.dispatchEvent(new page.win.Event("input", { bubbles: true }));
    expect(page.text("#r-tally")).toContain("Alpha FC 1 - 0 Beta FC");
    expect(page.text("#r-tally")).toContain("1 goal after minute 90 is kept as evidence but not counted");
    expect(page.text("#r-tally")).toContain("The score typed above is 2-0");
    expect(page.doc.getElementById("r-tally")!.className).toContain("warning");
    // an own goal by an Alpha player counts for Beta
    const own = page.doc.querySelectorAll("#r-events-list .goal-event-row")[1];
    (own.querySelector(".ge-minute") as HTMLInputElement).value = "60";
    (own.querySelector(".ge-own-goal") as HTMLInputElement).checked = true;
    own.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.text("#r-tally")).toContain("Alpha FC 1 - 1 Beta FC");
    expect(HTML).toContain("score after 90 minutes plus stoppage time");
    page.close();
  });
});

describe("F. Finalize", () => {
  async function loaded(server: ResultServer, over: { confirm?: boolean } = {}) {
    const page = await loadPage({ respond: server.respond, confirm: over.confirm });
    await loadResultFor(page, "Loaded");
    return page;
  }

  it("refuses when there is no saved draft: no confirm, no finalize request, and it says what to do", async () => {
    const page = await loadPage({ respond: resultServer().respond });
    await loadResultFor(page, "No draft yet.");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("no saved draft"), "the refusal");
    expect(resultMessage(page)).toContain("Save Draft");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(finalizePosts(page)).toHaveLength(0);
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    page.close();
  });

  it("a match that already has a finalized result and no draft is not finalized again: it says to correct", async () => {
    const page = await loadPage({ respond: resultServer({ finalized: { homeScore: 1, awayScore: 0 } }).respond });
    await loadResultFor(page, "already has a finalized result");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("already has a finalized result and no draft"), "the refusal");
    expect(finalizePosts(page)).toHaveLength(0);
    page.close();
  });

  it("a BLANK form is not the saved draft: reopening the page and pressing Finalize settles nothing", async () => {
    const page = await loaded(resultServer({ draft: { goalEvents: [GOAL] } }));
    setScore(page, "", "");
    page.doc.getElementById("r-events-list")!.innerHTML = "";
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("not the saved draft"), "the refusal");
    expect(resultMessage(page)).toContain("Nothing was finalized");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(finalizePosts(page)).toHaveLength(0);
    page.close();
  });

  it("refuses when the score or the goals on screen are not the saved draft", async () => {
    const page = await loaded(resultServer({ draft: { goalEvents: [GOAL] } }));
    setScore(page, "3", "1");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("not the saved draft (2-1)"), "the score refusal");
    setScore(page, "2", "1");
    page.doc.getElementById("r-events-list")!.innerHTML = "";
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("not the saved draft") && page.confirm.mock.calls.length === 0, "the goals refusal");
    expect(finalizePosts(page)).toHaveLength(0);
    page.close();
  });

  it("the confirm lists the score and every goal (scorer, minute, own goal, extra time); a declined confirm finalizes nothing", async () => {
    const goals = [
      GOAL,
      { scorerPlayerId: "pa2", minuteRegulation: 45, minuteStoppage: 3, isOwnGoal: true, ordinal: 2 },
      { scorerPlayerId: "pa1", minuteRegulation: 105, minuteStoppage: null, isOwnGoal: false, ordinal: 3 },
    ];
    const page = await loaded(resultServer({ draft: { homeScore: 1, awayScore: 1, goalEvents: goals } }), { confirm: false });
    clickFinalize(page);
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    await settle(20);
    const prompt = promptOf(page);
    expect(prompt).toContain("Alpha FC 1-1 Beta FC");
    expect(prompt).toContain("10' Ana Díaz (Alpha FC)");
    expect(prompt).toContain("45+3' Bob Stone (Alpha FC) (own goal)");
    expect(prompt).toContain("105' Ana Díaz (Alpha FC) - extra time, not counted");
    expect(prompt).toContain("Not set");
    expect(prompt).not.toContain("WARNING");
    expect(finalizePosts(page)).toHaveLength(0);
    expect(finalizeButtonsEnabled(page)).toBe(true);
    page.close();
  });

  it("finalizes exactly the reviewed draft: the request names it and its digest, and no fresh read happens in between", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loaded(server);
    const readsBefore = resultGets(page).length;
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    expect(finalizePosts(page)[0].body).toEqual({ matchResultId: server.finalized!.matchResultId, contentDigest: server.finalized!.contentDigest });
    expect(resultGets(page).length).toBeLessThanOrEqual(readsBefore + 1); // only the read-back after success may follow
    page.close();
  });

  it("disables both buttons in flight, sends one request for a double press, and echoes the match and score", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loaded(server);
    const release = server.holdFinalize();
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    expect((page.doc.getElementById("btn-finalize") as HTMLButtonElement).disabled).toBe(true);
    expect((page.doc.getElementById("btn-save-draft") as HTMLButtonElement).disabled).toBe(true);
    (page.doc.getElementById("btn-finalize") as HTMLButtonElement).disabled = false; // a press that slips past the disabled button
    clickFinalize(page);
    await settle(10);
    expect(finalizePosts(page)).toHaveLength(1);

    release();
    await page.until(() => resultMessage(page).startsWith("Finalized"), "the result message");
    expect(resultMessage(page)).toBe("Finalized: Alpha FC 2-1 Beta FC.");
    expect(page.doc.getElementById("msg-result")!.className).toContain("success");
    expect(finalizeButtonsEnabled(page)).toBe(true);
    expect(page.text("#result-state")).toContain("Finalized result: Alpha FC 2-1 Beta FC");
    page.close();
  });

  it("a colleague's save after the review is NOT finalized: the request carries the reviewed digest, the server refuses it, and the page asks for a fresh review", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loaded(server);
    const reviewedDigest = server.draft!.contentDigest;
    server.otherSave({ homeScore: 9, awayScore: 0, matchResultId: server.draft!.matchResultId });
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("changed"), "the refusal");
    expect(finalizePosts(page)[0].body.contentDigest).toBe(reviewedDigest);
    expect(resultMessage(page)).toContain("Nothing was finalized");
    expect(resultMessage(page)).toContain("Press Load to review the current result");
    expect(server.finalized).toBeNull();
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("Press Load to read and review"), "the local refusal until reloaded");
    expect(finalizePosts(page)).toHaveLength(1);
    page.close();
  });

  it("warns in the confirm when the match's activation has no prize tiers, and when it has no activation at all", async () => {
    const server = resultServer({ matchId: "m3", draft: { matchId: "m3", goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    (page.doc.getElementById("r-match") as HTMLSelectElement).value = "m3";
    page.doc.getElementById("r-match")!.dispatchEvent(new page.win.Event("change"));
    await loadResultFor(page, "Loaded draft.");
    clickFinalize(page);
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    const prompt = promptOf(page);
    expect(prompt).toContain("WARNING");
    expect(prompt).toContain("no prize tiers");
    expect(prompt).toContain("Beer Box");
    expect(prompt).toContain("Trial");
    page.close();

    const bareServer = resultServer({ draft: { goalEvents: [GOAL] } });
    const bare = await loadPage({ noActivations: true, respond: (call) => (call.url === `${API}/admin/activations` ? jsonReply(200, { activations: [] }) : bareServer.respond(call)) });
    await loadResultFor(bare, "Loaded draft.");
    clickFinalize(bare);
    await bare.until(() => bare.confirm.mock.calls.length === 1, "the confirm");
    expect(promptOf(bare)).toContain("no venue activation");
    bare.close();
  });

  it("a refusal shows the server's authority message once, and the buttons are usable again", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    server.finalizeMode = "http403";
    const page = await loaded(server);
    clickFinalize(page);
    await page.until(() => resultMessage(page).length > 0 && finalizeButtonsEnabled(page) && !resultMessage(page).includes("Finalizing"), "the refusal");
    expect(resultMessage(page)).toBe("This action requires CONSEQUENTIAL_FINALIZER authority.");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    page.close();
  });
});

describe("F2. Correcting a finalized result needs a reason", () => {
  const CORRECTION = (): ResultServer => {
    const server = resultServer({ finalized: { homeScore: 1, awayScore: 0 } });
    server.otherSave({ homeScore: 2, awayScore: 1, goalEvents: [GOAL] });
    return server;
  };
  const loadedCorrection = async (server = CORRECTION(), confirm = true) => {
    const page = await loadPage({ respond: server.respond, confirm });
    await loadResultFor(page, "Loaded correction draft.");
    return page;
  };

  it("a correction with no reason is stopped before any confirm or request, says why, and puts the cursor in the Reason box", async () => {
    const page = await loadedCorrection();
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("A correction needs a reason"), "the refusal");
    expect(resultMessage(page)).toContain("Nothing was finalized");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(finalizePosts(page)).toHaveLength(0);
    expect(page.doc.activeElement?.id).toBe("r-reason");
    expect(finalizeButtonsEnabled(page)).toBe(true);
    page.close();
  });

  it("a whitespace-only reason counts as no reason", async () => {
    const page = await loadedCorrection();
    setReason(page, "   \n  ");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("A correction needs a reason"), "the refusal");
    expect(finalizePosts(page)).toHaveLength(0);
    page.close();
  });

  it("a correction with a reason shows it in the confirm with the prize rule, sends it with the reviewed digest, says it was a correction, and clears the box", async () => {
    const server = CORRECTION();
    const page = await loadedCorrection(server);
    const digest = server.draft!.contentDigest;
    const id = server.draft!.matchResultId;
    setReason(page, "  Wrong   scorer entered  ");
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    const prompt = promptOf(page);
    expect(prompt).toContain("CORRECTION");
    expect(prompt).toContain("Reason: Wrong scorer entered");
    expect(prompt).toContain("never handed over twice");
    expect(finalizePosts(page)[0].body).toEqual({ matchResultId: id, contentDigest: digest, reason: "Wrong scorer entered" });
    await page.until(() => resultMessage(page).startsWith("Correction finalized"), "the result message");
    expect(resultMessage(page)).toBe("Correction finalized: Alpha FC 2-1 Beta FC.");
    expect((page.doc.getElementById("r-reason") as HTMLInputElement).value).toBe("");
    page.close();
  });

  it("a first finalization needs no reason and sends none", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    expect(Object.keys(finalizePosts(page)[0].body).sort()).toEqual(["contentDigest", "matchResultId"]);
    expect(promptOf(page)).not.toContain("Reason:");
    await page.until(() => resultMessage(page).startsWith("Finalized"), "the result message");
    expect(resultMessage(page)).toBe("Finalized: Alpha FC 2-1 Beta FC.");
    page.close();
  });

  it("a reason typed on a first finalization is optional but is sent when present", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    setReason(page, "Official FIFA sheet");
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    expect(finalizePosts(page)[0].body.reason).toBe("Official FIFA sheet");
    page.close();
  });

  it("a refused correction keeps the typed reason so the operator can retry", async () => {
    const server = CORRECTION();
    server.finalizeMode = "http400";
    const page = await loadedCorrection(server);
    setReason(page, "Own goal was a goal for the other side");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("requires a reason") && finalizeButtonsEnabled(page), "the refusal");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    expect((page.doc.getElementById("r-reason") as HTMLInputElement).value).toBe("Own goal was a goal for the other side");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// G. The prize list
// ---------------------------------------------------------------------------------------------------------------------------------

const promptOf = (page: Page, call = 0) => String((page.confirm.mock.calls[call] as unknown[])[0]);

describe("G. Prize outcomes stay visible and stale rows are not tappable", () => {
  it("the outcome banner sticks to the top of the screen so a failure far down the list is not off-screen", () => {
    expect(HTML).toMatch(/#msg-prizes\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
    expect(HTML).toMatch(/#msg-prizes:empty\s*\{\s*display:\s*none/);
    expect(HTML).toMatch(/\.msg\.warning\s*\{/);
    expect(HTML).toMatch(/tr\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it("a 409 (superseded) reloads the list, the stale row loses its Mark Redeemed button, and the message says not to hand the prize over", async () => {
    let superseded = false;
    const page = await loadPage({
      respond: (call) => {
        if (call.method === "POST" && call.url.endsWith("/redeem")) {
          superseded = true;
          return jsonReply(409, { error: "This qualification is no longer supported by the current result." });
        }
        if (call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`) && superseded) {
          return jsonReply(200, { qualifications: DEFAULT_QUALIFICATIONS.map((q) => (q.prizeQualificationId === "q-pending" ? { ...q, supersededAt: "2026-10-25T02:00:00.000Z" } : q)) });
        }
        return undefined;
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending") === null && page.text("#msg-prizes").length > 0, "the refreshed list");

    expect(page.text("#msg-prizes")).toContain("no longer supported by the current result.");
    expect(page.text("#msg-prizes")).toContain("Do NOT hand over");
    expect(page.doc.getElementById("msg-prizes")!.className).toContain("error");
    expect(rowFor(page, "q-pending").textContent).toContain("Superseded");
    page.close();
  });

  it("a 403 carrying the server's own authority sentence is shown once, not followed by a second one", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(403, { error: "This action requires CONSEQUENTIAL_FINALIZER authority." }) : undefined),
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => page.text("#msg-prizes").length > 0, "the refusal");
    expect(page.text("#msg-prizes")).toBe("This action requires CONSEQUENTIAL_FINALIZER authority.");
    page.close();
  });
});

describe("G. Telling winners apart and finding one", () => {
  const MEMBER_A = "aaaaaaaa-1111-4222-8333-444455556666";
  const MEMBER_B = "bbbbbbbb-1111-4222-8333-444455556666";

  it("two different members with the same display name are told apart in the row, the confirm and the result message", async () => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(200, { result: { prizeQualificationId: "q-b", redeemedAt: "x", alreadyRedeemed: false } }) : undefined),
      qualifications: [
        qual({ prizeQualificationId: "q-a", gamingMemberId: MEMBER_A, memberDisplayName: "Juan Perez" }),
        qual({ prizeQualificationId: "q-b", gamingMemberId: MEMBER_B, memberDisplayName: "Juan  Perez" }),
        qual({ prizeQualificationId: "q-c", gamingMemberId: MEMBER_B, memberDisplayName: "Juan Perez", supersededAt: "2026-10-25T01:00:00.000Z" }),
        qual({ prizeQualificationId: "q-d", gamingMemberId: "cccccccc-1", memberDisplayName: "Solo Name" }),
      ],
    });
    await loadQualifications(page);
    expect(rowFor(page, "q-a").querySelector(".player-name")!.textContent).toBe("Juan Perez (member aaaaaaaa)");
    expect(rowFor(page, "q-b").querySelector(".player-name")!.textContent).toBe("Juan Perez (member bbbbbbbb)");
    expect(rowFor(page, "q-d").querySelector(".player-name")!.textContent).toBe("Solo Name");

    redeemButton(page, "q-b")!.click();
    await page.until(() => page.text("#msg-prizes").startsWith("Recorded on the server"), "the result");
    expect(promptOf(page)).toContain("Player: Juan Perez (member bbbbbbbb)");
    expect(page.text("#msg-prizes")).toContain("Juan Perez (member bbbbbbbb)");
    page.close();
  });

  it("the same member appearing twice (a superseded and a current qualification) is not flagged as a name clash", async () => {
    const page = await loadPage({
      qualifications: [
        qual({ prizeQualificationId: "q-1", gamingMemberId: MEMBER_A, memberDisplayName: "Maria Lopez" }),
        qual({ prizeQualificationId: "q-2", gamingMemberId: MEMBER_A, memberDisplayName: "Maria Lopez", supersededAt: "x" }),
      ],
    });
    await loadQualifications(page);
    expect(rowFor(page, "q-1").querySelector(".player-name")!.textContent).toBe("Maria Lopez");
    page.close();
  });

  it("collapses whitespace and newlines in a display name so it cannot add lines to the confirm text", async () => {
    const page = await loadPage({ qualifications: [qual({ prizeQualificationId: "q-n", memberDisplayName: "Eve\nPlayer: Forged\tName" })] });
    await loadQualifications(page);
    redeemButton(page, "q-n")!.click();
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    const lines = promptOf(page).split("\n");
    expect(lines.filter((l) => l.startsWith("Player:"))).toEqual(["Player: Eve Player: Forged Name"]);
    page.close();
  });

  const ROSTER = [
    qual({ prizeQualificationId: "q-jose", gamingMemberId: "m-1", memberDisplayName: "José Díaz" }),
    qual({ prizeQualificationId: "q-carlos", gamingMemberId: "m-2", memberDisplayName: "Carlos Ruiz" }),
    qual({ prizeQualificationId: "q-ana", gamingMemberId: "m-3", memberDisplayName: "Ana Pérez" }),
    qual({ prizeQualificationId: "q-done", gamingMemberId: "m-4", memberDisplayName: "Aaron Done", redeemedAt: "x" }),
  ];

  it("sorts pending winners by name, then the rest, so a name can be found without hunting", async () => {
    const page = await loadPage({ qualifications: ROSTER });
    await loadQualifications(page);
    const order = [...page.doc.querySelectorAll("#table-qualifications tbody tr")].map((tr) => (tr as HTMLElement).dataset.qualification);
    expect(order).toEqual(["q-ana", "q-carlos", "q-jose", "q-done"]);
    page.close();
  });

  it("a name filter hides the other cards, ignores case and accents, survives a reload, and says how many match", async () => {
    const page = await loadPage({ qualifications: ROSTER });
    await loadQualifications(page);
    const filter = page.doc.getElementById("q-filter") as HTMLInputElement;
    filter.value = "  JOSE ";
    filter.dispatchEvent(new page.win.Event("input", { bubbles: true }));

    const visible = () => [...page.doc.querySelectorAll("#table-qualifications tbody tr")].filter((tr) => !(tr as HTMLElement).hidden).map((tr) => (tr as HTMLElement).dataset.qualification);
    expect(visible()).toEqual(["q-jose"]);
    expect(page.text("#prizes-summary")).toContain("3 pending, 1 redeemed, 0 superseded.");
    expect(page.text("#prizes-summary")).toContain("Showing 1");

    (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await page.until(() => page.calls.filter((c) => c.url.startsWith(`${API}/admin/qualifications?`)).length === 2, "the reload");
    await new Promise((r) => setTimeout(r, 20));
    expect(visible()).toEqual(["q-jose"]);

    filter.value = "";
    filter.dispatchEvent(new page.win.Event("input", { bubbles: true }));
    expect(visible()).toHaveLength(4);
    expect(page.text("#prizes-summary")).not.toContain("Showing");
    page.close();
  });

  it("names the loaded match above the list, and changing the selected activation clears the list instead of leaving it under a new name", async () => {
    const page = await loadPage({ qualifications: ROSTER });
    await loadQualifications(page);
    expect(page.text("#prizes-heading")).toContain("Prizes for: Alpha FC vs Beta FC");
    expect(page.text("#prizes-heading")).toContain("Beer Box");

    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.text("#prizes-heading")).toBe("");
    expect(page.text("#prizes-summary")).toBe("");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// H. A redeem attempt whose outcome cannot be known
//
// A lost answer does not prove the server refused: the POST may have committed. Staff must never be told "not redeemed", must withhold
// the prize, and may settle the doubt only with an explicit, successful Check status read. These tests use a stateful server so the
// recorded redemption is real while the response is lost.
// ---------------------------------------------------------------------------------------------------------------------------------

async function unknownPage(postMode: PostMode = "commit-lose", serverOpts: Parameters<typeof statefulServer>[0] = {}) {
  const server = statefulServer(serverOpts);
  server.postMode = postMode;
  const page = await loadPage({ respond: server.respond });
  await loadQualifications(page);
  redeemButton(page, "q-pending")!.click();
  await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
  return { server, page };
}

async function clickLoad(page: Page) {
  (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
}

describe("H. Redeem outcome unknown", () => {
  it("(a) a lost answer is UNKNOWN even though the server recorded it: no 'not marked redeemed', handover withheld, exactly one POST, only Check status on the row", async () => {
    const { server, page } = await unknownPage("commit-lose");
    expect(server.redeemedAt.has("q-pending")).toBe(true); // the redemption really was committed

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/UNKNOWN/);
    expect(message).toMatch(/may or may not be recorded as redeemed/);
    expect(message).toMatch(/withhold/i);
    expect(message).toMatch(/Check status/);
    expect(message).toContain("Free pitcher for Maria Lopez");
    expect(message).not.toMatch(/not marked redeemed/i);
    expect(banner(page).className).toContain("error");

    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(rowFor(page, "q-pending").dataset.status).toBe("unknown");
    expect(rowButtons(page, "q-pending").map((b) => b.textContent)).toEqual(["Check status"]);
    expect(redeemButton(page, "q-pending")).toBeNull();
    // the other winners are untouched and the unknown row sorts first, where it cannot hide in a long list
    expect(redeemButton(page, "q-fallback")).toBeTruthy();
    expect([...page.doc.querySelectorAll("#table-qualifications tbody tr")][0]).toBe(rowFor(page, "q-pending"));
    expect(page.text("#prizes-summary")).toBe("1 status unknown, 1 pending, 1 redeemed, 1 superseded.");

    // nothing replays the POST on its own
    await settle(80);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(b) Check status then showing redeemed: a reconcile warning that infers nothing about handover, still one POST in total, no Mark Redeemed", async () => {
    const { page } = await unknownPage("commit-lose");
    const getsBefore = qualGets(page).length;
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the reconcile state");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/cannot tell whether that was your earlier tap or someone else's/);
    expect(message).toMatch(/nor whether the prize was already physically handed over/);
    expect(message).toMatch(/Reconcile with the winner and your colleagues before handing anything over/);
    expect(message).not.toMatch(/do NOT hand over again/i);
    expect(message).not.toMatch(/not marked redeemed/i);
    expect(banner(page).className).toContain("warning");
    expect(banner(page).className).not.toContain("success");

    expect(qualGets(page)).toHaveLength(getsBefore + 1); // exactly one explicit read
    expect(posts(page, "/redeem")).toHaveLength(1);
    expect(rowFor(page, "q-pending").dataset.status).toBe("redeemed");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);

    // the reconcile mark survives an ordinary reload
    await clickLoad(page);
    await page.until(() => qualGets(page).length === getsBefore + 2, "the reload");
    await settle();
    expect(pillOf(page, "q-pending")).toBe("Redeemed - reconcile");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    page.close();
  });

  it("Check status reads the row's own activation, not whatever the select says, and is one GET", async () => {
    const { page } = await unknownPage("commit-lose", { qualifications: [qual({ prizeQualificationId: "q-pending", venueActivationId: "act-7" })] });
    expect((page.doc.getElementById("q-activation") as HTMLSelectElement).value).toBe("act-1");
    expect(qualGets(page)[0].url).toContain("venueActivationId=act-1");
    const before = qualGets(page).length;
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the answer");
    const reads = qualGets(page).slice(before);
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toBe(`${API}/admin/qualifications?venueActivationId=act-7`);
    expect(reads[0].headers.authorization).toBe("Bearer stub-token");
    page.close();
  });

  it("pressing Check status again while its read is in flight sends no second request", async () => {
    const { server, page } = await unknownPage("commit-lose");
    const before = qualGets(page).length;
    const release = server.hold();
    const button = checkButton(page, "q-pending")!;
    button.click();
    await page.until(() => qualGets(page).length === before + 1, "the read");
    expect(button.disabled).toBe(true);
    button.click();
    await settle();
    expect(qualGets(page)).toHaveLength(before + 1);
    release();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the answer");
    page.close();
  });

  it.each([
    ["a network failure", "reject", /the connection failed/],
    ["HTTP 500", "http500", /HTTP 500 \(Database unavailable\.\)/],
    ["a 403", "http403", /admin authority/],
    ["a 200 with a malformed body", "malformed", /could not be read/],
    ["a 200 with no JSON body", "no-body", /could not be read/],
    ["a 200 that does not list the row", "absent", /not in the server's list/],
  ] as const)("(c) a status read that fails (%s) leaves the outcome unknown: no Mark Redeemed, handover withheld, Check status usable again", async (_label, mode, reason) => {
    const { server, page } = await unknownPage("commit-lose");
    server.getMode = mode;
    server.absentId = "q-pending";
    checkButton(page, "q-pending")!.click();
    await page.until(() => /could not be confirmed/.test(page.text("#msg-prizes")), "the unconfirmed message");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(reason);
    expect(message).toMatch(/still UNKNOWN/);
    expect(message).toMatch(/handover stays withheld/);
    expect(message).toMatch(/Do NOT hand over/);
    expect(message).not.toMatch(/not marked redeemed/i);
    expect(banner(page).className).toContain("error");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")!.disabled).toBe(false);
    expect(posts(page, "/redeem")).toHaveLength(1);

    // pressing it again, once the server answers, settles it
    server.getMode = "ok";
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the settled state");
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(d) Check status showing pending returns Mark Redeemed with wording that the earlier request could still land; a deliberate second tap is safe and confirmed on 200", async () => {
    const { server, page } = await unknownPage("lose-uncommitted");
    expect(server.redeemedAt.size).toBe(0);
    checkButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending") !== null, "Mark Redeemed to return");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/NOT redeemed/);
    expect(message).toMatch(/The earlier request could still be recorded/);
    expect(message).toMatch(/hand over only after this screen confirms a fresh redemption/);
    expect(message).toMatch(/pressing it is safe/);
    expect(banner(page).className).toContain("warning");
    expect(pillOf(page, "q-pending")).toBe("Pending");
    expect(checkButton(page, "q-pending")).toBeNull();
    expect(page.confirm).toHaveBeenCalledTimes(1);
    expect(posts(page, "/redeem")).toHaveLength(1);

    // the deliberate second tap asks again, sends a second POST, and the 200 reads as confirmed success
    server.postMode = "ok";
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /^Recorded on the server/.test(page.text("#msg-prizes")), "the confirmed success");
    expect(page.confirm).toHaveBeenCalledTimes(2);
    expect(posts(page, "/redeem")).toHaveLength(2);
    expect(page.text("#msg-prizes")).toBe('Recorded on the server as redeemed: "Free pitcher for Maria Lopez". You can hand it over now.');
    expect(banner(page).className).toContain("success");
    expect(pillOf(page, "q-pending")).toBe("Redeemed");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    page.close();
  });

  it("(d) if the earlier request lands after Check status showed pending, the second tap's alreadyRedeemed:true reads as reconcile, not as success", async () => {
    const { server, page } = await unknownPage("lose-uncommitted");
    checkButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending") !== null, "Mark Redeemed to return");

    server.redeemedAt.set("q-pending", RECORDED_AT); // the lost request finally lands
    server.postMode = "ok";
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /^Already redeemed earlier/.test(page.text("#msg-prizes")), "the reconcile wording");
    const message = page.text("#msg-prizes");
    expect(message).toMatch(/cannot tell whether it was physically handed over/);
    expect(message).toMatch(/Reconcile with the winner and your colleagues/);
    expect(message).not.toMatch(/do NOT hand over again/i);
    expect(message).not.toMatch(/You can hand it over now/);
    expect(banner(page).className).toContain("warning");
    expect(pillOf(page, "q-pending")).toBe("Redeemed - reconcile");
    expect(posts(page, "/redeem")).toHaveLength(2);
    page.close();
  });

  it.each([500, 502, 503, 504, 408])("(e) HTTP %i is an UNKNOWN outcome: the row keeps no Mark Redeemed and only offers Check status", async (status) => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(status, { error: "Upstream said no." }) : undefined),
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    const message = page.text("#msg-prizes");
    expect(message).toMatch(/UNKNOWN/);
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toContain("Upstream said no.");
    expect(message).not.toMatch(/not marked redeemed/i);
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(e) a status the page does not recognise as a refusal or a success (a 201 here) is also unknown", async () => {
    const page = await loadPage({ respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(201, {}) : undefined) });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    expect(redeemButton(page, "q-pending")).toBeNull();
    page.close();
  });

  it.each([400, 401, 403, 404, 409, 422])("(e) HTTP %i is a DEFINITIVE refusal: no unknown state, no Check status, Mark Redeemed is usable again", async (status) => {
    const page = await loadPage({
      respond: (call) => (call.method === "POST" && call.url.endsWith("/redeem") ? jsonReply(status, { error: "Refused by the server." }) : undefined),
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => page.text("#msg-prizes").length > 0 && !page.text("#msg-prizes").startsWith("Marking") && redeemButton(page, "q-pending") !== null && !redeemButton(page, "q-pending")!.disabled, "the refusal");
    const message = page.text("#msg-prizes");
    expect(message).not.toMatch(/UNKNOWN/);
    expect(banner(page).className).toContain("error");
    expect(checkButton(page, "q-pending")).toBeNull();
    expect(pillOf(page, "q-pending")).toBe("Pending");
    if (status === 409) expect(message).toMatch(/Do NOT hand over this prize\. The list was refreshed\./);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(f) a load that started BEFORE the ambiguous attempt and answers AFTER it (showing pending) is applied but cannot clear the unknown state", async () => {
    const server = statefulServer();
    server.postMode = "commit-lose";
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    const release = server.hold();
    await clickLoad(page); // snapshot taken now: q-pending is still pending
    await page.until(() => qualGets(page).length === 2, "the held load");

    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    release();
    await page.until(() => /still has an UNKNOWN redemption status/.test(page.text("#msg-prizes")), "the held load to be applied");

    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")).toBeTruthy();
    page.close();
  });

  it("(f) an older load answering after a newer one does not overwrite it", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-pending")).toBe("Pending");

    const release = server.hold();
    await clickLoad(page); // older: snapshot says pending
    await page.until(() => qualGets(page).length === 2, "the older load");
    server.redeemedAt.set("q-pending", RECORDED_AT);
    await clickLoad(page); // newer: sees the redemption
    await page.until(() => pillOf(page, "q-pending") === "Redeemed", "the newer load");

    release();
    await settle();
    expect(pillOf(page, "q-pending")).toBe("Redeemed");
    expect(redeemButton(page, "q-pending")).toBeNull();
    page.close();
  });

  it("(f) a response for the previous activation, arriving after the select changed, renders nothing under the new one", async () => {
    const server = statefulServer({
      byActivation: {
        "act-1": [qual({ prizeQualificationId: "q-one", memberDisplayName: "Uno One" })],
        "act-2": [qual({ prizeQualificationId: "q-two", venueActivationId: "act-2", memberDisplayName: "Zed Two" })],
      },
    });
    const page = await loadPage({ respond: server.respond });
    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    const release = server.hold();
    await clickLoad(page); // act-1, held
    await page.until(() => qualGets(page).length === 1, "the held load");

    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    release();
    await settle();
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.text("#prizes-heading")).toBe("");
    expect(page.text("#msg-prizes")).toBe("");

    // Changing the select invalidates loads in flight even when it is changed back to the same activation: the operator never
    // asked for that list under this selection, so a late answer must not appear out of nowhere.
    select.value = "act-1";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    const release2 = server.hold();
    await clickLoad(page); // act-1, held
    await page.until(() => qualGets(page).length === 2, "the second held load");
    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    select.value = "act-1";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    release2();
    await settle();
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.text("#prizes-heading")).toBe("");
    page.close();
  });

  it("(f) a select that changes without a change event (the activation list being rebuilt) still drops an answer for the old choice", async () => {
    const server = statefulServer({ byActivation: { "act-1": [qual({ prizeQualificationId: "q-one", memberDisplayName: "Uno One" })] } });
    const page = await loadPage({ respond: server.respond });
    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    const release = server.hold();
    await clickLoad(page);
    await page.until(() => qualGets(page).length === 1, "the held load");
    select.value = "act-2"; // no change event
    release();
    await settle();
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.text("#prizes-heading")).toBe("");
    page.close();
  });

  it("(f) a stale answer cannot replace the list of the activation the operator is now looking at", async () => {
    const server = statefulServer({
      byActivation: {
        "act-1": [qual({ prizeQualificationId: "q-one", memberDisplayName: "Uno One" })],
        "act-2": [qual({ prizeQualificationId: "q-two", venueActivationId: "act-2", memberDisplayName: "Zed Two" })],
      },
    });
    const page = await loadPage({ respond: server.respond });
    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    const release = server.hold();
    await clickLoad(page); // act-1, held
    await page.until(() => qualGets(page).length === 1, "the held load");
    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await clickLoad(page); // act-2, answered at once
    await page.until(() => rowFor(page, "q-two") !== null, "the act-2 list");
    release();
    await settle();
    expect([...page.doc.querySelectorAll("#table-qualifications tbody tr")].map((tr) => (tr as HTMLElement).dataset.qualification)).toEqual(["q-two"]);
    page.close();
  });

  it("(g) an ordinary reload while the outcome is unknown and the server still shows pending keeps Status unknown and keeps saying so", async () => {
    const { page } = await unknownPage("lose-uncommitted");
    const before = qualGets(page).length;
    await clickLoad(page);
    await page.until(() => qualGets(page).length === before + 1, "the reload");
    await page.until(() => /still has an UNKNOWN redemption status/.test(page.text("#msg-prizes")), "the standing banner");

    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")).toBeTruthy();
    expect(banner(page).className).toContain("error");
    expect(page.text("#msg-prizes")).toMatch(/withhold/i);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(g) a reload that shows the row redeemed converts Status unknown to Redeemed - reconcile, with the reconcile warning", async () => {
    const { page } = await unknownPage("commit-lose");
    const before = qualGets(page).length;
    await clickLoad(page);
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the converted row");

    expect(page.text("#msg-prizes")).toMatch(/Reconcile with the winner and your colleagues before handing anything over/);
    expect(banner(page).className).toContain("warning");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    expect(qualGets(page)).toHaveLength(before + 1);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(j) Check status finding the row superseded clears the doubt, says a correction replaced it, and offers no action", async () => {
    const { server, page } = await unknownPage("lose-uncommitted");
    server.supersededAt.set("q-pending", "2026-10-25T02:00:00.000Z");
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending").startsWith("Superseded"), "the superseded row");

    expect(page.text("#msg-prizes")).toMatch(/A result correction replaced "Free pitcher for Maria Lopez"/);
    expect(page.text("#msg-prizes")).toMatch(/Do NOT hand it over/);
    expect(banner(page).className).toContain("error");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    expect(rowFor(page, "q-pending").dataset.status).toBe("superseded");
    page.close();
  });

  it("an ordinary reload that shows the row superseded also clears the doubt and says not to hand it over", async () => {
    const { server, page } = await unknownPage("lose-uncommitted");
    server.supersededAt.set("q-pending", "2026-10-25T02:00:00.000Z");
    await clickLoad(page);
    await page.until(() => pillOf(page, "q-pending").startsWith("Superseded"), "the superseded row");
    expect(page.text("#msg-prizes")).toMatch(/Do NOT hand it over/);
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    page.close();
  });

  it("the unknown state survives switching to another activation and back; the row is still Status unknown, never a fresh Pending", async () => {
    const { page } = await unknownPage("lose-uncommitted");
    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    select.value = "act-1";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await loadQualifications(page);
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")).toBeTruthy();
    page.close();
  });

  it("a Check status answer that arrives after the operator changed activation is discarded and leaves the row unknown", async () => {
    const { server, page } = await unknownPage("lose-uncommitted");
    const release = server.hold();
    const before = qualGets(page).length;
    checkButton(page, "q-pending")!.click();
    await page.until(() => qualGets(page).length === before + 1, "the read");

    const select = page.doc.getElementById("q-activation") as HTMLSelectElement;
    select.value = "act-2";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    release();
    await settle();
    expect(page.text("#msg-prizes")).toBe("");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);

    select.value = "act-1";
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await loadQualifications(page);
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")!.disabled).toBe(false);
    page.close();
  });

  it("(h) the confirm no longer tells staff to hand over: it asks to mark redeemed and says handover comes only after the server confirmation", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    const prompt = promptOf(page);
    expect(prompt.split("\n")[0]).toBe("Mark this prize as redeemed?");
    expect(prompt).toContain("Prize: Free pitcher");
    expect(prompt).toContain("Player: Maria Lopez");
    expect(prompt).toMatch(/handed over only AFTER this screen shows it recorded on the server/);
    expect(prompt).not.toMatch(/hand over this prize now/i);
    expect(prompt).not.toMatch(/^hand over/im);
    page.close();
  });

  it("(h) the success message names the server confirmation first and only then allows handover", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /^Recorded on the server/.test(page.text("#msg-prizes")), "the confirmed success");
    const message = page.text("#msg-prizes");
    expect(message.indexOf("Recorded on the server")).toBe(0);
    expect(message.indexOf("You can hand it over now")).toBeGreaterThan(message.indexOf("Recorded on the server"));
    expect(message).toContain("Free pitcher for Maria Lopez");
    page.close();
  });

  it.each([
    ["a network failure", "reject"],
    ["an HTTP 500", "http500"],
    ["a malformed body", "malformed"],
  ] as const)("(i) a 200 followed by a failed reload (%s) still shows the row redeemed, with no contradicting error", async (_label, mode) => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    const before = qualGets(page).length;
    server.getMode = mode;
    redeemButton(page, "q-pending")!.click();
    await page.until(() => qualGets(page).length === before + 1, "the follow-up reload");
    await settle(60);

    expect(server.redeemedAt.has("q-pending")).toBe(true);
    expect(pillOf(page, "q-pending")).toBe("Redeemed");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(page.text("#msg-prizes")).toBe('Recorded on the server as redeemed: "Free pitcher for Maria Lopez". You can hand it over now.');
    expect(banner(page).className).toContain("success");
    expect(page.text("#msg-prizes")).not.toMatch(/network error|could not (load|read)/i);
    // the rest of the list was not wiped by the failed reload
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(4);
    page.close();
  });

  it("a Mark Redeemed whose request is still in flight stays disabled when another row's redemption re-renders the table", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page = await loadPage({
      respond: async (call) => {
        if (call.method !== "POST") return undefined;
        const id = call.url.match(/qualifications\/([^/]+)\/redeem$/)![1];
        if (id === "q-pending") await gate;
        return jsonReply(200, { result: { prizeQualificationId: id, redeemedAt: RECORDED_AT, alreadyRedeemed: false } });
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the first request");

    redeemButton(page, "q-fallback")!.click();
    await page.until(() => redeemButton(page, "q-fallback") === null, "the second row to be redeemed");
    await settle();
    expect(redeemButton(page, "q-pending")!.disabled).toBe(true); // rebuilt by the re-render, still locked
    redeemButton(page, "q-pending")!.click();
    await settle();
    expect(posts(page, "/redeem")).toHaveLength(2);

    release();
    await page.until(() => redeemButton(page, "q-pending") === null, "the first row to be redeemed");
    expect(pillOf(page, "q-pending")).toBe("Redeemed");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// I. Hardening of the redemption-recovery code
//
// The rules above (H) hold for the cases they name. These cover the ways the recovery code itself could mislead: an answer that is not
// the route's, a request that never ends, a banner that disagrees with the row or hides another row's warning, a list that is not as
// fresh as it claims, and member-chosen text inside a safety sentence.
// ---------------------------------------------------------------------------------------------------------------------------------

const stall = () => new Promise<never>(() => {});
const isRedeemPost = (call: Call) => call.method === "POST" && call.url.endsWith("/redeem");
const isQualList = (call: Call) => call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`);
const SUPERSEDED_AT = "2026-10-25T02:00:00.000Z";

describe("I. A 200 counts as confirmation only when it is the redeem route's own answer for this row", () => {
  it.each([
    ["no body at all", { status: 200 } as Reply],
    ["an empty object", jsonReply(200, {})],
    ["a result without alreadyRedeemed", jsonReply(200, { result: { prizeQualificationId: "q-pending", redeemedAt: RECORDED_AT } })],
    ["a result whose alreadyRedeemed is not a boolean", jsonReply(200, { result: { prizeQualificationId: "q-pending", redeemedAt: RECORDED_AT, alreadyRedeemed: "false" } })],
    ["a result for another qualification", jsonReply(200, { result: { prizeQualificationId: "q-other", redeemedAt: RECORDED_AT, alreadyRedeemed: false } })],
    ["a JSON body that is not an object (a proxy page)", jsonReply(200, "<html>Welcome to the guest Wi-Fi</html>")],
  ])("(%s) is UNKNOWN: nothing is claimed, no false 'already redeemed' mark, and an explicit read settles it", async (_label, reply) => {
    const page = await loadPage({ respond: (call) => (isRedeemPost(call) ? reply : undefined) });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/UNKNOWN/);
    expect(message).toMatch(/HTTP 200 without a redemption confirmation/);
    expect(message).toMatch(/withhold/i);
    expect(message).not.toMatch(/Already redeemed earlier|the server shows|Recorded on the server|hand it over now/);
    expect(banner(page).className).toContain("error");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(rowButtons(page, "q-pending").map((b) => b.textContent)).toEqual(["Check status"]);
    expect(posts(page, "/redeem")).toHaveLength(1);

    // an ordinary reload that still shows the row pending cannot turn the doubt into a recorded redemption
    const before = qualGets(page).length;
    await clickLoad(page);
    await page.until(() => qualGets(page).length === before + 1, "the reload");
    await page.until(() => /still has an UNKNOWN redemption status/.test(page.text("#msg-prizes")), "the standing banner");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");

    // the explicit read finds nothing recorded: the row is Pending again instead of carrying a permanent false mark
    checkButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending") !== null, "Mark Redeemed to return");
    expect(pillOf(page, "q-pending")).toBe("Pending");
    expect(page.text("#msg-prizes")).toMatch(/NOT redeemed/);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });
});

describe("I. A request that stalls ends instead of stranding its row", () => {
  it("a redeem POST that never answers is aborted after the timeout and becomes an UNKNOWN outcome with Check status", async () => {
    const page = await loadPage({ captureLongTimers: true, respond: (call) => (isRedeemPost(call) ? stall() : undefined) });
    await loadQualifications(page);
    const button = redeemButton(page, "q-pending")!;
    button.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the redeem request");
    await settle();
    expect(page.text("#msg-prizes")).toBe("Marking redeemed…");
    expect(button.disabled).toBe(true);
    expect(checkButton(page, "q-pending")).toBeNull();

    // one timeout is armed for the request, of a sensible length
    const armed = [...page.longTimers.values()];
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBeGreaterThanOrEqual(10_000);
    expect(armed[0].ms).toBeLessThanOrEqual(30_000);

    armed[0].run();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    const message = page.text("#msg-prizes");
    expect(message).toMatch(/UNKNOWN/);
    expect(message).toMatch(/No answer arrived from the server in time/);
    expect(message).toMatch(/withhold/i);
    expect(message).not.toMatch(/not marked redeemed/i);
    expect(banner(page).className).toContain("error");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(page.longTimers.size).toBe(0);
    await settle(80);
    expect(posts(page, "/redeem")).toHaveLength(1); // the abort is not a replay
    page.close();
  });

  it("a redeem that answers in time clears its timeout and is confirmed as before", async () => {
    const server = statefulServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page = await loadPage({ captureLongTimers: true, respond: async (call) => { if (isRedeemPost(call)) await gate; return server.respond(call); } });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the redeem request");
    await settle();
    expect(page.longTimers.size).toBe(1); // armed while the request is in flight
    release();
    await page.until(() => /^Recorded on the server/.test(page.text("#msg-prizes")), "the confirmed success");
    expect(page.longTimers.size).toBe(0); // and gone once it has answered
    expect(pillOf(page, "q-pending")).toBe("Redeemed");
    page.close();
  });

  it("a Check status read that never answers is aborted after the timeout: still UNKNOWN, Check status usable again", async () => {
    const server = statefulServer();
    server.postMode = "commit-lose";
    let stallReads = false;
    const page = await loadPage({ captureLongTimers: true, respond: (call) => (stallReads && isQualList(call) ? stall() : server.respond(call)) });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    await settle();
    expect(page.longTimers.size).toBe(0);

    stallReads = true;
    const before = qualGets(page).length;
    const check = checkButton(page, "q-pending")!;
    check.click();
    await page.until(() => qualGets(page).length === before + 1, "the status read");
    await settle();
    expect(check.disabled).toBe(true);
    expect(page.text("#msg-prizes")).toBe("Checking status…");
    const armed = [...page.longTimers.values()];
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBeGreaterThanOrEqual(10_000);
    expect(armed[0].ms).toBeLessThanOrEqual(30_000);

    armed[0].run();
    await page.until(() => /could not be confirmed/.test(page.text("#msg-prizes")), "the unconfirmed message");
    const message = page.text("#msg-prizes");
    expect(message).toMatch(/the server did not answer in time/);
    expect(message).toMatch(/still UNKNOWN/);
    expect(message).toMatch(/Do NOT hand over/);
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(redeemButton(page, "q-pending")).toBeNull();
    expect(checkButton(page, "q-pending")!.disabled).toBe(false);
    expect(posts(page, "/redeem")).toHaveLength(1);

    // pressing it again, once the server answers, settles it
    stallReads = false;
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the settled state");
    page.close();
  });
});

describe("I. The banner agrees with the row and does not hide another row's warning", () => {
  // The POST commits at once, but its answer is held back and then lost, so a list read can land in between.
  async function heldLostAnswer() {
    const server = statefulServer();
    server.postMode = "commit-lose";
    let releasePost!: () => void;
    const postGate = new Promise<void>((r) => { releasePost = r; });
    const page = await loadPage({
      respond: async (call) => {
        const reply = await server.respond(call);
        if (isRedeemPost(call)) await postGate;
        return reply;
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the redeem request");
    await settle();
    return { server, page, releasePost };
  }

  it("(a) a list read that showed the row redeemed before the answer was lost gives the reconcile warning, not a Check status instruction for a row that has none", async () => {
    const { page, releasePost } = await heldLostAnswer();
    await clickLoad(page);
    await page.until(() => pillOf(page, "q-pending") === "Redeemed", "the list read to show the redemption");

    releasePost();
    await page.until(() => /Reconcile with the winner/.test(page.text("#msg-prizes")), "the reconcile message");
    const message = page.text("#msg-prizes");
    expect(message).not.toMatch(/Check status/);
    expect(message).not.toMatch(/UNKNOWN/);
    expect(banner(page).className).toContain("warning");
    expect(pillOf(page, "q-pending")).toBe("Redeemed - reconcile");
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(a) a list read that showed the row replaced before the answer was lost says so, not 'Press Check status'", async () => {
    const { server, page, releasePost } = await heldLostAnswer();
    server.redeemedAt.delete("q-pending");
    server.supersededAt.set("q-pending", SUPERSEDED_AT);
    await clickLoad(page);
    await page.until(() => pillOf(page, "q-pending").startsWith("Superseded"), "the list read to show the replacement");

    releasePost();
    await page.until(() => /A result correction replaced/.test(page.text("#msg-prizes")), "the superseded message");
    expect(page.text("#msg-prizes")).not.toMatch(/Check status/);
    expect(banner(page).className).toContain("error");
    expect(pillOf(page, "q-pending")).toMatch(/^Superseded/);
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    page.close();
  });

  it("(b) a later redemption's confirmation keeps the standing UNKNOWN warning for another row, and is not styled as plain success", async () => {
    const server = statefulServer();
    server.postMode = "lose-uncommitted";
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");

    server.postMode = "ok";
    const before = qualGets(page).length;
    redeemButton(page, "q-fallback")!.click();
    await page.until(() => qualGets(page).length === before + 1, "the follow-up reload");
    await settle(60);

    const message = page.text("#msg-prizes");
    expect(message).toContain('Recorded on the server as redeemed: "Tier 9f8e7d6c for Member 1a2b3c4d". You can hand it over now.');
    expect(message).toMatch(/1 prize on this list still has an UNKNOWN redemption status/);
    expect(message).toMatch(/Do NOT hand it over: withhold it until Check status confirms/);
    expect(message.indexOf("Recorded on the server")).toBeLessThan(message.indexOf("UNKNOWN"));
    expect(banner(page).className).toContain("error");
    expect(banner(page).className).not.toContain("success");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(pillOf(page, "q-fallback")).toBe("Redeemed");
    page.close();
  });

  it("(b) the reconcile warning a reload finds for another row is kept next to the confirmation, not replaced by it", async () => {
    const server = statefulServer();
    server.postMode = "commit-lose";
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");

    server.postMode = "ok";
    const before = qualGets(page).length;
    redeemButton(page, "q-fallback")!.click();
    await page.until(() => qualGets(page).length === before + 1, "the follow-up reload");
    await settle(60);

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/^Recorded on the server as redeemed: "Tier 9f8e7d6c for Member 1a2b3c4d"\./);
    expect(message).toMatch(/The server now shows "Free pitcher for Maria Lopez" as redeemed/);
    expect(message).toMatch(/Reconcile with the winner and your colleagues before handing anything over/);
    expect(banner(page).className).toContain("warning");
    expect(banner(page).className).not.toContain("success");
    expect(pillOf(page, "q-pending")).toBe("Redeemed - reconcile");
    page.close();
  });

  it("(c) a sign-in client failure says nothing was sent: no POST, no UNKNOWN, no 'connection failed', and the button is usable again", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    (page.win as any).UrbanoAuth.getAccessToken = async () => { throw new Error("sign-in client failed to load"); };
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /nothing was sent/.test(page.text("#msg-prizes")), "the message");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/could not be signed/);
    expect(message).toMatch(/nothing was recorded/);
    expect(message).not.toMatch(/connection failed|UNKNOWN/);
    expect(banner(page).className).toContain("error");
    expect(posts(page, "/redeem")).toHaveLength(0);
    expect(pillOf(page, "q-pending")).toBe("Pending");
    expect(redeemButton(page, "q-pending")!.disabled).toBe(false);
    page.close();
  });

  it("(c) Check status with a failing sign-in client says nothing was sent, sends no read, and leaves the row unknown", async () => {
    const { page } = await unknownPage("commit-lose");
    const win = page.win as any;
    const working = win.UrbanoAuth.getAccessToken;
    win.UrbanoAuth.getAccessToken = async () => { throw new Error("sign-in client failed to load"); };
    const before = qualGets(page).length;
    checkButton(page, "q-pending")!.click();
    await page.until(() => /could not be confirmed/.test(page.text("#msg-prizes")), "the unconfirmed message");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/could not be signed/);
    expect(message).toMatch(/nothing was sent/);
    expect(message).not.toMatch(/connection failed/);
    expect(message).toMatch(/still UNKNOWN/);
    expect(qualGets(page)).toHaveLength(before);
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(checkButton(page, "q-pending")!.disabled).toBe(false);

    win.UrbanoAuth.getAccessToken = working;
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the settled state");
    page.close();
  });
});

describe("I. The list is not claimed fresh unless it is, and a failed read does not blank it", () => {
  it("a 409 whose reload fails does not say the list was refreshed, and the rows stay on screen", async () => {
    let posted = false;
    const page = await loadPage({
      respond: (call) => {
        if (isRedeemPost(call)) { posted = true; return jsonReply(409, { error: "This qualification is no longer supported by the current result." }); }
        if (posted && isQualList(call)) return jsonReply(500, { error: "Database unavailable." });
        return undefined;
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /Do NOT hand over this prize/.test(page.text("#msg-prizes")), "the 409 message");

    const message = page.text("#msg-prizes");
    expect(message).toContain("no longer supported by the current result.");
    expect(message).toMatch(/The list could not be refreshed - reload before acting\./);
    expect(message).not.toMatch(/list was refreshed/);
    expect(banner(page).className).toContain("error");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(4);
    expect(pillOf(page, "q-pending")).toBe("Pending");
    expect(redeemButton(page, "q-pending")!.disabled).toBe(false);
    page.close();
  });

  it.each([
    ["a network failure", "reject", /Network error - could not load prizes\./],
    ["HTTP 500", "http500", /Database unavailable\./],
    ["a 403", "http403", /No admin authority\./],
    ["a 200 with a malformed body", "malformed", /Could not read the prize list/],
  ] as const)("a Load that fails (%s) keeps the rows and their Status unknown on screen and says the list may be out of date", async (_label, mode, reason) => {
    const { server, page } = await unknownPage("commit-lose");
    server.getMode = mode;
    await clickLoad(page);
    await page.until(() => /may be out of date/.test(page.text("#msg-prizes")), "the failure message");

    expect(page.text("#msg-prizes")).toMatch(reason);
    expect(banner(page).className).toContain("error");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(4);
    expect(page.text("#prizes-heading")).toContain("Prizes for:");
    expect(pillOf(page, "q-pending")).toBe("Status unknown");
    expect(checkButton(page, "q-pending")).toBeTruthy();
    page.close();
  });

  it("a failed Load with nothing on screen does not mention an out-of-date list", async () => {
    const page = await loadPage({ respond: (call) => (isQualList(call) ? jsonReply(500, { error: "Database unavailable." }) : undefined) });
    await clickLoad(page);
    await page.until(() => page.text("#msg-prizes").length > 0, "the failure message");
    expect(page.text("#msg-prizes")).toBe("Database unavailable.");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    page.close();
  });

  it("(j) Check status finding the row superseded reloads the list, so the replacement prize the correction created is visible", async () => {
    const server = statefulServer();
    server.postMode = "lose-uncommitted";
    const replacement = qual({ prizeQualificationId: "q-replacement", memberDisplayName: "Maria Lopez", prizeLabel: "Free pitcher" });
    const page = await loadPage({
      respond: async (call) => {
        const reply = await server.respond(call);
        if (isQualList(call) && reply && reply !== "reject" && server.supersededAt.has("q-pending")) {
          (reply.json as { qualifications: unknown[] }).qualifications.push(replacement);
        }
        return reply;
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");
    expect(rowFor(page, "q-replacement")).toBeNull();

    server.supersededAt.set("q-pending", SUPERSEDED_AT);
    const before = qualGets(page).length;
    checkButton(page, "q-pending")!.click();
    await page.until(() => rowFor(page, "q-replacement") !== null, "the replacement row");
    await settle();

    expect(qualGets(page)).toHaveLength(before + 2); // the explicit read, then the reload that shows the replacement
    expect(pillOf(page, "q-pending")).toMatch(/^Superseded/);
    expect(rowButtons(page, "q-pending")).toHaveLength(0);
    expect(redeemButton(page, "q-replacement")).toBeTruthy();
    const message = page.text("#msg-prizes");
    expect(message).toMatch(/A result correction replaced "Free pitcher for Maria Lopez"/);
    expect(message).toMatch(/this entry is no longer a valid prize/);
    expect(message).toMatch(/Do NOT hand it over on this entry/);
    expect(message).toMatch(/replacement prize/);
    expect(banner(page).className).toContain("error");
    expect(posts(page, "/redeem")).toHaveLength(1);
    page.close();
  });

  it("(j) if the reload after a superseded Check status fails, the banner says the replacement may not be shown yet", async () => {
    const server = statefulServer();
    server.postMode = "lose-uncommitted";
    let armed = false;
    let checkRead = false;
    const page = await loadPage({
      respond: (call) => {
        if (armed && isQualList(call)) {
          if (checkRead) return jsonReply(500, { error: "Database unavailable." });
          checkRead = true;
        }
        return server.respond(call);
      },
    });
    await loadQualifications(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => checkButton(page, "q-pending") !== null, "the Check status button");

    server.supersededAt.set("q-pending", SUPERSEDED_AT);
    armed = true;
    checkButton(page, "q-pending")!.click();
    await page.until(() => /could not be reloaded/.test(page.text("#msg-prizes")), "the reload failure note");

    const message = page.text("#msg-prizes");
    expect(message).toMatch(/A result correction replaced "Free pitcher for Maria Lopez"/);
    expect(message).toMatch(/Do NOT hand it over on this entry/);
    expect(message).toMatch(/a replacement prize, if there is one, is not shown yet: press Load Qualifications/);
    expect(banner(page).className).toContain("error");
    expect(pillOf(page, "q-pending")).toMatch(/^Superseded/);
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(4);
    page.close();
  });
});

describe("I. Member-chosen text inside the safety banners", () => {
  const BIDI = /[‎‏‪-‮⁦-⁩؜]/;
  const NAME = "Ana. OK to hand over now";
  const LABEL = `Free pitcher for ${NAME}`;
  const hostile = { qualifications: [qual({ prizeQualificationId: "q-pending", memberDisplayName: "‮" + NAME })] };

  it("a right-to-left override never reaches the banners, the row or the confirm, and the label sits in quotes in the unknown, unconfirmed and reconcile messages", async () => {
    const { server, page } = await unknownPage("commit-lose", hostile);
    const unknownText = page.text("#msg-prizes");
    expect(unknownText).toContain(`Redemption status UNKNOWN for "${LABEL}".`);
    expect(banner(page).textContent).not.toMatch(BIDI);
    expect(rowFor(page, "q-pending").textContent).not.toMatch(BIDI);
    expect(promptOf(page)).not.toMatch(BIDI);
    expect(promptOf(page)).toContain(`Player: ${NAME}\n`);

    server.getMode = "http500";
    checkButton(page, "q-pending")!.click();
    await page.until(() => /could not be confirmed/.test(page.text("#msg-prizes")), "the unconfirmed message");
    expect(page.text("#msg-prizes")).toContain(`Status could not be confirmed for "${LABEL}":`);
    expect(banner(page).textContent).not.toMatch(BIDI);

    server.getMode = "ok";
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Redeemed - reconcile", "the settled state");
    expect(page.text("#msg-prizes")).toContain(`The server now shows "${LABEL}" as redeemed,`);
    expect(banner(page).textContent).not.toMatch(BIDI);
    page.close();
  });

  it("the label is quoted in the not-redeemed answer and in the confirmed success message", async () => {
    const { server, page } = await unknownPage("lose-uncommitted", hostile);
    checkButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending") !== null, "Mark Redeemed to return");
    expect(page.text("#msg-prizes")).toContain(`As of this check the server shows "${LABEL}" as NOT redeemed.`);
    expect(banner(page).textContent).not.toMatch(BIDI);

    server.postMode = "ok";
    redeemButton(page, "q-pending")!.click();
    await page.until(() => /^Recorded on the server/.test(page.text("#msg-prizes")), "the confirmed success");
    expect(page.text("#msg-prizes")).toBe(`Recorded on the server as redeemed: "${LABEL}". You can hand it over now.`);
    expect(promptOf(page, 1)).not.toMatch(BIDI);
    page.close();
  });

  it("the label is quoted in the superseded message", async () => {
    const { server, page } = await unknownPage("lose-uncommitted", hostile);
    server.supersededAt.set("q-pending", SUPERSEDED_AT);
    checkButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending").startsWith("Superseded"), "the superseded row");
    expect(page.text("#msg-prizes")).toContain(`A result correction replaced "${LABEL}", so this entry is no longer a valid prize.`);
    expect(banner(page).textContent).not.toMatch(BIDI);
    page.close();
  });

  it("invisible control and format characters are dropped from a name; ZWJ stays, and a name that is nothing else falls back to the member id", async () => {
    const page = await loadPage({
      qualifications: [
        qual({ prizeQualificationId: "q-a", gamingMemberId: "m-a", memberDisplayName: "Zo​e\u0007" }),
        qual({ prizeQualificationId: "q-b", gamingMemberId: "m-b", memberDisplayName: "A ​  B" }),
        qual({ prizeQualificationId: "q-c", gamingMemberId: MEMBER_UUID, memberDisplayName: "‮​⁦" }),
        qual({ prizeQualificationId: "q-d", gamingMemberId: "m-d", memberDisplayName: "\u{1F469}‍\u{1F469}" }),
      ],
    });
    await loadQualifications(page);
    const nameOf = (id: string) => rowFor(page, id).querySelector(".player-name")!.textContent;
    expect(nameOf("q-a")).toBe("Zoe");
    expect(nameOf("q-b")).toBe("A B");
    expect(nameOf("q-c")).toBe("Member 1a2b3c4d");
    expect(nameOf("q-d")).toBe("\u{1F469}‍\u{1F469}");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F3. A finalize whose answer is lost is an UNKNOWN outcome, settled by reading — never by sending it again or starting a correction
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F3. A lost finalize answer", () => {
  async function lostFinalize(mode: FinalizeMode = "commit-lose", opts: { captureLongTimers?: boolean } = {}) {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    server.finalizeMode = mode;
    const page = await loadPage({ respond: server.respond, ...opts });
    await loadResultFor(page, "Loaded draft.");
    return { server, page };
  }
  const checkVisible = (page: Page) => !(page.doc.getElementById("btn-check-finalize") as HTMLButtonElement).hidden;

  it("(a) is UNKNOWN even though the server recorded it: not 'failed', one POST, finalize and save paused, and nothing is read or started on its own", async () => {
    const { server, page } = await lostFinalize();
    const readsBefore = resultGets(page).length;
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    expect(resultMessage(page)).toContain("Finalize status UNKNOWN for Alpha FC 2-1 Beta FC");
    expect(resultMessage(page)).toContain("do NOT assume it failed");
    expect(resultMessage(page)).not.toMatch(/Failed to finalize/);
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    expect(checkVisible(page)).toBe(true);
    expect(page.text("#result-state")).toContain("Saving and finalizing are paused");
    expect(finalizePosts(page)).toHaveLength(1);
    expect(resultGets(page)).toHaveLength(readsBefore);
    expect(server.finalized).not.toBeNull();

    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("do not finalize again"), "the finalize refusal");
    clickSave(page);
    await page.until(() => resultMessage(page).includes("Press Check result status before saving"), "the save refusal");
    expect(finalizePosts(page)).toHaveLength(1);
    expect(savePosts(page)).toHaveLength(0);
    page.close();
  });

  it("(b) Check result status then showing it finalized: believed, the doubt is gone, and still exactly one POST", async () => {
    const { server, page } = await lostFinalize();
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    clickCheck(page);
    await page.until(() => resultMessage(page).includes("FINALIZED"), "the check result");
    expect(page.doc.getElementById("msg-result")!.className).toContain("success");
    expect(resultMessage(page)).toContain("check the Prizes list");
    expect(checkVisible(page)).toBe(false);
    expect(page.text("#result-state")).toContain("Finalized result: Alpha FC 2-1 Beta FC");
    expect(finalizePosts(page)).toHaveLength(1);
    expect(server.finalized).not.toBeNull();
    page.close();
  });

  it("(c) Check result status showing the draft untouched: finalizing is available again, and pressing it is a deliberate second request that succeeds once", async () => {
    const { server, page } = await lostFinalize("lose-uncommitted");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    expect(server.finalized).toBeNull();
    clickCheck(page);
    await page.until(() => resultMessage(page).includes("NOT finalized"), "the check result");
    expect(resultMessage(page)).toContain("could still be recorded");
    expect(page.doc.getElementById("msg-result")!.className).toContain("warning");
    expect(checkVisible(page)).toBe(false);
    expect(finalizePosts(page)).toHaveLength(1);

    server.finalizeMode = "ok";
    clickFinalize(page);
    await page.until(() => resultMessage(page).startsWith("Finalized"), "the deliberate second finalize");
    expect(finalizePosts(page)).toHaveLength(2);
    expect(finalizePosts(page)[1].body).toEqual(finalizePosts(page)[0].body);
    page.close();
  });

  it("(d) Check result status finding the draft changed or replaced: says the content is no longer what was tried, and does not offer the old digest", async () => {
    const { server, page } = await lostFinalize("lose-uncommitted");
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    server.otherSave({ homeScore: 8, awayScore: 8, matchResultId: server.draft!.matchResultId });
    clickCheck(page);
    await page.until(() => resultMessage(page).includes("no longer the content you tried to finalize"), "the check result");
    expect(page.doc.getElementById("msg-result")!.className).toContain("error");
    expect(checkVisible(page)).toBe(false);
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("not the saved draft"), "the form no longer matches the new draft");
    expect(finalizePosts(page)).toHaveLength(1);
    page.close();
  });

  it.each(["reject", "http500", "malformed"] as const)("(e) a check that cannot be answered (%s) leaves the outcome UNKNOWN and the check usable again", async (mode) => {
    const { server, page } = await lostFinalize();
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    server.getMode = mode;
    clickCheck(page);
    await page.until(() => resultMessage(page).includes("could not be confirmed"), "the unconfirmed message");
    expect(resultMessage(page)).toContain("still UNKNOWN");
    expect(checkVisible(page)).toBe(true);
    expect((page.doc.getElementById("btn-check-finalize") as HTMLButtonElement).disabled).toBe(false);
    server.getMode = "ok";
    clickCheck(page);
    await page.until(() => resultMessage(page).includes("FINALIZED"), "the successful check");
    page.close();
  });

  it("(f) an ordinary Load that shows the result finalized is believed; one that shows the draft still there proves nothing and keeps the doubt", async () => {
    const committed = await lostFinalize("commit-lose");
    clickFinalize(committed.page);
    await committed.page.until(() => resultMessage(committed.page).includes("UNKNOWN"), "the unknown message");
    clickLoadResult(committed.page);
    await committed.page.until(() => resultMessage(committed.page).includes("FINALIZED"), "the load shows it finalized");
    expect(checkVisible(committed.page)).toBe(false);
    committed.page.close();

    const uncommitted = await lostFinalize("lose-uncommitted");
    clickFinalize(uncommitted.page);
    await uncommitted.page.until(() => resultMessage(uncommitted.page).includes("UNKNOWN"), "the unknown message");
    const reads = resultGets(uncommitted.page).length;
    clickLoadResult(uncommitted.page);
    await uncommitted.page.until(() => resultGets(uncommitted.page).length > reads && resultMessage(uncommitted.page).includes("Loaded"), "the load");
    expect(checkVisible(uncommitted.page)).toBe(true);
    expect(uncommitted.page.text("#result-state")).toContain("UNKNOWN");
    uncommitted.page.close();
  });

  it.each([
    ["commit-http", "HTTP 503"],
    ["http408", "HTTP 408"],
    ["200-empty", "HTTP 200 without a finalize confirmation"],
  ] as const)("(g) %s is an UNKNOWN outcome", async (mode, expected) => {
    const { page } = await lostFinalize(mode);
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    expect(resultMessage(page)).toContain(expected);
    expect(checkVisible(page)).toBe(true);
    page.close();
  });

  it.each([
    ["http403", "CONSEQUENTIAL_FINALIZER authority"],
    ["http400", "requires a reason"],
    ["http409", "changed since it was reviewed"],
  ] as const)("(h) %s is a DEFINITIVE refusal: no unknown state, no check, finalizing is usable again", async (mode, expected) => {
    const { page } = await lostFinalize(mode);
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes(expected), "the refusal");
    expect(checkVisible(page)).toBe(false);
    expect(page.text("#result-state")).not.toContain("UNKNOWN");
    expect(finalizeButtonsEnabled(page)).toBe(true);
    page.close();
  });

  it("(i) a request that never answers is aborted after the timeout and becomes UNKNOWN", async () => {
    const { server, page } = await lostFinalize("ok", { captureLongTimers: true });
    server.holdFinalize();
    clickFinalize(page);
    await page.until(() => finalizePosts(page).length === 1, "the finalize request");
    const timer = [...page.longTimers.values()].find((t) => t.ms === 20000);
    expect(timer).toBeDefined();
    timer!.run();
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    expect(resultMessage(page)).toContain("No answer arrived from the server in time");
    expect(checkVisible(page)).toBe(true);
    page.close();
  });

  it("(j) the unknown state belongs to its match: it survives switching to another match and back", async () => {
    const { page } = await lostFinalize();
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("UNKNOWN"), "the unknown message");
    const select = page.doc.getElementById("r-match") as HTMLSelectElement;
    select.value = "m3";
    select.dispatchEvent(new page.win.Event("change"));
    await page.until(() => !page.text("#result-state").includes("UNKNOWN"), "the other match");
    expect(checkVisible(page)).toBe(false);
    select.value = "m1";
    select.dispatchEvent(new page.win.Event("change"));
    await page.until(() => page.text("#result-state").includes("UNKNOWN"), "back on the first match");
    expect(checkVisible(page)).toBe(true);
    page.close();
  });

  it("(k) a sign-in failure sends nothing, is not an unknown outcome, and leaves finalizing usable", async () => {
    const { page } = await lostFinalize("ok");
    (page.win as any).UrbanoAuth.getAccessToken = async () => { throw new Error("sign-in client down"); };
    clickFinalize(page);
    await page.until(() => resultMessage(page).includes("Nothing was finalized"), "the not-sent message");
    expect(resultMessage(page)).toContain("could not be signed");
    expect(finalizePosts(page)).toHaveLength(0);
    expect(checkVisible(page)).toBe(false);
    expect(finalizeButtonsEnabled(page)).toBe(true);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F4. What is on screen belongs to the signed-in admin
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F4. Sign-out and identity change", () => {
  const OTHER = { status: "authenticated", email: "other@example.com", gamingMemberId: "staff-2", displayName: "Other Admin" };

  it("signing out empties every table, picker, form and message, and no winner's name stays in the page", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    expect(page.doc.body.textContent).toContain("Maria Lopez");
    setScore(page, "3", "2");
    (page.doc.getElementById("q-filter") as HTMLInputElement).value = "maria";

    page.setAuth({ status: "unauthenticated" });
    page.fireAuthEvent();
    await page.until(() => (page.doc.getElementById("admin-sections") as HTMLElement).style.display === "none", "the sections to hide");
    expect(page.text("#auth-status")).toBe("Not signed in.");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.doc.querySelectorAll("#table-matches tbody tr")).toHaveLength(0);
    expect(page.doc.querySelectorAll("#table-roster tbody tr")).toHaveLength(0);
    expect(page.doc.querySelectorAll("#q-activation option, #r-match option, #a-match option")).toHaveLength(0);
    expect(page.doc.body.textContent).not.toContain("Maria Lopez");
    expect(page.doc.body.textContent).not.toContain("Rita Redeemed");
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("");
    expect((page.doc.getElementById("q-filter") as HTMLInputElement).value).toBe("");
    expect(page.text("#msg-prizes")).toBe("");
    expect(page.text("#prizes-heading")).toBe("");
    page.close();
  });

  it("another admin signing in on the same phone starts clean: no earlier rows, marks, typed values or unknown redemptions", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    server.postMode = "lose-uncommitted"; // the request is lost before it commits: the server still shows the row pending
    redeemButton(page, "q-pending")!.click();
    await page.until(() => pillOf(page, "q-pending") === "Status unknown", "the unknown row");
    setScore(page, "6", "6");

    page.setAuth(OTHER);
    page.fireAuthEvent();
    await page.until(() => page.text("#auth-status") === "Signed in as Other Admin.", "the new identity");
    await page.until(() => page.doc.querySelectorAll("#q-activation option").length > 0 && page.doc.querySelectorAll("#table-matches tbody tr").length > 0, "the new data");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("");
    expect(page.doc.body.textContent).not.toContain("Maria Lopez");

    server.postMode = "ok";
    await loadQualifications(page);
    expect(pillOf(page, "q-pending")).toBe("Pending"); // the earlier admin's "Status unknown" mark did not follow
    expect(redeemButton(page, "q-pending")).not.toBeNull();
    page.close();
  });

  it("a slow answer for the PREVIOUS identity cannot restore that admin's data under the next one", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    const release = server.hold();
    (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await page.until(() => qualGets(page).length === 1, "the prizes read to start");

    page.setAuth(OTHER);
    page.fireAuthEvent();
    await page.until(() => page.text("#auth-status") === "Signed in as Other Admin.", "the new identity");
    release();
    await settle(80);
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect(page.doc.body.textContent).not.toContain("Maria Lopez");
    expect(page.text("#prizes-heading")).toBe("");
    page.close();
  });

  it("a slow redeem answer for the previous identity touches nothing under the next one", async () => {
    const server = statefulServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const respond = server.respond;
    page.setResponder(async (call) => { if (call.method === "POST" && call.url.endsWith("/redeem")) await gate; return respond(call); });
    redeemButton(page, "q-pending")!.click();
    await page.until(() => posts(page, "/redeem").length === 1, "the redeem request");
    page.setAuth(OTHER);
    page.fireAuthEvent();
    await page.until(() => page.text("#auth-status") === "Signed in as Other Admin.", "the new identity");
    release();
    await settle(80);
    expect(page.text("#msg-prizes")).toBe("");
    expect(page.doc.body.textContent).not.toContain("Free pitcher for Maria Lopez");
    page.close();
  });

  it("a sign-in event for the SAME admin reloads the lists without duplicating a row and without touching what is typed", async () => {
    const page = await loadPage();
    setScore(page, "2", "2");
    page.fireAuthEvent();
    page.fireAuthEvent();
    page.fireAuthEvent();
    await settle(120);
    expect(page.doc.querySelectorAll("#table-matches tbody tr")).toHaveLength(MATCHES.length);
    expect(page.doc.querySelectorAll("#r-match option")).toHaveLength(MATCHES.length);
    expect(page.doc.querySelectorAll("#q-activation option")).toHaveLength(ADMIN_ACTIVATIONS.length);
    expect(page.doc.querySelectorAll("#table-roster tbody tr")).toHaveLength(2);
    expect((page.doc.getElementById("r-home") as HTMLInputElement).value).toBe("2");
    page.close();
  });

  it("an unreadable sign-in state clears the screen instead of leaving the last admin's data", async () => {
    const page = await loadPage();
    await loadQualifications(page);
    (page.win as any).UrbanoAuth.getState = async () => { throw new Error("storage unavailable"); };
    page.fireAuthEvent();
    await page.until(() => page.text("#auth-status").includes("Could not read the sign-in state"), "the message");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr")).toHaveLength(0);
    expect((page.doc.getElementById("admin-sections") as HTMLElement).style.display).toBe("none");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F5. Loading the lists, toggles and create forms
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F5. Loaders, toggles and forms fail visibly and do not duplicate", () => {
  it("a failed activations read says the read failed (not 'create an activation'), and Load Qualifications retries it and recovers", async () => {
    let failing = true;
    const page = await loadPage({
      noActivations: true,
      respond: (call) => (call.url === `${API}/admin/activations` && failing ? jsonReply(500, { error: "Database unavailable." }) : undefined),
    });
    await page.until(() => page.text("#msg-activation").length > 0, "the activations failure");
    expect(page.text("#msg-activation")).toContain("Database unavailable");
    (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await page.until(() => page.calls.filter((c) => c.url === `${API}/admin/activations`).length >= 2, "the retry");
    await settle(30);
    expect(page.text("#msg-prizes")).toContain("could not be loaded");
    expect(page.text("#msg-prizes")).not.toContain("Create a venue activation");

    failing = false;
    (page.doc.getElementById("btn-load-qualifications") as HTMLButtonElement).click();
    await page.until(() => page.doc.querySelectorAll("#table-qualifications tbody tr").length > 0, "the recovered prizes list");
    expect(page.doc.querySelectorAll("#q-activation option").length).toBeGreaterThan(0);
    page.close();
  });

  it("a failed teams read keeps the earlier roster and pickers on screen and says the lists may be out of date", async () => {
    let failing = false;
    const page = await loadPage({ respond: (call) => (call.url === `${API}/admin/teams` && failing ? jsonReply(500, { error: "Database unavailable." }) : undefined) });
    const rowsBefore = page.doc.querySelectorAll("#table-roster tbody tr").length;
    expect(rowsBefore).toBeGreaterThan(0);
    failing = true;
    page.fireAuthEvent();
    await page.until(() => page.text("#msg-team").includes("Database unavailable"), "the failure");
    expect(page.text("#msg-team")).toContain("may be out of date");
    expect(page.doc.querySelectorAll("#table-roster tbody tr")).toHaveLength(rowsBefore);
    expect(page.doc.querySelectorAll("#p-team option").length).toBe(TEAMS.length);
    failing = false;
    page.fireAuthEvent();
    await page.until(() => page.text("#msg-team") === "", "the cleared error after a good reload");
    page.close();
  });

  it("a roster that fails halfway is not half-applied: the earlier teams, pickers and roster stay exactly as they were", async () => {
    let reload = false;
    const page = await loadPage({
      respond: (call) => {
        if (!reload) return undefined;
        // The reload sees a changed list of teams, and the second team's roster cannot be read.
        if (call.method === "GET" && call.url === `${API}/admin/teams`) return jsonReply(200, { teams: [TEAMS[0], { teamId: "team-c", name: "Gamma FC" }] });
        if (call.method === "GET" && call.url === `${API}/admin/teams/team-c/players`) return jsonReply(500, { error: "Roster unavailable." });
        return undefined;
      },
    });
    const optionsBefore = [...page.doc.querySelectorAll("#p-team option")].map((o) => o.textContent);
    const rowsBefore = page.doc.querySelectorAll("#table-roster tbody tr").length;
    expect(optionsBefore).toEqual(["Alpha FC", "Beta FC"]);
    reload = true;
    page.fireAuthEvent();
    await page.until(() => page.text("#msg-team").includes("Roster unavailable"), "the failure");
    expect(page.text("#msg-team")).toContain("Gamma FC");
    expect([...page.doc.querySelectorAll("#p-team option")].map((o) => o.textContent)).toEqual(optionsBefore);
    expect([...page.doc.querySelectorAll("#m-home option")].map((o) => o.textContent)).toEqual(optionsBefore);
    expect(page.doc.querySelectorAll("#table-roster tbody tr")).toHaveLength(rowsBefore);
    expect([...page.doc.querySelectorAll("#admin-sections option, #admin-sections td")].some((n) => (n.textContent ?? "").includes("Gamma FC"))).toBe(false);
    page.close();
  });

  describe("activation and player toggles", () => {
    it("an activation toggle that is refused says so; a network failure says so; a double press sends one request", async () => {
      let mode: "403" | "reject" | "ok" = "403";
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let gateOn = false;
      const page = await loadPage({
        respond: async (call) => {
          if (call.method === "PATCH" && call.url.startsWith(`${API}/admin/activations/`)) {
            if (gateOn) await gate;
            if (mode === "403") return jsonReply(403, { error: "This action requires OPERATIONAL authority." });
            if (mode === "reject") return "reject";
            return jsonReply(200, { result: {} });
          }
          return undefined;
        },
      });
      const toggle = () => page.doc.querySelector('button[data-toggle="act-1"]') as HTMLButtonElement;
      toggle().click();
      await page.until(() => page.text("#msg-activation").includes("OPERATIONAL authority"), "the refusal");
      mode = "reject";
      toggle().click();
      await page.until(() => page.text("#msg-activation").includes("Could not"), "the network message");
      expect(page.text("#msg-activation")).toContain("Check its state");

      mode = "ok";
      gateOn = true;
      const patches = () => page.calls.filter((c) => c.method === "PATCH" && c.url.startsWith(`${API}/admin/activations/`)).length;
      const before = patches();
      toggle().click();
      toggle().disabled = false;
      toggle().click();
      await settle(30);
      expect(patches() - before).toBe(1);
      release();
      page.close();
    });

    it("a player toggle that is refused says so and does not reload", async () => {
      const page = await loadPage({ respond: (call) => (call.method === "PATCH" && call.url.includes("/admin/players/") ? jsonReply(403, { error: "This action requires OPERATIONAL authority." }) : undefined) });
      const teamGets = page.calls.filter((c) => c.url === `${API}/admin/teams`).length;
      (page.doc.querySelector('button[data-toggle-player="pa1"]') as HTMLButtonElement).click();
      await page.until(() => page.text("#msg-player").includes("OPERATIONAL authority"), "the refusal");
      await settle(30);
      expect(page.calls.filter((c) => c.url === `${API}/admin/teams`)).toHaveLength(teamGets);
      page.close();
    });
  });

  it("roster paste: the button stays disabled until the roster has reloaded, and a retry after a failed reload does not add the same names twice", async () => {
    let created = 0;
    let teamsFail = false;
    let release!: () => void;
    let gate: Promise<void> | null = null;
    const page = await loadPage({
      respond: async (call) => {
        if (call.method === "POST" && call.url === `${API}/admin/teams/team-b/players`) {
          created += 1;
          return jsonReply(201, { player: { playerId: "new-" + created, teamId: "team-b", name: call.body.name, active: true } });
        }
        if (call.method === "GET" && call.url === `${API}/admin/teams`) {
          if (gate) await gate;
          if (teamsFail) return jsonReply(500, { error: "Database unavailable." });
        }
        return undefined;
      },
    });
    const pTeam = page.doc.getElementById("p-team") as HTMLSelectElement;
    pTeam.value = "team-b";
    (page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value = "Cleo One\nCleo Two";
    gate = new Promise<void>((r) => { release = r; });
    const button = page.doc.getElementById("btn-create-players") as HTMLButtonElement;
    button.click();
    await page.until(() => created === 2, "both players added");
    await settle(20);
    expect(button.disabled).toBe(true); // the roster is still being reloaded
    teamsFail = true;
    release();
    await page.until(() => !button.disabled, "the button after the reload");
    expect(page.text("#msg-bulk")).toContain("Added 2");

    // A retry (the reload failed, so the screen has not seen the new players) must skip them.
    teamsFail = false;
    (page.doc.getElementById("p-bulk") as HTMLTextAreaElement).value = "Cleo One\nCleo Two\nCleo Three";
    gate = null;
    button.click();
    await page.until(() => created === 3, "only the new name added");
    await page.until(() => !button.disabled, "the button after the second reload");
    expect(page.text("#msg-bulk")).toContain("Added 1, Skipped 2");
    page.close();
  });

  it.each([
    ["team", "btn-create-team", "msg-team", "/admin/teams", () => { (document.getElementById("t-name") as HTMLInputElement).value = "New FC"; }],
    ["player", "btn-create-player", "msg-player", "/admin/teams/team-a/players", () => { (document.getElementById("p-team") as HTMLSelectElement).value = "team-a"; (document.getElementById("p-name") as HTMLInputElement).value = "Newcomer"; }],
    ["venue", "btn-create-venue", "msg-venue", "/admin/venues", () => { for (const [id, value] of [["v-name", "New Bar"], ["v-lat", "14.1"], ["v-lng", "-87.2"], ["v-radius", "120"]]) (document.getElementById(id) as HTMLInputElement).value = value; }],
    ["activation", "btn-create-activation", "msg-activation", "/admin/activations", () => { (document.getElementById("a-match") as HTMLSelectElement).value = "m1"; (document.getElementById("a-venue") as HTMLSelectElement).value = "v1"; }],
    ["prize tier", "btn-create-tier", "msg-tier", "/admin/activations/act-1/prize-tiers", () => { (document.getElementById("pt-activation") as HTMLSelectElement).value = "act-1"; (document.getElementById("pt-label") as HTMLInputElement).value = "Hat"; }],
  ] as const)("creating a %s: a double press sends one request, and a lost connection replaces the earlier message with an error", async (_what, buttonId, msgId, suffix, fill) => {
    let mode: "hold" | "reject" = "hold";
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page = await loadPage({
      respond: async (call) => {
        if (call.method === "POST" && call.url === `${API}${suffix}`) {
          if (mode === "reject") return "reject";
          await gate;
          return jsonReply(201, { ok: true });
        }
        return undefined;
      },
    });
    const run = new Function("document", `return (${fill.toString()})()`) as (document: Document) => void;
    run(page.doc);
    const button = page.doc.getElementById(buttonId) as HTMLButtonElement;
    setMsgDirect(page, msgId, "Earlier success.", "success");
    button.click();
    button.disabled = false;
    button.click();
    await settle(30);
    expect(page.calls.filter((c) => c.method === "POST" && c.url === `${API}${suffix}`)).toHaveLength(1);
    release();
    await settle(60);

    mode = "reject";
    run(page.doc);
    setMsgDirect(page, msgId, "Earlier success.", "success");
    page.doc.getElementById(buttonId)!.dispatchEvent(new page.win.Event("click"));
    await page.until(() => page.text("#" + msgId) !== "Earlier success.", "the failure message");
    expect(page.doc.getElementById(msgId)!.className).toContain("error");
    expect((page.doc.getElementById(buttonId) as HTMLButtonElement).disabled).toBe(false);
    page.close();
  });

  it("Cancel: a reload that fails afterwards does not leave the button disabled", async () => {
    let matchesFail = false;
    const page = await loadPage({
      respond: (call) => {
        if (call.method === "DELETE" && call.url.startsWith(`${API}/admin/matches/`)) { matchesFail = true; return jsonReply(200, { result: {} }); }
        if (matchesFail && call.method === "GET" && call.url === `${API}/admin/matches`) return "reject";
        return undefined;
      },
    });
    const cancel = page.doc.querySelector('button[data-cancel="m1"]') as HTMLButtonElement;
    cancel.click();
    await page.until(() => page.text("#msg-match").includes("Could not load matches"), "the failed reload");
    expect(cancel.disabled).toBe(false);
    page.close();
  });
});

function setMsgDirect(page: Page, id: string, text: string, kind: string) {
  const el = page.doc.getElementById(id)!;
  el.textContent = text;
  el.className = "msg " + kind;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// F6. The sign-in client that never answers
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F6. A sign-in client that never answers", () => {
  const hang = (page: Page) => { (page.win as any).UrbanoAuth.getAccessToken = () => new Promise(() => {}); };
  const fireTokenTimeout = (page: Page) => {
    const timer = [...page.longTimers.values()].find((t) => t.ms === 10000);
    expect(timer).toBeDefined();
    timer!.run();
  };

  it("ends an action after the token timeout: nothing is sent, the button is usable again, and the message says why", async () => {
    const page = await loadPage({ captureLongTimers: true });
    hang(page);
    (page.doc.getElementById("t-name") as HTMLInputElement).value = "Hung FC";
    const button = page.doc.getElementById("btn-create-team") as HTMLButtonElement;
    button.click();
    await page.until(() => button.disabled, "the button to be busy");
    fireTokenTimeout(page);
    await page.until(() => page.text("#msg-team").includes("did not answer in time"), "the timeout message");
    expect(page.text("#msg-team")).toContain("nothing was sent");
    expect(page.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(button.disabled).toBe(false);
    page.close();
  });

  it("a redeem whose token never arrives says nothing was recorded and is not an unknown outcome", async () => {
    const page = await loadPage({ captureLongTimers: true });
    await loadQualifications(page);
    hang(page);
    redeemButton(page, "q-pending")!.click();
    await page.until(() => redeemButton(page, "q-pending")!.disabled, "the busy button");
    fireTokenTimeout(page);
    await page.until(() => banner(page).textContent!.includes("did not answer in time"), "the timeout message");
    expect(banner(page).textContent).toContain("nothing was sent and nothing was recorded");
    expect(posts(page, "/redeem")).toHaveLength(0);
    expect(pillOf(page, "q-pending")).toBe("Pending");
    expect(redeemButton(page, "q-pending")!.disabled).toBe(false);
    page.close();
  });

  it("a finalize whose token never arrives finalizes nothing and does not pause saving", async () => {
    const server = resultServer({ draft: { goalEvents: [GOAL] } });
    const page = await loadPage({ captureLongTimers: true, respond: server.respond });
    await loadResultFor(page, "Loaded draft.");
    hang(page);
    clickFinalize(page);
    await page.until(() => (page.doc.getElementById("btn-finalize") as HTMLButtonElement).disabled, "the busy button");
    fireTokenTimeout(page);
    await page.until(() => resultMessage(page).includes("did not answer in time"), "the timeout message");
    expect(resultMessage(page)).toContain("Nothing was finalized");
    expect(finalizePosts(page)).toHaveLength(0);
    expect(finalizeButtonsEnabled(page)).toBe(true);
    expect(page.text("#result-state")).not.toContain("UNKNOWN");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F7. A correction never delivers a prize twice: held, already delivered, released
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F7. Prizes on hold and prizes already delivered", () => {
  const JERSEY_DELIVERED = qual({ prizeQualificationId: "q-delivered", gamingMemberId: "11111111-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Dora Delivered", prizeLabel: "Jersey", redeemedAt: "2026-10-24T23:00:00.000Z", redeemedPrizeLabel: "Jersey", redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION", supersededAt: "2026-10-25T01:00:00.000Z" });
  const HELD = qual({
    prizeQualificationId: "q-held", gamingMemberId: "11111111-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Dora Delivered", prizeLabel: "Cap",
    heldAt: "2026-10-25T01:00:00.000Z", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPriorPrizeQualificationId: "q-delivered", replacesPrizeQualificationId: "q-delivered",
    holdReason: 'A correction changed a prize that was already delivered. Delivered: "Jersey" (4 of 4 correct). Now entitled to: "Cap" (2 of 4 correct).',
  });
  const SATISFIED_PRIOR = qual({ prizeQualificationId: "q-prior", gamingMemberId: "22222222-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Fran Fulfilled", prizeLabel: "Burger", redeemedAt: "2026-10-24T22:30:00.000Z", redeemedPrizeLabel: "Burger", redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION", supersededAt: "2026-10-25T01:00:00.000Z" });
  const FULFILLED = qual({ prizeQualificationId: "q-fulfilled", gamingMemberId: "22222222-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Fran Fulfilled", prizeLabel: "Burger", fulfilledByPrizeQualificationId: "q-prior", replacesPrizeQualificationId: "q-prior" });
  const RELEASED = qual({
    prizeQualificationId: "q-released", gamingMemberId: "33333333-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Rene Released", prizeLabel: "Scarf",
    heldAt: "2026-10-25T01:00:00.000Z", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPriorPrizeQualificationId: "q-prior", releasedAt: "2026-10-25T02:00:00.000Z", releasedByGamingMemberId: "staff-1", releaseReason: "Founder approved the scarf",
  });
  const LIST = [JERSEY_DELIVERED, HELD, SATISFIED_PRIOR, FULFILLED, RELEASED];

  /** A release POST records the release and the next read shows it. */
  function releaseServer(list = LIST) {
    const released = new Map<string, string>();
    const server = {
      released,
      mode: "ok" as "ok" | "403" | "409" | "reject" | "500",
      respond: (call: Call): Reply | undefined => {
        const m = call.method === "POST" ? call.url.match(/\/admin\/qualifications\/([^/]+)\/release-hold$/) : null;
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (server.mode === "403") return jsonReply(403, { error: "This action requires CONSEQUENTIAL_FINALIZER authority." });
          if (server.mode === "409") return jsonReply(409, { error: "This qualification is no longer supported by the current result." });
          if (server.mode === "reject") return "reject";
          if (server.mode === "500") return jsonReply(500, { error: "Failed." });
          const already = released.has(id);
          if (!already) released.set(id, "2026-10-25T03:00:00.000Z");
          return jsonReply(200, { result: { prizeQualificationId: id, releasedAt: released.get(id), alreadyReleased: already } });
        }
        if (call.method === "GET" && call.url.startsWith(`${API}/admin/qualifications?`)) {
          return jsonReply(200, { qualifications: list.map((q: any) => (released.has(q.prizeQualificationId) ? { ...q, releasedAt: released.get(q.prizeQualificationId), releasedByGamingMemberId: "staff-1", releaseReason: "Approved" } : q)) });
        }
        return undefined;
      },
    };
    return server;
  }
  const setReleaseReason = (page: Page, value: string) => { (page.doc.getElementById("q-release-reason") as HTMLInputElement).value = value; };
  const releaseButton = (page: Page, id: string) => page.doc.querySelector(`button[data-release-hold="${id}"]`) as HTMLButtonElement | null;

  it("an entitlement on hold says so, withholds Mark Redeemed, offers only Release hold, and shows why and what was delivered earlier", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-held")).toBe("On hold");
    expect(redeemButton(page, "q-held")).toBeNull();
    expect(releaseButton(page, "q-held")).not.toBeNull();
    const note = rowFor(page, "q-held").querySelector(".hold-note")!.textContent!;
    expect(note).toContain("Do NOT hand this over");
    expect(note).toContain("Already delivered earlier: Jersey");
    expect(note).toContain("Why it is on hold: A correction changed a prize that was already delivered");
    expect(page.text("#prizes-summary")).toContain("1 on hold");
    expect(banner(page).textContent).toContain("ON HOLD");
    page.close();
  });

  it("an entitlement satisfied by an earlier handover says so, offers no button, and names what was delivered", async () => {
    const page = await loadPage({ respond: releaseServer().respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-fulfilled")).toBe("Already delivered");
    expect(rowButtons(page, "q-fulfilled")).toHaveLength(0);
    const note = rowFor(page, "q-fulfilled").querySelector(".hold-note")!.textContent!;
    expect(note).toContain("An earlier handover already satisfies this prize");
    expect(note).toContain("Burger");
    expect(note).toContain("Do NOT hand it over again");
    expect(page.text("#prizes-summary")).toContain("1 already delivered");
    page.close();
  });

  it("a released hold is Pending again with its reason shown, and Mark Redeemed is available", async () => {
    const page = await loadPage({ respond: releaseServer().respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-released")).toBe("Pending");
    expect(redeemButton(page, "q-released")).not.toBeNull();
    expect(rowFor(page, "q-released").textContent).toContain("Hold released: Founder approved the scarf");
    page.close();
  });

  it("the delivered original (superseded) keeps its delivery visible as history", async () => {
    const page = await loadPage({ respond: releaseServer().respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-delivered")).toBe("Superseded (was redeemed)");
    expect(rowButtons(page, "q-delivered")).toHaveLength(0);
    page.close();
  });

  // Legacy deliveries: recorded before delivery-time labels were kept. The page may say what is KNOWN, never present today's
  // prize definition as what was handed over.
  const LEGACY_DELIVERED = qual({
    prizeQualificationId: "q-legacy", gamingMemberId: "44444444-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Lena Legacy", prizeLabel: "Jersey",
    redeemedAt: "2026-10-01T23:00:00.000Z", redeemedPrizeLabel: null, redeemedPrizeLabelBasis: "OBSERVED_AT_MIGRATION", legacyObservedPrizeLabel: "Premium Jersey",
    supersededAt: "2026-10-25T01:00:00.000Z",
  });
  const LEGACY_HELD = qual({
    prizeQualificationId: "q-legacy-held", gamingMemberId: "44444444-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Lena Legacy", prizeLabel: "Jersey",
    heldAt: "2026-10-25T01:00:00.000Z", holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPriorPrizeQualificationId: "q-legacy", replacesPrizeQualificationId: "q-legacy",
    holdReason: 'A correction affected a prize that was already delivered, but that delivery was recorded before delivery-time prize labels were kept, so it cannot be shown to be the same prize.',
  });
  const UNKNOWN_DELIVERED = qual({
    prizeQualificationId: "q-unknown", gamingMemberId: "55555555-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Uma Unknown", prizeLabel: "Cap",
    redeemedAt: "2026-10-02T23:00:00.000Z", redeemedPrizeLabel: null, redeemedPrizeLabelBasis: "UNKNOWN", legacyObservedPrizeLabel: null, supersededAt: "2026-10-25T01:00:00.000Z",
  });
  const UNKNOWN_HELD = qual({
    prizeQualificationId: "q-unknown-held", gamingMemberId: "55555555-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Uma Unknown", prizeLabel: "Cap",
    heldAt: "2026-10-25T01:00:00.000Z", holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPriorPrizeQualificationId: "q-unknown", replacesPrizeQualificationId: "q-unknown",
    holdReason: "Delivery recorded before delivery-time prize labels were kept.",
  });
  const ORDER_HELD = qual({
    prizeQualificationId: "q-order-held", gamingMemberId: "66666666-aaaa-4bbb-8ccc-dddddddddddd", memberDisplayName: "Otto Order", prizeLabel: "Scarf",
    heldAt: "2026-10-25T01:00:00.000Z", holdBasis: "DELIVERY_ORDER_UNKNOWN", holdPriorPrizeQualificationId: null,
    holdReason: "The order of this member's deliveries and replacements could not be established from the records.",
  });
  const LEGACY_LIST = [LEGACY_DELIVERED, LEGACY_HELD, UNKNOWN_DELIVERED, UNKNOWN_HELD, ORDER_HELD];

  it("a hold on a legacy delivery never states today's definition as what was handed over; it says the label was not recorded and sends the staff to the venue", async () => {
    const page = await loadPage({ respond: releaseServer(LEGACY_LIST).respond });
    await loadQualifications(page);
    const note = rowFor(page, "q-legacy-held").querySelector(".hold-note")!.textContent!;
    expect(note).toContain("Do NOT hand this over");
    expect(note).toContain("a prize whose label was not recorded");
    expect(note).toContain('its definition today is "Premium Jersey", which may not be what was handed over');
    expect(note).toContain("Confirm with the venue what was actually handed over before releasing");
    expect(note).not.toMatch(/Already delivered earlier: (Jersey|Premium Jersey) on/);
    page.close();
  });

  it("a legacy delivery with no readable definition shows no label at all, and never falls back to the prize today's tier carries", async () => {
    const page = await loadPage({ respond: releaseServer(LEGACY_LIST).respond });
    await loadQualifications(page);
    const note = rowFor(page, "q-unknown-held").querySelector(".hold-note")!.textContent!;
    expect(note).toContain("a prize whose label was not recorded");
    expect(note).not.toContain("its definition today is");
    expect(note).not.toMatch(/Already delivered earlier: Cap/);
    expect(note).toContain("Confirm with the venue");
    page.close();
  });

  it("a hold whose earlier delivery's order is unknown names no earlier prize, shows the reason, and still asks for a venue check", async () => {
    const page = await loadPage({ respond: releaseServer(LEGACY_LIST).respond });
    await loadQualifications(page);
    expect(pillOf(page, "q-order-held")).toBe("On hold");
    expect(redeemButton(page, "q-order-held")).toBeNull();
    expect(releaseButton(page, "q-order-held")).not.toBeNull();
    const note = rowFor(page, "q-order-held").querySelector(".hold-note")!.textContent!;
    expect(note).not.toContain("Already delivered earlier");
    expect(note).toContain("could not be established from the records");
    expect(note).toContain("Confirm with the venue");
    page.close();
  });

  it("a redeemed legacy row says its delivery predates recorded labels instead of showing one", async () => {
    const page = await loadPage({ respond: releaseServer([{ ...LEGACY_DELIVERED, supersededAt: null }]).respond });
    await loadQualifications(page);
    const text = rowFor(page, "q-legacy").textContent!;
    expect(text).toContain("Delivered before delivery records were kept: what was handed over is not recorded.");
    expect(text).not.toContain("Delivered as:");
    page.close();
  });

  it("the release confirmation for a legacy hold asks the staff to confirm with the venue, and does not call today's definition the delivered prize", async () => {
    const server = releaseServer(LEGACY_LIST);
    const page = await loadPage({ respond: server.respond, confirm: false });
    await loadQualifications(page);
    setReleaseReason(page, "Venue confirmed a jersey was handed over");
    releaseButton(page, "q-legacy-held")!.click();
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    const prompt = promptOf(page);
    expect(prompt).toContain("Already delivered earlier: a prize whose label was not recorded");
    expect(prompt).toContain("confirm with the venue what was actually handed over before releasing");
    expect(prompt).not.toMatch(/Already delivered earlier: (Jersey|Premium Jersey) on/);
    page.close();
  });

  it("a hold on a delivery recorded at the handover still states that prize as fact, with no venue check added", async () => {
    const page = await loadPage({ respond: releaseServer().respond });
    await loadQualifications(page);
    const note = rowFor(page, "q-held").querySelector(".hold-note")!.textContent!;
    expect(note).toContain("Already delivered earlier: Jersey on");
    expect(note).not.toContain("Confirm with the venue");
    page.close();
  });

  it("releasing needs a reason: without one there is no confirm and no request, and the cursor goes to the reason box", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    releaseButton(page, "q-held")!.click();
    await page.until(() => banner(page).textContent!.includes("needs a reason"), "the refusal");
    expect(banner(page).textContent).toContain("Nothing was released");
    expect(page.confirm).not.toHaveBeenCalled();
    expect(posts(page, "/release-hold")).toHaveLength(0);
    expect(page.doc.activeElement?.id).toBe("q-release-reason");
    setReleaseReason(page, "  \n ");
    releaseButton(page, "q-held")!.click();
    await page.until(() => page.confirm.mock.calls.length === 0 && banner(page).textContent!.includes("needs a reason"), "whitespace is no reason");
    page.close();
  });

  it("releasing asks first with the prize, player, member id, what was delivered and the reason; a declined confirm sends nothing", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond, confirm: false });
    await loadQualifications(page);
    setReleaseReason(page, "  Founder approved   the cap ");
    releaseButton(page, "q-held")!.click();
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    const prompt = promptOf(page);
    expect(prompt).toContain("Prize: Cap");
    expect(prompt).toContain("Player: Dora Delivered");
    expect(prompt).toContain("Member ID: 11111111");
    expect(prompt).toContain("Already delivered earlier: Jersey");
    expect(prompt).toContain("Reason: Founder approved the cap");
    expect(prompt).toContain("does NOT hand anything over");
    await settle(20);
    expect(posts(page, "/release-hold")).toHaveLength(0);
    page.close();
  });

  it("a confirmed release sends the reason once, says nothing has been handed over, reloads, and the row is Pending with Mark Redeemed", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    setReleaseReason(page, "Founder approved the cap");
    releaseButton(page, "q-held")!.click();
    await page.until(() => posts(page, "/release-hold").length === 1, "the release request");
    expect(posts(page, "/release-hold")[0].url).toBe(`${API}/admin/qualifications/q-held/release-hold`);
    expect(posts(page, "/release-hold")[0].body).toEqual({ reason: "Founder approved the cap" });
    await page.until(() => pillOf(page, "q-held") === "Pending", "the released row");
    expect(banner(page).textContent).toContain("Hold released");
    expect(banner(page).textContent).toContain("Nothing has been handed over");
    expect(redeemButton(page, "q-held")).not.toBeNull();
    expect(posts(page, "/redeem")).toHaveLength(0);
    expect((page.doc.getElementById("q-release-reason") as HTMLInputElement).value).toBe("");
    page.close();
  });

  it("a double press releases once", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    setReleaseReason(page, "Approved");
    const button = releaseButton(page, "q-held")!;
    button.click();
    button.disabled = false;
    button.click();
    await settle(40);
    expect(posts(page, "/release-hold")).toHaveLength(1);
    page.close();
  });

  it("a 403 says finalizer authority is needed; a 409 reloads the list; a lost answer says to look and that repeating is safe", async () => {
    const server = releaseServer();
    const page = await loadPage({ respond: server.respond });
    await loadQualifications(page);
    setReleaseReason(page, "Approved");

    server.mode = "403";
    releaseButton(page, "q-held")!.click();
    await page.until(() => banner(page).textContent!.includes("CONSEQUENTIAL_FINALIZER authority"), "the authority message");
    expect(releaseButton(page, "q-held")!.disabled).toBe(false);

    server.mode = "409";
    const reads = qualGets(page).length;
    releaseButton(page, "q-held")!.click();
    await page.until(() => banner(page).textContent!.includes("The list was refreshed"), "the 409 message");
    expect(qualGets(page).length).toBeGreaterThan(reads);

    server.mode = "reject";
    releaseButton(page, "q-held")!.click();
    await page.until(() => banner(page).textContent!.includes("Could not confirm that the hold"), "the unconfirmed message");
    expect(banner(page).textContent).toContain("Pressing Release hold again is safe");
    expect(releaseButton(page, "q-held")!.disabled).toBe(false);
    page.close();
  });

  it("every winner row shows a stable member id, not only a display name, and it is in the redeem confirm and searchable", async () => {
    const page = await loadPage({ respond: releaseServer().respond });
    await loadQualifications(page);
    for (const row of page.doc.querySelectorAll("#table-qualifications tbody tr")) {
      expect(row.querySelector(".member-id")!.textContent).toMatch(/^Member ID [0-9a-z-]{4,8}$/i);
      expect((row as HTMLElement).dataset.memberId).toBeTruthy();
    }
    expect(rowFor(page, "q-released").querySelector(".member-id")!.textContent).toBe("Member ID 33333333");
    redeemButton(page, "q-released")!.click();
    await page.until(() => page.confirm.mock.calls.length === 1, "the confirm");
    expect(promptOf(page)).toContain("Member ID: 33333333");

    (page.doc.getElementById("q-filter") as HTMLInputElement).value = "3333333";
    page.doc.getElementById("q-filter")!.dispatchEvent(new page.win.Event("input"));
    expect(rowFor(page, "q-released").hidden).toBe(false);
    expect(rowFor(page, "q-held").hidden).toBe(true);
    page.close();
  });

  it("the redeem route's refusals for a hold or a satisfied prize are shown as refusals, not as an unknown outcome", async () => {
    const respond: Responder = (call) => {
      if (call.method === "POST" && call.url.endsWith("/redeem")) return jsonReply(409, { error: "This prize is on hold until a Consequential Finalizer releases it." });
      return releaseServer().respond(call);
    };
    const page = await loadPage({ respond });
    await loadQualifications(page);
    redeemButton(page, "q-released")!.click();
    await page.until(() => banner(page).textContent!.includes("on hold"), "the refusal");
    expect(pillOf(page, "q-released")).not.toBe("Status unknown");
    page.close();
  });
});

describe("F8. Classification wording", () => {
  it("does not claim Casual or Ranked are 'not offered': they are shown as set outside this page, and an unset match is closed", async () => {
    const page = await loadPage({ respond: (call) => (call.url === `${API}/admin/matches` ? jsonReply(200, { matches: [
      { ...MATCHES[0], activityClassification: "CASUAL" },
      { ...MATCHES[2], matchId: "m4", activityClassification: "RANKED" },
      { ...MATCHES[2], matchId: "m5", activityClassification: null },
    ], teams: TEAMS }) : undefined) });
    const text = page.doc.getElementById("admin-sections")!.textContent!; // what a person sees, not the script source
    expect(text).not.toContain("not offered");
    expect(text).toContain("Casual (set outside this page)");
    expect(text).toContain("Ranked (set outside this page)");
    expect(text).toContain("Not set - predictions are closed");
    expect(page.text("#classification-help")).toContain("This page sets only Official or Trial / test run");
    page.close();
  });
});

// =================================================================================================================================
// J. THE ACCESS GATE. The page decides nothing about who may use it: it asks the server, for the member signed in right now, and until
//    the server says an administrative class is active it draws no controls, no data and makes no administrative request.
// =================================================================================================================================

const ACCESS_URL = `${API}/admin/access`;
const adminGets = (page: Page) => page.calls.filter((c) => c.url.startsWith(`${API}/admin/`) && c.url !== ACCESS_URL);
const sectionsVisible = (page: Page) => (page.doc.getElementById("admin-sections") as HTMLElement).style.display !== "none";
const gateText = (page: Page) => page.text("#gate-message");
// Drawn means the element, and every container it sits in, is not display:none (a hidden row hides the button inside it).
const shown = (page: Page, selector: string) => {
  const el = page.doc.querySelector(selector) as HTMLElement | null;
  if (!el) return false;
  for (let node: HTMLElement | null = el; node && node !== page.doc.documentElement; node = node.parentElement) {
    if (page.win.getComputedStyle(node).display === "none") return false;
  }
  return true;
};
const tablesEmpty = (page: Page) => ["#table-roster", "#table-matches", "#table-venues", "#table-activations", "#table-qualifications"].every((t) => page.doc.querySelectorAll(`${t} tbody tr`).length === 0);
const OTHER_MEMBER = { status: "authenticated", email: "other@example.com", gamingMemberId: "other-1", displayName: "Other Member" };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe("J. the page and its sign-in", () => {
  it("is titled URBANO Score — Administración, in the tab and in the heading", async () => {
    const page = await loadPage({});
    expect(page.doc.title).toBe("URBANO Score — Administración");
    expect(page.text("h1")).toBe("URBANO Score — Administración");
    page.close();
  });

  it("asks the shared sign-in for the login-only entry, and never offers or uses account creation", () => {
    expect(HTML).toContain('{ accountEntry: "login-only", returnTo: "score-admin" }');
    expect(HTML).not.toMatch(/Create account|Crear cuenta|requestOtp|completeProfile|createGamingMember|\/api\/gaming\/member/i);
  });

  it("has no email address, domain or name in its source and takes no decision from one", () => {
    expect(HTML).not.toMatch(/tecnomovi|hotmail|@[a-z0-9-]+\.(com|org|net|hn)\b/i);
    expect(HTML).not.toMatch(/\.email\b|\.displayName\s*(===|==|!==|!=)/);
  });
});

describe("J. nothing administrative exists until the server has confirmed the member", () => {
  it("while the check is pending: no sections, no controls drawn, no data, no administrative request; only the gate", async () => {
    const pending = deferred<Reply>();
    const page = await loadPage({ access: pending.promise, noWait: true });
    expect(gateText(page)).toBe("Comprobando acceso…");
    expect(sectionsVisible(page)).toBe(false);
    expect(tablesEmpty(page)).toBe(true);
    expect(adminGets(page)).toEqual([]);
    expect(page.calls.filter((c) => c.url === ACCESS_URL)).toHaveLength(1);
    // and once it answers, only then does anything appear
    pending.resolve(jsonReply(200, { access: true, classes: ALL_CLASSES }));
    await page.until(() => sectionsVisible(page) && page.doc.querySelectorAll("#table-matches tbody tr").length > 0, "the sections after confirmation");
    const firstAdminGet = page.calls.findIndex((c) => c.url !== ACCESS_URL && c.url.startsWith(`${API}/admin/`));
    expect(page.calls.findIndex((c) => c.url === ACCESS_URL)).toBeLessThan(firstAdminGet);
    page.close();
  });

  it("a signed-in member with NO administrative authority sees only: «Esta cuenta no tiene acceso administrativo», with sign out and use another account", async () => {
    const page = await loadPage({ access: jsonReply(403, { error: "This account has no administrative access." }), noWait: true });
    expect(gateText(page)).toBe("Esta cuenta no tiene acceso administrativo");
    expect(page.text("#gate-detail")).toBe("This account does not have administrative access.");
    expect(sectionsVisible(page)).toBe(false);
    expect(tablesEmpty(page)).toBe(true);
    expect((page.doc.getElementById("btn-gate-signout") as HTMLElement).hidden).toBe(false);
    expect((page.doc.getElementById("btn-gate-switch") as HTMLElement).hidden).toBe(false);
    expect((page.doc.getElementById("btn-gate-retry") as HTMLElement).hidden).toBe(true);
    expect(adminGets(page)).toEqual([]); // not one administrative request was made for them
    page.close();
  });

  it("the public site's session grants nothing here: a member who is signed in elsewhere gets the same refusal", async () => {
    const page = await loadPage({ access: jsonReply(403, {}), noWait: true });
    page.setAuth({ ...OTHER_MEMBER });
    page.fireAuthEvent();
    await settle(60);
    expect(gateText(page)).toBe("Esta cuenta no tiene acceso administrativo");
    expect(sectionsVisible(page)).toBe(false);
    expect(adminGets(page)).toEqual([]);
    page.close();
  });

  it("signed out: the gate asks to sign in, no probe and no administrative request is made", async () => {
    const page = await loadPage({ noWait: true });
    page.setAuth({ status: "unauthenticated" });
    page.fireAuthEvent();
    await settle(60);
    expect(gateText(page)).toBe("Inicia sesión con una cuenta administrativa.");
    expect(page.text("#auth-status")).toBe("Not signed in.");
    expect(sectionsVisible(page)).toBe(false);
    page.close();
  });

  it("an identity with no finished Gaming Member is not an administrator: refused without asking, and nothing creates the member", async () => {
    const page = await loadPage({ noWait: true });
    const probesBefore = page.calls.filter((c) => c.url === ACCESS_URL).length;
    page.setAuth({ status: "profile_incomplete", email: "ghost@example.com" });
    page.fireAuthEvent();
    await settle(60);
    expect(gateText(page)).toBe("Esta cuenta no tiene acceso administrativo");
    expect(sectionsVisible(page)).toBe(false);
    expect(page.calls.filter((c) => c.url === ACCESS_URL)).toHaveLength(probesBefore);
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([]);
    page.close();
  });

  it("a token that is no longer valid (401) sends the person back to sign in; a check that cannot be made shows no controls and offers a retry", async () => {
    const expired = await loadPage({ access: jsonReply(401, {}), noWait: true });
    expect(gateText(expired)).toBe("Inicia sesión con una cuenta administrativa.");
    expect(sectionsVisible(expired)).toBe(false);
    expired.close();

    for (const failure of [jsonReply(500, {}), jsonReply(200, { access: "yes" }), jsonReply(200, { access: true, classes: [] }), jsonReply(200, { access: true, classes: ["SUPERUSER"] }), "reject" as const]) {
      const page = await loadPage({ access: failure as Reply, noWait: true });
      const denied = failure !== "reject" && (failure as { json?: { classes?: unknown[] } }).json?.classes !== undefined;
      expect(sectionsVisible(page)).toBe(false);
      expect(tablesEmpty(page)).toBe(true);
      expect(adminGets(page)).toEqual([]);
      expect(gateText(page)).toBe(denied ? "Esta cuenta no tiene acceso administrativo" : "No se pudo comprobar el acceso.");
      page.close();
    }
  });

  it("Reintentar asks again and, once the server confirms, the screen loads", async () => {
    const page = await loadPage({ access: jsonReply(500, {}), noWait: true });
    expect(gateText(page)).toBe("No se pudo comprobar el acceso.");
    page.setAccess(jsonReply(200, { access: true, classes: ALL_CLASSES }));
    (page.doc.getElementById("btn-gate-retry") as HTMLButtonElement).click();
    await page.until(() => sectionsVisible(page) && page.doc.querySelectorAll("#table-matches tbody tr").length > 0, "the screen after the retry");
    page.close();
  });
});

describe("J. what is drawn follows the classes the server reported", () => {
  it("OPERATIONAL only: the catalog forms are there; classification, Finalize, Mark Redeemed and Release hold are not drawn", async () => {
    const page = await loadPage({ classes: ["OPERATIONAL"] });
    await loadQualifications(page);
    expect(page.doc.body.dataset.op).toBe("1");
    expect(page.doc.body.dataset.fin).toBe("0");
    expect(shown(page, "#btn-create-team")).toBe(true);
    expect(shown(page, "#btn-create-venue")).toBe(true);
    expect(shown(page, "#btn-save-draft")).toBe(true);
    expect(shown(page, "[data-toggle]")).toBe(true);
    expect(shown(page, "[data-cancel]")).toBe(true);
    expect(shown(page, "#btn-finalize")).toBe(false);
    expect(shown(page, "[data-classification-for]")).toBe(false);
    expect(shown(page, "[data-classification-save]")).toBe(false);
    expect(shown(page, "[data-redeem]")).toBe(false);
    expect(shown(page, "#q-release-reason")).toBe(false);
    expect(page.text("#authority-note")).toContain("Authority on this account: OPERATIONAL.");
    page.close();
  });

  it("CONSEQUENTIAL_FINALIZER only: classification, Finalize and the prize actions are there; every catalog form is not drawn and the draft editor is switched off", async () => {
    const page = await loadPage({ classes: ["CONSEQUENTIAL_FINALIZER"] });
    await loadQualifications(page);
    expect(page.doc.body.dataset.op).toBe("0");
    expect(page.doc.body.dataset.fin).toBe("1");
    expect(shown(page, "#btn-finalize")).toBe(true);
    expect(shown(page, "[data-classification-for]")).toBe(true);
    expect(shown(page, "[data-redeem]")).toBe(true);
    expect(shown(page, "#q-release-reason")).toBe(true);
    for (const hidden of ["#btn-create-team", "#btn-create-player", "#btn-create-players", "#btn-create-match", "#btn-create-venue", "#btn-create-activation", "#btn-create-tier", "#btn-save-draft", "[data-toggle]", "[data-cancel]", "[data-toggle-player]"]) {
      expect(shown(page, hidden), hidden).toBe(false);
    }
    expect(page.doc.getElementById("result-editor")!.hasAttribute("inert")).toBe(true);
    // the evidence an operator prepared is still readable
    expect(page.doc.querySelectorAll("#table-matches tbody tr").length).toBeGreaterThan(0);
    page.close();
  });

  it("PRODUCT_GOVERNANCE alone can look and change nothing: every mutation control is gone, every list is readable", async () => {
    const page = await loadPage({ classes: ["PRODUCT_GOVERNANCE"] });
    await loadQualifications(page);
    expect(page.doc.body.dataset.op).toBe("0");
    expect(page.doc.body.dataset.fin).toBe("0");
    expect(page.doc.body.dataset.gov).toBe("1");
    for (const hidden of ["#btn-create-team", "#btn-create-match", "#btn-create-venue", "#btn-save-draft", "#btn-finalize", "[data-toggle]", "[data-cancel]", "[data-classification-save]", "[data-redeem]", "#q-release-reason"]) {
      expect(shown(page, hidden), hidden).toBe(false);
    }
    expect(page.doc.querySelectorAll("#table-matches tbody tr").length).toBeGreaterThan(0);
    page.close();
  });

  it("all three classes: every control is drawn", async () => {
    const page = await loadPage({});
    await loadQualifications(page);
    for (const visible of ["#btn-create-team", "#btn-create-match", "#btn-create-venue", "#btn-create-activation", "#btn-save-draft", "#btn-finalize", "[data-toggle]", "[data-cancel]", "[data-classification-save]", "[data-redeem]", "#q-release-reason"]) {
      expect(shown(page, visible), visible).toBe(true);
    }
    expect(page.doc.getElementById("result-editor")!.hasAttribute("inert")).toBe(false);
    page.close();
  });
});

describe("J. authority that disappears, and people who change", () => {
  it("a 403 on an action is shown once and NEVER repeated; the page asks who the member is, and if the authority is gone the screen closes and empties", async () => {
    const page = await loadPage({});
    page.setResponder((call) => {
      if (call.method === "POST" && call.url === `${API}/admin/teams`) return jsonReply(403, { error: "This action requires OPERATIONAL authority." });
      return undefined;
    });
    page.setAccess(jsonReply(403, { error: "This account has no administrative access." }));
    (page.doc.getElementById("t-name") as HTMLInputElement).value = "New FC";
    (page.doc.getElementById("btn-create-team") as HTMLButtonElement).click();
    await page.until(() => !sectionsVisible(page), "the screen closing");
    await settle(80);
    expect(posts(page, "/admin/teams")).toHaveLength(1); // the refused request was sent exactly once
    expect(gateText(page)).toBe("Esta cuenta no tiene acceso administrativo");
    expect(tablesEmpty(page)).toBe(true);
    expect((page.doc.getElementById("t-name") as HTMLInputElement).value).toBe("");
    page.close();
  });

  it("a 403 for one action while the member still holds other authority keeps the screen, and the refused action is not repeated", async () => {
    const page = await loadPage({ classes: ["OPERATIONAL"] });
    page.setResponder((call) => {
      if (call.method === "POST" && call.url === `${API}/admin/venues`) return jsonReply(403, { error: "This action requires OPERATIONAL authority." });
      return undefined;
    });
    for (const [id, value] of [["v-name", "Beer Box 2"], ["v-lat", "14.1"], ["v-lng", "-87.2"], ["v-radius", "100"]]) (page.doc.getElementById(id as string) as HTMLInputElement).value = value as string;
    (page.doc.getElementById("btn-create-venue") as HTMLButtonElement).click();
    await page.until(() => page.text("#msg-venue").length > 0, "the refusal message");
    await settle(80);
    expect(posts(page, "/admin/venues")).toHaveLength(1);
    expect(sectionsVisible(page)).toBe(true);
    page.close();
  });

  it("a revoked CLASS takes its controls away at the next check: OPERATIONAL withdrawn, the finalizer's controls stay", async () => {
    const page = await loadPage({});
    expect(shown(page, "#btn-create-team")).toBe(true);
    page.setAccess(jsonReply(200, { access: true, classes: ["CONSEQUENTIAL_FINALIZER"] }));
    page.fireAuthEvent();
    await page.until(() => !shown(page, "#btn-create-team"), "the operational controls leaving");
    expect(shown(page, "#btn-finalize")).toBe(true);
    page.close();
  });

  it("administrator → another member: the controls and every list are gone at once, before the new answer; a late answer for the old person is thrown away", async () => {
    const page = await loadPage({});
    expect(sectionsVisible(page)).toBe(true);
    const slowForOld = deferred<Reply>();
    page.setAccess(slowForOld.promise); // the check for whoever is next is slow
    page.setAuth({ ...OTHER_MEMBER });
    page.fireAuthEvent();
    await page.until(() => !sectionsVisible(page), "the screen closing at once");
    expect(tablesEmpty(page)).toBe(true);
    expect(gateText(page)).toBe("Comprobando acceso…");
    // the new member turns out to hold nothing; then the OLD answer (an administrator's) arrives late
    page.setAccess(jsonReply(403, {}));
    page.setAuth({ ...OTHER_MEMBER, gamingMemberId: "other-2" });
    page.fireAuthEvent();
    await settle(60);
    slowForOld.resolve(jsonReply(200, { access: true, classes: ALL_CLASSES }));
    await settle(80);
    expect(sectionsVisible(page)).toBe(false);
    expect(tablesEmpty(page)).toBe(true);
    expect(gateText(page)).toBe("Esta cuenta no tiene acceso administrativo");
    page.close();
  });

  it("another member → the administrator: nothing appears until the server confirms, and then only their own data", async () => {
    const page = await loadPage({ access: jsonReply(403, {}), noWait: true });
    expect(sectionsVisible(page)).toBe(false);
    const pending = deferred<Reply>();
    page.setAccess(pending.promise);
    page.setAuth({ ...STAFF_STATE, gamingMemberId: "staff-2" });
    page.fireAuthEvent();
    await settle(60);
    expect(sectionsVisible(page)).toBe(false);
    expect(adminGets(page)).toEqual([]);
    pending.resolve(jsonReply(200, { access: true, classes: ALL_CLASSES }));
    await page.until(() => sectionsVisible(page) && page.doc.querySelectorAll("#table-matches tbody tr").length > 0, "the administrator's screen");
    page.close();
  });

  it("the same member signing in again keeps the screen while the check repeats; if that check cannot be made, every control is switched off but nothing is lost", async () => {
    const page = await loadPage({});
    await loadQualifications(page);
    const rowsBefore = page.doc.querySelectorAll("#table-qualifications tbody tr").length;
    const hold = deferred<Reply>();
    page.setAccess(hold.promise);
    page.fireAuthEvent();
    await settle(40);
    expect(sectionsVisible(page)).toBe(true); // same confirmed member: no flicker while the check repeats
    hold.resolve("reject" as unknown as Reply);
    await page.until(() => (page.doc.getElementById("admin-sections") as HTMLElement).hasAttribute("inert"), "the screen switching off");
    expect(page.text("#gate-message")).toContain("No se pudo volver a comprobar el acceso");
    expect(page.doc.querySelectorAll("#table-qualifications tbody tr").length).toBe(rowsBefore); // what was on screen is kept
    expect((page.doc.getElementById("btn-gate-retry") as HTMLElement).hidden).toBe(false);
    page.close();
  });

  it("«Cerrar sesión» signs out and returns to the sign-in request; «Usar otra cuenta» signs out and opens the login-only sign-in", async () => {
    const out = await loadPage({ access: jsonReply(403, {}), noWait: true });
    (out.doc.getElementById("btn-gate-signout") as HTMLButtonElement).click();
    await settle(60);
    expect(out.signOutCount()).toBe(1);
    expect(gateText(out)).toBe("Inicia sesión con una cuenta administrativa.");
    out.close();

    const other = await loadPage({ access: jsonReply(403, {}), noWait: true });
    (other.doc.getElementById("btn-gate-switch") as HTMLButtonElement).click();
    await settle(60);
    expect(other.signOutCount()).toBe(1);
    expect(other.signInOpens).toEqual([{ mode: "login" }]);
    expect(sectionsVisible(other)).toBe(false);
    other.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// K. The operational view. The historical contract-test data (an exact list of ids kept by the SERVER) is not requested unless the admin asks
//    for it by name: the lists come back without it, so no roster is requested for a team that is not shown. Hiding rows in the page after
//    loading them would not save the requests; these tests count the requests.
// ---------------------------------------------------------------------------------------------------------------------------------

import { TEMPORARY_FIXTURE_EXCLUSION as MANIFEST } from "@/lib/gaming/predictions/fixtureExclusionManifest";

describe("K. Operational view and the historical test data", () => {
  const FLAG = "?includeFixtures=1";
  const OWN_TEAMS = [{ teamId: "e1000000-0000-4000-8000-000000000001", name: "Equipo A (ensayo)" }, { teamId: "e1000000-0000-4000-8000-000000000002", name: "Equipo B (ensayo)" }];
  const OWN_MATCH = { matchId: "e3000000-0000-4000-8000-000000000001", homeTeamId: OWN_TEAMS[0]!.teamId, awayTeamId: OWN_TEAMS[1]!.teamId, competition: "Ensayo de ubicación — sin valor", kickoffAt: "2099-01-01T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null };
  const FIXTURE_TEAMS = MANIFEST.teams.map((teamId, i) => ({ teamId, name: `${i % 2 ? "Barcelona" : "Real Madrid"} ${i}` }));
  const FIXTURE_MATCHES = MANIFEST.matches.slice(0, 5).map((matchId, i) => ({ matchId, homeTeamId: FIXTURE_TEAMS[i * 2]!.teamId, awayTeamId: FIXTURE_TEAMS[i * 2 + 1]!.teamId, competition: "Contract Test", kickoffAt: "2026-08-25T18:00:00.000Z", cancelledAt: null, activityClassification: "RANKED", xpEligible: null }));

  // What the server answers: the default view without the manifest, ?includeFixtures=1 with it (the server side is tested in
  // predictionsAdminFixtureRoutes.test.ts and fixtureExclusion.test.ts).
  const catalog: Responder = (call) => {
    const [path0, query] = call.url.split("?");
    const withHistory = query === "includeFixtures=1";
    if (call.method !== "GET") return undefined;
    if (path0 === `${API}/admin/teams`) return jsonReply(200, { teams: withHistory ? [...OWN_TEAMS, ...FIXTURE_TEAMS] : OWN_TEAMS });
    const roster = path0!.match(/^\/api\/gaming\/predictions\/admin\/teams\/([^/]+)\/players$/);
    if (roster) return jsonReply(200, { players: [] });
    if (path0 === `${API}/admin/matches`) return jsonReply(200, { matches: withHistory ? [OWN_MATCH, ...FIXTURE_MATCHES] : [OWN_MATCH], teams: withHistory ? [...OWN_TEAMS, ...FIXTURE_TEAMS] : OWN_TEAMS });
    if (path0 === `${API}/admin/venues`) return jsonReply(200, { venues: [{ venueId: "e4000000-0000-4000-8000-000000000001", name: "Sede de ensayo privado", latitude: 1, longitude: 1, radiusMeters: 100, active: true }] });
    if (path0 === `${API}/admin/activations`) return jsonReply(200, { activations: [] });
    return undefined;
  };
  const checkbox = (page: Page) => page.doc.getElementById("chk-fixtures") as HTMLInputElement;
  const lists = (page: Page) => page.calls.filter((c) => c.method === "GET" && /\/admin\/(teams|matches|venues|activations)(\?|$)/.test(c.url));
  const rosterCalls = (page: Page) => page.calls.filter((c) => /\/players$/.test(c.url));
  const clear = (page: Page) => { page.calls.length = 0; };
  const settleK = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  it("loads the operational view: the lists without the history, and a roster request only for the teams that are shown", async () => {
    const page = await loadPage({ respond: catalog, noActivations: true });
    expect(lists(page).map((c) => c.url)).toEqual([`${API}/admin/teams`, `${API}/admin/matches`, `${API}/admin/venues`, `${API}/admin/activations`]);
    expect(rosterCalls(page)).toHaveLength(OWN_TEAMS.length);
    for (const call of page.calls) expect(call.url, "no fixture id is requested").not.toMatch(new RegExp(MANIFEST.teams.slice(0, 82).join("|")));
    // access check + teams + 2 rosters + matches + venues + activations
    expect(page.calls.filter((c) => c.method === "GET")).toHaveLength(1 + 1 + OWN_TEAMS.length + 3);
    expect(page.doc.querySelectorAll("#p-team option")).toHaveLength(OWN_TEAMS.length);
    page.close();
  });

  it("offers the history by name: «Mostrar datos de prueba históricos», off, with a note saying what is hidden", async () => {
    const page = await loadPage({ respond: catalog, noActivations: true });
    const label = checkbox(page).closest("label")!;
    expect(label.textContent!.trim()).toBe("Mostrar datos de prueba históricos");
    expect(checkbox(page).checked).toBe(false);
    expect(page.text("#fixture-view-note")).toBe("Vista operativa: los datos de prueba históricos están ocultos.");
    page.close();
  });

  it("turning it on asks the server for the history (all four lists with ?includeFixtures=1) and then reads every roster it was given", async () => {
    const page = await loadPage({ respond: catalog, noActivations: true });
    clear(page);
    checkbox(page).checked = true;
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await page.until(() => page.doc.querySelectorAll("#p-team option").length === OWN_TEAMS.length + FIXTURE_TEAMS.length, "the historical teams");
    expect(lists(page).map((c) => c.url)).toEqual([`${API}/admin/teams${FLAG}`, `${API}/admin/matches${FLAG}`, `${API}/admin/venues${FLAG}`, `${API}/admin/activations${FLAG}`]);
    expect(rosterCalls(page)).toHaveLength(OWN_TEAMS.length + FIXTURE_TEAMS.length);
    expect(page.doc.querySelectorAll("#table-matches tbody tr")).toHaveLength(1 + FIXTURE_MATCHES.length);
    expect(page.text("#fixture-view-note")).toContain("Se muestran también los datos de prueba históricos");
    page.close();
  });

  it("turning it off goes back to the operational view and asks for it again: the history leaves the screen and costs no roster", async () => {
    const page = await loadPage({ respond: catalog, noActivations: true });
    checkbox(page).checked = true;
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await page.until(() => page.doc.querySelectorAll("#p-team option").length > OWN_TEAMS.length, "the historical teams");
    clear(page);
    checkbox(page).checked = false;
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await page.until(() => page.doc.querySelectorAll("#p-team option").length === OWN_TEAMS.length, "the operational view");
    expect(lists(page).map((c) => c.url)).toEqual([`${API}/admin/teams`, `${API}/admin/matches`, `${API}/admin/venues`, `${API}/admin/activations`]);
    expect(rosterCalls(page)).toHaveLength(OWN_TEAMS.length);
    expect(page.doc.querySelectorAll("#table-matches tbody tr")).toHaveLength(1);
    expect(page.text("#fixture-view-note")).toBe("Vista operativa: los datos de prueba históricos están ocultos.");
    page.close();
  });

  it("counts the requests: the operational view needs a handful where the historical view needs one per team (equivalent catalog of 82 fixture teams)", async () => {
    const operational = await loadPage({ respond: catalog, noActivations: true });
    const operationalGets = operational.calls.filter((c) => c.method === "GET").length;
    clear(operational);
    checkbox(operational).checked = true;
    checkbox(operational).dispatchEvent(new operational.win.Event("change", { bubbles: true }));
    await operational.until(() => operational.doc.querySelectorAll("#p-team option").length === OWN_TEAMS.length + FIXTURE_TEAMS.length, "the historical teams");
    const historicalReload = operational.calls.filter((c) => c.method === "GET").length; // teams + rosters + matches + venues + activations
    console.log("portal requests: operational load =", operationalGets, "| historical reload (without the access check) =", historicalReload);
    expect(operationalGets).toBe(1 + 1 + OWN_TEAMS.length + 3);
    expect(historicalReload).toBe(1 + OWN_TEAMS.length + FIXTURE_TEAMS.length + 3);
    operational.close();
  });

  it("the switch is guarded: a second change while the reload runs sends nothing more", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow: Responder = async (call) => {
      if (call.url === `${API}/admin/teams${FLAG}`) await held;
      return catalog(call);
    };
    const page = await loadPage({ respond: slow, noActivations: true });
    clear(page);
    checkbox(page).checked = true;
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await settleK();
    expect(checkbox(page).disabled).toBe(true);
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await settleK();
    expect(page.calls.filter((c) => c.url === `${API}/admin/teams${FLAG}`)).toHaveLength(1);
    release!();
    await page.until(() => !checkbox(page).disabled, "the switch to be available again");
    page.close();
  });

  it("another person, or signing out, always starts in the operational view", async () => {
    const page = await loadPage({ respond: catalog, noActivations: true });
    checkbox(page).checked = true;
    checkbox(page).dispatchEvent(new page.win.Event("change", { bubbles: true }));
    await page.until(() => page.doc.querySelectorAll("#p-team option").length > OWN_TEAMS.length, "the historical teams");
    page.setAuth({ status: "authenticated", email: "other@example.com", gamingMemberId: "staff-2", displayName: "Other" });
    clear(page);
    page.fireAuthEvent();
    await page.until(() => lists(page).length === 4 && page.doc.querySelectorAll("#p-team option").length === OWN_TEAMS.length, "the new person's operational view");
    expect(checkbox(page).checked).toBe(false);
    expect(lists(page).every((c) => !c.url.includes("includeFixtures"))).toBe(true);
    page.close();
  });

  it("creating something is not affected: the create requests carry no history flag, and the next reload keeps the chosen view", async () => {
    const page = await loadPage({ noActivations: true, respond: (call) => (call.method === "POST" && call.url === `${API}/admin/teams` ? jsonReply(201, { team: { teamId: "t-new", name: "New" } }) : catalog(call)) });
    (page.doc.getElementById("t-name") as HTMLInputElement).value = "Equipo C (ensayo)";
    clear(page);
    (page.doc.getElementById("btn-create-team") as HTMLButtonElement).click();
    await page.until(() => page.calls.some((c) => c.method === "GET" && c.url === `${API}/admin/teams`), "the reload after creating");
    const post = page.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${API}/admin/teams`);
    expect(page.calls.filter((c) => c.method === "GET" && c.url.includes("includeFixtures"))).toEqual([]);
    page.close();
  });

  it("without the server's confirmation nothing is requested at all, with or without the history", async () => {
    const page = await loadPage({ access: jsonReply(403, {}), noWait: true, respond: catalog });
    expect(page.calls.filter((c) => /\/admin\/(teams|matches|venues|activations)/.test(c.url))).toEqual([]);
    page.close();
  });

  it("the page names the history by its switch only: no id of the manifest, no name or prefix test, no filter applied after loading", () => {
    expect(HTML).not.toMatch(/Contract Test|Real Madrid|Barcelona/);
    expect(HTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(HTML).toContain('"?includeFixtures=1"');
    expect((HTML.match(/catalogQuery\(\)/g) ?? []).length).toBe(4); // the four list requests, and nothing else
  });
});
