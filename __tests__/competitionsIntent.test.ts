import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// public/*.html and public/*.js are raw, unbundled static assets with no
// import/bundler support (see urbanoAuth.js's own header comment), and
// this project's own package.json sets "type": "module" — so a plain
// require() of this file resolves inconsistently across Node/Vite's own
// CJS/ESM interop. Rather than fight that, this test executes the
// EXACT SAME script text the browser loads (via `<script src="/
// competitionsIntent.js">`, a classic, non-module script) inside a
// throwaway `new Function` wrapper — the identical execution the
// browser performs, just targeting `globalThis` instead of `window`
// (competitionsIntent.js's own IIFE already falls back to `globalThis`
// when `window` is undefined). This proves the real, deployed file,
// not a re-transpiled or reinterpreted copy of it.
const scriptSource = readFileSync("public/competitionsIntent.js", "utf-8");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function(scriptSource)();
const CompetitionsIntent = (globalThis as unknown as {
  CompetitionsIntent: {
    isValidCompetitionCode: (value: unknown) => boolean;
    isValidTeamCode: (value: unknown) => boolean;
    getIntentCompetitionCodeFromSearch: (search: string) => string | null;
    getIntentTeamCodeFromSearch: (search: string) => string | null;
    computeUrlWithIntent: (currentHref: string, competitionCode: string | null, teamCode: string | null) => string | null;
    computeUrlWithoutIntent: (currentHref: string) => string | null;
  };
}).CompetitionsIntent;

// Exactly the shape lib/gaming/competitions/publicCode.ts produces:
// randomBytes(16).toString("base64url") — 22 characters from
// [A-Za-z0-9_-], no padding.
const VALID_CODE = "AbCdEfGhIjKlMnOpQrStUg"; // 22 chars
const VALID_CODE_2 = "ZyXwVuTsRqPoNmLkJiHgFa"; // 22 chars
const VALID_UUID = "a447bc9f-dc56-4dc6-abcb-52f22da01f3c";

/**
 * URBANO Gaming Competitions — return-to-intent behavioral coverage
 * (UG-CR-GATE-031, revised under UG-CR-GATE-081 Phase 3A). This shell's
 * own sign-in flow is an in-page panel, never a redirect to a separate
 * page (urbanoAuth.js), so there is no cross-page storage handoff to
 * test — the whole "return-to-intent" surface reduces to: a strict
 * allowlist over two URL query parameters (opaque public_codes, never
 * raw ids), and the guarantee that restoring it never fetches or
 * mutates anything beyond the one authenticated GET the page would make
 * anyway. Both are covered here; the live authenticate-and-resume
 * sequence itself is covered by real-browser evidence, since there is
 * no DOM/browser environment in this test run.
 */
describe("CompetitionsIntent.isValidCompetitionCode / isValidTeamCode", () => {
  it("accepts a syntactically valid 22-character base64url public_code", () => {
    expect(CompetitionsIntent.isValidCompetitionCode(VALID_CODE)).toBe(true);
    expect(CompetitionsIntent.isValidTeamCode(VALID_CODE)).toBe(true);
  });

  it("rejects a raw UUID — the exact shape this gate removes from navigation", () => {
    expect(CompetitionsIntent.isValidCompetitionCode(VALID_UUID)).toBe(false);
    expect(CompetitionsIntent.isValidTeamCode(VALID_UUID)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["too short", "shortcode"],
    ["too long", VALID_CODE + "x"],
    ["contains a slash (path-injection shape)", "AbCdEfGhIjKlMnOpQrSt/g"],
    ["contains a dot (protocol/host-injection shape)", "AbCdEfGhIjKlMnOpQrSt.g"],
    ["a number", 12345],
    ["a plain object", {}],
  ])("rejects %s", (_label, value) => {
    expect(CompetitionsIntent.isValidCompetitionCode(value)).toBe(false);
    expect(CompetitionsIntent.isValidTeamCode(value)).toBe(false);
  });

  it("base64url's own + and / substitutes (- and _) are accepted — this is what makes the encoding URL-safe in the first place", () => {
    expect(CompetitionsIntent.isValidCompetitionCode("AbCdEfGhIjKlMnOpQrSt-_")).toBe(true);
  });
});

describe("CompetitionsIntent.getIntentCompetitionCodeFromSearch / getIntentTeamCodeFromSearch", () => {
  it("extracts a valid code from the `c` query parameter", () => {
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch(`?c=${VALID_CODE}`)).toBe(VALID_CODE);
  });

  it("extracts a valid code from the `t` query parameter", () => {
    expect(CompetitionsIntent.getIntentTeamCodeFromSearch(`?c=${VALID_CODE}&t=${VALID_CODE_2}`)).toBe(VALID_CODE_2);
  });

  it("returns null when the parameter is absent", () => {
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch("")).toBeNull();
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch("?other=1")).toBeNull();
    expect(CompetitionsIntent.getIntentTeamCodeFromSearch(`?c=${VALID_CODE}`)).toBeNull();
  });

  it("returns null for a legacy raw-UUID query value — the old `competitionId`/`teamId` shape is no longer accepted under the new `c`/`t` parameters either", () => {
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch(`?c=${VALID_UUID}`)).toBeNull();
  });

  it("returns null for a malformed search string rather than throwing", () => {
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch("not a query string %")).toBeNull();
  });

  it("never reads the old `competitionId`/`teamId` parameter names — a URL carrying only those legacy keys resolves to no intent at all", () => {
    expect(CompetitionsIntent.getIntentCompetitionCodeFromSearch(`?competitionId=${VALID_UUID}`)).toBeNull();
    expect(CompetitionsIntent.getIntentTeamCodeFromSearch(`?teamId=${VALID_UUID}`)).toBeNull();
  });
});

describe("CompetitionsIntent.computeUrlWithIntent", () => {
  it("sets the `c` parameter for a valid competition code", () => {
    const result = CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html", VALID_CODE, null);
    expect(result).toBe(`/competitions.html?c=${VALID_CODE}`);
  });

  it("sets both `c` and `t` together for an invitation", () => {
    const result = CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html", VALID_CODE, VALID_CODE_2);
    expect(result).toBe(`/competitions.html?c=${VALID_CODE}&t=${VALID_CODE_2}`);
  });

  it("clears an existing `t` when teamCode is null — the ordinary (non-invitation) detail view", () => {
    const result = CompetitionsIntent.computeUrlWithIntent(`https://example.com/competitions.html?c=${VALID_CODE}&t=${VALID_CODE_2}`, VALID_CODE, null);
    expect(result).toBe(`/competitions.html?c=${VALID_CODE}`);
  });

  it("returns null (no history entry needed) when the URL is already exactly current", () => {
    const result = CompetitionsIntent.computeUrlWithIntent(`https://example.com/competitions.html?c=${VALID_CODE}`, VALID_CODE, null);
    expect(result).toBeNull();
  });

  it("returns null for an invalid competitionCode — never writes a malformed or legacy-shaped value into the URL", () => {
    expect(CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html", VALID_UUID, null)).toBeNull();
    expect(CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html", "", null)).toBeNull();
  });

  it("returns null for an unparseable href rather than throwing", () => {
    expect(CompetitionsIntent.computeUrlWithIntent("not a url", VALID_CODE, null)).toBeNull();
  });

  it("silently drops an invalid teamCode while still setting a valid competitionCode", () => {
    const result = CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html", VALID_CODE, VALID_UUID);
    expect(result).toBe(`/competitions.html?c=${VALID_CODE}`);
  });

  it("preserves unrelated existing query parameters", () => {
    const result = CompetitionsIntent.computeUrlWithIntent("https://example.com/competitions.html?utm_source=x", VALID_CODE, null);
    expect(result).toBe(`/competitions.html?utm_source=x&c=${VALID_CODE}`);
  });
});

describe("CompetitionsIntent.computeUrlWithoutIntent", () => {
  it("removes both `c` and `t`", () => {
    const result = CompetitionsIntent.computeUrlWithoutIntent(`https://example.com/competitions.html?c=${VALID_CODE}&t=${VALID_CODE_2}`);
    expect(result).toBe("/competitions.html");
  });

  it("removes only `c` when `t` is absent", () => {
    const result = CompetitionsIntent.computeUrlWithoutIntent(`https://example.com/competitions.html?c=${VALID_CODE}`);
    expect(result).toBe("/competitions.html");
  });

  it("returns null when there is nothing to remove", () => {
    expect(CompetitionsIntent.computeUrlWithoutIntent("https://example.com/competitions.html")).toBeNull();
  });

  it("preserves unrelated existing query parameters", () => {
    const result = CompetitionsIntent.computeUrlWithoutIntent(`https://example.com/competitions.html?utm_source=x&c=${VALID_CODE}`);
    expect(result).toBe("/competitions.html?utm_source=x");
  });

  it("returns null for an unparseable href rather than throwing", () => {
    expect(CompetitionsIntent.computeUrlWithoutIntent("not a url")).toBeNull();
  });
});
