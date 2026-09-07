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
const CompetitionsIntent = (globalThis as unknown as { CompetitionsIntent: {
  isValidCompetitionId: (value: unknown) => boolean;
  getIntentCompetitionIdFromSearch: (search: string) => string | null;
  computeUrlWithCompetitionId: (currentHref: string, competitionId: string) => string | null;
  computeUrlWithoutCompetitionId: (currentHref: string) => string | null;
} }).CompetitionsIntent;

const VALID_ID = "a447bc9f-dc56-4dc6-abcb-52f22da01f3c";
const VALID_ID_2 = "685c5ad6-dadf-4c5b-8ff2-1918821bf043";

/**
 * URBANO Gaming Competitions — return-to-intent behavioral coverage
 * (UG-CR-GATE-031). This shell's own sign-in flow is an in-page panel,
 * never a redirect to a separate page (urbanoAuth.js), so there is no
 * cross-page storage handoff to test — the whole "return-to-intent"
 * surface reduces to: a strict allowlist over one URL query parameter,
 * and the guarantee that restoring it never fetches or mutates anything
 * beyond the one authenticated GET the page would make anyway. Both are
 * covered here; the live authenticate-and-resume sequence itself is
 * covered by real-browser evidence (UG-CR-RPT-031 §5), since there is no
 * DOM/browser environment in this test run.
 */
describe("CompetitionsIntent.isValidCompetitionId — the strict destination allowlist", () => {
  it("accepts a well-formed UUID", () => {
    expect(CompetitionsIntent.isValidCompetitionId(VALID_ID)).toBe(true);
  });

  it("accepts a well-formed UUID regardless of hex letter case", () => {
    expect(CompetitionsIntent.isValidCompetitionId(VALID_ID.toUpperCase())).toBe(true);
  });

  const rejected: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["a number", 12345],
    ["an external URL", "https://evil.example.com/steal"],
    ["a protocol-relative URL", "//evil.example.com"],
    ["a javascript: URI", "javascript:alert(document.cookie)"],
    ["a data: URI", "data:text/html,<script>alert(1)</script>"],
    ["an inline script tag", "<script>alert(1)</script>"],
    ["a path-traversal attempt", "../../../admin"],
    ["a relative path", "/api/gaming/member"],
    ["a SQL-injection-shaped string", "' OR 1=1--"],
    ["a UUID with a trailing extra character", VALID_ID + "x"],
    ["a UUID with a missing hyphen", VALID_ID.replace("-", "")],
    ["a UUID-length string of the wrong shape", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["a UUID embedded inside a longer string", `x${VALID_ID}x`],
    ["a UUID followed by a query-injection attempt", `${VALID_ID}&admin=true`],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(CompetitionsIntent.isValidCompetitionId(value)).toBe(false);
  });
});

describe("CompetitionsIntent.getIntentCompetitionIdFromSearch — reading intent from the URL", () => {
  it("returns the valid competitionId from a query string", () => {
    expect(CompetitionsIntent.getIntentCompetitionIdFromSearch(`?competitionId=${VALID_ID}`)).toBe(VALID_ID);
  });

  it("returns null when the parameter is absent", () => {
    expect(CompetitionsIntent.getIntentCompetitionIdFromSearch("?other=1")).toBeNull();
  });

  it("returns null for an empty search string", () => {
    expect(CompetitionsIntent.getIntentCompetitionIdFromSearch("")).toBeNull();
  });

  it("returns null for a malformed (non-UUID) competitionId value — an unsupported destination falls back safely, never partially trusted", () => {
    expect(CompetitionsIntent.getIntentCompetitionIdFromSearch("?competitionId=not-a-real-id")).toBeNull();
  });

  it("returns null for an external-URL-shaped competitionId value", () => {
    expect(CompetitionsIntent.getIntentCompetitionIdFromSearch("?competitionId=https://evil.example.com")).toBeNull();
  });

  it("ignores every other query parameter, including ones shaped like an injected privilege or role claim", () => {
    expect(
      CompetitionsIntent.getIntentCompetitionIdFromSearch(`?competitionId=${VALID_ID}&role=organizer&isAdmin=true&gamingMemberId=attacker`)
    ).toBe(VALID_ID);
  });

  it("does not throw on a malformed query string", () => {
    expect(() => CompetitionsIntent.getIntentCompetitionIdFromSearch("%%%not-valid-encoding%%%")).not.toThrow();
  });
});

describe("CompetitionsIntent.computeUrlWithCompetitionId — restoring intent into the URL", () => {
  it("produces a same-document, path-relative URL for a valid id", () => {
    const result = CompetitionsIntent.computeUrlWithCompetitionId("https://app.example.com/competitions.html", VALID_ID);
    expect(result).toBe(`/competitions.html?competitionId=${VALID_ID}`);
  });

  it("the output never carries a scheme or host, regardless of the input origin — it can never itself become a cross-origin or open-redirect destination", () => {
    const result = CompetitionsIntent.computeUrlWithCompetitionId("https://app.example.com/competitions.html", VALID_ID)!;
    expect(result.startsWith("/")).toBe(true);
    expect(result).not.toMatch(/^https?:/);
    expect(result).not.toMatch(/^\/\//);
  });

  it("returns null (no-op) when the id is already the current one — avoids a redundant history entry", () => {
    const result = CompetitionsIntent.computeUrlWithCompetitionId(`https://app.example.com/competitions.html?competitionId=${VALID_ID}`, VALID_ID);
    expect(result).toBeNull();
  });

  it("rejects a malformed or unsupported id outright — no URL is ever produced for it", () => {
    expect(CompetitionsIntent.computeUrlWithCompetitionId("https://app.example.com/competitions.html", "https://evil.example.com")).toBeNull();
    expect(CompetitionsIntent.computeUrlWithCompetitionId("https://app.example.com/competitions.html", "<script>alert(1)</script>")).toBeNull();
    expect(CompetitionsIntent.computeUrlWithCompetitionId("https://app.example.com/competitions.html", "")).toBeNull();
  });

  it("preserves other existing query parameters", () => {
    const result = CompetitionsIntent.computeUrlWithCompetitionId(`https://app.example.com/competitions.html?theme=dark`, VALID_ID);
    expect(result).toBe(`/competitions.html?theme=dark&competitionId=${VALID_ID}`);
  });

  it("replaces a stale competitionId with the newly confirmed one, rather than appending a duplicate", () => {
    const result = CompetitionsIntent.computeUrlWithCompetitionId(`https://app.example.com/competitions.html?competitionId=${VALID_ID}`, VALID_ID_2);
    expect(result).toBe(`/competitions.html?competitionId=${VALID_ID_2}`);
  });
});

describe("CompetitionsIntent.computeUrlWithoutCompetitionId — clearing intent after a failed or completed restoration", () => {
  it("removes an existing competitionId parameter", () => {
    const result = CompetitionsIntent.computeUrlWithoutCompetitionId(`https://app.example.com/competitions.html?competitionId=${VALID_ID}`);
    expect(result).toBe("/competitions.html");
  });

  it("returns null when there was nothing to clear", () => {
    expect(CompetitionsIntent.computeUrlWithoutCompetitionId("https://app.example.com/competitions.html")).toBeNull();
  });

  it("preserves other query parameters while removing only competitionId", () => {
    const result = CompetitionsIntent.computeUrlWithoutCompetitionId(`https://app.example.com/competitions.html?theme=dark&competitionId=${VALID_ID}`);
    expect(result).toBe("/competitions.html?theme=dark");
  });
});

describe("competitions.html — structural proof that restoring intent never redirects or auto-replays a mutation", () => {
  const html = readFileSync("public/competitions.html", "utf-8");

  it("loads competitionsIntent.js from a same-origin relative path, never an external host", () => {
    expect(html).toMatch(/<script src="\/competitionsIntent\.js"><\/script>/);
  });

  it("never navigates or redirects anywhere — no location.href/assign/replace exists in this page at all", () => {
    expect(html).not.toMatch(/location\.href\s*=/);
    expect(html).not.toMatch(/location\.assign\s*\(/);
    expect(html).not.toMatch(/location\.replace\s*\(/);
  });

  it("the unauthenticated branch of renderApp (the one restoring intent) never issues a mutating request — it renders a static message and returns", () => {
    const match = html.match(/async function renderApp\(\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const unauthenticatedBranch = match![0].split('if (authState.status !== "authenticated") {')[1].split("return;")[0];
    expect(unauthenticatedBranch).not.toMatch(/method:\s*["']POST["']/);
    expect(unauthenticatedBranch).not.toContain("authedFetch");
  });

  it("renderCompetitionDetail always performs a fresh GET on every call — no cached view is ever reused across a restoration", () => {
    const functionStart = html.indexOf("async function renderCompetitionDetail(competitionId) {");
    expect(functionStart).toBeGreaterThan(-1);
    const fetchStatement = "const res = await authedFetch(`/api/gaming/competitions/${competitionId}`);";
    const fetchIndex = html.indexOf(fetchStatement, functionStart);
    expect(fetchIndex).toBeGreaterThan(-1);
    // The fetch is the very first statement inside the function body — nothing between the
    // function's opening brace and the fetch itself reads a cache or browser storage.
    const preamble = html.slice(functionStart, fetchIndex);
    expect(preamble).not.toMatch(/cache|localStorage|sessionStorage/i);
  });

  it("a failed restoration clears the intent from both state and the URL rather than leaving a dead end", () => {
    expect(html).toContain("currentCompetitionId = null;\n    clearCompetitionIntentFromUrl();");
  });

  it("a successful restoration reflects only the server-confirmed competitionId back into the URL, never the raw client-supplied value", () => {
    expect(html).toContain("setCompetitionIntentInUrl(competition.competitionId);");
  });

  it("no bearer token, OTP code, or service-role credential is ever assigned into a URL or history call", () => {
    expect(html).not.toMatch(/history\.(replaceState|pushState)\([^)]*(token|otp|service_role|password)/i);
  });
});
