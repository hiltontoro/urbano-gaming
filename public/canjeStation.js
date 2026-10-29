// The redemption station page (canje-the-pub.html). Everything it shows comes from the station's own server routes; the PIN is only ever
// typed into the field and sent once, and it is wiped from the field right away. Text from the server is always set with textContent.
(function () {
  "use strict";
  var SLUG = "clasico-the-pub-2026-10-25";
  var BASE = "/api/gaming/canje/" + SLUG;
  var HN_OFFSET_MS = 6 * 60 * 60 * 1000; // Honduras: UTC-6, no daylight saving
  var NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{1,39}$/u;
  var $ = function (id) { return document.getElementById(id); };
  var current = null; // the prize being confirmed
  var busy = false;

  function show(which) {
    ["login", "closed", "list", "confirm"].forEach(function (id) { $(id).hidden = id !== which; });
  }
  function say(id, text, kind) { var el = $(id); el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
  function hondurasText(iso) {
    var d = new Date(new Date(iso).getTime() - HN_OFFSET_MS);
    var p = function (n) { return String(n).padStart(2, "0"); };
    var h = d.getUTCHours();
    return p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + " " + (h % 12 === 0 ? 12 : h % 12) + ":" + p(d.getUTCMinutes()) + (h < 12 ? " a. m." : " p. m.");
  }
  async function api(path, options) {
    var res = await fetch(BASE + path, Object.assign({ credentials: "same-origin", cache: "no-store" }, options));
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json: json };
  }
  function forget() { $("prizes").textContent = ""; $("c-name").textContent = ""; $("c-code").textContent = ""; $("c-prize").textContent = ""; $("operator").value = ""; }
  function toLogin(message, kind) {
    current = null;
    forget(); // the names and codes do not stay in the page once the session is over
    show("login");
    $("pin").value = "";
    say("login-msg", message || "", kind);
  }
  function toClosed() { current = null; forget(); show("closed"); }

  function renderPrizes(data) {
    $("station-label").textContent = data.station.label;
    $("session-note").textContent = "La sesión termina a las " + hondurasText(data.station.sessionExpiresAt).replace(/^\d\d\/\d\d /, "") + " (hora de Honduras).";
    var box = $("prizes");
    box.textContent = "";
    if (data.prizes.length === 0) { var none = document.createElement("p"); none.className = "muted"; none.textContent = "No hay premios en este puesto."; box.appendChild(none); }
    data.prizes.forEach(function (prize) {
      var card = document.createElement("div"); card.className = "prize";
      var name = document.createElement("div"); name.className = "name"; name.textContent = prize.displayName;
      var code = document.createElement("div"); code.className = "code"; code.textContent = prize.code;
      var what = document.createElement("div"); what.textContent = prize.prizeLabel;
      var chip = document.createElement("span"); chip.className = "chip " + prize.status;
      chip.textContent = prize.status === "PENDING" ? "Pendiente" : prize.status === "REDEEMED" ? "Canjeado" + (prize.redeemedAt ? " · " + hondurasText(prize.redeemedAt) : "") : "No disponible · consulta con URBANO";
      card.appendChild(name); card.appendChild(code); card.appendChild(what); card.appendChild(chip);
      if (prize.status === "PENDING") {
        var row = document.createElement("div"); row.className = "row";
        var go = document.createElement("button"); go.type = "button"; go.className = "primary"; go.textContent = "Entregar este premio";
        go.addEventListener("click", function () { openConfirm(prize); });
        row.appendChild(go); card.appendChild(row);
      }
      box.appendChild(card);
    });
  }

  async function loadList(keepMessage) {
    if (!keepMessage) say("list-msg", "");
    var res;
    try { res = await api("/prizes"); } catch (e) { say("list-msg", "No se pudo leer la lista (sin conexión).", "error"); show("list"); return; }
    if (res.status === 200 && res.json) { renderPrizes(res.json); show("list"); return; }
    if (res.status === 410) { toClosed(); return; }
    if (res.status === 401 || res.status === 404) { toLogin(""); return; }
    say("list-msg", "No se pudo leer la lista. Intenta de nuevo.", "error"); show("list");
  }

  function openConfirm(prize) {
    current = prize;
    $("c-name").textContent = prize.displayName;
    $("c-code").textContent = prize.code;
    $("c-prize").textContent = prize.prizeLabel;
    $("operator").value = "";
    $("delivered").checked = false;
    say("confirm-msg", "");
    updateConfirm();
    show("confirm");
  }
  function validName() { return NAME_PATTERN.test($("operator").value.replace(/\s+/g, " ").trim()); }
  function updateConfirm() { $("btn-confirm").disabled = busy || !validName() || !$("delivered").checked; }

  $("login-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (busy) return;
    var pin = $("pin").value;
    $("pin").value = ""; // the PIN does not stay in the page
    busy = true; $("btn-login").disabled = true; say("login-msg", "Comprobando…");
    var res = null;
    try { res = await api("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: pin }) }); } catch (e) { res = null; }
    pin = null; busy = false; $("btn-login").disabled = false;
    if (!res) { say("login-msg", "Sin conexión. Intenta de nuevo.", "error"); return; }
    if (res.status === 200) { say("login-msg", ""); await loadList(); return; }
    if (res.status === 401) { say("login-msg", "El PIN no es correcto.", "error"); return; }
    if (res.status === 429) {
      var minutes = Math.max(1, Math.ceil(((res.json && res.json.retryAfterSeconds) || 60) / 60));
      say("login-msg", "Demasiados intentos. Espera " + minutes + " min y vuelve a intentar.", "error"); return;
    }
    if (res.status === 410) { toClosed(); return; }
    if (res.status === 409) { say("login-msg", "Este puesto todavía no está activado. Avisa a URBANO.", "error"); return; }
    say("login-msg", "No se pudo entrar. Intenta de nuevo.", "error");
  });

  $("btn-refresh").addEventListener("click", function () { loadList(); });
  $("btn-logout").addEventListener("click", async function () {
    try { await api("/session", { method: "DELETE" }); } catch (e) { /* the cookie also expires by itself */ }
    toLogin("Sesión cerrada.");
  });
  $("btn-cancel").addEventListener("click", function () { current = null; show("list"); });
  $("operator").addEventListener("input", updateConfirm);
  $("delivered").addEventListener("change", updateConfirm);

  $("btn-confirm").addEventListener("click", async function () {
    if (busy || !current || !validName() || !$("delivered").checked) return; // one request at a time: a second tap is not a second delivery
    busy = true; updateConfirm(); say("confirm-msg", "Registrando…");
    var res = null;
    try {
      res = await api("/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: current.code, operatorName: $("operator").value.replace(/\s+/g, " ").trim(), confirm: true }),
      });
    } catch (e) { res = null; }
    busy = false; updateConfirm();
    if (!res) { say("confirm-msg", "Sin conexión. No sabemos si se registró: actualiza la lista antes de intentar de nuevo.", "error"); return; }
    if (res.status === 200 && res.json) {
      var again = res.json.outcome === "ALREADY_REDEEMED";
      current = null;
      await loadList(true);
      say("list-msg", again ? "Este premio ya estaba canjeado. No se registró un segundo canje." : "Canje registrado.", again ? "warn" : "success");
      return;
    }
    if (res.status === 401) { toLogin("La sesión terminó. Entra de nuevo con el PIN.", "error"); return; }
    if (res.status === 410) { toClosed(); return; }
    if (res.status === 409) { current = null; await loadList(true); say("list-msg", "Este premio no se puede entregar desde aquí. Consulta con URBANO.", "error"); return; }
    if (res.status === 400) { say("confirm-msg", (res.json && res.json.error) || "Revisa tu nombre e intenta de nuevo.", "error"); return; }
    say("confirm-msg", "No se pudo registrar. Actualiza la lista antes de intentar de nuevo.", "error");
  });

  loadList();
})();
