import { NextResponse } from "next/server";
import { getAuthenticatedEmployeeId } from "@/lib/supabase/authenticated-employee";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const employeeId = await getAuthenticatedEmployeeId();
  if (!employeeId) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
  if (!(await hasActivePinUnlock(employeeId))) return NextResponse.json({ error: "Unlock the employee PIN before continuing." }, { status: 423 });
  let body: { action?: unknown; device_id?: unknown; cash_session_id?: unknown; amount_cents?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const amount = body.amount_cents;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > 2147483647) {
    return NextResponse.json({ error: "Amount must be a non-negative whole number of cents." }, { status: 400 });
  }
  try {
    const client = createServiceSupabase();
    if (body.action === "open" && typeof body.device_id === "string" && /^[0-9a-f-]{36}$/i.test(body.device_id)) {
      const { data, error } = await client.rpc("open_cash_session", {
        p_employee_id: employeeId, p_device_id: body.device_id, p_opening_float_cents: amount,
      });
      if (error) return NextResponse.json({ error: "Cash session could not be opened. Check the device registration and whether a session is already open." }, { status: 409 });
      return NextResponse.json({ session: { id: data.cash_session_id, device_id: body.device_id, opened_by: employeeId, status: data.status, opening_float_cents: data.opening_float_cents, opened_at: data.opened_at } }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "close" && typeof body.cash_session_id === "string" && /^[0-9a-f-]{36}$/i.test(body.cash_session_id)) {
      const { data, error } = await client.rpc("close_cash_session", {
        p_employee_id: employeeId, p_session_id: body.cash_session_id, p_counted_cash_cents: amount,
      });
      if (error) return NextResponse.json({ error: "Cash session could not be closed. Confirm that it is open and the count is valid." }, { status: 409 });
      return NextResponse.json({ session: data }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "Action must be open or close and include the corresponding identifier." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Cash session service unavailable." }, { status: 503 });
  }
}
