-- Migration: 0164_add_pulse_duel_mechanic
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). Duel Container vs. Mechanic
-- boundary, third instance — additive only, mirrors 0137's own
-- MATH_DUEL precedent exactly. Pulse's own content (private layouts,
-- turn/deadline authority, target evidence) never lives on this table;
-- see 0165-0167. The existing MC-shaped columns are already nullable
-- since 0137 and are simply left null for a Pulse row.

alter table duels
  drop constraint duels_mechanic_key_valid_values;

alter table duels
  add constraint duels_mechanic_key_valid_values
  check (mechanic_key in ('MULTIPLE_CHOICE', 'MATH_DUEL', 'PULSE'));
