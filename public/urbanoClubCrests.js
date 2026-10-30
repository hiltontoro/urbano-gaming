/* URBANO club crests — the ONE place that knows which crest file belongs to which club and where each file came from.
 *
 * Every page that shows a team asks this module (UrbanoClubCrests.element(teamName)); no page names a crest file itself. To REPLACE a
 * crest, change `src` here (and the file under /assets/clubs). To REMOVE them all, set ENABLED to false, or delete this script and its
 * <script> tags: every page keeps working, because the team's NAME is always written in text next to where the crest would be and is the
 * accessible name; a crest is only ever an addition to it, never the way a team is identified.
 *
 * What these files are: the clubs' marks. FC Barcelona's was copied from the club's own web site and Real Madrid's from a third-party image
 * site; the other eight come from UEFA (img.uefa.com) and Concacaf (media-sdp.concacaf.com) image servers. Provenance, hashes and the terms that
 * apply are in each entry below. Club crests are trademarks of their clubs. They are shown here only to identify the teams. Nothing in URBANO implies
 * a licence from, or any sponsorship, partnership or affiliation with, any club, league or competition.
 *
 * Only crests: no photograph of a player, no kit, no other club asset is used anywhere.
 *
 * STATUS OF EACH CREST (USE, NOT LICENCE — no status below means that a licence exists: no licence is on record for any of the ten).
 *   (no status)         already in use in production, the base of this prototype (FC Barcelona, Real Madrid). Not formally cleared either (see their notes).
 *   "founder-directed"  drawn because the Founder decided on 2026-10-29 that the crests of ALL TEN teams must be kept in the design of Home. The
 *                       decision is visual: it does not establish a licence, and the provenance below is kept so that each file can be replaced
 *                       or removed. Until the publication of that design is approved, these files exist only in the prototype.
 *   "preview-only"      NOT drawn unless the page that is drawing a preview sets window.URBANO_CRESTS_PREVIEW = true before this script runs; no
 *                       shipped page sets it, so in production the team is shown by its name alone. Nothing uses it today: it is the way to hold
 *                       back a crest again (change its status to "preview-only" and it disappears from every page at once).
 * To take back the eight "founder-directed" crests, set their status to "preview-only" (or ENABLED to false for all of them): the teams are then
 * named in text, which is always the accessible name.
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
    },
    {
      key: "manchester-city",
      status: "founder-directed",
      names: ["manchester city", "man city"],
      src: "/assets/clubs/manchester-city.png",
      provenance: {
        club: "Manchester City",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/52919.png",
        what: "club crest as served by UEFA (img.uefa.com), team 52919, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "9f900034303696b94274eb9995750d6c0b9dff7134e0b502f83a9a2ad6c18c14",
        fileSha256: "352f2ea6a20bb099e45192afe24cf27f8f057d307e8ae804ec0d7a99d3f73454",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "manchester-united",
      status: "founder-directed",
      names: ["manchester united", "man united"],
      src: "/assets/clubs/manchester-united.png",
      provenance: {
        club: "Manchester United",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/52682.png",
        what: "club crest as served by UEFA (img.uefa.com), team 52682, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "3effeadd6a62a047a7cd323e827a8b486f13e8ea2e0de9c9888d242c7d94ae2f",
        fileSha256: "44f1c5c3722984a0b10ece89f34b4fb5bf6a452bca5fcdb86f67555dc7af8707",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "arsenal",
      status: "founder-directed",
      names: ["arsenal"],
      src: "/assets/clubs/arsenal.png",
      provenance: {
        club: "Arsenal",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/52280.png",
        what: "club crest as served by UEFA (img.uefa.com), team 52280, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "850bad79785beb640c65f2c11113f39a00f256f51ab856fd65e99b803f3e6591",
        fileSha256: "66620767f6e36525e5dc6b4b5b13f6d80d18b84ed140151ec325a285ef23ad67",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "bayern-munchen",
      status: "founder-directed",
      names: ["bayern munchen", "bayern munich", "bayern"],
      src: "/assets/clubs/bayern-munchen.png",
      provenance: {
        club: "Bayern München",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/50037.png",
        what: "club crest as served by UEFA (img.uefa.com), team 50037, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "a408a6244509a793b82d1caf53f519c6fcced9c0a769c96a9d0e1d6cfd122bd0",
        fileSha256: "fdce9ce48b8e5fba5ede865ebde1df2519abc2142281fad5808c7e0aff4e2855",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "paris-saint-germain",
      status: "founder-directed",
      names: ["paris saint germain", "psg"],
      src: "/assets/clubs/paris-saint-germain.png",
      provenance: {
        club: "Paris Saint-Germain",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/52747.png",
        what: "club crest as served by UEFA (img.uefa.com), team 52747, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "2dfc738445fdce6ea2ec87ee9eb10222060898231916bd10a34b7bd66bf9051d",
        fileSha256: "68317ca842ec63e7a5aa43ef392ff1b7a9f6d0f85558a031ec44cc20d7a8940c",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "inter",
      status: "founder-directed",
      names: ["inter", "inter milan", "inter de milan"],
      src: "/assets/clubs/inter.png",
      provenance: {
        club: "Inter",
        from: "https://img.uefa.com/imgml/TP/teams/logos/140x140/50138.png",
        what: "club crest as served by UEFA (img.uefa.com), team 50138, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "a33b2f15f9ca40cb52ca8d9400b7ca62a3dd429c33eff2ac47f6302e3963836d",
        fileSha256: "164eafc271337d1263f0216baeefd6233cd8b7a6448829a9c52e53cf0cf3852b",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "olimpia",
      status: "founder-directed",
      names: ["olimpia", "cd olimpia"],
      src: "/assets/clubs/olimpia.png",
      provenance: {
        club: "Olimpia",
        from: "https://media-sdp.concacaf.com/clubLogos/b6dfe29337d7464aa49420eb14137461.webp",
        what: "club crest as served by Concacaf (media-sdp.concacaf.com), Central American Cup club logos, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "7bad072ce1567e242dabb0c8ed6e730bc004471915c1abd08e63505c7078adcd",
        fileSha256: "7060fabf018ffbecae10e17edd0f47577c1d1780ee89d042412275e8d26dc84d",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
      }
    },
    {
      key: "motagua",
      status: "founder-directed",
      names: ["motagua", "fc motagua"],
      src: "/assets/clubs/motagua.png",
      provenance: {
        club: "Motagua",
        from: "https://media-sdp.concacaf.com/clubLogos/81105d6963164c6d9304db308ae41d36.webp",
        what: "club crest as served by Concacaf (media-sdp.concacaf.com), Central American Cup club logos, converted to a 160 px square PNG with transparency (trimmed and centred); licence NOT established; drawn by decision of the Founder (2026-10-29)",
        sourceSha256: "a73a541183594f8b8176154e86ce697220d023bd0a943a23477e23f02eb4b2d3",
        fileSha256: "f4651591cb3fd290b0024333cc280c397b0c96f2a85caff10ccafafdbb30b1e5",
        retrievedAtUtc: "2026-10-29T03:00:00Z"
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
    var preview = w.URBANO_CRESTS_PREVIEW === true;
    for (var i = 0; i < CRESTS.length; i++) {
      if (CRESTS[i].names.indexOf(wanted) === -1) continue;
      // a crest that has not been cleared is only ever drawn by a page that says it is drawing a preview
      if (CRESTS[i].status === "preview-only" && !preview) return null;
      return CRESTS[i];
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
