/* URBANO Score — the EDITORIAL list behind "Próximos partidos" (the Home card and the preselection in the Score lineup).
 *
 * It is the PRESELECTION of about five matches for the whole month approved by the Founder on 2026-10-29 as a preselection, NOT as open matches
 * (see 06_ranking_cinco_mas_tres.md of the November 2026 proposal). It is written by hand from the official fixture pages of the clubs and
 * leagues, and it says nothing about participation: a match here is only a match that is coming. Whether people can take part is decided by the
 * server and read by /homeUpcoming.js from the public matches list, only for a match that has the SAME start instant and the SAME two teams.
 *
 * Every entry says where it was read and when it was last compared with that source:
 *   source      the name of the source(s), as a person could look them up.
 *   sourceUrl   the page that was read (a reference for whoever maintains this file; the card does not link to it).
 *   verifiedAt  "YYYY-MM-DD", the day the entry was last compared with that source.
 * An hour (kickoffAt) WITHOUT a source and a verifiedAt is not shown by the card (see /homeUpcoming.js): the match stays with its date and says
 * "Horario por confirmar". So no hour is ever displayed that nobody can trace.
 *
 * Each entry has ONE of two timings:
 *   kickoffAt  a UTC instant (the page shows it as Honduras time, UTC-6, no daylight saving): the hour is published by the competition.
 *   date       "YYYY-MM-DD", a Honduras calendar date with NO hour: the hour is not confirmed, and the card says "Horario por confirmar".
 *              Such an entry is never tied to a server match (there is no instant to compare) and stays in the list through that date. When the hour
 *              is confirmed, replace `date` with `kickoffAt` (and update source and verifiedAt): that is the only way the card can ever say anything
 *              about participation.
 * No participation window is written here and none is invented: the opening hour of a window is shown only when the server reports an approved one.
 * Dates and times can change: verifiedAt says when each entry was last compared with its source. Replacing this file (or later reading it from the
 * server) changes the cards and nothing else. A match that is cancelled and is still in this list is removed from it by hand.
 *
 * Motagua–Olimpia has a DATE and no hour on purpose. The Liga Nacional calendar (lnphn.com) lists three matches on 19 November (3:00, 5:15 and 7:30 p. m.,
 * Honduras time) with club crests and no team names, no channel is announced, and the calendar is "subject to change"; which of the three is this
 * match was inferred from the crests. That is not enough to print an hour (it was checked again on 2026-10-29 and still is not).
 */
(function (w) {
  "use strict";
  w.UrbanoUpcomingData = {
    matches: [
      {"id": "N26-26", "kickoffAt": "2026-11-07T20:00:00Z", "home": "Valencia", "away": "Real Madrid", "competition": "LaLiga",
        "source": "LaLiga (laliga.com) y Real Madrid CF (realmadrid.com), 21:00 hora de España", "sourceUrl": "https://www.laliga.com/en-GB/clubs/real-madrid/next-matches", "verifiedAt": "2026-10-29"},
      {"id": "N26-27", "kickoffAt": "2026-11-08T20:00:00Z", "home": "Atlético de Madrid", "away": "FC Barcelona", "competition": "LaLiga",
        "source": "FC Barcelona (fcbarcelona.es) y LaLiga (laliga.com), 21:00 hora de España", "sourceUrl": "https://www.fcbarcelona.es/es/futbol/primer-equip/calendari", "verifiedAt": "2026-10-29"},
      {"id": "N26-46", "date": "2026-11-19", "home": "Motagua", "away": "Olimpia", "competition": "Liga Nacional",
        "source": "Liga Nacional de Honduras (lnphn.com), fecha sin nombres de equipos ni canal", "sourceUrl": "https://www.lnphn.com/calendario/", "verifiedAt": "2026-10-29"},
      {"id": "N26-22", "kickoffAt": "2026-11-22T16:30:00Z", "home": "Liverpool", "away": "Manchester United", "competition": "Premier League",
        "source": "Premier League (premierleague.com), 16:30 GMT, aviso del 21-sep-2026", "sourceUrl": "https://www.premierleague.com/en/news/4725574/fixture-amendments-for-premier-league-matches-in-november", "verifiedAt": "2026-10-29"},
      {"id": "N26-24", "kickoffAt": "2026-11-29T16:30:00Z", "home": "Arsenal", "away": "Manchester City", "competition": "Premier League",
        "source": "Premier League (premierleague.com), 16:30 GMT, aviso del 21-sep-2026", "sourceUrl": "https://www.premierleague.com/en/news/4725574/fixture-amendments-for-premier-league-matches-in-november", "verifiedAt": "2026-10-29"}
    ]
  };
})(typeof window !== "undefined" ? window : this);
