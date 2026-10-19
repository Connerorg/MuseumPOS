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
  if not found or v_sale.status not in ('completed','partially_refunded') then
    raise exception using errcode='22023', message='completed_sale_required';
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

revoke all on function public.request_sale_refund(uuid,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.decide_sale_refund(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.request_sale_refund(uuid,uuid,integer,text) to service_role;
grant execute on function public.decide_sale_refund(uuid,uuid,boolean,text) to service_role;
