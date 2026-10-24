import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The shared authentication component (public/urbanoAuth.js) — account entry. The REAL file is evaluated in jsdom against a
 * controllable fake of the Supabase browser client and of this app's own /api/gaming/config and /api/gaming/member routes: no network,
 * no credentials. These tests prove the component's behavior (what it sends, what it refuses, what it shows). They do NOT prove that an
 * SMS provider delivers a text message: that needs a configured provider and a real handset.
 *
 * Covers: explicit Log in / Create account; email and phone as alternatives with truthful availability; login never creating an
 * account; registration verifying the code before any Gaming Member exists; code, resend, change-address, wrong/expired code and
 * rate-limit states; duplicate submissions and stale replies; identity notifications (and their absence for token refreshes);
 * intent preservation; sign-out clearing; backward compatibility of the original email-only calls.
 */

const SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoAuth.js"), "utf8");
const CODE = "123456";

type Method = { email?: boolean; phone?: boolean };

interface Options {
  authMethods?: Method | null;
  members?: Record<string, { gamingMemberId: string; displayName: string }>; // keyed by identifier
  existingUsers?: string[]; // identifiers that already have an Auth user
  session?: { identifier: string } | null; // already signed in when the page loads
  startWithMemberFor?: string[];
  attach?: Record<string, unknown>; // options given to attachSignInButton (for example { accountEntry: "login-only" })
  url?: string; // the address of the page (default http://localhost/)
}

function createHarness(options: Options = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><header id="hdr"><button id="btn-signin">Sign in with URBANO</button><span id="signin-status">Not signed in.</span></header></body></html>`,
    { url: options.url ?? "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const win = dom.window as unknown as Window & Record<string, any>;

  const users = new Map<string, string>(); // identifier -> auth user id
  for (const id of options.existingUsers ?? []) users.set(id, `uid-${id}`);
  const members = new Map<string, { gamingMemberId: string; displayName: string }>(Object.entries(options.members ?? {}));
  const state = {
    session: null as null | { access_token: string; user: { id: string; email?: string; phone?: string } },
    currentCode: new Map<string, string>(), // identifier -> the only valid code
    codesSent: [] as Array<{ identifier: string; code: string }>,
    otpCalls: [] as Array<Record<string, any>>,
    verifyCalls: [] as Array<Record<string, any>>,
    createdUsers: [] as string[],
    memberCreates: [] as string[],
    memberGets: 0,
    rateLimit: null as null | { seconds: number },
    networkDown: false,
    gate: null as null | Promise<void>,
    now: Date.now(),
  };
  const listeners: Array<(event: string, session: unknown) => void> = [];
  const emit = (event: string) => listeners.slice().forEach((l) => l(event, state.session));

  const sessionFor = (identifier: string) => ({
    access_token: `token-${identifier}`,
    user: { id: users.get(identifier)!, ...(identifier.startsWith("+") ? { phone: identifier } : { email: identifier }) },
  });
  if (options.session) {
    users.set(options.session.identifier, users.get(options.session.identifier) ?? `uid-${options.session.identifier}`);
    state.session = sessionFor(options.session.identifier);
  }

  const identifierOf = (payload: Record<string, any>) => (payload.email ?? payload.phone) as string;
  const client = {
    auth: {
      onAuthStateChange(callback: (event: string, session: unknown) => void) {
        listeners.push(callback);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async getSession() {
        return { data: { session: state.session } };
      },
      async signInWithOtp(payload: Record<string, any>) {
        state.otpCalls.push(JSON.parse(JSON.stringify(payload)));
        if (state.gate) await state.gate;
        if (state.networkDown) throw Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError" });
        if (state.rateLimit) {
          return { data: {}, error: { status: 429, code: "over_email_send_rate_limit", message: `For security purposes, you can only request this after ${state.rateLimit.seconds} seconds.` } };
        }
        const identifier = identifierOf(payload);
        if (!users.has(identifier)) {
          if (payload.options?.shouldCreateUser === false) {
            return { data: {}, error: { status: 422, code: "otp_disabled", message: "Signups not allowed for otp" } };
          }
          users.set(identifier, `uid-${identifier}`);
          state.createdUsers.push(identifier);
        }
        state.currentCode.set(identifier, CODE);
        state.codesSent.push({ identifier, code: CODE });
        return { data: {}, error: null };
      },
      async verifyOtp(payload: Record<string, any>) {
        state.verifyCalls.push(JSON.parse(JSON.stringify(payload)));
        const identifier = identifierOf(payload);
        if (state.currentCode.get(identifier) !== payload.token) {
          return { data: { session: null, user: null }, error: { status: 403, code: "otp_expired", message: "Token has expired or is invalid" } };
        }
        state.currentCode.delete(identifier);
        state.session = sessionFor(identifier);
        emit("SIGNED_IN");
        return { data: { session: state.session, user: state.session.user }, error: null };
      },
      async signOut() {
        state.session = null;
        emit("SIGNED_OUT");
        return { error: null };
      },
    },
  };

  const memberKey = (token: string | null) => (token ? token.replace(/^token-/, "") : null);
  win.supabase = { createClient: () => client };
  win.fetch = (async (url: string, init?: Record<string, any>) => {
    const target = String(url);
    if (target === "/api/gaming/config") {
      return { ok: true, status: 200, json: async () => ({ supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" }) };
    }
    if (target === "/api/gaming/auth-methods") {
      if (options.authMethods === null) return { ok: false, status: 404, json: async () => ({}) }; // an older deployment without the route
      return { ok: true, status: 200, json: async () => options.authMethods ?? { email: true, phone: false } };
    }
    if (target === "/api/gaming/member") {
      const token = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
      const identifier = memberKey(token);
      if (init?.method === "POST") {
        const name = JSON.parse(init.body).displayName as string;
        const existing = identifier ? members.get(identifier) : undefined;
        if (!existing && identifier) {
          members.set(identifier, { gamingMemberId: `gm-${identifier}`, displayName: name });
          state.memberCreates.push(identifier);
        }
        return { ok: true, status: 200, json: async () => ({ gamingMember: members.get(identifier!) }) };
      }
      state.memberGets += 1;
      return { ok: true, status: 200, json: async () => ({ gamingMember: identifier ? members.get(identifier) ?? null : null }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  win.Date.now = () => state.now;
  win.eval(`${SOURCE}\nwindow.UrbanoAuth = UrbanoAuth;`);

  const doc = win.document;
  const auth = win.UrbanoAuth as Record<string, any>;
  const panel = () => doc.querySelector("[data-urbano-signin-panel]") as HTMLElement;
  const header = () => doc.getElementById("btn-signin") as HTMLButtonElement;
  const q = (selector: string) => panel().querySelector(selector) as HTMLElement | null;
  const text = () => panel().textContent ?? "";
  const flush = async (n = 12) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const click = async (selector: string) => {
    const element = q(selector);
    if (!element) throw new Error(`no ${selector} in the panel: ${text()}`);
    element.click();
    await flush();
  };
  const type = async (selector: string, value: string) => {
    const input = q(selector) as HTMLInputElement | null;
    if (!input) throw new Error(`no ${selector} in the panel: ${text()}`);
    input.value = value;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  };

  auth.attachSignInButton(header(), doc.getElementById("signin-status"), options.attach);
  const identityEvents: Array<Record<string, any>> = [];
  const ready = (async () => {
    await flush();
    await auth.onIdentityChange((s: Record<string, any>) => identityEvents.push(s));
    await flush();
  })();

  return { win, doc, auth, state, users, members, panel, header, q, text, click, type, flush, emit, identityEvents, ready, close: () => dom.window.close() };
}

type Harness = ReturnType<typeof createHarness>;

async function openToMethod(h: Harness, mode: "login" | "register") {
  await h.ready;
  h.header().click();
  await h.flush();
  await h.click(mode === "login" ? "[data-choose-login]" : "[data-choose-register]");
}

async function sendEmail(h: Harness, address: string) {
  await h.type("[data-contact]", address);
  await h.click("[data-send]");
}

describe("Enter URBANO: explicit Log in / Create account, then Email or Phone", () => {
  it("the panel opens on a choice between Log in and Create account, and sends nothing", async () => {
    const h = createHarness();
    await h.ready;
    expect(h.header().textContent).toBe("Log in / Create account");
    h.header().click();
    await h.flush();
    expect(h.text()).toContain("Enter URBANO");
    expect(h.q("[data-choose-login]")!.textContent).toBe("Log in");
    expect(h.q("[data-choose-register]")!.textContent).toBe("Create account");
    expect(h.q("[data-contact]")).toBeNull();
    expect(h.state.otpCalls).toHaveLength(0);
    h.close();
  });

  it("pressing buttons inside the panel (which rebuilds it) never closes it; only a click elsewhere on the page does", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    expect(h.panel().style.display).toBe("block");
    await sendEmail(h, "ana@example.com");
    expect(h.q("[data-code]")).not.toBeNull();
    expect(h.panel().style.display).toBe("block");
    await h.click("[data-change]");
    expect(h.panel().style.display).toBe("block");
    await h.click("[data-back]");
    expect(h.panel().style.display).toBe("block");
    h.doc.body.click(); // somewhere else on the page
    await h.flush();
    expect(h.panel().style.display).toBe("none");
    h.close();
  });

  it("each choice leads to its own screen and a Back that returns to the choice", async () => {
    const h = createHarness();
    await openToMethod(h, "login");
    expect(h.text()).toContain("Log in");
    expect(h.q("[data-send]")!.textContent).toBe("Send login code");
    await h.click("[data-back]");
    expect(h.q("[data-choose-register]")).not.toBeNull();
    await h.click("[data-choose-register]");
    expect(h.text()).toContain("Create account");
    expect(h.q("[data-send]")!.textContent).toBe("Send verification code");
    h.close();
  });

  it("phone is labelled unavailable and cannot be used when the backend does not report it; nothing is sent or simulated", async () => {
    for (const authMethods of [undefined, { email: true, phone: false }, null] as const) {
      const h = createHarness({ authMethods });
      await openToMethod(h, "login");
      await h.flush();
      const phone = h.q("[data-method-phone]")!;
      expect(phone.textContent).toBe("Phone — not available yet");
      expect(phone.getAttribute("aria-disabled")).toBe("true");
      await h.click("[data-method-phone]");
      expect(h.text()).toContain("Phone sign-in isn't available yet");
      expect((h.q("[data-contact]") as HTMLInputElement).type).toBe("email");
      expect(h.state.otpCalls).toHaveLength(0);
      // and even a direct call into the component refuses without touching the backend
      const refused = await h.auth.requestCode({ channel: "phone", identifier: "+50499999999", mode: "register" });
      expect(refused).toMatchObject({ status: "error", kind: "unavailable" });
      expect(h.state.otpCalls).toHaveLength(0);
      h.close();
    }
  });

  it("phone works as an alternative only when the backend reports it: E.164 normalization, sms verification, no email asked for", async () => {
    const h = createHarness({ authMethods: { email: true, phone: true } });
    await openToMethod(h, "register");
    await h.flush();
    expect(h.q("[data-method-phone]")!.textContent).toBe("Phone");
    await h.click("[data-method-phone]");
    const input = h.q("[data-contact]") as HTMLInputElement;
    expect(input.type).toBe("tel");
    await h.type("[data-contact]", "+504 9999-9999");
    await h.click("[data-send]");
    expect(h.state.otpCalls).toEqual([{ phone: "+50499999999", options: { shouldCreateUser: true } }]);
    expect(h.text()).toContain("+50499999999");
    expect(h.text()).toContain("text message");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.state.verifyCalls).toEqual([{ phone: "+50499999999", token: CODE, type: "sms" }]);
    // a phone journey never asks for an email address
    expect(h.state.otpCalls.some((c) => "email" in c)).toBe(false);
    expect(h.text()).toContain("Choose your display name");
    h.close();
  });

  it("malformed phone numbers are refused before anything is sent, and the country code is never guessed", async () => {
    const h = createHarness({ authMethods: { email: true, phone: true } });
    await openToMethod(h, "login");
    await h.flush();
    await h.click("[data-method-phone]");
    for (const bad of ["", "99999999", "504 9999 9999", "+0123456", "+50", "+1234567890123456", "abc", "+504 99x99999"]) {
      await h.type("[data-contact]", bad);
      await h.click("[data-send]");
      expect(h.state.otpCalls, `"${bad}"`).toHaveLength(0);
      expect(h.q("[data-msg]")!.textContent, `"${bad}"`).not.toBe("");
    }
    expect(h.auth.normalizePhone("00504 9999 9999")).toEqual({ ok: true, e164: "+50499999999" });
    expect(h.auth.normalizePhone("(+1) 555-010-0199")).toEqual({ ok: true, e164: "+15550100199" });
    h.close();
  });

  it("an email must look like one before anything is sent", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    for (const bad of ["", "nobody", "a@b", "a b@c.co"]) {
      await h.type("[data-contact]", bad);
      await h.click("[data-send]");
      expect(h.state.otpCalls, `"${bad}"`).toHaveLength(0);
    }
    h.close();
  });
});

describe("Log in never silently creates an account", () => {
  it("an unknown email creates nothing and gets the same neutral screen as a known one; creating an account is a separate, explicit choice", async () => {
    const h = createHarness({ existingUsers: ["known@example.com"] });
    await openToMethod(h, "login");
    await sendEmail(h, "stranger@example.com");
    expect(h.state.otpCalls).toEqual([{ email: "stranger@example.com", options: { shouldCreateUser: false } }]);
    expect(h.state.createdUsers).toEqual([]);
    expect(h.users.has("stranger@example.com")).toBe(false);
    // nothing on screen reveals that there is no account, or claims a delivery
    expect(h.q("[data-code]")).not.toBeNull();
    expect(h.text()).not.toMatch(/couldn't find|no account|not found|doesn't exist/i);
    expect(h.text()).toContain("If stranger@example.com has an account, a code is on its way");
    expect(h.text()).not.toContain("We sent");
    // a code that cannot work fails exactly like a wrong code for a real account
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.text()).toContain("That code isn't valid or has expired");
    expect(h.state.createdUsers).toEqual([]);
    // creating one is a separate, explicit choice that keeps what was typed
    await h.click("[data-create-instead]");
    expect(h.text()).toContain("Create account");
    expect((h.q("[data-contact]") as HTMLInputElement).value).toBe("stranger@example.com");
    expect(h.state.createdUsers).toEqual([]);
    await h.click("[data-send]");
    expect(h.state.otpCalls[1]).toEqual({ email: "stranger@example.com", options: { shouldCreateUser: true } });
    expect(h.state.createdUsers).toEqual(["stranger@example.com"]);
    expect(h.text()).toContain("We sent a code to stranger@example.com");
    h.close();
  });

  it("the log-in screens for a known and an unknown address are identical apart from the address itself", async () => {
    const view = async (email: string) => {
      const h = createHarness({ existingUsers: ["known@example.com"] });
      await openToMethod(h, "login");
      await sendEmail(h, email);
      const afterSend = h.panel().textContent!.split(email).join("ADDRESS");
      const resend = h.q("[data-resend]") as HTMLButtonElement;
      const resendState = `${resend.disabled}|${resend.textContent}`;
      const codeStepControls = Array.from(h.panel().querySelectorAll("button, input")).map((el) => el.tagName + ":" + (el.getAttribute("data-code") ?? el.getAttribute("data-verify") ?? el.getAttribute("data-resend") ?? el.getAttribute("data-change") ?? el.getAttribute("data-create-instead") ?? ""));
      // after the cooldown, resend answers identically too
      h.state.now += 61_000;
      await new Promise((r) => setTimeout(r, 1100));
      (h.q("[data-resend]") as HTMLButtonElement).click();
      await h.flush();
      const afterResend = h.panel().textContent!.split(email).join("ADDRESS");
      h.close();
      return { afterSend, resendState, codeStepControls, afterResend };
    };
    const known = await view("known@example.com");
    const unknown = await view("stranger@example.com");
    expect(unknown).toEqual(known);
    expect(known.afterSend).toContain("Create an account instead");
  });

  it("a returning member logs in: the code is verified, the panel closes, the header names them, and no member or user is created", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } });
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    expect(h.state.otpCalls).toEqual([{ email: "ana@example.com", options: { shouldCreateUser: false } }]);
    expect(h.text()).toContain("If ana@example.com has an account, a code is on its way");
    expect(h.text()).toContain("check your spam folder");
    expect(h.text()).not.toMatch(/\d-digit/); // the project, not this screen, decides the code length
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.panel().style.display).toBe("none");
    expect(h.header().textContent).toBe("Hi, Ana");
    expect(h.state.createdUsers).toEqual([]);
    expect(h.state.memberCreates).toEqual([]);
    expect(h.identityEvents.map((e) => e.status)).toEqual(["authenticated"]);
    h.close();
  });

  it("a verified identity with no finished account is asked for a display name to finish, not silently given one", async () => {
    const h = createHarness({ existingUsers: ["half@example.com"] });
    await openToMethod(h, "login");
    await sendEmail(h, "half@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.text()).toContain("Choose your display name");
    expect(h.state.memberCreates).toEqual([]);
    h.close();
  });
});

describe("Create account verifies control of the contact before the Gaming Member exists", () => {
  it("wrong code first, then the right one; the display name step comes after verification; exactly one member is created", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    await sendEmail(h, "new@example.com");
    expect(h.state.memberCreates).toEqual([]);

    await h.type("[data-code]", "000000");
    await h.click("[data-verify]");
    expect(h.text()).toContain("That code isn't valid or has expired");
    expect(h.q("[data-code]")).not.toBeNull(); // still on the code step
    expect((h.q("[data-code]") as HTMLInputElement).value).toBe("");
    expect(h.state.memberCreates).toEqual([]);

    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.text()).toContain("Choose your display name");
    expect(h.state.memberCreates).toEqual([]); // verified, but no Gaming Member yet

    await h.type("[data-display-name]", "Nueva Persona");
    await h.click("[data-continue]");
    expect(h.state.memberCreates).toEqual(["new@example.com"]);
    expect(h.header().textContent).toBe("Hi, Nueva Persona");
    expect(h.panel().style.display).toBe("none");
    expect(h.identityEvents.map((e) => e.status)).toEqual(["profile_incomplete", "authenticated"]);
    h.close();
  });

  it("registering with a contact that already has an account is a login and says so; no second member is created", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } });
    await openToMethod(h, "register");
    await sendEmail(h, "ana@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.text()).toContain("Welcome back");
    expect(h.text()).toContain("already has an account");
    expect(h.header().textContent).toBe("Hi, Ana");
    expect(h.state.memberCreates).toEqual([]);
    expect(h.state.createdUsers).toEqual([]);
    await h.click("[data-welcome-continue]");
    expect(h.panel().style.display).toBe("none");
    h.close();
  });

  it("an empty display name is refused and creates nothing", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    await sendEmail(h, "new@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    await h.type("[data-display-name]", "   ");
    await h.click("[data-continue]");
    expect(h.text()).toContain("Enter a display name");
    expect(h.state.memberCreates).toEqual([]);
    h.close();
  });
});

describe("Code delivery, resend, change address and failure states", () => {
  it("resend is off during the cooldown, then sends a NEW code and the old one stops working", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } });
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    const resend = () => h.q("[data-resend]") as HTMLButtonElement;
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toMatch(/^Resend code in \d+s$/);
    resend().click();
    await h.flush();
    expect(h.state.otpCalls).toHaveLength(1); // a click during the cooldown sends nothing

    h.state.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100)); // the countdown label refreshes on a real one-second timer
    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Resend code");
    // the server issues a fresh code on every send; model it by changing the code
    const firstCode = h.state.currentCode.get("ana@example.com");
    resend().click();
    await h.flush();
    expect(h.state.otpCalls).toHaveLength(2);
    expect(h.state.otpCalls[1]).toEqual({ email: "ana@example.com", options: { shouldCreateUser: false } });
    expect(h.text()).toContain("If an account exists, a new code is on its way"); // log in never confirms an account
    h.state.currentCode.set("ana@example.com", "654321");
    await h.type("[data-code]", firstCode!);
    await h.click("[data-verify]");
    expect(h.text()).toContain("That code isn't valid or has expired"); // the old code no longer works
    await h.type("[data-code]", "654321");
    await h.click("[data-verify]");
    expect(h.header().textContent).toBe("Hi, Ana");
    h.close();
  });

  it("resend stays off for the server's whole 60 second per-user window, not a shorter one", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    h.state.now += 31_000;
    await new Promise((r) => setTimeout(r, 1100));
    const resend = h.q("[data-resend]") as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/^Resend code in \d+s$/);
    h.close();
  });

  it("accepts a code of any length the project issues (production issues 8 digits) and registration never promises a length", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    await sendEmail(h, "eight@example.com");
    expect(h.text()).toContain("We sent a code to eight@example.com");
    expect(h.text()).not.toMatch(/\d-digit/);
    h.state.currentCode.set("eight@example.com", "12345678");
    await h.type("[data-code]", "1234 5678"); // pasted with a space, as some mail clients show it
    await h.click("[data-verify]");
    expect(h.text()).toContain("Choose your display name");
    expect(h.state.verifyCalls.at(-1)).toMatchObject({ token: "12345678" });
    h.close();
  });

  it("a server rate limit shows the wait it asks for and keeps resend off for that long", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    h.state.rateLimit = { seconds: 42 };
    await sendEmail(h, "ana@example.com");
    expect(h.text()).toContain("Too many requests. Please wait 42 seconds");
    expect(h.q("[data-code]")).toBeNull(); // no code was sent, so no code screen
    h.close();

    const h2 = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h2, "login");
    await sendEmail(h2, "ana@example.com");
    h2.state.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100));
    h2.state.rateLimit = { seconds: 17 };
    (h2.q("[data-resend]") as HTMLButtonElement).click();
    await h2.flush();
    expect(h2.text()).toContain("Please wait 17 seconds");
    expect((h2.q("[data-resend]") as HTMLButtonElement).disabled).toBe(true);
    expect(h2.q("[data-resend]")!.textContent).toBe("Resend code in 17s");
    h2.close();
  });

  it("'Use a different email' returns to the address step with what was typed, and the new address is the one used", async () => {
    const h = createHarness({ existingUsers: ["a@example.com", "b@example.com"] });
    await openToMethod(h, "login");
    await sendEmail(h, "a@example.com");
    await h.click("[data-change]");
    expect(h.q("[data-code]")).toBeNull();
    expect((h.q("[data-contact]") as HTMLInputElement).value).toBe("a@example.com");
    await sendEmail(h, "b@example.com");
    expect(h.state.otpCalls.map((c) => c.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(h.text()).toContain("b@example.com");
    // the earlier address's code does not verify the new one
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.state.verifyCalls[0]).toMatchObject({ email: "b@example.com" });
    h.close();
  });

  it("a network failure is shown as such, with the typed address kept and nothing half-done", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    h.state.networkDown = true;
    await sendEmail(h, "ana@example.com");
    expect(h.text()).toContain("Couldn't reach the server");
    expect(h.q("[data-code]")).toBeNull();
    expect((h.q("[data-contact]") as HTMLInputElement).value).toBe("ana@example.com");
    h.state.networkDown = false;
    await h.click("[data-send]"); // trying again works
    expect(h.q("[data-code]")).not.toBeNull();
    expect(h.auth.classifyAuthError({ status: 422, code: "otp_disabled" }, "request", "register", "email").kind).toBe("signup_closed");
    expect(h.auth.classifyAuthError({ status: 403, code: "otp_expired" }, "verify", "login", "phone").kind).toBe("code_invalid");
    expect(h.auth.classifyAuthError({ status: 500, message: "boom" }, "request", "login", "email").kind).toBe("unknown");
    h.close();
  });

  it("the address a person typed is shown as text: markup in it is never parsed", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    const hostile = `a"><b>x</b>@example.com`; // no whitespace, so it passes the shape check and reaches the code screen
    await sendEmail(h, hostile);
    expect(h.q("[data-code]")).not.toBeNull();
    expect(h.panel().querySelector("b, img, script")).toBeNull();
    expect(h.text()).toContain(hostile);
    h.close();
  });
});

describe("Duplicate submissions and stale answers", () => {
  it("double-clicking Send is one request", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => { release = resolve; });
    await h.type("[data-contact]", "ana@example.com");
    (h.q("[data-send]") as HTMLElement).click();
    (h.q("[data-send]") as HTMLElement).click();
    (h.q("[data-send]") as HTMLElement).click();
    await h.flush();
    expect(h.state.otpCalls).toHaveLength(1);
    expect((h.q("[data-send]") as HTMLButtonElement).disabled).toBe(true);
    release();
    await h.flush();
    expect(h.q("[data-code]")).not.toBeNull();
    h.close();
  });

  it("double-clicking Verify is one verification", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } });
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    await h.type("[data-code]", CODE);
    (h.q("[data-verify]") as HTMLElement).click();
    (h.q("[data-verify]") as HTMLElement).click();
    await h.flush();
    expect(h.state.verifyCalls).toHaveLength(1);
    h.close();
  });

  it("a slow reply that arrives after the person went Back is ignored: no code screen appears", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => { release = resolve; });
    await h.type("[data-contact]", "ana@example.com");
    (h.q("[data-send]") as HTMLElement).click();
    await h.flush();
    await h.click("[data-back]"); // still usable while the request is in flight
    expect(h.q("[data-choose-login]")).not.toBeNull();
    release();
    await h.flush();
    expect(h.q("[data-code]")).toBeNull();
    expect(h.q("[data-choose-login]")).not.toBeNull();
    h.close();
  });
});

describe("Identity notifications, intended action and sign-out", () => {
  const ana = { existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } };

  it("onIdentityChange fires for a sign-in and a sign-out, and NOT for token refreshes or a repeated sign-in of the same person", async () => {
    const h = createHarness(ana);
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.identityEvents.map((e) => e.status)).toEqual(["authenticated"]);
    const before = h.identityEvents.length;
    h.emit("TOKEN_REFRESHED");
    h.emit("SIGNED_IN"); // a tab regaining focus re-announces the same person
    h.emit("INITIAL_SESSION");
    await h.flush();
    expect(h.identityEvents).toHaveLength(before);
    (h.doc.querySelector("[data-urbano-signout]") as HTMLElement).click();
    await h.flush();
    expect(h.identityEvents.map((e) => e.status)).toEqual(["authenticated", "unauthenticated"]);
    h.close();
  });

  it("the original onAuthStateChange keeps firing on every event, including token refreshes", async () => {
    const h = createHarness(ana);
    await h.ready;
    let calls = 0;
    await h.auth.onAuthStateChange(() => { calls += 1; });
    h.emit("TOKEN_REFRESHED");
    h.emit("TOKEN_REFRESHED");
    await h.flush();
    expect(calls).toBe(2);
    h.close();
  });

  it("an intended action is remembered through sign-in, consumed once, expires, and is cleared on sign-out", async () => {
    const h = createHarness(ana);
    await h.ready;
    expect(h.auth.openSignIn({ intent: { kind: "predict", matchId: "m1" } })).toBe(true);
    await h.flush();
    expect(h.panel().style.display).toBe("block"); // opened by the page, with a click that did not also dismiss it
    expect(h.auth.peekIntent()).toMatchObject({ kind: "predict", matchId: "m1" });
    expect(h.auth.consumeIntent()).toMatchObject({ kind: "predict", matchId: "m1" });
    expect(h.auth.consumeIntent()).toBeNull();

    h.auth.openSignIn({ intent: { kind: "predict", matchId: "m2" } });
    h.state.now += 31 * 60 * 1000;
    expect(h.auth.peekIntent()).toBeNull(); // stale after thirty minutes
    h.close();
  });

  it("signing out clears the remembered intent and every half-finished journey; the next person starts clean", async () => {
    const h = createHarness({ ...ana, session: { identifier: "ana@example.com" }, startWithMemberFor: ["ana@example.com"] });
    await h.ready;
    expect(h.header().textContent).toBe("Hi, Ana");
    h.auth.openSignIn({ intent: { kind: "predict", matchId: "m1" } }); // signed in: nothing to open
    expect(h.panel().style.display).toBe("none");
    expect(h.auth.peekIntent()).toMatchObject({ matchId: "m1" });
    (h.doc.querySelector("[data-urbano-signout]") as HTMLElement).click();
    await h.flush();
    expect(h.auth.peekIntent()).toBeNull();
    expect(h.header().textContent).toBe("Log in / Create account");
    h.header().click();
    await h.flush();
    expect(h.q("[data-choose-login]")).not.toBeNull();
    expect(h.text()).not.toContain("ana@example.com");
    h.close();
  });

  it("clicking the signed-in name does not offer to log in again", async () => {
    const h = createHarness({ ...ana, session: { identifier: "ana@example.com" } });
    await h.ready;
    h.header().click();
    await h.flush();
    expect(h.panel().style.display).toBe("none");
    h.close();
  });

  it("a session whose account was never finished resumes at the display name step, labelled as finishing", async () => {
    const h = createHarness({ existingUsers: ["half@example.com"], session: { identifier: "half@example.com" } });
    await h.ready;
    expect(h.header().textContent).toBe("Finish creating your account");
    h.header().click();
    await h.flush();
    expect(h.text()).toContain("Choose your display name");
    expect(h.text()).toContain("One last step");
    h.close();
  });

  it("an unrelated session event does not wipe a code the person is typing", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"] });
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    await h.type("[data-code]", "12");
    h.emit("INITIAL_SESSION");
    h.emit("TOKEN_REFRESHED");
    await h.flush();
    expect(h.q("[data-code]")).not.toBeNull();
    expect((h.q("[data-code]") as HTMLInputElement).value).toBe("12");
    h.close();
  });
});

describe("The original email-only calls keep their meaning for existing consumers", () => {
  it("requestOtp creates-or-signs-in by email exactly as before; verifyOtp resolves the member; the old surface is intact", async () => {
    const h = createHarness({ existingUsers: ["ana@example.com"], members: { "ana@example.com": { gamingMemberId: "gm-ana", displayName: "Ana" } } });
    await h.ready;
    for (const method of ["getState", "isAuthenticated", "requestOtp", "verifyOtp", "completeProfile", "signOut", "getAccessToken", "onAuthStateChange", "attachSignInButton"]) {
      expect(typeof h.auth[method], method).toBe("function");
    }
    expect(await h.auth.requestOtp("ana@example.com")).toEqual({ status: "sent" });
    expect(h.state.otpCalls[0]).toEqual({ email: "ana@example.com", options: { shouldCreateUser: true } });
    expect(await h.auth.verifyOtp("ana@example.com", "000000")).toMatchObject({ status: "error" });
    expect(await h.auth.verifyOtp("ana@example.com", CODE)).toMatchObject({ status: "authenticated", displayName: "Ana" });
    expect(h.state.verifyCalls.at(-1)).toEqual({ email: "ana@example.com", token: CODE, type: "email" });
    expect(await h.auth.getAccessToken()).toBe("token-ana@example.com");
    expect(await h.auth.getState()).toMatchObject({ status: "authenticated", email: "ana@example.com", gamingMemberId: "gm-ana", displayName: "Ana" });
    h.close();
  });

  it("getAuthMethods reports exactly what the backend says, and a deployment without the route means phone is unavailable", async () => {
    const withPhone = createHarness({ authMethods: { email: true, phone: true } });
    expect(await withPhone.auth.getAuthMethods()).toEqual({ email: true, phone: true });
    withPhone.close();
    const old = createHarness({ authMethods: null });
    expect(await old.auth.getAuthMethods()).toEqual({ email: true, phone: false });
    old.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// Login-only entry (attachSignInButton(..., { accountEntry: "login-only" })) — the Score administration portal.
// The panel can only LOG IN: no account is created, no Gaming Member is created, and no choice to create either is offered. Every
// other page keeps the panel exactly as before.
// ---------------------------------------------------------------------------------------------------------------------------------

const LOGIN_ONLY = { accountEntry: "login-only" };

async function openLoginOnly(h: Harness) {
  await h.ready;
  h.header().click();
  await h.flush();
}

describe("login-only entry: no account and no member can be created from this panel", () => {
  it("the header says Sign in, and the panel opens straight on the email screen with nothing to choose", async () => {
    const h = createHarness({ attach: LOGIN_ONLY });
    await h.ready;
    expect(h.header().textContent).toBe("Sign in");
    h.header().click();
    await h.flush();
    expect(h.q("[data-choose-login]")).toBeNull();
    expect(h.q("[data-choose-register]")).toBeNull();
    expect(h.q("[data-contact]")).not.toBeNull();
    expect(h.q("[data-send]")!.textContent).toBe("Send login code");
    expect(h.panel().getAttribute("aria-label")).toBe("Sign in");
    expect(h.state.otpCalls).toHaveLength(0);
    h.close();
  });

  it("the words Create account appear nowhere: not in the header, the panel, or any screen of the journey", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"], members: { "boss@example.com": { gamingMemberId: "gm-boss", displayName: "Boss" } } });
    const seen: string[] = [];
    const record = () => seen.push(`${h.header().textContent} | ${h.panel().textContent}`);
    await openLoginOnly(h);
    record();
    await sendEmail(h, "boss@example.com");
    record();
    for (const screen of seen) expect(screen).not.toMatch(/create (an )?account|I already have an account|Enter URBANO/i);
    expect(h.q("[data-create-instead]")).toBeNull();
    expect(h.q("[data-switch-mode]")).toBeNull();
    h.close();
  });

  it("the code is requested with shouldCreateUser false, on the first send and on a resend", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"] });
    await openLoginOnly(h);
    await sendEmail(h, "boss@example.com");
    expect(h.state.otpCalls).toHaveLength(1);
    expect(h.state.otpCalls[0]!.options?.shouldCreateUser).toBe(false);
    h.state.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100)); // the countdown ticks once a second
    await h.click("[data-resend]");
    expect(h.state.otpCalls).toHaveLength(2);
    expect(h.state.otpCalls[1]!.options?.shouldCreateUser).toBe(false);
    h.close();
  });

  it("an address nobody has an account for gets the same screen as a known one, and no Auth user is created", async () => {
    const known = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"] });
    await openLoginOnly(known);
    await sendEmail(known, "boss@example.com");
    const knownScreen = known.text();
    known.close();

    const unknown = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"] });
    await openLoginOnly(unknown);
    await sendEmail(unknown, "stranger@example.com");
    expect(unknown.q("[data-code]")).not.toBeNull();
    expect(unknown.text().replace("stranger@example.com", "boss@example.com")).toBe(knownScreen);
    expect(unknown.state.createdUsers).toEqual([]);
    expect(unknown.users.has("stranger@example.com")).toBe(false);
    expect(unknown.state.codesSent).toEqual([]);
    unknown.close();
  });

  it("a verified identity that has NO Gaming Member is not offered a name, and no member is created", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["ghost@example.com"] });
    await openLoginOnly(h);
    await sendEmail(h, "ghost@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.q("[data-display-name]")).toBeNull();
    expect(h.q("[data-continue]")).toBeNull();
    expect(h.state.memberCreates).toEqual([]);
    expect(h.panel().style.display).toBe("none");
    expect(h.header().textContent).toBe("Sign in");
    expect(await h.auth.getState()).toMatchObject({ status: "profile_incomplete" });
    h.close();
  });

  it("a page that loads with a session that has no Gaming Member does not say Finish creating your account", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["ghost@example.com"], session: { identifier: "ghost@example.com" } });
    await h.ready;
    await h.flush();
    expect(h.header().textContent).toBe("Sign in");
    expect(h.header().textContent).not.toMatch(/finish creating/i);
    h.header().click();
    await h.flush();
    expect(h.q("[data-display-name]")).toBeNull();
    expect(h.state.memberCreates).toEqual([]);
    h.close();
  });

  it("an existing member signs in and gets a normal signed-in header", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"], members: { "boss@example.com": { gamingMemberId: "gm-boss", displayName: "Boss" } } });
    await openLoginOnly(h);
    await sendEmail(h, "boss@example.com");
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    expect(h.header().textContent).toBe("Hi, Boss");
    expect(h.doc.querySelector("[data-urbano-signout]")).not.toBeNull();
    expect(h.state.createdUsers).toEqual([]);
    expect(h.state.memberCreates).toEqual([]);
    h.close();
  });

  it("asking the page to open the panel in register mode still opens the login screen", async () => {
    const h = createHarness({ attach: LOGIN_ONLY });
    await h.ready;
    expect(h.auth.openSignIn({ mode: "register" })).toBe(true);
    await h.flush();
    expect(h.q("[data-send]")!.textContent).toBe("Send login code");
    expect(h.q("[data-switch-mode]")).toBeNull();
    h.close();
  });

  it("Close leaves the panel and sends nothing", async () => {
    const h = createHarness({ attach: LOGIN_ONLY });
    await openLoginOnly(h);
    await h.click("[data-back]");
    expect(h.panel().style.display).toBe("none");
    expect(h.state.otpCalls).toHaveLength(0);
    h.close();
  });

  it("signing out returns to Sign in, still without a way to create an account", async () => {
    const h = createHarness({ attach: LOGIN_ONLY, existingUsers: ["boss@example.com"], members: { "boss@example.com": { gamingMemberId: "gm-boss", displayName: "Boss" } }, session: { identifier: "boss@example.com" } });
    await h.ready;
    await h.flush();
    expect(h.header().textContent).toBe("Hi, Boss");
    (h.doc.querySelector("[data-urbano-signout]") as HTMLElement).click();
    await h.flush();
    expect(h.header().textContent).toBe("Sign in");
    h.header().click();
    await h.flush();
    expect(h.q("[data-choose-register]")).toBeNull();
    h.close();
  });
});

describe("login-only entry leaves every other page alone", () => {
  it("without the option, and with an option that is not login-only, the panel is the one it always was", async () => {
    for (const attach of [undefined, {}, { accountEntry: "something-else" }, { accountEntry: "LOGIN-ONLY" }]) {
      const h = createHarness({ attach });
      await h.ready;
      expect(h.header().textContent).toBe("Log in / Create account");
      h.header().click();
      await h.flush();
      expect(h.q("[data-choose-login]")).not.toBeNull();
      expect(h.q("[data-choose-register]")).not.toBeNull();
      h.close();
    }
  });

  it("public registration still creates the identity and the member, after the code is verified", async () => {
    const h = createHarness();
    await openToMethod(h, "register");
    await sendEmail(h, "newcomer@example.com");
    expect(h.state.otpCalls[0]!.options?.shouldCreateUser).toBe(true);
    expect(h.state.createdUsers).toEqual(["newcomer@example.com"]);
    await h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    await h.type("[data-display-name]", "Newcomer");
    await h.click("[data-continue]");
    expect(h.state.memberCreates).toEqual(["newcomer@example.com"]);
    expect(h.header().textContent).toBe("Hi, Newcomer");
    h.close();
  });

  it("the original email-only calls keep their meaning (requestOtp registers), and the portal source never uses them", () => {
    const portal = readFileSync(path.join(process.cwd(), "public/predictions-admin.html"), "utf8");
    expect(portal).toContain('accountEntry: "login-only"');
    expect(portal).not.toMatch(/requestOtp|completeProfile|requestCode\(|mode:\s*"register"/);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// The fixed administrative return. The email link of a sign-in requested from the Score portal comes back to the portal; every other
// request names no destination at all. The address is a constant of the component, chosen by a KEY: it is never built from the address
// bar, from ?next=, or from a value a caller supplies.
// ---------------------------------------------------------------------------------------------------------------------------------

const SCORE_ADMIN_RETURN = "https://gaming.urbanohn.com/predictions-admin.html";
const PORTAL_ENTRY = { accountEntry: "login-only", returnTo: "score-admin" };

describe("returnTo: \"score-admin\" gives the sign-in email a fixed administrative destination", () => {
  it("the first send and a resend both ask for exactly that address, and still never create a user", async () => {
    const h = createHarness({ attach: PORTAL_ENTRY, existingUsers: ["boss@example.com"] });
    await openLoginOnly(h);
    await sendEmail(h, "boss@example.com");
    expect(h.state.otpCalls).toEqual([{ email: "boss@example.com", options: { shouldCreateUser: false, emailRedirectTo: SCORE_ADMIN_RETURN } }]);
    h.state.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100));
    await h.click("[data-resend]");
    expect(h.state.otpCalls).toHaveLength(2);
    expect(h.state.otpCalls[1]).toEqual({ email: "boss@example.com", options: { shouldCreateUser: false, emailRedirectTo: SCORE_ADMIN_RETURN } });
    expect(h.state.createdUsers).toEqual([]);
    h.close();
  });

  it("is independent of the entry mode: the key alone changes the destination and nothing else about the panel", async () => {
    const h = createHarness({ attach: { returnTo: "score-admin" }, existingUsers: ["ana@example.com"] });
    await h.ready;
    expect(h.header().textContent).toBe("Log in / Create account"); // the default panel, with its chooser
    await openToMethod(h, "login");
    await sendEmail(h, "ana@example.com");
    expect(h.state.otpCalls).toEqual([{ email: "ana@example.com", options: { shouldCreateUser: false, emailRedirectTo: SCORE_ADMIN_RETURN } }]);
    h.close();
  });

  it("public pages are untouched: no destination is named, whether they log in or create an account", async () => {
    for (const attach of [undefined, {}, { accountEntry: "login-only" }, { accountLink: "/profile.html" }]) {
      const h = createHarness({ attach: attach as Record<string, unknown> | undefined, existingUsers: ["ana@example.com"] });
      await h.ready;
      h.header().click();
      await h.flush();
      if (h.q("[data-choose-login]")) await h.click("[data-choose-login]");
      await sendEmail(h, "ana@example.com");
      expect(h.state.otpCalls, JSON.stringify(attach)).toHaveLength(1);
      expect(Object.keys(h.state.otpCalls[0]!.options), JSON.stringify(attach)).not.toContain("emailRedirectTo");
      h.close();
    }
    const registering = createHarness();
    await openToMethod(registering, "register");
    await sendEmail(registering, "newcomer@example.com");
    expect(registering.state.otpCalls).toEqual([{ email: "newcomer@example.com", options: { shouldCreateUser: true } }]);
    registering.close();
    const legacy = createHarness();
    await legacy.ready;
    await legacy.auth.requestOtp("ana@example.com");
    expect(legacy.state.otpCalls).toEqual([{ email: "ana@example.com", options: { shouldCreateUser: true } }]);
    legacy.close();
  });

  it("only the key table is honoured: other keys, addresses, paths and look-alikes change nothing", async () => {
    const hostile: unknown[] = [
      "https://evil.example/steal", "//evil.example", "/predictions-admin.html", "https://gaming.urbanohn.com/predictions-admin.html",
      "SCORE-ADMIN", "score-admin ", " score-admin", "score_admin", "", "constructor", "__proto__", "toString", "hasOwnProperty", 42, true, {}, ["score-admin"], null,
    ];
    for (const returnTo of hostile) {
      const h = createHarness({ attach: { accountEntry: "login-only", returnTo } as Record<string, unknown>, existingUsers: ["boss@example.com"] });
      await openLoginOnly(h);
      await sendEmail(h, "boss@example.com");
      expect(h.state.otpCalls, JSON.stringify(returnTo)).toEqual([{ email: "boss@example.com", options: { shouldCreateUser: false } }]);
      h.close();
    }
  });

  it("the address bar decides nothing: ?next=, ?redirect_to= and a fragment are ignored, with or without the key", async () => {
    const url = "http://localhost/predictions-admin.html?next=https://evil.example/x&redirect_to=https://evil.example/y&returnTo=https://evil.example/z#next=https://evil.example/w";
    const without = createHarness({ url, attach: { accountEntry: "login-only" }, existingUsers: ["boss@example.com"] });
    await openLoginOnly(without);
    await sendEmail(without, "boss@example.com");
    expect(without.state.otpCalls).toEqual([{ email: "boss@example.com", options: { shouldCreateUser: false } }]);
    without.close();
    const withKey = createHarness({ url, attach: PORTAL_ENTRY, existingUsers: ["boss@example.com"] });
    await openLoginOnly(withKey);
    await sendEmail(withKey, "boss@example.com");
    expect(withKey.state.otpCalls).toEqual([{ email: "boss@example.com", options: { shouldCreateUser: false, emailRedirectTo: SCORE_ADMIN_RETURN } }]);
    expect(JSON.stringify(withKey.state.otpCalls)).not.toContain("evil.example");
    withKey.close();
  });

  it("only an email link has a destination: a phone code never carries one", async () => {
    const h = createHarness({ attach: PORTAL_ENTRY, authMethods: { email: true, phone: true } });
    await h.ready;
    await h.auth.requestCode({ channel: "phone", identifier: "+50499999999", mode: "login", returnTo: "score-admin" });
    expect(h.state.otpCalls).toEqual([{ phone: "+50499999999", options: { shouldCreateUser: false } }]);
    h.close();
  });

  it("the component source never reads the address bar for a destination, and holds the one address as a constant", () => {
    const source = readFileSync(path.join(process.cwd(), "public/urbanoAuth.js"), "utf8");
    const returnPart = source.slice(source.indexOf("SIGN_IN_RETURN_TARGETS = "), source.indexOf("const UrbanoAuth = (() => {"));
    expect(returnPart).toContain(SCORE_ADMIN_RETURN);
    expect(source.match(/emailRedirectTo/g)).toHaveLength(1); // one assignment, in requestCode, from the key table
    expect(source).not.toMatch(/searchParams|URLSearchParams\([^)]*(next|redirect|return)/i);
    expect(source.match(/https:\/\/gaming\.urbanohn\.com/g)).toHaveLength(1);
    const portal = readFileSync(path.join(process.cwd(), "public/predictions-admin.html"), "utf8");
    expect(portal).toContain('{ accountEntry: "login-only", returnTo: "score-admin" }');
    expect(portal).not.toMatch(/gaming\.urbanohn\.com|emailRedirectTo|redirect_to/); // the portal names a key, never an address
    for (const page of ["index.html", "soccer-predictions.html", "profile.html", "competitions.html", "become-a-host.html", "leaderboards.html", "rewards.html", "competitions-admin.html", "host-applications-admin.html"]) {
      expect(readFileSync(path.join(process.cwd(), "public", page), "utf8"), page).not.toContain("returnTo");
    }
  });
});
