import type { PlayerPosition } from "../types";

/**
 * Season squad lists of the two clubs of El Clásico (2026-10-25), exactly as the clubs' own pages publish them, read on 2026-10-24.
 *
 *  - It is a ROSTER, not a call-up, a line-up or a promise that anyone is available: no player is switched off for an injury or a rumour,
 *    and nobody is added from memory or from another season. Two independent lists were not obtainable (the third-party site refused the
 *    request and the league's page carried no player data), so each club's list rests on that club's own page alone.
 *  - Names are kept as published (abbreviations are not expanded); only stray spaces around a name were trimmed.
 *  - Squad number and position are the season's roster data, not the player's identity. A player's identity is the stable id the database
 *    gives it once (see reconcile.ts and the local loader); nothing here is an id.
 *  - Position is normalised from the club's own label: POR goalkeeper, DEF defender, MED midfielder, DEL forward. For Real Madrid the page
 *    lists Brahim under its midfield heading while its own profile label says Forward: the profile label is used (DEL). Thiago's label is
 *    published in Spanish ("Centrocampista"): MED.
 *  - Coaches and staff are not players and are not here.
 */
export interface RosterEntry {
  name: string;
  jerseyNumber: number;
  position: PlayerPosition;
}

export interface RosterTeamSnapshot {
  /** The name the team is shown under; also the exact name the loader looks for (never a fuzzy match). */
  teamName: string;
  /** Provenance of every entry of this team. */
  source: { label: string; url: string; consultedOn: string; consultedAtUtc: string };
  players: RosterEntry[];
}

export interface RosterSnapshot {
  id: string;
  teams: RosterTeamSnapshot[];
}

export const CLASICO_ROSTER_SNAPSHOT: RosterSnapshot = {
  id: "clasico-2026-10-25",
  teams: [
    {
      teamName: "FC Barcelona",
      source: { label: "fcbarcelona.es · Primer equipo · Jugadores", url: "https://www.fcbarcelona.es/es/futbol/primer-equipo/jugadores", consultedOn: "2026-10-24", consultedAtUtc: "2026-10-25T05:13:40Z" },
      players: [
        { name: "Joan García", jerseyNumber: 1, position: "POR" },
        { name: "Wojciech Szczesny", jerseyNumber: 13, position: "POR" },
        { name: "Dominik Livakovic", jerseyNumber: 25, position: "POR" },
        { name: "João Cancelo", jerseyNumber: 2, position: "DEF" },
        { name: "Alejandro Balde", jerseyNumber: 3, position: "DEF" },
        { name: "Pau Cubarsí", jerseyNumber: 5, position: "DEF" },
        { name: "Xavi Espart", jerseyNumber: 12, position: "DEF" },
        { name: "Andreas Christensen", jerseyNumber: 15, position: "DEF" },
        { name: "Gerard Martín", jerseyNumber: 18, position: "DEF" },
        { name: "Jules Koundé", jerseyNumber: 23, position: "DEF" },
        { name: "Eric García", jerseyNumber: 24, position: "DEF" },
        { name: "Brian Fariñas", jerseyNumber: 4, position: "MED" },
        { name: "Gavi", jerseyNumber: 6, position: "MED" },
        { name: "Fermín López", jerseyNumber: 7, position: "MED" },
        { name: "Pedri", jerseyNumber: 8, position: "MED" },
        { name: "Rodri", jerseyNumber: 16, position: "MED" },
        { name: "Dani Olmo", jerseyNumber: 20, position: "MED" },
        { name: "Frenkie de Jong", jerseyNumber: 21, position: "MED" },
        { name: "Marc Bernal", jerseyNumber: 22, position: "MED" },
        { name: "Gabriel Jesus", jerseyNumber: 9, position: "DEL" },
        { name: "Lamine Yamal", jerseyNumber: 10, position: "DEL" },
        { name: "Raphinha", jerseyNumber: 11, position: "DEL" },
        { name: "Karim Adeyemi", jerseyNumber: 14, position: "DEL" },
        { name: "Anthony Gordon", jerseyNumber: 17, position: "DEL" },
        { name: "Roony Bardghji", jerseyNumber: 19, position: "DEL" },
        { name: "Jesse Bisiwu", jerseyNumber: 27, position: "DEL" },
        { name: "Hamza Mohamed Abdelkarim Elsayed Selim", jerseyNumber: 29, position: "DEL" },
      ],
    },
    {
      teamName: "Real Madrid CF",
      source: { label: "realmadrid.com · First team · Players", url: "https://www.realmadrid.com/en-US/football/first-team/players", consultedOn: "2026-10-24", consultedAtUtc: "2026-10-25T05:13:35Z" },
      players: [
        { name: "Courtois", jerseyNumber: 1, position: "POR" },
        { name: "Lunin", jerseyNumber: 13, position: "POR" },
        { name: "Asencio", jerseyNumber: 2, position: "DEF" },
        { name: "E. Militão", jerseyNumber: 3, position: "DEF" },
        { name: "Huijsen", jerseyNumber: 4, position: "DEF" },
        { name: "Trent", jerseyNumber: 12, position: "DEF" },
        { name: "Konaté", jerseyNumber: 16, position: "DEF" },
        { name: "Cucurella", jerseyNumber: 17, position: "DEF" },
        { name: "Á. Carreras", jerseyNumber: 18, position: "DEF" },
        { name: "Rüdiger", jerseyNumber: 22, position: "DEF" },
        { name: "F. Mendy", jerseyNumber: 23, position: "DEF" },
        { name: "Dumfries", jerseyNumber: 24, position: "DEF" },
        { name: "Bellingham", jerseyNumber: 5, position: "MED" },
        { name: "Camavinga", jerseyNumber: 6, position: "MED" },
        { name: "Valverde", jerseyNumber: 8, position: "MED" },
        { name: "Tchouaméni", jerseyNumber: 14, position: "MED" },
        { name: "Arda Güler", jerseyNumber: 15, position: "MED" },
        { name: "Bernardo Silva", jerseyNumber: 20, position: "MED" },
        { name: "Thiago", jerseyNumber: 27, position: "MED" },
        { name: "Vini Jr.", jerseyNumber: 7, position: "DEL" },
        { name: "Endrick", jerseyNumber: 9, position: "DEL" },
        { name: "Mbappé", jerseyNumber: 10, position: "DEL" },
        { name: "Rodrygo", jerseyNumber: 11, position: "DEL" },
        { name: "C. Espí", jerseyNumber: 19, position: "DEL" },
        { name: "Brahim", jerseyNumber: 21, position: "DEL" },
        { name: "Diomande", jerseyNumber: 25, position: "DEL" },
      ],
    },
  ],
};
