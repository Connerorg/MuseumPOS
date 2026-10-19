import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasActivePinUnlock } from "@/lib/supabase/require-pin-unlock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckoutItem = {
  kind: "product" | "ticket";
  id: string;
  quantity: number;
};

type CashCheckoutRequest = {
  device_id: string;
  cash_session_id: string;
  client_transaction_id: string;
  idempotency_key: string;
  payment_method: "cash";
  payment_reference?: string;
  items: CheckoutItem[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: CashCheckoutRequest;
  try {
    body = (await request.json()) as CashCheckoutRequest;
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  if (
    !body ||
    !uuidPattern.test(body.device_id ?? "") ||
    !uuidPattern.test(body.cash_session_id ?? "") ||
    !uuidPattern.test(body.client_transaction_id ?? "") ||
    typeof body.idempotency_key !== "string" ||
    body.idempotency_key.trim().length < 8 ||
    body.idempotency_key.trim().length > 200 ||
    body.payment_method !== "cash" ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 100
  ) {
    return badRequest("Checkout request is missing required fields or contains invalid values.");
  }

  for (const item of body.items) {
    if (
      !item ||
      (item.kind !== "product" && item.kind !== "ticket") ||
      !uuidPattern.test(item.id ?? "") ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 1000
    ) {
      return badRequest("One or more checkout items are invalid.");
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return badRequest("Checkout is not configured on the server.", 503);
  }

  const cookieStore = await cookies();
  const userClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try {
          values.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components may not permit cookie writes; the route still verifies the user.
        }
      },
    },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return badRequest("Sign in with an employee account before checkout.", 401);
  }
  if (!(await hasActivePinUnlock(userData.user.id))) return badRequest("Unlock the employee PIN before checkout.", 423);

  try {
    const serviceClient = createServiceSupabase();
    const { data, error } = await serviceClient.rpc("complete_cash_sale", {
      p_cashier_id: userData.user.id,
      p_request: {
        ...body,
        idempotency_key: body.idempotency_key.trim(),
        payment_method: "cash",
      },
    });

    if (error) {
      const message = error.message ?? "";
      if (message.includes("insufficient_stock")) return badRequest("Not enough stock is available.", 409);
      if (message.includes("open_cash_session_required")) return badRequest("Open a cash session for this device first.", 409);
      if (message.includes("only_cash_checkout_is_enabled")) return badRequest("Only cash checkout is currently enabled.", 409);
      if (message.includes("active_employee_required")) return badRequest("This employee account is inactive or not provisioned.", 403);
      if (message.includes("idempotency_key_already_used")) return badRequest("This checkout key was already used by another employee.", 409);
      if (message.includes("product_not_available") || message.includes("ticket_type_not_available")) {
        return badRequest("An item in this sale is no longer available.", 409);
      }
      if (message.includes("active_pos_device_required")) return badRequest("This POS device is inactive or not registered.", 409);
      return badRequest("The sale could not be completed. No sale should be assumed until the result is confirmed.", 500);
    }

    return NextResponse.json({ sale: data }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return badRequest("Checkout service is not available.", 503);
  }
}
