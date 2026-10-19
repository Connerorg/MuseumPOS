import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { error: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }) } as const;
  const store = await cookies();
  const auth = createServerClient(url, anonKey, { cookies: {
    getAll: () => store.getAll(),
    setAll: (values) => { try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
  }});
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return { error: NextResponse.json({ error: "Employee sign-in required." }, { status: 401 }) } as const;
  const db = createServiceSupabase();
  const { data: employee, error: profileError } = await db.from("employee_profiles")
    .select("id,role,active").eq("id", data.user.id).maybeSingle();
  if (profileError) return { error: NextResponse.json({ error: "Employee profile lookup failed." }, { status: 503 }) } as const;
  if (!employee?.active) return { error: NextResponse.json({ error: "Active employee profile required." }, { status: 403 }) } as const;
  return { db, employee } as const;
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;
  const manager = ["manager", "administrator"].includes(ctx.employee.role);
  let salesQuery = ctx.db.from("sales").select("id,receipt_number,total_cents,status,created_at,cashier_id")
    .in("status", ["completed", "partially_refunded"]).order("created_at", { ascending: false }).limit(100);
  let refundsQuery = ctx.db.from("refunds").select("id,sale_id,requested_by,approved_by,amount_cents,reason,status,created_at")
    .order("created_at", { ascending: false }).limit(100);
  if (!manager) {
    salesQuery = salesQuery.eq("cashier_id", ctx.employee.id);
    refundsQuery = refundsQuery.eq("requested_by", ctx.employee.id);
  }
  const [sales, refunds] = await Promise.all([salesQuery, refundsQuery]);
  if (sales.error || refunds.error) return NextResponse.json({ error: "Could not load refund records. Confirm the database migration is applied." }, { status: 503 });
  return NextResponse.json({ sales: sales.data ?? [], refunds: refunds.data ?? [], canApprove: manager }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;
  if (!(await hasActivePinUnlock(ctx.employee.id))) return NextResponse.json({ error: "Unlock the employee PIN before requesting a refund." }, { status: 423 });
  let body: { sale_id?: unknown; amount_cents?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof body.sale_id !== "string" || !uuidPattern.test(body.sale_id) ||
      !Number.isSafeInteger(body.amount_cents) || (body.amount_cents as number) <= 0 ||
      typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.trim().length > 500) {
    return NextResponse.json({ error: "Select a sale, full-sale amount, and reason." }, { status: 400 });
  }
  const result = await ctx.db.rpc("request_sale_refund", {
    p_actor_id: ctx.employee.id, p_sale_id: body.sale_id,
    p_amount_cents: body.amount_cents, p_reason: body.reason.trim(),
  });
  if (result.error) {
    const message = result.error.message ?? "";
    if (message.includes("only_full_sale_refunds_supported")) return NextResponse.json({ error: "Only full-sale refunds are supported until item-level refund handling is implemented." }, { status: 409 });
    if (message.includes("refund_already_requested_or_processed")) return NextResponse.json({ error: "A refund has already been requested or processed for this sale." }, { status: 409 });
    if (message.includes("non_cash_refund_requires_payment_provider")) return NextResponse.json({ error: "Card refunds require a configured payment-provider workflow." }, { status: 409 });
    return NextResponse.json({ error: "Refund request could not be saved. Confirm the refund migration is applied." }, { status: 409 });
  }
  return NextResponse.json({ refund: result.data }, { headers: { "Cache-Control": "no-store" } });
}
