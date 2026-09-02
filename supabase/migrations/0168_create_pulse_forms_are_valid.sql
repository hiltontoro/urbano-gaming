-- Migration: 0168_create_pulse_forms_are_valid
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). Server-side layout validator
-- used by commit_pulse_setup_atomically — the ONLY authority for
-- whether a committed layout is legal, regardless of whether the
-- client's draft originated manually or from the assisted generator
-- (the server never trusts a client's "this was assisted, so it must
-- already be valid" claim).
--
-- p_forms shape: a jsonb array of exactly 4 objects, each
-- {"formId": text, "cells": [{"row": int, "col": int}, ...]}.
-- Validates: exactly 4 forms; cell counts are exactly the multiset
-- {2,2,3,4}; every cell in 0..7 bounds; every form is a single
-- straight horizontal or vertical run (orientation, contiguity, and
-- "no duplicate cell within a form" all fall out of the same
-- span-length-equals-cell-count check); no two forms share a cell
-- (overlap forbidden; adjacency/touching is deliberately unrestricted
-- — the accepted Product direction permits forms to touch).

create function pulse_forms_are_valid(p_forms jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_form jsonb;
  v_cell jsonb;
  v_lengths integer[] := '{}';
  v_expected_lengths integer[] := array[2, 2, 3, 4];
  v_all_cells text[] := '{}';
  v_cell_key text;
  v_rows integer[];
  v_cols integer[];
  v_min_row integer;
  v_max_row integer;
  v_min_col integer;
  v_max_col integer;
  v_cell_count integer;
  v_i integer;
begin
  if p_forms is null or jsonb_typeof(p_forms) <> 'array' or jsonb_array_length(p_forms) <> 4 then
    return false;
  end if;

  for v_form in select * from jsonb_array_elements(p_forms) loop
    if jsonb_typeof(v_form -> 'cells') <> 'array' then
      return false;
    end if;

    v_cell_count := jsonb_array_length(v_form -> 'cells');
    if v_cell_count < 2 or v_cell_count > 4 then
      return false;
    end if;
    v_lengths := array_append(v_lengths, v_cell_count);

    v_rows := '{}';
    v_cols := '{}';
    for v_cell in select * from jsonb_array_elements(v_form -> 'cells') loop
      if jsonb_typeof(v_cell -> 'row') <> 'number' or jsonb_typeof(v_cell -> 'col') <> 'number' then
        return false;
      end if;
      v_rows := array_append(v_rows, (v_cell ->> 'row')::integer);
      v_cols := array_append(v_cols, (v_cell ->> 'col')::integer);
    end loop;

    if exists (select 1 from unnest(v_rows) r where r < 0 or r > 7)
       or exists (select 1 from unnest(v_cols) c where c < 0 or c > 7) then
      return false;
    end if;

    select min(r), max(r) into v_min_row, v_max_row from unnest(v_rows) r;
    select min(c), max(c) into v_min_col, v_max_col from unnest(v_cols) c;

    if v_min_row = v_max_row and v_min_col = v_max_col and v_cell_count > 1 then
      return false; -- every cell identical: not a line, and hides a within-form duplicate
    elsif v_min_row = v_max_row then
      if (v_max_col - v_min_col + 1) <> v_cell_count then
        return false; -- not a contiguous horizontal run (or contains a duplicate)
      end if;
    elsif v_min_col = v_max_col then
      if (v_max_row - v_min_row + 1) <> v_cell_count then
        return false; -- not a contiguous vertical run (or contains a duplicate)
      end if;
    else
      return false; -- not a straight line at all
    end if;

    for v_i in 1 .. array_length(v_rows, 1) loop
      v_cell_key := v_rows[v_i] || ',' || v_cols[v_i];
      if v_cell_key = any(v_all_cells) then
        return false; -- overlaps a cell already claimed by an earlier form
      end if;
      v_all_cells := array_append(v_all_cells, v_cell_key);
    end loop;
  end loop;

  select array_agg(x order by x) into v_lengths from unnest(v_lengths) x;
  if v_lengths <> v_expected_lengths then
    return false;
  end if;

  return true;
end;
$$;
