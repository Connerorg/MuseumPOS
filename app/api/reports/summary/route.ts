import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const store = await cookies();
  const auth = createServerClient(url, anonKey, { cookies: {
    getAll: () => store.getAll(),
    setAll: (values) => { try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
  }});
  const { data, error: authError } = await auth.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const validDate = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")));
  if (!validDate(from) || !validDate(to) || new Date(to + "T00:00:00Z") < new Date(from + "T00:00:00Z")) {
    return NextResponse.json({ error: "Provide a valid date range with the end date on or after the start date." }, { status: 400 });
  }
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  if ((end.getTime() - start.getTime()) / 86400000 > 366) return NextResponse.json({ error: "Report range cannot exceed 366 days." }, { status: 400 });

  try {
    const db = createServiceSupabase();
    const { data: employee, error: employeeError } = await db.from("employee_profiles")
      .select("id,role,active").eq("id", data.user.id).maybeSingle();
    if (employeeError) return NextResponse.json({ error: "Employee profile lookup failed." }, { status: 503 });
    if (!employee?.active) return NextResponse.json({ error: "Active employee profile required." }, { status: 403 });
    if (!["supervisor", "manager", "administrator"].includes(employee.role)) return NextResponse.json({ error: "Supervisor or manager role required for financial reports." }, { status: 403 });

    const [sales, refunds] = await Promise.all([
      db.from("sales").select("id,receipt_number,status,total_cents,created_at,completed_at")
        .gte("created_at", start.toISOString()).lt("created_at", end.toISOString()).order("created_at", { ascending: false }).limit(1000),
      db.from("refunds").select("id,sale_id,amount_cents,status,created_at,completed_at")
        .gte("created_at", start.toISOString()).lt("created_at", end.toISOString()).order("created_at", { ascending: false }).limit(1000),
    ]);
    if (sales.error || refunds.error) return NextResponse.json({ error: "Report queries failed. Confirm database migrations are applied." }, { status: 503 });
    const completedSales = (sales.data ?? []).filter((s) => s.status === "completed" || s.status === "partially_refunded");
    const completedRefunds = (refunds.data ?? []).filter((r) => r.status === "completed");
    const gross = completedSales.reduce((sum, s) => sum + s.total_cents, 0);
    const refunded = completedRefunds.reduce((sum, r) => sum + r.amount_cents, 0);
    return NextResponse.json({
      period: { from, to },
      totals: {
        sales_count: completedSales.length,
        gross_sales_cents: gross,
        refunds_count: completedRefunds.length,
        refunds_cents: refunded,
        net_after_refunds_cents: gross - refunded,
      },
      sales: sales.data ?? [],
      refunds: refunds.data ?? [],
      truncated: (sales.data?.length ?? 0) === 1000 || (refunds.data?.length ?? 0) === 1000,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Reporting service unavailable." }, { status: 503 });
  }
}
