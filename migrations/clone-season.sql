-- Seasonal table cloning.
-- Installs clone_season(suffix, tables[]): for each base table, creates a
-- year-suffixed archive copy (structure + data) if it doesn't already exist,
-- then mirrors the base table's RLS state and policies onto the archive.
--
-- Apply this file once in the Supabase SQL editor to install the function,
-- then each season run e.g.:
--
--   select clone_season('20262027');
--
-- Behaviour:
--   * New archive (target missing): copies data from the base table + applies RLS.
--   * Existing archive: skips the data copy (data untouched), re-syncs RLS only.
--   * Only reads from the base tables and writes to the suffixed ones — the live
--     unsuffixed tables are never modified.
--   * Mirror semantics: drops all policies on the target before recreating from
--     source, so any hand-added custom policy on an archive is removed on re-run.
--   * Data-only copy (CREATE TABLE AS): archives carry no PK/indexes/constraints,
--     matching the existing season tables. Swap the create line for
--     `create table public.%I (like public.%I including all)` + an
--     `insert into ... select * from ...` if you want those on the archives.
--
-- The default table list is the set that currently has season-suffixed
-- siblings; override per call, e.g. select clone_season('20262027', array['player','team']);

create or replace function clone_season(
  p_suffix text,
  p_tables text[] default array['club','division','lewis','player','team','venue']
) returns void
language plpgsql
as $fn$
declare
  src text; tgt text; pol record; oldpol record;
  v_roles text; v_using text; v_check text;
begin
  foreach src in array p_tables loop
    tgt := src || p_suffix;

    -- copy structure + data only if the archive doesn't exist yet
    if to_regclass(format('public.%I', tgt)) is null then
      execute format('create table public.%I as table public.%I', tgt, src);
      raise notice 'created table %', tgt;
    else
      raise notice 'table % exists, syncing RLS only', tgt;
    end if;

    -- mirror the source's RLS onto the target
    if (select relrowsecurity from pg_class where oid = format('public.%I', src)::regclass) then
      execute format('alter table public.%I enable row level security', tgt);
    end if;

    -- clear the target's policies, then recreate exactly what the source has
    for oldpol in
      select policyname from pg_policies where schemaname = 'public' and tablename = tgt
    loop
      execute format('drop policy %I on public.%I', oldpol.policyname, tgt);
    end loop;

    for pol in
      select * from pg_policies where schemaname = 'public' and tablename = src
    loop
      select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ')
        into v_roles from unnest(pol.roles) as r;
      v_using := case when pol.qual      is not null then format(' using (%s)', pol.qual) else '' end;
      v_check := case when pol.with_check is not null then format(' with check (%s)', pol.with_check) else '' end;

      execute format('create policy %I on public.%I as %s for %s to %s%s%s',
        pol.policyname, tgt, pol.permissive, pol.cmd, v_roles, v_using, v_check);
    end loop;
  end loop;
end;
$fn$;
