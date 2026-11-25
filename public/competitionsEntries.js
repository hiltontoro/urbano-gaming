// URBANO Gaming — Competitions team entries (UG-CR-GATE-CFM-016): the browser side of the invite-only pilot, from a team's formation to the freeze of its competition's entries.
//
// Two surfaces share this file, each mounted by an existing Competitions page into a host element that page owns:
//   - mountMember: on competitions.html — the member's team invitations and requests, their teams (and the creation of one), and, on one addressed competition, their
//     team's entry (enter, see the organizer's decision, see each roster place, withdraw) and the member's own roster proposal (accept, decline, withdraw).
//   - mountOrganizer: on competitions-admin.html — for the organizer of one addressed competition: switch team entries on or off, review the entries, approve, reject or
//     remove them with a reason, and freeze the entries.
//
// Everything that matters is decided by the server. These surfaces only SHOW what the accepted routes answer and send what a person chose; they hold no authority, they
// never read this browser's clock to decide that anything is allowed, and after every action they read the server again instead of concluding anything from an answer.
// The only actor is the verified Gaming Member the page's own authenticated fetch speaks for; no control here names a member, a team or a place by an identifier the
// person types: every identifier that is sent came from an earlier server answer to this same member.
//
// Two things replace identifiers (UG-CR-GATE-CFM-016A). A captain shares their team's join link: a signed-in person who opens it sees the team's name and nothing else, asks
// to join only by pressing the button, and the team's captain or sub-captain answers in the same inbox as every other request. And a leader proposing a roster chooses by
// display name from a read of their own team's members for that entry; each person still accepts their own place.
//
// What is deliberately NOT here: inviting a person. The product has no approved way for a page to find a person — a Gaming Member has no code or handle — so there is no
// control that asks for an identifier and no member directory.
//
// Safety rules this file keeps: every value that came from a server or a person (names, codes, sentences) is placed with textContent, never parsed as markup (nothing below
// builds an element from a string of markup); a surface is built only after the server has answered the reads it needs; any session change removes it in the same turn (unmountAll), aborts
// what it was waiting for and forgets what it held; an answer that arrives after that — or after the signed-in member is no longer the member the surface was built for —
// is discarded; nothing is sent for a member other than the one the surface was built for; and no private value is ever written to storage or to the address bar.
(function (root) {
  "use strict";

  const API = "/api/gaming/competitions";
  const DEFAULT_TIMEOUT_MS = 20000;
  const NOTE_MAX = 280;

  const COPY = {
    distinct: "Three different things happen here, and none of them stands in for another: the organizer decides on a team's entry; each player accepts their own roster place; and no payment is requested or confirmed on this page.",
    unavailable: "This could not be loaded right now.",
    generic: "This could not be completed right now. Try again.",
    signedOut: "Your session has ended. Sign in again.",
    lost: "Could not reach the server. Your action was not confirmed as recorded; what is shown is what the server holds now.",
    slow: "The server did not answer in time. Your action may not have been recorded; what is shown is what the server holds now.",
    answerUnreadable: "The server's answer could not be understood; what is shown is what the server holds now.",
  };

  const REASONS = [
    ["INELIGIBLE_TEAM", "The team is not eligible"],
    ["INCOMPLETE_ENTRY", "The entry is incomplete"],
    ["DUPLICATE_OR_MISTAKEN_ENTRY", "Duplicate or mistaken entry"],
    ["COMPETITION_CAPACITY", "The competition has no more room"],
    ["RULE_VIOLATION", "A rule was broken"],
    ["OTHER_ORGANIZER_DECISION", "Another organizer decision"],
  ];

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // What a server answer must look like. A list that is not exactly a list is a failed read; a row that is not exactly a row is left out, never repaired.
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const isText = (v) => typeof v === "string" && v.trim().length > 0;
  const isUuid = (v) => typeof v === "string" && UUID.test(v);
  const isInstant = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

  /** The rows of one list answer, each kept only when `keep` accepts it; null when the answer is not exactly a list under `key`. */
  function rowsOf(res, key, keep) {
    if (!res || res.status !== 200 || !isObject(res.json) || !Array.isArray(res.json[key])) return null;
    return res.json[key].filter(keep);
  }

  const readOffers = (res) => rowsOf(res, "offers", (o) => isObject(o)
    && (o.kind === "MEMBERSHIP" || o.kind === "LEADERSHIP") && isUuid(o.offerId) && (o.direction === "INCOMING" || o.direction === "OUTGOING") && isInstant(o.expiresAt)
    && isObject(o.team) && isUuid(o.team.lifetimeTeamId) && isText(o.team.publicCode) && isText(o.team.name)
    && (o.counterparty === null || (isObject(o.counterparty) && isUuid(o.counterparty.gamingMemberId) && isText(o.counterparty.displayName))));

  const readTeams = (res) => rowsOf(res, "teams", (t) => isObject(t)
    && isUuid(t.lifetimeTeamId) && isText(t.publicCode) && isText(t.name) && t.status === "ACTIVE" && isInstant(t.joinedAt)
    && (t.role === "CAPTAIN" || t.role === "SUB_CAPTAIN" || t.role === "MEMBER"));

  const readLedEntries = (res) => {
    const rows = rowsOf(res, "entries", (e) => isObject(e)
      && isUuid(e.competitionTeamId) && isUuid(e.competitionId) && isUuid(e.lifetimeTeamId) && isText(e.publicCode) && isText(e.name)
      && (e.status === "PENDING_ORGANIZER_APPROVAL" || e.status === "ACCEPTED") && isInstant(e.createdAt) && Array.isArray(e.claims));
    if (rows === null) return null;
    return rows.map((e) => Object.assign({}, e, {
      claims: e.claims.filter((c) => isObject(c) && isUuid(c.claimId) && isUuid(c.gamingMemberId) && isText(c.displayName) && (c.status === "PROPOSED" || c.status === "ACCEPTED") && isInstant(c.expiresAt)),
    }));
  };

  const readOwnClaims = (res) => rowsOf(res, "claims", (c) => isObject(c)
    && isUuid(c.claimId) && isUuid(c.competitionId) && (c.status === "PROPOSED" || c.status === "ACCEPTED") && isInstant(c.expiresAt)
    && isObject(c.team) && isUuid(c.team.lifetimeTeamId) && isText(c.team.publicCode) && isText(c.team.name));

  const readOrganizerEntries = (res) => rowsOf(res, "entries", (e) => isObject(e)
    && isUuid(e.competitionTeamId) && isText(e.publicCode) && isText(e.name) && (e.status === "PENDING_ORGANIZER_APPROVAL" || e.status === "ACCEPTED")
    && isInstant(e.createdAt) && isCount(e.acceptedPlayers) && isCount(e.proposedPlayers));

  const readCandidates = (res) => rowsOf(res, "members", (m) => isObject(m) && isUuid(m.gamingMemberId) && isText(m.displayName));

  /** What a join link's lookup answered: the team it names, that it names none (in the server's own words), or that it could not be read. */
  function readJoin(res) {
    if (res && res.status === 200 && isObject(res.json) && isObject(res.json.team) && isUuid(res.json.team.lifetimeTeamId) && isText(res.json.team.name)) {
      return { team: { lifetimeTeamId: res.json.team.lifetimeTeamId, name: res.json.team.name } };
    }
    if (res && res.status === 404) return { invalid: failureText(res) };
    return { unavailable: true };
  }

  /** An instant as the reader sees it: UTC, to the minute — computed from the value alone, never from this browser's clock. */
  function utc(value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? "" : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }

  /** What a refused or failed write says: the server's own bounded sentence when it gave one, otherwise one fixed sentence. */
  function failureText(res) {
    if (res && isObject(res.json) && isText(res.json.error)) return res.json.error;
    if (res && res.status === 401) return COPY.signedOut;
    return COPY.generic;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // Building elements. Text is always placed with textContent; nothing below parses markup.
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function put(parent, ...children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }
  function button(text, className, action, label) {
    const node = make("button", "ce-btn" + (className ? " " + className : ""), text);
    node.type = "button";
    if (action) node.setAttribute("data-action", action);
    if (label) node.setAttribute("aria-label", label);
    return node;
  }
  function pill(kind, text) {
    return make("span", "ce-pill ce-pill-" + kind, text);
  }
  function labelled(labelText, forId, control) {
    const wrap = make("div", "ce-field");
    const label = make("label", "", labelText);
    label.setAttribute("for", forId);
    return put(wrap, label, control);
  }

  const STYLE = [
    ".ce-region{border:1px solid var(--line,#2a2a2a);border-radius:14px;background:var(--surface-2,#1c1c1c);padding:16px 18px;margin:0 0 18px;color:var(--ink,#f5f1e8);font-size:14px;line-height:1.5}",
    ".ce-region [hidden]{display:none !important}",
    ".ce-region h2{font-size:16px;margin:0;padding:0;border:0;text-transform:none;letter-spacing:0;color:inherit}",
    ".ce-region h3{font-size:13px;margin:16px 0 6px;padding:0;border:0;color:var(--muted,#9b9689);text-transform:uppercase;letter-spacing:.06em}",
    ".ce-head{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}",
    ".ce-badge{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid var(--exp-purple,#7c3aed);color:#c4b5fd;margin-left:8px}",
    ".ce-note{font-size:13px;color:var(--muted,#9b9689);border-left:3px solid var(--exp-purple,#7c3aed);padding:4px 10px;margin:10px 0}",
    ".ce-msg{font-size:14px;color:var(--muted,#9b9689);margin:8px 0;overflow-wrap:anywhere}",
    ".ce-msg.error{color:var(--bad,#f87171)}.ce-msg.success{color:var(--good,#4ade80)}",
    ".ce-row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:10px 12px;margin:8px 0}",
    ".ce-main{min-width:0;flex:1 1 240px;overflow-wrap:anywhere}",
    ".ce-team{align-items:flex-start}.ce-row>.ce-panel{flex:1 0 100%}",
    ".ce-actions{display:flex;gap:8px;flex-wrap:wrap}",
    ".ce-btn{font:inherit;font-size:14px;font-weight:700;white-space:normal;overflow-wrap:anywhere;text-align:center;padding:9px 14px;border-radius:8px;border:1px solid var(--ink,#f5f1e8);background:var(--primary-fill,#f5f1e8);color:var(--primary-ink,#0a0a0a);cursor:pointer;min-height:40px}",
    ".ce-btn.secondary{background:transparent;color:var(--ink,#f5f1e8)}.ce-btn.danger{background:transparent;color:var(--bad,#f87171);border-color:var(--bad,#f87171)}",
    ".ce-btn:disabled{opacity:.5;cursor:not-allowed}",
    ".ce-pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:3px 9px;border-radius:999px;border:1px solid var(--line,#2a2a2a);color:var(--muted,#9b9689);margin-right:6px}",
    ".ce-pill-organizer{color:var(--gold,#d4af37);border-color:var(--gold,#d4af37)}.ce-pill-player{color:#c4b5fd;border-color:var(--exp-purple,#7c3aed)}.ce-pill-role{color:var(--ink,#f5f1e8)}",
    ".ce-line{margin:4px 0}.ce-line strong{font-weight:700}.ce-fine{font-size:12px;color:var(--muted,#9b9689)}",
    ".ce-place{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;border-top:1px solid var(--line,#2a2a2a);padding:8px 0}",
    ".ce-field{margin:10px 0}.ce-field label{display:block;color:var(--muted,#9b9689);font-weight:600;margin-bottom:6px}",
    ".ce-picker{margin:8px 0}.ce-choices{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:6px 12px;margin:0 0 8px;min-width:0}.ce-choices legend{padding:0 4px;color:var(--muted,#9b9689);font-weight:600}",
    ".ce-choice{display:flex;gap:10px;align-items:center;min-height:40px;overflow-wrap:anywhere;cursor:pointer}.ce-choice input{width:20px;height:20px;flex:0 0 auto}.ce-share{margin:8px 0}",
    ".ce-field input,.ce-field select,.ce-field textarea{font:inherit;font-size:16px;width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line,#2a2a2a);background:var(--bg-card,#161616);color:var(--ink,#f5f1e8);min-height:42px}",
    ".ce-panel{border:1px solid var(--bad,#f87171);border-radius:10px;padding:12px 14px;margin:10px 0;background:rgba(248,113,113,.06)}",
    "@media (max-width:640px){.ce-actions{width:100%}.ce-btn{width:100%}}",
  ].join("\n");

  function ensureStyle() {
    if (document.getElementById("competitions-entries-style")) return;
    const style = make("style", "", STYLE);
    style.id = "competitions-entries-style";
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // The live regions: one per mount, every one forgotten the moment the page says the session (or the view) changed.
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  let regions = [];
  /** Whether the person opened the member surface: the page re-renders on every authentication event (a token refresh, a returning tab), and what they opened stays open. A bare yes/no — nothing about anybody. */
  let keptOpen = false;
  /** The one-line notes a refusal of standing leaves where a surface was (they hold no private value); unmountAll removes them with everything else. */
  let notes = [];

  function dispose(region) {
    if (region.disposed) return;
    region.disposed = true;
    for (const controller of region.controllers) { try { controller.abort(); } catch (err) { /* already finished */ } }
    region.controllers.clear();
    if (region.root && region.root.parentNode) region.root.parentNode.removeChild(region.root);
    // What this member's session showed is forgotten with the region.
    region.root = null; region.model = null; region.options = null; region.status = null;
    regions = regions.filter((r) => r !== region);
  }

  /** Removes every surface this file built, in this very turn: pages call it at the start of every render and on every authentication event. */
  function unmountAll() {
    for (const region of regions.slice()) dispose(region);
    for (const note of notes) if (note.parentNode) note.parentNode.removeChild(note);
    notes = [];
  }

  function newRegion(kind, options) {
    const region = {
      kind, options, me: null, host: options.host, root: null, model: null, status: { text: "", kind: "" }, disposed: false, busy: false,
      controllers: new Set(), loadSerial: 0, shown: false, timeoutMs: typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      ui: { expanded: null, openTeams: new Set(), frozen: null, flow: null, picker: null },
    };
    for (const earlier of regions.slice()) if (earlier.host === options.host) dispose(earlier);
    regions.push(region);
    return region;
  }

  /** One uncached, abortable request through the page's authenticated fetch, bounded in time. */
  function request(region, method, path, body) {
    const options = region.options;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) region.controllers.add(controller);
    const init = { method, cache: "no-store" };
    if (controller) init.signal = controller.signal;
    if (body !== undefined) init.body = JSON.stringify(body);
    let timer;
    const limit = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { if (controller) { try { controller.abort(); } catch (err) { /* already finished */ } } reject(new Error("timeout")); }, region.timeoutMs);
    });
    return Promise.race([options.fetch(path, init), limit]).finally(() => { clearTimeout(timer); if (controller) region.controllers.delete(controller); });
  }

  /** True only while the region is alive AND the signed-in member is still the member it was built for; otherwise the region is gone and the caller does nothing more. */
  async function stillSame(region) {
    if (region.disposed) return false;
    const read = region.options.memberId;
    let now = null;
    try { now = await read(); } catch (err) { now = null; }
    if (region.disposed) return false;
    if (!same(now, region.me)) { dispose(region); return false; }
    return true;
  }

  /** While a request is out nothing can start another; a control that was already disabled stays disabled when the request ends. */
  function setBusy(region, busy) {
    if (!region.root) return;
    for (const control of region.root.querySelectorAll("button, input, select, textarea")) {
      if (busy) { if (!control.disabled) { control.setAttribute("data-ce-busy", "1"); control.disabled = true; } }
      else if (control.getAttribute("data-ce-busy") === "1") { control.removeAttribute("data-ce-busy"); control.disabled = false; }
    }
    if (busy) region.root.setAttribute("aria-busy", "true"); else region.root.removeAttribute("aria-busy");
  }

  function setStatus(region, text, kind) {
    if (region.disposed) return;
    region.status = { text, kind: kind || "" };
    const line = region.root && region.root.querySelector(".ce-status");
    if (line) { line.className = "ce-msg ce-status" + (kind ? " " + kind : ""); line.textContent = text; }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // The shared mechanics of an action: serialize, check the member, send, say what the server said, read the server again.
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  async function act(region, working, send, onResult) {
    if (region.disposed || region.busy) return;
    region.busy = true;
    region.ui.picker = null; // a list of players read before this action is not offered after it
    const hadFocus = !!(region.root && document.activeElement && region.root.contains(document.activeElement));
    setBusy(region, true);
    setStatus(region, working, "");
    try {
      if (!(await stillSame(region))) return;
      let res = null;
      let lost = null;
      try { res = await send(); } catch (err) { lost = err; }
      if (region.disposed) return;
      let message;
      let kind = "error";
      if (lost) message = lost && lost.message === "timeout" ? COPY.slow : COPY.lost;
      else if (res.status >= 200 && res.status < 300) {
        const said = onResult(res);
        message = said || COPY.answerUnreadable;
        kind = said ? "success" : "error";
      } else message = failureText(res);
      region.status = { text: message, kind };
      await reload(region);
      // The control that was used has been replaced with the rebuilt surface: focus goes to what the server said, so a keyboard or screen-reader user is not left on nothing.
      if (hadFocus && !region.disposed && region.root) {
        const line = region.root.querySelector(".ce-status");
        if (line) { line.tabIndex = -1; line.focus(); }
      }
    } finally {
      if (!region.disposed) { region.busy = false; setBusy(region, false); }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // The member surface
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  const roleWord = { CAPTAIN: "Captain", SUB_CAPTAIN: "Sub-captain", MEMBER: "Member" };
  const isLeader = (team) => team.role === "CAPTAIN" || team.role === "SUB_CAPTAIN";

  async function readAll(region) {
    const competition = region.options.competition;
    const get = (path) => request(region, "GET", path).catch(() => null);
    if (region.kind === "organizer") {
      const entries = await get(`${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries`);
      return { organizer: entries };
    }
    const code = region.options.joinCode;
    const [offers, teams, entries, claims, join] = await Promise.all([get(`${API}/lifetime-offers`), get(`${API}/lifetime-teams`), get(`${API}/lifetime-entries`), get(`${API}/lifetime-roster-claims`),
      code ? get(`${API}/lifetime-teams/by-code/${encodeURIComponent(code)}`) : null]);
    return { offers, teams, entries, claims, join };
  }

  /**
   * Reads what the surface needs and — if this is still the latest read, for the same member — builds the surface from it. The FIRST read decides whether a surface
   * exists at all: nothing is shown for a read the server refused or could not answer, nor for an organizer view of a competition that offers nothing to switch on. A LATER
   * read that fails keeps what is on screen and says so — except a refusal of standing (404), which removes the surface and what it held in this very turn.
   */
  async function reload(region) {
    const mine = ++region.loadSerial;
    const raw = await readAll(region);
    if (region.disposed || mine !== region.loadSerial) return false;
    if (!(await stillSame(region))) return false;
    if (mine !== region.loadSerial) return false;
    const first = !region.shown;
    let model;
    if (region.kind === "organizer") {
      const entries = readOrganizerEntries(raw.organizer);
      if (entries === null) return unreadable(region, first, !!raw.organizer && raw.organizer.status === 404);
      const competition = region.options.competition;
      if (first && entries.length === 0 && (!ORGANIZER_STATES.has(competition.state) || region.options.v1InUse === true)) { dispose(region); return false; }
      model = { entries };
    } else {
      model = { offers: readOffers(raw.offers), teams: readTeams(raw.teams), entries: readLedEntries(raw.entries), claims: readOwnClaims(raw.claims),
        join: region.options.joinCode ? readJoin(raw.join) : null };
      if (model.offers === null && model.teams === null && model.entries === null && model.claims === null) return unreadable(region, first, false);
    }
    region.model = model;
    region.shown = true;
    render(region);
    return true;
  }

  function unreadable(region, first, denied) {
    if (first) { dispose(region); return false; }
    if (denied) {
      const host = region.options.host;
      dispose(region);
      const note = make("p", "ce-msg ce-denied", "You do not currently organize this competition's team entries.");
      host.appendChild(note);
      notes.push(note);
      return false;
    }
    setStatus(region, "Could not refresh. What is shown may be out of date.", "error");
    return false;
  }

  function render(region) {
    const built = region.kind === "organizer" ? buildOrganizer(region) : buildMember(region);
    if (region.root && region.root.parentNode) region.root.parentNode.replaceChild(built, region.root);
    else region.options.host.appendChild(built);
    region.root = built;
    if (region.busy) setBusy(region, true);
  }

  function regionShell(region, id, title, badge) {
    ensureStyle();
    const root = make("section", "ce-region");
    root.id = id;
    root.setAttribute("role", "region");
    root.setAttribute("aria-labelledby", id + "-heading");
    const head = make("div", "ce-head");
    const heading = make("h2", "", title);
    heading.id = id + "-heading";
    if (badge) put(heading, make("span", "ce-badge", badge));
    put(head, heading);
    return { root, head };
  }

  function statusLine(region) {
    const line = make("p", "ce-msg ce-status" + (region.status && region.status.kind ? " " + region.status.kind : ""), region.status ? region.status.text : "");
    line.setAttribute("aria-live", "polite");
    return line;
  }

  function buildMember(region) {
    const model = region.model;
    const competition = region.options.competition;
    const { root, head } = regionShell(region, "team-entries", "Team entries", "Invite-only pilot");
    const active = model.join !== null || (model.offers && model.offers.some((o) => o.kind === "MEMBERSHIP")) || (model.teams && model.teams.length > 0)
      || (model.entries && model.entries.length > 0) || (model.claims && model.claims.length > 0);
    if (region.ui.expanded === null) region.ui.expanded = keptOpen || !!active || !!region.status.text;
    const toggle = button(region.ui.expanded ? "Hide" : "Show", "secondary", "toggle");
    toggle.id = "team-entries-toggle";
    toggle.setAttribute("aria-expanded", region.ui.expanded ? "true" : "false");
    toggle.setAttribute("aria-controls", "team-entries-body");
    const refresh = button("Refresh", "secondary", "refresh");
    refresh.id = "team-entries-refresh";
    put(head, put(make("div", "ce-actions"), refresh, toggle));
    put(root, head);

    const body = make("div");
    body.id = "team-entries-body";
    body.hidden = !region.ui.expanded;
    if (model.join !== null) put(body, buildJoin(region, model));
    put(body, make("p", "ce-note", COPY.distinct));
    put(body, buildInvitations(region, model), buildTeams(region, model, competition));
    if (competition) put(body, buildOwnProposals(region, model, competition));
    else if (model.claims && model.claims.length > 0) {
      put(body, make("p", "ce-msg", model.claims.length === 1 ? "A team proposed you for a roster. Open the competition it is for to answer." : "Teams proposed you for " + model.claims.length + " rosters. Open the competitions they are for to answer."));
    }
    put(body, statusLine(region));
    put(root, body);

    toggle.addEventListener("click", () => {
      region.ui.expanded = !region.ui.expanded;
      keptOpen = region.ui.expanded;
      body.hidden = !region.ui.expanded;
      toggle.textContent = region.ui.expanded ? "Hide" : "Show";
      toggle.setAttribute("aria-expanded", region.ui.expanded ? "true" : "false");
    });
    refresh.addEventListener("click", () => { act(region, "Refreshing…", () => Promise.resolve({ status: 200, json: {} }), () => "Up to date as the server holds it."); });
    return root;
  }

  // --- a team's join link ----------------------------------------------------------------------------------------------------------------------
  // Opening a link only shows which team it names. Joining is the person's own request, sent when they press the button, and a captain or sub-captain of the team decides it.

  function buildJoin(region, model) {
    const card = make("div");
    card.id = "join-team";
    put(card, make("h3", "", "Team link"));
    const row = make("div", "ce-row ce-join");
    const main = make("div", "ce-main");
    const actions = make("div", "ce-actions");
    const join = model.join;
    if (join.invalid) put(main, make("p", "ce-line ce-join-state", join.invalid));
    else if (join.unavailable) put(main, make("p", "ce-line ce-join-state", COPY.unavailable));
    else {
      const team = join.team;
      put(main, put(make("p", "ce-line"), make("strong", "ce-join-name", team.name)));
      const onIt = (model.teams || []).some((t) => same(t.lifetimeTeamId, team.lifetimeTeamId));
      const mine = (model.offers || []).filter((o) => o.kind === "MEMBERSHIP" && same(o.team.lifetimeTeamId, team.lifetimeTeamId));
      if (onIt) put(main, make("p", "ce-line ce-join-state", "You are on this team."));
      else if (mine.some((o) => o.direction === "OUTGOING" && o.counterparty === null)) put(main, make("p", "ce-line ce-join-state", "You have asked to join. A captain or sub-captain of the team answers."));
      else if (mine.some((o) => o.direction === "INCOMING")) put(main, make("p", "ce-line ce-join-state", "This team has invited you. Answer the invitation below."));
      else {
        put(main, make("p", "ce-line ce-fine ce-join-state", "You are not on this team, and opening this link has not changed that. A captain or sub-captain decides on a request to join."));
        const ask = button("Ask to join", "", "ask-to-join", "Ask to join " + team.name);
        ask.addEventListener("click", () => askToJoin(region, team));
        put(actions, ask);
      }
    }
    if (typeof region.options.onJoinClose === "function") {
      const close = button("Close the link", "secondary", "close-join");
      close.addEventListener("click", () => region.options.onJoinClose());
      put(actions, close);
    }
    return put(card, put(row, main, actions));
  }

  function askToJoin(region, team) {
    return act(region, "Sending your request…",
      () => request(region, "POST", `${API}/lifetime-teams/${encodeURIComponent(team.lifetimeTeamId)}/memberships`, { gamingMemberId: region.me }),
      (res) => (isObject(res.json) && isObject(res.json.membership) && res.json.membership.initiatedBySide === "PERSON" ? "Your request was sent. A captain or sub-captain of the team answers it." : null));
  }

  // --- invitations and requests ---------------------------------------------------------------------------------------------------------------

  function buildInvitations(region, model) {
    const card = make("div");
    card.id = "team-invitations";
    put(card, make("h3", "", "Team invitations and requests"));
    if (model.offers === null) return put(card, make("p", "ce-msg", COPY.unavailable));
    const offers = model.offers.filter((o) => o.kind === "MEMBERSHIP");
    if (offers.length === 0) return put(card, make("p", "ce-msg", "No invitations or requests right now."));
    const ledTeams = new Set((model.teams || []).filter(isLeader).map((t) => t.lifetimeTeamId.toLowerCase()));
    for (const offer of offers) card.appendChild(buildOffer(region, offer, model.teams === null ? null : ledTeams.has(offer.team.lifetimeTeamId.toLowerCase())));
    return card;
  }

  function buildOffer(region, offer, iLeadTheTeam) {
    const row = make("div", "ce-row ce-offer");
    const main = make("div", "ce-main");
    const person = offer.counterparty ? offer.counterparty.displayName : null;
    let sentence;
    if (offer.direction === "OUTGOING") {
      sentence = person ? "You invited " + person + " to join " + offer.team.name + ". Waiting for their answer." : "You asked to join " + offer.team.name + ". Waiting for the team's answer.";
    } else if (iLeadTheTeam === true) {
      sentence = (person || "Someone") + " asked to join " + offer.team.name + ".";
    } else if (iLeadTheTeam === false) {
      sentence = (person || "A team leader") + " invited you to join " + offer.team.name + ".";
    } else {
      sentence = "A membership offer for " + offer.team.name + (person ? " (" + person + ")" : "") + " is waiting for your answer.";
    }
    put(main, make("p", "ce-line ce-offer-text", sentence), make("p", "ce-line ce-fine", "Valid until " + utc(offer.expiresAt) + "; the server decides whether it can still be answered."));
    put(row, main);
    const actions = make("div", "ce-actions");
    if (offer.direction === "INCOMING") {
      const accept = button(iLeadTheTeam === true ? "Accept request" : "Accept invitation", "", "accept-offer", "Accept the offer for " + offer.team.name);
      const decline = button("Decline", "secondary", "decline-offer", "Decline the offer for " + offer.team.name);
      accept.addEventListener("click", () => answerOffer(region, offer, "ACCEPT"));
      decline.addEventListener("click", () => answerOffer(region, offer, "DECLINE"));
      put(actions, accept, decline);
    } else {
      const withdraw = button("Withdraw", "secondary", "withdraw-offer", "Withdraw the offer for " + offer.team.name);
      withdraw.addEventListener("click", () => withdrawOffer(region, offer));
      put(actions, withdraw);
    }
    return put(row, actions);
  }

  function answerOffer(region, offer, decision) {
    return act(region, decision === "ACCEPT" ? "Accepting…" : "Declining…",
      () => request(region, "POST", `${API}/lifetime-memberships/${encodeURIComponent(offer.offerId)}/decision`, { decision }),
      (res) => (isObject(res.json) && isObject(res.json.membership) ? (decision === "ACCEPT" ? "Accepted. The membership is now what the server holds." : "Declined.") : null));
  }

  function withdrawOffer(region, offer) {
    return act(region, "Withdrawing…",
      () => request(region, "POST", `${API}/lifetime-offers/${encodeURIComponent(offer.offerId)}/withdraw`, { kind: "MEMBERSHIP" }),
      (res) => (isObject(res.json) && isObject(res.json.offer) ? "Withdrawn." : null));
  }

  // --- teams -----------------------------------------------------------------------------------------------------------------------------------

  function buildTeams(region, model, competition) {
    const card = make("div");
    card.id = "my-teams";
    put(card, make("h3", "", "Your teams"));
    if (model.teams === null) put(card, make("p", "ce-msg", COPY.unavailable));
    else if (model.teams.length === 0) put(card, make("p", "ce-msg", "You are not on a team yet. Create one below, or accept an invitation when you receive one."));
    else for (const team of model.teams) card.appendChild(buildTeam(region, model, team, competition));
    if (model.teams !== null) put(card, buildCreateTeam(region));
    return card;
  }

  function buildTeam(region, model, team, competition) {
    const block = make("div", "ce-row ce-team");
    block.setAttribute("data-team", team.publicCode);
    const main = make("div", "ce-main");
    const title = make("p", "ce-line");
    put(title, make("strong", "ce-team-name", team.name), document.createTextNode(" "), pill("role", roleWord[team.role]));
    put(main, title);
    const open = region.ui.openTeams.has(team.lifetimeTeamId);
    const details = make("div", "ce-team-details");
    details.hidden = !open;
    put(details, make("p", "ce-line ce-fine", "Team code: " + team.publicCode), make("p", "ce-line ce-fine", "On the team since " + utc(team.joinedAt)));
    if (team.role === "CAPTAIN" && typeof region.options.joinLink === "function") put(details, buildShare(region, team));
    put(main, details);
    // On an addressed competition the team's entry is the point of the page: it is never hidden behind the details.
    if (competition) put(main, buildEntryForTeam(region, model, team, competition));
    const toggle = button(open ? "Close" : "Open", "secondary", "open-team", (open ? "Close " : "Open ") + team.name);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.addEventListener("click", () => {
      const now = details.hidden;
      details.hidden = !now;
      if (now) region.ui.openTeams.add(team.lifetimeTeamId); else region.ui.openTeams.delete(team.lifetimeTeamId);
      toggle.textContent = now ? "Close" : "Open";
      toggle.setAttribute("aria-expanded", now ? "true" : "false");
      toggle.setAttribute("aria-label", (now ? "Close " : "Open ") + team.name);
    });
    put(block, main, put(make("div", "ce-actions"), toggle));
    return block;
  }

  /** The captain's link to their own team. Whoever opens it signed in sees the team's name and may ask to join; nothing else comes with it. */
  function buildShare(region, team) {
    const url = region.options.joinLink(team.publicCode);
    const wrap = make("div", "ce-share");
    const input = make("input");
    input.id = "ce-join-link-" + team.publicCode;
    input.type = "text";
    input.readOnly = true;
    input.value = url;
    put(wrap, labelled("Link to ask to join this team", input.id, input));
    put(wrap, make("p", "ce-line ce-fine", "Anyone signed in who has this link can see the team's name and ask to join; you or your sub-captain decide. The link keeps working while the team exists."));
    const copy = button("Copy the link", "secondary", "copy-join-link", "Copy the join link of " + team.name);
    copy.addEventListener("click", async () => {
      let copied = false;
      try { copied = typeof region.options.copy === "function" && (await region.options.copy(url)) === true; } catch (err) { copied = false; }
      if (region.disposed) return;
      if (!copied) { input.focus(); input.select(); }
      setStatus(region, copied ? "Link copied." : "Select the link above and copy it.", copied ? "success" : "");
    });
    return put(wrap, copy);
  }

  function buildCreateTeam(region) {
    const form = make("div", "ce-create");
    form.id = "create-team-form";
    const input = make("input");
    input.id = "create-team-name";
    input.type = "text";
    input.autocomplete = "off";
    input.setAttribute("maxlength", "120"); // a bound on the payload only: the server decides what a valid name is
    put(form, labelled("Team name", "create-team-name", input));
    const submit = button("Create team", "", "create-team");
    submit.id = "create-team-submit";
    put(form, submit);
    submit.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) { setStatus(region, "A team name is required.", "error"); return; }
      createTeam(region, name);
    });
    return form;
  }

  function createTeam(region, name) {
    return act(region, "Creating the team…",
      () => request(region, "POST", `${API}/lifetime-teams`, { name }),
      (res) => (isObject(res.json) && isObject(res.json.team) && isUuid(res.json.team.lifetimeTeamId) ? "Team created. You are its captain." : null));
  }

  // --- the addressed competition: a team's entry and its roster places ------------------------------------------------------------------------

  function buildEntryForTeam(region, model, team, competition) {
    const wrap = make("div", "ce-entry");
    put(wrap, make("h3", "", "In this competition"));
    if (!isLeader(team)) return put(wrap, make("p", "ce-msg", "Your captain or sub-captain enters the team in a competition."));
    if (model.entries === null) return put(wrap, make("p", "ce-msg", COPY.unavailable));
    const entry = model.entries.find((e) => same(e.competitionId, competition.competitionId) && same(e.lifetimeTeamId, team.lifetimeTeamId));
    if (!entry) {
      if (competition.registered === false) put(wrap, make("p", "ce-msg", "Register for this competition first (the registration card on this page); then you can enter your team."));
      const enter = button("Enter this competition with " + team.name, "", "enter", "Enter this competition with " + team.name);
      enter.addEventListener("click", () => enterCompetition(region, team, competition));
      return put(wrap, enter);
    }
    return put(wrap, buildEntry(region, entry, competition));
  }

  function enterCompetition(region, team, competition) {
    return act(region, "Entering…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries`, { lifetimeTeamId: team.lifetimeTeamId }),
      (res) => (isObject(res.json) && isObject(res.json.entry) ? "Entered. The organizer decides on the team's entry." : null));
  }

  function buildEntry(region, entry, competition) {
    const card = make("div", "ce-entry-card");
    card.setAttribute("data-entry", entry.publicCode);
    const decision = make("p", "ce-line ce-organizer-decision");
    put(decision, make("strong", "", "The organizer's decision on the team: "),
      pill("organizer", entry.status === "ACCEPTED" ? "Approved by the organizer" : "Waiting for the organizer"));
    put(card, decision);
    put(card, make("p", "ce-line ce-fine", "The organizer's approval is about the team only. It does not accept anyone's roster place, and it is not a payment."));

    put(card, make("p", "ce-line", "Roster places — each player answers for themselves:"));
    if (entry.claims.length === 0) put(card, make("p", "ce-msg ce-no-places", "No roster places have been proposed yet."));
    for (const claim of entry.claims) put(card, buildPlace(region, entry, claim, competition));
    put(card, buildPicker(region, entry, competition));

    const withdraw = button("Withdraw the entry", "danger", "withdraw-entry", "Withdraw the entry of " + entry.name);
    const panel = make("div", "ce-panel");
    panel.hidden = true;
    put(panel, make("p", "ce-line", "Withdrawing the entry releases every roster place on it. This cannot be undone here."));
    const yes = button("Yes, withdraw the entry", "danger", "confirm-withdraw-entry");
    const keep = button("Keep the entry", "secondary", "keep-entry");
    put(panel, put(make("div", "ce-actions"), yes, keep));
    withdraw.addEventListener("click", () => { withdraw.hidden = true; panel.hidden = false; keep.focus(); });
    keep.addEventListener("click", () => { panel.hidden = true; withdraw.hidden = false; withdraw.focus(); });
    yes.addEventListener("click", () => withdrawEntry(region, entry, competition));
    return put(card, withdraw, panel);
  }

  function withdrawEntry(region, entry, competition) {
    return act(region, "Withdrawing the entry…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries/${encodeURIComponent(entry.competitionTeamId)}/withdraw`),
      (res) => (isObject(res.json) && isObject(res.json.entry) ? "The entry was withdrawn." : null));
  }

  function buildPlace(region, entry, claim, competition) {
    const row = make("div", "ce-place");
    const main = make("div", "ce-main");
    put(main, make("span", "ce-person", claim.displayName), document.createTextNode(" "),
      pill("player", claim.status === "ACCEPTED" ? "Accepted by the player" : "Waiting for the player"));
    if (claim.status === "PROPOSED") put(main, make("span", "ce-fine", " Open until " + utc(claim.expiresAt)));
    put(row, main);
    const remove = button(claim.status === "ACCEPTED" ? "Remove from the roster" : "Withdraw the proposal", "secondary", "release-claim",
      (claim.status === "ACCEPTED" ? "Remove " : "Withdraw the proposal for ") + claim.displayName);
    remove.addEventListener("click", () => releaseClaim(region, claim, competition));
    return put(row, remove);
  }

  function releaseClaim(region, claim, competition) {
    return act(region, "Updating the roster…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-roster-claims/${encodeURIComponent(claim.claimId)}/release`),
      (res) => (isObject(res.json) && isObject(res.json.claim) ? "The roster place was released." : null));
  }

  // --- choosing players for the entry ----------------------------------------------------------------------------------------------------------
  // The leader chooses from their own team's members by display name; the server scopes that read to this entry and its current leader. Choosing sends nothing until "Propose"
  // is pressed, and proposing accepts nothing: each person answers for themselves.

  function buildPicker(region, entry, competition) {
    const wrap = make("div", "ce-picker");
    const picker = region.ui.picker;
    if (!picker || !same(picker.entryId, entry.competitionTeamId)) {
      const choose = button("Choose players to propose", "secondary", "choose-players", "Choose players to propose for " + entry.name);
      choose.addEventListener("click", () => openPicker(region, entry, competition));
      return put(wrap, choose);
    }
    const group = make("fieldset", "ce-choices");
    put(group, make("legend", "", "Players to propose"));
    if (picker.members.length === 0) put(group, make("p", "ce-msg ce-no-candidates", "Everyone on the team already has an open proposal or a place on this entry."));
    const choices = picker.members.map((member, index) => {
      const box = make("input");
      box.type = "checkbox";
      box.id = "ce-choice-" + index;
      const label = make("label", "ce-choice");
      label.setAttribute("for", box.id);
      put(label, box, make("span", "ce-person", member.displayName + (same(member.gamingMemberId, region.me) ? " (you)" : "")));
      put(group, label);
      return { box, member };
    });
    const actions = make("div", "ce-actions");
    if (choices.length > 0) {
      const propose = button("Propose the chosen players", "", "propose-players");
      propose.addEventListener("click", () => {
        const chosen = choices.filter((c) => c.box.checked).map((c) => c.member.gamingMemberId);
        if (chosen.length === 0) { setStatus(region, "Choose at least one player.", "error"); return; }
        proposePlayers(region, entry, competition, chosen);
      });
      put(actions, propose);
    }
    const cancel = button("Cancel", "secondary", "cancel-picker", "Close the list of players");
    cancel.addEventListener("click", () => {
      region.ui.picker = null;
      render(region);
      const again = region.root && region.root.querySelector('[data-action="choose-players"]');
      if (again) again.focus();
    });
    return put(wrap, group, put(actions, cancel));
  }

  function openPicker(region, entry, competition) {
    return act(region, "Reading your team…",
      () => request(region, "GET", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries/${encodeURIComponent(entry.competitionTeamId)}/roster-candidates`),
      (res) => {
        const members = readCandidates(res);
        if (members === null) return null;
        region.ui.picker = { entryId: entry.competitionTeamId, members };
        return "Choose who to propose. Each person accepts or declines for themselves.";
      });
  }

  function proposePlayers(region, entry, competition, ids) {
    return act(region, "Proposing…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries/${encodeURIComponent(entry.competitionTeamId)}/roster-claims`, { gamingMemberIds: ids }),
      (res) => (isObject(res.json) && Array.isArray(res.json.claims) ? "Proposed. Each person accepts or declines for themselves." : null));
  }

  // --- the member's own roster proposal -------------------------------------------------------------------------------------------------------

  function buildOwnProposals(region, model, competition) {
    const card = make("div");
    card.id = "my-roster-proposals";
    put(card, make("h3", "", "Your roster proposal"));
    if (model.claims === null) return put(card, make("p", "ce-msg", COPY.unavailable));
    const mine = model.claims.filter((c) => same(c.competitionId, competition.competitionId));
    if (mine.length === 0) return put(card, make("p", "ce-msg", "No team has proposed you for this competition's roster."));
    if (competition.registered === false) put(card, make("p", "ce-msg", "Register for this competition first (the registration card on this page); then you can answer."));
    for (const claim of mine) card.appendChild(buildOwnProposal(region, claim, competition));
    return card;
  }

  function buildOwnProposal(region, claim, competition) {
    const row = make("div", "ce-row ce-own-proposal");
    const main = make("div", "ce-main");
    put(main, make("p", "ce-line", claim.team.name + " proposed you for this competition's roster."));
    const state = make("p", "ce-line");
    put(state, make("strong", "", "Your answer: "), pill("player", claim.status === "ACCEPTED" ? "You accepted this place" : "Waiting for your answer"));
    put(main, state);
    put(main, make("p", "ce-line ce-fine",
      "This is your answer alone. The organizer's decision on the team does not accept this place for you, and no payment is part of it."
      + (claim.status === "PROPOSED" ? " Open until " + utc(claim.expiresAt) + "; the server decides whether it can still be answered." : "")));
    put(row, main);
    const actions = make("div", "ce-actions");
    if (claim.status === "PROPOSED") {
      const accept = button("Accept my roster place", "", "accept-claim", "Accept my roster place on " + claim.team.name);
      const decline = button("Decline", "secondary", "decline-claim", "Decline the roster proposal from " + claim.team.name);
      accept.addEventListener("click", () => answerClaim(region, claim, competition, "ACCEPT"));
      decline.addEventListener("click", () => answerClaim(region, claim, competition, "REJECT"));
      put(actions, accept, decline);
    } else {
      const withdraw = button("Withdraw my place", "secondary", "withdraw-claim", "Withdraw my roster place on " + claim.team.name);
      withdraw.addEventListener("click", () => releaseClaim(region, claim, competition));
      put(actions, withdraw);
    }
    return put(row, actions);
  }

  function answerClaim(region, claim, competition, decision) {
    return act(region, decision === "ACCEPT" ? "Accepting your place…" : "Declining…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-roster-claims/${encodeURIComponent(claim.claimId)}/decision`, { decision }),
      (res) => (isObject(res.json) && isObject(res.json.claim) ? (decision === "ACCEPT" ? "You accepted your roster place." : "You declined the proposal.") : null));
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // The organizer surface
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  const ORGANIZER_STATES = new Set(["DRAFT", "TEAM_REGISTRATION_OPEN"]);

  function buildOrganizer(region) {
    const model = region.model;
    const competition = region.options.competition;
    const { root, head } = regionShell(region, "entries-organizer", "Team entries", "Invite-only pilot");
    const refresh = button("Refresh", "secondary", "refresh");
    refresh.id = "entries-refresh";
    refresh.addEventListener("click", () => { act(region, "Refreshing…", () => Promise.resolve({ status: 200, json: {} }), () => "Up to date as the server holds it."); });
    put(head, put(make("div", "ce-actions"), refresh));
    put(root, head);
    put(root, make("p", "ce-note", "Teams that already exist enter this competition themselves; you decide on each one. Your approval is about the team only: it does not accept any player's roster place (each player accepts their own) and it is not a payment. No payment is requested or confirmed here."));

    // the flow
    const flow = make("div");
    flow.id = "entries-flow";
    put(flow, make("h3", "", "Team entries"));
    const on = region.ui.flow === "on" || (region.ui.flow !== "off" && model.entries.length > 0);
    put(flow, make("p", "ce-msg ce-flow-state", on ? "Team entries are switched on for this competition." : region.ui.flow === "off" ? "Team entries are switched off for this competition." : "No team has entered yet. Switching team entries on does nothing if they are already on."));
    const enable = button("Switch team entries on", "", "enable");
    const disable = button("Switch team entries off", "secondary", "disable");
    enable.addEventListener("click", () => switchFlow(region, competition, true));
    disable.addEventListener("click", () => switchFlow(region, competition, false));
    put(flow, put(make("div", "ce-actions"), enable, disable));
    put(root, flow);

    // the entries
    const list = make("div");
    list.id = "entries-list";
    put(list, make("h3", "", "Entries"));
    if (model.entries.length === 0) put(list, make("p", "ce-msg ce-no-entries", "There are no entries to decide on."));
    for (const entry of model.entries) list.appendChild(buildOrganizerEntry(region, entry, competition));
    put(root, list);

    // the freeze
    const freeze = make("div");
    freeze.id = "entries-freeze";
    put(freeze, make("h3", "", "Freeze registration"));
    if (region.ui.frozen) {
      const f = region.ui.frozen;
      put(freeze, make("p", "ce-msg success ce-frozen", "Registration is frozen" + (f.at ? " (" + utc(f.at) + ")" : "") + ". Recorded: "
        + f.entries + (f.entries === 1 ? " entry" : " entries") + " and " + f.players + " accepted " + (f.players === 1 ? "player" : "players") + "."));
    } else {
      put(freeze, make("p", "ce-msg", "After the registration deadline, freezing records the entries and the accepted roster places and expires every roster proposal still open. Every entry must be decided first."));
      const start = button("Freeze registration", "", "freeze");
      const panel = make("div", "ce-panel");
      panel.hidden = true;
      put(panel, make("p", "ce-line", "Freezing registration is permanent. No team can enter, withdraw or change its roster afterwards."));
      const yes = button("Yes, freeze registration", "danger", "confirm-freeze");
      const no = button("Not yet", "secondary", "keep-open");
      put(panel, put(make("div", "ce-actions"), yes, no));
      start.addEventListener("click", () => { start.hidden = true; panel.hidden = false; no.focus(); });
      no.addEventListener("click", () => { panel.hidden = true; start.hidden = false; start.focus(); });
      yes.addEventListener("click", () => freezeEntries(region, competition));
      put(freeze, start, panel);
    }
    put(root, freeze);
    put(root, statusLine(region));
    return root;
  }

  function buildOrganizerEntry(region, entry, competition) {
    const row = make("div", "ce-row ce-organizer-entry");
    row.setAttribute("data-entry", entry.publicCode);
    const main = make("div", "ce-main");
    const title = make("p", "ce-line");
    put(title, make("strong", "ce-entry-name", entry.name), document.createTextNode(" "), pill("organizer", entry.status === "ACCEPTED" ? "Approved by you" : "Waiting for your decision"));
    put(main, title);
    put(main, make("p", "ce-line ce-fine ce-counts", "Players who accepted their place: " + entry.acceptedPlayers + " · Roster proposals waiting for a player: " + entry.proposedPlayers));
    put(row, main);
    if (region.ui.frozen) return row;

    const actions = make("div", "ce-actions");
    const decisionPanel = make("div", "ce-panel");
    decisionPanel.hidden = true;
    const approve = entry.status === "PENDING_ORGANIZER_APPROVAL" ? button("Approve", "", "approve", "Approve the entry of " + entry.name) : null;
    const against = button(entry.status === "ACCEPTED" ? "Remove…" : "Reject…", "danger", "open-reject", (entry.status === "ACCEPTED" ? "Remove the entry of " : "Reject the entry of ") + entry.name);
    if (approve) { approve.addEventListener("click", () => sendDecision(region, competition, entry, "APPROVE")); put(actions, approve); }
    put(actions, against);
    put(row, actions);

    const verb = entry.status === "ACCEPTED" ? "REMOVE" : "REJECT";
    const select = make("select");
    select.id = "reason-" + entry.publicCode;
    put(select, Object.assign(make("option", "", "Choose a reason"), { value: "" }));
    for (const [code, label] of REASONS) put(select, Object.assign(make("option", "", label), { value: code }));
    const note = make("textarea");
    note.id = "note-" + entry.publicCode;
    note.setAttribute("maxlength", String(NOTE_MAX));
    note.rows = 2;
    const confirm = button(verb === "REMOVE" ? "Confirm removal" : "Confirm rejection", "danger", "confirm-decision");
    confirm.disabled = true;
    const keep = button("Keep deciding", "secondary", "keep-deciding");
    put(decisionPanel, make("p", "ce-line", verb === "REMOVE" ? "Removing an approved entry releases its roster places." : "Rejecting an entry releases its roster places."),
      labelled("Reason (required)", select.id, select), labelled("Note (optional, up to " + NOTE_MAX + " characters)", note.id, note), put(make("div", "ce-actions"), confirm, keep));
    select.addEventListener("change", () => { confirm.disabled = region.busy || select.value === ""; });
    against.addEventListener("click", () => { actions.hidden = true; decisionPanel.hidden = false; select.focus(); });
    keep.addEventListener("click", () => { decisionPanel.hidden = true; actions.hidden = false; against.focus(); });
    confirm.addEventListener("click", () => {
      const text = note.value.trim();
      sendDecision(region, competition, entry, verb, select.value, text === "" ? undefined : text);
    });
    put(row, decisionPanel);
    return row;
  }

  function switchFlow(region, competition, on) {
    return act(region, on ? "Switching team entries on…" : "Switching team entries off…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entry-flow/${on ? "enable" : "disable"}`),
      (res) => {
        const flow = isObject(res.json) ? res.json.flow : null;
        if (!isObject(flow)) return null;
        region.ui.flow = on ? "on" : "off";
        if (on) return flow.alreadyEnabled === true ? "Team entries were already switched on." : "Team entries are switched on. Teams can now enter.";
        return flow.alreadyDisabled === true ? "Team entries were already switched off." : "Team entries are switched off.";
      });
  }

  function sendDecision(region, competition, entry, decision, reasonCode, note) {
    const body = { decision };
    if (decision !== "APPROVE") { body.reasonCode = reasonCode; if (note !== undefined) body.note = note; }
    return act(region, "Sending your decision…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries/${encodeURIComponent(entry.competitionTeamId)}/decision`, body),
      (res) => {
        const said = isObject(res.json) ? res.json.entry : null;
        if (!isObject(said)) return null;
        if (decision === "APPROVE") return "Approved. This approves the team only; each player still accepts their own roster place.";
        return decision === "REMOVE" ? "The entry was removed." : "The entry was rejected.";
      });
  }

  function freezeEntries(region, competition) {
    return act(region, "Freezing registration…",
      () => request(region, "POST", `${API}/${encodeURIComponent(competition.competitionId)}/lifetime-entries/freeze`),
      (res) => {
        const frozen = isObject(res.json) ? res.json.freeze : null;
        if (!isObject(frozen) || !isCount(frozen.entryCount) || !isCount(frozen.claimCount) || !isInstant(frozen.frozenAt)) return null;
        region.ui.frozen = { at: frozen.frozenAt, entries: frozen.entryCount, players: frozen.claimCount };
        return frozen.alreadyFrozen === true ? "Registration was already frozen." : "Registration is frozen.";
      });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Builds the member surface into `options.host` once the server has answered. `options`: { host, fetch(path, init) → Promise<{status, json}>, memberId() → Promise<id|null>,
   * competition: null | { competitionId, name, registered }, joinCode?: a team code from the page's link | null, joinLink?(teamCode) → url, copy?(text) → Promise<boolean>,
   * onJoinClose?(), timeoutMs? }. Resolves to true when a surface was built.
   */
  async function mountMember(options) {
    if (!options || !options.host || typeof options.fetch !== "function" || typeof options.memberId !== "function") return false;
    const region = newRegion("member", options);
    let me = null;
    try { me = await options.memberId(); } catch (err) { me = null; }
    if (region.disposed) return false;
    if (!isUuid(me)) { dispose(region); return false; }
    region.me = me;
    return reload(region);
  }

  /**
   * Builds the organizer surface for ONE addressed competition once the server has confirmed the caller may read its entries. `options`: { host, fetch, memberId,
   * competition: { competitionId, name, state }, v1InUse: boolean, timeoutMs? }. A competition that is not open for entries, or that already runs the V1 team flow,
   * gets nothing — unless entries exist.
   */
  async function mountOrganizer(options) {
    if (!options || !options.host || typeof options.fetch !== "function" || typeof options.memberId !== "function" || !options.competition || !isUuid(options.competition.competitionId)) return false;
    const region = newRegion("organizer", options);
    let me = null;
    try { me = await options.memberId(); } catch (err) { me = null; }
    if (region.disposed) return false;
    if (!isUuid(me)) { dispose(region); return false; }
    region.me = me;
    return reload(region);
  }

  root.CompetitionsEntries = { mountMember: mountMember, mountOrganizer: mountOrganizer, unmountAll: unmountAll };
})(typeof window !== "undefined" ? window : globalThis);
