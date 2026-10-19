-- Authorized stock movements for receiving, returns, waste, and corrections.
create or replace function public.adjust_inventory(
  p_actor_id uuid,
  p_product_id uuid,
  p_quantity_delta integer,
  p_movement_type public.inventory_movement_type,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_product public.products%rowtype;
  v_new_stock integer;
  v_reason text;
begin
  if p_actor_id is null or p_product_id is null or p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception using errcode = '22023', message = 'invalid_inventory_adjustment';
  end if;
  if p_movement_type not in ('restock','adjustment','return','waste','opening_balance') then
    raise exception using errcode = '22023', message = 'invalid_inventory_movement_type';
  end if;
  v_reason := nullif(btrim(p_reason), '');
  if v_reason is null or length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'inventory_reason_required';
  end if;

  select * into v_actor from public.employee_profiles
  where id = p_actor_id and active = true for share;
  if not found or v_actor.role not in ('supervisor','manager','administrator') then
    raise exception using errcode = '42501', message = 'inventory_manager_role_required';
  end if;

  select * into v_product from public.products
  where id = p_product_id and active = true for update;
  if not found or not v_product.track_inventory then
    raise exception using errcode = '22023', message = 'tracked_active_product_required';
  end if;
  v_new_stock := v_product.stock_on_hand + p_quantity_delta;
  if v_new_stock < 0 then
    raise exception using errcode = '22000', message = 'inventory_cannot_be_negative';
  end if;

  update public.products set stock_on_hand = v_new_stock, updated_at = now() where id = p_product_id;
  insert into public.inventory_movements(product_id,movement_type,quantity_delta,reason,created_by)
  values(p_product_id,p_movement_type,p_quantity_delta,v_reason,p_actor_id);
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'inventory.adjusted','product',p_product_id::text,
    jsonb_build_object('previous_stock',v_product.stock_on_hand,'new_stock',v_new_stock,
      'quantity_delta',p_quantity_delta,'movement_type',p_movement_type,'reason',v_reason));

  return jsonb_build_object('product_id',p_product_id,'previous_stock',v_product.stock_on_hand,
    'stock_on_hand',v_new_stock,'quantity_delta',p_quantity_delta,'movement_type',p_movement_type);
end;
$function$;
revoke all on function public.adjust_inventory(uuid,uuid,integer,public.inventory_movement_type,text) from public, anon, authenticated;
grant execute on function public.adjust_inventory(uuid,uuid,integer,public.inventory_movement_type,text) to service_role;

-- Enforce cash-session ownership server-side; managers may close sessions left by another employee.
create or replace function public.close_cash_session(p_employee_id uuid, p_session_id uuid, p_counted_cash_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_session public.cash_sessions%rowtype;
  v_actor public.employee_profiles%rowtype;
  v_expected bigint;
  v_variance bigint;
begin
  if p_counted_cash_cents is null or p_counted_cash_cents < 0 then
    raise exception using errcode = '22023', message = 'invalid_counted_cash';
  end if;
  select * into v_actor from public.employee_profiles where id=p_employee_id and active=true;
  if not found then raise exception using errcode = '42501', message = 'active_employee_required'; end if;
  select * into v_session from public.cash_sessions where id=p_session_id for update;
  if not found or v_session.status <> 'open' then
    raise exception using errcode = '22023', message = 'open_cash_session_required';
  end if;
  if v_session.opened_by <> p_employee_id and v_actor.role not in ('manager','administrator') then
    raise exception using errcode = '42501', message = 'cash_session_owner_or_manager_required';
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
  set status='closed', closed_by=p_employee_id, counted_cash_cents=p_counted_cash_cents,
      expected_cash_cents=v_expected, variance_cents=v_variance, closed_at=now()
  where id=p_session_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_employee_id,'cash_session.closed','cash_session',p_session_id::text,
    jsonb_build_object('expected_cash_cents',v_expected,'counted_cash_cents',p_counted_cash_cents,'variance_cents',v_variance));
  return jsonb_build_object('cash_session_id',p_session_id,'status','closed',
    'expected_cash_cents',v_expected,'counted_cash_cents',p_counted_cash_cents,'variance_cents',v_variance);
end;
$function$;
revoke all on function public.close_cash_session(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.close_cash_session(uuid,uuid,integer) to service_role;
