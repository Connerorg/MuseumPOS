import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { response: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }) } as const;
  const store = await cookies();
  const auth = createServerClient(url, key, { cookies: {
    getAll: () => store.getAll(),
    setAll: (values) => { try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
  }});
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return { response: NextResponse.json({ error: "Sign-in required." }, { status: 401 }) } as const;
  if (!(await hasActivePinUnlock(data.user.id))) return { response: NextResponse.json({ error: "Unlock PIN first." }, { status: 423 }) } as const;
  const db = createServiceSupabase();
  const { data: employee, error: profileError } = await db.from("employee_profiles").select("id,role,active").eq("id", data.user.id).maybeSingle();
  if (profileError) return { response: NextResponse.json({ error: "Profile lookup failed." }, { status: 503 }) } as const;
  if (!employee?.active || !["manager", "administrator"].includes(employee.role)) return { response: NextResponse.json({ error: "Manager or administrator required." }, { status: 403 }) } as const;
  return { db, actorId: data.user.id } as const;
}

export async function POST(request: Request) {
  const ctx = await authorize();
  if ("response" in ctx) return ctx.response;
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  const body = parsed as Record<string, unknown>;
  const valid = (body?.kind === "product" || body?.kind === "ticket") &&
    typeof body.code === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(body.code.trim()) &&
    typeof body.name === "string" && body.name.trim().length >= 2 && body.name.trim().length <= 120 &&
    typeof body.price_cents === "number" && Number.isSafeInteger(body.price_cents) && Number(body.price_cents) >= 0 &&
    (body.description == null || (typeof body.description === "string" && body.description.length <= 500)) &&
    (body.track_inventory === undefined || typeof body.track_inventory === "boolean") &&
    Number.isSafeInteger(body.initial_stock ?? 0) && Number(body.initial_stock ?? 0) >= 0 &&
    Number.isSafeInteger(body.reorder_level ?? 0) && Number(body.reorder_level ?? 0) >= 0;
  if (!valid) return NextResponse.json({ error: "Catalogue fields are invalid." }, { status: 400 });
  try {
    const { data, error } = await ctx.db.rpc("create_catalogue_item", {
      p_actor_id: ctx.actorId, p_kind: body.kind as "product" | "ticket", p_code: (body.code as string).trim(),
      p_name: (body.name as string).trim(), p_description: typeof body.description === "string" ? body.description.trim() : null,
      p_price_cents: body.price_cents as number, p_track_inventory: body.kind === "product" && body.track_inventory === true,
      p_initial_stock: Number(body.initial_stock ?? 0), p_reorder_level: Number(body.reorder_level ?? 0),
    });
    if (error) return NextResponse.json({ error: error.code === "23505" ? "That SKU or ticket code already exists." : "Catalogue item could not be created. Confirm the migration is applied." }, { status: 409 });
    return NextResponse.json({ item: data }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Catalogue service unavailable." }, { status: 503 }); }
}

export async function PATCH(request: Request) {
  const ctx = await authorize();
  if ("response" in ctx) return ctx.response;
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  const body = parsed as Record<string, unknown>;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if ((body?.kind !== "product" && body?.kind !== "ticket") ||
      typeof body.item_id !== "string" || !uuidPattern.test(body.item_id) ||
      typeof body.name !== "string" || body.name.trim().length < 2 || body.name.trim().length > 120 ||
      typeof body.price_cents !== "number" || !Number.isSafeInteger(body.price_cents) || Number(body.price_cents) < 0) {
    return NextResponse.json({ error: "Catalogue update fields are invalid." }, { status: 400 });
  }
  try {
    const { data, error } = await ctx.db.rpc("update_catalogue_item", {
      p_actor_id: ctx.actorId, p_kind: body.kind as "product" | "ticket", p_item_id: body.item_id as string,
      p_name: (body.name as string).trim(), p_price_cents: body.price_cents as number,
    });
    if (error) return NextResponse.json({ error: "Catalogue update failed. Confirm the item is active and the migration is applied." }, { status: 409 });
    return NextResponse.json({ item: data }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Catalogue service unavailable." }, { status: 503 }); }
}
