// URBANO Gaming — Halloween Community Voting, two-round pilot: the operator tablet's logic.
//
// Pure functions (no DOM, no network; the fetch is an argument). The page uses them to decide what to show and what to offer next; the
// server and the database decide what is ALLOWED. Nothing here is an authority: `roundReadiness` mirrors the database's rule for opening
// so the operator sees the blockers BEFORE pressing the button, but pressing it never relies on this, and `nextSteps` is a checklist, not
// a lock — every button calls a route that checks the host token and the designated operator again, and the database checks them once more.
//
// The event's time. Every time on the pilot's pages is read and written in the EVENT'S OWN zone, America/Tegucigalpa (UTC−6, no daylight
// saving time), never the tablet's: a tablet set to another zone must not move the registration cutoff or the deadline by hours. The
// schedule below is DATA — the Founder's initial times — used only to PREFILL the form; nothing here creates an event, opens a round or
// saves anything, and the operator must press "Guardar horarios" to store it.

const CommunityVotingRoundOperator = (() => {
  const EVENT_TIME_ZONE = "America/Tegucigalpa";
  const EVENT_UTC_OFFSET_HOURS = -6;

  /** 31 October 2026: registration and photographs 19:00–20:30, preliminary 20:30–21:30, then a final of 300 seconds from its own opening. */
  const EVENT_SCHEDULE_TEMPLATE = Object.freeze({
    date: "2026-10-31",
    registrationOpens: "19:00",
    registrationCloses: "20:30",
    preliminaryOpens: "20:30",
    preliminaryCloses: "21:30",
    finalWindowSeconds: 300,
  });

  /** A calendar date and a wall-clock time in the event's zone -> an ISO instant, or null when either is not valid. */
  function toEventInstant(date, time) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === "string" ? date : "");
    const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === "string" ? time : "");
    if (!d || !t) return null;
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const check = new Date(Date.UTC(y, m - 1, day));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return null;
    return new Date(Date.UTC(y, m - 1, day, Number(t[1]), Number(t[2])) - EVENT_UTC_OFFSET_HOURS * 3600 * 1000).toISOString();
  }

  /** An ISO instant -> the event's own { date, time }, whatever the device's zone; null when absent or not a date. */
  function fromEventInstant(iso) {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const local = new Date(ms + EVENT_UTC_OFFSET_HOURS * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return {
      date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    };
  }

  /** The template as exact instants: the registration cutoff is when registration closes, the preliminary's deadline is when it closes. */
  function templateInstants() {
    const t = EVENT_SCHEDULE_TEMPLATE;
    return {
      registrationOpensAt: toEventInstant(t.date, t.registrationOpens),
      contestantCutoffAt: toEventInstant(t.date, t.registrationCloses),
      votingOpensAt: toEventInstant(t.date, t.preliminaryOpens),
      votingClosesAt: toEventInstant(t.date, t.preliminaryCloses),
    };
  }

  /** Never enlarges; keeps the aspect ratio; the long side is at most `maxLongSide`. */
  function planResize(width, height, maxLongSide) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1, height: 1, scale: 1 };
    const longSide = Math.max(width, height);
    const scale = Math.min(1, maxLongSide / longSide);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
  }

  function formatClaimCode(code) {
    if (typeof code !== "string") return "";
    return code.length === 12 ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;
  }

  /** What still has to happen for one entry, in the order the process requires. A final's entries arrive complete (carried from the preliminary). */
  function entryNextStep(entry) {
    if (entry.withdrawn) return "WITHDRAWN";
    // A photograph hidden at the person's request was approved first; hiding it does not make the contestant "not ready".
    if (entry.media === "HIDDEN") return entry.association === "CONFIRMED" ? "READY" : "ASSOCIATION";
    if (entry.media === "NONE" || entry.media === "REJECTED" || !entry.media) return "PHOTO";
    if (entry.media === "PENDING_CONSENT") return "CONSENT";
    if (entry.media === "PENDING_REVIEW") return "REVIEW";
    return entry.association === "CONFIRMED" ? "READY" : "ASSOCIATION";
  }

  const STEP_REASON = {
    PHOTO: "Falta una fotografía aprobada.",
    CONSENT: "Falta el consentimiento de galería y concurso de la persona.",
    REVIEW: "Falta aprobar o rechazar la fotografía.",
    ASSOCIATION: "Falta confirmar la asociación con la persona participante.",
  };

  function roundReadiness(overview) {
    const entries = overview && Array.isArray(overview.entries) ? overview.entries : [];
    const active = entries.filter((e) => !e.withdrawn);
    const blockers = [];
    for (const e of active) {
      const step = entryNextStep(e);
      if (step !== "READY") blockers.push({ entryId: e.entryId, label: e.label, reason: STEP_REASON[step] || "Falta completar este participante." });
    }
    return { ready: active.length >= 2 && blockers.length === 0, activeCount: active.length, blockers };
  }

  // ---------------------------------------------------------------- Test events: the same words on every page

  /** The label of a rehearsal. The voter and display modules carry the same words (a test pins that they agree). */
  const TEST_EVENT_LABEL = "EVENTO DE PRUEBA";
  const TEST_EVENT_NOTICE = "Es un ensayo: nada de lo que pasa en esta ronda es el evento real ni cuenta como su resultado.";

  // ---------------------------------------------------------------- The final's geofence: form, position of the device, outcome, schematic

  const GEOFENCE_FIELDS = Object.freeze([
    { id: "lat", key: "venueLatitude", label: "Latitud del centro", range: "un número entre -90 y 90", ok: (n) => n >= -90 && n <= 90 },
    { id: "lon", key: "venueLongitude", label: "Longitud del centro", range: "un número entre -180 y 180", ok: (n) => n >= -180 && n <= 180 },
    { id: "radius", key: "venueRadiusMeters", label: "Radio (metros)", range: "un número mayor que 0 y de hasta 100000", ok: (n) => n > 0 && n <= 100000 },
    { id: "accuracy", key: "maxAccuracyMeters", label: "Precisión máxima aceptada (metros)", range: "un número mayor que 0 y de hasta 100000", ok: (n) => n > 0 && n <= 100000 },
    { id: "inside", key: "insideMarginFactor", label: "Margen interior", range: "un número entre 0 y 1000", ok: (n) => n >= 0 && n <= 1000 },
    { id: "outside", key: "outsideMarginFactor", label: "Margen exterior", range: "un número entre 0 y 1000", ok: (n) => n >= 0 && n <= 1000 },
  ]);

  const GEOFENCE_HELP = Object.freeze({
    radius: "El radio es la distancia, en metros, del centro al borde del lugar. Solo se acepta el voto de quien está dentro de ese círculo.",
    accuracy: "La precisión máxima es el error de posición (en metros) que el teléfono de un votante puede reportar. Si reporta más error que este valor, su lectura no se usa y se le pide salir a un lugar abierto o acercarse. Un valor bajo es más exigente; uno demasiado bajo deja fuera a teléfonos con una señal normal.",
    inside: "El margen interior es cuántas veces el error reportado se suma a la distancia al centro antes de compararla con el radio. Con 1, alguien cuenta como dentro solo si incluso con todo su error cabe en el círculo; con 0 solo se mira la distancia.",
    outside: "El margen exterior es cuántas veces el error reportado se resta a la distancia para decidir que alguien está fuera. Con 1, está fuera solo si incluso con todo su error sigue más allá del borde. Entre dentro y fuera la lectura queda sin confirmar y se le pide acercarse.",
    browser: "La ubicación del navegador es una señal de elegibilidad, no es una prueba contra la suplantación: una persona podría simular una posición con herramientas de su teléfono. Sirve para pedir que los votantes estén en el lugar, no para garantizarlo.",
  });

  /** A plain decimal (a comma is accepted as the decimal mark). Anything else — blank, text, NaN, Infinity, an exponent — is not a number here. */
  function parseDecimal(text) {
    const t = String(text === undefined || text === null ? "" : text).trim().replace(/^([+-]?\d+),(\d+)$/, "$1.$2");
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  /** The six venue numbers from the form's six texts, or the fields that are wrong, each with its own message. Nothing is sent from a wrong form. */
  function parseGeofenceForm(form) {
    const errors = {};
    const venue = {};
    for (const f of GEOFENCE_FIELDS) {
      const n = parseDecimal(form ? form[f.id] : "");
      if (n === null || !f.ok(n)) errors[f.id] = `${f.label}: escribe ${f.range}.`;
      else venue[f.key] = n;
    }
    return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, venue };
  }

  function geofenceToForm(venue) {
    const out = {};
    for (const f of GEOFENCE_FIELDS) out[f.id] = String(venue[f.key]);
    return out;
  }

  /** True when the form differs from what is saved — numerically (14.0987 and 14.09870 are the same), and a form that cannot be read is a change. */
  function geofenceDirty(saved, form) {
    const parsed = parseGeofenceForm(form);
    if (!parsed.ok || !saved) return true;
    return GEOFENCE_FIELDS.some((f) => parsed.venue[f.key] !== saved[f.key]);
  }

  /** How precise a phone must be for its reading to propose a venue centre when the form gives no limit of its own. */
  const DEFAULT_CENTRE_ACCURACY_METERS = 100;
  const DEVICE_POSITION_OPTIONS = Object.freeze({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });

  const validReading = (r) =>
    !!r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Number.isFinite(r.accuracyMeters) &&
    r.latitude >= -90 && r.latitude <= 90 && r.longitude >= -180 && r.longitude <= 180 && r.accuracyMeters > 0 && !(r.latitude === 0 && r.longitude === 0);

  /**
   * One fresh reading of THIS device, as { latitude, longitude, accuracyMeters }. The reading is handed to the caller and kept nowhere here: it
   * is not stored, logged or sent anywhere by this function. Rejects with { code } so every failure has its own message.
   */
  function readDevicePosition(geolocation, options) {
    return new Promise((resolve, reject) => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") return reject({ code: "LOCATION_UNSUPPORTED" });
      geolocation.getCurrentPosition(
        (position) => {
          const c = position && position.coords;
          if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) || !Number.isFinite(c.accuracy)) return reject({ code: "LOCATION_UNAVAILABLE" });
          resolve({ latitude: c.latitude, longitude: c.longitude, accuracyMeters: c.accuracy });
        },
        (error) => reject({ code: error && error.code === 1 ? "LOCATION_DENIED" : error && error.code === 3 ? "LOCATION_TIMEOUT" : "LOCATION_UNAVAILABLE" }),
        Object.assign({}, DEVICE_POSITION_OPTIONS, options || {})
      );
    });
  }

  /**
   * The centre this reading can propose: only a reading precise enough for the accuracy the venue asks of its voters. A rough reading would put
   * the circle somewhere else, so it proposes nothing and the page says why.
   */
  function proposeCenter(reading, maxAccuracyMeters) {
    if (!validReading(reading)) return { ok: false, code: "INVALID_READING" };
    const limit = Number.isFinite(maxAccuracyMeters) && maxAccuracyMeters > 0 ? maxAccuracyMeters : DEFAULT_CENTRE_ACCURACY_METERS;
    if (reading.accuracyMeters > limit) return { ok: false, code: "ACCURACY_INSUFFICIENT" };
    return { ok: true, latitude: reading.latitude, longitude: reading.longitude, accuracyMeters: reading.accuracyMeters };
  }

  const LOCATION_MESSAGES = Object.freeze({
    LOCATION_DENIED: "El navegador no permitió usar la ubicación de este dispositivo. Permite el acceso a la ubicación para este sitio en la configuración del navegador y vuelve a intentarlo.",
    LOCATION_UNAVAILABLE: "No se pudo obtener la ubicación del dispositivo. Revisa que la ubicación esté activada y vuelve a intentarlo.",
    LOCATION_TIMEOUT: "La ubicación tardó demasiado en responder. Sal a un lugar abierto, espera unos segundos y vuelve a intentarlo.",
    LOCATION_UNSUPPORTED: "Este dispositivo o navegador no permite obtener la ubicación.",
    ACCURACY_INSUFFICIENT: "La precisión de la ubicación es insuficiente para proponer el centro. Sal a un lugar abierto, espera a que el teléfono mejore su lectura y vuelve a intentarlo.",
    INVALID_READING: "La lectura de ubicación no es válida. Vuelve a intentarlo.",
  });
  function describeLocationError(code) {
    return (typeof code === "string" && Object.prototype.hasOwnProperty.call(LOCATION_MESSAGES, code) && LOCATION_MESSAGES[code]) || "No se pudo usar la ubicación. Inténtalo de nuevo.";
  }

  /** Meters as people read them: whole numbers stay whole, anything else keeps one decimal. */
  const meters = (n) => (Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1)) : "—");
  const TEST_IS_ONLY_A_TEST = "Es solo una prueba: no se guardó tu posición ni se registró ningún voto.";

  /** What the server's evaluation of ONE reading means, in words. The decision is the server's; this only describes it. */
  function describeTestResult(result) {
    const r = result || {};
    const distance = meters(r.distanceMeters);
    const accuracy = meters(r.accuracyMeters);
    const radius = meters(r.radiusMeters);
    const limit = meters(r.maxAccuracyMeters);
    switch (r.decision) {
      case "INSIDE":
        return { tone: "good", title: "Dentro de la geocerca", detail: `Estás a ${distance} m del centro (radio ${radius} m), con una precisión de ±${accuracy} m. Con los márgenes configurados, esta lectura se aceptaría como dentro del lugar. ${TEST_IS_ONLY_A_TEST}` };
      case "OUTSIDE":
        return { tone: "bad", title: "Fuera de la geocerca", detail: `Estás a ${distance} m del centro (radio ${radius} m), con una precisión de ±${accuracy} m. Con esta lectura el voto se rechazaría. ${TEST_IS_ONLY_A_TEST}` };
      case "AMBIGUOUS":
        return { tone: "warn", title: "No se puede confirmar si estás dentro", detail: `Estás a ${distance} m del centro (radio ${radius} m), pero con una precisión de ±${accuracy} m el círculo de error cruza el borde: no se puede decir si estás dentro o fuera. A un votante se le pediría acercarse y volver a intentarlo. ${TEST_IS_ONLY_A_TEST}` };
      case "ACCURACY_EXCESSIVE":
        return { tone: "warn", title: "Precisión insuficiente", detail: `El teléfono reportó una precisión de ±${accuracy} m y el máximo aceptado es ${limit} m, así que la lectura no se usa para decidir. Distancia al centro: ${distance} m. ${TEST_IS_ONLY_A_TEST}` };
      default:
        return { tone: "warn", title: "Respuesta no reconocida", detail: `El servidor devolvió una decisión que esta pantalla no conoce; no la tomes como aprobada. ${TEST_IS_ONLY_A_TEST}` };
    }
  }

  /**
   * The local drawing of the venue: the centre, the radius and (when there is one) a test reading with its accuracy circle, north up and east to
   * the right, in a square of `size` units. It is a SCHEMATIC computed here from the numbers: no map, no tiles, no provider, no key. The decision
   * about a reading is the server's and is not made here; this only shows where the reading falls. A reading within three radii is kept in view by
   * zooming out; a farther one is drawn as an arrow on the edge, so a stray reading cannot squash the venue.
   */
  function schematic(input) {
    const size = input && input.size > 0 ? input.size : 240;
    const radius = input ? input.radiusMeters : NaN;
    const centre = input ? input.centre : null;
    if (!Number.isFinite(radius) || radius <= 0 || !centre || !(centre.latitude >= -90 && centre.latitude <= 90) || !(centre.longitude >= -180 && centre.longitude <= 180)) return null;
    const half = size / 2;
    const rad = (d) => (d * Math.PI) / 180;

    let located = null;
    const r = input.reading;
    if (validReading(r)) {
      const east = 6371000 * Math.cos(rad(centre.latitude)) * rad(r.longitude - centre.longitude);
      const north = 6371000 * rad(r.latitude - centre.latitude);
      const distance = Math.hypot(east, north);
      located = { east, north, distance, bearing: (((Math.atan2(east, north) * 180) / Math.PI) + 360) % 360, accuracy: r.accuracyMeters };
    }

    const base = radius / (0.7 * half); // the radius takes 70% of the half-frame
    let metersPerPixel = base;
    let far = false;
    if (located) {
      if (located.distance <= radius * 3) metersPerPixel = Math.max(base, located.distance / (0.9 * half));
      else far = true;
    }

    let reading = null;
    if (located) {
      if (far) {
        const k = 0.92 * half;
        reading = { x: half + Math.sin(rad(located.bearing)) * k, y: half - Math.cos(rad(located.bearing)) * k, accuracyPx: 0, outOfFrame: true };
      } else {
        reading = { x: half + located.east / metersPerPixel, y: half - located.north / metersPerPixel, accuracyPx: located.accuracy / metersPerPixel, outOfFrame: false };
      }
      reading.bearingDegrees = located.bearing;
      reading.distanceMeters = located.distance;
    }

    // a round scale bar (1, 2 or 5 times a power of ten) no longer than a third of the frame
    const target = metersPerPixel * size * 0.3;
    const power = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [5, 2, 1].map((m) => m * power).find((m) => m <= target) || power;
    return {
      size,
      centre: { x: half, y: half },
      metersPerPixel,
      radiusPx: radius / metersPerPixel,
      reading,
      scaleBar: { meters: nice, px: nice / metersPerPixel, label: `${nice} m` },
    };
  }

  // ---------------------------------------------------------------- The lobby of the Session must be locked before voting can open

  const LOBBY_LOCK_NOTICE =
    "Antes de abrir, el lobby del evento debe estar bloqueado: así se cierra la entrada de participantes ordinarios y la lista de personas ya no cambia. " +
    "El bloqueo lo hace el anfitrión desde el panel de su sesión, con su token; esta pantalla no lo hace por ti ni lo salta. Cuando esté bloqueado, vuelve a revisar.";

  /** Whether the Session's lobby still has to be locked. An overview that does not say (or a round that already opened) blocks nothing: the server stays the authority. */
  function lobbyStatus(overview) {
    if (!overview || overview.opened || typeof overview.sessionState !== "string" || overview.sessionState === "LOBBY_LOCKED") return { pending: false, text: null };
    return { pending: true, text: LOBBY_LOCK_NOTICE };
  }

  // ---------------------------------------------------------------- Policies that still need the Founder's approval

  /**
   * The three policies the system will not guess. Each has exactly ONE value the system can execute (`value`); another value would be a
   * code change, not a choice on this screen. Until the operator records the policy (citing where the Founder approved it), the operation
   * that depends on it is refused by the server. The three texts are statements — when it applies, what recording it does, and what happens
   * until then — never a yes/no question, and never a suggestion of which answer to give.
   */
  const POLICY_INFO = Object.freeze({
    ZERO_VALID_VOTES_PRELIMINARY: {
      value: "ALL_ENTRIES_ADVANCE",
      title: "Si nadie recibe votos válidos en la preliminar",
      applies: "Aplica solo si la preliminar cierra sin ningún voto válido; un voto a una participación que se retiró no cuenta.",
      ifRecorded: "El corte de finalistas se puede confirmar y pasan a la final todas las participaciones que no se retiraron.",
      whilePending: "Si ocurre ese caso, el corte de finalistas se rechaza hasta que se registre.",
    },
    ZERO_VOTE_ENTRIES_AT_CUTOFF: {
      value: "TIED_ZERO_VOTE_ENTRIES_ADVANCE",
      title: "Si una participación sin votos quedaría dentro del corte",
      applies: "Aplica solo si hay votos válidos pero una participación sin ningún voto quedaría dentro del corte de finalistas (por un campo pequeño o por un empate en cero).",
      ifRecorded: "El corte de finalistas se puede confirmar y las participaciones sin votos que queden dentro del corte avanzan a la final.",
      whilePending: "Si ocurre ese caso, el corte de finalistas se rechaza hasta que se registre.",
    },
    FINALIST_WITHDRAWAL_AFTER_SELECTION: {
      value: "EXCLUDE_WITHOUT_REFILL",
      title: "Si un finalista se retira después del corte",
      applies: "Aplica solo si un finalista ya elegido se retira después del corte.",
      ifRecorded: "La final sigue sin esa persona: nadie ocupa su lugar y el corte no se modifica.",
      whilePending: "Si ocurre ese caso, no se prepara ni se abre la final y no se publica ninguna de las dos rondas.",
    },
  });

  const POLICY_ORDER = ["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF", "FINALIST_WITHDRAWAL_AFTER_SELECTION"];

  /**
   * The wording of the policy panel. The operator's authority does not approve a policy: the Founder does, outside this screen, and the
   * application has no way to check it. What the operator records is a note of an approval that already exists, in their name.
   */
  const POLICY_STATUS_PENDING = "Pendiente de aprobación del Founder";
  const POLICY_STATUS_RECORDED = "Registrada por el operador";
  const POLICY_ACTION_LABEL = "Registrar decisión aprobada";
  const POLICY_OPERATOR_NOTICE = "Tu autoridad como operador no aprueba esta política: la aprueba el Founder, fuera de esta pantalla. Registrarla aquí solo deja constancia, a tu nombre, de esa aprobación; la aplicación no puede verificar que exista.";
  const POLICY_ACK_TEXT = "Confirmo que el Founder ya aprobó esta política con este valor exacto, y entiendo que solo registro una constancia que la aplicación no verifica.";
  const POLICY_RECORDED_NOTICE = "Constancia registrada por el operador. La aplicación no verificó que el Founder haya aprobado este valor.";
  const POLICY_MISSING_ACK = "Confirma que el Founder ya aprobó esta política con este valor exacto.";
  const POLICY_MISSING_REFERENCE = "Cita dónde consta la aprobación del Founder (mínimo 3 caracteres).";

  const policyTitle = (key) => (POLICY_INFO[key] ? POLICY_INFO[key].title : key);

  /**
   * The checklist of the round, each step with whether it is available NOW and why not. `overview` is the operator overview. The order is
   * the pilot's: preliminary — entries, open, close, cut, review, publish; final — prepare, open, close, review, publish.
   */
  function nextSteps(overview) {
    if (!overview) return [];
    const role = overview.roundRole;
    const readiness = roundReadiness(overview);
    const { opened, closed, published } = overview;
    const open = opened && !closed;
    const pending = (overview.pendingResolutions || []).map((p) => p.key);
    const waiting = (keys) => pending.find((k) => keys.includes(k)) || null;
    const decision = (key) => `${POLICY_STATUS_PENDING}: ${policyTitle(key)}.`;
    const closes = overview.schedule && overview.schedule.votingClosesAt ? Date.parse(overview.schedule.votingClosesAt) : null;
    const hasFutureDeadline = closes !== null && closes > Date.parse(overview.serverNow);
    const steps = [];

    if (role === "FINAL") {
      const held = waiting(["FINALIST_WITHDRAWAL_AFTER_SELECTION"]);
      const prepared = overview.entries.length > 0;
      steps.push({
        key: "PREPARE", label: "Preparar la final con los finalistas", done: prepared,
        enabled: !prepared && !opened && !held,
        reason: prepared ? "La final ya tiene sus finalistas." : opened ? "La final ya abrió." : held ? decision(held) : null,
      });
    }

    const openHeld = role === "FINAL" ? waiting(["FINALIST_WITHDRAWAL_AFTER_SELECTION"]) : null;
    const lobby = lobbyStatus(overview);
    steps.push({
      key: "OPEN",
      label: role === "FINAL" ? "Abrir la final (empieza el tiempo)" : "Abrir la votación",
      done: opened,
      enabled: !opened && readiness.ready && !openHeld && !lobby.pending && (role === "FINAL" || hasFutureDeadline),
      reason: opened ? "Ya está abierta."
        : openHeld ? decision(openHeld)
        : !readiness.ready ? (readiness.activeCount < 2 ? "Se necesitan al menos dos participantes." : "Hay participantes sin completar.")
        : role === "PRELIMINARY" && !hasFutureDeadline ? "Configura primero la hora de cierre, que debe ser futura: es el límite para votar."
        : lobby.pending ? "Falta bloquear el lobby del evento: lo hace el anfitrión desde el panel de su sesión, no esta pantalla."
        : null,
    });
    steps.push({ key: "CLOSE", label: "Cerrar la votación", done: closed, enabled: !!open, reason: closed ? "Ya está cerrada." : open ? null : "Primero hay que abrirla." });

    if (role === "PRELIMINARY") {
      const cutHeld = waiting(["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF"]);
      steps.push({
        key: "FINALISTS", label: "Hacer el corte de finalistas", done: !!overview.finalistsSelected,
        enabled: !!closed && !overview.finalistsSelected && !cutHeld,
        reason: !closed ? "Primero hay que cerrar la votación." : overview.finalistsSelected ? "El corte ya está hecho." : cutHeld ? decision(cutHeld) : null,
      });
    }

    // A final that closed with no valid vote has no result: there is nothing to review and nothing to publish, whatever else is in place.
    const noResult = role === "FINAL" && !!closed && overview.noValidResult === true;
    const reviewReady = !!closed && (role === "FINAL" || !!overview.finalistsSelected);
    const publishHeld = waiting(["FINALIST_WITHDRAWAL_AFTER_SELECTION"]);
    const reviewCurrent = !!(overview.review && overview.review.current);
    steps.push({
      key: "REVIEW", label: "Registrar la revisión de los resultados", done: false,
      enabled: reviewReady && !published && !noResult,
      reason: published ? "Ya se publicaron." : noResult ? "La final no tiene ningún voto válido: no hay resultado que revisar." : reviewReady ? (overview.review && !overview.review.current ? "La revisión anterior quedó vieja: regístrala de nuevo." : null) : role === "PRELIMINARY" ? "Primero hay que cerrar y hacer el corte." : "Primero hay que cerrar la votación.",
    });
    steps.push({
      key: "PUBLISH", label: role === "FINAL" ? "Publicar al ganador (o ganadores)" : "Publicar a los finalistas", done: !!published,
      enabled: reviewReady && !published && !noResult && reviewCurrent && !publishHeld,
      reason: published ? "Ya se publicó."
        : !reviewReady ? "Primero hay que cerrar la votación."
        : noResult ? "La final no tiene ningún voto válido: no hay resultado que publicar."
        : !reviewCurrent ? "Requiere una revisión de los resultados actuales."
        : publishHeld ? decision(publishHeld)
        : null,
    });
    return steps;
  }

  /** The clock the operator sees, from the SERVER's answer (never the tablet's wall clock): the time left until the deadline, h:mm:ss or m:ss. */
  function deadlineLabel(overview, monotonicElapsedMs) {
    if (!overview || !overview.deadlineAt || !overview.opened || overview.closed) return null;
    const left = Math.max(0, Date.parse(overview.deadlineAt) - Date.parse(overview.serverNow) - (monotonicElapsedMs || 0));
    const total = Math.ceil(left / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
  }

  const PROMO_LABEL = {
    NOT_ASKED: "No se le ha preguntado",
    ACCEPTED: "Autorizó el uso promocional",
    DECLINED: "No autorizó el uso promocional",
    WITHDRAWN: "Retiró la autorización promocional",
  };
  const promoLabel = (state) => PROMO_LABEL[state] || PROMO_LABEL.NOT_ASKED;

  const MESSAGES = {
    AUTHENTICATION_REQUIRED: "Inicia sesión como operador y confirma el token del evento.",
    OPERATOR_REQUIRED: "Esta cuenta no es la del operador designado para este evento.",
    HOST_TOKEN_MISMATCH: "El token del evento no coincide. Revisa que sea el de este evento.",
    OPERATOR_NOT_CONFIGURED: "El operador de la actividad no está configurado en el servidor.",
    PREPARATION_INCOMPLETE: "Todavía hay participantes sin completar. Revisa la lista de pendientes.",
    PREPARATION_CLOSED: "La votación ya se abrió: ya no se puede cambiar la preparación ni los horarios.",
    SESSION_NOT_STARTABLE: "Primero bloquea el lobby del evento.",
    ALREADY_OPENED: "La votación ya está abierta.",
    CUTOFF_PASSED: "Ya pasó la hora límite para nuevos participantes y fotografías.",
    PHOTO_INVALID: "La fotografía no es válida. Toma otra.",
    PHOTO_HIDDEN: "La persona pidió ocultar su fotografía: no se puede agregar otra.",
    CONSENT_REQUIRED: "La persona debe confirmar que es mayor de edad y aceptar el consentimiento.",
    CONSENT_ALREADY_RECORDED: "Esa decisión ya está registrada.",
    DECISION_ALREADY_RECORDED: "Esta fotografía ya fue decidida.",
    PHOTO_REQUIRED: "Esto aplica a la fotografía más reciente del participante.",
    ENTRY_HAS_MEDIA: "Este participante ya tiene fotografía: retíralo en lugar de eliminarlo.",
    ENTRY_ALREADY_WITHDRAWN: "Este participante ya fue retirado.",
    ENTRY_NOT_FOUND: "No existe ese participante.",
    CONFIRMATION_REJECTED: "El código no coincide. Pídele a la persona que lo lea de su pantalla.",
    CLAIM_VOIDED: "Demasiados códigos incorrectos: la asociación quedó anulada. Crea el participante de nuevo.",
    CONFIRMATION_NOT_PENDING: "Esta persona aún no ha ingresado su código de concursante.",
    CLAIM_EXPIRED: "El código venció. Crea el participante de nuevo.",
    WRONG_ROUND: "Esto no aplica a esta ronda.",
    VOTING_NOT_OPEN: "La votación no está abierta.",
    VOTING_WINDOW_ELAPSED: "El tiempo de votación terminó.",
    NO_ELIGIBLE_ENTRIES: "No queda ningún participante para avanzar.",
    FINALISTS_NOT_SELECTED: "Primero hay que hacer el corte de finalistas de la preliminar.",
    POLICY_REQUIRED: "Falta registrar una decisión aprobada por el Founder antes de continuar. Se nombra en el panel de políticas.",
    POLICY_ALREADY_RECORDED: "Esa política ya está registrada y no se puede cambiar.",
    REVIEW_REQUIRED: "Primero registra la revisión de los resultados.",
    REVIEW_STALE: "Los resultados o los participantes elegibles cambiaron después de la revisión (por ejemplo, un retiro o una decisión). Regístrala de nuevo.",
    ALREADY_PUBLISHED: "Estos resultados ya se publicaron.",
    RESULTS_NOT_AVAILABLE: "Los totales solo se ven cuando la votación está cerrada.",
    NO_VALID_RESULT: "La final no tiene ningún voto válido: no hay resultado que publicar ni ganador. Los votos y la evidencia se conservan. El sistema no ofrece cancelar, reabrir, extender ni elegir un ganador; hace falta una resolución explícita.",
    ALREADY_CLOSED: "Esto ya está cerrado.",
    ADMISSION_CLOSED: "Ya no se admiten nuevos votantes en esta ronda.",
    PROFILE_INCOMPLETE: "Completa tu perfil de URBANO Gaming para operar.",
    VERIFIED_EMAIL_REQUIRED: "Necesitas un correo verificado para operar.",
    INSTANCE_ALREADY_REGISTERED: "Esta sesión ya tiene una ronda registrada.",
    SESSION_NOT_REGISTRABLE: "Esta sesión ya no puede registrarse.",
    CAPABILITY_SET_NOT_EXACTLY_VOTING: "La sesión debe tener únicamente la capacidad de votación.",
    PARTICIPANTS_ALREADY_EXIST: "La sesión ya tiene participantes: crea una sesión nueva.",
    INVALID_GEOFENCE_CONFIG: "Los datos del lugar (latitud, longitud, radio, precisión y márgenes) no son válidos.",
    INVALID_LOCATION_READING: "La lectura de ubicación no es válida. Vuelve a intentarlo.",
    GEOFENCE_FROZEN: "La final ya abrió: la geocerca ya no se puede cambiar.",
    NOT_A_FINAL: "Solo la final tiene geocerca: la preliminar se vota desde cualquier lugar.",
    TEST_MODE_MISMATCH: "La final debe ser de prueba si su preliminar es de prueba, y real si es real.",
    CANDIDATE_NOT_AVAILABLE: "Ese participante ya no está disponible.",
    SCHEDULE_INVALID: "Los horarios no son coherentes: el orden debe ser registro, hora límite, apertura y cierre. La final no lleva hora de cierre: su tiempo cuenta desde que la abres.",
    SCHEDULE_REQUIRED: "La preliminar necesita una hora de cierre configurada y futura antes de abrirse: es el límite para votar.",
    INVALID_REQUEST: "Algo en la solicitud no es válido. Revisa los datos.",
    INTERNAL_ERROR: "Algo salió mal en el servidor. Inténtalo de nuevo.",
    NETWORK: "No hay conexión con el servidor. Inténtalo de nuevo.",
  };

  /**
   * What the operator is told when a final closes with no valid vote. It states what the system holds and what it does NOT do: it keeps the
   * votes and the round's evidence, publishes nobody, and offers no way out of its own — the way out is an explicit resolution by whoever
   * owns the event, which is not decided here.
   */
  const NO_VALID_RESULT_NOTICE =
    "La final cerró sin ningún voto válido, así que no tiene un resultado que publicar y no hay ganador. Los votos y la evidencia de la ronda se conservan. " +
    "El sistema no ofrece cancelar, reabrir, extender ni elegir un ganador a mano: esto requiere una resolución explícita de quien decide sobre el evento.";

  function describeError(code) {
    return (typeof code === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) || "No se pudo completar la acción. Inténtalo de nuevo.";
  }

  /** A thin client for the operator routes. The bearer proves WHO, the host token proves the event. Every call returns { status, json }. */
  function buildOperatorApi(fetchImpl, getToken, getHostToken, instanceId) {
    const base = `/api/gaming/community-voting/rounds/${instanceId}`;
    async function call(path, method, body) {
      const headers = { "Content-Type": "application/json" };
      const token = await getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const host = getHostToken();
      if (host) headers["x-host-token"] = host;
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
      overview: () => call("/operator/overview", "GET"),
      results: () => call("/operator/results", "GET"),
      schedule: (body) => call("/schedule", "PUT", body),
      geofence: (venue) => call("/operator/geofence", "PUT", { venue }),
      testGeofence: (location) => call("/operator/geofence/test", "POST", { location }),
      createEntry: (claimTtlSeconds) => call("/operator/entries", "POST", { claimTtlSeconds }),
      removeEntry: (entryId) => call(`/operator/entries/${entryId}`, "DELETE"),
      photo: (entryId, fullImage, thumbImage) => call(`/operator/entries/${entryId}/photo`, "POST", { fullImage, thumbImage }),
      consent: (entryId, photoId, consentVersion) => call(`/operator/entries/${entryId}/consent`, "POST", { photoId, consentVersion, accepted: true, ageConfirmed: true }),
      promo: (entryId, consentVersion, decision) => call(`/operator/entries/${entryId}/promo-consent`, "POST", { consentVersion, decision }),
      decision: (entryId, photoId, decision, reason) => call(`/operator/entries/${entryId}/decision`, "POST", { photoId, decision, reason }),
      association: (entryId, confirmationCode) => call(`/operator/entries/${entryId}/association`, "POST", { confirmationCode }),
      hidePhoto: (entryId, reason) => call(`/operator/entries/${entryId}/photo-hide`, "POST", { reason }),
      withdraw: (entryId, reason, hidePhoto) => call(`/operator/entries/${entryId}/withdrawal`, "POST", { reason, hidePhoto: hidePhoto === true }),
      policy: (policyKey, approvalReference) => call("/operator/policies", "POST", { policyKey, policyValue: POLICY_INFO[policyKey] ? POLICY_INFO[policyKey].value : "", approvalReference }),
      resolveTask: (taskId, note) => call(`/operator/tasks/${taskId}`, "POST", { note }),
      open: (promptText) => call("/operator/open", "POST", { promptText }),
      close: () => call("/operator/close", "POST", {}),
      finalists: () => call("/operator/finalists", "POST", {}),
      prepareFinal: () => call("/operator/prepare-final", "POST", {}),
      review: (note) => call("/operator/review", "POST", { note }),
      publish: () => call("/operator/publish", "POST", {}),
      info: () => call("/info", "GET"),
    };
  }

  return {
    EVENT_TIME_ZONE,
    EVENT_SCHEDULE_TEMPLATE,
    toEventInstant,
    fromEventInstant,
    templateInstants,
    planResize,
    formatClaimCode,
    entryNextStep,
    roundReadiness,
    POLICY_INFO,
    POLICY_ORDER,
    POLICY_STATUS_PENDING,
    POLICY_STATUS_RECORDED,
    POLICY_ACTION_LABEL,
    POLICY_OPERATOR_NOTICE,
    POLICY_ACK_TEXT,
    POLICY_RECORDED_NOTICE,
    POLICY_MISSING_ACK,
    POLICY_MISSING_REFERENCE,
    NO_VALID_RESULT_NOTICE,
    TEST_EVENT_LABEL,
    TEST_EVENT_NOTICE,
    GEOFENCE_FIELDS,
    GEOFENCE_HELP,
    parseGeofenceForm,
    geofenceToForm,
    geofenceDirty,
    readDevicePosition,
    proposeCenter,
    describeLocationError,
    describeTestResult,
    schematic,
    lobbyStatus,
    LOBBY_LOCK_NOTICE,
    nextSteps,
    deadlineLabel,
    promoLabel,
    describeError,
    buildOperatorApi,
  };
})();
