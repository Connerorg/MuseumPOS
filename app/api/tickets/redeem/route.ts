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
  let body: { barcode?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (typeof body.barcode !== "string" || body.barcode.trim().length < 8 || body.barcode.trim().length > 128) {
    return NextResponse.json({ error: "A valid ticket barcode is required." }, { status: 400 });
  }
  try {
    const { data, error } = await createServiceSupabase().rpc("redeem_ticket", {
      p_employee_id: employeeId, p_barcode: body.barcode.trim(),
    });
    if (error) {
      if (error.message.includes("ticket_not_found")) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
      if (error.message.includes("ticket_not_valid_for_entry")) return NextResponse.json({ error: "Ticket has already been redeemed or is no longer valid." }, { status: 409 });
      return NextResponse.json({ error: "Ticket validation failed." }, { status: 409 });
    }
    return NextResponse.json({ ticket: data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Ticket validation service unavailable." }, { status: 503 });
  }
}
