-- Short-lived server-side PIN unlock window for the authenticated employee.
create table if not exists private.employee_pin_unlocks (
  employee_id uuid primary key references public.employee_profiles(id) on delete cascade,
  unlocked_until timestamptz not null,
  updated_at timestamptz not null default now()
);
revoke all on table private.employee_pin_unlocks from public, anon, authenticated, service_role;
grant select, insert, update, delete on table private.employee_pin_unlocks to service_role;

create or replace function public.verify_employee_pin(p_employee_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $function$
declare
  v_hash text;
  v_attempts integer;
  v_locked_until timestamptz;
begin
  if p_employee_id is null or p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    return false;
  end if;

  select c.pin_hash, c.failed_attempts, c.locked_until
    into v_hash, v_attempts, v_locked_until
  from private.employee_credentials c
  join public.employee_profiles e on e.id = c.employee_id
  where c.employee_id = p_employee_id and e.active = true
  for update of c;

  if not found or v_locked_until > now() then
    return false;
  end if;

  if extensions.crypt(p_pin, v_hash) = v_hash then
    update private.employee_credentials
    set failed_attempts = 0, locked_until = null, updated_at = now()
    where employee_id = p_employee_id;
    insert into private.employee_pin_unlocks(employee_id, unlocked_until, updated_at)
    values(p_employee_id, now() + interval '15 minutes', now())
    on conflict(employee_id) do update
      set unlocked_until = excluded.unlocked_until, updated_at = now();
    insert into public.audit_logs(actor_id, action, entity_type, entity_id)
    values(p_employee_id, 'employee.pin_unlocked', 'employee', p_employee_id::text);
    return true;
  end if;

  update private.employee_credentials
  set failed_attempts = v_attempts + 1,
      locked_until = case when v_attempts + 1 >= 5 then now() + interval '15 minutes' else null end,
      updated_at = now()
  where employee_id = p_employee_id;
  return false;
end;
$function$;

create or replace function public.require_employee_pin_unlock(p_employee_id uuid)
returns boolean
language sql
security definer
set search_path = pg_catalog, public, private
as $function$
  select exists (
    select 1 from private.employee_pin_unlocks u
    join public.employee_profiles e on e.id = u.employee_id
    where u.employee_id = p_employee_id and e.active = true and u.unlocked_until > now()
  );
$function$;

revoke all on function public.verify_employee_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.require_employee_pin_unlock(uuid) from public, anon, authenticated;
grant execute on function public.verify_employee_pin(uuid, text) to service_role;
grant execute on function public.require_employee_pin_unlock(uuid) to service_role;
