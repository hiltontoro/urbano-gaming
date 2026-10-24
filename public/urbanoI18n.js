// URBANO Gaming — public shell language (Español / English).
//
// Spanish is the default. The browser's own language is NEVER consulted: a person who has not chosen sees Spanish. The choice is a
// per-viewer convenience kept in localStorage under "urbano.lang"; when localStorage is missing, blocked or throws (private windows,
// blocked site data) everything still works and the choice simply lasts for the page. Nothing here is sent to a server.
//
// Scope: this module translates TEXT only. Identifiers, data values (team, player, venue and competition names, prize labels), API
// contracts, evaluation rules and time-zone policy are never touched. Server-sent strings are translated only when they are an exact,
// known message (see pred.srv.* below); an unknown server message is never guessed at.
//
// Use on a page:
//   <html lang="es"> ... <script src="/urbanoI18n.js"></script>   (before the page's own scripts)
//   static text:      <span data-i18n="key">Texto en español</span>          (the Spanish text is the no-script first paint)
//   with variables:   data-i18n="key" data-i18n-vars='{"n":3}'               (a value {"$t":"other.key"} is translated at apply time)
//   attributes:       data-i18n-attr="placeholder:key;aria-label:other.key"
//   selector buttons: <button data-lang="es" aria-pressed="true">ES</button>  <button data-lang="en" aria-pressed="false">EN</button>
//   JS:               UrbanoI18n.t("key", { name }) ; UrbanoI18n.onChange(cb) ; UrbanoI18n.apply(root)
//
// The shared sign-in component (urbanoAuth.js) calls UrbanoI18n only when it is present, so pages that do not load this module (for
// example the administrative portal) keep their English text exactly as before.
(function (root) {
  "use strict";

  var STORAGE_KEY = "urbano.lang";
  var DEFAULT_LANG = "es";
  var LANGS = ["es", "en"];
  var LOCALES = { es: "es-HN", en: "en-US" };

  var DICT = {
    es: {
      // ---- shell (shared header, navigation, footer) ----
      "shell.lang.label": "Idioma",
      "shell.lang.es": "Cambiar a español",
      "shell.lang.en": "Cambiar a inglés",
      "shell.brand.urbano": "URBANO — ir a urbanohn.com",
      "shell.brand.gaming": "URBANO Gaming — inicio",
      "shell.nav.label": "Navegación principal",
      "shell.nav.home": "Inicio",
      "shell.nav.play": "Jugar",
      "shell.nav.experiences": "Experiencias",
      "shell.nav.leaderboards": "Clasificaciones",
      "shell.nav.rewards": "Premios",
      "shell.footer.part": "URBANO Gaming — parte de URBANO",
      "shell.footer.tecnomovi": "TecnoMovi — ir a tecnomovi.com",

      // ---- Home ----
      "home.title": "URBANO Gaming",
      "home.hero.title": "Jugá, predecí y competí con tu comunidad.",
      "home.hero.sub": "Trivia, predicciones, minijuegos competitivos y experiencias en vivo — hechos para jugar juntos.",
      "home.featured.label": "Destacado",
      "home.pred.soon": "Próximamente",
      "home.pred.historyPast": "Ver predicciones y resultados anteriores →",
      "home.score.clasico": "El Clásico: Real Madrid vs. Barcelona",
      "home.score.venue": "Vivilo en The Pub by Beer Box",
      "home.score.when": "Domingo 25 de octubre · 2:00 p. m. (hora de Honduras) · 21:00 en España",
      "home.score.sides": "Barcelona es local · Real Madrid, visitante",
      "home.score.soon": "Predicciones próximamente",
      "home.games.label": "Juegos de habilidad",
      "home.games.note": "Vienen más juegos competitivos en camino.",
      "home.minigames.label": "Minijuegos",
      "home.art.community": "Comunidad",
      "home.exp.label": "Experiencias",
      "home.organizers.label": "Para organizadores",
      "home.competitions.sub": "Ligas y torneos de tu comunidad.",
      "home.status.featured": "Destacado",
      "home.status.playtest": "Playtest",
      "home.status.soon": "Próximamente",
      "home.locked.soon": "Próximamente",
      "home.open": "Abrir →",
      "home.poker.sub": "Organizá una mesa privada de No-Limit Hold'em para tu grupo.",
      "home.poker.action": "Organizar →",
      "home.trivia.sub": "Organizá o unite a una sesión en vivo — probá el playtest actual de Trivia.",
      "home.rutas.sub": "Deslizá cada pieza hasta su salida. Elegí un escenario para empezar.",
      "home.towers.sub": "Llevá toda la pila a la torre objetivo. Una pieza grande nunca queda sobre una más pequeña.",
      "home.host.title": "Ser anfitrión",
      "home.host.closed": "Las solicitudes para ser anfitrión todavía no están abiertas.",
      "home.host.open": "Postulate para organizar un torneo privado, solo por invitación, en tu local, para adultos que conocés.",
      "home.host.action": "Postularme →",
      "home.halloween.sub": "Votación de la comunidad en vivo, pensada para Halloween.",

      // ---- shared sign-in component (urbanoAuth.js) ----
      "auth.btn.signedOut": "Iniciar sesión / Crear cuenta",
      "auth.btn.finish": "Terminá de crear tu cuenta",
      "auth.btn.hi": "Hola, {name}",
      "auth.profile.title": "Ver mi perfil",
      "auth.signOut": "Cerrar sesión",
      "auth.panel.aria": "Iniciar sesión o crear una cuenta",
      "auth.entry.title": "Entrá a URBANO",
      "auth.entry.note": "Iniciá sesión en tu cuenta o creá una.",
      "auth.login": "Iniciar sesión",
      "auth.register": "Crear cuenta",
      "auth.method.loginNote": "Elegí cómo recibir tu código.",
      "auth.method.registerNote": "Te enviaremos un código para confirmar que sos vos.",
      "auth.method.email": "Correo",
      "auth.method.phone": "Teléfono",
      "auth.method.phoneSoon": "Teléfono — todavía no disponible",
      "auth.method.phoneSoonTitle": "El acceso por teléfono todavía no está disponible.",
      "auth.method.phoneSoonMsg": "El acceso por teléfono todavía no está disponible. Usá tu correo.",
      "auth.input.emailPlaceholder": "tu@ejemplo.com",
      "auth.input.emailAria": "Correo electrónico",
      "auth.input.phoneAria": "Número de teléfono",
      "auth.sendLogin": "Enviar código de acceso",
      "auth.sendVerification": "Enviar código de verificación",
      "auth.phoneHint": "Usá el código de país, por ejemplo +504 9999 9999.",
      "auth.back": "Volver",
      "auth.switch.toRegister": "Crear una cuenta en su lugar",
      "auth.switch.toLogin": "Ya tengo una cuenta",
      "auth.code.title": "Ingresá tu código",
      "auth.code.introLoginEmail": "Si {id} tiene una cuenta, te llegará un código en breve. Puede tardar un minuto; revisá tu carpeta de spam si no lo ves.",
      "auth.code.introLoginPhone": "Si {id} tiene una cuenta, te llegará un mensaje de texto con un código. Puede tardar un minuto.",
      "auth.code.introRegisterEmail": "Enviamos un código a {id}. Puede tardar un minuto; revisá tu carpeta de spam si no lo ves.",
      "auth.code.introRegisterPhone": "Enviamos un mensaje de texto con un código a {id}. Puede tardar un minuto.",
      "auth.code.placeholder": "Código de verificación",
      "auth.code.verify": "Verificar",
      "auth.code.resend": "Reenviar código",
      "auth.code.resendIn": "Reenviar código en {s} s",
      "auth.code.otherNumber": "Usar otro número",
      "auth.code.otherEmail": "Usar otro correo",
      "auth.code.noCodeEmail": "¿No te llegó el código por correo? ",
      "auth.code.noCodePhone": "¿No te llegó el código por mensaje de texto? ",
      "auth.name.title": "Elegí tu nombre para mostrar",
      "auth.name.note": "Así vas a aparecer en los juegos.",
      "auth.name.placeholder": "Cómo vas a aparecer en los juegos",
      "auth.name.aria": "Nombre para mostrar",
      "auth.continue": "Continuar",
      "auth.welcome.title": "Te damos la bienvenida de nuevo",
      "auth.welcome.email": "Este correo ya tiene una cuenta, así que iniciamos tu sesión como {name}.",
      "auth.welcome.phone": "Este número de teléfono ya tiene una cuenta, así que iniciamos tu sesión como {name}.",
      "auth.msg.phoneEmpty": "Ingresá tu número de teléfono con el código de país, por ejemplo +504 9999 9999.",
      "auth.msg.phoneNoCountry": "Empezá con el código de país, por ejemplo +504 9999 9999 para Honduras.",
      "auth.msg.phoneInvalid": "Ese número de teléfono no parece válido. Usá el código de país seguido del número, por ejemplo +504 9999 9999.",
      "auth.msg.emailEmpty": "Ingresá tu correo electrónico.",
      "auth.msg.emailInvalid": "Eso no parece un correo electrónico. Revisalo e intentá de nuevo.",
      "auth.msg.requestingLogin": "Solicitando tu código de acceso...",
      "auth.msg.sendingVerification": "Enviando tu código de verificación...",
      "auth.msg.sendingNew": "Enviando un código nuevo...",
      "auth.msg.resentLogin": "Si existe una cuenta, te llegará un código nuevo. Los códigos anteriores ya no funcionan.",
      "auth.msg.resentRegister": "Te llegará un código nuevo. Los códigos anteriores ya no funcionan.",
      "auth.msg.codeEmptyPhone": "Ingresá el código de tu mensaje de texto.",
      "auth.msg.codeEmptyEmail": "Ingresá el código de tu correo.",
      "auth.msg.verifying": "Verificando...",
      "auth.msg.incompleteLogin": "Encontramos tu acceso pero no una cuenta terminada. Elegí un nombre para mostrar para terminarla.",
      "auth.msg.lastStep": "Un último paso para terminar de crear tu cuenta.",
      "auth.msg.nameEmpty": "Ingresá un nombre para mostrar.",
      "auth.msg.saving": "Guardando...",
      "auth.err.rateLimited": "Demasiadas solicitudes. Esperá {seconds} segundos e intentá de nuevo.",
      "auth.err.rateLimitedFew": "Demasiadas solicitudes. Esperá unos segundos e intentá de nuevo.",
      "auth.err.codeInvalid": "Ese código no es válido o venció. Revisá el código o pedí uno nuevo.",
      "auth.err.signupClosed": "Por ahora no se pueden crear cuentas nuevas.",
      "auth.err.phoneUnavailable": "El acceso por teléfono no está disponible en este momento.",
      "auth.err.phoneUnavailableYet": "El acceso por teléfono todavía no está disponible.",
      "auth.err.invalidPhone": "Ese número de teléfono no se puede usar.",
      "auth.err.invalidEmail": "Ese correo electrónico no se puede usar.",
      "auth.err.network": "No pudimos conectarnos con el servidor. Revisá tu conexión e intentá de nuevo.",
      "auth.err.unknown": "Algo salió mal. Intentá de nuevo.",
      "auth.err.notSignedIn": "No iniciaste sesión.",
      "auth.err.identityChanged": "Tu sesión cambió. Intentá de nuevo.",
      "auth.err.profileFailed": "No se pudo completar el perfil.",
      "auth.srv.nameEmpty": "El nombre para mostrar no puede estar vacío.",
      "auth.srv.nameTooLong": "El nombre para mostrar no puede superar los 40 caracteres.",
      "auth.link.error": "Este enlace de acceso no es válido, ya se usó o venció. Pedí uno nuevo para iniciar sesión.",
      "auth.link.retry": "Pedir un código nuevo",

      // ---- public URBANO Score journey (the public name; the route and identifiers keep their historical names) ----
      "pred.title": "URBANO Score — URBANO Gaming",
      "pred.back": "← Volver a URBANO Gaming",
      "pred.loading": "Cargando URBANO Score…",
      "pred.descriptor": "Tus predicciones deportivas",
      "pred.scope": "Por ahora solo hay fútbol disponible.",
      "pred.empty": "Todavía no hay partidos abiertos para predicciones — volvé pronto.",
      "pred.updating": "Actualizando…",
      "pred.err.refresh": "No pudimos actualizar los partidos. Recargá la página para intentar de nuevo.",
      "pred.err.load": "No pudimos cargar los partidos. Recargá la página para intentar de nuevo.",
      "pred.home": "Local",
      "pred.away": "Visitante",
      "pred.vs": "vs",
      "pred.result": "Resultado: {home}–{away}",
      "pred.locked": "Bloqueado — esperando el resultado oficial",
      "pred.login.unfinished": "Un paso más: elegí un nombre para mostrar y terminá de crear tu cuenta; después hacé tu predicción.",
      "pred.login.prompt": "Iniciá sesión o creá una cuenta para hacer tu predicción.",
      "pred.login.finishBtn": "Terminá de crear tu cuenta",
      "pred.login.btn": "Iniciar sesión o crear cuenta",
      "pred.dim.scoreline": "Marcador",
      "pred.dim.goalscorer": "Goleador",
      "pred.dim.goalMinute": "Minuto del gol",
      "pred.dim.firstScorer": "Primer anotador",
      "pred.correctCount": "{n} de 4 correctas.",
      "pred.noGoalscorer": "Sin goleador",
      "pred.noGoal": "Sin gol",
      "pred.yours.full": "Tu predicción: {home}–{away}, {scorer}, {minute}, primero: {first}",
      "pred.yours.awaiting": "Tu predicción: {home}–{away}. Esperando el resultado oficial.",
      "pred.missed": "No enviaste una predicción antes del inicio del partido.",
      "pred.noVenue": "Por ahora no hay ninguna sede activa para este partido.",
      "pred.f.venue": "Sede",
      "pred.f.checking": "Verificando tu ubicación…",
      "pred.f.exact": "Marcador exacto",
      "pred.f.who": "¿Quién va a marcar?",
      "pred.f.noScorerOpt": "Sin goleador / Sin gol",
      "pred.f.minuteQ": "¿En qué minuto se marcará algún gol?",
      "pred.f.minutePlaceholder": "Sin gol — dejalo en blanco",
      "pred.f.stoppagePlaceholder": "agregado",
      "pred.f.minuteHint": "El tiempo agregado solo aplica en el minuto 45 o 90.",
      "pred.f.firstQ": "¿Quién marca primero?",
      "pred.f.update": "Actualizar predicción",
      "pred.f.submit": "Enviar predicción",
      "pred.geo.unavailable": "Ubicación no disponible — activá el acceso a la ubicación para enviar una predicción.",
      "pred.geo.within": "Estás dentro del alcance de esta sede.",
      "pred.geo.outside": "Parecés estar fuera del alcance de esta sede — el envío podría ser rechazado.",
      "pred.submitting": "Enviando…",
      "pred.locationRequired": "Se requiere tu ubicación para enviar una predicción.",
      "pred.saved": "Predicción guardada. Podés editarla hasta el inicio del partido.",
      "pred.failed": "No se pudo enviar la predicción.",
      "pred.signedInNote": "Ya iniciaste sesión. Hacé tu predicción abajo.",
      "pred.prize.qualified": "Premio obtenido: ",
      "pred.prize.superseded": "(reemplazado por una corrección del resultado).",
      "pred.prize.redeemed": "ya canjeado.",
      "pred.prize.delivered": "ya entregado antes — el resultado corregido no lo cambia.",
      "pred.prize.review": "en revisión por la sede tras una corrección del resultado — consultá con un anfitrión de URBANO antes de retirarlo.",
      "pred.prize.pending": "todavía sin canjear — consultá con un anfitrión de URBANO.",
      "pred.srv.matchNotFound": "No existe un partido con ese identificador.",
      "pred.srv.cancelled": "Este partido fue cancelado.",
      "pred.srv.locked": "Las predicciones están cerradas para este partido.",
      "pred.srv.notClassified": "Este partido todavía no tiene una clasificación de actividad declarada y no puede recibir predicciones.",
      "pred.srv.activationNotFound": "No existe una activación de sede con ese identificador.",
      "pred.srv.activationMismatch": "Esta activación de sede no corresponde al partido indicado.",
      "pred.srv.activationDisabled": "Esta activación de sede no está habilitada por ahora.",
      "pred.srv.activationImmutable": "Esta predicción se envió por primera vez a través de otra activación de sede.",
      "pred.srv.geoNotEligible": "El envío no cumplió los requisitos de ubicación.",
      "pred.srv.geoUnavailable": "No se pudo determinar la ubicación de este envío.",
      "pred.srv.invalidScore": "Los marcadores predichos no pueden ser negativos.",
      "pred.srv.invalidMinute": "El minuto de gol predicho debe ser un minuto reglamentario entre 1 y 90, y el tiempo agregado solo se admite cuando el minuto reglamentario es 45 o 90.",
      "pred.srv.invalidFirstTeam": "El primer equipo en marcar debe ser el local, el visitante o ninguno.",
      "pred.srv.invalidGoalscorer": "El goleador elegido debe ser un jugador activo de uno de los dos equipos de este partido.",
      "pred.srv.invalidJson": "El cuerpo de la solicitud debe ser un JSON válido.",
      "pred.srv.invalidPayload": "La predicción enviada no es válida.",
      "pred.srv.authRequired": "Necesitás iniciar sesión como miembro de URBANO Gaming para hacer esto.",
      "pred.srv.generic": "No pudimos guardar tu predicción. Intentá de nuevo.",

      // ---- profile (read-only shell) ----
      "profile.title": "Mi perfil — URBANO Gaming",
      "profile.heading": "Mi perfil",
      "profile.loading": "Cargando tu perfil…",
      "profile.signedOut": "Iniciá sesión para ver tu perfil.",
      "profile.signedOutBtn": "Iniciar sesión",
      "profile.incomplete": "Terminá de crear tu cuenta para ver tu perfil.",
      "profile.incompleteBtn": "Terminá de crear tu cuenta",
      "profile.name": "Nombre",
      "profile.email": "Correo",
      "profile.emailStatus": "Estado del correo",
      "profile.verified": "Verificado",
      "profile.unverified": "Sin verificar",
      "profile.unknown": "No disponible",
      "profile.since": "Miembro desde",
      "profile.predictions": "Mis predicciones en URBANO Score →",
      "profile.readOnly": "Por ahora tu perfil es de solo lectura.",
      "profile.soon.heading": "Próximamente",
      "profile.soon.name": "Nombre editable",
      "profile.soon.password": "Contraseña",
      "profile.soon.avatar": "Avatar",
      "profile.soon.phone": "Teléfono verificado",
      "profile.soon.pill": "Próximamente",
      "profile.err": "No pudimos cargar tu perfil. Recargá la página para intentar de nuevo."
    },

    en: {
      "shell.lang.label": "Language",
      "shell.lang.es": "Switch to Spanish",
      "shell.lang.en": "Switch to English",
      "shell.brand.urbano": "URBANO — go to urbanohn.com",
      "shell.brand.gaming": "URBANO Gaming — home",
      "shell.nav.label": "Main navigation",
      "shell.nav.home": "Home",
      "shell.nav.play": "Play",
      "shell.nav.experiences": "Experiences",
      "shell.nav.leaderboards": "Leaderboards",
      "shell.nav.rewards": "Rewards",
      "shell.footer.part": "URBANO Gaming — part of URBANO",
      "shell.footer.tecnomovi": "TecnoMovi — go to tecnomovi.com",

      "home.title": "URBANO Gaming",
      "home.hero.title": "Play, predict, and compete with your community.",
      "home.hero.sub": "Trivia, predictions, competitive minigames, and live experiences — built for playing together.",
      "home.featured.label": "Featured",
      "home.pred.soon": "Coming Soon",
      "home.pred.historyPast": "See past predictions and results →",
      "home.score.clasico": "El Clásico: Real Madrid vs. Barcelona",
      "home.score.venue": "Watch it at The Pub by Beer Box",
      "home.score.when": "Sunday, October 25 · 2:00 p.m. (Honduras time) · 9:00 p.m. in Spain",
      "home.score.sides": "Barcelona is the home team · Real Madrid, the visitor",
      "home.score.soon": "Predictions coming soon",
      "home.games.label": "Skill Games",
      "home.games.note": "More competitive games are on the way.",
      "home.minigames.label": "Minigames",
      "home.art.community": "Community",
      "home.exp.label": "Experiences",
      "home.organizers.label": "For organizers",
      "home.competitions.sub": "Leagues and tournaments for your community.",
      "home.status.featured": "Featured",
      "home.status.playtest": "Playtest",
      "home.status.soon": "Coming Soon",
      "home.locked.soon": "Coming soon",
      "home.open": "Open →",
      "home.poker.sub": "Host a private No-Limit Hold'em table for your group.",
      "home.poker.action": "Host →",
      "home.trivia.sub": "Host or join a live session — try the current Trivia playtest.",
      "home.rutas.sub": "Slide each piece to its matching exit. Choose a scenario to begin.",
      "home.towers.sub": "Move the whole stack to the target tower. A larger piece never rests on a smaller one.",
      "home.host.title": "Become a Host",
      "home.host.closed": "Host applications are not open yet.",
      "home.host.open": "Apply to run a private, invite-only tournament at your venue, for adults you know.",
      "home.host.action": "Apply →",
      "home.halloween.sub": "Live community voting, designed for Halloween.",

      "auth.btn.signedOut": "Log in / Create account",
      "auth.btn.finish": "Finish creating your account",
      "auth.btn.hi": "Hi, {name}",
      "auth.profile.title": "View my profile",
      "auth.signOut": "Sign out",
      "auth.panel.aria": "Log in or create an account",
      "auth.entry.title": "Enter URBANO",
      "auth.entry.note": "Log in to your account, or create one.",
      "auth.login": "Log in",
      "auth.register": "Create account",
      "auth.method.loginNote": "Choose how to get your code.",
      "auth.method.registerNote": "We'll send a code to confirm it's really you.",
      "auth.method.email": "Email",
      "auth.method.phone": "Phone",
      "auth.method.phoneSoon": "Phone — not available yet",
      "auth.method.phoneSoonTitle": "Phone sign-in isn't available yet.",
      "auth.method.phoneSoonMsg": "Phone sign-in isn't available yet. Please use your email.",
      "auth.input.emailPlaceholder": "you@example.com",
      "auth.input.emailAria": "Email address",
      "auth.input.phoneAria": "Phone number",
      "auth.sendLogin": "Send login code",
      "auth.sendVerification": "Send verification code",
      "auth.phoneHint": "Use the country code, for example +504 9999 9999.",
      "auth.back": "Back",
      "auth.switch.toRegister": "Create an account instead",
      "auth.switch.toLogin": "I already have an account",
      "auth.code.title": "Enter your code",
      "auth.code.introLoginEmail": "If {id} has an account, a code is on its way. It can take a minute to arrive; check your spam folder if you don't see it.",
      "auth.code.introLoginPhone": "If {id} has an account, a text message with a code is on its way. It can take a minute to arrive.",
      "auth.code.introRegisterEmail": "We sent a code to {id}. It can take a minute to arrive; check your spam folder if you don't see it.",
      "auth.code.introRegisterPhone": "We sent a text message with a code to {id}. It can take a minute to arrive.",
      "auth.code.placeholder": "Verification code",
      "auth.code.verify": "Verify",
      "auth.code.resend": "Resend code",
      "auth.code.resendIn": "Resend code in {s}s",
      "auth.code.otherNumber": "Use a different number",
      "auth.code.otherEmail": "Use a different email",
      "auth.code.noCodeEmail": "No code from your email? ",
      "auth.code.noCodePhone": "No code from your text message? ",
      "auth.name.title": "Choose your display name",
      "auth.name.note": "This is how you'll appear in games.",
      "auth.name.placeholder": "How you'll appear in games",
      "auth.name.aria": "Display name",
      "auth.continue": "Continue",
      "auth.welcome.title": "Welcome back",
      "auth.welcome.email": "This email already has an account, so we signed you in as {name}.",
      "auth.welcome.phone": "This phone number already has an account, so we signed you in as {name}.",
      "auth.msg.phoneEmpty": "Enter your phone number with its country code, for example +504 9999 9999.",
      "auth.msg.phoneNoCountry": "Start with the country code, for example +504 9999 9999 for Honduras.",
      "auth.msg.phoneInvalid": "That doesn't look like a valid phone number. Use the country code followed by the number, for example +504 9999 9999.",
      "auth.msg.emailEmpty": "Enter your email address.",
      "auth.msg.emailInvalid": "That doesn't look like an email address. Check it and try again.",
      "auth.msg.requestingLogin": "Requesting your login code...",
      "auth.msg.sendingVerification": "Sending your verification code...",
      "auth.msg.sendingNew": "Sending a new code...",
      "auth.msg.resentLogin": "If an account exists, a new code is on its way. Older codes no longer work.",
      "auth.msg.resentRegister": "A new code is on its way. Older codes no longer work.",
      "auth.msg.codeEmptyPhone": "Enter the code from your text message.",
      "auth.msg.codeEmptyEmail": "Enter the code from your email.",
      "auth.msg.verifying": "Verifying...",
      "auth.msg.incompleteLogin": "We found your sign-in but no finished account. Choose a display name to finish.",
      "auth.msg.lastStep": "One last step to finish creating your account.",
      "auth.msg.nameEmpty": "Enter a display name.",
      "auth.msg.saving": "Saving...",
      "auth.err.rateLimited": "Too many requests. Please wait {seconds} seconds and try again.",
      "auth.err.rateLimitedFew": "Too many requests. Please wait a few seconds and try again.",
      "auth.err.codeInvalid": "That code isn't valid or has expired. Check the code, or send a new one.",
      "auth.err.signupClosed": "New accounts can't be created right now.",
      "auth.err.phoneUnavailable": "Phone sign-in isn't available right now.",
      "auth.err.phoneUnavailableYet": "Phone sign-in isn't available yet.",
      "auth.err.invalidPhone": "That phone number can't be used.",
      "auth.err.invalidEmail": "That email address can't be used.",
      "auth.err.network": "Couldn't reach the server. Check your connection and try again.",
      "auth.err.unknown": "Something went wrong. Please try again.",
      "auth.err.notSignedIn": "Not signed in.",
      "auth.err.identityChanged": "Your session changed. Please try again.",
      "auth.err.profileFailed": "Failed to complete profile.",
      "auth.srv.nameEmpty": "Display name cannot be empty.",
      "auth.srv.nameTooLong": "Display name cannot exceed 40 characters.",
      "auth.link.error": "This sign-in link isn't valid, was already used, or has expired. Request a new one to sign in.",
      "auth.link.retry": "Request a new code",

      "pred.title": "URBANO Score — URBANO Gaming",
      "pred.back": "← Back to URBANO Gaming",
      "pred.loading": "Loading URBANO Score…",
      "pred.descriptor": "Your sports predictions",
      "pred.scope": "For now, only soccer is available.",
      "pred.empty": "No matches are open for prediction yet — check back soon.",
      "pred.updating": "Updating…",
      "pred.err.refresh": "Couldn't update the matches. Reload the page to try again.",
      "pred.err.load": "Couldn't load the matches. Reload the page to try again.",
      "pred.home": "Home",
      "pred.away": "Away",
      "pred.vs": "vs",
      "pred.result": "Result: {home}–{away}",
      "pred.locked": "Locked — awaiting official result",
      "pred.login.unfinished": "One more step: choose a display name to finish creating your account, then make your prediction.",
      "pred.login.prompt": "Log in or create an account to make your prediction.",
      "pred.login.finishBtn": "Finish creating your account",
      "pred.login.btn": "Log in or create account",
      "pred.dim.scoreline": "Scoreline",
      "pred.dim.goalscorer": "Goalscorer",
      "pred.dim.goalMinute": "Goal Minute",
      "pred.dim.firstScorer": "First Scorer",
      "pred.correctCount": "{n} of 4 correct.",
      "pred.noGoalscorer": "No Goalscorer",
      "pred.noGoal": "No Goal",
      "pred.yours.full": "Your prediction: {home}–{away}, {scorer}, {minute}, first: {first}",
      "pred.yours.awaiting": "Your prediction: {home}–{away}. Awaiting the official result.",
      "pred.missed": "You did not submit a prediction before kickoff.",
      "pred.noVenue": "No venue is currently active for this match.",
      "pred.f.venue": "Venue",
      "pred.f.checking": "Checking your location…",
      "pred.f.exact": "Exact score",
      "pred.f.who": "Who will score?",
      "pred.f.noScorerOpt": "No Goalscorer / No Goal",
      "pred.f.minuteQ": "At what minute will any goal be scored?",
      "pred.f.minutePlaceholder": "No Goal — leave blank",
      "pred.f.stoppagePlaceholder": "stoppage",
      "pred.f.minuteHint": "Stoppage time only applies at minute 45 or 90.",
      "pred.f.firstQ": "Who scores first?",
      "pred.f.update": "Update Prediction",
      "pred.f.submit": "Submit Prediction",
      "pred.geo.unavailable": "Location unavailable — enable location access to submit a prediction.",
      "pred.geo.within": "You're within range of this venue.",
      "pred.geo.outside": "You appear to be outside this venue's range — submission may be rejected.",
      "pred.submitting": "Submitting…",
      "pred.locationRequired": "Location is required to submit a prediction.",
      "pred.saved": "Prediction saved. You can edit it until kickoff.",
      "pred.failed": "Failed to submit prediction.",
      "pred.signedInNote": "You're signed in. Make your prediction below.",
      "pred.prize.qualified": "Prize qualified: ",
      "pred.prize.superseded": "(superseded by a result correction).",
      "pred.prize.redeemed": "already redeemed.",
      "pred.prize.delivered": "already handed over earlier — the corrected result does not change it.",
      "pred.prize.review": "being reviewed by the venue after a result correction — ask an URBANO host before collecting.",
      "pred.prize.pending": "not yet redeemed — see an URBANO host.",
      "pred.srv.matchNotFound": "No match exists for this id.",
      "pred.srv.cancelled": "This match has been cancelled.",
      "pred.srv.locked": "Predictions are locked for this match.",
      "pred.srv.notClassified": "This match has no declared Activity Classification and cannot accept predictions yet.",
      "pred.srv.activationNotFound": "No venue activation exists for this id.",
      "pred.srv.activationMismatch": "This venue activation is not for the supplied match.",
      "pred.srv.activationDisabled": "This venue activation is not currently enabled.",
      "pred.srv.activationImmutable": "This prediction was first submitted through a different venue activation.",
      "pred.srv.geoNotEligible": "Submission failed geolocation eligibility.",
      "pred.srv.geoUnavailable": "Location could not be determined for this submission.",
      "pred.srv.invalidScore": "Predicted scores must be non-negative.",
      "pred.srv.invalidMinute": "Predicted goal minute must be a regulation minute between 1 and 90, with a positive stoppage offset allowed only when the regulation minute is 45 or 90.",
      "pred.srv.invalidFirstTeam": "Predicted first team to score must be HOME, AWAY, or null.",
      "pred.srv.invalidGoalscorer": "The selected goalscorer must be an active player on one of this match's two teams.",
      "pred.srv.invalidJson": "Request body must be valid JSON.",
      "pred.srv.invalidPayload": "Invalid prediction payload.",
      "pred.srv.authRequired": "A valid Authorization header for an authenticated Gaming Member is required.",
      "pred.srv.generic": "Failed to submit prediction.",

      "profile.title": "My profile — URBANO Gaming",
      "profile.heading": "My profile",
      "profile.loading": "Loading your profile…",
      "profile.signedOut": "Log in to see your profile.",
      "profile.signedOutBtn": "Log in",
      "profile.incomplete": "Finish creating your account to see your profile.",
      "profile.incompleteBtn": "Finish creating your account",
      "profile.name": "Name",
      "profile.email": "Email",
      "profile.emailStatus": "Email status",
      "profile.verified": "Verified",
      "profile.unverified": "Not verified",
      "profile.unknown": "Not available",
      "profile.since": "Member since",
      "profile.predictions": "My predictions in URBANO Score →",
      "profile.readOnly": "Your profile is read-only for now.",
      "profile.soon.heading": "Coming soon",
      "profile.soon.name": "Editable name",
      "profile.soon.password": "Password",
      "profile.soon.avatar": "Avatar",
      "profile.soon.phone": "Verified phone",
      "profile.soon.pill": "Coming soon",
      "profile.err": "We couldn't load your profile. Reload the page to try again."
    }
  };

  // Server messages that are KNOWN and exact, mapped to their dictionary keys. Anything else is shown in the page's own generic
  // message (Spanish) or as received (English); this module never guesses at a translation of an unknown server string.
  var SERVER_MESSAGES = {
    "No match exists for this id.": "pred.srv.matchNotFound",
    "This match has been cancelled.": "pred.srv.cancelled",
    "Predictions are locked for this match.": "pred.srv.locked",
    "This match has no declared Activity Classification and cannot accept predictions yet.": "pred.srv.notClassified",
    "No venue activation exists for this id.": "pred.srv.activationNotFound",
    "This venue activation is not for the supplied match.": "pred.srv.activationMismatch",
    "This venue activation is not currently enabled.": "pred.srv.activationDisabled",
    "This prediction was first submitted through a different venue activation.": "pred.srv.activationImmutable",
    "Submission failed geolocation eligibility.": "pred.srv.geoNotEligible",
    "Location could not be determined for this submission.": "pred.srv.geoUnavailable",
    "Predicted scores must be non-negative.": "pred.srv.invalidScore",
    "Predicted goal minute must be a regulation minute between 1 and 90, with a positive stoppage offset allowed only when the regulation minute is 45 or 90.": "pred.srv.invalidMinute",
    "Predicted first team to score must be HOME, AWAY, or null.": "pred.srv.invalidFirstTeam",
    "The selected goalscorer must be an active player on one of this match's two teams.": "pred.srv.invalidGoalscorer",
    "Request body must be valid JSON.": "pred.srv.invalidJson",
    "Invalid prediction payload.": "pred.srv.invalidPayload",
    "A valid Authorization header for an authenticated Gaming Member is required.": "pred.srv.authRequired",
    "Failed to submit prediction.": "pred.srv.generic",
    "Display name cannot be empty.": "auth.srv.nameEmpty",
    "Display name cannot exceed 40 characters.": "auth.srv.nameTooLong",
    "Failed to create Gaming Member.": "auth.err.profileFailed"
  };

  var lang = DEFAULT_LANG;
  var listeners = [];

  function storage() {
    try {
      return root.localStorage || null;
    } catch (err) {
      return null;
    }
  }

  function readStored() {
    var s = storage();
    if (!s) return null;
    try {
      var value = s.getItem(STORAGE_KEY);
      return value === "es" || value === "en" ? value : null;
    } catch (err) {
      return null;
    }
  }

  function writeStored(value) {
    var s = storage();
    if (!s) return;
    try {
      s.setItem(STORAGE_KEY, value);
    } catch (err) {
      /* storage unavailable or full: the choice lasts for this page only */
    }
  }

  function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, function (whole, name) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
      var value = vars[name];
      if (value && typeof value === "object" && typeof value.$t === "string") return t(value.$t);
      return value === null || value === undefined ? "" : String(value);
    });
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(DICT[lang], key) || Object.prototype.hasOwnProperty.call(DICT.en, key);
  }

  function t(key, vars) {
    var table = DICT[lang];
    var template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : Object.prototype.hasOwnProperty.call(DICT.en, key) ? DICT.en[key] : key;
    return interpolate(template, vars);
  }

  function parseVars(el) {
    var raw = el.getAttribute("data-i18n-vars");
    if (!raw) return undefined;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch (err) {
      return undefined;
    }
  }

  function apply(scope) {
    var doc = root.document;
    if (!doc) return;
    var rootNode = scope || doc;
    if (doc.documentElement) doc.documentElement.setAttribute("lang", lang);
    var nodes = rootNode.querySelectorAll ? rootNode.querySelectorAll("[data-i18n]") : [];
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"), parseVars(nodes[i]));
    }
    var attrNodes = rootNode.querySelectorAll ? rootNode.querySelectorAll("[data-i18n-attr]") : [];
    for (var j = 0; j < attrNodes.length; j++) {
      var pairs = (attrNodes[j].getAttribute("data-i18n-attr") || "").split(";");
      for (var k = 0; k < pairs.length; k++) {
        var at = pairs[k].indexOf(":");
        if (at <= 0) continue;
        attrNodes[j].setAttribute(pairs[k].slice(0, at).trim(), t(pairs[k].slice(at + 1).trim(), parseVars(attrNodes[j])));
      }
    }
    var buttons = doc.querySelectorAll("[data-lang]");
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].setAttribute("aria-pressed", String(buttons[b].getAttribute("data-lang") === lang));
    }
  }

  function setLang(next) {
    if (LANGS.indexOf(next) < 0) return false;
    var changed = next !== lang;
    lang = next;
    writeStored(next);
    apply();
    if (changed) {
      listeners.slice().forEach(function (callback) {
        try {
          callback(lang);
        } catch (err) {
          if (root.console) root.console.error("UrbanoI18n: change listener failed:", err);
        }
      });
    }
    return true;
  }

  function onChange(callback) {
    listeners.push(callback);
    return function () {
      listeners = listeners.filter(function (cb) {
        return cb !== callback;
      });
    };
  }

  // The language buttons work by delegation, so a selector added after this script ran works too.
  function bindSelector() {
    var doc = root.document;
    if (!doc) return;
    doc.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest("[data-lang]") : null;
      if (!target) return;
      event.preventDefault();
      setLang(target.getAttribute("data-lang"));
    });
  }

  lang = readStored() || DEFAULT_LANG;

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_LANG: DEFAULT_LANG,
    LANGS: LANGS.slice(),
    getLang: function () {
      return lang;
    },
    setLang: setLang,
    t: t,
    has: has,
    // The locale used to format dates and numbers for the chosen language. Time-zone policy is NOT part of it.
    locale: function () {
      return LOCALES[lang];
    },
    // The dictionary key for an exact, known server message in this module's table, or null.
    serverMessageKey: function (message) {
      return Object.prototype.hasOwnProperty.call(SERVER_MESSAGES, message) ? SERVER_MESSAGES[message] : null;
    },
    onChange: onChange,
    apply: apply,
    dictionary: function () {
      return { es: Object.assign({}, DICT.es), en: Object.assign({}, DICT.en) };
    }
  };

  root.UrbanoI18n = api;
  if (root.document) {
    bindSelector();
    apply();
    // Loaded in <head> (before the page's text exists) the first apply() finds nothing: apply again once the document is ready.
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", function () {
        apply();
      });
    }
  }
})(typeof window !== "undefined" ? window : this);
