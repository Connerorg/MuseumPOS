import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ saleId: string }> }) {
  const { saleId } = await context.params;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(saleId)) return NextResponse.json({ error: "Invalid sale ID." }, { status: 400 });
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
  try {
    const db = createServiceSupabase();
    const { data: employee, error: profileError } = await db.from("employee_profiles").select("id,role,active").eq("id", data.user.id).maybeSingle();
    if (profileError) return NextResponse.json({ error: "Employee profile lookup failed." }, { status: 503 });
    if (!employee?.active) return NextResponse.json({ error: "Active employee profile required." }, { status: 403 });
    const { data: sale, error: saleError } = await db.from("sales")
      .select("id,receipt_number,status,currency,subtotal_cents,tax_cents,discount_cents,total_cents,created_at,completed_at,cashier_id")
      .eq("id", saleId).maybeSingle();
    if (saleError) return NextResponse.json({ error: "Sale lookup failed." }, { status: 503 });
    if (!sale) return NextResponse.json({ error: "Sale not found." }, { status: 404 });
    if (sale.cashier_id !== employee.id && !["supervisor", "manager", "administrator"].includes(employee.role)) {
      return NextResponse.json({ error: "You cannot view another cashier's receipt." }, { status: 403 });
    }
    const { data: items, error: itemsError } = await db.from("sale_items")
      .select("id,item_name_snapshot,item_code_snapshot,quantity,unit_price_cents,tax_cents,discount_cents,line_total_cents,product_id,ticket_type_id")
      .eq("sale_id", saleId).order("id");
    if (itemsError) return NextResponse.json({ error: "Sale items could not be loaded." }, { status: 503 });
    const ticketItemIds = (items ?? []).filter((item) => item.ticket_type_id).map((item) => item.id);
    let tickets: { id: string; sale_item_id: string; ticket_code: string; barcode: string; status: string; issued_at: string }[] = [];
    if (ticketItemIds.length) {
      const result = await db.from("issued_tickets").select("id,sale_item_id,ticket_code,barcode,status,issued_at")
        .in("sale_item_id", ticketItemIds).order("issued_at");
      if (result.error) return NextResponse.json({ error: "Issued tickets could not be loaded." }, { status: 503 });
      tickets = result.data ?? [];
    }
    return NextResponse.json({ sale, items: items ?? [], tickets }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Receipt service unavailable." }, { status: 503 });
  }
}
