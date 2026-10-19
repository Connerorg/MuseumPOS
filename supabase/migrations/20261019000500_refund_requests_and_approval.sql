-- Refund request and independent supervisor/manager approval.
create or replace function public.request_sale_refund(
  p_actor_id uuid,
  p_sale_id uuid,
  p_amount_cents integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_sale public.sales%rowtype;
  v_reason text;
  v_refund public.refunds%rowtype;
  v_reserved bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception using errcode='22023', message='invalid_refund_amount';
  end if;
  v_reason := nullif(btrim(p_reason),'');
  if v_reason is null or length(v_reason)<3 or length(v_reason)>500 then
    raise exception using errcode='22023', message='refund_reason_required';
  end if;
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found then raise exception using errcode='42501', message='active_employee_required'; end if;
  select * into v_sale from public.sales where id=p_sale_id for update;
  if not found or v_sale.status <> 'completed' then
    raise exception using errcode='22023', message='completed_sale_required';
  end if;
  if v_sale.cashier_id <> p_actor_id and v_actor.role not in ('supervisor','manager','administrator') then
    raise exception using errcode='42501', message='sale_owner_or_supervisor_required';
  end if;
  select coalesce(sum(amount_cents),0) into v_reserved from public.refunds
    where sale_id=p_sale_id and status in ('pending','approved','completed');
  if v_reserved > 0 then
    raise exception using errcode='23505', message='refund_already_requested_or_processed';
  end if;
  -- Current schema does not associate refunds with individual sale lines. Until item-level
  -- refund lines exist, permit only a full-sale refund to avoid ambiguous stock/ticket handling.
  if p_amount_cents <> v_sale.total_cents then
    raise exception using errcode='22023', message='only_full_sale_refunds_supported';
  end if;
  if exists(select 1 from public.payments where sale_id=p_sale_id and method<>'cash') then
    raise exception using errcode='0A000', message='non_cash_refund_requires_payment_provider';
  end if;

  insert into public.refunds(sale_id,requested_by,amount_cents,reason,status)
  values(p_sale_id,p_actor_id,p_amount_cents,v_reason,'pending') returning * into v_refund;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'refund.requested','refund',v_refund.id::text,
    jsonb_build_object('sale_id',p_sale_id,'amount_cents',p_amount_cents,'reason',v_reason));
  return jsonb_build_object('refund_id',v_refund.id,'sale_id',p_sale_id,'amount_cents',p_amount_cents,
    'status',v_refund.status,'created_at',v_refund.created_at);
end;
$function$;

create or replace function public.decide_sale_refund(
  p_actor_id uuid,
  p_refund_id uuid,
  p_approve boolean,
  p_decision_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_refund public.refunds%rowtype;
  v_decision_reason text;
  v_status text;
begin
  if p_approve is null then raise exception using errcode='22023', message='refund_decision_required'; end if;
  v_decision_reason := nullif(btrim(p_decision_reason),'');
  if v_decision_reason is null or length(v_decision_reason)<3 or length(v_decision_reason)>500 then
    raise exception using errcode='22023', message='refund_decision_reason_required';
  end if;
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found or v_actor.role not in ('manager','administrator') then
    raise exception using errcode='42501', message='manager_or_administrator_required';
  end if;
  select * into v_refund from public.refunds where id=p_refund_id for update;
  if not found or v_refund.status <> 'pending' then
    raise exception using errcode='22023', message='pending_refund_required';
  end if;
  if v_refund.requested_by = p_actor_id then
    raise exception using errcode='42501', message='refund_requester_cannot_approve';
  end if;
  v_status := case when p_approve then 'approved' else 'rejected' end;
  update public.refunds set status=v_status, approved_by=p_actor_id where id=p_refund_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,case when p_approve then 'refund.approved' else 'refund.rejected' end,
    'refund',p_refund_id::text,jsonb_build_object('sale_id',v_refund.sale_id,
    'amount_cents',v_refund.amount_cents,'decision_reason',v_decision_reason));
  return jsonb_build_object('refund_id',p_refund_id,'status',v_status,'decision_reason',v_decision_reason);
end;
$function$;

create or replace function public.complete_cash_refund(
  p_actor_id uuid,
  p_refund_id uuid,
  p_cash_session_id uuid,
  p_restock_returned_items boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_refund public.refunds%rowtype;
  v_sale public.sales%rowtype;
  v_session public.cash_sessions%rowtype;
  v_item record;
  v_available bigint;
begin
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found or v_actor.role not in ('manager','administrator') then
    raise exception using errcode='42501', message='manager_or_administrator_required';
  end if;
  select * into v_refund from public.refunds where id=p_refund_id for update;
  if not found or v_refund.status <> 'approved' then
    raise exception using errcode='22023', message='approved_refund_required';
  end if;
  select * into v_sale from public.sales where id=v_refund.sale_id for update;
  if not found or v_sale.status not in ('completed','partially_refunded') then
    raise exception using errcode='22023', message='completed_sale_required';
  end if;
  if exists(select 1 from public.payments where sale_id=v_sale.id and (method <> 'cash' or status <> 'confirmed')) then
    raise exception using errcode='0A000', message='cash_payment_only';
  end if;
  select * into v_session from public.cash_sessions
    where id=p_cash_session_id and status='open' for update;
  if not found then raise exception using errcode='22023', message='open_cash_session_required'; end if;
  select v_session.opening_float_cents + coalesce(sum(
    case movement_type
      when 'cash_sale' then amount_cents
      when 'paid_in' then amount_cents
      when 'float_adjustment' then amount_cents
      when 'refund' then -amount_cents
      when 'paid_out' then -amount_cents
      else 0
    end
  ),0) into v_available
  from public.cash_movements where cash_session_id=p_cash_session_id;
  if v_available < v_refund.amount_cents then
    raise exception using errcode='22000', message='insufficient_cash_for_refund';
  end if;

  insert into public.cash_movements(cash_session_id,movement_type,amount_cents,reference,created_by)
  values(p_cash_session_id,'refund',v_refund.amount_cents,'Refund '||p_refund_id::text,p_actor_id);

  update public.issued_tickets set status='refunded'
  where sale_item_id in (select id from public.sale_items where sale_id=v_sale.id)
    and status='valid';

  if p_restock_returned_items then
    for v_item in
      select si.id as sale_item_id, si.product_id, si.quantity
      from public.sale_items si
      join public.products p on p.id=si.product_id
      where si.sale_id=v_sale.id and p.track_inventory
      for update of p
    loop
      update public.products set stock_on_hand=stock_on_hand+v_item.quantity, updated_at=now()
      where id=v_item.product_id;
      insert into public.inventory_movements(product_id,sale_item_id,movement_type,quantity_delta,reason,created_by)
      values(v_item.product_id,v_item.sale_item_id,'return',v_item.quantity,'Approved full-sale refund; returned to stock',p_actor_id);
    end loop;
  end if;

  update public.refunds set status='completed', completed_at=now() where id=p_refund_id;
  update public.sales set status='refunded' where id=v_sale.id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'refund.completed','refund',p_refund_id::text,
    jsonb_build_object('sale_id',v_sale.id,'amount_cents',v_refund.amount_cents,
      'cash_session_id',p_cash_session_id,'restocked_returned_items',p_restock_returned_items));
  return jsonb_build_object('refund_id',p_refund_id,'sale_id',v_sale.id,'status','completed',
    'amount_cents',v_refund.amount_cents,'cash_session_id',p_cash_session_id);
end;
$function$;

revoke all on function public.request_sale_refund(uuid,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.decide_sale_refund(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.request_sale_refund(uuid,uuid,integer,text) to service_role;
grant execute on function public.decide_sale_refund(uuid,uuid,boolean,text) to service_role;

revoke all on function public.complete_cash_refund(uuid,uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.complete_cash_refund(uuid,uuid,uuid,boolean) to service_role;
