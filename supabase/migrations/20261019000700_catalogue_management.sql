-- Manager-controlled catalogue creation and individual price changes.
create or replace function public.create_catalogue_item(
  p_actor_id uuid,
  p_kind text,
  p_code text,
  p_name text,
  p_description text,
  p_price_cents integer,
  p_track_inventory boolean default false,
  p_initial_stock integer default 0,
  p_reorder_level integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_product public.products%rowtype;
  v_ticket public.ticket_types%rowtype;
  v_code text := lower(btrim(p_code));
  v_name text := btrim(p_name);
  v_description text := nullif(btrim(p_description),'');
begin
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found or v_actor.role not in ('manager','administrator') then
    raise exception using errcode='42501', message='manager_or_administrator_required';
  end if;
  if p_kind not in ('product','ticket') or v_code !~ '^[a-z0-9][a-z0-9_-]{1,39}$'
     or v_name is null or length(v_name)<2 or length(v_name)>120
     or p_price_cents is null or p_price_cents<0
     or p_initial_stock is null or p_initial_stock<0
     or p_reorder_level is null or p_reorder_level<0 then
    raise exception using errcode='22023', message='invalid_catalogue_item';
  end if;
  if p_kind='ticket' and (coalesce(p_track_inventory,false) or p_initial_stock<>0 or p_reorder_level<>0) then
    raise exception using errcode='22023', message='tickets_do_not_track_stock';
  end if;
  if p_kind='product' and not coalesce(p_track_inventory,false) and p_initial_stock<>0 then
    raise exception using errcode='22023', message='initial_stock_requires_tracking';
  end if;

  if p_kind='product' then
    insert into public.products(sku,name,description,unit_price_cents,track_inventory,stock_on_hand,reorder_level,active)
    values(upper(btrim(p_code)),v_name,v_description,p_price_cents,coalesce(p_track_inventory,false),
      case when p_track_inventory then p_initial_stock else 0 end,p_reorder_level,true)
    returning * into v_product;
    insert into public.price_rules(product_id,category_code,unit_price_cents,created_by)
    values(v_product.id,'individual',p_price_cents,p_actor_id);
    if p_track_inventory and p_initial_stock>0 then
      insert into public.inventory_movements(product_id,movement_type,quantity_delta,reason,created_by)
      values(v_product.id,'opening_balance',p_initial_stock,'Opening stock on catalogue creation',p_actor_id);
    end if;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(p_actor_id,'catalogue.product_created','product',v_product.id::text,
      jsonb_build_object('sku',v_product.sku,'unit_price_cents',p_price_cents,'initial_stock',v_product.stock_on_hand));
    return jsonb_build_object('kind','product','id',v_product.id,'code',v_product.sku,'name',v_product.name,
      'price_cents',v_product.unit_price_cents,'stock_on_hand',v_product.stock_on_hand);
  end if;

  insert into public.ticket_types(code,name,description,base_price_cents,active)
  values(v_code,v_name,v_description,p_price_cents,true) returning * into v_ticket;
  insert into public.price_rules(ticket_type_id,category_code,unit_price_cents,created_by)
  values(v_ticket.id,'individual',p_price_cents,p_actor_id);
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'catalogue.ticket_created','ticket_type',v_ticket.id::text,
    jsonb_build_object('code',v_ticket.code,'base_price_cents',p_price_cents));
  return jsonb_build_object('kind','ticket','id',v_ticket.id,'code',v_ticket.code,'name',v_ticket.name,
    'price_cents',v_ticket.base_price_cents);
end;
$function$;

create or replace function public.update_catalogue_item(
  p_actor_id uuid,
  p_kind text,
  p_item_id uuid,
  p_name text,
  p_price_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_product public.products%rowtype;
  v_ticket public.ticket_types%rowtype;
  v_old_price integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found or v_actor.role not in ('manager','administrator') then
    raise exception using errcode='42501', message='manager_or_administrator_required';
  end if;
  if p_kind not in ('product','ticket') or p_item_id is null or p_name is null
     or length(btrim(p_name))<2 or length(btrim(p_name))>120
     or p_price_cents is null or p_price_cents<0 then
    raise exception using errcode='22023', message='invalid_catalogue_update';
  end if;

  if p_kind='product' then
    select * into v_product from public.products where id=p_item_id and active=true for update;
    if not found then raise exception using errcode='22023', message='product_not_available'; end if;
    v_old_price := v_product.unit_price_cents;
    update public.products set name=btrim(p_name),unit_price_cents=p_price_cents,updated_at=v_now where id=p_item_id;
    update public.price_rules set valid_until=v_now where product_id=p_item_id and category_code='individual'
      and valid_until is null and valid_from<v_now;
    insert into public.price_rules(product_id,category_code,unit_price_cents,created_by,valid_from)
    values(p_item_id,'individual',p_price_cents,p_actor_id,v_now);
  else
    select * into v_ticket from public.ticket_types where id=p_item_id and active=true for update;
    if not found then raise exception using errcode='22023', message='ticket_type_not_available'; end if;
    v_old_price := v_ticket.base_price_cents;
    update public.ticket_types set name=btrim(p_name) where id=p_item_id;
    update public.price_rules set valid_until=v_now where ticket_type_id=p_item_id and category_code='individual'
      and valid_until is null and valid_from<v_now;
    insert into public.price_rules(ticket_type_id,category_code,unit_price_cents,created_by,valid_from)
    values(p_item_id,'individual',p_price_cents,p_actor_id,v_now);
    update public.ticket_types set base_price_cents=p_price_cents where id=p_item_id;
  end if;

  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'catalogue.item_updated',p_kind,p_item_id::text,
    jsonb_build_object('old_price_cents',v_old_price,'new_price_cents',p_price_cents,'name',btrim(p_name)));
  return jsonb_build_object('kind',p_kind,'id',p_item_id,'name',btrim(p_name),
    'old_price_cents',v_old_price,'price_cents',p_price_cents);
end;
$function$;

revoke all on function public.create_catalogue_item(uuid,text,text,text,text,integer,boolean,integer,integer) from public, anon, authenticated;
revoke all on function public.update_catalogue_item(uuid,text,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.create_catalogue_item(uuid,text,text,text,text,integer,boolean,integer,integer) to service_role;
grant execute on function public.update_catalogue_item(uuid,text,uuid,text,integer) to service_role;
