/*
 * URBANO Gaming — the featured contest ("Destacado").
 *
 * The Home's featured card and the URBANO Voting page show the same two buttons for the contest the operator has chosen to show:
 * "Votar por tu disfraz favorito" and "Participar como concursante". This module is the ONLY place that decides whether they are links.
 *
 * It asks the server ONE question, once: has the operator listed a contest? (GET /api/gaming/community-voting/contests/featured; { featured: null }
 * means no.) The answer is checked strictly against the documented shape — { featured: { voteUrl, registerUrl, phase, registration?, categories } },
 * where voteUrl is "/community-voting-round.html?c=<id>" and registerUrl is the same page with "&participar=1" for the SAME id. Anything that is not
 * exactly that — an error status, a 404 (the endpoint is not deployed), a late or malformed body, a url that is not the contest page of this site,
 * extra parameters, two different ids, an unknown phase, a contest with no category — changes NOTHING: the two buttons stay what the markup wrote
 * (words in a dashed outline, not links), the sentence under them says that nothing is available yet, and there is no link at all. When the answer
 * is exactly right the two buttons become real links, the sentence says where registration and voting stand, and the categories are listed. What
 * the server sends is only ever drawn as text.
 *
 * It sends nothing (a plain GET without credentials), stores nothing, and never blocks the page: the markup is complete before this script runs.
 */
(function (w) {
  "use strict";
  var ENDPOINT = "/api/gaming/community-voting/contests/featured";
  var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var VOTE_URL = new RegExp("^/community-voting-round\\.html\\?c=(" + UUID + ")$", "i");
  var JOIN_URL = new RegExp("^/community-voting-round\\.html\\?c=(" + UUID + ")&participar=1$", "i");
  var PHASES = { NOT_OPEN: true, OPEN: true, CLOSED: true, RESULTS: true };
  var REGISTRATION = { NOT_SCHEDULED: true, NOT_OPEN: true, OPEN: true, CLOSED: true };

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function t(key) { return w.UrbanoI18n && typeof w.UrbanoI18n.t === "function" ? w.UrbanoI18n.t(key) : key; }
  function lang() { return w.UrbanoI18n && typeof w.UrbanoI18n.getLang === "function" && w.UrbanoI18n.getLang() === "en" ? "en" : "es"; }

  // exactly the documented answer, or null
  function validate(data) {
    var f = data && typeof data === "object" ? data.featured : null;
    if (!f || typeof f !== "object") return null;
    if (typeof f.voteUrl !== "string" || typeof f.registerUrl !== "string") return null;
    var vote = VOTE_URL.exec(f.voteUrl);
    var join = JOIN_URL.exec(f.registerUrl);
    if (!vote || !join || vote[1].toLowerCase() !== join[1].toLowerCase()) return null; // both buttons are about the same contest
    if (f.contestId !== undefined && (typeof f.contestId !== "string" || f.contestId.toLowerCase() !== vote[1].toLowerCase())) return null;
    if (typeof f.phase !== "string" || !own(PHASES, f.phase)) return null;
    if (!Array.isArray(f.categories) || f.categories.length === 0) return null; // a contest with nothing to vote on is not one to point at
    // where registration stands; an answer without it (or with an unknown word) simply says nothing about registration
    var reg = f.registration && typeof f.registration === "object" && typeof f.registration.phase === "string" && own(REGISTRATION, f.registration.phase) ? f.registration.phase : "NOT_SCHEDULED";
    var names = [];
    for (var i = 0; i < f.categories.length && names.length < 8; i++) {
      var n = f.categories[i] && f.categories[i].name;
      if (n && typeof n.es === "string" && typeof n.en === "string" && n.es.length > 0 && n.es.length <= 80 && n.en.length > 0 && n.en.length <= 80) names.push({ es: n.es, en: n.en });
    }
    return { vote: f.voteUrl, join: f.registerUrl, phase: f.phase, registration: reg, names: names };
  }

  // where each button goes (a validated answer's own two addresses)
  function destinations(validated) { return { vote: validated.vote, join: validated.join }; }

  // what the sentence under the buttons says: while voting has not opened, where registration stands (if the server says), then where voting stands
  function sentence(validated) {
    var parts = [];
    if (validated.phase === "NOT_OPEN" && validated.registration !== "NOT_SCHEDULED") parts.push(t("home.feat.reg." + validated.registration));
    parts.push(t("home.feat.status." + validated.phase));
    return parts.join(" ");
  }

  function bind(root) {
    if (!root) return null;
    var status = root.querySelector("[data-feat-status]");
    var cats = root.querySelector("[data-feat-cats]");
    var current = null;

    function paint() {
      if (!current) return;
      if (status) { status.removeAttribute("data-i18n"); status.textContent = sentence(current); }
      if (cats) {
        cats.textContent = "";
        for (var i = 0; i < current.names.length; i++) {
          var li = document.createElement("li");
          li.textContent = current.names[i][lang()];
          cats.appendChild(li);
        }
        cats.setAttribute("aria-label", t("home.feat.categories"));
        cats.hidden = current.names.length === 0;
      }
    }

    function activate() {
      var dest = destinations(current);
      ["vote", "join"].forEach(function (kind) {
        var el = root.querySelector('[data-feat="' + kind + '"]');
        if (!el || el.tagName === "A") return;
        var a = document.createElement("a");
        a.className = "xf-btn " + (kind === "vote" ? "is-primary" : "is-secondary");
        a.setAttribute("href", dest[kind]);
        a.setAttribute("data-feat", kind);
        if (el.getAttribute("data-i18n")) a.setAttribute("data-i18n", el.getAttribute("data-i18n")); // a change of language re-translates the link itself
        a.textContent = el.textContent;
        el.parentNode.replaceChild(a, el);
      });
    }

    if (w.UrbanoI18n && typeof w.UrbanoI18n.onChange === "function") w.UrbanoI18n.onChange(paint);
    if (typeof w.fetch !== "function") return { stop: function () {} };
    var controller = typeof w.AbortController === "function" ? new w.AbortController() : null;
    var timer = controller ? w.setTimeout(function () { controller.abort(); }, 8000) : null;
    w.fetch(ENDPOINT, { method: "GET", headers: { accept: "application/json" }, cache: "no-store", credentials: "omit", signal: controller ? controller.signal : undefined })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (data) { current = validate(data); if (current) { activate(); paint(); } })
      .catch(function () { /* the card stays informational */ })
      .then(function () { if (timer) w.clearTimeout(timer); });
    return { stop: function () { if (controller) controller.abort(); } };
  }

  w.UrbanoFeaturedContest = { ENDPOINT: ENDPOINT, validate: validate, destinations: destinations, bind: bind };
})(window);
