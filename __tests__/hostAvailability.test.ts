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
 *
 * Update of 2026-10-31 (Founder direction: the Home shows four experiences): the Home no longer carries the Become a Host card, so the tests that loaded the
 * Home to prove that card fails closed (and their negative controls) were retired with it; they are in git history at 98bb902, and the old Home is kept in
 * archive/home.score-card-2026-10-29.html. The same fail-closed matrix (flag absent, `false`, malformed, exact `true`, endpoint failure, timeout, malformed
 * answer, reader missing, nothing actionable before the answer, no environment value in the browser) and its negative controls are proven on the shared
 * reader by __tests__/hostDirectPageReadiness.test.ts, against the page that still ships (public/become-a-host.html). What stays here: the server's
 * bounded answer, and the pinned 320 px header rules (now in public/experience.css).
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
const ROUTE_SOURCE = readFileSync(path.join(process.cwd(), "app/api/gaming/host/availability/route.ts"), "utf8");
// The ONE browser-side reader of the server's answer, shared by the landing card and the application page (UG-CR-GATE-091).
const READER_SOURCE = readFileSync(path.join(process.cwd(), "public/hostAvailability.js"), "utf8");
// The shared language module the landing page loads. Most tests in this file assert the English wording, so the page is loaded in English;
// Spanish-by-default and the language switch are covered by __tests__/shellPublic.test.ts.
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");

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

// ---------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-091 Correction D — the 320 px landing header. jsdom does not lay anything out, so these pin the RULES that produce the
// measured result (real-browser numbers at 320 / 375 / 768 / 1280 px are in UG-CR-RPT-091); the rules are what must not silently regress.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("landing header — the 320 px overflow fix is pinned", () => {
  const css = readFileSync(path.join(process.cwd(), "public/experience.css"), "utf8"); // the shell rules moved, unchanged, from the Home's <style> into the stylesheet the five pages share
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

  it("the header wraps BY DESIGN (it now holds the brand, the language selector and the account group): on phones row 1 is the brand and the selector, row 2 is the account group alone", () => {
    // Before the shell work the header held two items and was pinned as never wrapping at 375 px and wider. It now holds more, so the wrap
    // is part of the layout: it can never push the page sideways, and on a phone the account group takes its own full-width row so a real name has room.
    expect(rule(".shell-header")).toMatch(/flex-wrap:\s*wrap/);
    expect(media("max-width: 640px")).toMatch(/\.header-tools\s*\{[^}]*display:\s*contents/);
    expect(media("max-width: 640px")).toMatch(/\.account-group\s*\{[^}]*flex:\s*1 1 100%/); // the account group takes the second row alone
    expect(rule(".header-tools")).toMatch(/min-width:\s*0/);
  });

  it("the account group keeps name and Sign out together on the right, and only an extreme name is truncated (ellipsis), never wrapped", () => {
    expect(rule(".account-group")).toMatch(/justify-content:\s*flex-end/);
    expect(rule(".account-group .signin-btn")).toMatch(/min-width:\s*0/);
    expect(rule(".account-group [data-urbano-signout]")).toMatch(/white-space:\s*nowrap/);
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
