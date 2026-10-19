import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const store = await cookies();
  const auth = createServerClient(url, anonKey, { cookies: {
    getAll: () => store.getAll(),
    setAll: (values) => { try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
  }});
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
  if (!(await hasActivePinUnlock(data.user.id))) return NextResponse.json({ error: "Unlock the employee PIN before managing POS devices." }, { status: 423 });
  let body: { device_code?: unknown; display_name?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (typeof body.device_code !== "string" || !/^[A-Za-z0-9_-]{2,32}$/.test(body.device_code.trim()) ||
      typeof body.display_name !== "string" || body.display_name.trim().length < 2 || body.display_name.trim().length > 80) {
    return NextResponse.json({ error: "Device code must be 2–32 letters/numbers/dashes/underscores, and display name 2–80 characters." }, { status: 400 });
  }
  try {
    const db = createServiceSupabase();
    const { data: employee, error: profileError } = await db.from("employee_profiles")
      .select("id,role,active").eq("id", data.user.id).maybeSingle();
    if (profileError) return NextResponse.json({ error: "Employee profile lookup failed." }, { status: 503 });
    if (!employee?.active || !["manager", "administrator"].includes(employee.role)) return NextResponse.json({ error: "Manager or administrator role required." }, { status: 403 });
    const { data: device, error: insertError } = await db.from("pos_devices")
      .insert({ device_code: body.device_code.trim(), display_name: body.display_name.trim(), active: true })
      .select("id,device_code,display_name,active").single();
    if (insertError) {
      if (insertError.code === "23505") return NextResponse.json({ error: "That device code is already registered." }, { status: 409 });
      return NextResponse.json({ error: "Device could not be registered." }, { status: 409 });
    }
    await db.from("audit_logs").insert({ actor_id: data.user.id, action: "pos_device.created", entity_type: "pos_device", entity_id: device.id, details: { device_code: device.device_code, display_name: device.display_name } });
    return NextResponse.json({ device }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Device management service unavailable." }, { status: 503 });
  }
}
