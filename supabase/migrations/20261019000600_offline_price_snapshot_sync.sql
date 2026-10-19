-- Offline synchronization validates the cached price snapshot while holding catalogue locks,
-- then delegates to the same idempotent atomic cash-sale transaction used online.
create or replace function public.sync_offline_cash_sale(p_cashier_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_item jsonb;
  v_kind text;
  v_item_id uuid;
  v_expected integer;
  v_actual integer;
  v_product public.products%rowtype;
  v_ticket public.ticket_types%rowtype;
  v_rule integer;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object'
     or coalesce(p_request->>'source','') <> 'offline'
     or jsonb_typeof(p_request->'items') <> 'array'
     or jsonb_array_length(p_request->'items') < 1
     or jsonb_array_length(p_request->'items') > 100 then
    raise exception using errcode='22023', message='invalid_offline_sync_request';
  end if;

  for v_item in select value from jsonb_array_elements(p_request->'items')
  loop
    begin
      v_item_id := (v_item->>'id')::uuid;
      v_expected := (v_item->>'expected_unit_price_cents')::integer;
    exception when others then
      raise exception using errcode='22023', message='invalid_offline_price_snapshot';
    end;
    v_kind := v_item->>'kind';
    if v_expected is null or v_expected < 0 then
      raise exception using errcode='22023', message='invalid_offline_price_snapshot';
    end if;

    if v_kind='product' then
      select * into v_product from public.products where id=v_item_id and active=true for update;
      if not found then raise exception using errcode='22023', message='product_not_available'; end if;
      select pr.unit_price_cents into v_rule from public.price_rules pr
      where pr.product_id=v_product.id and pr.category_code='individual'
        and pr.valid_from<=now() and (pr.valid_until is null or pr.valid_until>now())
      order by pr.valid_from desc limit 1 for share;
      v_actual := coalesce(v_rule,v_product.unit_price_cents);
    elsif v_kind='ticket' then
      select * into v_ticket from public.ticket_types where id=v_item_id and active=true for share;
      if not found then raise exception using errcode='22023', message='ticket_type_not_available'; end if;
      select pr.unit_price_cents into v_rule from public.price_rules pr
      where pr.ticket_type_id=v_ticket.id and pr.category_code='individual'
        and pr.valid_from<=now() and (pr.valid_until is null or pr.valid_until>now())
      order by pr.valid_from desc limit 1 for share;
      v_actual := coalesce(v_rule,v_ticket.base_price_cents);
    else
      raise exception using errcode='22023', message='unsupported_item_kind';
    end if;
    if v_actual <> v_expected then
      raise exception using errcode='22000', message='catalogue_price_changed';
    end if;
    v_rule := null;
  end loop;

  return public.complete_cash_sale(p_cashier_id, p_request - 'source');
end;
$function$;

revoke all on function public.sync_offline_cash_sale(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.sync_offline_cash_sale(uuid,jsonb) to service_role;
