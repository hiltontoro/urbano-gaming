import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * B2 — the Gaming Member is bound to the authenticated identity.
 *
 * The shared sign-in client (public/urbanoAuth.js, the REAL file) is run in jsdom against a fake Supabase browser client and a fake
 * /api/gaming/member route whose answers this test can hold back and release in any order. Nothing here touches a network, a
 * provider or real data: the people are synthetic.
 *
 * The defect this pins (root cause): a member lookup started for person A kept running after person B signed in, and when A's answer
 * arrived it was written into ONE shared cache AFTER that cache had been cleared for B. B's next read then returned A's name, id and
 * join date next to B's own email. The fix makes every lookup belong to the Auth user id it was made for, discards (and cancels)
 * work for a person who is gone, and re-reads for whoever is signed in now.
 *
 * Covered: A -> B with A's answer late; sign-out with a lookup pending; repeated changes with answers released out of order; the same
 * person refreshing a token; a profile save and a code verification that finish after the person changed; and the consumers, not only
 * the final render: the identity callbacks, the account link in the header and the real profile page, with the real client.
 * Negative controls remove each protection from a COPY of the client and show the scenario then fails.
 */

const ROOT = process.cwd();
const AUTH_SOURCE = readFileSync(path.join(ROOT, "public/urbanoAuth.js"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const PROFILE_HTML = readFileSync(path.join(ROOT, "public/profile.html"), "utf8");
const PRED_HTML = readFileSync(path.join(ROOT, "public/soccer-predictions.html"), "utf8");

type Who = "A" | "B" | "C";
const PEOPLE: Record<Who, { id: string; email: string; name: string; memberId: string; since: string }> = {
  A: { id: "uid-A", email: "a@example.com", name: "Persona A", memberId: "gm-A", since: "2026-02-01T00:00:00.000Z" },
  B: { id: "uid-B", email: "b@example.com", name: "Persona B", memberId: "gm-B", since: "2026-03-01T00:00:00.000Z" },
  C: { id: "uid-C", email: "c@example.com", name: "Persona C", memberId: "gm-C", since: "2026-04-01T00:00:00.000Z" },
};
const WHO_BY_EMAIL = Object.fromEntries((Object.keys(PEOPLE) as Who[]).map((w) => [PEOPLE[w].email, w])) as Record<string, Who>;
const profileOf = (who: Who) => ({
  status: "authenticated", email: PEOPLE[who].email, emailVerified: true, displayName: PEOPLE[who].name, gamingMemberId: PEOPLE[who].memberId, memberSince: PEOPLE[who].since,
});
const stateOf = (who: Who) => ({ status: "authenticated", email: PEOPLE[who].email, authUserId: PEOPLE[who].id, gamingMemberId: PEOPLE[who].memberId, displayName: PEOPLE[who].name });

const tick = (n = 25) => (async () => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); })();
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

interface Deferred { promise: Promise<void>; release: () => void }
function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface StackOptions {
  source?: string; // the client under test (a mutated copy for the negative controls)
  honorAbort?: boolean; // does the fake network honour AbortController? (real browsers do; the fix must not DEPEND on it)
  html?: string; // a page to run the client in (default: an empty one)
  withI18n?: boolean;
  initialSession?: Who; // already signed in when the page loads
  page?: string; // the page's file name (its address), default profile.html
  preArm?: string[]; // holds to set before the page starts: a person ("A") holds that person's member lookup, "route:key" holds a route
  /** Extra fake routes (for a page that calls its own endpoints). Return undefined to fall through to a 404. */
  routes?: (url: string, init: Record<string, any> | undefined, ctx: { who: Who | null; gate: (key: string) => Promise<void> }) => Promise<unknown> | unknown;
  members?: Partial<Record<Who, { gamingMemberId: string; displayName: string; createdAt: string } | null>>;
}

/** One browser window with the real client, a fake Auth client and a fake member route whose answers can be held and released. */
async function createStack(options: StackOptions = {}) {
  const honorAbort = options.honorAbort !== false;
  const members: Record<Who, { gamingMemberId: string; displayName: string; createdAt: string } | null> = {
    A: { gamingMemberId: PEOPLE.A.memberId, displayName: PEOPLE.A.name, createdAt: PEOPLE.A.since },
    B: { gamingMemberId: PEOPLE.B.memberId, displayName: PEOPLE.B.name, createdAt: PEOPLE.B.since },
    C: { gamingMemberId: PEOPLE.C.memberId, displayName: PEOPLE.C.name, createdAt: PEOPLE.C.since },
    ...(options.members as any),
  };
  const sessionOf = (who: Who) => ({ access_token: `token-${who}`, user: { id: PEOPLE[who].id, email: PEOPLE[who].email, email_confirmed_at: "2026-01-01T00:00:00Z" } });
  const state = {
    session: (options.initialSession ? sessionOf(options.initialSession) : null) as null | { access_token: string; user: Record<string, unknown> },
    listeners: [] as Array<(event: string, session: unknown) => void>,
    gets: [] as Array<{ token: string; aborted: boolean }>,
    posts: [] as Array<{ token: string; displayName: string }>,
  };
  const armedGets = new Map<string, Deferred[]>();
  const armedPosts = new Map<string, Deferred[]>();
  const armedRoutes = new Map<string, Deferred[]>();
  const arm = (map: Map<string, Deferred[]>, key: string) => { const d = deferred(); const list = map.get(key) ?? []; list.push(d); map.set(key, list); return d; };
  // Holds that must exist before the page starts running (it asks for its data as soon as it loads).
  const preArmed: Record<string, Deferred> = {};
  for (const key of options.preArm ?? []) preArmed[key] = key.startsWith("route:") ? arm(armedRoutes, key.slice(6)) : arm(armedGets, `token-${key}`);
  const whoOfToken = (token: string) => token.replace("token-", "") as Who;

  const client = {
    auth: {
      onAuthStateChange(callback: (event: string, session: unknown) => void) { state.listeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: state.session } }; },
      async signOut() { setSession(null); return { error: null }; },
      async signInWithOtp() { return { data: {}, error: null }; },
      async verifyOtp(payload: { email: string; token: string }) {
        const who = WHO_BY_EMAIL[payload.email];
        setSession(who);
        return { data: { session: state.session, user: state.session!.user }, error: null };
      },
    },
  };

  function setSession(who: Who | null, event?: string) {
    state.session = who ? sessionOf(who) : null;
    const name = event ?? (who ? "SIGNED_IN" : "SIGNED_OUT");
    state.listeners.slice().forEach((listener) => listener(name, state.session));
  }

  const bearer = (init?: Record<string, any>) => String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "").replace("Bearer ", "");
  async function fetchFake(url: string, init?: Record<string, any>) {
    const target = String(url);
    if (target === "/api/gaming/config") return { ok: true, status: 200, json: async () => ({ supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" }) };
    if (target === "/api/gaming/auth-methods") return { ok: true, status: 200, json: async () => ({ email: true, phone: false }) };
    if (target !== "/api/gaming/member") {
      if (options.routes) {
        const token = bearer(init);
        const who = token.startsWith("token-") ? (token.replace("token-", "") as Who) : null;
        const out = await options.routes(target, init, { who, gate: async (key: string) => { const g = armedRoutes.get(key)?.shift(); if (g) await g.promise; } });
        if (out !== undefined) return out;
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const token = bearer(init);
    const who = whoOfToken(token);
    if (init?.method === "POST") {
      const displayName = JSON.parse(init.body).displayName as string;
      state.posts.push({ token, displayName });
      const gate = armedPosts.get(token)?.shift();
      if (gate) await gate.promise;
      members[who] = { gamingMemberId: `gm-new-${who}`, displayName, createdAt: "2026-10-01T00:00:00.000Z" };
      return { ok: true, status: 200, json: async () => ({ gamingMember: members[who] }) };
    }
    const record = { token, aborted: false };
    state.gets.push(record);
    const gate = armedGets.get(token)?.shift();
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        gate.promise.then(resolve);
        const signal: AbortSignal | undefined = init?.signal;
        if (signal && honorAbort) {
          const abort = () => { record.aborted = true; const err = new Error("The operation was aborted."); err.name = "AbortError"; reject(err); };
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort);
        }
      });
    }
    return { ok: true, status: 200, json: async () => ({ gamingMember: members[who] }) };
  }

  const dom = new JSDOM(options.html ?? "<!doctype html><html><body></body></html>", {
    url: `http://localhost/${options.page ?? "profile.html"}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      Object.defineProperty(w.navigator, "language", { value: "en-US", configurable: true });
      if (options.withI18n) w.eval(I18N_SOURCE);
      w.supabase = { createClient: () => client };
      w.fetch = fetchFake;
      w.eval(`${options.source ?? AUTH_SOURCE}\nwindow.UrbanoAuth = UrbanoAuth;`);
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as any;
  const doc = win.document as Document;

  const auth = win.UrbanoAuth as Record<string, any>;
  const hold = (who: Who) => arm(armedGets, `token-${who}`);
  const holdRoute = (key: string) => arm(armedRoutes, key);
  /** Changes who the Auth client reports WITHOUT delivering any event (the window between a session change and its event). */
  const switchSilently = (who: Who | null) => { state.session = who ? sessionOf(who) : null; };
  const holdPost = (who: Who) => arm(armedPosts, `token-${who}`);
  const identities: any[] = [];
  const boot = async () => { await auth.onIdentityChange((s: any) => identities.push(s)); };
  return { win, doc, auth, state, members, setSession, switchSilently, hold, holdPost, holdRoute, boot, identities, honorAbort, preArmed };
}
type Stack = Awaited<ReturnType<typeof createStack>>;

/** A person's data is "consistent" when every field belongs to the same person. */
function mixes(result: any): string[] {
  const out: string[] = [];
  if (!result || !result.email) return out;
  const who = WHO_BY_EMAIL[result.email];
  if (!who) return out;
  const p = PEOPLE[who];
  if (result.displayName !== undefined && result.displayName !== p.name) out.push(`${result.email} carries the name "${result.displayName}"`);
  if (result.gamingMemberId !== undefined && result.gamingMemberId !== p.memberId) out.push(`${result.email} carries member id ${result.gamingMemberId}`);
  if (result.memberSince !== undefined && result.memberSince !== null && result.memberSince !== p.since) out.push(`${result.email} carries the join date ${result.memberSince}`);
  if (result.authUserId !== undefined && result.authUserId !== p.id) out.push(`${result.email} carries the user id ${result.authUserId}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The scenario each protection exists for, as a list of violations (empty = correct). Reused by the negative controls.
// ---------------------------------------------------------------------------------------------------------------------------------

async function lateAnswerScenario(stack: Stack): Promise<string[]> {
  const out: string[] = [];
  await stack.boot();
  stack.setSession("A");
  const gateA = stack.hold("A");
  const pending = stack.auth.getProfile(); // a lookup for A is now in flight
  await tick();
  stack.setSession("B"); // B signs in while A's lookup is still running
  const forB = await stack.auth.getProfile();
  if (JSON.stringify(forB) !== JSON.stringify(profileOf("B"))) out.push(`B's profile was ${JSON.stringify(forB)}`);
  out.push(...mixes(forB));
  gateA.release(); // A's answer arrives late
  const late = await pending; // the call that was started for A, finished after the change
  if (JSON.stringify(late) !== JSON.stringify(profileOf("B"))) out.push(`the call started for A returned ${JSON.stringify(late)} instead of the current person`);
  out.push(...mixes(late));
  await tick();
  const again = await stack.auth.getProfile(); // and the cache was not poisoned by the late answer
  if (JSON.stringify(again) !== JSON.stringify(profileOf("B"))) out.push(`after the late answer, B's profile was ${JSON.stringify(again)}`);
  out.push(...mixes(again));
  if (stack.honorAbort && !stack.state.gets.find((g) => g.token === "token-A")?.aborted) out.push("A's lookup was not cancelled when A was no longer signed in");
  return out;
}

describe("who the lookup belongs to does not depend on an event having been delivered", () => {
  it("a stored lookup for A is never handed to B, even when B's session is visible before any Auth event is delivered", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    expect(await stack.auth.getProfile()).toEqual(profileOf("A")); // A's member is now stored
    stack.switchSilently("B"); // B's session is what the client reports, but the event has not reached us yet
    expect(await stack.auth.getProfile()).toEqual(profileOf("B"));
    expect(await stack.auth.getState()).toEqual(stateOf("B"));
    expect(stack.state.gets.map((g) => g.token)).toEqual(["token-A", "token-B"]);
  });

  it("the same holds for sign-out that is visible before its event: nothing of A is returned", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    await stack.auth.getProfile();
    stack.switchSilently(null);
    expect(await stack.auth.getProfile()).toEqual({ status: "unauthenticated" });
  });
});

describe("A -> B with A's answer arriving late", () => {
  for (const honorAbort of [true, false]) {
    const label = honorAbort ? "the pending request is cancelled" : "even where the network ignores the cancellation";
    it(`getProfile: B never receives A's name, id or date (${label})`, async () => {
      const stack = await createStack({ honorAbort });
      expect(await lateAnswerScenario(stack)).toEqual([]);
    });

    it(`getState: B never receives A's name or id, and neither does the call that was started for A (${label})`, async () => {
      const stack = await createStack({ honorAbort });
      await stack.boot();
      stack.setSession("A");
      const gateA = stack.hold("A");
      const pending = stack.auth.getState();
      await tick();
      stack.setSession("B");
      expect(await stack.auth.getState()).toEqual(stateOf("B"));
      gateA.release();
      expect(await pending).toEqual(stateOf("B"));
      expect(await stack.auth.getState()).toEqual(stateOf("B"));
    });
  }

  it("the email of B is never combined with the name, id or date of A, whichever read is made and in whichever order the answers arrive", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const gateA = stack.hold("A");
    const reads = [stack.auth.getProfile(), stack.auth.getState(), stack.auth.getProfile()];
    await tick();
    stack.setSession("B");
    reads.push(stack.auth.getProfile(), stack.auth.getState());
    gateA.release();
    for (const result of await Promise.all(reads)) expect(mixes(result), JSON.stringify(result)).toEqual([]);
  });
});

describe("sign-out with a lookup pending", () => {
  for (const honorAbort of [true, false]) {
    it(`the pending read ends as signed out, nothing of A remains, and the next person gets only their own data (${honorAbort ? "cancellable" : "not cancellable"})`, async () => {
      const stack = await createStack({ honorAbort });
      await stack.boot();
      stack.setSession("A");
      const gateA = stack.hold("A");
      const pendingState = stack.auth.getState();
      const pendingProfile = stack.auth.getProfile();
      await tick();
      await stack.auth.signOut(); // the person signs out while the lookup is still running
      gateA.release();
      expect(await pendingState).toEqual({ status: "unauthenticated" });
      expect(await pendingProfile).toEqual({ status: "unauthenticated" });
      expect(await stack.auth.getState()).toEqual({ status: "unauthenticated" });
      stack.setSession("B");
      expect(await stack.auth.getProfile()).toEqual(profileOf("B"));
      expect(await stack.auth.getState()).toEqual(stateOf("B"));
      expect(JSON.stringify(stack.identities)).not.toContain("Persona A");
    });
  }

  it("a signed-out session with a late answer for A, followed by A signing in again, resolves A freshly", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const gate = stack.hold("A");
    const pending = stack.auth.getProfile();
    await tick();
    stack.setSession(null);
    expect(await pending).toEqual({ status: "unauthenticated" });
    gate.release();
    stack.setSession("A");
    expect(await stack.auth.getProfile()).toEqual(profileOf("A"));
  });
});

describe("repeated changes", () => {
  for (const honorAbort of [true, false]) {
    it(`A -> B -> A -> B with the answers released out of order: every read ends on the person signed in at that moment (${honorAbort ? "cancellable" : "not cancellable"})`, async () => {
      const stack = await createStack({ honorAbort });
      await stack.boot();
      stack.setSession("A");
      const a1 = stack.hold("A");
      const p1 = stack.auth.getProfile();
      await tick();
      stack.setSession("B");
      const b1 = stack.hold("B");
      const p2 = stack.auth.getProfile();
      await tick();
      stack.setSession("A");
      const a2 = stack.hold("A");
      const p3 = stack.auth.getState();
      await tick();
      stack.setSession("B");
      const p4 = stack.auth.getProfile();
      a2.release(); b1.release(); a1.release(); // the oldest answers arrive last
      const results = await Promise.all([p1, p2, p3, p4]);
      for (const result of results) expect(mixes(result), JSON.stringify(result)).toEqual([]);
      expect(results[0]).toEqual(profileOf("B"));
      expect(results[1]).toEqual(profileOf("B"));
      expect(results[2]).toEqual(stateOf("B"));
      expect(results[3]).toEqual(profileOf("B"));
      expect(await stack.auth.getProfile()).toEqual(profileOf("B"));
    });
  }

  it("A -> B -> C in quick succession leaves exactly C, with no identity callback ever reporting A or B's data after C", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const gateA = stack.hold("A");
    const pending = stack.auth.getProfile();
    await tick();
    stack.setSession("B");
    stack.setSession("C");
    gateA.release();
    expect(await pending).toEqual(profileOf("C"));
    await tick();
    const last = stack.identities[stack.identities.length - 1];
    expect(last).toEqual(stateOf("C"));
    const afterC = stack.identities.slice(stack.identities.findIndex((s) => s.authUserId === PEOPLE.C.id));
    for (const s of afterC) expect(s.authUserId).toBe(PEOPLE.C.id);
    for (const s of stack.identities) expect(mixes(s), JSON.stringify(s)).toEqual([]);
  });

  it("a person who changes away and comes back while a lookup was cancelled is simply asked again (no error)", async () => {
    const stack = await createStack({ honorAbort: true });
    await stack.boot();
    stack.setSession("A");
    stack.hold("A");
    const pending = stack.auth.getProfile();
    await tick();
    stack.setSession("B"); // cancels A's request
    stack.setSession("A"); // and A is back before the first call noticed
    expect(await pending).toEqual(profileOf("A"));
  });

  it("a lookup that really fails for the person who is still signed in is reported, not swallowed", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const original = stack.win.fetch;
    stack.win.fetch = async (url: string, init?: any) => { if (String(url) === "/api/gaming/member") throw new Error("offline"); return original(url, init); };
    await expect(stack.auth.getProfile()).rejects.toThrow("offline");
    stack.win.fetch = original; // a failure is never cached: the next read asks again
    expect(await stack.auth.getProfile()).toEqual(profileOf("A"));
  });
});

describe("the same person", () => {
  it("is looked up once for repeated reads, and a token refresh does not change who they are", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    expect(await stack.auth.getProfile()).toEqual(profileOf("A"));
    expect(await stack.auth.getState()).toEqual(stateOf("A"));
    expect(await stack.auth.getProfile()).toEqual(profileOf("A"));
    expect(stack.state.gets).toHaveLength(1);
    stack.setSession("A", "TOKEN_REFRESHED");
    expect(await stack.auth.getProfile()).toEqual(profileOf("A"));
    expect(stack.state.gets.length).toBeLessThanOrEqual(2);
  });

  it("two reads in flight at once for the same person share one lookup", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const gate = stack.hold("A");
    const reads = [stack.auth.getProfile(), stack.auth.getState()];
    await tick();
    gate.release();
    expect(await reads[0]).toEqual(profileOf("A"));
    expect(await reads[1]).toEqual(stateOf("A"));
    expect(stack.state.gets).toHaveLength(1);
  });

  it("an Auth event for the same person while the lookup is still in flight does not start a second request (and a finished lookup is still re-asked after an event)", async () => {
    const stack = await createStack({ honorAbort: true });
    await stack.boot();
    stack.setSession("A");
    const gate = stack.hold("A");
    const first = stack.auth.getProfile();
    await tick();
    stack.setSession("A", "INITIAL_SESSION"); // e.g. the client's first event arriving while the page's first lookup is running
    stack.setSession("A", "TOKEN_REFRESHED");
    const second = stack.auth.getState();
    await tick();
    gate.release();
    expect(await first).toEqual(profileOf("A"));
    expect(await second).toEqual(stateOf("A"));
    expect(stack.state.gets).toHaveLength(1); // one request, shared
    stack.setSession("A", "SIGNED_IN");
    await stack.auth.getState();
    expect(stack.state.gets.length).toBe(2); // the finished lookup was forgotten by the event, as before
  });

  it("every lookup in flight for a person who left is cancelled, however many there are", async () => {
    const stack = await createStack({ honorAbort: true });
    await stack.boot();
    stack.setSession("A");
    stack.hold("A"); stack.hold("A");
    const reads = [stack.auth.getProfile(), stack.auth.getState()];
    await tick();
    stack.setSession("B");
    expect(await Promise.all(reads)).toEqual([profileOf("B"), stateOf("B")]);
    expect(stack.state.gets.filter((g) => g.token === "token-A").every((g) => g.aborted)).toBe(true);
  });

  it("a session without an Auth user id has no identity to bind a member to: it is treated as signed out, never guessed", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.state.session = { access_token: "token-A", user: { email: "a@example.com" } };
    expect(await stack.auth.getState()).toEqual({ status: "unauthenticated" });
    expect(await stack.auth.getProfile()).toEqual({ status: "unauthenticated" });
    expect(stack.state.gets).toHaveLength(0);
  });
});

describe("a profile save or a code check that finishes after the person changed", () => {
  it("completeProfile for A does not become B's member, and tells the caller the session changed", async () => {
    const stack = await createStack({ members: { A: null } });
    await stack.boot();
    stack.setSession("A");
    expect((await stack.auth.getState()).status).toBe("profile_incomplete");
    const gatePost = stack.holdPost("A");
    const saving = stack.auth.completeProfile("Nombre nuevo de A");
    await tick();
    stack.setSession("B"); // B signs in while A's save is still travelling
    gatePost.release();
    const result = await saving;
    expect(result).toMatchObject({ status: "error", kind: "identity_changed", messageKey: "auth.err.identityChanged" });
    expect(await stack.auth.getProfile()).toEqual(profileOf("B"));
    expect(await stack.auth.getState()).toEqual(stateOf("B"));
    // A's save did reach the server, so when A signs in again A's own, fresh data is there
    stack.setSession("A");
    expect(await stack.auth.getProfile()).toMatchObject({ email: "a@example.com", displayName: "Nombre nuevo de A" });
  });

  it("completeProfile still works for the person who is signed in the whole time", async () => {
    const stack = await createStack({ members: { A: null } });
    await stack.boot();
    stack.setSession("A");
    const result = await stack.auth.completeProfile("Ana");
    expect(result).toMatchObject({ status: "authenticated", email: "a@example.com", displayName: "Ana" });
    expect(await stack.auth.getState()).toMatchObject({ status: "authenticated", displayName: "Ana", email: "a@example.com" });
  });

  it("verifyCode reports the person who just verified, even if A's lookup is still pending; a change right after is reported, not mixed", async () => {
    const stack = await createStack();
    await stack.boot();
    stack.setSession("A");
    const gateA = stack.hold("A");
    const pendingA = stack.auth.getProfile();
    await tick();
    const verified = await stack.auth.verifyCode({ channel: "email", identifier: PEOPLE.B.email, code: "123456" });
    expect(verified).toEqual({ status: "authenticated", email: PEOPLE.B.email, gamingMemberId: PEOPLE.B.memberId, displayName: PEOPLE.B.name });
    gateA.release();
    expect(await pendingA).toEqual(profileOf("B"));
  });

  it("verifyCode when the session changes again before it finishes: the result says so and carries nobody's data", async () => {
    const stack = await createStack();
    await stack.boot();
    const gateB = stack.hold("B");
    const verifying = stack.auth.verifyCode({ channel: "email", identifier: PEOPLE.B.email, code: "123456" });
    await tick();
    stack.setSession("C"); // someone else signs in while B's member is being looked up
    gateB.release();
    const result = await verifying;
    expect(result).toMatchObject({ status: "error", kind: "identity_changed" });
    expect(JSON.stringify(result)).not.toContain("Persona B");
    expect(await stack.auth.getProfile()).toEqual(profileOf("C"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The consumers: not only the final render, but what they were told along the way
// ---------------------------------------------------------------------------------------------------------------------------------

describe("consumers of the client", () => {
  const HEADER_PAGE = `<!doctype html><html lang="es"><body><div class="account-group"><a id="account-link" href="/profile.html" hidden></a><button id="btn-signin" style="visibility:hidden">x</button></div><p id="signin-status"></p></body></html>`;

  it("an older page (no language module, no account link): the header names the person signed in, and when another tab signs in as someone else it names THEM, never A's data after B", async () => {
    const stack = await createStack({ html: HEADER_PAGE });
    stack.setSession("A"); // already signed in as A when the page loads
    stack.auth.attachSignInButton(stack.doc.getElementById("btn-signin"), stack.doc.getElementById("signin-status"));
    await stack.boot();
    await tick();
    const header = () => stack.doc.getElementById("btn-signin")!.textContent;
    expect(header()).toBe("Hi, Persona A");
    const gateB = stack.hold("B");
    stack.setSession("B"); // another tab signs in as B while B's member is still being looked up
    expect(header()).not.toContain("Persona A"); // synchronously: A's name is gone the moment the person changed
    await tick();
    expect(header()).not.toContain("Persona A");
    gateB.release();
    await tick();
    expect(header()).toBe("Hi, Persona B");
    for (const s of stack.identities) expect(mixes(s), JSON.stringify(s)).toEqual([]);
    expect(stack.identities[stack.identities.length - 1]).toEqual(stateOf("B"));
  });

  it("the header account link follows the person, in Spanish, and a late answer for A does not repaint it", async () => {
    const stack = await createStack({ html: HEADER_PAGE, withI18n: true });
    stack.setSession("A");
    stack.auth.attachSignInButton(stack.doc.getElementById("btn-signin"), stack.doc.getElementById("signin-status"), { accountLink: stack.doc.getElementById("account-link") });
    await stack.boot();
    await tick();
    const link = stack.doc.getElementById("account-link")!;
    expect(link.textContent).toBe("Hola, Persona A");
    const gateA = stack.hold("A");
    stack.setSession("B");
    await tick();
    gateA.release(); // A's late answer (there was none pending for the header: it was already resolved) changes nothing
    await tick();
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe("Hola, Persona B");
    stack.setSession(null);
    await tick();
    expect(link.hidden).toBe(true);
    expect(link.textContent).not.toContain("Persona");
    expect(stack.doc.getElementById("btn-signin")!.textContent).toBe("Iniciar sesión / Crear cuenta");
  });

  it("a header that names A while C (an account without a finished profile) signs in elsewhere does not keep naming A", async () => {
    const stack = await createStack({ html: HEADER_PAGE, withI18n: true, members: { C: null } });
    stack.setSession("A");
    stack.auth.attachSignInButton(stack.doc.getElementById("btn-signin"), stack.doc.getElementById("signin-status"), { accountLink: stack.doc.getElementById("account-link") });
    await stack.boot();
    await tick();
    stack.setSession("C");
    await tick();
    expect(stack.doc.getElementById("account-link")!.textContent).not.toContain("Persona A");
    expect(stack.doc.getElementById("btn-signin")!.textContent).toBe("Terminá de crear tu cuenta");
  });
});

describe("onIdentityReset: pages are told, synchronously, that the person changed", () => {
  it("fires at once for a different person and for sign-out, with only { userId }; never for a token refresh or a repeated event", async () => {
    const stack = await createStack();
    const resets: unknown[] = [];
    await stack.auth.onIdentityReset((info: unknown) => resets.push(info));
    stack.setSession("A"); // the first event of the page load: nobody else was being shown
    expect(resets).toEqual([]);
    stack.setSession("A", "TOKEN_REFRESHED");
    stack.setSession("A", "SIGNED_IN");
    expect(resets).toEqual([]);
    stack.setSession("B"); // synchronous: the reset has already happened when setSession returns
    expect(resets).toEqual([{ userId: PEOPLE.B.id }]);
    stack.setSession(null);
    expect(resets).toEqual([{ userId: PEOPLE.B.id }, { userId: null }]);
    expect(JSON.stringify(resets)).not.toMatch(/example\.com|Persona|gm-/); // identifiers only, no personal data
  });

  it("a page that was reset is always told who is signed in afterwards, even when the person came back (A -> B -> A)", async () => {
    const stack = await createStack();
    stack.setSession("A");
    await stack.boot();
    expect(await stack.auth.getState()).toEqual(stateOf("A")); // A is what the pages were last told
    const seen: any[] = [];
    await stack.auth.onIdentityChange((s: any) => seen.push(s));
    stack.setSession("B");
    stack.setSession("A");
    await tick();
    expect(seen.length).toBeGreaterThan(0); // not silently swallowed because the final person equals the last one reported
    expect(seen[seen.length - 1]).toEqual(stateOf("A"));
  });

  it("an unsubscribed listener is not called", async () => {
    const stack = await createStack();
    const calls: unknown[] = [];
    const off = await stack.auth.onIdentityReset((i: unknown) => calls.push(i));
    stack.setSession("A");
    off();
    stack.setSession("B");
    expect(calls).toEqual([]);
  });
});

describe("the real profile page with the real client", () => {
  async function profilePage(setup?: (stack: Stack) => void) {
    const stack = await createStack({ html: PROFILE_HTML, withI18n: true });
    setup?.(stack);
    await tick();
    return stack;
  }
  const body = (stack: Stack) => (stack.doc.getElementById("profile-body")!.textContent ?? "").replace(/\s+/g, " ");
  const shows = (stack: Stack, who: Who) => body(stack).includes(PEOPLE[who].name) && body(stack).includes(PEOPLE[who].email);
  const traceOf = (stack: Stack, who: Who) => body(stack).includes(PEOPLE[who].name) || body(stack).includes(PEOPLE[who].email) || (stack.doc.getElementById("account-link")!.textContent ?? "").includes(PEOPLE[who].name);

  it("A is shown, then B replaces A with no trace of A, then A's late answer arrives and changes nothing", async () => {
    // The page asks for the profile as soon as it loads, so A must be signed in (and held) before it does.
    const dom = await (async () => {
      const stack = await createStack({ html: PROFILE_HTML, withI18n: true });
      return stack;
    })();
    await tick();
    // The first load found nobody signed in: the page shows the signed-out card.
    expect(body(dom)).not.toContain("Persona");
    dom.setSession("A");
    await tick();
    expect(shows(dom, "A")).toBe(true);
    const gateB = dom.hold("B");
    dom.setSession("B");
    await tick();
    expect(traceOf(dom, "A"), `while B loads the page shows: ${body(dom)}`).toBe(false); // nothing of A while B's data is on its way
    gateB.release();
    await tick();
    expect(shows(dom, "B")).toBe(true);
    expect(traceOf(dom, "A")).toBe(false);
  });

  it("A's lookup still running when B signs in: the page ends on B only, whenever A's answer comes", async () => {
    const stack = await createStack({ html: PROFILE_HTML, withI18n: true });
    await tick();
    const gateA = stack.hold("A");
    stack.setSession("A"); // the page starts loading A's profile; the answer is held back
    await tick();
    stack.setSession("B");
    await tick();
    expect(shows(stack, "B")).toBe(true);
    gateA.release(); // late
    await tick();
    expect(shows(stack, "B")).toBe(true);
    expect(traceOf(stack, "A"), body(stack)).toBe(false);
    expect(stack.doc.querySelector("[data-profile-email-status]")!.textContent).toBe("Verificado");
    const since = Array.from(stack.doc.querySelectorAll(".profile-fields .row")).find((r) => r.querySelector("dt")!.textContent === "Miembro desde")!;
    expect(since.querySelector("dd")!.textContent).toContain("2026"); // B's date, formatted
    expect(since.querySelector("dd")!.textContent).toBe(new Date(PEOPLE.B.since).toLocaleDateString("es-HN", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Tegucigalpa" }));
  });

  it("signing out with the lookup pending leaves the signed-out card and no trace of A", async () => {
    const stack = await createStack({ html: PROFILE_HTML, withI18n: true });
    await tick();
    const gateA = stack.hold("A");
    stack.setSession("A");
    await tick();
    stack.setSession(null);
    await tick();
    gateA.release();
    await tick();
    expect(traceOf(stack, "A"), body(stack)).toBe(false);
    expect(stack.doc.getElementById("profile-body")!.querySelector("button, a")).not.toBeNull(); // the sign-in card, not a blank page
  });

  it("repeated changes A -> B -> A -> B end on B, and at no point does the page show a mix (a name from one person with the email of another)", async () => {
    const stack = await createStack({ html: PROFILE_HTML, withI18n: true });
    await tick();
    const seen: string[] = [];
    const observer = new stack.win.MutationObserver(() => seen.push(body(stack)));
    observer.observe(stack.doc.getElementById("profile-body")!, { childList: true, subtree: true, characterData: true });
    const gates = [stack.hold("A"), stack.hold("B"), stack.hold("A")];
    stack.setSession("A"); await tick();
    stack.setSession("B"); await tick();
    stack.setSession("A"); await tick();
    stack.setSession("B"); await tick();
    gates.reverse().forEach((g) => g.release());
    await tick();
    expect(shows(stack, "B")).toBe(true);
    for (const snapshot of seen) {
      const hasA = snapshot.includes(PEOPLE.A.name) || snapshot.includes(PEOPLE.A.email);
      const hasB = snapshot.includes(PEOPLE.B.name) || snapshot.includes(PEOPLE.B.email);
      if (hasA && hasB) throw new Error(`a snapshot mixed two people: ${snapshot}`);
      if (snapshot.includes(PEOPLE.A.email) && snapshot.includes(PEOPLE.B.name)) throw new Error(`mix: ${snapshot}`);
      if (snapshot.includes(PEOPLE.B.email) && snapshot.includes(PEOPLE.A.name)) throw new Error(`mix: ${snapshot}`);
    }
  });
});

describe("the real Predictions page with the real client", () => {
  const match = () => ({
    matchId: "m1", competition: "Liga Sintética", cancelledAt: null, finalized: false,
    kickoffAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    homeTeam: { teamId: "ta", name: "Club Alfa", players: [{ playerId: "p1", name: "Ana Díaz" }] },
    awayTeam: { teamId: "tb", name: "Club Beta", players: [{ playerId: "p3", name: "Cleo Park" }] },
    venueActivations: [{ venueActivationId: "act-1", enabled: true, venue: { venueId: "v1", name: "Local Sintético", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, prizeTiers: [] }],
  });
  // A's prediction is 7-1, B's is 2-0: the number in the form tells whose data is on screen.
  const routes = async (url: string, _init: unknown, ctx: { who: Who | null; gate: (key: string) => Promise<void> }) => {
    if (url === "/api/gaming/predictions/matches") return { status: 200, json: async () => ({ matches: [match()] }) };
    if (url.endsWith("/mine")) {
      await ctx.gate(`mine-${ctx.who}`);
      const prediction = ctx.who === "A" ? { predictedHomeScore: 7, predictedAwayScore: 1 } : { predictedHomeScore: 2, predictedAwayScore: 0 };
      return { status: 200, json: async () => ({ prediction }) };
    }
    return undefined;
  };
  const home = (stack: Stack) => (stack.doc.getElementById("home-score-m1") as HTMLInputElement | null)?.value ?? null;
  const content = (stack: Stack) => (stack.doc.getElementById("content")!.textContent ?? "").replace(/\s+/g, " ");

  it("signed in as A the form holds A's prediction; when B signs in, A's form is gone at once, and B's own appears when B's data arrives", async () => {
    const stack = await createStack({ html: PRED_HTML, withI18n: true, page: "soccer-predictions.html", routes, initialSession: "A" });
    await tick(60);
    expect(home(stack)).toBe("7");
    const gateB = stack.hold("B");
    const mineB = stack.holdRoute("mine-B");
    stack.setSession("B");
    expect(home(stack), "synchronously after the change").toBeNull(); // not a single frame of A's form for B
    await tick(40);
    expect(home(stack)).toBeNull();
    expect(content(stack)).not.toContain("Club Alfa"); // nothing of the previous build either
    gateB.release();
    mineB.release();
    await tick(60);
    expect(home(stack)).toBe("2");
  });

  it("A's build still waiting on the network when B signs in is dropped: the page ends on B's prediction whenever A's answer comes", async () => {
    const stack = await createStack({ html: PRED_HTML, withI18n: true, page: "soccer-predictions.html", routes, initialSession: "A", preArm: ["route:mine-A"] });
    await tick(40); // the page is now waiting for A's prediction
    expect(home(stack)).toBeNull();
    stack.setSession("B");
    await tick(60);
    expect(home(stack)).toBe("2");
    stack.preArmed["route:mine-A"].release(); // A's answer arrives late
    await tick(60);
    expect(home(stack)).toBe("2");
    expect(stack.doc.querySelectorAll('input[id^="home-score-"]')).toHaveLength(1);
  });

  it("signing out leaves the sign-in prompt, not A's form", async () => {
    const stack = await createStack({ html: PRED_HTML, withI18n: true, page: "soccer-predictions.html", routes, initialSession: "A" });
    await tick(60);
    expect(home(stack)).toBe("7");
    stack.setSession(null);
    await tick(60);
    expect(home(stack)).toBeNull();
    expect(stack.doc.querySelector("[data-login-cta]")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: each protection is removed from a COPY of the client, and the scenario it guards must then fail.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("negative controls", () => {
  function mutated(from: string, to: string): string {
    expect(AUTH_SOURCE.split(from).length - 1, `mutation anchor: ${from}`).toBe(1);
    return AUTH_SOURCE.replace(from, to);
  }

  it("a lookup that is not re-checked against the signed-in person (the original defect's behaviour) hands B the wrong data", async () => {
    const source = mutated("    return userIdOf(data && data.session) === userId;", "    return true;");
    const found = await lateAnswerScenario(await createStack({ source, honorAbort: false }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(" | ")).toMatch(/Persona A|instead of the current person/);
  });

  it("a lookup shared across people (not keyed by the Auth user id) mixes B's email with A's member", async () => {
    const source = mutated("    if (memberEntry && memberEntry.userId === userId) return memberEntry.promise;", "    if (memberEntry) return memberEntry.promise;");
    const stack = await createStack({ source });
    await stack.boot();
    stack.setSession("A");
    await stack.auth.getProfile();
    stack.switchSilently("B"); // B's session is visible before the event that would clear the stored lookup
    const forB = await stack.auth.getProfile();
    expect(mixes(forB).length).toBeGreaterThan(0); // B's email next to A's name, id and date
    expect(forB.displayName).toBe("Persona A");
  });

  it("a lookup that is not cancelled when the person changes is caught", async () => {
    const source = mutated("if (lookup.userId !== currentUserId && typeof lookup.abort === \"function\") lookup.abort();", "");
    const found = await lateAnswerScenario(await createStack({ source, honorAbort: true }));
    expect(found.join(" | ")).toMatch(/not cancelled/);
  });

  it("a profile save that is stored without checking who is signed in poisons the next person", async () => {
    const source = mutated("if (!userId || !(await stillSignedInAs(client, userId))) return identityChangedResult();", "if (!userId) return identityChangedResult();");
    const stack = await createStack({ source, members: { A: null } });
    await stack.boot();
    stack.setSession("A");
    await stack.auth.getState();
    const gatePost = stack.holdPost("A");
    const saving = stack.auth.completeProfile("Nombre nuevo de A");
    await tick();
    stack.setSession("B");
    gatePost.release();
    const result = await saving;
    expect(result.status).toBe("authenticated"); // wrong: the call reports A as signed in although B is
    expect(result.email).toBe("a@example.com");
  });

  it("without the re-read after a wait, a sign-out with a lookup pending leaves the pending read reporting A", async () => {
    const source = mutated("    return userIdOf(data && data.session) === userId;", "    return true;");
    const stack = await createStack({ source, honorAbort: false });
    await stack.boot();
    stack.setSession("A");
    const gate = stack.hold("A");
    const pending = stack.auth.getState();
    await tick();
    await stack.auth.signOut();
    gate.release();
    expect((await pending).status).toBe("authenticated"); // wrong: nobody is signed in
  });
  it("without the reset announcement, the profile page keeps showing A while B's data is on its way", async () => {
    const source = mutated("          announceIdentity(userIdOf(session));\n", "");
    const stack = await createStack({ html: PROFILE_HTML, withI18n: true, source, initialSession: "A" });
    await tick(40);
    expect((stack.doc.getElementById("profile-body")!.textContent ?? "")).toContain("Persona A");
    stack.hold("B");
    stack.setSession("B");
    await tick(40);
    expect((stack.doc.getElementById("profile-body")!.textContent ?? "")).toContain("Persona A"); // wrong: B is signed in, A is still on screen
  });

  it("without the 'owed' flag, a page that was reset by A -> B -> A is never told who is signed in", async () => {
    const source = mutated("    if (key === lastIdentityKey && !resetOwed) return;", "    if (key === lastIdentityKey) return;");
    const stack = await createStack({ source });
    stack.setSession("A");
    await stack.boot();
    await stack.auth.getState();
    const seen: any[] = [];
    await stack.auth.onIdentityChange((s: any) => seen.push(s));
    stack.setSession("B");
    stack.setSession("A");
    await tick();
    expect(seen).toHaveLength(0); // wrong: the page was cleared by the reset and is never refilled
  });
});
