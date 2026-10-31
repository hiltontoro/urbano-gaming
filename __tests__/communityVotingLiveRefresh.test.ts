import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

/**
 * UG-IV-GATE-014 — what the phone rehearsal found about LIVE STATE, executed from the exact deployed source text.
 *
 *   1. The operator panel showed 0 votes while the server already counted 5, because nothing refreshed it but an action or a reload.
 *   2. The voter's clock kept running after an early close and the winner appeared ~30 s after publication, because the pages only asked
 *      the server every 10-35 s and never when they became visible again.
 *
 * Part 1 (this half of the file): the generic poller both pages use (one copy in each logic module, pinned identical), the delays each page
 * asks for, and the indicator text. No DOM, no network, no real timers: the clock, the timers, the visibility and the fetch are injected,
 * which is what makes "no overlapping polls", "a stale answer can never overwrite a newer one" and "stop on identity change" provable.
 * Part 2 (below) runs the ACTUAL pages in jsdom with virtual timers.
 */

vi.setConfig({ testTimeout: 60_000 });

type Json = Record<string, any>;
const source = (file: string) => readFileSync(`public/${file}`, "utf-8");
function load<T>(file: string, name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${source(file)}\nreturn ${name};`)() as T;
}

interface PollStatus { running: boolean; refreshing: boolean; failures: number; stale: boolean; ageMs: number | null; terminal: boolean; hidden: boolean }
interface FetchResult { ok: boolean; apply?: () => void; terminal?: boolean }
interface Poller {
  start(): void;
  stop(): void;
  refreshNow(reason?: string): void;
  invalidate(): void;
  markFresh(): void;
  onVisibility(visible: boolean): void;
  status(): PollStatus;
}
interface PollerDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isVisible: () => boolean;
  random: () => number;
  delayFor: (ctx: { failures: number }) => number | null;
  fetchOnce: () => Promise<FetchResult>;
  onStatus?: () => void;
  staleAfterMs?: number;
  jitter?: number;
  maxBackoffMs?: number;
}
interface Operator {
  createPoller(deps: PollerDeps): Poller;
  livePollDelayMs(ctx: { overview: Json | null }): number;
  liveStatus(status: PollStatus): { tone: "off" | "ok" | "refreshing" | "stale" | "paused"; text: string };
  LIVE_POLL: Record<string, number>;
  nextSteps(overview: Json): Array<{ key: string; label: string; done: boolean; enabled: boolean; reason: string | null }>;
}
interface Round {
  createPoller(deps: PollerDeps): Poller;
  pollDelayMs(ctx: { roundRole?: string; phase?: string; published?: boolean; sinceChangeMs?: number }): number;
  POLL: Record<string, number>;
}
const P = load<Operator>("communityVotingRoundOperator.js", "CommunityVotingRoundOperator");
const R = load<Round>("communityVotingRound.js", "CommunityVotingRound");

// ---------------------------------------------------------------- a virtual clock, virtual timers and a scripted fetch

const flush = async () => { for (let i = 0; i < 25; i += 1) await Promise.resolve(); };

function virtualClock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { id += 1; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    /** the delays of the timers still waiting, soonest first */
    pending: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        t = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

/** Each call of fetchOnce waits until the test releases it: this is how overlap, order and cancellation are provoked. */
function scriptedFetch() {
  const calls: Array<{ n: number; release: (r: FetchResult) => void }> = [];
  const fetchOnce = () => new Promise<FetchResult>((resolve) => { calls.push({ n: calls.length + 1, release: resolve }); });
  return { calls, fetchOnce };
}

const BOTH: Array<[string, { createPoller(deps: PollerDeps): Poller }]> = [["operator", P], ["voter", R]];

describe.each(BOTH)("the generic poller — %s copy", (_name, mod) => {
  function setup(over: Partial<PollerDeps> = {}) {
    const clock = virtualClock();
    const f = scriptedFetch();
    const flags = { visible: true, statusCalls: 0 };
    const poller = mod.createPoller({
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      isVisible: () => flags.visible, random: () => 0.5, delayFor: () => 4000,
      fetchOnce: f.fetchOnce, onStatus: () => { flags.statusCalls += 1; },
      ...over,
    });
    return { clock, f, flags, poller };
  }

  it("start() waits one interval before the first poll: whoever starts it has just read the state, so it fetches nothing at once", async () => {
    const { clock, f, poller } = setup();
    poller.start();
    expect(f.calls).toHaveLength(0);
    expect(clock.pending()).toEqual([4000]);
    await clock.advance(3999);
    expect(f.calls).toHaveLength(0);
    await clock.advance(1);
    expect(f.calls).toHaveLength(1);
    expect(poller.status()).toMatchObject({ running: true, refreshing: true });
  });

  it("applies a fresh answer, remembers when it came, and schedules the next poll only AFTER this one finished", async () => {
    const { clock, f, poller } = setup();
    const applied = vi.fn();
    poller.start();
    await clock.advance(4000);
    expect(clock.pending()).toEqual([]); // nothing is scheduled while the poll is in flight
    f.calls[0].release({ ok: true, apply: applied });
    await flush();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(poller.status()).toMatchObject({ refreshing: false, failures: 0, stale: false, ageMs: 0 });
    expect(clock.pending()).toEqual([4000]);
    await clock.advance(4000);
    expect(f.calls).toHaveLength(2);
  });

  it("never has two fetches in flight: a timer, a visibility return and refreshNow arriving together make ONE request, and one follow-up after it", async () => {
    const { clock, f, poller, flags } = setup();
    poller.start();
    await clock.advance(4000); // the timer's poll is in flight
    expect(f.calls).toHaveLength(1);
    poller.refreshNow("manual");
    poller.refreshNow("again");
    flags.visible = true;
    poller.onVisibility(true);
    await flush();
    expect(f.calls).toHaveLength(1); // still ONE request in flight
    f.calls[0].release({ ok: true });
    await flush();
    expect(f.calls).toHaveLength(2); // exactly one coalesced follow-up
    f.calls[1].release({ ok: true });
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([4000]);
  });

  it("refreshNow() with nothing in flight fetches at once and replaces the waiting timer", async () => {
    const { clock, f, poller } = setup();
    poller.start();
    await clock.advance(1000);
    poller.refreshNow("visible");
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
    f.calls[0].release({ ok: true });
    await flush();
    expect(clock.pending()).toEqual([4000]);
  });

  it("invalidate() makes the answer in flight unusable: it is neither applied nor counted as fresh, and the loop goes on", async () => {
    const { clock, f, poller } = setup();
    const applied = vi.fn();
    poller.start();
    await clock.advance(4000);
    poller.invalidate(); // an operator action started an authoritative refresh elsewhere
    f.calls[0].release({ ok: true, apply: applied });
    await flush();
    expect(applied).not.toHaveBeenCalled();
    expect(poller.status().ageMs).toBe(4000); // measured from start: this answer proved nothing
    expect(clock.pending()).toEqual([4000]);
  });

  it("markFresh() records an authoritative refresh made elsewhere and clears the failures", async () => {
    const { clock, f, poller } = setup();
    poller.start();
    await clock.advance(4000);
    f.calls[0].release({ ok: false });
    await flush();
    expect(poller.status().failures).toBe(1);
    await clock.advance(8000);
    f.calls[1].release({ ok: false });
    await flush();
    poller.markFresh();
    expect(poller.status()).toMatchObject({ failures: 0, ageMs: 0, stale: false });
  });

  it("stop() drops the answer in flight, cancels the timer and nothing runs until start(); an answer from before a stop/start is dropped as well", async () => {
    const { clock, f, poller } = setup();
    const old = vi.fn();
    const fresh = vi.fn();
    poller.start();
    await clock.advance(4000);
    poller.stop();
    expect(clock.pending()).toEqual([]);
    expect(poller.status()).toMatchObject({ running: false, stale: false, ageMs: null });
    f.calls[0].release({ ok: true, apply: old });
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(clock.pending()).toEqual([]);
    await clock.advance(60_000);
    expect(f.calls).toHaveLength(1);

    // a new round: start again; the request of the previous one is still pending in the browser and answers LATE
    poller.start();
    await clock.advance(4000);
    expect(f.calls).toHaveLength(2);
    f.calls[1].release({ ok: true, apply: fresh });
    await flush();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("a request started before stop() that answers after start() never applies, even though the loop is running again", async () => {
    const { clock, f, poller } = setup();
    const old = vi.fn();
    poller.start();
    await clock.advance(4000);
    poller.stop();
    poller.start();
    f.calls[0].release({ ok: true, apply: old });
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(poller.status().refreshing).toBe(false);
    expect(clock.pending()).toEqual([4000]); // the new loop is waiting for ITS first interval, unaffected by the old answer
  });

  it("is silent while the page is hidden and refreshes at once when it is visible again", async () => {
    const { clock, f, poller, flags } = setup();
    poller.start();
    flags.visible = false;
    poller.onVisibility(false);
    expect(clock.pending()).toEqual([]);
    expect(poller.status().hidden).toBe(true);
    await clock.advance(120_000);
    expect(f.calls).toHaveLength(0);
    flags.visible = true;
    poller.onVisibility(true);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.calls[0].release({ ok: true });
    await flush();
    expect(clock.pending()).toEqual([4000]);
  });

  it("a poll that finishes while the page is hidden does not schedule another", async () => {
    const { clock, f, poller, flags } = setup();
    poller.start();
    await clock.advance(4000);
    flags.visible = false;
    f.calls[0].release({ ok: true });
    await flush();
    expect(clock.pending()).toEqual([]);
  });

  it("backs off after failures (x2 up to the cap), reports stale after staleAfterMs without a fresh answer, and a success resets both", async () => {
    const { clock, f, poller } = setup({ staleAfterMs: 15_000 });
    poller.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await clock.advance(i === 0 ? 4000 : delays[i - 1]);
      f.calls[i].release({ ok: false });
      await flush();
      delays.push(clock.pending()[0]);
    }
    expect(delays).toEqual([8000, 16_000, 30_000, 30_000, 30_000]);
    expect(poller.status()).toMatchObject({ failures: 5, stale: true });
    await clock.advance(30_000);
    f.calls[5].release({ ok: true });
    await flush();
    expect(poller.status()).toMatchObject({ failures: 0, stale: false, ageMs: 0 });
    expect(clock.pending()).toEqual([4000]);
  });

  it("is not stale before staleAfterMs and is stale after it, whether or not polls are failing", async () => {
    const { clock, poller } = setup({ staleAfterMs: 15_000, delayFor: () => 60_000 });
    poller.start();
    await clock.advance(14_999);
    expect(poller.status().stale).toBe(false);
    await clock.advance(2);
    expect(poller.status().stale).toBe(true);
  });

  it("a terminal answer (the connection itself was refused) ends the loop: no more requests, and the status says so", async () => {
    const { clock, f, poller } = setup();
    poller.start();
    await clock.advance(4000);
    f.calls[0].release({ ok: false, terminal: true });
    await flush();
    expect(poller.status()).toMatchObject({ running: false, terminal: true });
    expect(clock.pending()).toEqual([]);
    await clock.advance(120_000);
    expect(f.calls).toHaveLength(1);
  });

  it("an answer that throws is a failure, never an unhandled rejection or a stuck 'refreshing'", async () => {
    const { clock, poller } = setup({ fetchOnce: async () => { throw new Error("boom"); } });
    poller.start();
    await clock.advance(4000);
    expect(poller.status()).toMatchObject({ refreshing: false, failures: 1 });
    expect(clock.pending()).toEqual([8000]);
  });

  it("jitters each delay within +-20% so a crowd does not call in step", async () => {
    const low = setup({ random: () => 0 });
    low.poller.start();
    expect(low.clock.pending()).toEqual([3200]);
    const high = setup({ random: () => 0.999999 });
    high.poller.start();
    expect(high.clock.pending()[0]).toBeGreaterThan(4790);
    expect(high.clock.pending()[0]).toBeLessThanOrEqual(4800);
  });

  it("a delay of null pauses the loop (nothing to watch) instead of polling for nothing", async () => {
    const { clock, f, poller } = setup({ delayFor: () => null });
    poller.start();
    expect(clock.pending()).toEqual([]);
    await clock.advance(120_000);
    expect(f.calls).toHaveLength(0);
    poller.refreshNow("visible");
    await flush();
    expect(f.calls).toHaveLength(1); // an explicit request still works
  });

  it("tells its listener whenever the status changes (refreshing, fresh, failed, stopped)", async () => {
    const { clock, f, poller, flags } = setup();
    poller.start();
    const afterStart = flags.statusCalls;
    await clock.advance(4000);
    expect(flags.statusCalls).toBeGreaterThan(afterStart);
    const refreshing = flags.statusCalls;
    f.calls[0].release({ ok: true });
    await flush();
    expect(flags.statusCalls).toBeGreaterThan(refreshing);
    const fresh = flags.statusCalls;
    poller.stop();
    expect(flags.statusCalls).toBeGreaterThan(fresh);
  });
});

describe("the two copies of the poller are the SAME text", () => {
  const between = (text: string) => {
    const begin = text.indexOf("// ---- createPoller:begin");
    const end = text.indexOf("// ---- createPoller:end");
    return begin >= 0 && end > begin ? text.slice(begin, end) : "";
  };
  it("is delimited in both logic modules and byte-identical, so the voter page and the operator panel can never drift apart", () => {
    const op = between(source("communityVotingRoundOperator.js"));
    const voter = between(source("communityVotingRound.js"));
    expect(op.length).toBeGreaterThan(500);
    expect(voter).toBe(op);
  });
});

// ---------------------------------------------------------------- the operator's live-refresh delays and indicator

describe("operator: how often the panel asks, and what it says about its data", () => {
  it("asks quickly while voting is open, a little slower while a round is being prepared or waits for its review, and rarely once published", () => {
    expect(P.livePollDelayMs({ overview: { opened: true, closed: false, published: false } })).toBe(4000);
    expect(P.livePollDelayMs({ overview: { opened: false, closed: false, published: false } })).toBe(8000);
    expect(P.livePollDelayMs({ overview: { opened: true, closed: true, published: false } })).toBe(6000);
    expect(P.livePollDelayMs({ overview: { opened: true, closed: true, published: true } })).toBe(20_000);
    expect(P.livePollDelayMs({ overview: null })).toBe(8000);
  });

  it("is bounded: no delay is below 3 seconds or above the backoff cap", () => {
    for (const v of Object.values(P.LIVE_POLL)) expect(v).toBeGreaterThanOrEqual(3000);
    for (const overview of [null, { opened: true }, { opened: true, closed: true }, { published: true }]) {
      const d = P.livePollDelayMs({ overview: overview as Json | null });
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it("says nothing when nothing is being watched, 'refreshing' while a request is out, the age of the data when it is fresh, and says plainly when it is stale", () => {
    const base = { running: true, refreshing: false, failures: 0, stale: false, ageMs: 2500, terminal: false, hidden: false };
    expect(P.liveStatus({ ...base, running: false, ageMs: null })).toEqual({ tone: "off", text: "" });
    expect(P.liveStatus({ ...base, refreshing: true })).toMatchObject({ tone: "refreshing", text: "Actualizando…" });
    expect(P.liveStatus({ ...base, ageMs: 400 })).toMatchObject({ tone: "ok", text: "Actualizado ahora" });
    expect(P.liveStatus(base)).toMatchObject({ tone: "ok", text: "Actualizado hace 2 s" });
    expect(P.liveStatus({ ...base, ageMs: 42_000, stale: true, failures: 3 })).toMatchObject({ tone: "stale", text: expect.stringMatching(/Sin actualizar.*42 s/) });
    expect(P.liveStatus({ ...base, ageMs: 150_000, stale: true })).toMatchObject({ tone: "stale", text: expect.stringMatching(/2 min/) });
    expect(P.liveStatus({ ...base, hidden: true })).toMatchObject({ tone: "paused" });
    expect(P.liveStatus({ ...base, running: false, terminal: true, ageMs: null })).toMatchObject({ tone: "stale", text: expect.stringMatching(/conexión con la ronda/i) });
  });

  it("never presents stale data as current: a stale status is never 'ok', even while a request is out", () => {
    const stale = { running: true, refreshing: true, failures: 2, stale: true, ageMs: 60_000, terminal: false, hidden: false };
    expect(P.liveStatus(stale).tone).not.toBe("ok");
    expect(P.liveStatus(stale).text).toMatch(/Actualizando|Sin actualizar/);
  });
});

// ---------------------------------------------------------------- the public pages' delays

describe("voter and display: how soon the page learns that the round opened, closed or published", () => {
  it("polls a final every 5 s while it is open and every 8 s while it waits to open — the window is only five minutes", () => {
    expect(R.pollDelayMs({ roundRole: "FINAL", phase: "OPEN" })).toBe(5000);
    expect(R.pollDelayMs({ roundRole: "FINAL", phase: "NOT_OPEN" })).toBe(8000);
  });

  it("polls a preliminary every 15 s while it is open and every 20 s while it waits to open — hours long, many voters", () => {
    expect(R.pollDelayMs({ roundRole: "PRELIMINARY", phase: "OPEN" })).toBe(15_000);
    expect(R.pollDelayMs({ roundRole: "PRELIMINARY", phase: "NOT_OPEN" })).toBe(20_000);
  });

  it("after a close it asks every 6 s for the first 3 minutes (the publication is expected soon), then every 20 s, and once published only every 60 s", () => {
    for (const roundRole of ["FINAL", "PRELIMINARY"]) {
      expect(R.pollDelayMs({ roundRole, phase: "CLOSED", published: false, sinceChangeMs: 0 })).toBe(6000);
      expect(R.pollDelayMs({ roundRole, phase: "CLOSED", published: false, sinceChangeMs: 179_999 })).toBe(6000);
      expect(R.pollDelayMs({ roundRole, phase: "CLOSED", published: false, sinceChangeMs: 180_000 })).toBe(20_000);
      expect(R.pollDelayMs({ roundRole, phase: "CLOSED", published: true, sinceChangeMs: 0 })).toBe(60_000);
      expect(R.pollDelayMs({ roundRole, phase: "ENDED", published: true })).toBe(60_000);
    }
  });

  it("is bounded: never below 3 s, and an unknown phase falls back to the slow, safe delay", () => {
    for (const v of Object.values(R.POLL)) expect(v).toBeGreaterThanOrEqual(3000);
    expect(R.pollDelayMs({})).toBe(20_000);
    expect(R.pollDelayMs({ roundRole: "FINAL", phase: "WHATEVER" })).toBe(20_000);
  });
});

// =====================================================================================================================
// Part 2 — the ACTUAL pages, run whole in jsdom with the real logic modules, a scripted server and VIRTUAL time.
// Nothing here waits for real seconds: timers, performance.now(), page visibility and the location sensor are all driven by the test.
// =====================================================================================================================

const OPERATOR_HTML = source("community-voting-round-operator.html");
const VOTER_HTML = source("community-voting-round.html");
const DISPLAY_HTML = source("community-voting-round-display.html");
const FILES: Record<string, string> = {
  "communityVotingRound.js": source("communityVotingRound.js"),
  "communityVotingRoundOperator.js": source("communityVotingRoundOperator.js"),
  "communityVotingSlideshow.js": source("communityVotingSlideshow.js"),
  "urbanoAuth.js": "/* the identity seam is stubbed by the test */",
};
const inlineScripts = (html: string) => html.replace(/<script src="\/([^"]+)"><\/script>/g, (_m, name: string) => `<script>${FILES[name] ?? ""}</script>`);

const INSTANCE = "11111111-2222-4333-8444-555555555555";
const PREFIX = `/api/gaming/community-voting/rounds/${INSTANCE}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BASE_MS = Date.parse("2026-10-31T21:00:00.000Z");

interface Call { at: number; url: string; route: string; method: string; body: any; headers: Record<string, string> }
type Reply = { status: number; json?: unknown };
type AuthState = { status: "unauthenticated" | "profile_incomplete" | "authenticated"; email?: string; authUserId?: string; gamingMemberId?: string };
type Reading = { coords?: { latitude: number; longitude: number; accuracy: number }; errorCode?: number };

async function livePage(opts: {
  html: string; query?: string; auth?: AuthState; session?: Record<string, string>;
  respond: (call: Call) => Reply | Promise<Reply>;
  sensor?: { mode?: "auto" | "manual"; reading?: () => Reading };
}) {
  const calls: Call[] = [];
  let vnow = 0;
  let tid = 0;
  let hidden = false;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  let auth: AuthState = opts.auth ?? { status: "unauthenticated" };
  const changeCallbacks: Array<(s: AuthState) => unknown> = [];
  const resetCallbacks: Array<() => unknown> = [];
  const authListeners: Array<() => void> = [];
  const sensor = { calls: 0, options: [] as Array<Record<string, unknown>>, pending: [] as Array<{ ok: (p: unknown) => void; err: (e: unknown) => void }>, mode: opts.sensor?.mode ?? "auto", reading: opts.sensor?.reading ?? (() => ({ errorCode: 2 } as Reading)) };
  const geo = {
    getCurrentPosition: (ok: (p: unknown) => void, err: (e: unknown) => void, options: Record<string, unknown>) => {
      sensor.calls += 1;
      sensor.options.push(options);
      if (sensor.mode === "manual") { sensor.pending.push({ ok, err }); return; }
      const r = sensor.reading();
      if (r.errorCode) err({ code: r.errorCode }); else ok({ coords: r.coords });
    },
  };
  const dom = new JSDOM(inlineScripts(opts.html), {
    url: `http://localhost/page.html${opts.query ?? `?e=${INSTANCE}`}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      for (const [k, v] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(k, v);
      Object.defineProperty(window.navigator, "geolocation", { value: geo, configurable: true });
      Object.defineProperty(window.document, "hidden", { get: () => hidden, configurable: true });
      Object.defineProperty(window.document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
      Object.defineProperty(window, "performance", { value: { now: () => vnow }, configurable: true });
      w.Math.random = () => 0.5; // jitter factor exactly 1: the delays are the base delays
      w.setTimeout = (fn: () => void, ms = 0) => { tid += 1; timers.set(tid, { at: vnow + Math.max(0, ms), fn }); return tid; };
      w.clearTimeout = (id: number) => { timers.delete(id); };
      w.setInterval = (fn: () => void, ms: number) => { tid += 1; timers.set(tid, { at: vnow + ms, fn, every: ms }); return tid; };
      w.clearInterval = w.clearTimeout;
      w.UrbanoAuth = {
        getState: async () => (auth.status === "unauthenticated" ? auth : { authUserId: "stub-user", gamingMemberId: "stub-member", ...auth }),
        getAccessToken: async () => (auth.status === "unauthenticated" ? null : "stub-access-token"),
        onAuthStateChange: async (cb: () => void) => { authListeners.push(cb); return () => {}; },
        onIdentityChange: async (cb: (s: AuthState) => unknown) => { changeCallbacks.push(cb); return () => {}; },
        onIdentityReset: async (cb: () => unknown) => { resetCallbacks.push(cb); return () => {}; },
        attachSignInButton: () => {},
        requestOtp: async () => ({ status: "sent" }),
        verifyOtp: async (email: string) => { auth = { status: "profile_incomplete", email }; return { status: "profile_incomplete", email }; },
        completeProfile: async (name: string) => { auth = { status: "authenticated", email: auth.email }; return { status: "authenticated", email: auth.email, displayName: name }; },
        signOut: async () => { auth = { status: "unauthenticated" }; return { status: "unauthenticated" }; },
      };
      w.fetch = async (url: string, init: any = {}) => {
        const full = String(url);
        const call: Call = { at: vnow, url: full, route: full.replace(PREFIX, "").split("?")[0], method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} };
        calls.push(call);
        const out = await opts.respond(call);
        return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; }, text: async () => "", blob: async () => new window.Blob([""]) };
      };
      w.Image = class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
      w.URL.createObjectURL = () => "blob:stub";
      w.URL.revokeObjectURL = () => {};
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const settle = async () => { for (let i = 0; i < 6; i += 1) { await new Promise((r) => setImmediate(r)); } };
  async function advance(ms: number) {
    const end = vnow + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      vnow = due[1].at;
      if (due[1].every) due[1].at = vnow + due[1].every; else timers.delete(due[0]);
      due[1].fn();
      await settle();
    }
    vnow = end;
    await settle();
  }
  await settle();
  return {
    win, doc, calls, sensor, advance, settle,
    now: () => vnow,
    $: (sel: string) => doc.querySelector(sel) as HTMLElement | null,
    $$: (sel: string) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[],
    text: () => doc.getElementById("app")?.textContent ?? doc.body.textContent ?? "",
    body: () => doc.body.textContent ?? "",
    modal: () => doc.getElementById("modalRoot")?.textContent ?? "",
    stored: () => { const out: Record<string, string> = {}; for (let i = 0; i < win.sessionStorage.length; i += 1) { const k = win.sessionStorage.key(i) as string; out[k] = win.sessionStorage.getItem(k) as string; } return out; },
    async setHidden(next: boolean) { hidden = next; doc.dispatchEvent(new win.Event("visibilitychange")); await settle(); },
    async signOut() { auth = { status: "unauthenticated" }; for (const cb of resetCallbacks) await cb(); for (const cb of changeCallbacks) await cb({ status: "unauthenticated" }); authListeners.forEach((l) => l()); await settle(); },
    async signInAs(next: AuthState) { auth = next; for (const cb of resetCallbacks) await cb(); for (const cb of changeCallbacks) await cb({ authUserId: "stub-user", ...next }); authListeners.forEach((l) => l()); await settle(); },
    click: async (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); await settle(); },
    type: async (el: Element | null, value: string) => { const i = el as HTMLInputElement; i.value = value; i.dispatchEvent(new win.Event("input", { bubbles: true })); i.dispatchEvent(new win.Event("change", { bubbles: true })); await settle(); },
    count: (route: string, since = 0) => calls.filter((c) => c.route === route && c.at >= since).length,
  };
}
type LivePage = Awaited<ReturnType<typeof livePage>>;

interface Deferred { promise: Promise<void>; release: () => void }
const deferred = (): Deferred => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };

// ---------------------------------------------------------------- the operator's world: a scripted server that behaves like the real one

const entryOf = (n: number, over: Json = {}) => ({ entryId: uuid(n), label: `#${1111 * (n - 200)}`, association: "CONFIRMED", media: "APPROVED", photoId: uuid(n + 100), promotional: "NOT_ASKED", withdrawn: false, carried: true, claimable: false, claimExpiresAt: null, ...over });
const VENUE = { venueLatitude: 14.0723, venueLongitude: -87.1921, venueRadiusMeters: 120, maxAccuracyMeters: 50, insideMarginFactor: 1, outsideMarginFactor: 1 };

function operatorWorld(init: Json = {}) {
  const final = init.role === "FINAL";
  const world = {
    ov: {
      roundRole: final ? "FINAL" : "PRELIMINARY", isTest: true, sessionState: "LOBBY_LOCKED", interactionState: "PROMPT_ACTIVE", opened: true, closed: false, published: false,
      serverNow: "2026-10-31T21:00:00.000Z", windowSeconds: final ? 300 : null, deadlineAt: "2026-10-31T22:00:00.000Z",
      schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: final ? null : "2026-10-31T22:00:00.000Z", status: "TENTATIVE" },
      counters: { boundVoters: 3, votes: 0, entries: 2, withdrawn: 0 }, finalistsSelected: false, noValidResult: false,
      policies: [], pendingResolutions: [] as Json[], review: null as Json | null, tasks: [], publishedAffected: [],
      geofence: final ? { ...VENUE, editable: true, savedAt: null } : null,
      entries: [entryOf(201), entryOf(202)] as Json[],
      ...init.ov,
    } as Json,
    status: 200,
    holds: [] as Deferred[],
    results: { rows: [{ label: "#1111", votes: 2, competitionRank: 1, finalist: true, winner: true, withdrawn: false }] } as Json,
    reviewReply: { status: 201 } as Reply,
    reviewMakesCurrent: true,
    seen: [] as Call[],
  };
  const respond = async (call: Call): Promise<Reply> => {
    world.seen.push(call);
    if (call.route === "/operator/overview") {
      const snapshot = JSON.parse(JSON.stringify(world.ov)); // what the server knew WHEN it received the request
      const gate = world.holds.shift();
      if (gate) await gate.promise;
      if (world.status !== 200) return { status: world.status, json: { code: "INTERNAL_ERROR" } };
      return { status: 200, json: snapshot };
    }
    if (call.route === "/info") return { status: 200, json: { info: { isTest: true }, texts: { galleryConsent: { version: "g", text: "t" }, promoConsent: { version: "p", text: "t" } } } };
    if (call.route === "/operator/results") return world.ov.closed ? { status: 200, json: world.results } : { status: 409, json: { code: "RESULTS_NOT_AVAILABLE" } };
    if (call.route === "/operator/close" && call.method === "POST") { world.ov.closed = true; return { status: 200, json: {} }; }
    if (call.route === "/operator/finalists" && call.method === "POST") { world.ov.finalistsSelected = true; return { status: 200, json: {} }; }
    if (call.route === "/operator/review" && call.method === "POST") {
      if (world.reviewReply.status === 201) world.ov.review = { reviewedAt: "2026-10-31T21:30:00.000Z", digest: "d1", current: world.reviewMakesCurrent };
      return world.reviewReply;
    }
    if (call.route === "/operator/publish" && call.method === "POST") { world.ov.published = true; return { status: 201, json: {} }; }
    return { status: 200, json: {} };
  };
  return { world, respond };
}
const SESSION = { "cvop2:round": JSON.stringify({ instanceId: INSTANCE, hostToken: "host-token-123", ownerUserId: "stub-user" }) };
const operatorPage = (w: ReturnType<typeof operatorWorld>) => livePage({ html: OPERATOR_HTML, respond: w.respond, query: "", auth: { status: "authenticated", authUserId: "stub-user" }, session: SESSION });
const counterOf = (p: LivePage, label: string) => p.$$(".counter").find((c) => c.querySelector("span")?.textContent === label)?.querySelector("b")?.textContent ?? null;
const overviewCalls = (w: ReturnType<typeof operatorWorld>) => w.world.seen.filter((c) => c.route === "/operator/overview");

describe("operator panel — live state without a reload (GATE-014)", () => {
  it("shows the votes, the lifecycle and the review by themselves: no reload and no action", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    expect(counterOf(p, "Votos recibidos")).toBe("0");
    expect(overviewCalls(w)).toHaveLength(1);
    w.world.ov.counters.votes = 5;
    w.world.ov.counters.boundVoters = 7;
    await p.advance(4000);
    expect(overviewCalls(w)).toHaveLength(2);
    expect(counterOf(p, "Votos recibidos")).toBe("5");
    expect(counterOf(p, "Votantes dentro")).toBe("7");
    w.world.ov.closed = true;
    w.world.ov.finalistsSelected = true;
    w.world.ov.review = { reviewedAt: "2026-10-31T21:30:00.000Z", digest: "d1", current: true };
    await p.advance(6000);
    expect(p.$("#roundHeader")?.textContent).toMatch(/Cerrada/);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).toBe("Hecho");
    expect(p.$("#step-PUBLISH")?.hasAttribute("disabled")).toBe(false);
    w.world.ov.published = true;
    await p.advance(6000);
    expect(p.$("#roundHeader")?.textContent).toMatch(/Publicada/);
    expect(p.$("[data-step=PUBLISH] .chip")?.textContent).toBe("Hecho");
  });

  it("asks only as often as it says: 4 s while voting is open, and never more than one request at a time", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.advance(60_000);
    const polls = overviewCalls(w).length - 1;
    expect(polls).toBeGreaterThanOrEqual(14);
    expect(polls).toBeLessThanOrEqual(15);
    const gate = deferred();
    w.world.holds.push(gate);
    const before = overviewCalls(w).length;
    await p.advance(4000);
    expect(overviewCalls(w).length).toBe(before + 1);
    await p.advance(90_000); // the answer is held: no second request may start meanwhile
    expect(overviewCalls(w).length).toBe(before + 1);
    gate.release();
    await p.settle();
    await p.advance(4000);
    expect(overviewCalls(w).length).toBe(before + 2);
  });

  it("a late, OLDER answer never overwrites newer state: the panel keeps what an operator action just brought", async () => {
    const w = operatorWorld();
    w.world.ov.counters.votes = 5;
    const p = await operatorPage(w);
    const gate = deferred();
    w.world.holds.push(gate);
    await p.advance(4000); // this poll is held, and will answer with what the server knew NOW (open, 5 votes)
    w.world.ov.counters.votes = 9;
    await p.click(p.$("#step-CLOSE")); // opens the confirmation
    const confirm = p.$("#dialogConfirm");
    expect(confirm).toBeTruthy();
    await p.click(confirm);
    expect(p.$("#roundHeader")?.textContent).toMatch(/Cerrada/);
    expect(counterOf(p, "Votos recibidos")).toBe("9");
    gate.release(); // the old answer finally arrives
    await p.settle();
    expect(p.$("#roundHeader")?.textContent).toMatch(/Cerrada/);
    expect(counterOf(p, "Votos recibidos")).toBe("9");
  });

  it("stops at once on sign-out, on 'Cambiar de ronda' and when another person signs in: no request is made for the round afterwards", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.advance(4000);
    const n = overviewCalls(w).length;
    await p.signOut();
    await p.advance(120_000);
    expect(overviewCalls(w).length).toBe(n);
    await p.signInAs({ status: "authenticated", authUserId: "another-user", email: "b@example.invalid" });
    await p.advance(120_000);
    expect(overviewCalls(w).length).toBe(n);
    expect(p.stored()["cvop2:round"]).toBeUndefined();

    const w2 = operatorWorld();
    const q = await operatorPage(w2);
    await q.click(q.$("#disconnect"));
    const m = overviewCalls(w2).length;
    await q.advance(120_000);
    expect(overviewCalls(w2).length).toBe(m);
    expect(q.$("#connectCard")).toBeTruthy();
  });

  it("an answer that arrives after the person changed is not applied, and the panel does not resume polling for the new person's empty page", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    const gate = deferred();
    w.world.holds.push(gate);
    w.world.ov.counters.votes = 4;
    await p.advance(4000);
    await p.signOut();
    gate.release();
    await p.settle();
    expect(p.$("#roundHeader")).toBeNull();
    expect(p.text()).not.toContain("Votos recibidos");
    const n = overviewCalls(w).length;
    await p.advance(60_000);
    expect(overviewCalls(w).length).toBe(n);
  });

  it("is silent while the page is hidden and refreshes the moment it becomes visible again", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    await p.setHidden(true);
    const n = overviewCalls(w).length;
    await p.advance(120_000);
    expect(overviewCalls(w).length).toBe(n);
    w.world.ov.counters.votes = 11;
    await p.setHidden(false);
    expect(overviewCalls(w).length).toBe(n + 1); // immediately, without waiting for the next interval
    expect(counterOf(p, "Votos recibidos")).toBe("11");
  });

  it("says when its data is stale instead of presenting old counts as current, and says so again when it recovers", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    w.world.ov.counters.votes = 5;
    await p.advance(4000);
    expect(p.$("#liveStatus")?.getAttribute("data-tone")).toBe("ok");
    w.world.status = 503;
    await p.advance(25_000);
    expect(p.$("#liveStatus")?.getAttribute("data-tone")).toBe("stale");
    expect(p.$("#liveStatus")?.textContent).toMatch(/Sin actualizar/);
    expect(p.$(".counters")?.getAttribute("data-stale")).toBe("true");
    expect(counterOf(p, "Votos recibidos")).toBe("5"); // the last known value stays visible, but marked
    w.world.status = 200;
    w.world.ov.counters.votes = 8;
    await p.advance(40_000);
    expect(p.$("#liveStatus")?.getAttribute("data-tone")).toBe("ok");
    expect(p.$(".counters")?.getAttribute("data-stale")).not.toBe("true");
    expect(counterOf(p, "Votos recibidos")).toBe("8");
  });

  it("shows 'refreshing' while a request is out, with the last data still on screen", async () => {
    const w = operatorWorld();
    const p = await operatorPage(w);
    const gate = deferred();
    w.world.holds.push(gate);
    await p.advance(5000);
    expect(p.$("#liveStatus")?.getAttribute("data-tone")).toBe("refreshing");
    expect(p.$("#liveStatus")?.textContent).toBe("Actualizando…");
    gate.release();
    await p.settle();
    expect(p.$("#liveStatus")?.getAttribute("data-tone")).toBe("ok");
  });

  it("does not wipe a focused input, typed text or an unsaved geofence proposal when the data refreshes", async () => {
    const w = operatorWorld({ role: "FINAL", ov: { opened: false, interactionState: null } });
    const p = await operatorPage(w);
    const lat = p.$("#geo-lat") as HTMLInputElement;
    expect(lat).toBeTruthy();
    await p.type(lat, "15.25");
    lat.focus();
    expect(p.doc.activeElement).toBe(lat);
    w.world.ov.counters.boundVoters = 9;
    w.world.ov.entries = [entryOf(201), entryOf(202), entryOf(203)];
    w.world.ov.counters.entries = 3;
    await p.advance(8000);
    expect(overviewCalls(w).length).toBeGreaterThanOrEqual(2);
    expect(counterOf(p, "Votantes dentro")).toBe("9"); // what has no input in it is refreshed
    expect(p.$("#geo-lat")).toBe(lat); // the very same element: not rebuilt
    expect((p.$("#geo-lat") as HTMLInputElement).value).toBe("15.25");
    expect(p.doc.activeElement).toBe(lat);
    expect(p.$("#geo-dirty")).toBeTruthy(); // the unsaved-changes mark is still there
  });

  it("keeps a code typed into an entry card, and applies the other changes around it", async () => {
    const w = operatorWorld({ ov: { opened: false, interactionState: null, entries: [entryOf(201), entryOf(202, { association: "CLAIMED" })] } });
    const p = await operatorPage(w);
    const code = p.$(`#confirm-code-${uuid(202)}`) as HTMLInputElement;
    expect(code).toBeTruthy();
    await p.type(code, "ABCD1234");
    w.world.ov.counters.boundVoters = 6;
    w.world.ov.entries = [entryOf(201), entryOf(202, { association: "CLAIMED" }), entryOf(203, { association: "CLAIMED" })];
    await p.advance(8000);
    expect(counterOf(p, "Votantes dentro")).toBe("6");
    expect((p.$(`#confirm-code-${uuid(202)}`) as HTMLInputElement).value).toBe("ABCD1234");
    expect(p.$(`#confirm-code-${uuid(202)}`)).toBe(code);
    // the section that waits is not presented as current: the panel says that newer data is held back, and marks the section
    expect(p.$("#liveStatus")?.textContent).toMatch(/Hay cambios nuevos que se mostrarán cuando termines de editar/);
    expect(p.$("#entries")?.getAttribute("data-deferred")).toBe("true");
    // once the typed text is gone the next refresh brings the section up to date and the notice disappears
    await p.type(code, "");
    await p.advance(8000);
    expect(p.$("#liveStatus")?.textContent ?? "").not.toMatch(/Hay cambios nuevos/);
    expect(p.$$("#entries .entry").length).toBe(3);
  });

  it("after an operator action the authoritative state is requested at once, not at the next interval", async () => {
    const w = operatorWorld({ ov: { opened: false, interactionState: null } });
    const p = await operatorPage(w);
    const n = overviewCalls(w).length;
    await p.click(p.$("#step-OPEN"));
    await p.click(p.$("#dialogConfirm"));
    expect(overviewCalls(w).length).toBeGreaterThan(n);
    expect(w.world.seen.some((c) => c.route === "/operator/open")).toBe(true);
  });
});

describe("operator panel — 'Registrar la revisión' (GATE-014)", () => {
  const closedAndCut = { ov: { closed: true, finalistsSelected: true } };

  it("marks the review as done only because the server's overview says so after the click, and then offers the publication", async () => {
    const w = operatorWorld(closedAndCut);
    const p = await operatorPage(w);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).toBe("Disponible");
    await p.click(p.$("#step-REVIEW"));
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).toBe("Hecho");
    expect(p.$("#step-REVIEW")?.hasAttribute("disabled")).toBe(true);
    expect(p.$("#step-PUBLISH")?.hasAttribute("disabled")).toBe(false);
    expect(p.$(".msg.ok")?.textContent).toMatch(/Revisión registrada para los resultados actuales/);
  });

  it("does NOT claim success when the server accepted the click but the refreshed overview says the review is not current", async () => {
    const w = operatorWorld(closedAndCut);
    w.world.reviewMakesCurrent = false; // the results changed between the click and the refresh
    const p = await operatorPage(w);
    await p.click(p.$("#step-REVIEW"));
    expect(p.$(".msg.ok")?.textContent ?? "").not.toMatch(/Revisión registrada/);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).not.toBe("Hecho");
    expect(p.text()).toMatch(/no quedó vigente|quedó vieja/);
    expect(p.$("#step-PUBLISH")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows a review made stale by a later change as stale, and the publication goes back to disabled until it is registered again", async () => {
    const w = operatorWorld({ ov: { closed: true, finalistsSelected: true, review: { reviewedAt: "2026-10-31T21:30:00.000Z", digest: "d1", current: true } } });
    const p = await operatorPage(w);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).toBe("Hecho");
    w.world.ov.review = { reviewedAt: "2026-10-31T21:30:00.000Z", digest: "d1", current: false }; // a withdrawal changed the eligible results
    await p.advance(6000);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).toBe("Disponible");
    expect(p.$("[data-step=REVIEW]")?.textContent).toMatch(/quedó vieja/);
    expect(p.$("#step-PUBLISH")?.hasAttribute("disabled")).toBe(true);
  });

  it("a refused review claims nothing", async () => {
    const w = operatorWorld(closedAndCut);
    w.world.reviewReply = { status: 409, json: { code: "REVIEW_STALE" } };
    const p = await operatorPage(w);
    await p.click(p.$("#step-REVIEW"));
    expect(p.$(".msg.ok")).toBeNull();
    expect(p.$(".msg.err")?.textContent).toMatch(/cambiaron después de la revisión/);
    expect(p.$("[data-step=REVIEW] .chip")?.textContent).not.toBe("Hecho");
  });
});

describe("operator panel — unresolved policies stay off the routine path (GATE-014)", () => {
  it("the policies card is collapsed while no decision blocks anything, and opens by itself — with the blocking reason on the checklist — when one does", async () => {
    const quiet = await operatorPage(operatorWorld({ ov: { closed: true } }));
    const card = quiet.$("#policiesCard") as HTMLDetailsElement;
    expect(card.tagName).toBe("DETAILS");
    expect(card.open).toBe(false);
    expect(card.textContent).toMatch(/Políticas que requieren aprobación del Founder/); // still there to read, one tap away

    const blocked = await operatorPage(operatorWorld({ ov: { closed: true, pendingResolutions: [{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF" }] } }));
    const open = blocked.$("#policiesCard") as HTMLDetailsElement;
    expect(open.open).toBe(true);
    expect(blocked.$("[data-step=FINALISTS]")?.textContent).toMatch(/Pendiente de aprobación del Founder/); // the reason is never hidden
  });
});

// ---------------------------------------------------------------- the public pages' world: a final or a preliminary whose state moves with VIRTUAL time

const ITEMS = [{ alias: "1111", candidateId: uuid(101), mine: false }, { alias: "2222", candidateId: uuid(102), mine: false }, { alias: "3333", candidateId: uuid(103), mine: true }]
  .map((i) => ({ ...i, thumbUrl: `${PREFIX}/photos/${i.alias}?v=thumb`, fullUrl: `${PREFIX}/photos/${i.alias}?v=full` }));

function voterWorld(init: { role?: "PRELIMINARY" | "FINAL"; deadlineAtMs?: number | null } = {}) {
  const role = init.role ?? "FINAL";
  const final = role === "FINAL";
  const w = {
    role, phase: "OPEN" as string, deadlineAtMs: (init.deadlineAtMs === undefined ? 300_000 : init.deadlineAtMs) as number | null, published: false,
    results: { published: true, kind: "WINNERS", items: [{ alias: "1111" }] } as Json, myCandidateId: null as string | null, intent: 0,
    seen: [] as Call[], votes: [] as Call[], holds: [] as Deferred[],
    close() { w.phase = "CLOSED"; },
    publish() { w.published = true; },
  };
  /** the phase is derived from the SERVER's clock: an open round whose deadline has passed is closed even before the operator closes it */
  const phaseAt = (at: number) => (w.phase === "OPEN" && w.deadlineAtMs !== null && at >= w.deadlineAtMs ? "CLOSED" : w.phase);
  const infoAt = (at: number) => {
    const phase = phaseAt(at);
    return {
      info: {
        roundRole: role, phase, locationRequired: final, windowSeconds: final ? 300 : null, isTest: true,
        deadlineAt: w.deadlineAtMs === null ? null : new Date(BASE_MS + w.deadlineAtMs).toISOString(), serverNow: new Date(BASE_MS + at).toISOString(),
        deadlineRemainingMs: phase === "OPEN" ? (w.deadlineAtMs === null ? null : w.deadlineAtMs - at) : 0,
        registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, tentative: false, approvedContestants: 3, published: w.published,
      },
      texts: { galleryConsent: { version: "v", text: "t" }, promoConsent: { version: "p", text: "t" } },
    };
  };
  const respond = async (call: Call): Promise<Reply> => {
    w.seen.push(call);
    switch (call.route) {
      case "/info": {
        const snapshot = infoAt(call.at); // what the server knew WHEN it received the request
        const gate = w.holds.shift();
        if (gate) await gate.promise;
        return { status: 200, json: snapshot };
      }
      case "/results": return { status: 200, json: w.published ? w.results : { published: false, kind: null, items: [] } };
      case "/binding": return { status: 200, json: { bindingId: uuid(50), created: false } };
      case "/status": { const i = infoAt(call.at).info; return { status: 200, json: { bound: true, roundRole: role, phase: i.phase, myCandidateId: w.myCandidateId, deadlineRemainingMs: i.deadlineRemainingMs, interactionInstanceId: uuid(7) } }; }
      case "/gallery": return { status: 200, json: { phase: phaseAt(call.at), roundRole: role, interactionInstanceId: uuid(7), items: ITEMS } };
      case "/intents": return { status: 201, json: { bindingId: uuid(50), intentNo: ++w.intent } };
      case "/slideshow": return { status: 200, json: { prompt: "Elige tu disfraz favorito.", rotationSeconds: 8, items: [] } };
      case "/votes":
        w.votes.push(call);
        if (phaseAt(call.at) !== "OPEN") return { status: 409, json: { code: "VOTING_WINDOW_ELAPSED" } };
        w.myCandidateId = call.body.candidateId;
        return { status: 200, json: { outcome: "APPLIED", candidateId: call.body.candidateId } };
      default: return { status: 404, json: { code: "NOT_FOUND" } };
    }
  };
  return { w, respond };
}
const AUTH_OK: AuthState = { status: "authenticated", email: "marta@example.invalid" };
const voterPage = (v: ReturnType<typeof voterWorld>, extra: Partial<Parameters<typeof livePage>[0]> = {}) => livePage({ html: VOTER_HTML, respond: v.respond, auth: AUTH_OK, ...extra });
const displayPage = (v: ReturnType<typeof voterWorld>) => livePage({ html: DISPLAY_HTML, respond: v.respond });
const infoCalls = (v: ReturnType<typeof voterWorld>, since = 0) => v.w.seen.filter((c) => c.route === "/info" && c.at >= since);

describe("voter page — how soon it learns what the server decided (GATE-014)", () => {
  it("an early close of the FINAL reaches the voter within one poll (at most 6 s), the clock stops, and the page says the voting is closed", async () => {
    const v = voterWorld();
    const p = await voterPage(v);
    expect(p.$("#clock")).toBeTruthy();
    await p.advance(5001); // the worst moment: a poll has just been made
    const closedAt = p.now();
    v.w.close();
    await p.advance(3000);
    expect(p.$("#clock")).toBeTruthy(); // no answer yet: the next poll is not due
    await p.advance(3000);
    const learned = infoCalls(v, closedAt)[0];
    expect(learned.at - closedAt).toBeLessThanOrEqual(6000);
    expect(p.text()).toMatch(/La votación está cerrada/);
    expect(p.$("#clock")).toBeNull();
  });

  it("the publication appears within 6.5 s of the server publishing it (it used to take 20-25 s), without a reload", async () => {
    const v = voterWorld();
    const p = await voterPage(v);
    await p.advance(5001);
    v.w.close();
    await p.advance(5000); // the page has learned that it is closed
    expect(p.text()).toMatch(/La votación está cerrada/);
    expect(p.text()).not.toMatch(/Tenemos ganador/);
    expect(v.w.seen.filter((c) => c.route === "/results")).toHaveLength(0); // nothing is asked for, or invented, before the server says "published"
    const publishedAt = p.now();
    v.w.publish();
    await p.advance(6500);
    expect(p.text()).toMatch(/¡Tenemos ganador!/);
    expect(v.w.seen.find((c) => c.route === "/results")!.at - publishedAt).toBeLessThanOrEqual(6500);
  });

  it("a preliminary hears about its close within 16 s, and about its publication within 7 s", async () => {
    const v = voterWorld({ role: "PRELIMINARY", deadlineAtMs: 7_200_000 });
    const p = await voterPage(v);
    await p.advance(15_001);
    const closedAt = p.now();
    v.w.close();
    await p.advance(16_000);
    expect(infoCalls(v, closedAt)[0].at - closedAt).toBeLessThanOrEqual(16_000);
    expect(p.text()).toMatch(/La votación está cerrada/);
    v.w.publish();
    await p.advance(7000);
    expect(p.text()).toMatch(/¡Tenemos ganador!/);
  });

  it("when the countdown reaches zero the page asks the server AT ONCE (it does not wait for the next poll) and follows its answer", async () => {
    const v = voterWorld({ deadlineAtMs: 302_300 }); // not a multiple of the poll period, so a poll cannot do this by chance
    const p = await voterPage(v);
    await p.advance(302_300 + 1000); // the page's clock ticks once a second: it notices the zero at most one tick later
    const asked = infoCalls(v, 302_300);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0].at - 302_300).toBeLessThanOrEqual(1500);
    expect(p.text()).toMatch(/La votación está cerrada/);
    expect(p.$("#clock")).toBeNull();
  });

  it("is silent while hidden, and the moment it is visible again it asks and shows what happened meanwhile", async () => {
    const v = voterWorld();
    const p = await voterPage(v);
    await p.setHidden(true);
    const n = infoCalls(v).length;
    v.w.close();
    await p.advance(120_000);
    expect(infoCalls(v).length).toBe(n);
    await p.setHidden(false);
    expect(infoCalls(v).length).toBe(n + 1);
    expect(p.text()).toMatch(/La votación está cerrada/);
  });

  it("never has two info requests in flight and ignores an older answer that arrives after a newer one", async () => {
    const v = voterWorld();
    const p = await voterPage(v);
    const gate = deferred();
    v.w.holds.push(gate);
    await p.advance(5000); // held: it carries the state at t=5000 (open)
    const inFlight = infoCalls(v).length;
    v.w.close();
    await p.advance(90_000); // while it is held, no other request may be made
    expect(infoCalls(v).length).toBe(inFlight);
    await p.setHidden(true);
    await p.setHidden(false); // asking again while one is out must not overlap either
    expect(infoCalls(v).length).toBe(inFlight);
    gate.release();
    await p.settle();
    await p.advance(6000);
    expect(p.text()).toMatch(/La votación está cerrada/);
    expect(infoCalls(v).length).toBeGreaterThan(inFlight);
  });

  it("keeps its requests bounded: 10 minutes of an open final cost at most 125 requests, of an open preliminary at most 45, and none while hidden", async () => {
    const final = voterWorld({ deadlineAtMs: 3_600_000 });
    const p = await voterPage(final);
    await p.advance(600_000);
    expect(infoCalls(final).length).toBeLessThanOrEqual(125);
    expect(infoCalls(final).length).toBeGreaterThanOrEqual(100);
    const pre = voterWorld({ role: "PRELIMINARY", deadlineAtMs: 7_200_000 });
    const q = await voterPage(pre);
    await q.advance(600_000);
    expect(infoCalls(pre).length).toBeLessThanOrEqual(45);
    const hiddenWorld = voterWorld({ deadlineAtMs: 3_600_000 });
    const r = await voterPage(hiddenWorld);
    await r.setHidden(true);
    const before = infoCalls(hiddenWorld).length;
    await r.advance(600_000);
    expect(infoCalls(hiddenWorld).length).toBe(before);
  });

  it("a vote refused because the window is over re-synchronises at once and shows the round as closed — the earlier confirmation is not touched", async () => {
    const v = voterWorld({ deadlineAtMs: 20_000 });
    v.w.myCandidateId = uuid(102);
    const p = await voterPage(v, { sensor: { reading: () => ({ coords: { latitude: 14.0723, longitude: -87.1921, accuracy: 8 } }) } });
    await p.advance(21_000);
    expect(p.text()).toMatch(/La votación está cerrada/);
    expect(p.$("#choose")?.hasAttribute("disabled") ?? true).toBe(true); // no vote can be started after the deadline
  });
});

describe("voter page — every final vote and every revision takes its own reading (GATE-014)", () => {
  const A = { coords: { latitude: 14.0723, longitude: -87.1921, accuracy: 8 } };
  const B = { coords: { latitude: 14.0728, longitude: -87.1917, accuracy: 6 } };

  it("a revision with the browser's permission already granted (no prompt) still reads a NEW position and sends THAT one to be evaluated", async () => {
    const v = voterWorld();
    const readings = [A, B];
    const p = await voterPage(v, { sensor: { reading: () => readings.shift() ?? B } });
    await p.click(p.$("#choose")); // "Votar por este" on the first card
    await p.click(p.$("#confirmVote"));
    expect(v.w.votes).toHaveLength(1);
    await p.click(p.$("#next"));
    await p.click(p.$("#choose")); // "Cambiar mi voto a este"
    expect(p.$("#confirmVote")?.textContent).toBe("Cambiar mi voto");
    await p.click(p.$("#confirmVote"));
    expect(p.sensor.calls).toBe(2);
    expect(p.sensor.options.every((o) => o.maximumAge === 0)).toBe(true);
    expect(v.w.votes).toHaveLength(2);
    expect(v.w.votes[0].body.location).toEqual({ latitude: 14.0723, longitude: -87.1921, accuracyMeters: 8 });
    expect(v.w.votes[1].body.location).toEqual({ latitude: 14.0728, longitude: -87.1917, accuracyMeters: 6 });
    expect(v.w.votes[1].body.intentNo).toBeGreaterThan(v.w.votes[0].body.intentNo); // a revision is a NEW intent
  });

  it("a denied reading on a revision sends no bind, no intent and no vote, and keeps the earlier vote on screen", async () => {
    const v = voterWorld();
    let denied = false;
    const p = await voterPage(v, { sensor: { reading: () => (denied ? { errorCode: 1 } : A) } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(v.w.votes).toHaveLength(1);
    const before = p.calls.length;
    denied = true;
    await p.click(p.$("#next"));
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    const after = p.calls.slice(before).map((c) => c.route);
    expect(after).not.toContain("/binding");
    expect(after).not.toContain("/intents");
    expect(after).not.toContain("/votes");
    expect(p.text()).toMatch(/necesitamos tu ubicación/);
    expect(p.$("#choose")?.textContent).toBe("Cambiar mi voto a este"); // the earlier vote is still the person's current one
  });

  it("a position that arrives AFTER the person switched account is discarded: nothing is bound, issued or voted", async () => {
    const v = voterWorld();
    const p = await voterPage(v, { sensor: { mode: "manual" } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote")); // the browser is now asking; the callback has not come
    expect(p.sensor.pending).toHaveLength(1);
    const before = p.calls.length;
    await p.click(p.$("#switchAccount"));
    await p.click(p.$("#switchConfirm"));
    p.sensor.pending[0].ok({ coords: A.coords }); // the person finally pressed "Allow" — for a session that no longer exists
    await p.settle();
    const routes = p.calls.slice(before).map((c) => c.route);
    expect(routes).not.toContain("/binding");
    expect(routes).not.toContain("/intents");
    expect(routes).not.toContain("/votes");
    expect(v.w.votes).toHaveLength(0);
  });

  it("a prompt nobody answers does not freeze the page: the reading gives up on its own, the buttons come back, and a late 'Allow' casts nothing", async () => {
    const v = voterWorld({ deadlineAtMs: 3_600_000 });
    const p = await voterPage(v, { sensor: { mode: "manual" } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.$("#choose")?.hasAttribute("disabled")).toBe(true); // busy while the browser asks
    await p.advance(120_000);
    expect(p.$("#choose")?.hasAttribute("disabled")).toBe(false);
    expect(p.text()).toMatch(/La ubicación tardó demasiado/);
    p.sensor.pending[0].ok({ coords: A.coords });
    await p.settle();
    expect(v.w.votes).toHaveLength(0);
  });
});

describe("venue display — the same freshness (GATE-014)", () => {
  it("follows the round without a reload: the countdown, the close (within 6 s) and the winner (within 6.5 s)", async () => {
    const v = voterWorld();
    const p = await displayPage(v);
    expect(p.$("#when")?.textContent).toMatch(/Final abierta · quedan/);
    await p.advance(5001);
    const closedAt = p.now();
    v.w.close();
    await p.advance(6000);
    expect(p.$("#when")?.textContent).toMatch(/La votación está cerrada/);
    expect(infoCalls(v, closedAt)[0].at - closedAt).toBeLessThanOrEqual(6000);
    v.w.publish();
    await p.advance(6500);
    expect(p.$("#when")?.textContent).toMatch(/Ganador: #1111/);
  });

  it("makes one request at a time, none while hidden, and one at once when visible again", async () => {
    const v = voterWorld();
    const p = await displayPage(v);
    const gate = deferred();
    v.w.holds.push(gate);
    await p.advance(5000);
    const n = infoCalls(v).length;
    await p.advance(60_000);
    expect(infoCalls(v).length).toBe(n);
    gate.release();
    await p.settle();
    await p.setHidden(true);
    const m = infoCalls(v).length;
    await p.advance(120_000);
    expect(infoCalls(v).length).toBe(m);
    await p.setHidden(false);
    expect(infoCalls(v).length).toBe(m + 1);
  });
});
