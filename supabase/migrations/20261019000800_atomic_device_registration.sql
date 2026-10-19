-- Register POS devices and write their audit record atomically.
create or replace function public.register_pos_device(
  p_actor_id uuid,
  p_device_code text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.employee_profiles%rowtype;
  v_device public.pos_devices%rowtype;
begin
  select * into v_actor from public.employee_profiles where id=p_actor_id and active=true;
  if not found or v_actor.role not in ('manager','administrator') then
    raise exception using errcode='42501', message='manager_or_administrator_required';
  end if;
  if p_device_code is null or p_device_code !~ '^[A-Za-z0-9_-]{2,32}$'
     or p_display_name is null or length(btrim(p_display_name))<2 or length(btrim(p_display_name))>80 then
    raise exception using errcode='22023', message='invalid_pos_device';
  end if;
  insert into public.pos_devices(device_code,display_name,active)
  values(upper(btrim(p_device_code)),btrim(p_display_name),true)
  returning * into v_device;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(p_actor_id,'pos_device.created','pos_device',v_device.id::text,
    jsonb_build_object('device_code',v_device.device_code,'display_name',v_device.display_name));
  return jsonb_build_object('id',v_device.id,'device_code',v_device.device_code,
    'display_name',v_device.display_name,'active',v_device.active);
end;
$function$;
revoke all on function public.register_pos_device(uuid,text,text) from public, anon, authenticated;
grant execute on function public.register_pos_device(uuid,text,text) to service_role;
