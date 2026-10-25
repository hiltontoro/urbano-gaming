/**
 * TEST-ONLY. The documented PROPOSAL for the roster fields of `players` — not a migration, never applied by the application, the loader or
 * any deployment. The contract test applies it (idempotently) to the DISPOSABLE LOCAL database it already runs against, so the loader and
 * the repository can be proved against a real Postgres. A durable migration would be a separate, explicitly authorised step; this text is
 * kept identical to the proposal document that was handed over for review.
 */
export const ROSTER_COLUMNS_PROPOSAL_SQL = `
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
`;
