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
 * navigation intent this capability ever carries is a validated
 * UUID-shaped competitionId, and — added for the Branded Team
 * Registration and Invitation Journey (UG-CR-RPT-041/042 §8/§11) — an
 * equally-validated UUID-shaped teamId alongside it. Nothing else — no
 * arbitrary path, no external host, no protocol, no serialized action,
 * no authentication token, no role/authority claim — is ever treated as
 * a valid destination. teamId carries exactly the same non-authority
 * guarantee competitionId already had: it is possession of a navigation
 * hint, never a grant of membership, captaincy, or approval — every
 * actual authorization decision is re-verified server-side by whichever
 * route this intent eventually leads to.
 */
(function (root) {
  var UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /** Strict allowlist check: true only for a syntactically valid UUID string. Anything else (undefined, null, empty, a URL, a script/protocol string, a path, an overlong string) is rejected. */
  function isValidCompetitionId(value) {
    return typeof value === "string" && value.length === 36 && UUID_PATTERN.test(value);
  }

  /** Same shape as isValidCompetitionId — a distinct name only for readability at call sites; the validation rule (any syntactically valid UUID) is identical. */
  function isValidTeamId(value) {
    return typeof value === "string" && value.length === 36 && UUID_PATTERN.test(value);
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

  /** Same extraction/validation, for the teamId query parameter. */
  function getIntentTeamIdFromSearch(search) {
    var raw;
    try {
      raw = new URLSearchParams(search || "").get("teamId");
    } catch (err) {
      return null;
    }
    return isValidTeamId(raw) ? raw : null;
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

  /**
   * Reflects a server-CONFIRMED (competitionId, teamId) pair together —
   * an opened invitation always carries both, so both are set (or left
   * unchanged if already current) in one history entry rather than two.
   * teamId is optional: passing null/invalid clears it while still
   * setting competitionId, for the ordinary (non-invitation) detail view.
   */
  function computeUrlWithIntent(currentHref, competitionId, teamId) {
    if (!isValidCompetitionId(competitionId)) return null;
    var url;
    try {
      url = new URL(currentHref);
    } catch (err) {
      return null;
    }
    var changed = false;
    if (url.searchParams.get("competitionId") !== competitionId) {
      url.searchParams.set("competitionId", competitionId);
      changed = true;
    }
    if (isValidTeamId(teamId)) {
      if (url.searchParams.get("teamId") !== teamId) {
        url.searchParams.set("teamId", teamId);
        changed = true;
      }
    } else if (url.searchParams.has("teamId")) {
      url.searchParams.delete("teamId");
      changed = true;
    }
    return changed ? url.pathname + url.search : null;
  }

  /** Strips both competitionId and teamId intent from the URL. Returns null if there was nothing to remove. */
  function computeUrlWithoutIntent(currentHref) {
    var url;
    try {
      url = new URL(currentHref);
    } catch (err) {
      return null;
    }
    var changed = false;
    if (url.searchParams.has("competitionId")) { url.searchParams.delete("competitionId"); changed = true; }
    if (url.searchParams.has("teamId")) { url.searchParams.delete("teamId"); changed = true; }
    return changed ? url.pathname + url.search : null;
  }

  root.CompetitionsIntent = {
    isValidCompetitionId: isValidCompetitionId,
    isValidTeamId: isValidTeamId,
    getIntentCompetitionIdFromSearch: getIntentCompetitionIdFromSearch,
    getIntentTeamIdFromSearch: getIntentTeamIdFromSearch,
    computeUrlWithCompetitionId: computeUrlWithCompetitionId,
    computeUrlWithoutCompetitionId: computeUrlWithoutCompetitionId,
    computeUrlWithIntent: computeUrlWithIntent,
    computeUrlWithoutIntent: computeUrlWithoutIntent,
  };
})(typeof window !== "undefined" ? window : globalThis);
