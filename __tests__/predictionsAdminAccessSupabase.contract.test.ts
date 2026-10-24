/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadEnv } from "vite";
import { JSDOM } from "jsdom";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { revokePlatformAuthority } from "../lib/gaming/authority/revokePlatformAuthority";
import { GET as accessGET } from "../app/api/gaming/predictions/admin/access/route";
import { GET as venuesGET, POST as venuesPOST } from "../app/api/gaming/predictions/admin/venues/route";
import { PATCH as classificationPATCH } from "../app/api/gaming/predictions/admin/matches/[matchId]/activity-classification/route";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * The Score administration access, against a real local Supabase: REAL Auth tokens (magic link + verifyOtp), REAL Postgres, the REAL
 * route handlers and the REAL authority functions. Nothing is stubbed. Writes only ever go to the local database the guard allows.
 *
 * What this proves that the in-memory suites cannot: a genuine Supabase Auth token resolves to the right member; a grant made and
 * revoked through the real atomic functions is what the next request sees; an identity with no Gaming Member is refused and never
 * given one; clients cannot call the grant/revoke/bootstrap functions; and the real Auth server — not a fake — honours
 * shouldCreateUser: false, which is what the login-only panel relies on.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");

const admin = createClient(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, serviceKey);

const createdAuthUserIds: string[] = [];
const createdMemberIds: string[] = [];
const createdVenueIds: string[] = [];

interface Person { authUserId: string; memberId: string | null; token: string }

async function signInToken(email: string): Promise<string> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  const verified = await admin.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  if (!verified.data.session) throw new Error("verifyOtp returned no session.");
  return verified.data.session.access_token;
}

async function createPerson(name: string, options: { member: boolean } = { member: true }): Promise<Person> {
  const email = `admin-access-${name}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create the test auth user.");
  createdAuthUserIds.push(data.user.id);
  let memberId: string | null = null;
  if (options.member) {
    const member = await gamingRepo.createGamingMember(data.user.id, `AdminAccess-${name}`);
    memberId = member.gamingMemberId;
    createdMemberIds.push(memberId);
  }
  return { authUserId: data.user.id, memberId, token: await signInToken(email) };
}

async function governanceActor(): Promise<string> {
  const { data: existing, error } = await admin.from("authority_grants").select("gaming_member_id").eq("authority_class", "PRODUCT_GOVERNANCE").is("revoked_at", null).limit(1).maybeSingle();
  if (error) throw error;
  if (existing) return existing.gaming_member_id as string;
  const founder = await createPerson("governance");
  await bootstrapGovernanceAuthority(authorityRepo, founder.memberId!, "Admin access contract: bootstrap.");
  return founder.memberId!;
}

const asRequest = (url: string, token: string | null, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });

const passes = (status: number) => status !== 401 && status !== 403;

beforeAll(() => {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
});

afterAll(async () => {
  if (createdVenueIds.length > 0) {
    await admin.from("venue_activations").delete().in("venue_id", createdVenueIds);
    await admin.from("venues").delete().in("venue_id", createdVenueIds);
  }
  if (createdMemberIds.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", createdMemberIds);
    await admin.from("authority_grants").delete().in("gaming_member_id", createdMemberIds);
  }
  for (const authUserId of createdAuthUserIds) await admin.auth.admin.deleteUser(authUserId);
});

describe("GET /admin/access with real Supabase Auth tokens and real grants", () => {
  it("answers each person with exactly what their grants say, and revocation is seen on the very next request", async () => {
    const governance = await governanceActor();
    const founder = await createPerson("founder");
    const operator = await createPerson("operator");
    const finalizer = await createPerson("finalizer");
    const participant = await createPerson("participant");
    for (const cls of ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] as const) {
      await grantPlatformAuthority(authorityRepo, governance, founder.memberId!, cls, "Admin access contract.");
    }
    await grantPlatformAuthority(authorityRepo, governance, operator.memberId!, "OPERATIONAL", "Admin access contract.");
    await grantPlatformAuthority(authorityRepo, governance, finalizer.memberId!, "CONSEQUENTIAL_FINALIZER", "Admin access contract.");

    const ask = (token: string | null) => accessGET(asRequest("http://localhost/api/gaming/predictions/admin/access", token));

    const f = await ask(founder.token);
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual({ access: true, classes: ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] });
    expect(f.headers.get("cache-control")).toBe("no-store");

    expect(await (await ask(operator.token)).json()).toEqual({ access: true, classes: ["OPERATIONAL"] });
    expect(await (await ask(finalizer.token)).json()).toEqual({ access: true, classes: ["CONSEQUENTIAL_FINALIZER"] });
    expect((await ask(participant.token)).status).toBe(403);
    expect((await ask(null)).status).toBe(401);
    expect((await ask("not-a-real-token")).status).toBe(401);

    await revokePlatformAuthority(authorityRepo, governance, operator.memberId!, "OPERATIONAL", "Admin access contract: revoke.");
    expect((await ask(operator.token)).status).toBe(403);
    // the founder is unaffected by someone else's revocation
    expect((await ask(founder.token)).status).toBe(200);
  }, 60000);

  it("an authenticated identity with NO Gaming Member is refused, and the call never creates one", async () => {
    const ghost = await createPerson("ghost", { member: false });
    const response = await accessGET(asRequest("http://localhost/api/gaming/predictions/admin/access", ghost.token));
    expect(response.status).toBe(401);
    const { data } = await admin.from("gaming_members").select("gaming_member_id").eq("auth_user_id", ghost.authUserId);
    expect(data ?? []).toEqual([]);
  }, 30000);
});

describe("the real routes, with real tokens: a refusal changes nothing, and each class opens only its own door", () => {
  it("a participant cannot create a venue (403) and no row appears; an operator can; classification needs the finalizer", async () => {
    const governance = await governanceActor();
    const participant = await createPerson("rt-participant");
    const operator = await createPerson("rt-operator");
    const finalizer = await createPerson("rt-finalizer");
    await grantPlatformAuthority(authorityRepo, governance, operator.memberId!, "OPERATIONAL", "Admin access contract.");
    await grantPlatformAuthority(authorityRepo, governance, finalizer.memberId!, "CONSEQUENTIAL_FINALIZER", "Admin access contract.");

    const name = `Access Contract ${randomUUID()}`;
    const body = JSON.stringify({ name, latitude: 10, longitude: 10, radiusMeters: 50 });

    const refused = await venuesPOST(asRequest("http://localhost/venues", participant.token, { method: "POST", body }));
    expect(refused.status).toBe(403);
    const { data: none } = await admin.from("venues").select("venue_id").eq("name", name);
    expect(none ?? []).toEqual([]);

    const wrongClass = await venuesPOST(asRequest("http://localhost/venues", finalizer.token, { method: "POST", body }));
    expect(wrongClass.status).toBe(403);

    const created = await venuesPOST(asRequest("http://localhost/venues", operator.token, { method: "POST", body }));
    expect(created.status).toBe(201);
    const venue = (await created.json()) as { venue: { venueId: string } };
    createdVenueIds.push(venue.venue.venueId);

    // reads accept any one administrative class
    for (const person of [operator, finalizer]) {
      const listed = await venuesGET(asRequest("http://localhost/venues", person.token));
      expect(listed.status).toBe(200);
    }
    expect((await venuesGET(asRequest("http://localhost/venues", participant.token))).status).toBe(403);

    const missingMatch = randomUUID();
    const params = { params: { matchId: missingMatch } };
    const classify = (token: string) => classificationPATCH(asRequest("http://localhost/x", token, { method: "PATCH", body: JSON.stringify({ activityClassification: "TRAINING" }) }), params);
    expect((await classify(operator.token)).status).toBe(403); // the operator is not the finalizer
    expect(passes((await classify(finalizer.token)).status)).toBe(true); // the finalizer is let in (the match does not exist: 404, not 403)
    expect((await classify(participant.token)).status).toBe(403);
  }, 60000);
});

describe("the database boundary: clients cannot grant, revoke or bootstrap authority", () => {
  it.skipIf(!anonKey)("a signed-in participant calling the authority functions directly is refused by the database", async () => {
    const participant = await createPerson("rpc-participant");
    const other = await createPerson("rpc-other");
    const client = createClient(supabaseUrl!, anonKey!, { global: { headers: { Authorization: `Bearer ${participant.token}` } }, auth: { persistSession: false } });

    const grant = await client.rpc("grant_platform_authority_atomically", {
      p_granting_gaming_member_id: participant.memberId,
      p_target_gaming_member_id: participant.memberId,
      p_authority_class: "OPERATIONAL",
      p_reason: "self grant attempt",
    });
    expect(grant.error).not.toBeNull();
    const bootstrap = await client.rpc("bootstrap_governance_authority_atomically", { p_gaming_member_id: participant.memberId, p_reason: "attempt" });
    expect(bootstrap.error).not.toBeNull();
    const revoke = await client.rpc("revoke_platform_authority_atomically", {
      p_revoking_gaming_member_id: participant.memberId,
      p_target_gaming_member_id: other.memberId,
      p_authority_class: "OPERATIONAL",
      p_reason: "attempt",
    });
    expect(revoke.error).not.toBeNull();

    expect(await authorityRepo.hasActiveAuthority(participant.memberId!, "OPERATIONAL")).toBe(false);
  }, 30000);
});

describe("the real Auth server honours shouldCreateUser: false — what the login-only panel depends on", () => {
  it.skipIf(!anonKey)("an unknown address cannot be turned into an account by a login-mode request; a register-mode request can (control)", async () => {
    const anon = createClient(supabaseUrl!, anonKey!, { auth: { persistSession: false } });
    const unknownLogin = `login-only-${randomUUID()}@example.com`;
    const refused = await anon.auth.signInWithOtp({ email: unknownLogin, options: { shouldCreateUser: false } });
    expect(refused.error).not.toBeNull();
    const afterLogin = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(afterLogin.data.users.some((user) => user.email === unknownLogin)).toBe(false);

    const unknownRegister = `register-${randomUUID()}@example.com`;
    const accepted = await anon.auth.signInWithOtp({ email: unknownRegister, options: { shouldCreateUser: true } });
    expect(accepted.error).toBeNull();
    const afterRegister = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const created = afterRegister.data.users.find((user) => user.email === unknownRegister);
    expect(created).toBeDefined();
    if (created) createdAuthUserIds.push(created.id);
  }, 30000);
});


// ---------------------------------------------------------------------------------------------------------------------------------
// End to end: the REAL page (public/predictions-admin.html), the REAL sign-in component (public/urbanoAuth.js), REAL Supabase Auth (the
// one-time code arrives in the local mail catcher), the REAL route handlers and REAL Postgres. Only the browser is jsdom, and `fetch`
// is a router that hands every /api/... request to the route module Next would have run.
// ---------------------------------------------------------------------------------------------------------------------------------

const MAILPIT = env.MAILPIT_URL || "http://127.0.0.1:54834";
const PAGE_HTML = readFileSync(path.join(process.cwd(), "public/predictions-admin.html"), "utf8");
const AUTH_JS = readFileSync(path.join(process.cwd(), "public/urbanoAuth.js"), "utf8");

const routeModules = import.meta.glob("../app/api/**/route.ts") as Record<string, () => Promise<Record<string, (request: Request, context: { params: Record<string, string> }) => Promise<Response>>>>;
const routeTable = Object.keys(routeModules).map((file) => {
  const pattern = file.replace("../app", "").replace(/\/route\.ts$/, "");
  const names: string[] = [];
  const regex = new RegExp("^" + pattern.replace(/\[([^\]]+)\]/g, (_m, name: string) => { names.push(name); return "([^/]+)"; }) + "$");
  return { regex, names, load: routeModules[file]! };
});

async function mailpitReachable(): Promise<boolean> {
  try { return (await fetch(`${MAILPIT}/api/v1/messages`)).ok; } catch { return false; }
}

async function oneTimeCodeFor(email: string, since: number): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listed = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as { messages?: Array<{ ID: string; Created: string }> };
    const fresh = (listed.messages ?? []).find((m) => new Date(m.Created).getTime() >= since - 2000);
    if (fresh) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)).json()) as { Text?: string };
      const match = /\b(\d{6})\b/.exec(detail.Text ?? "");
      if (match) return match[1]!;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the one-time code never reached the mail catcher");
}

async function openRealPortal() {
  const calls: Array<{ method: string; path: string; status: number }> = [];
  const dom = new JSDOM(PAGE_HTML.replace('<script src="/urbanoAuth.js"></script>', `<script>${AUTH_JS.replace(/<\/script>/g, "<\\/script>")}</script>`), {
    url: "http://localhost/predictions-admin.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.supabase = { createClient: (url: string, key: string, options: Record<string, unknown>) => createClient(url, key, options as never) };
      w.confirm = () => true;
      w.fetch = async (input: string, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        const method = (init.method || "GET").toUpperCase();
        let response: Response;
        if (url.pathname === "/api/gaming/config") {
          response = new Response(JSON.stringify({ supabaseUrl, supabaseAnonKey: anonKey }), { status: 200, headers: { "content-type": "application/json" } });
        } else {
          const hit = routeTable.map((r) => ({ r, m: r.regex.exec(url.pathname) })).find((x) => x.m);
          if (!hit) response = new Response(JSON.stringify({ error: "no such route" }), { status: 404 });
          else {
            const mod = await hit.r.load();
            const handler = mod[method];
            const params = Object.fromEntries(hit.r.names.map((name, i) => [name, hit.m![i + 1]!]));
            // jsdom's AbortSignal is not Node's: a real browser hands the real one to the real fetch, so it is simply left out here.
            const { signal: _signal, ...requestInit } = init as RequestInit & { signal?: unknown };
            void _signal;
            response = handler ? await handler(new Request(url.toString(), requestInit as RequestInit), { params }) : new Response("{}", { status: 405 });
          }
        }
        calls.push({ method, path: url.pathname, status: response.status });
        return response;
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const until = async (predicate: () => boolean, label: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 20));
      if (predicate()) return;
      if (Date.now() > deadline) {
        const panelText = (doc.querySelector("[data-urbano-signin-panel]")?.textContent ?? "").replace(/\s+/g, " ").trim();
        throw new Error("timed out waiting for " + label + " | gate: " + (doc.getElementById("gate-message")?.textContent ?? "") + " | panel: " + panelText);
      }
    }
  };
  const gate = () => (doc.getElementById("gate-message")?.textContent ?? "").trim();
  const sectionsVisible = () => (doc.getElementById("admin-sections") as HTMLElement).style.display !== "none";
  const drawn = (selector: string) => {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) return false;
    for (let node: HTMLElement | null = el; node && node !== doc.documentElement; node = node.parentElement) if (win.getComputedStyle(node).display === "none") return false;
    return true;
  };
  const panel = () => doc.querySelector("[data-urbano-signin-panel]") as HTMLElement;
  const typeInto = (selector: string, value: string) => {
    const input = panel().querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  // Opens the login-only panel (if it is closed), asks for a code for this address and waits for the code screen. Returns when it was asked.
  const sendCodeTo = async (email: string) => {
    // The server will not send a second code to the same address inside its per-user window, and creating the test member just
    // requested a link for it: a short pause keeps this journey honest instead of tripping that (correct) protection.
    await new Promise((r) => setTimeout(r, 1500));
    if (!panel() || panel().style.display !== "block") (doc.getElementById("btn-signin") as HTMLButtonElement).click();
    await until(() => !!panel().querySelector("[data-contact]"), "the email field");
    typeInto("[data-contact]", email);
    const asked = Date.now();
    (panel().querySelector("[data-send]") as HTMLButtonElement).click();
    await until(() => !!panel().querySelector("[data-code]"), "the code screen");
    return asked;
  };
  const enterCode = (code: string) => {
    typeInto("[data-code]", code);
    (panel().querySelector("[data-verify]") as HTMLButtonElement).click();
  };
  return { win, doc, calls, until, gate, sectionsVisible, drawn, panel, sendCodeTo, enterCode, close: () => dom.window.close() };
}

describe("end to end, real page + real sign-in + real Auth + real routes", () => {
  it.skipIf(!anonKey)("the whole journey: an unknown address, a participant, the administrator, and a class taken away while the screen is open", async () => {
    if (!(await mailpitReachable())) return; // the local mail catcher is part of `supabase start`; without it this journey cannot run
    const governance = await governanceActor();
    const participant = await createPerson("e2e-participant");
    const founder = await createPerson("e2e-founder");
    for (const cls of ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] as const) {
      await grantPlatformAuthority(authorityRepo, governance, founder.memberId!, cls, "Admin access end-to-end.");
    }
    const emailOf = async (person: Person) => (await admin.auth.admin.getUserById(person.authUserId)).data.user!.email!;
    const participantEmail = await emailOf(participant);
    const founderEmail = await emailOf(founder);

    const page = await openRealPortal();
    try {
      // 1. nobody is signed in: only the gate, and the panel can only log in
      await page.until(() => page.gate() === "Inicia sesión con una cuenta administrativa.", "the signed-out gate");
      expect(page.sectionsVisible()).toBe(false);
      expect(page.doc.getElementById("btn-signin")!.textContent).toBe("Sign in");

      // 2. an address nobody has an account for: it looks the same, and the REAL Auth server creates nothing
      const stranger = `e2e-stranger-${randomUUID()}@example.com`;
      await page.sendCodeTo(stranger);
      expect(page.panel().textContent).not.toMatch(/create (an )?account/i);
      const afterStranger = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      expect(afterStranger.data.users.some((user) => user.email === stranger)).toBe(false);
      (page.panel().querySelector("[data-change]") as HTMLButtonElement).click();

      // 3. a real participant signs in with a real code: signed in, but nothing administrative exists and nothing was requested
      const participantAsked = await page.sendCodeTo(participantEmail);
      page.enterCode(await oneTimeCodeFor(participantEmail, participantAsked));
      await page.until(() => page.gate() === "Esta cuenta no tiene acceso administrativo", "the no-access gate");
      expect(page.sectionsVisible()).toBe(false);
      expect(page.doc.querySelectorAll("#table-matches tbody tr").length).toBe(0);
      expect(page.calls.filter((c) => c.path.startsWith("/api/gaming/predictions/admin/") && !c.path.endsWith("/access"))).toEqual([]);
      expect(page.calls.find((c) => c.path.endsWith("/admin/access"))?.status).toBe(403);
      const participantMembers = await admin.from("gaming_members").select("gaming_member_id").eq("auth_user_id", participant.authUserId);
      expect((participantMembers.data ?? []).length).toBe(1); // exactly the member they already had: nothing was created

      // 4. «Usar otra cuenta»: the administrator signs in with a real code and the screen is built from the server's answer
      (page.doc.getElementById("btn-gate-switch") as HTMLButtonElement).click();
      await page.until(() => page.panel().style.display === "block" && !!page.panel().querySelector("[data-contact]"), "the login-only panel after switching");
      const founderAsked = await page.sendCodeTo(founderEmail);
      page.enterCode(await oneTimeCodeFor(founderEmail, founderAsked));
      await page.until(() => page.sectionsVisible(), "the administrator's screen");
      expect(page.doc.getElementById("authority-note")!.textContent).toContain("Authority on this account: OPERATIONAL, CONSEQUENTIAL_FINALIZER, PRODUCT_GOVERNANCE.");
      expect(page.drawn("#btn-create-team")).toBe(true);
      expect(page.drawn("#btn-finalize")).toBe(true);
      await page.until(() => page.calls.filter((c) => c.path === "/api/gaming/predictions/admin/matches" && c.status === 200).length > 0, "the real lists");
      const lists = page.calls.filter((c) => c.path.startsWith("/api/gaming/predictions/admin/") && !c.path.endsWith("/access"));
      expect(lists.every((c) => c.status === 200)).toBe(true);

      // 5. the finalizer class is taken away while the screen is open. The page's own request layer sends a real finalizer-only action,
      //    the REAL route refuses it, the page asks the server who this is, and the controls of the lost class go. Nothing is retried.
      await revokePlatformAuthority(authorityRepo, governance, founder.memberId!, "CONSEQUENTIAL_FINALIZER", "Admin access end-to-end: revoke.");
      const redeemPath = `/api/gaming/predictions/admin/qualifications/${randomUUID()}/redeem`;
      const refused = await page.win.authedFetch(redeemPath, { method: "POST" });
      expect(refused.status).toBe(403);
      await page.until(() => !page.drawn("#btn-finalize"), "the finalizer's controls leaving");
      expect(page.drawn("#btn-create-team")).toBe(true); // the operational half stays
      expect(page.doc.getElementById("authority-note")!.textContent).toContain("Authority on this account: OPERATIONAL, PRODUCT_GOVERNANCE.");
      expect(page.calls.filter((c) => c.method === "POST" && c.path === redeemPath)).toHaveLength(1); // sent once, never repeated
      expect(await authorityRepo.hasActiveAuthority(founder.memberId!, "OPERATIONAL")).toBe(true);
    } finally {
      page.close();
    }
  }, 120000);
});
