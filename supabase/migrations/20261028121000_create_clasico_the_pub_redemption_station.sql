-- Migration: 20261028121000_create_clasico_the_pub_redemption_station
-- Data, not schema: the redemption station of El Clásico in The Pub (25 October 2026), for the prizes of that ONE match and activation.
--
--   * Identity of the station: a gaming member «Estación de canje · The Pub» with NO authority grant and an auth user that cannot sign in
--     (no e-mail, no phone, no password, no identity, banned). It exists only so that a delivery can say, in prize_qualifications and in
--     the audit event, that it was made by the station, and not by a person.
--   * The station itself: scope = the Clásico activation of The Pub; it ends at the close of 31 October 2026 in Honduras (UTC-6),
--     2026-11-01T06:00:00Z; sessions of 4 hours; NO PIN (pin_version 0): nobody can open a session until the Founder sets the PIN
--     privately through the administration page, which calls redemption_station_set_pin().
--   * It does nothing in a database that does not hold that activation (for example a blank test database) and nothing when the station
--     already exists, so it can be replayed.

do $$
declare
  c_slug constant text := 'clasico-the-pub-2026-10-25';
  c_activation constant uuid := '5f9ea3d1-9892-4d72-a1d0-c5c1d458d93a';
  c_match constant uuid := 'ad72e2e2-dad0-48ef-8e7a-7d8369d37af6';
  c_auth_user constant uuid := 'dc6ef12a-3013-4278-8f5c-db1c75848795';
  c_member constant uuid := 'ece459ad-4256-4941-b981-96284bdc7b9b';
begin
  if exists (select 1 from redemption_stations where slug = c_slug) then
    raise notice 'redemption station % already exists: nothing to do', c_slug;
    return;
  end if;
  if not exists (select 1 from venue_activations where venue_activation_id = c_activation and match_id = c_match) then
    raise notice 'the Clásico activation of The Pub is not in this database: no station created';
    return;
  end if;

  -- written the way the auth service writes a row of its own (the zero instance, empty strings in the token columns), so that the service
  -- can read it back; with no e-mail, no phone, no password and no identity there is nothing to sign in with, and it is banned besides
  insert into auth.users (
    instance_id, id, aud, role, banned_until,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values (
    '00000000-0000-0000-0000-000000000000', c_auth_user, 'authenticated', 'authenticated', now() + interval '100 years',
    '', '', '', '',
    '{}'::jsonb, '{"purpose":"identity of a redemption station: it cannot sign in"}'::jsonb, now(), now()
  )
  on conflict (id) do nothing;

  insert into gaming_members (gaming_member_id, auth_user_id, display_name)
  values (c_member, c_auth_user, 'Estación de canje · The Pub')
  on conflict (gaming_member_id) do nothing;

  insert into redemption_stations (slug, label, venue_activation_id, match_id, actor_gaming_member_id, session_ttl_minutes, expires_at)
  values (c_slug, 'The Pub · El Clásico', c_activation, c_match, c_member, 240, '2026-11-01T06:00:00Z');

  -- the identity of the station must hold no authority: stop if it does
  if exists (select 1 from authority_grants where gaming_member_id = c_member) then
    raise exception 'the identity of the station holds an authority grant';
  end if;
end;
$$;
