import { NextResponse } from "next/server";
import { getAuthenticatedEmployeeId } from "@/lib/supabase/authenticated-employee";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const employeeId = await getAuthenticatedEmployeeId();
  if (!employeeId) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
  let body: { pin?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (typeof body.pin !== "string" || !/^[0-9]{4,8}$/.test(body.pin)) {
    return NextResponse.json({ error: "PIN must contain 4 to 8 digits." }, { status: 400 });
  }
  try {
    const { data, error } = await createServiceSupabase().rpc("verify_employee_pin", {
      p_employee_id: employeeId, p_pin: body.pin,
    });
    if (error) return NextResponse.json({ error: "PIN verification is not configured for this employee." }, { status: 503 });
    if (data !== true) return NextResponse.json({ error: "PIN is incorrect or the account is temporarily locked." }, { status: 401 });
    return NextResponse.json({ unlocked: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "PIN verification service unavailable." }, { status: 503 });
  }
}
