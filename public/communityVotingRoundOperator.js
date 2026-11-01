// URBANO Gaming — Halloween Community Voting, the four-category contest: the operator's station (logic).
//
// Pure functions and small injected-dependency helpers (no DOM; the network and the clock are ARGUMENTS), so the exact deployed text is unit-tested.
// The station is organised around what the operator does with a person standing in front of them: search the code, verify the person, take the
// photograph, record the consent, approve, confirm — and, afterwards, deliver the photograph by hand from their own WhatsApp. Everything here is a
// CONVENIENCE: every rule (the host token, the designated operator, one candidacy per identified person, the representative's photo consent, the freeze at
// opening) is enforced by the server and the database, and nothing on this page can make an invalid action valid.
//
// PRIVACY: the delivery number is requested only when the operator asks to deliver, from the one route that returns it, and it lives in this page's
// memory only while that panel is open — it is never written to storage and never put in a URL other than the wa.me link the operator opens themself.

const CommunityVotingOperator = (() => {
  const EVENT_TIME_ZONE = "America/Tegucigalpa";
  const HN_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC-6 all year (no daylight saving time)
  const CATEGORY_KEYS = ["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"];

  // ---------------------------------------------------------------- time (the event's, never the phone's)

  /** "2026-10-31" + "20:00" (+ optional whole days) in Tegucigalpa time, as an ISO instant; null when either part is not valid. */
  function eventInstant(date, time, plusDays) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    const t = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
    if (!d || !t) return null;
    const [y, mo, da, hh, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
    const local = new Date(Date.UTC(y, mo - 1, da, hh, mi));
    // a calendar date and a clock time that really exist: 31 February and 99:99 are not "rolled over" into some other day
    if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== da || local.getUTCHours() !== hh || local.getUTCMinutes() !== mi) return null;
    return new Date(local.getTime() + HN_OFFSET_MS + (plusDays || 0) * 86400000).toISOString();
  }

  /** The instant as { date, time } in Tegucigalpa time, for filling the form back in. */
  function fromEventInstant(iso) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return { date: "", time: "" };
    const d = new Date(ms - HN_OFFSET_MS);
    const p = (n) => String(n).padStart(2, "0");
    return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
  }

  /** The approved Halloween plan, as FORM VALUES (a button that fills a form; it saves and opens nothing). */
  const EVENT_PLAN = { date: "2026-10-31", registrationOpens: "20:00", registrationCloses: "23:00", votingOpens: "23:00", votingCloses: "00:00" };

  function rehearsalPlan(now) {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) return null;
    const start = fromEventInstant(new Date(ms - 60000).toISOString());
    const cut = fromEventInstant(new Date(ms + 15 * 60000).toISOString());
    const end = fromEventInstant(new Date(ms + 30 * 60000).toISOString());
    if (start.date !== cut.date) return null;
    return { date: start.date, registrationOpens: start.time, registrationCloses: cut.time, votingOpens: cut.time, votingCloses: end.time, confirmed: false };
  }

  /** The form's times as the instants the server stores. The closing time at or before the opening time is the NEXT day (voting that runs past midnight). */
  function scheduleFromForm(f) {
    const registrationOpensAt = eventInstant(f.date, f.registrationOpens, 0);
    const contestantCutoffAt = eventInstant(f.date, f.registrationCloses, 0);
    const votingOpensAt = eventInstant(f.date, f.votingOpens, 0);
    const wraps = typeof f.votingCloses === "string" && typeof f.votingOpens === "string" && f.votingCloses <= f.votingOpens;
    const votingClosesAt = eventInstant(f.date, f.votingCloses, wraps ? 1 : 0);
    if (!registrationOpensAt || !contestantCutoffAt || !votingOpensAt || !votingClosesAt) return null;
    if (!(Date.parse(registrationOpensAt) <= Date.parse(contestantCutoffAt) && Date.parse(contestantCutoffAt) <= Date.parse(votingOpensAt) && Date.parse(votingOpensAt) < Date.parse(votingClosesAt))) return null;
    return { registrationOpensAt, contestantCutoffAt, votingOpensAt, votingClosesAt, status: f.confirmed ? "CONFIRMED" : "TENTATIVE" };
  }

  // ---------------------------------------------------------------- the photograph

  /** Never enlarges; keeps the aspect ratio; the long side is at most `maxLongSide`. */
  function planResize(width, height, maxLongSide) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1, height: 1, scale: 1 };
    const longSide = Math.max(width, height);
    const scale = Math.min(1, maxLongSide / longSide);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
  }
  const PHOTO_LIMITS = { full: 1600, thumb: 480 };

  /** The claim credential as it is read aloud: 4-4-4. Anything else is shown as it came. */
  function formatClaimCode(code) {
    if (typeof code !== "string") return "";
    return code.length === 12 ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;
  }

  // ---------------------------------------------------------------- what an entry needs next

  const isMember = (e) => e && e.kind === "GROUP_MEMBER";
  const isReady = (e) => !!e && !e.withdrawn && e.association === "CONFIRMED" && e.media === "APPROVED";

  /** The name the station shows: the public name, or the ballot number of an entry the team made by hand and has not named. */
  function entryTitle(e) {
    if (!e) return "";
    return e.publicName ? e.publicName : e.label ? `Sin nombre · ${e.label}` : "Sin nombre";
  }

  /**
   * The steps one candidacy goes through at the station, in order, each marked done / current / todo. The first step that is not done is the current
   * one and the page shows ITS action. A self-registered candidacy is verified (the person's name and category) before anything else; a hand-made one
   * is associated through the pilot's claim -> confirm act with the person's own phone.
   */
  function stationSteps(e) {
    if (!e) return [];
    const selfRegistered = !!e.selfRegistered;
    const confirmed = e.association === "CONFIRMED";
    const hasPhoto = e.media !== "NONE" && e.media !== "REJECTED" && e.media !== "HIDDEN";
    const consented = e.media === "PENDING_REVIEW" || e.media === "APPROVED" || e.entryConsent === true;
    const approved = e.media === "APPROVED" || e.photoDecision === "APPROVED";
    const steps = [];
    steps.push({
      key: selfRegistered ? "VERIFY" : "ASSOCIATE",
      label: selfRegistered ? "Verificar a la persona (nombre y categoría)" : "Asociar a la persona con su teléfono",
      done: confirmed,
    });
    steps.push({ key: "PHOTO", label: "Tomar la foto", done: hasPhoto });
    steps.push({ key: "CONSENT", label: "Consentimiento de la foto", done: consented });
    steps.push({ key: "APPROVE", label: "Aprobar la foto", done: approved });
    // The group is represented by one verified account; extra member accounts are optional.
    let currentSeen = false;
    return steps.map((s) => {
      const state = s.done ? "done" : currentSeen ? "todo" : "current";
      if (!s.done) currentSeen = true;
      return { key: s.key, label: s.label, state };
    });
  }

  /** The current step's key, or null when the candidacy is complete (public once the photograph is approved and the person confirmed). */
  function currentStep(e) {
    const s = stationSteps(e).find((x) => x.state === "current");
    return s ? s.key : null;
  }

  /**
   * What stands between a category and its opening, from its overview. The database enforces the same rule (every candidacy ready, at least two);
   * saying it here only spares the operator a refusal. A registration the person never completed is NOT dropped silently: it keeps the category
   * from opening until the operator decides about it (completes it or removes it).
   */
  function categoryReadiness(overview) {
    const entries = ((overview && overview.entries) || []).filter((e) => !isMember(e) && !e.withdrawn);
    const ready = entries.filter(isReady);
    const pending = entries.filter((e) => !isReady(e));
    const reasons = [];
    if (overview && overview.opened) return { opened: true, total: entries.length, ready: ready.length, pending, canOpen: false, reasons: [] };
    if (entries.length < 2) reasons.push(entries.length === 0 ? "Todavía no hay candidaturas." : "Se necesitan al menos 2 candidaturas.");
    if (pending.length > 0) reasons.push(pending.length === 1 ? "Falta completar 1 candidatura." : `Faltan completar ${pending.length} candidaturas.`);
    return { opened: false, total: entries.length, ready: ready.length, pending, canOpen: reasons.length === 0 && ready.length >= 2, reasons };
  }

  /** A short label for where a category stands, for the operator's strip. */
  function categoryPhaseLabel(overview) {
    if (!overview) return "Sin datos";
    if (overview.published) return "Resultados publicados";
    if (overview.closed) return "Cerrada";
    if (overview.opened) return "Votación abierta";
    return "Preparando";
  }

  /** The operator's own next step for the category after it closes: review the result, then publish it. */
  function afterCloseStep(overview) {
    if (!overview || !overview.closed) return null;
    if (overview.published) return "DONE";
    if (overview.review && overview.review.current) return "PUBLISH";
    return "REVIEW";
  }

  // ---------------------------------------------------------------- the delivery panel

  const DELIVERY_LABEL = { PENDING: "Envío pendiente", DELIVERED: "Entregado" };
  const deliveryLabel = (status) => DELIVERY_LABEL[status] || "";

  /** The operator is reminded, in the panel itself, that the link cannot attach the picture. */
  const DELIVERY_NOTICE =
    "El enlace abre WhatsApp con el mensaje listo, pero no adjunta la foto: descargala y adjuntala vos. Abrir WhatsApp no marca nada como entregado; eso lo decidís vos al terminar.";

  // ---------------------------------------------------------------- messages

  const MESSAGES = {
    AUTHENTICATION_REQUIRED: "Iniciá sesión con tu correo para continuar.",
    OPERATOR_REQUIRED: "Esta cuenta no es la del operador del concurso.",
    OPERATOR_NOT_CONFIGURED: "El operador del concurso todavía no está configurado en el servidor.",
    HOST_TOKEN_MISMATCH: "Las claves guardadas en este navegador no corresponden a este concurso. Restaurá la copia de seguridad.",
    INSTANCE_NOT_FOUND: "No encontramos esa categoría.",
    ENTRY_NOT_FOUND: "No encontramos esa candidatura.",
    WRONG_ENTRY_KIND: "Esta acción no corresponde a este tipo de candidatura.",
    PREPARATION_CLOSED: "La votación de esa categoría ya abrió: la preparación no se puede cambiar.",
    PREPARATION_INCOMPLETE: "Todavía no se puede abrir: cada candidatura necesita su persona confirmada y su foto aprobada, y hace falta al menos 2.",
    ALREADY_OPENED: "Esa categoría ya está abierta.",
    SESSION_NOT_STARTABLE: "Esa categoría no está lista para abrir.",
    SCHEDULE_REQUIRED: "La categoría necesita una hora de cierre en el futuro antes de abrir.",
    SCHEDULE_INVALID: "Los horarios no tienen sentido: inscripción, cierre de inscripción, apertura y cierre deben ir en ese orden.",
    CUTOFF_PASSED: "La inscripción ya terminó.",
    CONSENT_REQUIRED: "Falta el consentimiento de la persona.",
    PHOTO_INVALID: "La foto no sirve. Tomá otra.",
    PHOTO_REQUIRED: "Primero hay que subir la foto.",
    DECISION_ALREADY_RECORDED: "Esa foto ya tiene una decisión.",
    CONSENT_ALREADY_RECORDED: "El consentimiento ya estaba registrado.",
    CONFIRMATION_REJECTED: "Ese código no coincide. Pedíselo de nuevo a la persona.",
    CONFIRMATION_NOT_PENDING: "Esa persona todavía no escribió su código.",
    ALREADY_CANDIDATE: "Esa persona ya tiene una candidatura en el concurso.",
    ENTRY_HAS_MEDIA: "Esa candidatura ya tiene foto: en vez de quitarla, retirala.",
    ENTRY_ALREADY_WITHDRAWN: "Esa candidatura ya fue retirada.",
    GROUP_FULL: "El grupo ya no tiene lugar para otra persona.",
    ALREADY_CLOSED: "Esa categoría ya cerró.",
    RESULTS_NOT_AVAILABLE: "Los resultados todavía no están disponibles.",
    REVIEW_REQUIRED: "Primero registrá la revisión del resultado.",
    REVIEW_STALE: "El resultado cambió después de la revisión: revisalo otra vez.",
    ALREADY_PUBLISHED: "Esos resultados ya se publicaron.",
    CATEGORY_ALREADY_REGISTERED: "Esa categoría ya existe en el concurso.",
    NETWORK: "No hay conexión. Lo último que hiciste todavía no se confirmó.",
    INVALID_REQUEST: "Algo en lo que escribiste no es válido.",
    INTERNAL_ERROR: "Algo salió mal del lado del servidor. Intentalo de nuevo.",
  };
  function describeError(code) {
    return (typeof code === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) || "No se pudo completar la acción. Intentalo de nuevo.";
  }

  // ---------------------------------------------------------------- the clients

  async function request(fetchImpl, getToken, url, method, body, extraHeaders) {
    const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

  /** The operator's client for ONE category: the bearer proves WHO, the category's host token proves the event. Every call returns { status, json }. */
  function buildOperatorApi(fetchImpl, getToken, getHostToken, instanceId) {
    const base = `/api/gaming/community-voting/rounds/${instanceId}`;
    const call = (path, method, body) => request(fetchImpl, getToken, `${base}${path}`, method, body, { "x-host-token": getHostToken() || "" });
    return {
      overview: () => call("/operator/overview", "GET"),
      results: () => call("/operator/results", "GET"),
      info: () => call("/info", "GET"),
      schedule: (schedule) => call("/schedule", "PUT", schedule),
      listing: (listed) => call("/operator/listing", "PUT", { listed }),
      openRegistration: () => call("/operator/registration", "POST", {}),
      find: (code) => call(`/operator/candidacies?code=${encodeURIComponent(code)}`, "GET"),
      createEntry: (kind) => call("/operator/entries", "POST", kind === "GROUP" ? { kind: "GROUP" } : {}),
      removeEntry: (entryId) => call(`/operator/entries/${entryId}`, "DELETE"),
      rename: (entryId, publicName) => call(`/operator/entries/${entryId}/name`, "PUT", { publicName }),
      confirmation: (entryId) => call(`/operator/entries/${entryId}/confirmation`, "POST", {}),
      photo: (entryId, fullImage, thumbImage) => call(`/operator/entries/${entryId}/photo`, "POST", { fullImage, thumbImage }),
      consent: (entryId, photoId, consentVersion) => call(`/operator/entries/${entryId}/consent`, "POST", { photoId, consentVersion, accepted: true, ageConfirmed: true }),
      decision: (entryId, photoId, decision, reason) => call(`/operator/entries/${entryId}/decision`, "POST", { photoId, decision, reason }),
      association: (entryId, confirmationCode) => call(`/operator/entries/${entryId}/association`, "POST", { confirmationCode }),
      addMember: (groupEntryId) => call(`/operator/entries/${groupEntryId}/members`, "POST", {}),
      memberConsent: (memberEntryId, photoId, consentVersion) => call(`/operator/entries/${memberEntryId}/member-consent`, "POST", { photoId, consentVersion, accepted: true, ageConfirmed: true }),
      withdraw: (entryId, reason, hidePhoto) => call(`/operator/entries/${entryId}/withdrawal`, "POST", { reason, hidePhoto: hidePhoto === true }),
      contact: (entryId) => call(`/operator/entries/${entryId}/contact`, "POST", {}),
      delivered: (entryId) => call(`/operator/entries/${entryId}/delivery`, "POST", {}),
      open: (promptText) => call("/operator/open", "POST", { promptText }),
      close: () => call("/operator/close", "POST", {}),
      review: (note) => call("/operator/review", "POST", note ? { note } : {}),
      publish: () => call("/operator/publish", "POST", {}),
    };
  }

  /** The calls that create the contest: a Session per category (the platform's own routes), its capability, then the category's registration. */
  function buildSetupApi(fetchImpl, getToken) {
    return {
      createSession: () => request(fetchImpl, getToken, "/api/sessions", "POST", undefined),
      declareVoting: (sessionId, hostToken) => request(fetchImpl, getToken, `/api/sessions/${sessionId}/capabilities`, "POST", { hostToken, capabilities: ["VOTING"] }),
      registerCategory: (sessionId, hostToken, categoryKey, contestId, purpose) =>
        request(fetchImpl, getToken, "/api/gaming/community-voting/rounds", "POST", Object.assign({ sessionId, categoryKey }, contestId ? { contestId } : {}, purpose ? { purpose } : {}), { "x-host-token": hostToken }),
      contest: (contestId) => request(fetchImpl, getToken, `/api/gaming/community-voting/contests/${contestId}`, "GET"),
    };
  }

  // ---------------------------------------------------------------- what this browser keeps: the contest's keys

  const STORE_KEY = "cv:operator:contest:v1";

  /**
   * The contest this operator is running: its id and, per category, the Instance and the host token. The tokens are secrets of THIS operator's device;
   * the backup file lets them recover if the browser forgets. The shape is checked on every read: anything else is ignored, never trusted.
   */
  function parseKeys(raw) {
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!v || typeof v !== "object" || typeof v.contestId !== "string" || typeof v.categories !== "object" || v.categories === null) return null;
      const categories = {};
      for (const key of CATEGORY_KEYS) {
        const c = v.categories[key];
        if (c && typeof c.instanceId === "string" && typeof c.hostToken === "string" && c.hostToken.length > 0) {
          categories[key] = { instanceId: c.instanceId, sessionId: typeof c.sessionId === "string" ? c.sessionId : "", hostToken: c.hostToken };
        }
      }
      return { contestId: v.contestId, ownerUserId: typeof v.ownerUserId === "string" ? v.ownerUserId : "", categories, mode: v.mode === "REHEARSAL" ? "REHEARSAL" : "LIVE" };
    } catch (e) {
      return null;
    }
  }
  const keysComplete = (k) => !!k && CATEGORY_KEYS.every((key) => k.categories[key]);

  function rememberContest(contests, keys) {
    const parsed = parseKeys(keys);
    if (!parsed) return contests.slice();
    const at = contests.findIndex((c) => c.contestId === parsed.contestId);
    return at < 0 ? [...contests, parsed] : contests.map((c, i) => i === at ? parsed : c);
  }
  function parseWorkspace(raw, legacy) {
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(v)) return v.reduce((all, c) => rememberContest(all, c), []);
    } catch (e) { /* a legacy backup is independently recoverable */ }
    const p = parseKeys(legacy);
    return p ? [p] : [];
  }

  return {
    rehearsalPlan,
    parseWorkspace,
    rememberContest,
    EVENT_TIME_ZONE,
    CATEGORY_KEYS,
    EVENT_PLAN,
    eventInstant,
    fromEventInstant,
    scheduleFromForm,
    planResize,
    PHOTO_LIMITS,
    formatClaimCode,
    isMember,
    isReady,
    entryTitle,
    stationSteps,
    currentStep,
    categoryReadiness,
    categoryPhaseLabel,
    afterCloseStep,
    deliveryLabel,
    DELIVERY_NOTICE,
    describeError,
    buildOperatorApi,
    buildSetupApi,
    STORE_KEY,
    parseKeys,
    keysComplete,
  };
})();
