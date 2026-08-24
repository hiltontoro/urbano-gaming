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
// Only the anon key is ever used in this file — never service_role.

const UrbanoAuth = (() => {
  const SUPABASE_JS_CDN_URL =
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";

  let clientPromise = null;

  // undefined = not yet resolved against the server this page load;
  // null = resolved, no completed profile yet; object = resolved,
  // complete. Invalidated (reset to undefined) on every Auth state
  // change so a fresh sign-in / sign-out always re-resolves rather than
  // serving a stale cached profile.
  let cachedGamingMember = undefined;

  let authChangeCallbacks = [];

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

        client.auth.onAuthStateChange((_event, _session) => {
          cachedGamingMember = undefined;
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
        });

        return client;
      })();
    }
    return clientPromise;
  }

  async function fetchGamingMemberProfile(accessToken) {
    const response = await fetch("/api/gaming/member", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.gamingMember ?? null;
  }

  const api = {
    /**
     * Resolves the current Gaming Auth state:
     *   { status: "unauthenticated" }
     *   { status: "profile_incomplete", email }
     *   { status: "authenticated", email, gamingMemberId, displayName }
     */
    async getState() {
      const client = await getClient();
      const { data } = await client.auth.getSession();
      const session = data && data.session;

      if (!session) {
        return { status: "unauthenticated" };
      }

      if (cachedGamingMember === undefined) {
        cachedGamingMember = await fetchGamingMemberProfile(
          session.access_token
        );
      }

      if (!cachedGamingMember) {
        return { status: "profile_incomplete", email: session.user.email };
      }

      return {
        status: "authenticated",
        email: session.user.email,
        gamingMemberId: cachedGamingMember.gamingMemberId,
        displayName: cachedGamingMember.displayName,
      };
    },

    async isAuthenticated() {
      const state = await this.getState();
      return state.status === "authenticated";
    },

    /** Requests a one-time code be emailed to `email`. */
    async requestOtp(email) {
      const client = await getClient();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) {
        return { status: "error", message: error.message };
      }
      return { status: "sent" };
    },

    /**
     * Verifies a one-time code. On success, resolves the Gaming Member
     * profile through this app's own API and reports whether it is
     * already complete (returning member) or still needs display_name
     * collection (first-time member) — never creates a Gaming Member
     * itself.
     */
    async verifyOtp(email, code) {
      const client = await getClient();
      const { data, error } = await client.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });

      if (error || !data || !data.session) {
        return {
          status: "error",
          message: error ? error.message : "Verification failed.",
        };
      }

      cachedGamingMember = await fetchGamingMemberProfile(
        data.session.access_token
      );

      if (!cachedGamingMember) {
        return { status: "profile_incomplete", email };
      }

      return {
        status: "authenticated",
        email,
        gamingMemberId: cachedGamingMember.gamingMemberId,
        displayName: cachedGamingMember.displayName,
      };
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
        return { status: "error", message: "Not signed in." };
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
          message: body.error || "Failed to complete profile.",
        };
      }

      cachedGamingMember = body.gamingMember;
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
      cachedGamingMember = undefined;
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
     * Wires a "Sign in with URBANO" button to the real sign-in flow.
     * Deliberately builds its own minimal inline panel rather than
     * requiring each of the five pages that call this to carry their
     * own sign-in markup — "use the existing shell seam," not a
     * redesign of any page.
     */
    attachSignInButton(buttonEl, statusEl) {
      if (!buttonEl) return;
      createSignInPanel(this, buttonEl, statusEl);
    },
  };

  return api;
})();

/**
 * Builds and wires the minimal inline sign-in panel: email -> Send Code
 * -> verification code -> verify -> (first-time only) display name ->
 * signed in. Kept as a plain function outside the UrbanoAuth object
 * (rather than a method) so it can freely close over its own
 * panel-local DOM state without polluting the public API surface.
 */
function createSignInPanel(auth, buttonEl, statusEl) {
  // Resolving the real Auth state takes two network round-trips
  // (GET /api/gaming/config, then loading the Supabase client from its
  // CDN) before getState() can even check the — otherwise instant —
  // local session. Rather than let the button sit on its static HTML
  // default ("Sign in with URBANO") for that whole window only to flip
  // to "Hi, {name}" once resolved, hide it immediately and reveal the
  // correct state once known. visibility (not display) keeps its
  // layout space reserved, so nothing else in the header reflows when
  // it reappears.
  buttonEl.style.visibility = "hidden";

  const panel = document.createElement("div");
  panel.setAttribute("data-urbano-signin-panel", "");
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

  let email = "";
  let step = "email"; // email | code | displayName
  let panelOpen = false;

  function setPanelMessage(message, isError) {
    const el = panel.querySelector("[data-msg]");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#b3261e" : "#555";
  }

  function openPanel() {
    panelOpen = true;
    panel.style.display = "block";
    renderStep();
  }

  function closePanel() {
    panelOpen = false;
    panel.style.display = "none";
  }

  function renderStep() {
    if (step === "email") {
      panel.innerHTML = `
        <div style="margin-bottom:8px;font-weight:600;">Sign in with URBANO</div>
        <input data-email type="email" placeholder="you@example.com"
          style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:6px;" />
        <button data-send style="width:100%;padding:8px;border-radius:6px;border:none;background:#111;color:#fff;cursor:pointer;">Send Code</button>
        <p data-msg style="margin:8px 0 0;min-height:16px;"></p>
      `;
      const emailInput = panel.querySelector("[data-email]");
      emailInput.value = email;
      panel.querySelector("[data-send]").addEventListener("click", async () => {
        const value = emailInput.value.trim();
        if (!value) {
          setPanelMessage("Enter your email address.", true);
          return;
        }
        setPanelMessage("Sending code...");
        const result = await auth.requestOtp(value);
        if (result.status === "error") {
          setPanelMessage(result.message, true);
          return;
        }
        email = value;
        step = "code";
        renderStep();
      });
    } else if (step === "code") {
      panel.innerHTML = `
        <div style="margin-bottom:8px;font-weight:600;">Enter your code</div>
        <div style="margin-bottom:8px;color:#555;">Sent to ${email}</div>
        <input data-code type="text" inputmode="numeric" placeholder="Verification code"
          style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:6px;" />
        <button data-verify style="width:100%;padding:8px;border-radius:6px;border:none;background:#111;color:#fff;cursor:pointer;">Verify</button>
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <a data-resend href="#" style="font-size:12px;">Resend code</a>
          <a data-back href="#" style="font-size:12px;">Use a different email</a>
        </div>
        <p data-msg style="margin:8px 0 0;min-height:16px;"></p>
      `;
      const codeInput = panel.querySelector("[data-code]");
      panel.querySelector("[data-verify]").addEventListener("click", async () => {
        const code = codeInput.value.trim();
        if (!code) {
          setPanelMessage("Enter the code from your email.", true);
          return;
        }
        setPanelMessage("Verifying...");
        const result = await auth.verifyOtp(email, code);
        if (result.status === "error") {
          setPanelMessage(result.message, true);
          return;
        }
        if (result.status === "profile_incomplete") {
          step = "displayName";
          renderStep();
          return;
        }
        closePanel();
        renderSignedIn(result);
      });
      panel.querySelector("[data-resend]").addEventListener("click", async (e) => {
        e.preventDefault();
        setPanelMessage("Resending code...");
        const result = await auth.requestOtp(email);
        setPanelMessage(
          result.status === "error" ? result.message : "Code resent."
        );
      });
      panel.querySelector("[data-back]").addEventListener("click", (e) => {
        e.preventDefault();
        step = "email";
        renderStep();
      });
    } else if (step === "displayName") {
      panel.innerHTML = `
        <div style="margin-bottom:8px;font-weight:600;">Choose your display name</div>
        <input data-display-name type="text" maxlength="40" placeholder="How you'll appear in games"
          style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:6px;" />
        <button data-continue style="width:100%;padding:8px;border-radius:6px;border:none;background:#111;color:#fff;cursor:pointer;">Continue</button>
        <p data-msg style="margin:8px 0 0;min-height:16px;"></p>
      `;
      const nameInput = panel.querySelector("[data-display-name]");
      panel.querySelector("[data-continue]").addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) {
          setPanelMessage("Enter a display name.", true);
          return;
        }
        setPanelMessage("Saving...");
        const result = await auth.completeProfile(name);
        if (result.status === "error") {
          setPanelMessage(result.message, true);
          return;
        }
        closePanel();
        renderSignedIn(result);
      });
    }
  }

  function renderSignedIn(state) {
    buttonEl.textContent = `Hi, ${state.displayName}`;
    buttonEl.style.visibility = "";
    buttonEl.onclick = null;
    let signOutLink = buttonEl.parentElement.querySelector(
      "[data-urbano-signout]"
    );
    if (!signOutLink) {
      signOutLink = document.createElement("a");
      signOutLink.setAttribute("data-urbano-signout", "");
      signOutLink.href = "#";
      signOutLink.textContent = "Sign out";
      signOutLink.style.cssText =
        "margin-left:8px;font-size:12px;color:inherit;";
      buttonEl.insertAdjacentElement("afterend", signOutLink);
    }
    signOutLink.style.display = "inline";
    signOutLink.onclick = async (e) => {
      e.preventDefault();
      await auth.signOut();
      renderSignedOut();
    };
    if (statusEl) {
      statusEl.style.display = "none";
    }
  }

  function renderSignedOut() {
    buttonEl.textContent = "Sign in with URBANO";
    buttonEl.style.visibility = "";
    const signOutLink = buttonEl.parentElement.querySelector(
      "[data-urbano-signout]"
    );
    if (signOutLink) signOutLink.style.display = "none";
    step = "email";
    email = "";
  }

  buttonEl.addEventListener("click", () => {
    if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.addEventListener("click", (e) => {
    if (
      panelOpen &&
      !panel.contains(e.target) &&
      e.target !== buttonEl
    ) {
      closePanel();
    }
  });

  auth
    .getState()
    .then((state) => {
      if (state.status === "authenticated") {
        renderSignedIn(state);
      } else {
        renderSignedOut();
      }
    })
    .catch((err) => {
      console.error("UrbanoAuth: failed to resolve initial state:", err);
      // Fail open to the signed-out control rather than leaving the
      // button permanently hidden if state resolution itself errors.
      renderSignedOut();
    });

  auth.onAuthStateChange(() => {
    auth
      .getState()
      .then((state) => {
        if (state.status !== "authenticated") {
          renderSignedOut();
        }
      })
      .catch(() => {});
  });
}
