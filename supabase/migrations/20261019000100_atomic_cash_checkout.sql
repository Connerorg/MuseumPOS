-- Transaction-safe online cash checkout. This does not enable card processing or offline synchronization.
create or replace function public.complete_cash_sale(
  p_cashier_id uuid,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_device_id uuid;
  v_session_id uuid;
  v_client_tx uuid;
  v_idempotency_key text;
  v_existing public.sales%rowtype;
  v_cashier public.employee_profiles%rowtype;
  v_session public.cash_sessions%rowtype;
  v_item jsonb;
  v_kind text;
  v_item_id uuid;
  v_qty integer;
  v_product public.products%rowtype;
  v_ticket public.ticket_types%rowtype;
  v_sale_id uuid := gen_random_uuid();
  v_sale_item_id uuid;
  v_name text;
  v_code text;
  v_unit_price integer;
  v_line_total integer;
  v_subtotal integer := 0;
  v_receipt text;
  v_payment_reference text;
begin
  if p_cashier_id is null or p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_checkout_request';
  end if;

  begin
    v_device_id := (p_request->>'device_id')::uuid;
    v_session_id := (p_request->>'cash_session_id')::uuid;
    v_client_tx := (p_request->>'client_transaction_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_checkout_identifiers';
  end;

  v_idempotency_key := nullif(btrim(p_request->>'idempotency_key'), '');
  v_payment_reference := nullif(btrim(p_request->>'payment_reference'), '');
  if v_idempotency_key is null or length(v_idempotency_key) > 200
     or v_client_tx is null or v_device_id is null or v_session_id is null then
    raise exception using errcode = '22023', message = 'missing_checkout_identifiers';
  end if;
  if coalesce(p_request->>'payment_method', 'cash') <> 'cash' then
    raise exception using errcode = '0A000', message = 'only_cash_checkout_is_enabled';
  end if;
  if jsonb_typeof(p_request->'items') <> 'array'
     or jsonb_array_length(p_request->'items') < 1
     or jsonb_array_length(p_request->'items') > 100 then
    raise exception using errcode = '22023', message = 'invalid_checkout_items';
  end if;

  select * into v_cashier
  from public.employee_profiles
  where id = p_cashier_id and active = true
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'active_employee_required';
  end if;

  select * into v_existing from public.sales where idempotency_key = v_idempotency_key;
  if found then
    if v_existing.cashier_id <> p_cashier_id then
      raise exception using errcode = '23505', message = 'idempotency_key_already_used';
    end if;
    return jsonb_build_object('sale_id', v_existing.id, 'receipt_number', v_existing.receipt_number,
      'status', v_existing.status, 'total_cents', v_existing.total_cents, 'idempotent_replay', true);
  end if;

  perform 1 from public.pos_devices where id = v_device_id and active = true for share;
  if not found then
    raise exception using errcode = '22023', message = 'active_pos_device_required';
  end if;

  select * into v_session
  from public.cash_sessions
  where id = v_session_id and device_id = v_device_id and status = 'open'
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'open_cash_session_required';
  end if;

  for v_item in select value from jsonb_array_elements(p_request->'items')
  loop
    v_kind := v_item->>'kind';
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 1000 then
      raise exception using errcode = '22023', message = 'invalid_item_quantity';
    end if;
    begin
      v_item_id := (v_item->>'id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_item_id';
    end;

    if v_kind = 'product' then
      select * into v_product from public.products
      where id = v_item_id and active = true
      for update;
      if not found then
        raise exception using errcode = '22023', message = 'product_not_available';
      end if;
      if v_product.track_inventory and v_product.stock_on_hand < v_qty then
        raise exception using errcode = '22000', message = 'insufficient_stock';
      end if;
      v_name := v_product.name;
      v_code := v_product.sku;
      select pr.unit_price_cents into v_unit_price
      from public.price_rules pr
      where pr.product_id = v_product.id
        and pr.category_code = 'individual'
        and pr.valid_from <= now()
        and (pr.valid_until is null or pr.valid_until > now())
      order by pr.valid_from desc
      limit 1;
      v_unit_price := coalesce(v_unit_price, v_product.unit_price_cents);
      insert into public.sale_items(sale_id, product_id, item_name_snapshot, item_code_snapshot,
        quantity, unit_price_cents, tax_cents, discount_cents, line_total_cents)
      values(v_sale_id, v_product.id, v_name, v_code, v_qty, v_unit_price, 0, 0, v_unit_price * v_qty)
      returning id into v_sale_item_id;
      if v_product.track_inventory then
        update public.products set stock_on_hand = stock_on_hand - v_qty, updated_at = now()
        where id = v_product.id;
        insert into public.inventory_movements(product_id, sale_item_id, movement_type, quantity_delta, reason, created_by)
        values(v_product.id, v_sale_item_id, 'sale', -v_qty, 'POS cash sale', p_cashier_id);
      end if;
    elsif v_kind = 'ticket' then
      select * into v_ticket from public.ticket_types
      where id = v_item_id and active = true
      for share;
      if not found then
        raise exception using errcode = '22023', message = 'ticket_type_not_available';
      end if;
      v_name := v_ticket.name;
      v_code := v_ticket.code;
      select pr.unit_price_cents into v_unit_price
      from public.price_rules pr
      where pr.ticket_type_id = v_ticket.id
        and pr.category_code = 'individual'
        and pr.valid_from <= now()
        and (pr.valid_until is null or pr.valid_until > now())
      order by pr.valid_from desc
      limit 1;
      v_unit_price := coalesce(v_unit_price, v_ticket.base_price_cents);
      insert into public.sale_items(sale_id, ticket_type_id, item_name_snapshot, item_code_snapshot,
        quantity, unit_price_cents, tax_cents, discount_cents, line_total_cents)
      values(v_sale_id, v_ticket.id, v_name, v_code, v_qty, v_unit_price, 0, 0, v_unit_price * v_qty)
      returning id into v_sale_item_id;
      insert into public.issued_tickets(sale_item_id, ticket_type_id)
      select v_sale_item_id, v_ticket.id from generate_series(1, v_qty);
    else
      raise exception using errcode = '22023', message = 'unsupported_item_kind';
    end if;

    v_subtotal := v_subtotal + v_unit_price * v_qty;
    v_unit_price := null;
  end loop;

  if v_subtotal <= 0 then
    raise exception using errcode = '22023', message = 'zero_total_checkout_not_allowed';
  end if;

  v_receipt := 'MUS-' || to_char(current_date, 'YYYYMMDD') || '-' || upper(substr(replace(v_sale_id::text, '-', ''), 1, 8));
  insert into public.sales(id, receipt_number, device_id, cash_session_id, cashier_id,
    client_transaction_id, idempotency_key, status, currency, subtotal_cents, tax_cents,
    discount_cents, total_cents, tax_treatment, completed_at)
  values(v_sale_id, v_receipt, v_device_id, v_session_id, p_cashier_id,
    v_client_tx, v_idempotency_key, 'completed', 'ZAR', v_subtotal, 0, 0, v_subtotal,
    'unconfigured', now());

  insert into public.payments(sale_id, method, status, amount_cents, currency,
    terminal_reference, recorded_by, confirmed_at)
  values(v_sale_id, 'cash', 'confirmed', v_subtotal, 'ZAR',
    v_payment_reference, p_cashier_id, now());

  insert into public.cash_movements(cash_session_id, movement_type, amount_cents, reference, created_by)
  values(v_session_id, 'cash_sale', v_subtotal, v_receipt, p_cashier_id);

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(p_cashier_id, 'sale.completed', 'sale', v_sale_id::text,
    jsonb_build_object('receipt_number', v_receipt, 'total_cents', v_subtotal, 'payment_method', 'cash'));

  return jsonb_build_object('sale_id', v_sale_id, 'receipt_number', v_receipt,
    'status', 'completed', 'total_cents', v_subtotal, 'currency', 'ZAR', 'idempotent_replay', false);
end;
$function$;

revoke all on function public.complete_cash_sale(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.complete_cash_sale(uuid, jsonb) to service_role;
