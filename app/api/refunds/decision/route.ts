import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
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
  if (!(await hasActivePinUnlock(data.user.id))) return NextResponse.json({ error: "Unlock the employee PIN before approving refunds." }, { status: 423 });

  let body: { refund_id?: unknown; approve?: unknown; decision_reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof body.refund_id !== "string" || !uuidPattern.test(body.refund_id) ||
      typeof body.approve !== "boolean" ||
      typeof body.decision_reason !== "string" || body.decision_reason.trim().length < 3 || body.decision_reason.trim().length > 500) {
    return NextResponse.json({ error: "Provide a refund ID, approval decision, and decision reason." }, { status: 400 });
  }
  try {
    const result = await createServiceSupabase().rpc("decide_sale_refund", {
      p_actor_id: data.user.id, p_refund_id: body.refund_id,
      p_approve: body.approve, p_decision_reason: body.decision_reason.trim(),
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("manager_or_administrator_required")) return NextResponse.json({ error: "Only a manager or administrator can approve or reject refunds." }, { status: 403 });
      if (message.includes("refund_requester_cannot_approve")) return NextResponse.json({ error: "The employee who requested the refund cannot approve it." }, { status: 403 });
      return NextResponse.json({ error: "Refund decision could not be saved. Confirm that the migration is applied and the request is pending." }, { status: 409 });
    }
    return NextResponse.json({ refund: result.data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Refund approval service unavailable." }, { status: 503 });
  }
}
