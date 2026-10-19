import { NextResponse } from "next/server";
import { getAuthenticatedEmployeeId } from "@/lib/supabase/authenticated-employee";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actorId = await getAuthenticatedEmployeeId();
  if (!actorId) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
  if (!(await hasActivePinUnlock(actorId))) return NextResponse.json({ error: "Unlock the employee PIN before continuing." }, { status: 423 });
  let body: { employee_id?: unknown; pin?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (typeof body.employee_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.employee_id) ||
      typeof body.pin !== "string" || !/^[0-9]{4,8}$/.test(body.pin)) {
    return NextResponse.json({ error: "Employee ID or PIN is invalid." }, { status: 400 });
  }
  try {
    const { error } = await createServiceSupabase().rpc("set_employee_pin", {
      p_actor_id: actorId, p_employee_id: body.employee_id, p_pin: body.pin,
    });
    if (error) {
      if (error.message.includes("manager_or_administrator_required")) {
        return NextResponse.json({ error: "A manager or administrator must set employee PINs." }, { status: 403 });
      }
      return NextResponse.json({ error: "PIN could not be saved. Confirm that the employee is active and the database migration is applied." }, { status: 409 });
    }
    return NextResponse.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "PIN service unavailable." }, { status: 503 });
  }
}
