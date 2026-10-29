// Administration of the redemption station (canje-admin.html): shows its state and lets an administrator set or change the PIN, or close the
// station. Whether the person may do it is decided by the server on every request (OPERATIONAL authority); nothing here grants anything.
// The PIN is only typed into the two fields and sent once, over the signed-in connection; it is wiped from the fields right away and is
// never shown, stored or put in an address.
(function () {
  "use strict";
  var SLUG = "clasico-the-pub-2026-10-25";
  var BASE = "/api/gaming/canje/" + SLUG;
  var HN_OFFSET_MS = 6 * 60 * 60 * 1000; // Honduras: UTC-6, no daylight saving
  var TOKEN_TIMEOUT_MS = 10000;
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;
  var closed = false;

  UrbanoAuth.attachSignInButton($("btn-signin"), $("auth-status"), { accountEntry: "login-only" });

  function say(id, text, kind) { var el = $(id); el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
  function hondurasText(iso) {
    if (!iso) return "—";
    var d = new Date(new Date(iso).getTime() - HN_OFFSET_MS);
    var p = function (n) { return String(n).padStart(2, "0"); };
    var h = d.getUTCHours();
    return p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear() + " " + (h % 12 === 0 ? 12 : h % 12) + ":" + p(d.getUTCMinutes()) + (h < 12 ? " a. m." : " p. m.") + " (Honduras)";
  }

  function accessToken() {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("sign-in did not answer")); }, TOKEN_TIMEOUT_MS);
      Promise.resolve().then(function () { return UrbanoAuth.getAccessToken(); }).then(
        function (token) { clearTimeout(timer); resolve(token); },
        function (error) { clearTimeout(timer); reject(error); }
      );
    });
  }
  async function authed(path, options) {
    var token = await accessToken();
    var headers = Object.assign({ "content-type": "application/json" }, (options && options.headers) || {});
    if (token) headers.authorization = "Bearer " + token;
    var res = await fetch(BASE + path, Object.assign({ cache: "no-store" }, options, { headers: headers }));
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json: json };
  }

  function leave(message) {
    $("admin").hidden = true;
    $("pin").value = ""; $("pin2").value = "";
    say("access-msg", message || "");
  }

  function render(status) {
    closed = status.revokedAt !== null || Date.now() >= new Date(status.expiresAt).getTime();
    $("s-label").textContent = status.label;
    $("s-pin").textContent = status.pinSet ? "definido" : "sin definir (nadie puede entrar todavía)";
    $("s-version").textContent = String(status.pinVersion);
    $("s-sessions").textContent = String(status.activeSessions);
    $("s-last").textContent = hondurasText(status.lastPinChangeAt);
    $("s-expires").textContent = hondurasText(status.expiresAt);
    $("s-state").textContent = status.revokedAt !== null ? "cerrado (" + hondurasText(status.revokedAt) + ")" : closed ? "vencido" : "abierto";
    $("admin").hidden = false;
    update();
  }

  async function load() {
    say("pin-msg", "");
    var state;
    try { state = await UrbanoAuth.getState(); } catch (e) { leave("No se pudo leer la sesión. Recarga la página."); return; }
    if (!state || state.status === "unauthenticated") { leave("Entra con tu cuenta de administración."); return; }
    if (state.status !== "authenticated" || !state.gamingMemberId) { leave("Esta cuenta no tiene acceso de administración."); return; }
    var res;
    try { res = await authed("/pin"); } catch (e) { leave("No se pudo comprobar el acceso. Intenta de nuevo."); return; }
    if (res.status === 200 && res.json) { say("access-msg", ""); render(res.json); return; }
    if (res.status === 401) { leave("Entra con tu cuenta de administración."); return; }
    if (res.status === 403) { leave("Esta cuenta no tiene acceso de administración."); return; }
    if (res.status === 404) { leave("No existe el puesto de canje."); return; }
    leave("No se pudo leer el estado del puesto.");
  }

  function update() {
    var a = $("pin").value, b = $("pin2").value;
    $("btn-save").disabled = busy || closed || a.length < 8 || b.length < 8;
    $("btn-close").disabled = busy || closed || !$("close-sure").checked;
  }

  $("pin").addEventListener("input", update);
  $("pin2").addEventListener("input", update);
  $("close-sure").addEventListener("change", update);
  $("btn-reload").addEventListener("click", load);

  $("pin-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (busy || closed) return;
    var pin = $("pin").value, confirmPin = $("pin2").value;
    $("pin").value = ""; $("pin2").value = ""; // the PIN does not stay in the page
    if (pin !== confirmPin) { say("pin-msg", "Los dos PIN no coinciden. Escríbelos de nuevo.", "error"); update(); return; }
    busy = true; update(); say("pin-msg", "Guardando…");
    var res = null;
    try { res = await authed("/pin", { method: "POST", body: JSON.stringify({ pin: pin, confirmPin: confirmPin }) }); } catch (e) { res = null; }
    pin = null; confirmPin = null; busy = false;
    if (!res) { say("pin-msg", "Sin conexión o sin sesión. No sabemos si se guardó: actualiza el estado antes de intentar de nuevo.", "error"); update(); return; }
    if (res.status === 200 && res.json) {
      await load();
      say("pin-msg", "PIN guardado (versión " + res.json.pinVersion + "). Sesiones cerradas: " + res.json.sessionsRevoked + ".", "success");
      return;
    }
    if (res.status === 400) { say("pin-msg", (res.json && res.json.error) || "Ese PIN no sirve. Elige otro.", "error"); update(); return; }
    if (res.status === 401 || res.status === 403) { leave("Tu sesión terminó o esta cuenta no tiene acceso."); return; }
    if (res.status === 410) { await load(); say("pin-msg", "El puesto está cerrado: ya no se puede cambiar el PIN.", "error"); return; }
    say("pin-msg", "No se pudo guardar. Actualiza el estado antes de intentar de nuevo.", "error"); update();
  });

  $("btn-close").addEventListener("click", async function () {
    if (busy || closed || !$("close-sure").checked) return;
    busy = true; update(); say("close-msg", "Cerrando…");
    var res = null;
    try { res = await authed("/revoke", { method: "POST", body: "{}" }); } catch (e) { res = null; }
    busy = false;
    $("close-sure").checked = false;
    if (!res) { say("close-msg", "Sin conexión o sin sesión. Actualiza el estado para saber si se cerró.", "error"); update(); return; }
    if (res.status === 200) { await load(); say("close-msg", "Puesto cerrado.", "success"); return; }
    if (res.status === 401 || res.status === 403) { leave("Tu sesión terminó o esta cuenta no tiene acceso."); return; }
    say("close-msg", "No se pudo cerrar. Actualiza el estado.", "error"); update();
  });

  UrbanoAuth.onAuthStateChange(function () { load(); });
  load();
})();
