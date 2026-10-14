/*
 * Become a Host availability, exactly as the SERVER answers it (UG-CR-GATE-090 / UG-CR-GATE-091).
 *
 * Every page that must know whether host applications are open (the landing card and the application page) reads the answer
 * through this one function, so the strict reading of it exists in exactly one place and cannot drift between pages. The
 * browser never decides readiness: it only relays GET /api/gaming/host/availability, which reads the server's own gate.
 *
 * resolve() resolves to true ONLY for HTTP 200 whose JSON body is exactly { "available": true } (one key, strict boolean true).
 * Anything else resolves to false: a network error, a timeout (the request is aborted), a non-200 status, a body that is not
 * JSON, not an object, an array, with more or fewer keys, or any other value (including the string "true" or the number 1).
 * It never throws and never rejects, so a caller that waits on it can only ever see "open" or "not open".
 *
 * The request is a credential-free, uncached GET. Nothing from the response other than that one boolean is used.
 */
(function (root) {
  var AVAILABILITY_URL = "/api/gaming/host/availability";
  var TIMEOUT_MS = 4000;

  async function resolve() {
    var timer = null;
    try {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      if (controller) timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      var res = await fetch(AVAILABILITY_URL, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller ? controller.signal : undefined,
      });
      if (!res || res.status !== 200) return false;
      var body = await res.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
      var keys = Object.keys(body);
      return keys.length === 1 && keys[0] === "available" && body.available === true;
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  root.HostAvailability = Object.freeze({ resolve: resolve });
})(window);
