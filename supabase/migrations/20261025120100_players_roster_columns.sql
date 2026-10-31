-- Migration 20261025120100 — roster fields of players (squad number, position, provenance) for the Clásico rosters.
-- Append-only: a new file after 20261025120000. Four nullable columns, three checks and a partial unique index; nothing is dropped, rewritten or
-- backfilled. Players added by hand keep working with no number. The application reads players with select "*" and tolerates these columns being absent,
-- so the application and this migration can be applied in either order. Existing grants and row-level security of `players` apply to the new columns
-- unchanged (server roles only since 20261021120000).
--
-- jersey_number       the squad number of the season's roster (0-99). Not the player's identity: the identity is player_id, generated once.
-- position            POR / DEF / MED / DEL, normalised from the club's own label.
-- roster_source       where the entry was read (label + address); roster_consulted_on: the date it was consulted.
-- A squad number must carry its provenance. Unique per team among ACTIVE players, so a number is never shared on screen.

alter table players
  add column if not exists jersey_number smallint,
  add column if not exists position text,
  add column if not exists roster_source text,
  add column if not exists roster_consulted_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_jersey_number_range') then
    alter table players add constraint players_jersey_number_range check (jersey_number is null or jersey_number between 0 and 99);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_position_valid') then
    alter table players add constraint players_position_valid check (position is null or position in ('POR', 'DEF', 'MED', 'DEL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_squad_number_has_provenance') then
    alter table players add constraint players_squad_number_has_provenance check (jersey_number is null or (roster_source is not null and roster_consulted_on is not null));
  end if;
end
$$;

create unique index if not exists players_team_active_jersey_uidx on players (team_id, jersey_number) where jersey_number is not null and active;
