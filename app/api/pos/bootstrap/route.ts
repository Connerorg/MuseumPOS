import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 503 });
  }

  const cookieStore = await cookies();
  const authClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch {}
      },
    },
  });
  const { data: auth, error: authError } = await authClient.auth.getUser();
  if (authError || !auth.user) {
    return NextResponse.json({ error: "Sign in with an employee account." }, { status: 401 });
  }

  try {
    const db = createServiceSupabase();
    const { data: employee, error: employeeError } = await db
      .from("employee_profiles")
      .select("id,employee_number,display_name,role,active")
      .eq("id", auth.user.id)
      .maybeSingle();
    if (employeeError) return NextResponse.json({ error: "Employee profile lookup failed." }, { status: 503 });
    if (!employee || !employee.active) return NextResponse.json({ error: "This account is not provisioned as an active museum employee." }, { status: 403 });

    const { data: pinUnlocked, error: pinError } = await db.rpc("require_employee_pin_unlock", { p_employee_id: auth.user.id });
    if (pinError) return NextResponse.json({ error: "PIN unlock migration is not applied. Apply the Supabase migrations before using the POS." }, { status: 503 });

    const now = new Date().toISOString();
    const [tickets, products, devices, sessions, categories, priceRules, employees] = await Promise.all([
      db.from("ticket_types").select("id,code,name,description,base_price_cents,currency,active").eq("active", true).order("name"),
      db.from("products").select("id,sku,barcode,name,description,category_id,unit_price_cents,currency,track_inventory,stock_on_hand,reorder_level,active").eq("active", true).order("name"),
      db.from("pos_devices").select("id,device_code,display_name,active").eq("active", true).order("display_name"),
      db.from("cash_sessions").select("id,device_id,opened_by,status,opening_float_cents,opened_at").eq("status", "open").order("opened_at", { ascending: false }),
      db.from("sale_categories").select("id,code,name,active").eq("active", true).order("sort_order"),
      db.from("price_rules").select("id,ticket_type_id,product_id,unit_price_cents,valid_from,valid_until").eq("category_code", "individual").lte("valid_from", now).order("valid_from", { ascending: false }),
      ["manager", "administrator"].includes(employee.role)
        ? db.from("employee_profiles").select("id,employee_number,display_name,role,active").order("display_name")
        : Promise.resolve({ data: [], error: null }),
    ]);
    const failed = [tickets, products, devices, sessions, categories, priceRules, employees].find((result) => result.error);
    if (failed?.error) return NextResponse.json({ error: "Could not load the POS catalogue. Confirm that database migrations have been applied." }, { status: 503 });

    return NextResponse.json({
      employee,
      ticketTypes: tickets.data ?? [],
      products: products.data ?? [],
      devices: devices.data ?? [],
      openSessions: sessions.data ?? [],
      categories: categories.data ?? [],
      priceRules: (priceRules.data ?? []).filter((rule) => !rule.valid_until || rule.valid_until > now).map(({ id, ticket_type_id, product_id, unit_price_cents, valid_from }) => ({ id, ticket_type_id, product_id, unit_price_cents, valid_from })),
      employees: employees.data ?? [],
      pinUnlocked: pinUnlocked === true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "POS service unavailable." }, { status: 503 });
  }
}
