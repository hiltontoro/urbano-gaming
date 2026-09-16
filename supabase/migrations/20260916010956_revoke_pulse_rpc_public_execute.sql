-- Migration: 20260916010956_revoke_pulse_rpc_public_execute
-- URBANO Pulse — Production Containment Security Correction (UG-CR-GATE-050,
-- UG-CR-REV-034). Append-only corrective migration: migrations 0164-0172 are
-- left untouched.
--
-- The four Pulse mutating functions below were created in the exposed
-- `public` schema without any explicit EXECUTE privilege statement.
-- PostgreSQL/Supabase grants EXECUTE on a newly created function to PUBLIC
-- by default, and Row Level Security does not govern function execution —
-- so `anon`/`authenticated` API roles could call these functions directly,
-- bypassing the intended privileged server repository path entirely. This
-- mirrors the same class of gap already closed for Race's own atomic
-- functions (see supabase/migrations/20260904085843_create_race_functions.sql),
-- but goes one step further per this gate's explicit instruction: EXECUTE
-- for `service_role` is granted here EXPLICITLY rather than left to rely on
-- its own default grant, so this privilege posture is self-contained and
-- does not depend on an assumption about role defaults holding in the
-- future.
--
-- Every statement below resolves the EXACT signature (parameter types, in
-- declared order) — never the function name alone — so an unintended
-- overload sharing the same name could never be left callable by accident.

revoke execute on function public.start_pulse_duel_atomically(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.start_pulse_duel_atomically(uuid, text, uuid, uuid)
  to service_role;

revoke execute on function public.commit_pulse_setup_atomically(uuid, text, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.commit_pulse_setup_atomically(uuid, text, jsonb, boolean, text)
  to service_role;

revoke execute on function public.apply_pulse_target_atomically(uuid, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.apply_pulse_target_atomically(uuid, text, integer, integer, text)
  to service_role;

revoke execute on function public.claim_pulse_timeout_atomically(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_pulse_timeout_atomically(uuid, text)
  to service_role;
