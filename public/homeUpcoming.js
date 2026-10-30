/* URBANO Score — "Próximos partidos": the list drawn on the Home card and, as the preselection, in the Score lineup.
 *
 * WHAT THE LIST SAYS, AND WHAT DECIDES IT.
 * The list of matches is EDITORIAL (/homeUpcomingData.js): a match that is coming, with its two teams and EITHER the start as an instant OR only
 * a Honduras date (the hour is not confirmed yet: "Horario por confirmar"). By itself it is information and nothing else: every match is shown as
 * "Preselección". The list never says that people can take part unless THE SERVER says so, and it reads the server once, from the public matches
 * list (GET /api/gaming/predictions/matches, no sign-in, nothing sent), or is handed that list by a page that has already read it:
 *
 *   state        when
 *   -----------  ---------------------------------------------------------------------------------------------------------------------
 *   final        the server has a finalized result for the match
 *   closed       the match has started (the server refuses a participation from the instant of kickoff)
 *   open         the server lists an ENABLED venue activation of an ACTIVE venue with an AVAILABLE prize offer, and the approved window (if the
 *                match has one) has opened — exactly the conditions under which URBANO Score accepts a participation
 *   scheduled    the server says the match has an APPROVED participation window that has not opened yet (the opening hour is shown, and the
 *                server refuses before it)
 *   next         anything else: the match is only announced (a preselection)
 *
 * A server match counts for an editorial entry only when the entry HAS an hour, the match is not cancelled, its start instant is EXACTLY the
 * entry's and both of its teams are the entry's, home first. So an entry without a confirmed hour can only be a preselection (there is no instant
 * to compare), a test, rehearsal or past match in the database cannot turn the announcement of another match into an opening, and a spelling the
 * list does not recognise can only leave the match announced. The chip of a match never says that it is NOT open: it says what the match is.
 *
 * AN HOUR IS SHOWN ONLY WITH ITS SOURCE. An entry's hour (kickoffAt) is honoured only when the entry also says where it was read (source) and the
 * day it was last compared with that source (verifiedAt, a real calendar date that is not after the match). An hour without both is not shown: the
 * entry stays in the list with its Honduras date and "Horario por confirmar", exactly like an entry that never had an hour.
 *
 * A CANCELLED MATCH IS NOT AN UPCOMING ONE. When the server's list carries a cancelled match that is this very fixture (the same two clubs, home
 * first, starting on the entry's Honduras day, at any hour) and no live match of that pairing on that day, the entry is left out of the list: it is
 * neither shown as an announcement nor as an opening. (The public list that production serves today leaves cancelled matches out altogether, so
 * this rule has nothing to read there until the list says so; it is written, and tested, for the day it does.)
 *
 * The one sentence under the list speaks about the SERVER'S list, not about the editorial rows, and only once that list has been read: "no match
 * is open" when none of its matches accepts participation, "some are open" when at least one does (whether or not it is one of the rows). While the
 * list is being read, or if it cannot be read, the sentence is not shown at all: the list never asserts something it does not know.
 *
 * No participation window is ever written or guessed here. The list promises no prize, sponsorship or tie with any club.
 * Times are shown as Honduras time (the instant minus six hours, no daylight saving), the same on every device.
 */
(function (w) {
  "use strict";

  var MATCHES_URL = "/api/gaming/predictions/matches";
  var HN_OFFSET_MS = 6 * 60 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MAX_ITEMS = 5;
  // A match with an hour stays in the list for three hours after it starts (as "Cerrado", or "Finalizado" if the server has its result), then
  // leaves it. A match with only a date stays through that Honduras date.
  var STAYS_AFTER_KICKOFF_MS = 3 * 60 * 60 * 1000;
  var REFRESH_MS = 60 * 1000;
  // an instant must carry its zone (Z or ±hh:mm): written without one it would be read in the zone of each device
  var ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

  var STATE_KEY = {
    next: "upcoming.state.next",
    scheduled: "upcoming.state.scheduled",
    open: "upcoming.state.open",
    closed: "upcoming.state.closed",
    final: "upcoming.state.final"
  };

  function normalize(name) {
    var crests = w.UrbanoClubCrests;
    if (crests && typeof crests.normalize === "function") return crests.normalize(name);
    return String(name == null ? "" : name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  /* The same club under another spelling: the same normalised name, or two names of one club in the crest registry (which lists the
     spellings it knows, whether or not that crest is shown). Never a name that merely CONTAINS another. */
  function sameClub(a, b) {
    var x = normalize(a), y = normalize(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var crests = w.UrbanoClubCrests;
    var all = crests && typeof crests.all === "function" ? crests.all() : [];
    for (var i = 0; i < all.length; i++) {
      var names = all[i].names || [];
      if (names.indexOf(x) !== -1 && names.indexOf(y) !== -1) return true;
    }
    return false;
  }

  function teamName(team) {
    return team && typeof team.name === "string" ? team.name : "";
  }

  /* 00:00 Honduras of a "YYYY-MM-DD" date, as an instant; NaN for anything that is not a real calendar date. */
  function dayStartMs(date) {
    var m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
    if (!m) return NaN;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var utc = Date.UTC(y, mo - 1, d);
    var check = new Date(utc);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return NaN;
    return utc + HN_OFFSET_MS;
  }

  /* An ISO instant WITH its zone, as milliseconds; NaN for anything else. The calendar is checked here (not left to Date.parse, which in some
     engines rolls "2026-02-30" over to March): an impossible day or hour makes the whole value invalid, the same on every device. */
  function instantMs(value) {
    var m = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
    if (!m) return NaN;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = m[6] == null ? 0 : Number(m[6]);
    if (h > 23 || mi > 59 || s > 59) return NaN;
    var utc = Date.UTC(y, mo - 1, d, h, mi, s);
    var check = new Date(utc);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return NaN;
    var ms = m[7] == null ? 0 : Number((m[7] + "00").slice(0, 3));
    var zone = m[8];
    var offsetMin = 0;
    if (zone !== "Z") {
      var zh = Number(zone.slice(1, 3)), zm = Number(zone.slice(4, 6));
      if (zh > 23 || zm > 59) return NaN;
      offsetMin = (zone.charAt(0) === "-" ? -1 : 1) * (zh * 60 + zm);
    }
    return utc + ms - offsetMin * 60 * 1000;
  }

  function filled(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  /* 00:00 Honduras of the Honduras calendar day that contains an instant. */
  function dayOf(ms) {
    return Math.floor((ms - HN_OFFSET_MS) / DAY_MS) * DAY_MS + HN_OFFSET_MS;
  }

  /* The hour of an entry may be shown only when the entry says where it was read and when it was last compared with that source: a name for the
     source and a verification date that is a real calendar day and not after the match. */
  function hourSourced(entry, startMs) {
    if (!filled(entry.source)) return false;
    var verified = dayStartMs(entry.verifiedAt);
    return !Number.isNaN(verified) && verified <= startMs;
  }

  /* How an editorial entry is placed in time, or null when it cannot be (the entry is then dropped, never guessed):
     { hasTime, start, leaves } — `start` is the kickoff, or 00:00 Honduras of the date when there is no hour; `leaves` is when it leaves the list.
     An entry that CLAIMS an hour (kickoffAt) with a value that is not a valid instant WITH its zone is dropped; it does not fall back to its date.
     An hour that is a valid instant but has no source or verification date (see hourSourced) is not honoured: the entry is placed on the Honduras
     day of that instant, without an hour (`unsourced` says so). */
  function timing(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.kickoffAt != null) {
      var k = instantMs(entry.kickoffAt);
      if (Number.isNaN(k)) return null;
      if (!hourSourced(entry, k)) {
        var d = dayOf(k);
        return { hasTime: false, start: d, leaves: d + DAY_MS, unsourced: true };
      }
      return { hasTime: true, start: k, leaves: k + STAYS_AFTER_KICKOFF_MS };
    }
    var s = dayStartMs(entry.date);
    return Number.isNaN(s) ? null : { hasTime: false, start: s, leaves: s + DAY_MS };
  }

  /* An entry that can be drawn: an id, two named teams and a placement in time. Anything else is dropped (never drawn as "undefined"). */
  function drawable(entry) {
    return !!entry && typeof entry === "object" && filled(entry.id) && filled(entry.home) && filled(entry.away) && timing(entry) !== null;
  }

  /* The server match that IS this editorial match, or null. Only an entry with an hour can have one. */
  function findServerMatch(entry, serverMatches) {
    var tm = timing(entry);
    if (!tm || !tm.hasTime || !Array.isArray(serverMatches)) return null;
    for (var i = 0; i < serverMatches.length; i++) {
      var m = serverMatches[i];
      // a cancelled match is not "the" match (the Score page skips it too): the announcement stays announced
      if (!m || m.cancelledAt || instantOf(m) !== tm.start) continue;
      if (sameClub(teamName(m.homeTeam), entry.home) && sameClub(teamName(m.awayTeam), entry.away)) return m;
    }
    return null;
  }

  /* A server match that is, beyond reasonable doubt, the same FIXTURE as an editorial entry even if it is not the strict match: it is not cancelled
     and it has the same two clubs (any start), or the same start with one of the two clubs, or (for an entry with only a date) it starts on that
     Honduras date with one of the two clubs. The Score page hides a preselection row for such a match: its own card is already in the lineup, and a
     row that says "preselection" next to it would contradict the card. Hiding an announcement can never claim anything. */
  function hasTwin(entry, serverMatches) {
    var tm = timing(entry);
    if (!tm || !Array.isArray(serverMatches)) return false;
    for (var i = 0; i < serverMatches.length; i++) {
      var m = serverMatches[i];
      if (!m || m.cancelledAt) continue;
      var home = sameClub(teamName(m.homeTeam), entry.home), away = sameClub(teamName(m.awayTeam), entry.away);
      if (home && away) return true;
      if (!home && !away) continue;
      var at = instantOf(m);
      if (Number.isNaN(at)) continue;
      if (tm.hasTime ? at === tm.start : at >= tm.start && at < tm.start + DAY_MS) return true;
    }
    return false;
  }

  /* The server says this very fixture is CANCELLED: a cancelled match with the same two clubs (home first) that starts on the entry's Honduras day
     (any hour: the hour may have moved before the cancellation), and no live match of that pairing on that day (then the fixture exists and the
     entry stays). Only the server's own words count: a list that cannot be read, or that has no such match, cancels nothing. */
  function isCancelled(entry, serverMatches) {
    var tm = timing(entry);
    if (!tm || !Array.isArray(serverMatches)) return false;
    var from = dayOf(tm.start), cancelled = false;
    for (var i = 0; i < serverMatches.length; i++) {
      var m = serverMatches[i];
      if (!m || typeof m !== "object") continue;
      var at = instantOf(m);
      if (Number.isNaN(at) || at < from || at >= from + DAY_MS) continue;
      if (!sameClub(teamName(m.homeTeam), entry.home) || !sameClub(teamName(m.awayTeam), entry.away)) continue;
      if (!m.cancelledAt) return false;
      cancelled = true;
    }
    return cancelled;
  }

  function instantOf(match) {
    return match && typeof match.kickoffAt === "string" ? Date.parse(match.kickoffAt) : NaN;
  }

  function windowOpensMs(match) {
    return match && match.participationOpensAt ? Date.parse(match.participationOpensAt) : NaN;
  }

  function acceptsParticipation(match) {
    var activations = Array.isArray(match.venueActivations) ? match.venueActivations : [];
    for (var i = 0; i < activations.length; i++) {
      var a = activations[i];
      if (a && a.enabled === true && a.venue && a.venue.active === true && a.offer && a.offer.available === true) return true;
    }
    return false;
  }

  /* { state, opensAt } for one editorial entry. `server` is the matching server match or null. Pure: the same inputs give the same answer. */
  function deriveState(entry, server, nowMs) {
    var tm = timing(entry);
    // without a confirmed hour there is nothing to compare with the server and no moment at which the match could have started
    if (!tm || !tm.hasTime) return { state: "next", opensAt: null };
    if (server) {
      if (server.finalized === true) return { state: "final", opensAt: null };
      if (nowMs >= instantOf(server)) return { state: "closed", opensAt: null };
      var opens = windowOpensMs(server);
      var hasWindow = !Number.isNaN(opens);
      if (acceptsParticipation(server) && (!hasWindow || nowMs >= opens)) return { state: "open", opensAt: null };
      if (hasWindow && nowMs < opens) return { state: "scheduled", opensAt: opens };
    }
    if (nowMs >= tm.start) return { state: "closed", opensAt: null };
    return { state: "next", opensAt: null };
  }

  /* Does the SERVER's list have a match that accepts a participation right now? Independent of the editorial rows. A cancelled, finalized or
     already started match does not count; a match whose approved window has not opened does not count either. */
  function serverHasOpen(serverMatches, nowMs) {
    if (!Array.isArray(serverMatches)) return false;
    for (var i = 0; i < serverMatches.length; i++) {
      var m = serverMatches[i];
      if (!m || typeof m !== "object" || m.cancelledAt || m.finalized === true) continue;
      var start = instantOf(m);
      if (Number.isNaN(start) || nowMs >= start) continue;
      var opens = windowOpensMs(m);
      if (!Number.isNaN(opens) && nowMs < opens) continue;
      if (acceptsParticipation(m)) return true;
    }
    return false;
  }

  /* The entries that belong in the list now: those that have not left it, in order of start, with their state. `only` (an array of states) keeps
     just those states: the Score lineup uses ["next"] because every other state is already a card of its own there. An entry the server says is
     cancelled (see isCancelled) is left out; with `hideTwins` so is an entry that has a twin in the server's list (see hasTwin). An entry that cannot
     be drawn (see drawable), and every repeat of an id, is dropped. */
  function selectAll(entries, serverMatches, nowMs, only, hideTwins) {
    var out = [];
    var seen = {};
    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      if (!drawable(entry) || Object.prototype.hasOwnProperty.call(seen, entry.id)) return;
      seen[entry.id] = true;
      var tm = timing(entry);
      if (nowMs >= tm.leaves) return;
      if (isCancelled(entry, serverMatches)) return;
      if (hideTwins && hasTwin(entry, serverMatches)) return;
      var derived = deriveState(entry, findServerMatch(entry, serverMatches), nowMs);
      if (Array.isArray(only) && only.indexOf(derived.state) === -1) return;
      // `traceable`: what the row shows (its date, and its hour if it has one) comes with where it was read and the day it was last compared
      var traceable = !tm.unsourced && filled(entry.source) && !Number.isNaN(dayStartMs(entry.verifiedAt));
      out.push({ entry: entry, start: tm.start, hasTime: tm.hasTime, state: derived.state, opensAt: derived.opensAt, traceable: traceable });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* The first `limit` of selectAll (MAX_ITEMS when none is given). */
  function select(entries, serverMatches, nowMs, limit, only, hideTwins) {
    return selectAll(entries, serverMatches, nowMs, only, hideTwins).slice(0, limit == null ? MAX_ITEMS : limit);
  }

  /* Honduras clock parts of an instant. */
  function hondurasParts(ms) {
    var d = new Date(ms - HN_OFFSET_MS);
    return { year: d.getUTCFullYear(), weekday: d.getUTCDay(), day: d.getUTCDate(), month: d.getUTCMonth(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }

  /* "YYYY-MM-DD" of the Honduras day that contains an instant. */
  function isoDay(ms) {
    var p = hondurasParts(ms);
    return String(p.year).padStart(4, "0") + "-" + String(p.month + 1).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
  }

  function clockText(parts, t) {
    var h = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
    return h + ":" + String(parts.minute).padStart(2, "0") + " " + t(parts.hour < 12 ? "upcoming.am" : "upcoming.pm");
  }

  function dateVars(parts, t) {
    var weekdays = String(t("upcoming.weekdays")).split("|");
    var months = String(t("upcoming.months")).split("|");
    return { weekday: weekdays[parts.weekday] || "", day: String(parts.day), month: months[parts.month] || "" };
  }

  /* "sáb 7 nov · 🇭🇳 2:00 p. m." for a match with an hour. */
  function whenText(ms, t) {
    var p = hondurasParts(ms);
    var v = dateVars(p, t);
    v.time = clockText(p, t);
    return t("upcoming.when", v);
  }

  /* "jue 19 nov · Horario por confirmar" for a match with only a date (`dayStart` is 00:00 Honduras of that date). */
  function whenDateText(dayStart, t) {
    return t("upcoming.whenTbc", dateVars(hondurasParts(dayStart), t));
  }

  /* "Participación desde las 12:30 p. m." — one o'clock takes the singular article ("desde la 1:15"). */
  function opensAtText(ms, t) {
    var p = hondurasParts(ms);
    return t(p.hour % 12 === 1 ? "upcoming.opensAtOne" : "upcoming.opensAt", { time: clockText(p, t) });
  }

  /* The key of the one sentence under the list, or null for no sentence. It follows the SERVER's list, and only once it has been read ("ok"). */
  function statusKey(items, serverState, serverMatches, nowMs) {
    if (serverState !== "ok" || !items.length) return null;
    return serverHasOpen(serverMatches, nowMs) ? "upcoming.status.open" : "upcoming.status.none";
  }

  function make(doc, tag, className, text) {
    var el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function teamNode(doc, name) {
    var span = make(doc, "span", "upcoming-team");
    span.setAttribute("data-club", name);
    span.appendChild(doc.createTextNode(name));
    return span;
  }

  /* Draws the list. Every word that comes from data is set as text, never as markup. */
  function render(host, items, t) {
    var doc = host.ownerDocument;
    host.textContent = "";
    if (!items.length) {
      host.appendChild(make(doc, "li", "upcoming-none", t("upcoming.none")));
      return;
    }
    items.forEach(function (item) {
      var li = make(doc, "li", "upcoming-item");
      li.setAttribute("data-state", item.state);
      li.setAttribute("data-match", item.entry.id);
      li.setAttribute("data-time", item.hasTime ? "set" : "tbc");
      var teams = make(doc, "div", "upcoming-teams");
      teams.appendChild(teamNode(doc, item.entry.home));
      // "vs." and the away team stay together when the pair has to wrap
      var away = make(doc, "span", "upcoming-away");
      away.appendChild(make(doc, "span", "upcoming-vs", t("upcoming.vs")));
      away.appendChild(teamNode(doc, item.entry.away));
      teams.appendChild(away);
      var meta = make(doc, "div", "upcoming-meta");
      meta.appendChild(make(doc, "span", "upcoming-comp", typeof item.entry.competition === "string" ? item.entry.competition : ""));
      var time = make(doc, "time", "upcoming-time", item.hasTime ? whenText(item.start, t) : whenDateText(item.start, t));
      time.setAttribute("datetime", item.hasTime ? item.entry.kickoffAt : isoDay(item.start));
      // where the hour (or the date) was read and when it was last compared: carried by the row, so what a person sees can be audited
      if (item.traceable) {
        li.setAttribute("data-source", item.entry.source);
        li.setAttribute("data-verified", item.entry.verifiedAt);
      }
      meta.appendChild(time);
      var chip = make(doc, "span", "upcoming-chip state-" + item.state, t(STATE_KEY[item.state]));
      li.appendChild(teams);
      li.appendChild(meta);
      li.appendChild(chip);
      if (item.state === "scheduled" && item.opensAt != null) {
        li.appendChild(make(doc, "span", "upcoming-opens", opensAtText(item.opensAt, t)));
      }
      host.appendChild(li);
    });
    // the crests are decoration drawn by the central module; a team without one is just its name
    if (w.UrbanoClubCrests && typeof w.UrbanoClubCrests.decorate === "function") w.UrbanoClubCrests.decorate(host);
  }

  /* Reads the public matches list once: the list, or null when it could not be read (any failure). */
  function readServer(fetchFn) {
    try {
      return Promise.resolve(fetchFn(MATCHES_URL, { cache: "no-store" })).then(function (res) {
        if (!res || res.status !== 200) return null;
        return res.json().then(function (body) { return body && Array.isArray(body.matches) ? body.matches : null; }, function () { return null; });
      }, function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* Starts the list. Options: host (the <ul>), statusHost (an element for the one sentence under the list), data, fetch, now, i18n, refreshMs,
     serverMatches (the public matches list, when the page has already read it: then nothing is requested), only and hideTwins (see selectAll),
     limit (a number, or a function that gives it at every drawing: a phone shows fewer rows), onPaint(items, total) (called after every drawing that
     changed something; `total` is how many entries belong in the list, whether or not `limit` lets them all be drawn). Draws at once from the
     editorial list (every match a preselection, no sentence), then once more with what the server says. Redrawing with nothing new leaves the page
     exactly as it is (no node is replaced, so a screen reader or a text selection is not disturbed every minute). */
  function init(options) {
    var opts = options || {};
    var host = opts.host;
    if (!host) return null;
    var now = opts.now || function () { return Date.now(); };
    var i18n = opts.i18n || w.UrbanoI18n;
    // without the language table there are no words to draw: the list is simply not started (it never adds a second failure to the page)
    if (!i18n || typeof i18n.t !== "function") return null;
    var t = function (key, vars) { return i18n.t(key, vars); };
    var entries = (opts.data || w.UrbanoUpcomingData || {}).matches;
    var handed = Array.isArray(opts.serverMatches);
    var fetchFn = opts.fetch || (typeof w.fetch === "function" ? w.fetch.bind(w) : null);
    var serverMatches = handed ? opts.serverMatches : [];
    var serverState = handed ? "ok" : fetchFn ? "pending" : "failed";
    var stopped = false;
    var signature = null;
    function paint(force) {
      if (stopped) return;
      var nowMs = now();
      var all = selectAll(entries, serverMatches, nowMs, opts.only, opts.hideTwins);
      var limit = typeof opts.limit === "function" ? opts.limit() : opts.limit;
      var items = all.slice(0, limit == null ? MAX_ITEMS : limit);
      var key = statusKey(items, serverState, serverMatches, nowMs);
      var sig = JSON.stringify([items.map(function (i) { return [i.entry.id, i.state, i.opensAt, i.hasTime]; }), all.length, key]);
      if (!force && sig === signature) return;
      signature = sig;
      render(host, items, t);
      if (opts.statusHost) {
        var text = key ? t(key) : "";
        if (opts.statusHost.textContent !== text) opts.statusHost.textContent = text;
        opts.statusHost.hidden = !key;
      }
      if (typeof opts.onPaint === "function") opts.onPaint(items, all.length);
    }
    paint(true);
    // a change of language redraws everything, even when the matches are the same
    var unsubscribe = typeof i18n.onChange === "function" ? i18n.onChange(function () { paint(true); }) : null;
    if (!handed && fetchFn) {
      readServer(fetchFn).then(function (matches) {
        if (stopped) return;
        serverState = matches ? "ok" : "failed";
        serverMatches = matches || [];
        paint();
      });
    }
    var timer = opts.refreshMs === 0 ? null : setInterval(paint, opts.refreshMs || REFRESH_MS);
    return {
      paint: function () { paint(true); },
      stop: function () {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (typeof unsubscribe === "function") unsubscribe();
        unsubscribe = null;
      }
    };
  }

  w.UrbanoHomeUpcoming = {
    init: init, select: select, selectAll: selectAll, deriveState: deriveState, findServerMatch: findServerMatch, hasTwin: hasTwin, isCancelled: isCancelled, serverHasOpen: serverHasOpen, sameClub: sameClub,
    timing: timing, whenText: whenText, whenDateText: whenDateText, MATCHES_URL: MATCHES_URL, MAX_ITEMS: MAX_ITEMS
  };
})(typeof window !== "undefined" ? window : this);
