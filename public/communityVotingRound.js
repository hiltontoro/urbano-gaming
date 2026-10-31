// URBANO Gaming — Halloween Community Voting, two-round pilot: the voter page's logic.
//
// Pure functions and small injected-dependency helpers (no DOM; the network, the clock, the storage and the location sensor are all
// ARGUMENTS), so the exact deployed text is unit-tested. Everything here is a CONVENIENCE for the person voting: which step to show,
// what to remember across a sign-in, how to run one vote. The rules that decide whether a vote counts live on the server and in the
// database; nothing on this page can make an invalid vote valid, and nothing here can see a total, a rank or a count of votes — the
// server never sends one to a voter.
//
// Identity (UG-IV-GATE-004A): a Supabase session with a CONFIRMED EMAIL plus a Gaming Member profile, through the platform's existing
// seam (public/urbanoAuth.js). No telephone, WhatsApp or SMS step exists on this page, and Instagram is only a link that brings people
// here; nothing is read from it.
//
// Location: the PRELIMINARY is voted from anywhere and this page never asks the browser for a position there. The FINAL asks for one
// with every vote and every revision. The decision comes from the server's answer (`locationRequired`), never from the page itself.
//
// Time: every time shown is the EVENT'S (America/Tegucigalpa), never the phone's, and the remaining time is judged against the SERVER's
// clock. A round that is scheduled but has not been opened by the operator is shown as exactly that — "programada", not "abierta".

const CommunityVotingRound = (() => {
  const toNum = (v) => (Number.isFinite(v) ? v : 0);
  const toInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const EVENT_TIME_ZONE = "America/Tegucigalpa";

  // ---------------------------------------------------------------- messages

  const MESSAGES = {
    AUTHENTICATION_REQUIRED: "Inicia sesión con tu correo para continuar.",
    VERIFIED_EMAIL_REQUIRED: "Necesitas verificar tu correo electrónico para votar.",
    PROFILE_INCOMPLETE: "Antes de votar, completa tu perfil de URBANO Gaming.",
    INSTANCE_NOT_FOUND: "No encontramos esta votación. Revisa el enlace.",
    NOT_BOUND: "Primero entra a la votación con tu correo.",
    ADMISSION_CLOSED: "Ya no se admiten nuevos votantes en este momento.",
    NOT_A_ROUND: "Este enlace no corresponde a esta votación.",
    VOTING_NOT_OPEN: "La votación no está abierta.",
    VOTING_WINDOW_ELAPSED: "El tiempo de la votación terminó. Tu voto no se pudo registrar ni cambiar.",
    CANDIDATE_NOT_AVAILABLE: "Ese disfraz ya no está disponible. Elige otro.",
    SELF_VOTE_NOT_ALLOWED: "No puedes votar por tu propio disfraz. Elige otro.",
    INTERACTION_MISMATCH: "La votación cambió. Recarga la página.",
    INTENT_UNISSUED: "No pudimos preparar tu voto. Inténtalo de nuevo.",
    INTENT_BINDING_MISMATCH: "No pudimos preparar tu voto. Recarga la página.",
    INTENT_PAYLOAD_MISMATCH: "Este envío ya se usó para otro voto. Recarga la página.",
    STALE_INTENT: "Ya enviaste un voto más reciente desde otro lugar. Recarga para ver cuál quedó.",
    STALE_ACTION: "La pantalla cambió mientras se tomaba tu ubicación: no se envió ningún voto.",
    INVALID_LOCATION_READING: "No pudimos leer tu ubicación. Activa la ubicación del teléfono e inténtalo de nuevo.",
    LOCATION_ACCURACY_EXCESSIVE: "Tu ubicación no es lo bastante precisa. Sal a un lugar abierto y vuelve a intentarlo.",
    LOCATION_OUTSIDE: "Para votar en la final debes estar en el evento.",
    LOCATION_AMBIGUOUS: "No pudimos confirmar que estás en el evento. Acércate y vuelve a intentarlo.",
    LOCATION_DENIED: "Para votar en la final necesitamos tu ubicación. Permite el acceso a la ubicación y vuelve a intentarlo.",
    LOCATION_UNAVAILABLE: "No pudimos obtener tu ubicación. Inténtalo de nuevo en un momento.",
    LOCATION_TIMEOUT: "La ubicación tardó demasiado. Inténtalo de nuevo.",
    LOCATION_UNSUPPORTED: "Este dispositivo no permite obtener la ubicación, que la final necesita.",
    CLAIM_INVALID: "Ese código de concursante no es válido. Pide uno nuevo al operador.",
    CLAIM_EXPIRED: "Ese código de concursante venció. Pide uno nuevo al operador.",
    CLAIM_RATE_LIMITED: "Demasiados códigos incorrectos. Habla con el operador.",
    CONTESTANT_ALREADY_HAS_ENTRY: "Ya tienes una participación registrada en este concurso.",
    PREPARATION_CLOSED: "La preparación del concurso ya terminó.",
    NETWORK: "No hay conexión. Tu voto todavía no se confirmó; inténtalo de nuevo.",
    INVALID_REQUEST: "Algo en la solicitud no es válido. Inténtalo de nuevo.",
    INTERNAL_ERROR: "Algo salió mal de nuestro lado. Inténtalo de nuevo en un momento.",
  };

  function describeError(code) {
    return (typeof code === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) || "No pudimos completar la acción. Inténtalo de nuevo.";
  }

  // ---------------------------------------------------------------- identity: which step is next

  /**
   * The step the person is at, from the identity seam's state ("unauthenticated" | "profile_incomplete" | "authenticated"). The page
   * calls verifyOtp ONLY from SIGN_IN, i.e. only when there is no session at all, so a session is never replaced behind the person's back;
   * to use another account they must choose to sign out first.
   */
  function identityStep(authStatus) {
    if (authStatus === "authenticated") return "READY";
    if (authStatus === "profile_incomplete") return "PROFILE";
    return "SIGN_IN";
  }

  /** The step an API refusal sends the person back to, or null when it is not an identity refusal. */
  function stepForError(code) {
    if (code === "PROFILE_INCOMPLETE") return "PROFILE";
    if (code === "AUTHENTICATION_REQUIRED" || code === "VERIFIED_EMAIL_REQUIRED") return "SIGN_IN";
    return null;
  }

  const PROFILE_NOTICE =
    "Para votar necesitas completar tu perfil de URBANO Gaming. Solo te pedimos el nombre con el que quieres aparecer; tu voto sigue siendo privado.";
  const SIGN_IN_NOTICE = "Para votar entras con tu correo: te enviamos un código y lo escribes aquí. No hace falta teléfono.";

  /**
   * How a TEST event (a rehearsal) announces itself on the voter page and the venue screen. The words are the same as the operator page's
   * (a test pins that they agree) and they are shown whenever the server says the round is a test, in every state.
   */
  const TEST_EVENT_LABEL = "EVENTO DE PRUEBA";
  const TEST_EVENT_NOTICE = "Es un ensayo: lo que pasa aquí no es el evento real ni cuenta como su resultado.";

  // ---------------------------------------------------------------- what to remember across a sign-in

  const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

  /**
   * The contestant the person had chosen when they were sent to sign in or complete their profile, so they land back on it. It stores
   * the contestant's public NUMBER only, in the tab's own session storage, and it is only ever used to HIGHLIGHT: choosing still needs
   * the person's own confirmation. Every storage access is guarded; without storage the page works, it just forgets.
   */
  function createPendingSelection(storage, instanceId, now) {
    const key = `cv:round:pending:${instanceId}`;
    const clock = now || (() => Date.now());
    const read = () => {
      try {
        const parsed = JSON.parse(storage.getItem(key) || "null");
        if (!parsed || typeof parsed.alias !== "string" || !/^[0-9]{4}$/.test(parsed.alias) || !Number.isFinite(parsed.at)) return null;
        if (clock() - parsed.at > PENDING_TTL_MS) return null;
        return parsed;
      } catch (e) {
        return null;
      }
    };
    return {
      get: () => (read() ? read().alias : null),
      set(alias) {
        if (typeof alias !== "string" || !/^[0-9]{4}$/.test(alias)) return false;
        try {
          storage.setItem(key, JSON.stringify({ alias, at: clock() }));
          return true;
        } catch (e) {
          return false;
        }
      },
      clear() {
        try {
          storage.removeItem(key);
        } catch (e) {
          /* nothing to forget */
        }
      },
    };
  }

  /**
   * After sign-in / profile the page may resume on the contestant the person had chosen — when it is SAFE to: the round is open, the
   * contestant is still shown, it is not the person's own, and it is not already their vote. Returns the item to highlight, or null.
   */
  function resumeSelection(pendingAlias, items, phase, myCandidateId) {
    if (!pendingAlias || phase !== "OPEN" || !Array.isArray(items)) return null;
    const item = items.find((i) => i.alias === pendingAlias);
    if (!item || item.mine || !item.candidateId) return null;
    if (myCandidateId && item.candidateId === myCandidateId) return null;
    return item;
  }

  // ---------------------------------------------------------------- time: the server's clock, a monotonic counter

  /**
   * A countdown that starts from the SERVER's remaining time and is advanced by a monotonic clock, never by the phone's wall clock. It is
   * a display; the database refuses a vote after the deadline whatever this says. `resync` replaces the base with a fresher server answer.
   */
  function createCountdown(initialRemainingMs, monotonicNow) {
    const now = monotonicNow || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    let base = Number.isFinite(initialRemainingMs) ? Math.max(0, initialRemainingMs) : null;
    let at = now();
    return {
      remaining() {
        if (base === null) return null;
        return Math.max(0, base - (now() - at));
      },
      resync(remainingMs) {
        base = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : null;
        at = now();
      },
      expired() {
        const r = this.remaining();
        return r !== null && r <= 0;
      },
    };
  }

  /** m:ss, or h:mm:ss from one hour up. */
  function formatCountdown(ms) {
    const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
    const pad = (n) => String(n).padStart(2, "0");
    return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
  }

  /** The time left until the deadline as the server last reported it, or null when there is no deadline to show. */
  function deadlineRemainingText(info) {
    if (!info || info.deadlineRemainingMs === null || info.deadlineRemainingMs === undefined || !Number.isFinite(info.deadlineRemainingMs)) return null;
    return formatCountdown(info.deadlineRemainingMs);
  }

  /** A time of day (HH:MM, 24 hours) in the EVENT's zone, whatever the phone's; "" when absent or not a date. */
  function formatEventTime(iso) {
    if (typeof iso !== "string" || iso.length === 0 || Number.isNaN(Date.parse(iso))) return "";
    try {
      return new Intl.DateTimeFormat("es-HN", { timeZone: EVENT_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    } catch (e) {
      return "";
    }
  }

  /**
   * What the banner says. A round that is merely SCHEDULED is not open: it says when it is planned and that the operator has not
   * opened it yet. A round that is OPEN says that, and when it stops. The times are the event's.
   */
  function phaseNotice(info) {
    const phase = info && info.phase;
    const final = !!(info && info.roundRole === "FINAL");
    if (phase === "OPEN") {
      const until = formatEventTime(info.deadlineAt);
      const stops = until ? ` Cierra a las ${until} (hora de Honduras).` : "";
      return final
        ? `La final está abierta. Elige a tu favorito entre los finalistas: puedes cambiar tu voto mientras dure el tiempo.${stops}`
        : `La votación está abierta. Elige a tu favorito: puedes cambiar tu voto hasta que cierre.${stops}`;
    }
    if (phase === "CLOSED") return "La votación está cerrada. Gracias por participar.";
    if (phase === "ENDED") return "Este evento ya terminó. Gracias por participar.";
    const planned = formatEventTime(info && (info.scheduledOpensAt || info.votingOpensAt));
    if (planned) {
      return `La ${final ? "final" : "votación"} está programada para las ${planned} (hora de Honduras), pero aún no está abierta: la abre el equipo del evento.${info.tentative ? " El horario es tentativo hasta que se confirme." : ""}`;
    }
    return info && info.tentative
      ? "La votación aún no está abierta. Los horarios son tentativos hasta que se confirmen."
      : "La votación aún no está abierta. Vuelve en unos minutos.";
  }

  // ---------------------------------------------------------------- the deck and the grid

  /**
   * Which rows of a fixed-row-height grid to draw for the current scroll position. Only the visible rows plus a small overscan are
   * rendered; the padding above and below stands in for the rest, so the scroll bar still represents the whole list.
   */
  function computeVirtualWindow(o) {
    const total = toInt(o.total);
    const columns = Math.max(1, toInt(o.columns));
    const rowHeight = Math.max(1, toNum(o.rowHeight) > 0 ? toNum(o.rowHeight) : 1);
    const viewportHeight = Math.max(0, toNum(o.viewportHeight));
    const overscan = Math.max(0, toInt(o.overscanRows === undefined ? 2 : o.overscanRows));
    const totalRows = Math.ceil(total / columns);
    const totalHeight = totalRows * rowHeight;
    const maxScroll = Math.max(0, totalHeight - viewportHeight);
    const scrollTop = Math.min(Math.max(0, toNum(o.scrollTop)), maxScroll);

    const firstVisibleRow = Math.floor(scrollTop / rowHeight);
    const lastVisibleRow = Math.min(Math.max(0, totalRows - 1), Math.floor((scrollTop + Math.max(0, viewportHeight - 1)) / rowHeight));
    const firstRow = totalRows === 0 ? 0 : Math.max(0, firstVisibleRow - overscan);
    const lastRow = totalRows === 0 ? 0 : Math.min(totalRows, lastVisibleRow + 1 + overscan);
    return {
      firstRow,
      lastRow,
      firstIndex: firstRow * columns,
      lastIndex: Math.min(total, lastRow * columns),
      topPadding: firstRow * rowHeight,
      bottomPadding: (totalRows - lastRow) * rowHeight,
      totalRows,
      totalHeight,
    };
  }

  /** Next/previous card, wrapping around so discovery never dead-ends. */
  function deckNavigate(index, delta, total) {
    const n = toInt(total);
    if (n === 0) return 0;
    const i = Math.min(Math.max(toInt(index), 0), n - 1);
    return (((i + toNum(delta)) % n) + n) % n;
  }

  /** A mostly-horizontal drag longer than `minDistance` is a swipe; a tap, a short drag or a vertical scroll is not. */
  function swipeIntent(o) {
    const min = o.minDistance === undefined ? 60 : o.minDistance;
    const dx = toNum(o.dx);
    const dy = toNum(o.dy);
    if (Math.abs(dx) < min || Math.abs(dy) > Math.abs(dx)) return null;
    return dx < 0 ? "next" : "prev";
  }

  // ---------------------------------------------------------------- location (final only)

  /** Does THIS round need a position with the vote? Only what the server says: a page cannot decide it. */
  function locationRequired(info) {
    return !!(info && info.locationRequired === true);
  }

  /**
   * One position reading, or a rejection carrying a code from MESSAGES. Fresh (never a cached position), bounded in time. The result is
   * sent in the body of the vote POST and nowhere else; it is never stored, logged or put in a URL.
   */
  function readPosition(geolocation, options) {
    const timeout = (options && options.timeoutMs) || 12000;
    // The browser's own `timeout` starts only AFTER the person answers the permission prompt, so a prompt nobody answers would leave the
    // vote waiting forever; this wall-clock limit (the browser's timeout plus time to answer) ends it, and whatever arrives later is ignored.
    const grace = options && Number.isFinite(options.promptGraceMs) ? options.promptGraceMs : 45000;
    const setTimer = (options && options.setTimer) || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = (options && options.clearTimer) || ((handle) => clearTimeout(handle));
    return new Promise((resolve, reject) => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") return reject({ code: "LOCATION_UNSUPPORTED" });
      let settled = false;
      let timer = null;
      const finish = (settle, value) => {
        if (settled) return; // a callback that arrives after the answer, the refusal or the time limit changes nothing
        settled = true;
        if (timer !== null) clearTimer(timer);
        settle(value);
      };
      timer = setTimer(() => finish(reject, { code: "LOCATION_TIMEOUT" }), timeout + grace);
      geolocation.getCurrentPosition(
        (position) => {
          const c = position && position.coords;
          if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) || !Number.isFinite(c.accuracy)) return finish(reject, { code: "LOCATION_UNAVAILABLE" });
          finish(resolve, { latitude: c.latitude, longitude: c.longitude, accuracyMeters: c.accuracy });
        },
        (error) => finish(reject, { code: error && error.code === 1 ? "LOCATION_DENIED" : error && error.code === 3 ? "LOCATION_TIMEOUT" : "LOCATION_UNAVAILABLE" }),
        { enableHighAccuracy: true, timeout, maximumAge: 0 }
      );
    });
  }

  // ---------------------------------------------------------------- one vote, start to finish

  /**
   * Runs ONE vote (or one revision): bind (idempotent), take a fresh server-issued intent, read the position ONLY when the round needs
   * one, and send the vote. The vote is confirmed ONLY when the server answered 200; nothing is shown as accepted before that.
   *
   * A lost response (network error on the vote) is not a failure and not a success: the result carries `retry`, the SAME intent, which
   * the server answers as a replay if it had been applied and applies if it had not — so retrying can never duplicate or fabricate a vote.
   */
  async function castFavorite(deps) {
    const { api, geolocation, info, candidateId, interactionInstanceId, retry, isCurrent } = deps;
    // A position can arrive long after the tap that asked for it (the person answers the prompt late, signs out, taps something else).
    // `isCurrent` says whether the page is still where the tap happened; when it is not, NOTHING is sent: no bind, no intent, no vote.
    const stale = () => typeof isCurrent === "function" && !isCurrent();
    const staleResult = () => ({ ok: false, code: "STALE_ACTION", stale: true, retry: retry || null });
    let location = null;
    if (locationRequired(info)) {
      try {
        location = await readPosition(geolocation);
      } catch (e) {
        return { ok: false, code: (e && e.code) || "LOCATION_UNAVAILABLE", retry: retry || null };
      }
      if (stale()) return staleResult();
    }

    let bindingId;
    let intentNo;
    if (retry && retry.candidateId === candidateId && retry.interactionInstanceId === interactionInstanceId) {
      bindingId = retry.bindingId;
      intentNo = retry.intentNo;
    } else {
      const bound = await api.bind();
      if (stale()) return staleResult();
      if (bound.status !== 200 && bound.status !== 201) return { ok: false, code: (bound.json && bound.json.code) || "NETWORK", status: bound.status };
      bindingId = bound.json.bindingId;
      const issued = await api.intent();
      if (stale()) return staleResult();
      if (issued.status !== 201) return { ok: false, code: (issued.json && issued.json.code) || "NETWORK", status: issued.status };
      intentNo = issued.json.intentNo;
    }

    const body = { bindingId, intentNo, interactionInstanceId, candidateId };
    if (location) body.location = location;
    const cast = await api.vote(body);
    if (cast.status === 200 && cast.json && (cast.json.outcome === "APPLIED" || cast.json.outcome === "UNCHANGED" || cast.json.outcome === "REPLAYED")) {
      return { ok: true, outcome: cast.json.outcome, candidateId: cast.json.candidateId };
    }
    if (cast.status === 0) return { ok: false, code: "NETWORK", retry: { bindingId, intentNo, candidateId, interactionInstanceId } };
    return { ok: false, code: (cast.json && cast.json.code) || "INTERNAL_ERROR", status: cast.status, current: (cast.json && cast.json.current) || null };
  }

  // ---------------------------------------------------------------- the API

  /** A thin client for the pilot's routes. Every call returns { status, json }; it never throws on an HTTP error. */
  function buildApi(fetchImpl, getToken, instanceId) {
    const base = `/api/gaming/community-voting/rounds/${instanceId}`;
    async function call(path, method, body, authed) {
      const headers = { "Content-Type": "application/json" };
      if (authed) {
        const token = await getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      try {
        const response = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let json = null;
        try {
          json = await response.json();
        } catch (e) {
          json = null;
        }
        return { status: response.status, json };
      } catch (e) {
        return { status: 0, json: { code: "NETWORK" } };
      }
    }
    return {
      info: () => call("/info", "GET", undefined, false),
      results: () => call("/results", "GET", undefined, false),
      bind: () => call("/binding", "POST", {}, true),
      status: () => call("/status", "GET", undefined, true),
      gallery: () => call("/gallery", "GET", undefined, true),
      intent: () => call("/intents", "POST", {}, true),
      vote: (body) => call("/votes", "POST", body, true),
      claim: (claimCode) => call("/claims", "POST", { claimCode }, true),
    };
  }


  // ---------------------------------------------------------------- live state: how soon a page learns what the server decided (UG-IV-GATE-014)

  // ---- createPoller:begin (the SAME text in communityVotingRoundOperator.js and communityVotingRound.js: a test pins that the two copies are identical)
  /**
   * A self-scheduling poll with every guarantee a live page needs and none of its DOM. Every collaborator is an ARGUMENT (the clock, the
   * timers, the page's visibility, the request itself), so the timing is unit-tested without waiting.
   *   - ONE request at a time. A timer, a return to the page and refreshNow() that arrive while one is out make ONE follow-up, never two requests.
   *   - The next poll is scheduled only AFTER the previous one finished, so polls can never pile up.
   *   - An answer is used only while it is still the newest: invalidate() (an authoritative read made elsewhere) and stop() (another person,
   *     another round, a sign-out) make whatever is in flight unusable — it is dropped when it arrives, never applied.
   *   - Nothing runs while the page is hidden; becoming visible again refreshes at once.
   *   - Failures back off (x2, capped) and data older than staleAfterMs is reported stale, so a page can SAY so instead of presenting it as current.
   * fetchOnce() resolves { ok, apply?, terminal? }. apply() runs ONLY if the answer is still wanted; terminal ends the loop (the connection itself was refused).
   */
  function createPoller(deps) {
    const staleAfterMs = deps.staleAfterMs === undefined ? 15000 : deps.staleAfterMs;
    const jitter = deps.jitter === undefined ? 0.2 : deps.jitter;
    const maxBackoffMs = deps.maxBackoffMs === undefined ? 30000 : deps.maxBackoffMs;
    let running = false;
    let terminal = false;
    let generation = 0;
    let sequence = 0;
    let timer = null;
    let flight = null;
    let queued = false;
    let failures = 0;
    let startedAt = 0;
    let lastOkAt = null;

    function notify() {
      if (typeof deps.onStatus !== "function") return;
      try {
        deps.onStatus();
      } catch (e) {
        /* a listener never stops the loop */
      }
    }
    function cancelTimer() {
      if (timer === null) return;
      deps.clearTimer(timer);
      timer = null;
    }
    function schedule() {
      cancelTimer();
      if (!running || flight !== null || !deps.isVisible()) return;
      const base = deps.delayFor({ failures });
      if (base === null || base === undefined) return;
      const backedOff = Math.min(maxBackoffMs, base * Math.pow(2, Math.min(failures, 4)));
      const factor = 1 + (deps.random() * 2 - 1) * jitter;
      timer = deps.setTimer(() => {
        timer = null;
        run();
      }, Math.round(backedOff * factor));
    }
    async function run() {
      if (!running) return;
      if (flight !== null) {
        queued = true;
        return;
      }
      cancelTimer();
      queued = false;
      sequence += 1;
      const mine = { generation, sequence };
      flight = mine;
      notify();
      let result;
      try {
        result = await deps.fetchOnce();
      } catch (e) {
        result = { ok: false };
      }
      settle(mine, result || { ok: false });
    }
    function settle(mine, result) {
      if (flight === mine) flight = null;
      if (mine.generation !== generation) return; // stopped (and perhaps started again) meanwhile: this answer is no longer ours
      if (mine.sequence === sequence) {
        // still the newest request: its answer is wanted
        if (result.ok) {
          failures = 0;
          lastOkAt = deps.now();
          if (typeof result.apply === "function") {
            try {
              const applied = result.apply();
              if (applied && typeof applied.then === "function") applied.then(null, () => {});
            } catch (e) {
              /* the page's own error handling decides what to show */
            }
          }
        } else {
          failures += 1;
          if (result.terminal) {
            terminal = true;
            running = false;
          }
        }
      }
      notify();
      if (!running) return;
      if (queued) {
        queued = false;
        run();
        return;
      }
      schedule();
    }
    return {
      start() {
        generation += 1;
        sequence += 1;
        running = true;
        terminal = false;
        flight = null;
        queued = false;
        failures = 0;
        startedAt = deps.now();
        lastOkAt = null;
        cancelTimer();
        notify();
        schedule();
      },
      stop() {
        generation += 1;
        running = false;
        flight = null;
        queued = false;
        cancelTimer();
        notify();
      },
      refreshNow() {
        run();
      },
      invalidate() {
        sequence += 1;
      },
      markFresh() {
        lastOkAt = deps.now();
        failures = 0;
        if (running && flight === null) schedule(); // the next delay follows the state that was just read
        notify();
      },
      onVisibility(visible) {
        if (!running) return;
        if (visible) {
          run();
          return;
        }
        cancelTimer();
        notify();
      },
      status() {
        const age = running ? deps.now() - (lastOkAt === null ? startedAt : lastOkAt) : null;
        return { running, refreshing: flight !== null, failures, stale: running && age > staleAfterMs, ageMs: age, terminal, hidden: !deps.isVisible() };
      },
    };
  }
  // ---- createPoller:end

  /**
   * How often a public page asks for the round's state (before jitter and backoff). The window of a FINAL is only five minutes, so it is asked
   * often; a preliminary lasts hours and may have a crowd, so it is asked less. After a close the publication is expected soon, so the page
   * asks quickly for a few minutes and then settles; once published there is little left to learn. Bounded: never faster than 5 s.
   */
  const POLL = { finalOpenMs: 5000, finalWaitMs: 8000, openMs: 15000, waitMs: 20000, afterCloseMs: 6000, afterCloseWindowMs: 180000, settledMs: 20000, publishedMs: 60000, staleAfterMs: 30000 };

  function pollDelayMs(ctx) {
    const c = ctx || {};
    const final = c.roundRole === "FINAL";
    if (c.phase === "OPEN") return final ? POLL.finalOpenMs : POLL.openMs;
    if (c.phase === "NOT_OPEN") return final ? POLL.finalWaitMs : POLL.waitMs;
    if (c.phase === "CLOSED" || c.phase === "ENDED") {
      if (c.published) return POLL.publishedMs;
      return toNum(c.sinceChangeMs) < POLL.afterCloseWindowMs ? POLL.afterCloseMs : POLL.settledMs;
    }
    return POLL.settledMs; // an unknown phase: the slow, safe delay
  }

  return {
    describeError,
    identityStep,
    stepForError,
    PROFILE_NOTICE,
    SIGN_IN_NOTICE,
    TEST_EVENT_LABEL,
    TEST_EVENT_NOTICE,
    createPendingSelection,
    resumeSelection,
    createCountdown,
    formatCountdown,
    deadlineRemainingText,
    formatEventTime,
    EVENT_TIME_ZONE,
    phaseNotice,
    computeVirtualWindow,
    deckNavigate,
    swipeIntent,
    locationRequired,
    readPosition,
    castFavorite,
    createPoller,
    POLL,
    pollDelayMs,
    buildApi,
    toNum,
  };
})();
