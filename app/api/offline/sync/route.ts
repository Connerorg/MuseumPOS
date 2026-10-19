import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OfflineItem = { kind: "product" | "ticket"; id: string; quantity: number; expected_unit_price_cents: number };
type OfflineSale = { employee_id: string; device_id: string; cash_session_id: string; client_transaction_id: string; idempotency_key: string; payment_method: "cash"; source: "offline"; items: OfflineItem[] };

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
  if (error || !data.user) return NextResponse.json({ error: "Sign in again before syncing offline cash entries." }, { status: 401 });
  if (!(await hasActivePinUnlock(data.user.id))) return NextResponse.json({ error: "Unlock the employee PIN before syncing offline cash entries." }, { status: 423 });

  let body: OfflineSale;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!body || body.source !== "offline" || body.payment_method !== "cash" ||
      body.employee_id !== data.user.id ||
      !uuidPattern.test(body.device_id ?? "") || !uuidPattern.test(body.cash_session_id ?? "") ||
      !uuidPattern.test(body.client_transaction_id ?? "") ||
      typeof body.idempotency_key !== "string" || body.idempotency_key.trim().length < 8 ||
      !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    return NextResponse.json({ error: "Offline entry is missing required identifiers or is not cash-only." }, { status: 400 });
  }
  for (const item of body.items) {
    if (!item || (item.kind !== "ticket" && item.kind !== "product") || !uuidPattern.test(item.id ?? "") ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 ||
        !Number.isSafeInteger(item.expected_unit_price_cents) || item.expected_unit_price_cents < 0) {
      return NextResponse.json({ error: "Offline item or cached price snapshot is invalid." }, { status: 400 });
    }
  }
  try {
    const serviceClient = createServiceSupabase();
    const { data: existingSale, error: existingError } = await serviceClient.from("sales")
      .select("id,cashier_id").eq("idempotency_key", body.idempotency_key.trim()).maybeSingle();
    if (existingError) return NextResponse.json({ error: "Could not verify offline retry state." }, { status: 503 });
    if (!existingSale) {
      const [employeeResult, sessionResult] = await Promise.all([
        serviceClient.from("employee_profiles").select("role,active").eq("id", data.user.id).maybeSingle(),
        serviceClient.from("cash_sessions").select("id,device_id,opened_by,status").eq("id", body.cash_session_id).maybeSingle(),
      ]);
      if (!employeeResult.data?.active) return NextResponse.json({ error: "Active employee profile required." }, { status: 403 });
      if (!sessionResult.data || sessionResult.data.device_id !== body.device_id || sessionResult.data.status !== "open") {
        return NextResponse.json({ error: "The original cash session is no longer open or does not match this device. Manager review is required." }, { status: 409 });
      }
      if (sessionResult.data.opened_by !== data.user.id && !["manager", "administrator"].includes(employeeResult.data.role)) {
        return NextResponse.json({ error: "Only the original session owner or a manager can reconcile this till." }, { status: 403 });
      }
    } else if (existingSale.cashier_id !== data.user.id) {
      return NextResponse.json({ error: "This offline idempotency key belongs to another employee." }, { status: 409 });
    }
    const result = await serviceClient.rpc("sync_offline_cash_sale", {
      p_cashier_id: data.user.id,
      p_request: { ...body, idempotency_key: body.idempotency_key.trim(), payment_method: "cash", source: "offline" },
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("catalogue_price_changed")) return NextResponse.json({ error: "Catalogue price changed while this device was offline. This entry needs manager review; it was not synced." }, { status: 409 });
      if (message.includes("open_cash_session_required")) return NextResponse.json({ error: "The original cash session is no longer open. This entry needs manager review; it was not synced." }, { status: 409 });
      if (message.includes("insufficient_stock")) return NextResponse.json({ error: "Stock is insufficient to reconcile this offline sale. Manager review is required." }, { status: 409 });
      return NextResponse.json({ error: "Offline entry could not be reconciled. It remains queued and requires review." }, { status: 409 });
    }
    return NextResponse.json({ sale: result.data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Offline synchronization service unavailable." }, { status: 503 });
  }
}
