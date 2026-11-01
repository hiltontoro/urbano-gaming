(function () {
  "use strict";
  // Original photos selected from the two approved participant collages. Never
  // copy their bytes into public assets: these endpoints enforce consent,
  // withdrawal and the existing seven-day server retention policy.
  var expiresAt = Date.parse("2026-11-08T06:00:00Z");
  var photos = [
    ["c08fce8b-5ec0-4f89-b0c1-3f154cb61497", "7160"],
    ["c08fce8b-5ec0-4f89-b0c1-3f154cb61497", "1442"],
    ["f98d4938-0c1d-46bb-956e-eacf72a7ded5", "7211"],
    ["b0a160a7-d782-42b0-a442-a13fc11cb7de", "3446"],
    ["8f4eddef-e654-414c-b1b9-631432bd3622", "4162"],
    ["8f4eddef-e654-414c-b1b9-631432bd3622", "7121"]
  ];
  var groups = document.querySelectorAll("[data-halloween-memories]");
  function expired() { return Date.now() >= expiresAt; }
  function clear() {
    for (var i = 0; i < groups.length; i++) {
      var images = groups[i].querySelectorAll("img");
      for (var j = 0; j < images.length; j++) { images[j].removeAttribute("src"); images[j].remove(); }
      groups[i].hidden = true;
      var section = groups[i].closest("[data-memories-section]");
      if (section) section.hidden = true;
    }
  }
  if (expired()) { clear(); return; }
  for (var i = 0; i < groups.length; i++) {
    (function (group) {
      var preview = group.getAttribute("data-halloween-memories") === "preview";
      var selected = preview ? photos.slice(0, 3) : photos;
      selected.forEach(function (photo, index) {
        var image = document.createElement("img");
        image.alt = "";
        image.width = 300;
        image.height = 400;
        // The container stays hidden until load: lazy loading could otherwise
        // wait for visibility while visibility waits for the load event.
        image.loading = "eager";
        image.decoding = "async";
        image.addEventListener("load", function () {
          if (expired()) { clear(); return; }
          image.hidden = false;
          group.hidden = false;
          var section = group.closest("[data-memories-section]");
          if (section) section.hidden = false;
        });
        image.addEventListener("error", function () {
          image.remove();
          if (!group.querySelector("img:not([hidden])")) {
            group.hidden = true;
            var section = group.closest("[data-memories-section]");
            if (section) section.hidden = true;
          }
        });
        image.hidden = true;
        image.src = "/api/gaming/community-voting/rounds/" + photo[0] + "/photos/" + photo[1] + "?v=" + (preview ? "thumb" : "full");
        group.appendChild(image);
      });
    })(groups[i]);
  }
  // Additional display cleanup for tabs left open or restored after the deadline.
  // The server, not this local clock, remains authoritative for photo access.
  var timer = setInterval(function () { if (expired()) { clear(); clearInterval(timer); } }, 1000);
  document.addEventListener("visibilitychange", function () { if (expired()) clear(); });
  window.addEventListener("pageshow", function () { if (expired()) clear(); });
})();
