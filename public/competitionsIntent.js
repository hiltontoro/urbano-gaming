/**
 * URBANO Gaming Competitions — return-to-intent pure logic (UG-CR-
 * GATE-031). Deliberately factored out of competitions.html's own inline
 * script so it can be unit-tested directly (public/*.html pages have no
 * bundler/import support and are never otherwise importable by a test —
 * see urbanoAuth.js's own header comment) rather than duplicated as two
 * silently-driftable copies. Every function here is pure: no `window`,
 * no fetch, no mutation, no browser storage. The one caller,
 * competitions.html, supplies the real `location.href`/`location.search`
 * strings in and applies the returned string via `history.replaceState`
 * itself — the thinnest possible DOM-touching wrapper around logic that
 * is otherwise plain string/regex validation.
 *
 * Loaded as a plain classic (non-module) script — this project's own
 * package.json sets "type": "module", which makes a CommonJS
 * module.exports branch here resolve inconsistently under Node/Vite's
 * require() interop; __tests__/competitionsIntent.test.ts instead
 * executes this exact file's source text directly (the same thing the
 * browser does), reading the result off `globalThis.CompetitionsIntent`
 * — this IIFE's own fallback when `window` is undefined.
 *
 * The accepted allowlist is intentionally narrow: the ONLY Competitions
 * navigation intent this capability ever carries is one validated
 * UUID-shaped competitionId. Nothing else — no arbitrary path, no
 * external host, no protocol, no serialized action — is ever treated as
 * a valid destination.
 */
(function (root) {
  var COMPETITION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /** Strict allowlist check: true only for a syntactically valid UUID string. Anything else (undefined, null, empty, a URL, a script/protocol string, a path, an overlong string) is rejected. */
  function isValidCompetitionId(value) {
    return typeof value === "string" && value.length === 36 && COMPETITION_ID_PATTERN.test(value);
  }

  /**
   * Extracts and validates the competitionId intent from a URL's own
   * query string (e.g. `location.search`, `"?competitionId=...&x=1"`).
   * Returns the validated id, or null for anything missing, malformed,
   * or of the wrong shape — there is no partial-trust outcome.
   */
  function getIntentCompetitionIdFromSearch(search) {
    var raw;
    try {
      raw = new URLSearchParams(search || "").get("competitionId");
    } catch (err) {
      return null;
    }
    return isValidCompetitionId(raw) ? raw : null;
  }

  /**
   * Given the current full URL and a server-CONFIRMED competitionId,
   * returns the new relative URL (pathname + search) with that id
   * reflected as the ?competitionId= query parameter — or null if no
   * change is needed (already current) or the id fails validation. The
   * caller applies this via history.replaceState; this function never
   * touches history/location itself, so it has nothing to do with
   * navigation, redirection, or any cross-origin destination — the
   * output is always same-document, same-origin, path-relative.
   */
  function computeUrlWithCompetitionId(currentHref, competitionId) {
    if (!isValidCompetitionId(competitionId)) return null;
    var url;
    try {
      url = new URL(currentHref);
    } catch (err) {
      return null;
    }
    if (url.searchParams.get("competitionId") === competitionId) return null;
    url.searchParams.set("competitionId", competitionId);
    return url.pathname + url.search;
  }

  /** The inverse of computeUrlWithCompetitionId: strips any competitionId intent from the URL. Returns null if there was nothing to remove. */
  function computeUrlWithoutCompetitionId(currentHref) {
    var url;
    try {
      url = new URL(currentHref);
    } catch (err) {
      return null;
    }
    if (!url.searchParams.has("competitionId")) return null;
    url.searchParams.delete("competitionId");
    return url.pathname + url.search;
  }

  root.CompetitionsIntent = {
    isValidCompetitionId: isValidCompetitionId,
    getIntentCompetitionIdFromSearch: getIntentCompetitionIdFromSearch,
    computeUrlWithCompetitionId: computeUrlWithCompetitionId,
    computeUrlWithoutCompetitionId: computeUrlWithoutCompetitionId,
  };
})(typeof window !== "undefined" ? window : globalThis);
