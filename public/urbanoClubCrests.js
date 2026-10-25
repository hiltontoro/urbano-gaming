/* URBANO club crests — the ONE place that knows which crest file belongs to which club and where each file came from.
 *
 * Every page that shows a team asks this module (UrbanoClubCrests.element(teamName)); no page names a crest file itself. To REPLACE a
 * crest, change `src` here (and the file under /assets/clubs). To REMOVE them all, set ENABLED to false, or delete this script and its
 * <script> tags: every page keeps working, because the team's NAME is always written in text next to where the crest would be and is the
 * accessible name; a crest is only ever an addition to it, never the way a team is identified.
 *
 * What these files are: the clubs' marks, FC Barcelona's copied from the club's own web site and Real Madrid's from a third-party image
 * site (provenance and the terms that site states are below). Club crests are trademarks of their clubs. They are shown here only to identify the two teams of the match. Nothing in URBANO implies a licence from, or any
 * sponsorship, partnership or affiliation with, either club.
 *
 * Only crests: no photograph of a player, no kit, no other club asset is used anywhere.
 */
(function (w) {
  "use strict";

  var ENABLED = true;

  /* names: the exact (normalised) team names this crest belongs to. A name that merely contains a club's word (for example a test fixture
     called "Barcelona 4f2a9c") is NOT that club. */
  var CRESTS = [
    {
      key: "fc-barcelona",
      names: ["fc barcelona", "barcelona"],
      src: "/assets/clubs/fc-barcelona.svg",
      provenance: {
        club: "FC Barcelona",
        from: "https://www.fcbarcelona.es/resources/v13.12.2-9251/i/svg-output/icn.svg",
        what: "symbol id=\"fc-barcelona\" of the club's own icon sprite (full-colour crest); the symbol's content is copied unchanged into a standalone SVG",
        sourceLastModified: "2026-10-09",
        sourceSha256: "41affce992f6ddc35c1792d17b28ec795c2dcea172e38850f5f214a79559b38c",
        fileSha256: "c7ff1e9fcb2b7f1f5c0e8832458075efef7a5b24308593da39b7ee21d1639858",
        retrievedAtUtc: "2026-10-25T05:43:48Z"
      }
    },
    {
      key: "real-madrid-cf",
      names: ["real madrid cf", "real madrid"],
      src: "/assets/clubs/real-madrid-cf.png",
      provenance: {
        club: "Real Madrid CF",
        from: "https://pngdownload.io/download/1260/?tmstv=1702371724",
        page: "https://pngdownload.io/png-image/real-madrid-logo-iconic-football-club-emblem-png-transparent-symbol-of-excellence/",
        what: "the full-colour crest (crown, circle, band and letters) as a transparent PNG, 1600x1900 RGBA, from a third-party image site that the Founder named, because the club's own sites offered no full-colour file with transparency (the only full-colour crest there sits on a white background); the file used is that PNG with its empty transparent margin cropped and reduced to 256 px high, nothing retouched",
        siteTerms: "the site labels the image 'Creative Commons 4.0 BY-NC' and asks for attribution by a link to its page; that label is the site's own and cannot grant rights over the club's mark, and its non-commercial condition does not fit the commercial setting of the restaurant",
        sourceLastModified: "not stated by the site",
        sourceSha256: "c253e59f64d3769500d50d1fee8194cf84d38438cf71cf5dfc403d27f1796a06",
        fileSha256: "942d1bd606cfbf208595e6dfcd8c712a75c8ee91c58d56fe939d38148e6d17f1",
        retrievedAtUtc: "2026-10-25T07:20:00Z"
      }
    }
  ];

  function normalize(name) {
    return String(name == null ? "" : name)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* The crest entry for a team name, or null (no crest known, or crests switched off). */
  function forTeam(teamName) {
    if (!ENABLED) return null;
    var wanted = normalize(teamName);
    if (!wanted) return null;
    for (var i = 0; i < CRESTS.length; i++) {
      if (CRESTS[i].names.indexOf(wanted) !== -1) return CRESTS[i];
    }
    return null;
  }

  /* A decorative <img> for the team, or null. It carries no alternative text of its own (the team's name is written beside it, as text),
     is hidden from assistive technology, and removes itself if its file cannot be loaded — leaving only the name, which is the fallback. */
  function element(teamName, doc) {
    var entry = forTeam(teamName);
    if (!entry) return null;
    var d = doc || w.document;
    var img = d.createElement("img");
    img.className = "club-crest";
    img.setAttribute("src", entry.src);
    img.setAttribute("alt", "");
    img.setAttribute("aria-hidden", "true");
    img.setAttribute("width", "24");
    img.setAttribute("height", "24");
    img.setAttribute("decoding", "async");
    img.setAttribute("data-crest", entry.key);
    img.addEventListener("error", function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    return img;
  }

  /* Puts the crest in front of every [data-club] element under `root` (the element's data-club is the team name). Safe to call again: an
     element is decorated once. An element whose team has no crest is left exactly as it is. */
  function decorate(root) {
    var scope = root || w.document;
    if (!scope || typeof scope.querySelectorAll !== "function") return 0;
    var nodes = scope.querySelectorAll("[data-club]");
    var added = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.getAttribute("data-crest-done") === "1") continue;
      node.setAttribute("data-crest-done", "1");
      var img = element(node.getAttribute("data-club"), node.ownerDocument);
      if (img) { node.insertBefore(img, node.firstChild); added++; }
    }
    return added;
  }

  w.UrbanoClubCrests = { forTeam: forTeam, element: element, decorate: decorate, normalize: normalize, all: function () { return CRESTS.slice(); }, enabled: function () { return ENABLED; } };
})(typeof window !== "undefined" ? window : this);
