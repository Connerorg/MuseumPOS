-- Employee PIN lockout, cash session lifecycle, and one-time ticket redemption.
-- All functions are callable only by the server-side service role; routes must verify the Supabase user first.
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

create or replace function public.set_employee_pin(p_actor_id uuid, p_employee_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $function$
declare
  v_actor_role public.employee_role;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception using errcode = '22023', message = 'pin_must_be_4_to_8_digits';
  end if;
  select role into v_actor_role from public.employee_profiles where id = p_actor_id and active = true;
  if v_actor_role not in ('manager','administrator') or v_actor_role is null then
    raise exception using errcode = '42501', message = 'manager_or_administrator_required';
  end if;
  if not exists (select 1 from public.employee_profiles where id = p_employee_id and active = true) then
    raise exception using errcode = '22023', message = 'active_employee_required';
  end if;

  insert into private.employee_credentials(employee_id, pin_hash, failed_attempts, locked_until, pin_changed_at, updated_at)
  values(p_employee_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)), 0, null, now(), now())
  on conflict (employee_id) do update
  set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null,
      pin_changed_at = now(), updated_at = now();

  insert into public.audit_logs(actor_id, action, entity_type, entity_id)
  values(p_actor_id, 'employee.pin_changed', 'employee', p_employee_id::text);
end;
$function$;

create or replace function public.open_cash_session(p_employee_id uuid, p_device_id uuid, p_opening_float_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_session public.cash_sessions%rowtype;
begin
  if p_opening_float_cents is null or p_opening_float_cents < 0 then
    raise exception using errcode = '22023', message = 'invalid_opening_float';
  end if;
  if not exists (select 1 from public.employee_profiles where id = p_employee_id and active = true) then
    raise exception using errcode = '42501', message = 'active_employee_required';
  end if;
  if not exists (select 1 from public.pos_devices where id = p_device_id and active = true) then
    raise exception using errcode = '22023', message = 'active_pos_device_required';
  end if;

  insert into public.cash_sessions(device_id, opened_by, opening_float_cents, status)
  values(p_device_id, p_employee_id, p_opening_float_cents, 'open')
  returning * into v_session;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(p_employee_id, 'cash_session.opened', 'cash_session', v_session.id::text,
    jsonb_build_object('device_id', p_device_id, 'opening_float_cents', p_opening_float_cents));

  return jsonb_build_object('cash_session_id', v_session.id, 'status', v_session.status,
    'opening_float_cents', v_session.opening_float_cents, 'opened_at', v_session.opened_at);
end;
$function$;

create or replace function public.close_cash_session(p_employee_id uuid, p_session_id uuid, p_counted_cash_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_session public.cash_sessions%rowtype;
  v_expected bigint;
  v_variance bigint;
begin
  if p_counted_cash_cents is null or p_counted_cash_cents < 0 then
    raise exception using errcode = '22023', message = 'invalid_counted_cash';
  end if;
  if not exists (select 1 from public.employee_profiles where id = p_employee_id and active = true) then
    raise exception using errcode = '42501', message = 'active_employee_required';
  end if;

  select * into v_session from public.cash_sessions where id = p_session_id for update;
  if not found or v_session.status <> 'open' then
    raise exception using errcode = '22023', message = 'open_cash_session_required';
  end if;

  select v_session.opening_float_cents + coalesce(sum(
    case movement_type
      when 'cash_sale' then amount_cents
      when 'paid_in' then amount_cents
      when 'float_adjustment' then amount_cents
      when 'refund' then -amount_cents
      when 'paid_out' then -amount_cents
      else 0
    end
  ), 0)
  into v_expected
  from public.cash_movements where cash_session_id = p_session_id;

  v_variance := p_counted_cash_cents - v_expected;
  update public.cash_sessions
  set status = 'closed', closed_by = p_employee_id, counted_cash_cents = p_counted_cash_cents,
      expected_cash_cents = v_expected, variance_cents = v_variance, closed_at = now()
  where id = p_session_id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(p_employee_id, 'cash_session.closed', 'cash_session', p_session_id::text,
    jsonb_build_object('expected_cash_cents', v_expected, 'counted_cash_cents', p_counted_cash_cents,
      'variance_cents', v_variance));

  return jsonb_build_object('cash_session_id', p_session_id, 'status', 'closed',
    'expected_cash_cents', v_expected, 'counted_cash_cents', p_counted_cash_cents,
    'variance_cents', v_variance);
end;
$function$;

create or replace function public.redeem_ticket(p_employee_id uuid, p_barcode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_ticket public.issued_tickets%rowtype;
begin
  if p_barcode is null or length(btrim(p_barcode)) < 8 or length(btrim(p_barcode)) > 128 then
    raise exception using errcode = '22023', message = 'invalid_ticket_barcode';
  end if;
  if not exists (select 1 from public.employee_profiles where id = p_employee_id and active = true) then
    raise exception using errcode = '42501', message = 'active_employee_required';
  end if;

  select * into v_ticket from public.issued_tickets
  where barcode = btrim(p_barcode) or ticket_code = btrim(p_barcode)
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ticket_not_found';
  end if;
  if v_ticket.status <> 'valid' then
    raise exception using errcode = '22000', message = 'ticket_not_valid_for_entry';
  end if;

  update public.issued_tickets
  set status = 'redeemed', redeemed_at = now(), redeemed_by = p_employee_id
  where id = v_ticket.id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(p_employee_id, 'ticket.redeemed', 'ticket', v_ticket.id::text,
    jsonb_build_object('ticket_code', v_ticket.ticket_code));

  return jsonb_build_object('ticket_id', v_ticket.id, 'ticket_code', v_ticket.ticket_code,
    'status', 'redeemed', 'redeemed_at', now());
end;
$function$;

revoke all on function public.verify_employee_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.set_employee_pin(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.open_cash_session(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.close_cash_session(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.redeem_ticket(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_employee_pin(uuid, text) to service_role;
grant execute on function public.set_employee_pin(uuid, uuid, text) to service_role;
grant execute on function public.open_cash_session(uuid, uuid, integer) to service_role;
grant execute on function public.close_cash_session(uuid, uuid, integer) to service_role;
grant execute on function public.redeem_ticket(uuid, text) to service_role;
