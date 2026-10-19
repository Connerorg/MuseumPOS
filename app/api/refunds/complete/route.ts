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
  if (!(await hasActivePinUnlock(data.user.id))) return NextResponse.json({ error: "Unlock the employee PIN before completing a refund." }, { status: 423 });

  let body: { refund_id?: unknown; cash_session_id?: unknown; restock_returned_items?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof body.refund_id !== "string" || !uuidPattern.test(body.refund_id) ||
      typeof body.cash_session_id !== "string" || !uuidPattern.test(body.cash_session_id) ||
      typeof body.restock_returned_items !== "boolean") {
    return NextResponse.json({ error: "Refund, open cash session, and returned-stock decision are required." }, { status: 400 });
  }
  try {
    const result = await createServiceSupabase().rpc("complete_cash_refund", {
      p_actor_id: data.user.id, p_refund_id: body.refund_id,
      p_cash_session_id: body.cash_session_id, p_restock_returned_items: body.restock_returned_items,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("manager_or_administrator_required")) return NextResponse.json({ error: "Only a manager or administrator can complete cash refunds." }, { status: 403 });
      if (message.includes("cash_payment_only")) return NextResponse.json({ error: "Only confirmed cash sales can be refunded here. Card refunds need terminal/provider integration." }, { status: 409 });
      if (message.includes("open_cash_session_required")) return NextResponse.json({ error: "An open cash session is required to record the cash outflow." }, { status: 409 });
      return NextResponse.json({ error: "Cash refund could not be completed. Confirm approval, session, and migration status." }, { status: 409 });
    }
    return NextResponse.json({ refund: result.data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Refund processing service unavailable." }, { status: 503 });
  }
}
