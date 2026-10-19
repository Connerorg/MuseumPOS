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
  if (!(await hasActivePinUnlock(data.user.id))) return NextResponse.json({ error: "Unlock the employee PIN before changing inventory." }, { status: 423 });

  let body: { product_id?: unknown; quantity_delta?: unknown; movement_type?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const movementTypes = ["restock", "adjustment", "return", "waste", "opening_balance"];
  if (typeof body.product_id !== "string" || !uuidPattern.test(body.product_id) ||
      !Number.isSafeInteger(body.quantity_delta) || (body.quantity_delta as number) === 0 ||
      Math.abs(body.quantity_delta as number) > 100000 ||
      typeof body.movement_type !== "string" || !movementTypes.includes(body.movement_type) ||
      typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.trim().length > 500) {
    return NextResponse.json({ error: "Provide a product, non-zero quantity change, movement type, and reason." }, { status: 400 });
  }
  try {
    const result = await createServiceSupabase().rpc("adjust_inventory", {
      p_actor_id: data.user.id,
      p_product_id: body.product_id,
      p_quantity_delta: body.quantity_delta,
      p_movement_type: body.movement_type,
      p_reason: body.reason.trim(),
    });
    if (result.error) {
      if (result.error.message.includes("inventory_manager_role_required")) return NextResponse.json({ error: "A supervisor, manager, or administrator is required for stock changes." }, { status: 403 });
      if (result.error.message.includes("inventory_cannot_be_negative")) return NextResponse.json({ error: "Stock cannot become negative." }, { status: 409 });
      return NextResponse.json({ error: "Inventory adjustment failed. Confirm that the migration is applied and the product is tracked." }, { status: 409 });
    }
    return NextResponse.json({ adjustment: result.data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Inventory service unavailable." }, { status: 503 });
  }
}
