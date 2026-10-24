// URBANO Gaming — Application Shell authentication seam.
//
// URBANO Gaming Identity Foundation: this is now the real, canonical
// browser-facing Auth adapter — no page should ever call Supabase Auth
// directly. Responsibilities: initialize the browser Supabase client,
// expose getState/requestOtp/verifyOtp/completeProfile/signOut/
// getAccessToken/onAuthStateChange, and resolve the Gaming Member
// profile through this app's own API (GET/POST /api/gaming/member),
// never directly against the gaming_members table from the browser.
//
// public/*.html pages are raw, unbundled static assets with no
// import/bundler support, so the Supabase client library itself is
// loaded from a CDN UMD build at runtime (window.supabase.createClient),
// not via npm import — and the browser-safe project URL/anon key are
// fetched once from GET /api/gaming/config rather than assumed to be
// available as a Next.js NEXT_PUBLIC_* build-time variable (this repo
// has no next.config.js/bundler step that could ever inline one into a
// static HTML file — see that route's own comment).
//
// Persistence is Supabase Auth's normal browser session (localStorage-
// backed), deliberately explicit here — intentionally different from,
// and never merged with, the existing per-tab Participant/host
// sessionStorage pattern used elsewhere in this shell (see
// participant.html's own comment on why that one deliberately does NOT
// use localStorage). Gaming Member sign-in survives refresh, browser
// reopen, and multiple tabs; a Participant/host token does not, by
// design, on both sides.
//
// Account entry (Enter URBANO -> Log in / Create account -> Email / Phone
// -> Verify -> continue the intended action): Log in never creates an
// account; Create account verifies control of the email or phone number
// before the Gaming Member is created; email and phone are alternative
// methods (neither journey asks for both). A method is offered as
// available only when /api/gaming/auth-methods reports its backend as
// configured — phone defaults to NOT available. Pages that must react to
// signing in/out or to a different person (not to every token refresh)
// use onIdentityChange; onAuthStateChange keeps its original meaning.
//
// Only the anon key is ever used in this file — never service_role.
//
// Language: every user-facing string goes through urbanoAuthText(key, englishFallback, vars). When a page loads /urbanoI18n.js the
// text follows the page's chosen language (Spanish by default); on a page that does not load it (for example the administrative
// portal) the English fallback below is used, exactly as before. Results returned to callers keep their English `message` meaning and
// gain an additive `messageKey` (+ `messageVars`) so a caller can re-translate them.
//
// Sign-in link problems: when Auth sends a person back with an error (an invalid, used or expired link) the error is read from the
// address bar ONCE, the Auth return data is removed from the bar, a clear message with an explicit "request a new code" action is
// shown, and nothing is ever sent automatically. Only a sanitized error code is kept in memory; tokens are never read, stored or logged.

function urbanoAuthText(key, fallback, vars) {
  const i18n = typeof window !== "undefined" ? window.UrbanoI18n : undefined;
  if (i18n && typeof i18n.has === "function" && i18n.has(key)) return i18n.t(key, vars);
  return String(fallback).replace(/\{(\w+)\}/g, (whole, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

// ---- fixed sign-in return destinations ---------------------------------------------------------------------------------------------
// The link in a sign-in email returns the person to the Auth service's Site URL (the Home page) unless the request names a destination.
// A page may ask for one of these FIXED destinations by KEY. The address is never built from the address bar, from a query string such
// as ?next=, or from any value a caller supplies, and the Site URL itself is not changed. Auth only honours a destination that is also
// on the project's Redirect URLs list; otherwise it falls back to the Site URL, which is exactly what every page that asks for no
// destination gets today. Only the Score administration portal asks for one.
const SIGN_IN_RETURN_TARGETS = Object.freeze({
  "score-admin": "https://gaming.urbanohn.com/predictions-admin.html",
});

function signInReturnUrl(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(SIGN_IN_RETURN_TARGETS, key) ? SIGN_IN_RETURN_TARGETS[key] : null;
}

const UrbanoAuth = (() => {
  const SUPABASE_JS_CDN_URL =
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  const INTENT_KEY = "urbano.auth.intent";
  const INTENT_MAX_AGE_MS = 30 * 60 * 1000;

  let clientPromise = null;

  // The Gaming Member of the person who is signed in NOW, and of nobody else. A lookup (finished or still in flight) belongs to ONE
  // authenticated person for life: it is keyed by that person's Auth user id, it is created synchronously and never reassigned
  // after an `await`, and a read only ever combines a session with the lookup made for that same user id. So an answer that arrives
  // late (another person signed in meanwhile, or the session ended) can only settle the promise of the person it was asked for and
  // can never be mistaken for the member of whoever is signed in now. { userId, promise, abort, settled } or null.
  let memberEntry = null;
  // Every lookup still in flight, wherever the stored entry points now, so work for a person who is gone can always be cancelled.
  const memberLookups = new Set();
  // A read that finds the signed-in person changed while it was waiting starts again; this bounds that (it only happens if the
  // person changes again and again during every single attempt).
  const MAX_IDENTITY_ATTEMPTS = 4;

  let authChangeCallbacks = [];
  let identityCallbacks = [];
  let identityResetCallbacks = [];
  let lastIdentityKey = null;
  let publishSequence = 0;
  // Who the pages were last told about (undefined until the first Auth event of the page load), and whether the pages have been told
  // that the person changed and are still owed the new state (so a change that ends on the same person is still reported).
  let announcedUserId;
  let resetOwed = false;

  // Which entry methods the deployment DECLARES, as reported by
  // GET /api/gaming/auth-methods. A declaration is not evidence of delivery:
  // nothing here knows whether a code will arrive, so no screen may promise
  // one. Unknown means unavailable for phone: a method nobody has switched on
  // is never offered.
  let authMethods = { email: true, phone: false };

  // Registered by the sign-in panel so a page can open it with an intent.
  let signInOpener = null;
  let memoryIntent = null;

  // ---- sign-in link return data (address bar) -------------------------
  // After a person opens the link in an email, Supabase Auth returns them to the site with either a session (implicit flow: tokens
  // in the address-bar fragment, read by the Supabase client itself) or an error (an invalid, used or expired link). Both are
  // Auth return data and none of it should stay in the address bar. Tokens are never read here: the client reads them, and this
  // code only removes what is left once it has finished. Only an error code, sanitized to lowercase letters, digits and
  // underscores, is ever kept (in memory, for the message).
  const AUTH_RETURN_PARAMS = [
    "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type",
    "provider_token", "provider_refresh_token", "error", "error_code", "error_description", "sb",
  ];
  const AUTH_ERROR_PARAMS = ["error", "error_code", "error_description"];
  let linkErrorRead = false;
  let pendingLinkError = null; // { code } or null

  function splitParams(text) {
    return String(text || "").replace(/^[#?]/, "").split("&").filter((piece) => piece !== "");
  }

  function paramName(piece) {
    const raw = piece.split("=")[0];
    try {
      return decodeURIComponent(raw.replace(/\+/g, " "));
    } catch (err) {
      return raw;
    }
  }

  function paramValue(piece) {
    const at = piece.indexOf("=");
    if (at < 0) return "";
    try {
      return decodeURIComponent(piece.slice(at + 1).replace(/\+/g, " "));
    } catch (err) {
      return "";
    }
  }

  // Removes the named parameters from the fragment (hashNames) and from the query string (queryNames), keeping every other character
  // of the address (path, other query values, an in-page anchor such as #play) exactly as it was. The query list is deliberately
  // short: a generic name such as "type" may belong to the page itself, so only Auth's own error parameters are removed there.
  function stripAddressParams(hashNames, queryNames) {
    try {
      const loc = window.location;
      const hashPieces = splitParams(loc.hash);
      const searchPieces = splitParams(loc.search);
      // Only an address that actually carries Auth return data is touched: a session (tokens) or an Auth error. A fragment or query that
      // merely happens to contain one of these generic names is the page's own business and is left exactly as it is.
      const hashIsAuthReturn = hashPieces.some((piece) => ["access_token", "refresh_token", "error", "error_code"].includes(paramName(piece)));
      const queryIsAuthReturn = searchPieces.some((piece) => paramName(piece) === "error_code");
      const keepHash = hashIsAuthReturn ? hashPieces.filter((piece) => !hashNames.includes(paramName(piece))) : hashPieces;
      const keepSearch = queryIsAuthReturn ? searchPieces.filter((piece) => !queryNames.includes(paramName(piece))) : searchPieces;
      if (keepHash.length === hashPieces.length && keepSearch.length === searchPieces.length) return;
      const next = loc.pathname + (keepSearch.length ? "?" + keepSearch.join("&") : "") + (keepHash.length ? "#" + keepHash.join("&") : "");
      window.history.replaceState(window.history.state, "", next);
    } catch (err) {
      /* history unavailable: leave the address as it is */
    }
  }

  // Reads (once per page load) whether Auth sent the person back with an error, then removes the error data from the address bar.
  function readLinkErrorOnce() {
    if (linkErrorRead) return pendingLinkError;
    linkErrorRead = true;
    try {
      const hashPieces = splitParams(window.location.hash);
      const searchPieces = splitParams(window.location.search);
      const hashHasError = hashPieces.some((piece) => ["error", "error_code"].includes(paramName(piece)));
      const queryHasError = searchPieces.some((piece) => paramName(piece) === "error_code");
      if (hashHasError || queryHasError) {
        const source = hashHasError ? hashPieces : searchPieces;
        const codePiece = source.find((piece) => paramName(piece) === "error_code");
        const code = codePiece ? paramValue(codePiece).toLowerCase() : "";
        pendingLinkError = { code: /^[a-z0-9_]{1,64}$/.test(code) ? code : "unknown" };
        stripAddressParams(AUTH_ERROR_PARAMS, AUTH_ERROR_PARAMS);
      }
    } catch (err) {
      pendingLinkError = null;
    }
    return pendingLinkError;
  }

  function loadSupabaseScript() {
    if (window.supabase && window.supabase.createClient) {
      return Promise.resolve();
    }

    const existing = document.querySelector(
      `script[src="${SUPABASE_JS_CDN_URL}"]`
    );
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () =>
          reject(new Error("Failed to load the Supabase client library."))
        );
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SUPABASE_JS_CDN_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load the Supabase client library."));
      document.head.appendChild(script);
    });
  }

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const configResponse = await fetch("/api/gaming/config");
        if (!configResponse.ok) {
          throw new Error("Failed to load browser Supabase configuration.");
        }
        const config = await configResponse.json();

        // Which entry methods the deployment declares. Best effort and
        // fail-closed: if this cannot be read, phone stays unavailable.
        try {
          const methodsResponse = await fetch("/api/gaming/auth-methods");
          if (methodsResponse.ok) {
            const methods = await methodsResponse.json();
            authMethods = {
              email: methods.email !== false,
              phone: methods.phone === true,
            };
          }
        } catch (err) {
          /* keep the defaults: email available, phone not */
        }

        await loadSupabaseScript();

        const client = window.supabase.createClient(
          config.supabaseUrl,
          config.supabaseAnonKey,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              storage: window.localStorage,
            },
          }
        );

        client.auth.onAuthStateChange((_event, session) => {
          // Every Auth event forgets the stored lookup (a fresh sign-in / sign-out always re-resolves). When the person is no longer
          // the one the lookup was for (a different person, or nobody), the lookup still in flight is cancelled too.
          dropMember(userIdOf(session));
          announceIdentity(userIdOf(session));
          authChangeCallbacks.forEach((callback) => {
            try {
              callback();
            } catch (err) {
              console.error(
                "UrbanoAuth: onAuthStateChange listener failed:",
                err
              );
            }
          });
          // Fire-and-forget: awaiting other Supabase calls inside this
          // listener can deadlock the client's own lock.
          publishIdentity();
        });

        // By the time getSession() settles, the client has finished reading any sign-in return data from the address bar. Remove
        // whatever Auth left there, so a person's tokens do not stay in the address bar, the history or a shared screenshot. This
        // runs outside the listener above (no lock is held) and a failure here never affects sign-in.
        if (client.auth && typeof client.auth.getSession === "function") {
          Promise.resolve(client.auth.getSession())
            .then(() => stripAddressParams(AUTH_RETURN_PARAMS, AUTH_ERROR_PARAMS))
            .catch(() => {});
        }

        return client;
      })();
    }
    return clientPromise;
  }

  async function fetchGamingMemberProfile(accessToken, signal) {
    const response = await fetch("/api/gaming/member", {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.gamingMember ?? null;
  }

  // The Auth user id of a session, or null. A session with no user id has no identity a member can be bound to, so it is treated as
  // no session at all (fail closed) rather than guessed at.
  function userIdOf(session) {
    const id = session && session.user && session.user.id;
    return typeof id === "string" && id !== "" ? id : null;
  }

  // What an Auth event does to the stored lookups. A FINISHED lookup is forgotten (a fresh sign-in or sign-out always re-resolves, as
  // before); one still in flight for the same person is kept, because asking again would only duplicate the request. Every lookup in
  // flight for a person other than `currentUserId` (a different person, or null = nobody) is cancelled: its answer is no longer wanted.
  function dropMember(currentUserId) {
    if (memberEntry && (memberEntry.settled || memberEntry.userId !== currentUserId)) memberEntry = null;
    memberLookups.forEach((lookup) => {
      if (lookup.userId !== currentUserId && typeof lookup.abort === "function") lookup.abort();
    });
  }

  // Tells pages, synchronously and before anything is looked up, that the signed-in person is no longer the one they were showing
  // (a different person, or nobody): the moment to drop whatever belonged to the previous person. Token refreshes and repeated
  // events for the same person are not changes.
  function announceIdentity(userId) {
    if (announcedUserId === undefined) {
      announcedUserId = userId; // the first event of the page load: nothing was shown for anyone else yet
      return;
    }
    if (userId === announcedUserId) return;
    announcedUserId = userId;
    resetOwed = true;
    identityResetCallbacks.slice().forEach((callback) => {
      try {
        callback({ userId });
      } catch (err) {
        console.error("UrbanoAuth: onIdentityReset listener failed:", err);
      }
    });
  }

  // The member lookup for this session's person (see memberEntry). Never cached on failure.
  function memberFor(session) {
    const userId = userIdOf(session);
    if (memberEntry && memberEntry.userId === userId) return memberEntry.promise;
    if (memberEntry) dropMember(userId);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const entry = { userId, promise: null, abort: controller ? () => controller.abort() : null, settled: false };
    entry.promise = fetchGamingMemberProfile(session.access_token, controller ? controller.signal : undefined).then(
      (member) => {
        entry.settled = true;
        memberLookups.delete(entry);
        return member;
      },
      (err) => {
        entry.settled = true;
        memberLookups.delete(entry);
        if (memberEntry === entry) memberEntry = null;
        throw err;
      }
    );
    entry.promise.catch(() => {}); // callers that are still waiting see the failure; one nobody waits for any more is not an unhandled error
    memberEntry = entry;
    memberLookups.add(entry);
    return entry.promise;
  }

  // Is `userId` still the person the Auth client says is signed in? (The authoritative check after any wait.)
  async function stillSignedInAs(client, userId) {
    const { data } = await client.auth.getSession();
    return userIdOf(data && data.session) === userId;
  }

  // ONE consistent read of "who is signed in and who is their member": { session, member } of the same person, or { session: null }.
  // If the person changes while the member is being looked up (another person signed in, or the session ended) the answer is
  // discarded and the read starts again for whoever is signed in now, so no caller is ever handed the previous person's data.
  async function resolveIdentity() {
    for (let attempt = 0; attempt < MAX_IDENTITY_ATTEMPTS; attempt += 1) {
      const client = await getClient();
      const { data } = await client.auth.getSession();
      const session = data && data.session;
      const userId = userIdOf(session);
      if (announcedUserId === undefined) announcedUserId = userId; // what pages are about to be shown: the baseline a later change is measured against
      if (!userId) return { session: null, member: null };
      let member;
      try {
        member = await memberFor(session);
      } catch (err) {
        if (!(await stillSignedInAs(client, userId))) continue; // the lookup was cancelled or failed for a person who is gone
        if (err && err.name === "AbortError") continue; // cancelled while the person changed and then changed back: ask again
        throw err;
      }
      if (!(await stillSignedInAs(client, userId))) continue;
      return { session, member };
    }
    throw new Error("The signed-in person kept changing; try again.");
  }

  function identityKey(state) {
    return [state.status, state.authUserId || "", state.gamingMemberId || ""].join("|");
  }

  // Tells identity listeners that WHO is signed in (or how far their
  // account is) changed. Token refreshes, tab refocus events and repeated
  // sign-in events for the same person produce the same key and are
  // ignored, so a page is never rebuilt under someone who is typing. The
  // newest evaluation wins if two overlap.
  async function publishIdentity() {
    const sequence = ++publishSequence;
    let state;
    try {
      state = await resolveState();
    } catch (err) {
      return;
    }
    if (sequence !== publishSequence) return;
    const key = identityKey(state);
    if (key === lastIdentityKey && !resetOwed) return;
    resetOwed = false; // pages that were told the person changed are always told who is signed in now
    lastIdentityKey = key;
    identityCallbacks.slice().forEach((callback) => {
      try {
        callback(state);
      } catch (err) {
        console.error("UrbanoAuth: onIdentityChange listener failed:", err);
      }
    });
  }

  async function resolveState() {
    const { session, member } = await resolveIdentity();

    if (!session) {
      return { status: "unauthenticated" };
    }

    if (!member) {
      return {
        status: "profile_incomplete",
        email: session.user.email,
        authUserId: session.user.id,
      };
    }

    return {
      status: "authenticated",
      email: session.user.email,
      authUserId: session.user.id,
      gamingMemberId: member.gamingMemberId,
      displayName: member.displayName,
    };
  }

  // ---- phone numbers -------------------------------------------------

  /**
   * Normalizes a phone number to E.164 (+ country code, digits only).
   * It never guesses a country: a number without a country code is
   * refused with an example, because sending a code to a wrong guess both
   * fails the person and spends money. "00" is accepted as "+".
   */
  function normalizePhone(input) {
    let value = String(input === null || input === undefined ? "" : input).trim();
    if (!value) return { ok: false, messageKey: "auth.msg.phoneEmpty", message: urbanoAuthText("auth.msg.phoneEmpty", "Enter your phone number with its country code, for example +504 9999 9999.") };
    value = value.replace(/[\s().-]/g, "");
    if (value.startsWith("00")) value = "+" + value.slice(2);
    if (!value.startsWith("+")) {
      return { ok: false, messageKey: "auth.msg.phoneNoCountry", message: urbanoAuthText("auth.msg.phoneNoCountry", "Start with the country code, for example +504 9999 9999 for Honduras.") };
    }
    if (!/^\+[1-9]\d{6,14}$/.test(value)) {
      return { ok: false, messageKey: "auth.msg.phoneInvalid", message: urbanoAuthText("auth.msg.phoneInvalid", "That doesn't look like a valid phone number. Use the country code followed by the number, for example +504 9999 9999.") };
    }
    return { ok: true, e164: value };
  }

  function isPlausibleEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  // ---- error classification -------------------------------------------

  /**
   * Turns a Supabase Auth error into something a person can act on.
   * phase: "request" (sending a code) or "verify" (checking one);
   * mode: "login" | "register".
   */
  function classifyAuthError(error, phase, mode, channel) {
    const text = String((error && (error.message || error.msg)) || "").toLowerCase();
    const code = String((error && (error.code || error.error_code)) || "").toLowerCase();
    const status = Number(error && error.status);
    const noun = channel === "phone" ? "phone number" : "email";

    const retryMatch = text.match(/after (\d+) second/);
    if (
      code.includes("rate_limit") ||
      status === 429 ||
      text.includes("rate limit") ||
      text.includes("only request this after")
    ) {
      const seconds = retryMatch ? Number(retryMatch[1]) : 60;
      return seconds > 0
        ? {
            kind: "rate_limited",
            retryAfterSeconds: seconds,
            messageKey: "auth.err.rateLimited",
            messageVars: { seconds },
            message: urbanoAuthText("auth.err.rateLimited", "Too many requests. Please wait {seconds} seconds and try again.", { seconds }),
          }
        : {
            kind: "rate_limited",
            retryAfterSeconds: seconds,
            messageKey: "auth.err.rateLimitedFew",
            message: urbanoAuthText("auth.err.rateLimitedFew", "Too many requests. Please wait a few seconds and try again."),
          };
    }

    if (phase === "verify") {
      if (code === "otp_expired" || code === "otp_invalid" || status === 403 || status === 400 || text.includes("expired") || text.includes("invalid")) {
        return {
          kind: "code_invalid",
          messageKey: "auth.err.codeInvalid",
          message: urbanoAuthText("auth.err.codeInvalid", "That code isn't valid or has expired. Check the code, or send a new one."),
        };
      }
    }

    if (phase === "request") {
      if (code === "otp_disabled" || code === "signup_disabled" || text.includes("signups not allowed")) {
        if (mode === "login") {
          // Internal classification only: requestCode turns this into the same
          // { status: "sent" } a known contact gets, so no screen ever shows it.
          return {
            kind: "no_account",
            message: `If an account exists for that ${noun}, a code is on its way. If nothing arrives, create an account instead.`,
          };
        }
        return { kind: "signup_closed", messageKey: "auth.err.signupClosed", message: urbanoAuthText("auth.err.signupClosed", "New accounts can't be created right now.") };
      }
      if (channel === "phone" && (code.includes("sms") || code.includes("provider") || text.includes("sms") || text.includes("phone provider"))) {
        return { kind: "unavailable", messageKey: "auth.err.phoneUnavailable", message: urbanoAuthText("auth.err.phoneUnavailable", "Phone sign-in isn't available right now.") };
      }
      if (code === "validation_failed" || code === "email_address_invalid" || code === "phone_number_invalid" || status === 400) {
        return channel === "phone"
          ? { kind: "invalid_input", messageKey: "auth.err.invalidPhone", message: urbanoAuthText("auth.err.invalidPhone", "That phone number can't be used.") }
          : { kind: "invalid_input", messageKey: "auth.err.invalidEmail", message: urbanoAuthText("auth.err.invalidEmail", "That email address can't be used.") };
      }
    }

    if (
      (error && error.name === "AuthRetryableFetchError") ||
      text.includes("failed to fetch") ||
      text.includes("networkerror") ||
      text.includes("network request failed") ||
      text.includes("load failed")
    ) {
      return { kind: "network", messageKey: "auth.err.network", message: urbanoAuthText("auth.err.network", "Couldn't reach the server. Check your connection and try again.") };
    }

    return { kind: "unknown", messageKey: "auth.err.unknown", message: urbanoAuthText("auth.err.unknown", "Something went wrong. Please try again.") };
  }

  // ---- intended action ---------------------------------------------------

  function storeIntent(intent) {
    const record = Object.assign({}, intent, { savedAt: Date.now() });
    memoryIntent = record;
    try {
      window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(record));
    } catch (err) {
      /* sessionStorage unavailable: the in-memory copy still serves this page */
    }
  }

  function readIntent() {
    let record = memoryIntent;
    if (!record) {
      try {
        const raw = window.sessionStorage.getItem(INTENT_KEY);
        record = raw ? JSON.parse(raw) : null;
      } catch (err) {
        record = null;
      }
    }
    if (!record || typeof record !== "object") return null;
    if (typeof record.savedAt !== "number" || Date.now() - record.savedAt > INTENT_MAX_AGE_MS) {
      removeIntent();
      return null;
    }
    return record;
  }

  function removeIntent() {
    memoryIntent = null;
    try {
      window.sessionStorage.removeItem(INTENT_KEY);
    } catch (err) {
      /* nothing to clear */
    }
  }

  // What a call that was started for one person reports when a different person (or nobody) is signed in by the time it finishes.
  function identityChangedResult() {
    return {
      status: "error",
      kind: "identity_changed",
      messageKey: "auth.err.identityChanged",
      message: urbanoAuthText("auth.err.identityChanged", "Your session changed. Please try again."),
    };
  }

  const api = {
    /**
     * Resolves the current Gaming Auth state:
     *   { status: "unauthenticated" }
     *   { status: "profile_incomplete", email, authUserId }
     *   { status: "authenticated", email, authUserId, gamingMemberId, displayName }
     */
    async getState() {
      const state = await resolveState();
      if (lastIdentityKey === null) lastIdentityKey = identityKey(state);
      return state;
    },

    async isAuthenticated() {
      const state = await this.getState();
      return state.status === "authenticated";
    },

    /** Which entry methods the backend reports as available: { email, phone }. */
    async getAuthMethods() {
      await getClient();
      return { email: authMethods.email, phone: authMethods.phone };
    },

    /**
     * Read-only profile facts for the signed-in person, from what Auth and this app's own member route ALREADY return:
     *   { status: "unauthenticated" }
     *   { status: "profile_incomplete", email, emailVerified }
     *   { status: "authenticated", email, emailVerified, displayName, gamingMemberId, memberSince }
     * emailVerified is true only when Auth explicitly reports email_confirmed_at, false only when Auth explicitly reports it as
     * null, and null when Auth does not say: having a session never counts as verification. memberSince is the Gaming Member's own
     * createdAt when the member route returns it, otherwise null (it is never inferred from the Auth account).
     */
    async getProfile() {
      // The session and the member come from the same single read (resolveIdentity): the email, the verification state, the name,
      // the id and the date always belong to the same person, whatever happened to the Auth session while the lookup was running.
      const { session, member } = await resolveIdentity();
      if (!session) return { status: "unauthenticated" };
      const user = session.user || {};
      const confirmedAt = user.email_confirmed_at;
      const emailVerified = typeof confirmedAt === "string" && confirmedAt !== "" ? true : confirmedAt === null ? false : null;
      if (!member) {
        return { status: "profile_incomplete", email: user.email || null, emailVerified };
      }
      const created = member.createdAt;
      return {
        status: "authenticated",
        email: user.email || null,
        emailVerified,
        displayName: member.displayName,
        gamingMemberId: member.gamingMemberId,
        memberSince: typeof created === "string" && Number.isFinite(Date.parse(created)) ? created : null,
      };
    },

    normalizePhone,
    classifyAuthError,

    /**
     * Sends a one-time code. mode "login" never creates an account, and an
     * unknown contact gets the same { status: "sent" } as a known one: the
     * result must not tell the caller whether an account exists. (That
     * covers this component only; a caller going straight to Supabase Auth
     * with shouldCreateUser:false still sees the backend's own answer.)
     * "sent" means the backend accepted the request, never that anything was
     * delivered. mode "register" may create the auth identity, but no Gaming
     * Member exists until the code has been verified and the display name
     * chosen.
     * { channel: "email" | "phone", identifier, mode, returnTo }
     * returnTo is a KEY into SIGN_IN_RETURN_TARGETS (never an address). It only shapes the email link; an unknown key is ignored.
     */
    async requestCode(options) {
      const channel = options && options.channel === "phone" ? "phone" : "email";
      const mode = options && options.mode === "login" ? "login" : "register";
      const identifier = options && options.identifier;
      if (channel === "phone" && !authMethods.phone) {
        // Fail closed without calling the backend: never simulate a send.
        await getClient().catch(() => null);
        if (!authMethods.phone) {
          return { status: "error", kind: "unavailable", messageKey: "auth.err.phoneUnavailableYet", message: urbanoAuthText("auth.err.phoneUnavailableYet", "Phone sign-in isn't available yet.") };
        }
      }
      let client;
      try {
        client = await getClient();
      } catch (err) {
        return { status: "error", kind: "network", messageKey: "auth.err.network", message: urbanoAuthText("auth.err.network", "Couldn't reach the server. Check your connection and try again.") };
      }
      const requestOptions = { shouldCreateUser: mode !== "login" };
      const returnUrl = channel === "email" ? signInReturnUrl(options && options.returnTo) : null;
      if (returnUrl) requestOptions.emailRedirectTo = returnUrl;
      const payload = channel === "phone"
        ? { phone: identifier, options: requestOptions }
        : { email: identifier, options: requestOptions };
      let result;
      try {
        result = await client.auth.signInWithOtp(payload);
      } catch (err) {
        const failure = classifyAuthError(err, "request", mode, channel);
        if (failure.kind === "no_account") return { status: "sent" };
        return Object.assign({ status: "error", detail: err && err.message }, failure);
      }
      if (result && result.error) {
        const failure = classifyAuthError(result.error, "request", mode, channel);
        if (failure.kind === "no_account") return { status: "sent" };
        return Object.assign({ status: "error", detail: result.error.message }, failure);
      }
      return { status: "sent" };
    },

    /**
     * Verifies a one-time code. On success, resolves the Gaming Member
     * profile through this app's own API and reports whether it is
     * already complete (returning member) or still needs display_name
     * collection (first-time member) — never creates a Gaming Member
     * itself.
     * { channel, identifier, code }
     */
    async verifyCode(options) {
      const channel = options && options.channel === "phone" ? "phone" : "email";
      const identifier = options && options.identifier;
      const code = options && options.code;
      let client;
      try {
        client = await getClient();
      } catch (err) {
        return { status: "error", kind: "network", messageKey: "auth.err.network", message: urbanoAuthText("auth.err.network", "Couldn't reach the server. Check your connection and try again.") };
      }
      let outcome;
      try {
        outcome = await client.auth.verifyOtp(
          channel === "phone"
            ? { phone: identifier, token: code, type: "sms" }
            : { email: identifier, token: code, type: "email" }
        );
      } catch (err) {
        const failure = classifyAuthError(err, "verify", "login", channel);
        return Object.assign({ status: "error", detail: err && err.message }, failure);
      }
      const data = outcome && outcome.data;
      const error = outcome && outcome.error;

      if (error || !data || !data.session) {
        const failure = classifyAuthError(error || { code: "otp_invalid" }, "verify", "login", channel);
        return Object.assign({ status: "error", detail: error ? error.message : "Verification failed." }, failure);
      }

      // The lookup is made for the person this session belongs to, and is only reported if that person is still the one signed in.
      const verifiedUserId = userIdOf(data.session);
      let member;
      try {
        member = verifiedUserId ? await memberFor(data.session) : null;
      } catch (err) {
        if (!(await stillSignedInAs(client, verifiedUserId))) return identityChangedResult();
        throw err;
      }
      if (!(await stillSignedInAs(client, verifiedUserId))) return identityChangedResult();

      if (!member) {
        return { status: "profile_incomplete", email: identifier };
      }

      return {
        status: "authenticated",
        email: identifier,
        gamingMemberId: member.gamingMemberId,
        displayName: member.displayName,
      };
    },

    /** Original email-only entry points, unchanged in meaning for existing callers. */
    async requestOtp(email) {
      const result = await this.requestCode({ channel: "email", identifier: email, mode: "register" });
      if (result.status === "error") {
        return { status: "error", message: result.detail || result.message };
      }
      return { status: "sent" };
    },

    async verifyOtp(email, code) {
      const result = await this.verifyCode({ channel: "email", identifier: email, code });
      if (result.status === "error") {
        return { status: "error", message: result.detail || result.message };
      }
      return result;
    },

    /**
     * Completes a first-time Gaming Member's profile. Only meaningful
     * immediately after verifyOtp returns "profile_incomplete" — the
     * server independently re-derives the auth identity from the
     * current session's own bearer token, never from a client-supplied
     * id.
     */
    async completeProfile(displayName) {
      const client = await getClient();
      const { data } = await client.auth.getSession();
      const session = data && data.session;
      if (!session) {
        return { status: "error", messageKey: "auth.err.notSignedIn", message: urbanoAuthText("auth.err.notSignedIn", "Not signed in.") };
      }

      const response = await fetch("/api/gaming/member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ displayName }),
      });
      const body = await response.json();

      if (!response.ok) {
        return {
          status: "error",
          message: body.error || urbanoAuthText("auth.err.profileFailed", "Failed to complete profile."),
          ...(body.error ? {} : { messageKey: "auth.err.profileFailed" }),
        };
      }

      // The profile was saved for the person whose token was sent. It is only stored, and only reported, if that person is still the
      // one signed in: otherwise the answer belongs to someone else and must not become the member of whoever is signed in now.
      const userId = userIdOf(session);
      if (!userId || !(await stillSignedInAs(client, userId))) return identityChangedResult();
      memberEntry = { userId, promise: Promise.resolve(body.gamingMember), abort: null, settled: true };
      // The session did not change, so Supabase raises no event: tell
      // identity listeners that this person's account is now complete.
      publishIdentity();
      return {
        status: "authenticated",
        email: session.user.email,
        gamingMemberId: body.gamingMember.gamingMemberId,
        displayName: body.gamingMember.displayName,
      };
    },

    async signOut() {
      const client = await getClient();
      await client.auth.signOut();
      dropMember(null); // nobody is signed in: forget the lookup and cancel any still in flight
      removeIntent();
      return { status: "unauthenticated" };
    },

    /** Returns the current Supabase access token, or null if signed out. */
    async getAccessToken() {
      const client = await getClient();
      const { data } = await client.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    },

    /**
     * Registers a callback fired on every Auth state change (sign in,
     * sign out, token refresh). Returns an unsubscribe function.
     */
    async onAuthStateChange(callback) {
      await getClient();
      authChangeCallbacks.push(callback);
      return () => {
        authChangeCallbacks = authChangeCallbacks.filter(
          (cb) => cb !== callback
        );
      };
    },

    /**
     * Registers a callback fired SYNCHRONOUSLY, before anything is looked up, the moment the signed-in person changes or signs out
     * (never for a token refresh or a repeated event for the same person). It receives { userId } only (no personal data). Use it to
     * drop whatever on screen belonged to the previous person at once; onIdentityChange follows with the new state. Returns an
     * unsubscribe function.
     */
    async onIdentityReset(callback) {
      await getClient();
      identityResetCallbacks.push(callback);
      return () => {
        identityResetCallbacks = identityResetCallbacks.filter((cb) => cb !== callback);
      };
    },

    /**
     * Registers a callback fired only when WHO is signed in, or how far
     * their account is, changes: signing in, signing out, a different
     * person, or a first-time member finishing their profile. It is NOT
     * fired for token refreshes or repeated events for the same person,
     * so it is safe for a page to rebuild itself from it. The callback
     * receives the new state. Returns an unsubscribe function.
     */
    async onIdentityChange(callback) {
      await getClient();
      identityCallbacks.push(callback);
      return () => {
        identityCallbacks = identityCallbacks.filter((cb) => cb !== callback);
      };
    },

    /**
     * Opens the sign-in panel on this page. An intent (for example
     * { kind: "predict", matchId }) is remembered until it is consumed
     * after sign-in, cleared on sign-out, or 30 minutes pass.
     * Returns false if this page has no sign-in panel.
     */
    openSignIn(options) {
      if (options && options.intent) storeIntent(options.intent);
      if (!signInOpener) return false;
      signInOpener({ mode: options && options.mode });
      return true;
    },

    /** The remembered intended action, without clearing it. */
    peekIntent() {
      return readIntent();
    },

    /** The remembered intended action, cleared as it is returned (null if none). */
    consumeIntent() {
      const intent = readIntent();
      removeIntent();
      return intent;
    },

    clearIntent() {
      removeIntent();
    },

    /**
     * Wires a "Sign in with URBANO" button to the real sign-in flow.
     * Deliberately builds its own minimal inline panel rather than
     * requiring each of the pages that call this to carry their
     * own sign-in markup — "use the existing shell seam," not a
     * redesign of any page.
     *
     * options (all optional; omitting them keeps the original behavior exactly):
     *   accountLink  an <a hidden> the page owns. When a person is signed in it shows "Hi, {name}" (a real link, to the page's own
     *                profile address) in place of the button; signed out, it is hidden again and the button returns.
     */
    attachSignInButton(buttonEl, statusEl, options) {
      if (!buttonEl) return;
      // An invalid, used or expired sign-in link is read (and removed from the address bar) once per page load.
      const linkError = readLinkErrorOnce();
      createSignInPanel(this, buttonEl, statusEl, (opener) => {
        signInOpener = opener;
      }, options || {}, linkError);
    },
  };

  return api;
})();

/**
 * Builds and wires the inline account-entry panel:
 *   Enter URBANO -> Log in | Create account -> Email | Phone -> code ->
 *   (first-time only) display name -> signed in.
 * Kept as a plain function outside the UrbanoAuth object (rather than a
 * method) so it can freely close over its own panel-local DOM state
 * without polluting the public API surface. All user-supplied text is
 * placed with textContent, never parsed as HTML.
 */
function createSignInPanel(auth, buttonEl, statusEl, registerOpener, options, linkError) {
  const tr = urbanoAuthText;
  const accountLink = (options && options.accountLink) || null;
  // Opt-in (the administration portal): this panel can only LOG IN. It never offers "Create account", never asks for a code in
  // register mode (shouldCreateUser is always false) and never asks for a display name or creates a Gaming Member: an identity that
  // has no finished profile simply stays signed out of anything administrative. Omitting the option keeps every other page exactly
  // as it was. This shapes what THIS panel does; it is not a security boundary (the server checks authority on every request).
  const loginOnly = !!(options && options.accountEntry === "login-only");
  // Opt-in, independent of the entry mode: the KEY of a fixed return destination for the sign-in email link (see SIGN_IN_RETURN_TARGETS).
  // The panel never interprets it; requestCode resolves it, and a key that is not in the table changes nothing.
  const returnTo = options && typeof options.returnTo === "string" ? options.returnTo : null;
  // The panel's own wording in this mode is plain English: the administration portal does not load the language module (see the header of
  // urbanoI18n.js), and adding keys would change the generated Spanish blocks of the public pages.
  const signedOutLabel = () => (loginOnly ? "Sign in" : tr("auth.btn.signedOut", "Log in / Create account"));
  // The server will not send a second code to the same address inside its
  // per-user window (60 s on the production project as inspected on
  // 2026-10-22), so a shorter wait here would only turn a legitimate resend
  // into a rate-limit error, one an unknown address would never produce.
  const RESEND_COOLDOWN_SECONDS = 60;
  const BUTTON_STYLE =
    "width:100%;padding:8px;border-radius:6px;border:none;background:#111;color:#fff;cursor:pointer;margin-bottom:8px;";
  const BUTTON_SECONDARY_STYLE =
    "width:100%;padding:8px;border-radius:6px;border:1px solid #111;background:#fff;color:#111;cursor:pointer;margin-bottom:8px;";
  const INPUT_STYLE =
    "width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:6px;";
  const LINK_STYLE = "font-size:12px;color:#111;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;";

  // A panel message is either a plain string (already final text, for example a message a server sent) or a descriptor
  // { key, fallback, vars } that is translated at the moment it is drawn, so changing language re-translates what is on screen.
  const msg = (key, fallback, vars) => ({ key, fallback, vars });
  function resolveMessage(message) {
    return message && typeof message === "object" ? tr(message.key, message.fallback, message.vars) : message || "";
  }
  // A server message is translated only when it is an exact, known one (see UrbanoI18n.serverMessageKey); otherwise it is shown as received.
  function serverMessage(text) {
    const i18n = typeof window !== "undefined" ? window.UrbanoI18n : undefined;
    const key = i18n && typeof i18n.serverMessageKey === "function" ? i18n.serverMessageKey(text) : null;
    return key ? msg(key, text) : text;
  }
  // The message of a result returned by the shared component: its key when it carries one.
  function resultMessage(result) {
    if (result.messageKey) return msg(result.messageKey, result.message, result.messageVars);
    return serverMessage(result.message);
  }

  // Resolving the real Auth state takes two network round-trips
  // (GET /api/gaming/config, then loading the Supabase client from its
  // CDN) before getState() can even check the — otherwise instant —
  // local session. Rather than let the button sit on its static HTML
  // default for that whole window only to flip
  // to "Hi, {name}" once resolved, hide it immediately and reveal the
  // correct state once known. visibility (not display) keeps its
  // layout space reserved, so nothing else in the header reflows when
  // it reappears.
  buttonEl.style.visibility = "hidden";

  const panel = document.createElement("div");
  panel.setAttribute("data-urbano-signin-panel", "");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", loginOnly ? "Sign in" : tr("auth.panel.aria", "Log in or create an account"));
  panel.style.cssText = [
    "display:none",
    "position:absolute",
    // Anchored to the parent's right edge, not the left — the sign-in
    // button this panel opens from lives at the far right of the shell
    // header on every page that calls attachSignInButton. Without an
    // explicit right anchor, an absolutely positioned block sibling
    // falls back to its static left:0 position, which pins the panel
    // to the opposite side of the header from the button that opened
    // it — invisible on a wide desktop viewport (plenty of clear space
    // either side) but overlapping the brand mark on a narrow one.
    "right:0",
    // Dropped below the header it hangs from. Without an explicit top, an
    // absolutely positioned child of a vertically centred flex header keeps
    // its centred static position and a tall panel spills above the page.
    "top:100%",
    "z-index:1000",
    "margin-top:8px",
    "padding:14px",
    "width:min(320px, calc(100vw - 24px))",
    "box-sizing:border-box",
    "border-radius:10px",
    "border:1px solid rgba(0,0,0,0.15)",
    "background:#fff",
    "color:#111",
    "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
    "font-family:inherit",
    "font-size:13px",
  ].join(";");

  buttonEl.insertAdjacentElement("afterend", panel);
  if (getComputedStyle(buttonEl.parentElement || document.body).position === "static") {
    buttonEl.parentElement.style.position = "relative";
  }

  let mode = loginOnly ? "login" : null; // "login" | "register"
  let channel = "email"; // "email" | "phone"
  let identifier = ""; // the email address, or the E.164 number, a code was sent to
  let typedIdentifier = ""; // what the person typed (kept when they go back)
  let step = loginOnly ? "method" : "entry"; // entry | method | code | displayName | welcomeBack
  let panelOpen = false;
  let phoneAvailable = false;
  let incompleteProfile = false;
  // Bumped whenever the journey is restarted, abandoned or signed out. A
  // reply that arrives for an older flow is ignored, never applied.
  let flowId = 0;
  let busy = false; // one request at a time per panel: a double click is one request
  let resendReadyAt = 0;
  let resendTimer = null;
  let lastMessage = { message: "", error: false };
  let shownDisplayName = ""; // the name the signed-in header shows (kept so a language change can redraw it)
  let welcomeState = null; // what the "welcome back" screen shows (kept for the same reason)
  let shownStatus = "unauthenticated"; // what the header currently shows: unauthenticated | profile_incomplete | authenticated
  let justOpened = false; // the click that opened the panel must not also count as an outside click

  function node(tag, options, children) {
    const element = document.createElement(tag);
    const opts = options || {};
    if (opts.style) element.style.cssText = opts.style;
    if (opts.text !== undefined) element.textContent = opts.text;
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach((name) => element.setAttribute(name, opts.attrs[name]));
    }
    (children || []).forEach((child) => child && element.appendChild(child));
    return element;
  }

  function title(text) {
    return node("div", { text, style: "margin-bottom:8px;font-weight:600;font-size:14px;" });
  }

  function note(text) {
    return node("div", { text, style: "margin-bottom:8px;color:#555;" });
  }

  function button(label, dataAttr, secondary) {
    return node("button", {
      text: label,
      attrs: { type: "button", [dataAttr]: "" },
      style: secondary ? BUTTON_SECONDARY_STYLE : BUTTON_STYLE,
    });
  }

  function linkButton(label, dataAttr) {
    return node("button", { text: label, attrs: { type: "button", [dataAttr]: "" }, style: LINK_STYLE });
  }

  function messageLine() {
    const line = node("p", {
      attrs: { "data-msg": "", role: "status", "aria-live": "polite" },
      style: "margin:8px 0 0;min-height:16px;",
    });
    line.textContent = resolveMessage(lastMessage.message);
    line.style.color = lastMessage.error ? "#b3261e" : "#555";
    return line;
  }

  function setPanelMessage(message, isError) {
    lastMessage = { message: message || "", error: !!isError };
    const el = panel.querySelector("[data-msg]");
    if (!el) return;
    el.textContent = resolveMessage(lastMessage.message);
    el.style.color = isError ? "#b3261e" : "#555";
  }

  // While a request is in flight the action buttons are off (a double click is one request), but Back, "different
  // email/number" and the mode switch stay usable: the person can always leave a slow request, and its late answer is ignored.
  function setBusy(value) {
    busy = value;
    panel.querySelectorAll("[data-send], [data-verify], [data-continue]").forEach((b) => {
      b.disabled = value;
    });
    refreshResendLabel();
  }

  function abandonFlow() {
    flowId += 1;
    stopResendTimer();
  }

  function goTo(nextStep, message, isError) {
    step = nextStep;
    lastMessage = { message: message || "", error: !!isError };
    renderStep();
  }

  function openPanel(options) {
    if (shownStatus === "authenticated") return; // signed in: there is nothing to log in to
    panelOpen = true;
    justOpened = true;
    setTimeout(() => {
      justOpened = false;
    }, 0);
    panel.style.display = "block";
    const requestedMode = options && options.mode;
    if (incompleteProfile) {
      goTo("displayName", msg("auth.msg.lastStep", "One last step to finish creating your account."));
      return;
    }
    if (requestedMode === "login" || requestedMode === "register") {
      mode = loginOnly ? "login" : requestedMode;
      if (step === "entry") step = "method";
    }
    renderStep();
    auth
      .getAuthMethods()
      .then((methods) => {
        if (phoneAvailable !== methods.phone) {
          phoneAvailable = methods.phone;
          if (panelOpen && step === "method") renderStep();
        }
      })
      .catch(() => {});
  }

  function closePanel() {
    panelOpen = false;
    panel.style.display = "none";
    stopResendTimer();
  }

  // ---- resend countdown ------------------------------------------------

  function stopResendTimer() {
    if (resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
  }

  function secondsUntilResend() {
    return Math.max(0, Math.ceil((resendReadyAt - Date.now()) / 1000));
  }

  function refreshResendLabel() {
    const resend = panel.querySelector("[data-resend]");
    if (!resend) return;
    const seconds = secondsUntilResend();
    resend.textContent = seconds > 0 ? tr("auth.code.resendIn", "Resend code in {s}s", { s: seconds }) : tr("auth.code.resend", "Resend code");
    resend.disabled = busy || seconds > 0;
    resend.style.opacity = resend.disabled ? "0.5" : "1";
    resend.style.cursor = resend.disabled ? "default" : "pointer";
  }

  function startResendCountdown(seconds) {
    resendReadyAt = Date.now() + seconds * 1000;
    stopResendTimer();
    resendTimer = setInterval(() => {
      refreshResendLabel();
      if (secondsUntilResend() <= 0) stopResendTimer();
    }, 1000);
    refreshResendLabel();
  }

  // ---- screens ------------------------------------------------------------

  function renderEntry() {
    panel.replaceChildren(
      title(tr("auth.entry.title", "Enter URBANO")),
      note(tr("auth.entry.note", "Log in to your account, or create one.")),
      button(tr("auth.login", "Log in"), "data-choose-login"),
      button(tr("auth.register", "Create account"), "data-choose-register", true),
      messageLine()
    );
    panel.querySelector("[data-choose-login]").addEventListener("click", () => {
      mode = "login";
      goTo("method");
    });
    panel.querySelector("[data-choose-register]").addEventListener("click", () => {
      mode = "register";
      goTo("method");
    });
  }

  function renderMethod() {
    if (channel === "phone" && !phoneAvailable) channel = "email";
    const isLogin = mode === "login";
    const emailActive = channel === "email";
    const emailToggle = node("button", {
      text: tr("auth.method.email", "Email"),
      attrs: { type: "button", "data-method-email": "", "aria-pressed": String(emailActive) },
      style: `flex:1;padding:8px;border-radius:6px;border:1px solid #111;cursor:pointer;background:${emailActive ? "#111" : "#fff"};color:${emailActive ? "#fff" : "#111"};`,
    });
    const phoneActive = channel === "phone" && phoneAvailable;
    const phoneToggle = node("button", {
      text: phoneAvailable ? tr("auth.method.phone", "Phone") : tr("auth.method.phoneSoon", "Phone — not available yet"),
      attrs: { type: "button", "data-method-phone": "", "aria-pressed": String(phoneActive) },
      style: `flex:1;padding:8px;border-radius:6px;border:1px solid ${phoneAvailable ? "#111" : "#bbb"};background:${phoneActive ? "#111" : "#fff"};color:${phoneActive ? "#fff" : phoneAvailable ? "#111" : "#888"};cursor:${phoneAvailable ? "pointer" : "not-allowed"};font-size:${phoneAvailable ? "13px" : "11px"};`,
    });
    if (!phoneAvailable) {
      phoneToggle.setAttribute("aria-disabled", "true");
      phoneToggle.title = tr("auth.method.phoneSoonTitle", "Phone sign-in isn't available yet.");
    }
    const input = node("input", {
      attrs: emailActive
        ? { "data-contact": "", type: "email", placeholder: tr("auth.input.emailPlaceholder", "you@example.com"), autocomplete: "email", "aria-label": tr("auth.input.emailAria", "Email address") }
        : { "data-contact": "", type: "tel", placeholder: "+504 9999 9999", autocomplete: "tel", "aria-label": tr("auth.input.phoneAria", "Phone number") },
      style: INPUT_STYLE,
    });
    input.value = typedIdentifier;
    const children = [
      title(loginOnly ? "Sign in" : isLogin ? tr("auth.login", "Log in") : tr("auth.register", "Create account")),
      note(isLogin ? tr("auth.method.loginNote", "Choose how to get your code.") : tr("auth.method.registerNote", "We'll send a code to confirm it's really you.")),
      node("div", { style: "display:flex;gap:6px;margin-bottom:8px;" }, [emailToggle, phoneToggle]),
      input,
      button(isLogin ? tr("auth.sendLogin", "Send login code") : tr("auth.sendVerification", "Send verification code"), "data-send"),
    ];
    if (!emailActive) {
      children.push(note(tr("auth.phoneHint", "Use the country code, for example +504 9999 9999.")));
    }
    children.push(messageLine());
    const switchRow = node("div", { style: "display:flex;justify-content:space-between;margin-top:4px;" });
    switchRow.appendChild(linkButton(loginOnly ? "Close" : tr("auth.back", "Back"), "data-back"));
    if (!loginOnly) {
      switchRow.appendChild(linkButton(isLogin ? tr("auth.switch.toRegister", "Create an account instead") : tr("auth.switch.toLogin", "I already have an account"), "data-switch-mode"));
    }
    children.push(switchRow);
    panel.replaceChildren.apply(panel, children);

    emailToggle.addEventListener("click", () => {
      if (channel === "email") return;
      channel = "email";
      typedIdentifier = "";
      goTo("method");
    });
    phoneToggle.addEventListener("click", () => {
      if (!phoneAvailable) {
        setPanelMessage(msg("auth.method.phoneSoonMsg", "Phone sign-in isn't available yet. Please use your email."), true);
        return;
      }
      if (channel === "phone") return;
      channel = "phone";
      typedIdentifier = "";
      goTo("method");
    });
    input.addEventListener("input", () => {
      typedIdentifier = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendCode();
      }
    });
    panel.querySelector("[data-send]").addEventListener("click", sendCode);
    panel.querySelector("[data-back]").addEventListener("click", () => {
      abandonFlow();
      if (loginOnly) {
        closePanel();
        return;
      }
      mode = null;
      goTo("entry");
    });
    const switchMode = panel.querySelector("[data-switch-mode]");
    if (switchMode) {
      switchMode.addEventListener("click", () => {
        abandonFlow();
        mode = mode === "login" ? "register" : "login";
        goTo("method");
      });
    }
    input.focus();
  }

  function renderCode() {
    // Log in shows the same screen whether or not the address has an account,
    // so its wording is conditional and never claims a code was delivered.
    // The code length is the project's choice (8 digits in production, 6
    // locally): the screen never states it.
    const isPhone = channel === "phone";
    const intro = mode === "login"
      ? (isPhone
          ? tr("auth.code.introLoginPhone", "If {id} has an account, a text message with a code is on its way. It can take a minute to arrive.", { id: identifier })
          : tr("auth.code.introLoginEmail", "If {id} has an account, a code is on its way. It can take a minute to arrive; check your spam folder if you don't see it.", { id: identifier }))
      : (isPhone
          ? tr("auth.code.introRegisterPhone", "We sent a text message with a code to {id}. It can take a minute to arrive.", { id: identifier })
          : tr("auth.code.introRegisterEmail", "We sent a code to {id}. It can take a minute to arrive; check your spam folder if you don't see it.", { id: identifier }));
    const input = node("input", {
      attrs: {
        "data-code": "", type: "text", inputmode: "numeric", autocomplete: "one-time-code",
        placeholder: tr("auth.code.placeholder", "Verification code"), "aria-label": tr("auth.code.placeholder", "Verification code"),
      },
      style: INPUT_STYLE,
    });
    const resend = node("button", {
      text: tr("auth.code.resend", "Resend code"),
      attrs: { type: "button", "data-resend": "" },
      style: LINK_STYLE,
    });
    const children = [
      title(tr("auth.code.title", "Enter your code")),
      note(intro),
      input,
      button(tr("auth.code.verify", "Verify"), "data-verify"),
      node("div", { style: "display:flex;justify-content:space-between;margin-top:8px;" }, [
        resend,
        linkButton(isPhone ? tr("auth.code.otherNumber", "Use a different number") : tr("auth.code.otherEmail", "Use a different email"), "data-change"),
      ]),
    ];
    if (mode === "login" && !loginOnly) {
      children.push(
        node("div", { style: "margin-top:8px;font-size:12px;" }, [
          document.createTextNode(isPhone ? tr("auth.code.noCodePhone", "No code from your text message? ") : tr("auth.code.noCodeEmail", "No code from your email? ")),
          linkButton(tr("auth.switch.toRegister", "Create an account instead"), "data-create-instead"),
        ])
      );
    }
    children.push(messageLine());
    panel.replaceChildren.apply(panel, children);
    panel.querySelector("[data-verify]").addEventListener("click", verifyCode);
    const createInstead = panel.querySelector("[data-create-instead]");
    if (createInstead) {
      createInstead.addEventListener("click", () => {
        // Creating an account is its own explicit choice; what was typed is kept.
        abandonFlow();
        mode = "register";
        goTo("method");
      });
    }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        verifyCode();
      }
    });
    resend.addEventListener("click", resendCode);
    panel.querySelector("[data-change]").addEventListener("click", () => {
      abandonFlow();
      goTo("method");
    });
    refreshResendLabel();
    if (secondsUntilResend() > 0 && !resendTimer) {
      resendTimer = setInterval(() => {
        refreshResendLabel();
        if (secondsUntilResend() <= 0) stopResendTimer();
      }, 1000);
    }
    input.focus();
  }

  function renderDisplayName() {
    const input = node("input", {
      attrs: { "data-display-name": "", type: "text", maxlength: "40", placeholder: tr("auth.name.placeholder", "How you'll appear in games"), "aria-label": tr("auth.name.aria", "Display name") },
      style: INPUT_STYLE,
    });
    panel.replaceChildren(
      title(tr("auth.name.title", "Choose your display name")),
      note(tr("auth.name.note", "This is how you'll appear in games.")),
      input,
      button(tr("auth.continue", "Continue"), "data-continue"),
      messageLine()
    );
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveDisplayName(input);
      }
    });
    panel.querySelector("[data-continue]").addEventListener("click", () => saveDisplayName(input));
    input.focus();
  }

  function renderWelcomeBack(state) {
    welcomeState = state;
    panel.replaceChildren(
      title(tr("auth.welcome.title", "Welcome back")),
      note(
        channel === "phone"
          ? tr("auth.welcome.phone", "This phone number already has an account, so we signed you in as {name}.", { name: state.displayName })
          : tr("auth.welcome.email", "This email already has an account, so we signed you in as {name}.", { name: state.displayName })
      ),
      button(tr("auth.continue", "Continue"), "data-welcome-continue")
    );
    panel.querySelector("[data-welcome-continue]").addEventListener("click", () => {
      closePanel();
    });
  }

  function renderStep() {
    if (loginOnly) {
      mode = "login";
      if (step === "entry" || step === "displayName") step = "method";
    }
    if (step === "entry") renderEntry();
    else if (step === "method") renderMethod();
    else if (step === "code") renderCode();
    else if (step === "displayName") renderDisplayName();
  }

  // ---- actions --------------------------------------------------------------

  async function sendCode() {
    if (busy) return;
    const raw = (panel.querySelector("[data-contact]") || {}).value || typedIdentifier;
    typedIdentifier = raw;
    let target;
    if (channel === "phone") {
      const phone = auth.normalizePhone(raw);
      if (!phone.ok) {
        setPanelMessage(resultMessage(phone), true);
        return;
      }
      target = phone.e164;
    } else {
      target = String(raw).trim();
      if (!target) {
        setPanelMessage(msg("auth.msg.emailEmpty", "Enter your email address."), true);
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
        setPanelMessage(msg("auth.msg.emailInvalid", "That doesn't look like an email address. Check it and try again."), true);
        return;
      }
    }
    const myFlow = flowId;
    setBusy(true);
    setPanelMessage(mode === "login" ? msg("auth.msg.requestingLogin", "Requesting your login code...") : msg("auth.msg.sendingVerification", "Sending your verification code..."));
    const result = await auth.requestCode({ channel, identifier: target, mode: loginOnly ? "login" : mode, returnTo });
    setBusy(false);
    if (myFlow !== flowId) return;
    if (result.status === "error") {
      setPanelMessage(resultMessage(result), true);
      if (result.kind === "rate_limited") startResendCountdown(result.retryAfterSeconds || 60);
      return;
    }
    identifier = target;
    startResendCountdown(RESEND_COOLDOWN_SECONDS);
    goTo("code", "");
  }

  async function resendCode() {
    if (busy || secondsUntilResend() > 0) return;
    const myFlow = flowId;
    setBusy(true);
    setPanelMessage(msg("auth.msg.sendingNew", "Sending a new code..."));
    const result = await auth.requestCode({ channel, identifier, mode: loginOnly ? "login" : mode, returnTo });
    setBusy(false);
    if (myFlow !== flowId) return;
    if (result.status === "error") {
      setPanelMessage(resultMessage(result), true);
      if (result.kind === "rate_limited") startResendCountdown(result.retryAfterSeconds || 60);
      return;
    }
    startResendCountdown(RESEND_COOLDOWN_SECONDS);
    setPanelMessage(
      mode === "login"
        ? msg("auth.msg.resentLogin", "If an account exists, a new code is on its way. Older codes no longer work.")
        : msg("auth.msg.resentRegister", "A new code is on its way. Older codes no longer work.")
    );
  }

  async function verifyCode() {
    if (busy) return;
    const input = panel.querySelector("[data-code]");
    const code = ((input && input.value) || "").replace(/\s+/g, "");
    if (!code) {
      setPanelMessage(channel === "phone" ? msg("auth.msg.codeEmptyPhone", "Enter the code from your text message.") : msg("auth.msg.codeEmptyEmail", "Enter the code from your email."), true);
      return;
    }
    const myFlow = flowId;
    setBusy(true);
    setPanelMessage(msg("auth.msg.verifying", "Verifying..."));
    const result = await auth.verifyCode({ channel, identifier, code });
    setBusy(false);
    if (myFlow !== flowId) return;
    if (result.status === "error") {
      setPanelMessage(resultMessage(result), true);
      if (result.kind === "code_invalid" && input) {
        input.value = "";
        input.focus();
      }
      return;
    }
    if (result.status === "profile_incomplete" && loginOnly) {
      // A verified identity with no Gaming Member. Nothing is created from here: the page decides what a session without a member may do.
      closePanel();
      renderSignedOut(true);
      return;
    }
    if (result.status === "profile_incomplete") {
      incompleteProfile = true;
      shownStatus = "profile_incomplete";
      goTo("displayName", mode === "login" ? msg("auth.msg.incompleteLogin", "We found your sign-in but no finished account. Choose a display name to finish.") : "");
      return;
    }
    if (mode === "register") {
      // A registration for a contact that already had an account is a
      // login: say so instead of pretending a new account was made.
      shownStatus = "authenticated";
      renderSignedIn(result);
      step = "welcomeBack";
      renderWelcomeBack(result);
      return;
    }
    closePanel();
    renderSignedIn(result);
  }

  async function saveDisplayName(input) {
    if (busy || loginOnly) return;
    const name = input.value.trim();
    if (!name) {
      setPanelMessage(msg("auth.msg.nameEmpty", "Enter a display name."), true);
      return;
    }
    const myFlow = flowId;
    setBusy(true);
    setPanelMessage(msg("auth.msg.saving", "Saving..."));
    const result = await auth.completeProfile(name);
    setBusy(false);
    if (myFlow !== flowId) return;
    if (result.status === "error") {
      setPanelMessage(resultMessage(result), true);
      return;
    }
    incompleteProfile = false;
    closePanel();
    renderSignedIn(result);
  }

  // ---- header ------------------------------------------------------------------

  function paintSignedInLabel() {
    const hi = tr("auth.btn.hi", "Hi, {name}", { name: shownDisplayName });
    if (accountLink) {
      // A real link to the page's own profile address replaces the button while someone is signed in.
      accountLink.textContent = hi;
      accountLink.setAttribute("title", tr("auth.profile.title", "View my profile"));
      accountLink.hidden = false;
      buttonEl.style.display = "none";
    } else {
      buttonEl.textContent = hi;
    }
    buttonEl.style.visibility = "";
  }

  function renderSignedIn(state) {
    shownStatus = "authenticated";
    shownDisplayName = state.displayName;
    paintSignedInLabel();
    buttonEl.onclick = null;
    let signOutLink = buttonEl.parentElement.querySelector(
      "[data-urbano-signout]"
    );
    if (!signOutLink) {
      signOutLink = document.createElement("a");
      signOutLink.setAttribute("data-urbano-signout", "");
      signOutLink.href = "#";
      signOutLink.textContent = tr("auth.signOut", "Sign out");
      signOutLink.style.cssText =
        "margin-left:8px;font-size:12px;color:inherit;";
      buttonEl.insertAdjacentElement("afterend", signOutLink);
    }
    signOutLink.textContent = tr("auth.signOut", "Sign out");
    signOutLink.style.display = "inline";
    signOutLink.onclick = async (e) => {
      e.preventDefault();
      await auth.signOut();
      renderSignedOut();
    };
    if (statusEl) {
      statusEl.style.display = "none";
    }
    hideLinkError(); // a signed-in person has no use for a message about a link that did not work
  }

  function renderSignedOut(profileIncomplete) {
    shownStatus = profileIncomplete ? "profile_incomplete" : "unauthenticated";
    abandonFlow();
    if (accountLink) {
      accountLink.hidden = true;
      buttonEl.style.display = "";
    }
    buttonEl.textContent = profileIncomplete && !loginOnly
      ? tr("auth.btn.finish", "Finish creating your account")
      : signedOutLabel();
    buttonEl.style.visibility = "";
    const signOutLink = buttonEl.parentElement.querySelector(
      "[data-urbano-signout]"
    );
    if (signOutLink) signOutLink.style.display = "none";
    incompleteProfile = !!profileIncomplete && !loginOnly;
    step = loginOnly ? "method" : profileIncomplete ? "displayName" : "entry";
    mode = loginOnly ? "login" : null;
    channel = "email";
    identifier = "";
    typedIdentifier = "";
    lastMessage = { message: "", error: false };
    welcomeState = null;
    if (panelOpen) renderStep();
  }

  buttonEl.addEventListener("click", () => {
    if (shownStatus === "authenticated") return; // a profile view is a later feature; never show log-in options to a signed-in person
    if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.addEventListener("click", (e) => {
    if (justOpened) return;
    // The panel rebuilds itself when a button inside it is pressed, which
    // detaches the pressed button before this listener runs, so "was the
    // click inside the panel" is answered from the path the event took, not
    // from where the target is now.
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const inside = path.includes(panel) || panel.contains(e.target);
    const onLanguageSelector = !!(e.target && typeof e.target.closest === "function" && e.target.closest("[data-lang]"));
    if (panelOpen && !inside && e.target !== buttonEl && !onLanguageSelector) {
      closePanel();
    }
  });

  registerOpener((options) => {
    openPanel(options);
  });

  // ---- a sign-in link that did not work ----------------------------------------
  // Shown in the page's own status line (or, if the page has none, a line at the top of the page). It says what happened in plain
  // words and offers ONE explicit action: open the log-in panel to request a new code. Nothing is sent until the person asks.
  let linkErrorHost = null;
  let linkErrorVisible = false;

  function paintLinkError() {
    if (!linkError) return;
    if (!linkErrorHost) {
      linkErrorHost = statusEl || document.createElement("p");
      if (!statusEl) {
        linkErrorHost.style.cssText = "margin:10px 20px 0;font-size:12.5px;line-height:1.5;";
        document.body.insertBefore(linkErrorHost, document.body.firstChild);
      }
      linkErrorHost.setAttribute("role", "alert");
      linkErrorHost.setAttribute("data-urbano-link-error", "");
    }
    const text = document.createElement("span");
    text.setAttribute("data-link-error-text", "");
    text.textContent = tr("auth.link.error", "This sign-in link isn't valid, was already used, or has expired. Request a new one to sign in.");
    const retry = node("button", {
      text: tr("auth.link.retry", "Request a new code"),
      attrs: { type: "button", "data-link-error-retry": "" },
      style: "font:inherit;color:inherit;cursor:pointer;text-decoration:underline;background:none;border:none;padding:10px 6px;margin-left:4px;",
    });
    retry.addEventListener("click", () => {
      openPanel({ mode: "login" });
    });
    linkErrorHost.replaceChildren(text, retry);
    linkErrorHost.style.display = "block";
    linkErrorVisible = true;
  }

  function hideLinkError() {
    if (linkErrorHost && linkErrorVisible) linkErrorHost.style.display = "none";
    linkErrorVisible = false;
  }

  // ---- language change -----------------------------------------------------------
  // Redraws what is on screen in the new language without losing what the person already typed or where they are in the journey.
  function redrawPanel() {
    const codeEl = panel.querySelector("[data-code]");
    const nameEl = panel.querySelector("[data-display-name]");
    const contactEl = panel.querySelector("[data-contact]");
    const typed = { code: codeEl ? codeEl.value : "", name: nameEl ? nameEl.value : "" };
    if (contactEl) typedIdentifier = contactEl.value;
    if (step === "welcomeBack" && welcomeState) renderWelcomeBack(welcomeState);
    else renderStep();
    const codeNow = panel.querySelector("[data-code]");
    if (codeNow && typed.code) codeNow.value = typed.code;
    const nameNow = panel.querySelector("[data-display-name]");
    if (nameNow && typed.name) nameNow.value = typed.name;
    setBusy(busy);
  }

  function relabel() {
    panel.setAttribute("aria-label", loginOnly ? "Sign in" : tr("auth.panel.aria", "Log in or create an account"));
    if (shownStatus === "authenticated") {
      paintSignedInLabel();
      const signOutLink = buttonEl.parentElement.querySelector("[data-urbano-signout]");
      if (signOutLink) signOutLink.textContent = tr("auth.signOut", "Sign out");
    } else {
      buttonEl.textContent = shownStatus === "profile_incomplete" && !loginOnly
        ? tr("auth.btn.finish", "Finish creating your account")
        : signedOutLabel();
    }
    if (panelOpen) redrawPanel();
    if (linkErrorVisible) paintLinkError();
  }

  const pageI18n = typeof window !== "undefined" ? window.UrbanoI18n : undefined;
  if (pageI18n && typeof pageI18n.onChange === "function") pageI18n.onChange(relabel);

  if (linkError) paintLinkError();

  function applyState(state) {
    if (state.status === "authenticated") {
      // A different person than the one the panel was serving: end any
      // half-finished journey rather than let it finish under the wrong name.
      abandonFlow();
      incompleteProfile = false;
      if (panelOpen && step !== "welcomeBack") closePanel();
      renderSignedIn(state);
    } else if (state.status === "profile_incomplete") {
      renderSignedOut(true);
    } else {
      renderSignedOut(false);
    }
  }

  auth
    .getState()
    .then((state) => {
      applyState(state);
    })
    .catch((err) => {
      console.error("UrbanoAuth: failed to resolve initial state:", err);
      // Fail open to the signed-out control rather than leaving the
      // button permanently hidden if state resolution itself errors.
      renderSignedOut(false);
    });

  // The signed-in person changed under a header that was naming someone (another tab signed in as somebody else, or the session
  // ended): the old name must not stay on screen while the new person is resolved, and the resolved state is applied even if it is
  // the same KIND of state (authenticated -> authenticated is a different person).
  let identityChangedUnderHeader = false;
  if (typeof auth.onIdentityReset === "function") {
    auth
      .onIdentityReset(() => {
        if (shownStatus !== "authenticated") return;
        identityChangedUnderHeader = true;
        shownDisplayName = "…";
        paintSignedInLabel();
      })
      .catch(() => {});
  }

  // Keep the header truthful when the session changes elsewhere (another
  // tab signs out, the session expires): signed out stays signed out.
  auth
    .onAuthStateChange(() => {
      auth
        .getState()
        .then((state) => {
          if (identityChangedUnderHeader) {
            identityChangedUnderHeader = false;
            applyState(state);
            return;
          }
          // Only a real transition resets the journey: an event that leaves
          // the header unchanged (initial session, refocus) must never wipe a
          // code the person is in the middle of entering.
          if (state.status === shownStatus) return;
          if (state.status === "unauthenticated") renderSignedOut(false);
          else if (state.status === "profile_incomplete") renderSignedOut(true);
        })
        .catch(() => {});
    })
    // If the Auth client cannot be loaded at all (the library's CDN is unreachable), registering fails; the header already fails open
    // to the signed-out control above, so this is not an error worth an unhandled rejection.
    .catch(() => {});
}
