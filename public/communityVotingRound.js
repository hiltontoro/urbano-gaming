// URBANO Gaming — Halloween Community Voting, the four-category contest: the voter page's logic.
//
// Pure functions and small injected-dependency helpers (no DOM; the network, the clock and the storage are all ARGUMENTS), so the exact
// deployed text is unit-tested. Everything here is a CONVENIENCE for the person voting: which step to show, what to remember across a sign-in,
// how to run one vote. The rules that decide whether a vote counts live on the server and in the database; nothing on this page can make an
// invalid vote valid, and nothing here can see a total, a rank or a count of votes — the server never sends one to a voter.
//
// Identity: a Supabase session with a CONFIRMED EMAIL plus a Gaming Member profile, through the platform's existing seam (public/urbanoAuth.js).
// No telephone, WhatsApp or SMS step exists on this page, and Instagram is only a link that brings people here; nothing is read from it.
//
// NO LOCATION: the contest is voted from anywhere, by people at the venue and by people who are not. This page has no code that reads a position,
// no location message and no request that carries a coordinate, and a test pins that.
//
// Time: every time shown is the EVENT'S (America/Tegucigalpa), never the phone's, and the remaining time is judged against the SERVER's
// clock. A category that is scheduled but has not been opened by the operator is shown as exactly that — "programada", not "abierta".

const CommunityVotingRound = (() => {
  const toNum = (v) => (Number.isFinite(v) ? v : 0);
  const toInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const EVENT_TIME_ZONE = "America/Tegucigalpa";

  // ---------------------------------------------------------------- messages

  const MESSAGES = {
    AUTHENTICATION_REQUIRED: "Iniciá sesión con tu correo para continuar.",
    VERIFIED_EMAIL_REQUIRED: "Necesitás verificar tu correo electrónico para continuar.",
    PROFILE_INCOMPLETE: "Antes de continuar, completá tu perfil de URBANO Gaming.",
    INSTANCE_NOT_FOUND: "No encontramos esta votación. Revisá el enlace.",
    CONTEST_NOT_FOUND: "No encontramos este concurso. Revisá el enlace.",
    ENTRY_NOT_FOUND: "No encontramos esa candidatura. Puede que todavía no sea pública.",
    NOT_BOUND: "Primero entrá al concurso con tu correo.",
    ADMISSION_CLOSED: "Ya no se admiten nuevos votantes en este momento.",
    NOT_A_ROUND: "Este enlace no corresponde a esta votación.",
    NOT_A_CATEGORY_ROUND: "Este enlace no corresponde a esta votación.",
    VOTING_NOT_OPEN: "La votación de esta categoría no está abierta.",
    VOTING_WINDOW_ELAPSED: "El tiempo de la votación terminó. Tu voto no se pudo registrar ni cambiar.",
    CANDIDATE_NOT_AVAILABLE: "Ese disfraz ya no está disponible. Elegí otro.",
    SELF_VOTE_NOT_ALLOWED: "No podés votar por tu propio disfraz ni por el de tu grupo. Elegí otro.",
    INTERACTION_MISMATCH: "La votación cambió. Recargá la página.",
    INTENT_UNISSUED: "No pudimos preparar tu voto. Intentalo de nuevo.",
    INTENT_BINDING_MISMATCH: "No pudimos preparar tu voto. Recargá la página.",
    INTENT_PAYLOAD_MISMATCH: "Este envío ya se usó para otro voto. Recargá la página.",
    STALE_INTENT: "Ya enviaste un voto más reciente desde otro lugar. Recargá para ver cuál quedó.",
    STALE_ACTION: "La pantalla cambió mientras se enviaba tu voto: no se envió ningún voto.",
    ALREADY_CANDIDATE: "Ya tenés una candidatura en el concurso. Cada persona participa una sola vez, en una sola categoría.",
    REGISTRATION_NOT_OPEN: "La inscripción todavía no abrió.",
    CUTOFF_PASSED: "La inscripción terminó. Ya no se aceptan nuevas candidaturas.",
    SCHEDULE_REQUIRED: "La inscripción todavía no tiene horario. Volvé más tarde.",
    PREPARATION_CLOSED: "La inscripción terminó. Ya no se aceptan nuevas candidaturas.",
    CONSENT_REQUIRED: "Marcá las confirmaciones que te pedimos para poder inscribirte.",
    NETWORK: "No hay conexión. Todavía no se confirmó; intentalo de nuevo.",
    INVALID_REQUEST: "Algo en lo que escribiste no es válido. Revisalo e intentalo de nuevo.",
    INTERNAL_ERROR: "Algo salió mal de nuestro lado. Intentalo de nuevo en un momento.",
  };

  function describeError(code) {
    return (typeof code === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) || "No pudimos completar la acción. Intentalo de nuevo.";
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

  const PROFILE_NOTICE = "Para participar necesitás completar tu perfil de URBANO Gaming. Solo te pedimos el nombre con el que querés aparecer.";
  const SIGN_IN_NOTICE = "Entrás con tu correo: te enviamos un código y lo escribís acá. No hace falta teléfono.";

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

  // America/Tegucigalpa is UTC-6 all year (no daylight saving time). The parts are computed from the instant, never from the phone's clock or zone.
  const HN_OFFSET_MS = 6 * 60 * 60 * 1000;
  const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  function eventParts(iso) {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const d = new Date(t - HN_OFFSET_MS);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
  const isMidnight = (p) => p.hour === 0 && p.minute === 0;
  const clock12 = (p) => `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${String(p.minute).padStart(2, "0")}`;

  /** A time of day in the EVENT's zone, in 12 hours: "11:00 p. m."; midnight is the word "medianoche". "" when absent or not a date. */
  function formatEventTime(iso) {
    const p = eventParts(iso);
    if (!p) return "";
    return isMidnight(p) ? "medianoche" : `${clock12(p)} ${p.hour < 12 ? "a. m." : "p. m."}`;
  }
  /** "a las 11:00 p. m." / "a medianoche": the time as a sentence needs it. */
  function atTime(iso) {
    const t = formatEventTime(iso);
    return t === "" ? "" : t === "medianoche" ? "a medianoche" : `a las ${t}`;
  }
  /** "hasta las 11:00 p. m." / "hasta medianoche". */
  function untilTime(iso) {
    const t = formatEventTime(iso);
    return t === "" ? "" : t === "medianoche" ? "hasta medianoche" : `hasta las ${t}`;
  }
  /** "8:00–11:00 p. m." when both ends share the meridiem; otherwise each end in full ("11:00 p. m.–medianoche"). "" when either is absent. */
  function formatEventRange(fromIso, toIso) {
    const a = eventParts(fromIso);
    const b = eventParts(toIso);
    if (!a || !b) return "";
    if (!isMidnight(a) && !isMidnight(b) && a.hour < 12 === b.hour < 12) return `${clock12(a)}–${clock12(b)} ${b.hour < 12 ? "a. m." : "p. m."}`;
    return `${formatEventTime(fromIso)}–${formatEventTime(toIso)}`;
  }
  /** "sábado 31 de octubre de 2026". */
  function formatEventDate(iso) {
    const p = eventParts(iso);
    return p ? `${WEEKDAYS[p.weekday]} ${p.day} de ${MONTHS[p.month]} de ${p.year}` : "";
  }
  /** "domingo 1 de noviembre". */
  function formatEventDayShort(iso) {
    const p = eventParts(iso);
    return p ? `${WEEKDAYS[p.weekday]} ${p.day} de ${MONTHS[p.month]}` : "";
  }
  /** "Inscripciones y fotos: 8:00–11:00 p. m." — "" when the plan is not configured: nothing is invented. */
  function registrationWindowText(opensIso, closesIso) {
    const range = formatEventRange(opensIso, closesIso);
    return range ? `Inscripciones y fotos: ${range}` : "";
  }
  /** "Votación: 11:00 p. m.–medianoche, entrando al domingo 1 de noviembre". */
  function votingWindowText(opensIso, closesIso) {
    const range = formatEventRange(opensIso, closesIso);
    if (!range) return "";
    const a = eventParts(opensIso);
    const b = eventParts(closesIso);
    const nextDay = a.day !== b.day || a.month !== b.month || a.year !== b.year;
    return `Votación: ${range}${nextDay ? `, entrando al ${formatEventDayShort(closesIso)}` : ""}`;
  }

  /**
   * What a CATEGORY's banner says. A category that is merely SCHEDULED is not open: it says when it is planned and that the team has not opened it
   * yet. An OPEN one says that, and when it stops. A closed one says so and, once published, that the results are in. The times are the event's.
   */
  function phaseNotice(info) {
    const phase = info && info.phase;
    if (phase === "OPEN") {
      const until = info.deadlineAt ? ` Cierra ${atTime(info.deadlineAt)} (hora de Honduras).` : "";
      return `La votación está abierta. Elegí a tu favorito: podés cambiar tu voto hasta que cierre.${until}`;
    }
    if (phase === "CLOSED") return info && info.published ? "La votación de esta categoría cerró y ya están los resultados." : "La votación de esta categoría cerró. Gracias por participar: los resultados se publican después de que el equipo los revise.";
    if (phase === "ENDED") return "El concurso ya terminó. Gracias por participar.";
    const planned = atTime(info && (info.scheduledOpensAt || info.votingOpensAt));
    if (planned) return `La votación todavía no está abierta: está prevista ${planned} (hora de Honduras) y la abre el equipo del evento.${info.tentative ? " El horario es tentativo hasta que se confirme." : ""}`;
    return info && info.tentative ? "La votación todavía no está abierta. Los horarios son tentativos hasta que se confirmen." : "La votación todavía no está abierta. Volvé en unos minutos.";
  }

  /**
   * What the REGISTRATION of contestants says, by the server's clock. It never invents a time: with nothing configured it says only that the
   * schedule will be announced. After the cutoff it says that registrations ended — the page then offers no form at all.
   */
  function registrationNotice(reg) {
    const phase = reg && reg.phase;
    if (phase === "OPEN") return reg.closesAt ? `La inscripción de concursantes está abierta ${untilTime(reg.closesAt)} (hora de Honduras).` : "La inscripción de concursantes está abierta.";
    if (phase === "NOT_OPEN") return reg.opensAt ? `La inscripción de concursantes abre ${atTime(reg.opensAt)} (hora de Honduras).` : "La inscripción de concursantes todavía no abrió.";
    if (phase === "CLOSED") return "La inscripción de concursantes terminó. Ya no se aceptan nuevas candidaturas.";
    return "Pronto anunciaremos el horario de inscripción.";
  }

  /** The state of a category as the picker names it: one short label and whether it can be voted in. Judged by the SERVER's phase, never the phone. */
  function categoryState(cat, myVote) {
    const voted = !!myVote;
    if (!cat) return { label: "", open: false, tone: "idle" };
    if (cat.phase === "OPEN") return { label: voted ? "Ya votaste · podés cambiarlo" : "Votación abierta · todavía no votaste", open: true, tone: voted ? "voted" : "open" };
    if (cat.phase === "CLOSED" || cat.phase === "ENDED") {
      if (cat.published) return { label: "Resultados publicados", open: false, tone: "results" };
      return { label: voted ? "Votación cerrada · tu voto quedó registrado" : "Votación cerrada", open: false, tone: "closed" };
    }
    return { label: "La votación todavía no abre", open: false, tone: "idle" };
  }

  /** What a published category announces: the winner(s) by public number, or — when nobody cast a valid vote — that there is no winner. Never a count. */
  function resultsHeadline(results) {
    if (!results || results.published !== true) return null;
    const n = Array.isArray(results.items) ? results.items.length : 0;
    if (n === 0) return "Sin resultado ganador";
    return n > 1 ? "¡Tenemos ganadores compartidos!" : "¡Tenemos ganador!";
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

  // ---------------------------------------------------------------- one vote, start to finish

  /**
   * Runs ONE vote (or one revision): bind (idempotent), take a fresh server-issued intent and send the vote. The vote is confirmed ONLY when the
   * server answered 200; nothing is shown as accepted before that. Nothing about a location is read, asked or sent: there is none in the contest.
   *
   * A lost response (network error on the vote) is not a failure and not a success: the result carries `retry`, the SAME intent, which
   * the server answers as a replay if it had been applied and applies if it had not — so retrying can never duplicate or fabricate a vote.
   */
  async function castFavorite(deps) {
    const { api, candidateId, interactionInstanceId, retry, isCurrent } = deps;
    // `isCurrent` says whether the page is still where the tap happened (the person may sign out or tap something else while a request is out);
    // when it is not, NOTHING further is sent: no bind, no intent, no vote.
    const stale = () => typeof isCurrent === "function" && !isCurrent();
    const staleResult = () => ({ ok: false, code: "STALE_ACTION", stale: true, retry: retry || null });
    if (stale()) return staleResult();

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

    const cast = await api.vote({ bindingId, intentNo, interactionInstanceId, candidateId });
    if (cast.status === 200 && cast.json && (cast.json.outcome === "APPLIED" || cast.json.outcome === "UNCHANGED" || cast.json.outcome === "REPLAYED")) {
      return { ok: true, outcome: cast.json.outcome, candidateId: cast.json.candidateId };
    }
    if (cast.status === 0) return { ok: false, code: "NETWORK", retry: { bindingId, intentNo, candidateId, interactionInstanceId } };
    return { ok: false, code: (cast.json && cast.json.code) || "INTERNAL_ERROR", status: cast.status, current: (cast.json && cast.json.current) || null };
  }

  // ---------------------------------------------------------------- the public code, the search and the share text

  /**
   * The code as a person types it: any case, with or without the hyphen, with spaces. Null when it cannot be a code (a look-alike — 0, 1, I, L, O,
   * U — or the wrong length). The SAME normalization the server and the database apply, so the page and the search agree on what was meant.
   */
  function normalizeCode(raw) {
    if (typeof raw !== "string") return null;
    const compact = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    return /^HAL[2-9A-HJKMNP-TV-Z]{5}$/.test(compact) ? `HAL-${compact.slice(3)}` : null;
  }

  const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  /**
   * The gallery filtered by what the person typed: a complete code finds exactly that candidacy; anything else matches names and codes by substring
   * (accents and case ignored). An empty query shows everything. Nothing here ranks or reorders: the order is the voter's own reproducible one.
   */
  function searchGallery(items, query) {
    const list = Array.isArray(items) ? items : [];
    const q = typeof query === "string" ? query.trim() : "";
    if (q === "") return list;
    const code = normalizeCode(q);
    if (code) return list.filter((i) => i.code === code);
    const needle = fold(q);
    return list.filter((i) => fold(i.name).includes(needle) || fold(i.code).includes(needle) || fold(i.code).replace(/-/g, "").includes(needle.replace(/-/g, "")));
  }

  /** What a candidacy shows as its title: the public name the person chose, or — for an entry the team made by hand and has not named — its ballot number. */
  function candidacyTitle(item) {
    if (item && typeof item.name === "string" && item.name !== "") return item.name;
    return item && item.alias ? `Disfraz #${item.alias}` : "Disfraz";
  }

  /** The text to share a ficha: neutral (it never asks for a vote), the code and the link. */
  function shareText(ficha) {
    const c = ficha && ficha.candidacy;
    if (!c) return "";
    return `Mirá la candidatura de ${c.name || "este disfraz"} (código ${c.code}) en el concurso de disfraces de The Pub by Beer Box: ${c.ficheUrl}`;
  }

  // ---------------------------------------------------------------- the contestant's registration (form logic only: the server and the database decide)

  const COUNTRY_CODES = [
    { code: "504", label: "Honduras (+504)" },
    { code: "502", label: "Guatemala (+502)" },
    { code: "503", label: "El Salvador (+503)" },
    { code: "505", label: "Nicaragua (+505)" },
    { code: "506", label: "Costa Rica (+506)" },
    { code: "507", label: "Panamá (+507)" },
    { code: "52", label: "México (+52)" },
    { code: "1", label: "Estados Unidos y Canadá (+1)" },
    { code: "57", label: "Colombia (+57)" },
    { code: "34", label: "España (+34)" },
    { code: "other", label: "Otro país" },
  ];
  const DEFAULT_COUNTRY = "504";

  /** "+504" and "9988 7766" make "+50499887766"; "" when either part has no digits. The person SEES this number and confirms it before it is sent. */
  function composeWhatsapp(countryCode, national) {
    const cc = String(countryCode || "").replace(/\D/g, "");
    const nn = String(national || "").replace(/\D/g, "");
    return cc && nn ? `+${cc}${nn}` : "";
  }
  const validWhatsapp = (e164) => /^\+[1-9][0-9]{7,14}$/.test(e164);

  /** "+504 9988-7766" as the person reads it back to confirm; the E.164 digits when the country is unknown to the formatter. */
  function displayWhatsapp(e164) {
    if (!validWhatsapp(e164)) return "";
    const m = /^\+504(\d{4})(\d{4})$/.exec(e164);
    return m ? `+504 ${m[1]}-${m[2]}` : e164;
  }

  const hasControl = (text) => /[\u0000-\u001f\u007f-\u009f]/.test(text);

  /** The registration form's own checks — a convenience for the person. The server and the database re-validate every one of them. */
  function validateRegistration(v) {
    const errors = {};
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if ([...name].length < 2 || [...name].length > 40 || hasControl(name)) errors.name = "Escribí el nombre con el que querés aparecer (de 2 a 40 letras).";
    if (!["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"].includes(v.category)) errors.category = "Elegí la categoría en la que participás.";
    const whatsapp = composeWhatsapp(v.country === "other" ? v.otherCountry : v.country, v.number);
    if (!validWhatsapp(whatsapp)) errors.whatsapp = "Escribí tu número de WhatsApp completo, con el código del país.";
    else if (v.whatsappConfirmed !== true) errors.whatsappConfirmed = "Confirmá que este número es tuyo.";
    if (v.requirementsAccepted !== true) errors.requirements = "Para inscribirte tenés que confirmar que sos mayor de edad y aceptar los requisitos.";
    if (v.deliveryAuthorized !== true) errors.delivery = "Marcá si autorizás que te enviemos tu foto y tu código por WhatsApp.";
    return { ok: Object.keys(errors).length === 0, errors, whatsapp, name };
  }

  /** What the registration view shows, from the contest's registration phase and the person's own candidacy. */
  function registrationStage(registration, mine) {
    if (mine) return "MINE";
    const phase = registration && registration.phase;
    if (phase === "OPEN") return "FORM";
    if (phase === "NOT_OPEN") return "NOT_OPEN";
    if (phase === "CLOSED") return "CLOSED";
    return "NOT_SCHEDULED";
  }

  /** What a candidacy says about itself to the person who owns it (or belongs to it), step by step. Never a promise the team has not made. */
  function myCandidacyText(mine) {
    if (!mine) return "";
    if (mine.state === "WITHDRAWN") return "Esta candidatura fue retirada.";
    if (mine.state === "PUBLIC") return "Tu candidatura ya es pública: aparece en la galería con tu foto.";
    return mine.role === "MEMBER"
      ? "Eres parte de esta candidatura de grupo. Aparecerá en la galería cuando el equipo termine de verificarla en la estación."
      : "Tu candidatura está inscrita. Pasá por la estación del concurso con tu código: el equipo verifica tu nombre y tu categoría, te toma la foto y la hace pública.";
  }

  function deliveryText(status) {
    if (status === "DELIVERED") return "Tu foto y tu código ya te los enviaron por WhatsApp.";
    if (status === "PENDING") return "Te enviaremos tu foto y tu código por WhatsApp después de la estación. Mientras tanto, tu candidatura no depende de ese envío.";
    return "";
  }

  /** The reasons of the contest in a few lines, for "Cómo participar". Nothing here hides an essential condition; the rest of the page stays short. */
  const HOW_TO_PARTICIPATE = [
    "Para participar como concursante, inscribite con tu cuenta de URBANO Gaming (correo verificado y perfil completo). Es una sola candidatura por persona, en una sola categoría, y solo para mayores de edad.",
    "Pasá por la estación del concurso con tu código: el equipo verifica tu nombre y tu categoría y te toma la foto. Tu candidatura se hace pública solo después de eso.",
    "En el grupo, una persona lo inscribe como representante y el equipo registra en la estación a las demás. Todas las personas de la foto tienen que aceptar.",
    "Para votar entrás con tu correo. Podés votar desde donde estés: no pedimos tu ubicación. Tenés un voto por categoría y lo podés cambiar hasta que cierre la votación.",
    "No podés votar por tu propio disfraz ni por el de tu grupo.",
    "Gana quien reciba más votos en cada categoría. Si hay empate, hay más de un ganador. Los resultados se publican después de que el equipo los revise.",
    "Habrá premios en cada categoría.",
  ];

  // ---------------------------------------------------------------- the API

  /** A thin client for ONE category's routes. Every call returns { status, json }; it never throws on an HTTP error. */
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
      register: (body) => call("/registration", "POST", body, true),
    };
  }

  /** The contest's own routes: the caller's candidacy (signed in) and a candidacy's public ficha by its code. Every call returns { status, json }. */
  function buildContestApi(fetchImpl, getToken, contestId) {
    const base = `/api/gaming/community-voting/contests/${contestId}`;
    async function call(path, authed) {
      const headers = { "Content-Type": "application/json" };
      if (authed) {
        const token = await getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      try {
        const response = await fetchImpl(`${base}${path}`, { method: "GET", headers });
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
      mine: () => call("/mine", true),
      ficha: (code) => call(`/candidacies/${encodeURIComponent(code)}`, false),
    };
  }


  /** The contest's own public read: the categories that have a round, each with its phase by the SERVER's clock. No identity, never cached. */
  async function readContest(fetchImpl, contestId) {
    try {
      const response = await fetchImpl(`/api/gaming/community-voting/contests/${contestId}`, { method: "GET", headers: { "Content-Type": "application/json" } });
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
   * How often a public page asks for the contest's state (before jitter and backoff). A category lasts an hour at most and may have a crowd, so
   * it is asked every 15 s while open; after a close the publication is expected soon, so the page asks quickly for a few minutes and then
   * settles; once everything is published there is little left to learn. Bounded: never faster than 5 s.
   */
  const POLL = { openMs: 15000, waitMs: 20000, afterCloseMs: 6000, afterCloseWindowMs: 180000, settledMs: 20000, publishedMs: 60000, staleAfterMs: 30000 };

  function pollDelayMs(ctx) {
    const c = ctx || {};
    if (c.phase === "OPEN") return POLL.openMs;
    if (c.phase === "NOT_OPEN") return POLL.waitMs;
    if (c.phase === "CLOSED" || c.phase === "ENDED" || c.phase === "RESULTS") {
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
    formatEventRange,
    formatEventDate,
    formatEventDayShort,
    atTime,
    untilTime,
    registrationWindowText,
    votingWindowText,
    EVENT_TIME_ZONE,
    phaseNotice,
    registrationNotice,
    normalizeCode,
    searchGallery,
    candidacyTitle,
    shareText,
    COUNTRY_CODES,
    DEFAULT_COUNTRY,
    composeWhatsapp,
    displayWhatsapp,
    validateRegistration,
    registrationStage,
    myCandidacyText,
    deliveryText,
    HOW_TO_PARTICIPATE,
    categoryState,
    resultsHeadline,
    computeVirtualWindow,
    deckNavigate,
    swipeIntent,
    castFavorite,
    createPoller,
    POLL,
    pollDelayMs,
    buildApi,
    buildContestApi,
    readContest,
    toNum,
  };
})();
