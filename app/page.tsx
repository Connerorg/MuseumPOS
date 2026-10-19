"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Employee = { id: string; employee_number: string; display_name: string; role: string; active: boolean };
type TicketType = { id: string; code: string; name: string; description: string | null; base_price_cents: number; currency: string };
type Product = { id: string; sku: string; barcode: string | null; name: string; description: string | null; category_id: string | null; unit_price_cents: number; currency: string; track_inventory: boolean; stock_on_hand: number; reorder_level: number };
type Device = { id: string; device_code: string; display_name: string };
type CashSession = { id: string; device_id: string; opened_by: string; status: string; opening_float_cents: number; opened_at: string };
type Category = { id: string; code: string; name: string };
type CatalogItem = { id: string; kind: "ticket" | "product"; name: string; code: string; category: "Tickets" | "Merchandise"; price: number; detail: string; stock?: number; trackInventory?: boolean };
type Bootstrap = { employee: Employee; ticketTypes: TicketType[]; products: Product[]; devices: Device[]; openSessions: CashSession[]; categories: Category[]; priceRules: { id: string; ticket_type_id: string | null; product_id: string | null; unit_price_cents: number; valid_from: string }[]; pinUnlocked: boolean };
type CartLine = { item: CatalogItem; quantity: number };
type Notice = { kind: "success" | "error" | "info"; text: string };
type Report = { period: { from: string; to: string }; totals: { sales_count: number; gross_sales_cents: number; refunds_count: number; refunds_cents: number; net_after_refunds_cents: number }; sales: { id: string; receipt_number: string | null; status: string; total_cents: number; created_at: string }[]; refunds: { id: string; sale_id: string; amount_cents: number; status: string; created_at: string }[]; truncated: boolean };
type RefundRecord = { id: string; sale_id: string; requested_by: string; approved_by: string | null; amount_cents: number; reason: string; status: string; created_at: string };
type RefundData = { sales: { id: string; receipt_number: string | null; total_cents: number; status: string; created_at: string; cashier_id: string }[]; refunds: RefundRecord[]; canApprove: boolean };
type OfflineEntry = { id: string; created_at: string; device_id: string; cash_session_id: string; client_transaction_id: string; idempotency_key: string; payment_method: "cash"; source: "offline"; items: { kind: "ticket" | "product"; id: string; quantity: number; expected_unit_price_cents: number }[]; display_items: { name: string; quantity: number; unit_price_cents: number }[]; status: "queued" | "synced" | "conflict"; receipt_number?: string; error?: string };
const OFFLINE_DB_NAME = "museum-pos-offline";
function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("sales")) req.result.createObjectStore("sales", { keyPath: "id" });
      if (!req.result.objectStoreNames.contains("cache")) req.result.createObjectStore("cache", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function readOfflineEntries(): Promise<OfflineEntry[]> {
  const db = await openOfflineDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("sales", "readonly").objectStore("sales").getAll();
      req.onsuccess = () => resolve(req.result as OfflineEntry[]);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
async function saveOfflineEntry(entry: OfflineEntry): Promise<void> {
  const db = await openOfflineDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sales", "readwrite");
      tx.objectStore("sales").put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function saveCachedBootstrap(value: Bootstrap): Promise<void> {
  const db = await openOfflineDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cache", "readwrite");
      tx.objectStore("cache").put({ key: "bootstrap", value, saved_at: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function readCachedBootstrap(): Promise<Bootstrap | null> {
  const db = await openOfflineDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("cache", "readonly").objectStore("cache").get("bootstrap");
      req.onsuccess = () => resolve((req.result?.value as Bootstrap | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
const localDate = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

const money = (cents: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(cents / 100);
const uuid = () => crypto.randomUUID();

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request failed.");
  return body as T;
}

export default function Home() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [active, setActive] = useState("Checkout");
  const [category, setCategory] = useState("All items");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [session, setSession] = useState<CashSession | null>(null);
  const [openingFloat, setOpeningFloat] = useState("0");
  const [countedCash, setCountedCash] = useState("");
  const [barcode, setBarcode] = useState("");
  const [notice, setNotice] = useState<Notice>({ kind: "info", text: "Connecting to the configured POS backend…" });
  const [lastSale, setLastSale] = useState<{ receipt_number: string; total_cents: number; sale_id: string } | null>(null);
  const [lastTicket, setLastTicket] = useState<{ ticket_code: string; status: string; redeemed_at: string } | null>(null);
  const [inventoryProductId, setInventoryProductId] = useState("");
  const [inventoryDelta, setInventoryDelta] = useState("1");
  const [inventoryMovement, setInventoryMovement] = useState("restock");
  const [inventoryReason, setInventoryReason] = useState("");
  const [reportFrom, setReportFrom] = useState(localDate());
  const [reportTo, setReportTo] = useState(localDate());
  const [report, setReport] = useState<Report | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [refundData, setRefundData] = useState<RefundData | null>(null);
  const [refundSaleId, setRefundSaleId] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundDecisionReason, setRefundDecisionReason] = useState("");
  const [restockRefundedItems, setRestockRefundedItems] = useState(true);
  const [refundBusy, setRefundBusy] = useState(false);
  const [offlineEntries, setOfflineEntries] = useState<OfflineEntry[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [checkoutIds, setCheckoutIds] = useState<{ client_transaction_id: string; idempotency_key: string; fingerprint: string } | null>(null);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Bootstrap>("/api/pos/bootstrap");
      setBoot(data);
      setDeviceId((old) => old || data.devices[0]?.id || "");
      await saveCachedBootstrap(data).catch(() => undefined);
      if (data.pinUnlocked) {
        try { sessionStorage.setItem("museum-pos-pin-unlocked-at", String(Date.now())); } catch {}
      }
      setNotice({ kind: "success", text: "Connected to Supabase. Prices and stock below come from the current catalogue." });
    } catch (error) {
      try {
        const cached = await readCachedBootstrap();
        if (cached) {
          let recentUnlock = false;
          try {
            const unlockedAt = Number(sessionStorage.getItem("museum-pos-pin-unlocked-at") || "0");
            recentUnlock = unlockedAt > 0 && Date.now() - unlockedAt < 15 * 60 * 1000;
          } catch {}
          const offlineBoot = { ...cached, pinUnlocked: recentUnlock };
          setBoot(offlineBoot);
          setDeviceId((old) => old || cached.devices[0]?.id || "");
          setNotice({ kind: "info", text: "Offline mode: showing the last cached catalogue. Cash entries are local until reconciled; no card payments are available." });
          return;
        }
      } catch {}
      setBoot(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not connect to the POS backend." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    const updateOnline = () => setIsOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    void readOfflineEntries().then(setOfflineEntries).catch(() => setNotice({ kind: "error", text: "Offline queue storage is unavailable in this browser." }));
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const client = createSupabaseBrowserClient();
        const { data } = await client.auth.getSession();
        if (cancelled) return;
        if (data.session) await loadBootstrap();
        else {
          setLoading(false);
          setNotice({ kind: "info", text: "Sign in with your museum employee account to continue." });
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
          setNotice({ kind: "error", text: "Supabase public configuration is missing. Configure the Vercel environment variables and redeploy." });
        }
      }
    };
    void start();
    return () => { cancelled = true; };
  }, [loadBootstrap]);

  const loadRefunds = useCallback(async () => {
    try {
      const data = await api<RefundData>("/api/refunds");
      setRefundData(data);
    } catch (error) {
      setRefundData(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not load refund records." });
    }
  }, []);

  useEffect(() => {
    if (boot && active === "Refunds") void loadRefunds();
  }, [active, boot, loadRefunds]);

  useEffect(() => {
    if (!boot || !deviceId) { setSession(null); return; }
    const existing = boot.openSessions.find((s) => s.device_id === deviceId && s.opened_by === boot.employee.id);
    setSession(existing ?? null);
  }, [boot, deviceId]);

  const catalogue = useMemo<CatalogItem[]>(() => [
    ...((boot?.ticketTypes ?? []).map((t) => ({
      id: t.id, kind: "ticket" as const, name: t.name, code: t.code, category: "Tickets" as const,
      price: boot?.priceRules.find((rule) => rule.ticket_type_id === t.id)?.unit_price_cents ?? t.base_price_cents, detail: t.description || "Admission ticket",
    }))),
    ...((boot?.products ?? []).map((p) => ({
      id: p.id, kind: "product" as const, name: p.name, code: p.sku, category: "Merchandise" as const,
      price: boot?.priceRules.find((rule) => rule.product_id === p.id)?.unit_price_cents ?? p.unit_price_cents, detail: p.track_inventory ? `Stock: ${p.stock_on_hand}` : "Stock not tracked",
      stock: p.stock_on_hand, trackInventory: p.track_inventory,
    }))),
  ], [boot]);

  const filtered = catalogue.filter((p) =>
    (category === "All items" || p.category === category) &&
    (p.name.toLowerCase().includes(search.toLowerCase()) || p.code.toLowerCase().includes(search.toLowerCase()))
  );
  const total = cart.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const activeDevice = boot?.devices.find((d) => d.id === deviceId);
  const anotherOpenSession = boot?.openSessions.find((s) => s.device_id === deviceId && s.opened_by !== boot.employee.id);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      setNotice({ kind: "success", text: "Signed in. Load your employee profile and unlock your PIN to operate the till." });
      await loadBootstrap();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Sign-in failed." });
    } finally {
      setAuthBusy(false);
    }
  }

  async function unlockPin(event: FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    try {
      await api("/api/employee/pin", { method: "POST", body: JSON.stringify({ pin }) });
      try { sessionStorage.setItem("museum-pos-pin-unlocked-at", String(Date.now())); } catch {}
      setPin("");
      setNotice({ kind: "success", text: "Employee PIN verified. Sensitive operations are unlocked for 15 minutes." });
      await loadBootstrap();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "PIN verification failed." });
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    try {
      const client = createSupabaseBrowserClient();
      await client.auth.signOut();
    } finally {
      setBoot(null); setSession(null); setCart([]); setPin("");
      setNotice({ kind: "info", text: "Signed out." });
    }
  }

  function addItem(item: CatalogItem) {
    if (item.price <= 0) { setNotice({ kind: "error", text: "This item has no configured price and cannot be sold." }); return; }
    setCart((old) => {
      const line = old.find((l) => l.item.id === item.id && l.item.kind === item.kind);
      return line
        ? old.map((l) => l.item.id === item.id && l.item.kind === item.kind ? { ...l, quantity: l.quantity + 1 } : l)
        : [...old, { item, quantity: 1 }];
    });
  }

  function changeQty(id: string, delta: number) {
    setCart((old) => old.map((l) => l.item.id === id ? { ...l, quantity: l.quantity + delta } : l).filter((l) => l.quantity > 0));
  }

  async function openSession(event: FormEvent) {
    event.preventDefault();
    if (!deviceId) return;
    setAuthBusy(true);
    try {
      const amount = Math.round(Number(openingFloat) * 100);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Enter a valid opening float amount.");
      const result = await api<{ session: CashSession }>("/api/cash-sessions", {
        method: "POST", body: JSON.stringify({ action: "open", device_id: deviceId, amount_cents: amount }),
      });
      setSession(result.session);
      await loadBootstrap();
      setNotice({ kind: "success", text: "Cash session opened. Record the physical opening float accurately." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not open cash session." });
    } finally { setAuthBusy(false); }
  }

  async function queueOfflineSale(ids: { client_transaction_id: string; idempotency_key: string }) {
    if (!boot || !session || !cart.length) throw new Error("Open a cash session and add items before queueing an offline sale.");
    const entry: OfflineEntry = {
      id: ids.idempotency_key,
      created_at: new Date().toISOString(),
      device_id: deviceId,
      cash_session_id: session.id,
      client_transaction_id: ids.client_transaction_id,
      idempotency_key: ids.idempotency_key,
      payment_method: "cash",
      source: "offline",
      items: cart.map(({ item, quantity }) => ({ kind: item.kind, id: item.id, quantity, expected_unit_price_cents: item.price })),
      display_items: cart.map(({ item, quantity }) => ({ name: item.name, quantity, unit_price_cents: item.price })),
      status: "queued",
    };
    await saveOfflineEntry(entry);
    setOfflineEntries((old) => [entry, ...old.filter((x) => x.id !== entry.id)]);
    setCart([]);
    setCheckoutIds(null);
    setActive("Offline queue");
    setNotice({ kind: "info", text: "Cash entry saved locally. It is not yet in the official ledger; keep this till session open until it syncs." });
  }

  async function syncOfflineEntries() {
    if (!isOnline || !boot || !boot.pinUnlocked) {
      setNotice({ kind: "error", text: "Connect to the network and unlock your employee PIN before syncing." });
      return;
    }
    const pending = offlineEntries.filter((entry) => entry.status === "queued");
    if (!pending.length) {
      setNotice({ kind: "info", text: "There are no queued entries to sync. Conflicts require manager review." });
      return;
    }
    setSyncBusy(true);
    let synced = 0;
    try {
      for (const entry of pending) {
        try {
          const result = await api<{ sale: { receipt_number?: string; status?: string } }>("/api/offline/sync", {
            method: "POST",
            body: JSON.stringify({
              device_id: entry.device_id, cash_session_id: entry.cash_session_id,
              client_transaction_id: entry.client_transaction_id, idempotency_key: entry.idempotency_key,
              payment_method: "cash", source: "offline", items: entry.items,
            }),
          });
          const updated: OfflineEntry = { ...entry, status: "synced", receipt_number: result.sale.receipt_number };
          await saveOfflineEntry(updated);
          setOfflineEntries((old) => old.map((x) => x.id === entry.id ? updated : x));
          synced += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sync failed.";
          const updated: OfflineEntry = { ...entry, status: message.toLowerCase().includes("changed") || message.toLowerCase().includes("review") || message.toLowerCase().includes("insufficient") ? "conflict" : "queued", error: message };
          await saveOfflineEntry(updated);
          setOfflineEntries((old) => old.map((x) => x.id === entry.id ? updated : x));
        }
      }
      await loadBootstrap();
      setNotice({ kind: synced ? "success" : "error", text: `${synced} offline entry/entries synced. Any entries marked conflict need manager review; unsynced entries remain in the local queue.` });
    } finally { setSyncBusy(false); }
  }

  async function checkout() {
    if (!boot || !session || !deviceId || !cart.length) return;
    const fingerprint = JSON.stringify({ deviceId, sessionId: session.id, items: cart.map((line) => ({ kind: line.item.kind, id: line.item.id, quantity: line.quantity })) });
    const ids = checkoutIds?.fingerprint === fingerprint
      ? checkoutIds
      : { client_transaction_id: uuid(), idempotency_key: uuid(), fingerprint };
    if (checkoutIds?.fingerprint !== fingerprint) setCheckoutIds(ids);
    setAuthBusy(true); setLastSale(null);
    try {
      if (!navigator.onLine) {
        await queueOfflineSale(ids);
        return;
      }
      const result = await api<{ sale: { sale_id: string; receipt_number: string; total_cents: number; status: string } }>("/api/checkout/cash", {
        method: "POST",
        body: JSON.stringify({
          device_id: deviceId, cash_session_id: session.id,
          client_transaction_id: ids.client_transaction_id, idempotency_key: ids.idempotency_key,
          payment_method: "cash",
          items: cart.map((line) => ({ kind: line.item.kind, id: line.item.id, quantity: line.quantity })),
        }),
      });
      setLastSale(result.sale);
      setCart([]);
      setCheckoutIds(null);
      await loadBootstrap();
      setNotice({ kind: "success", text: `Sale completed: ${result.sale.receipt_number}. Cash payment was recorded in the database.` });
    } catch (error) {
      if (!navigator.onLine) {
        try { await queueOfflineSale(ids); }
        catch (queueError) { setNotice({ kind: "error", text: queueError instanceof Error ? queueError.message : "The result is uncertain and could not be queued. Keep the basket and retry with the same idempotency key when online." }); }
      } else {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "Checkout result could not be confirmed. Retry safely; the same idempotency key is retained." });
      }
    } finally { setAuthBusy(false); }
  }

  async function redeemTicket(event: FormEvent) {
    event.preventDefault();
    setAuthBusy(true); setLastTicket(null);
    try {
      const result = await api<{ ticket: { ticket_code: string; status: string; redeemed_at: string } }>("/api/tickets/redeem", {
        method: "POST", body: JSON.stringify({ barcode: barcode.trim() }),
      });
      setLastTicket(result.ticket); setBarcode("");
      setNotice({ kind: "success", text: `Ticket ${result.ticket.ticket_code} was redeemed successfully.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Ticket could not be redeemed." });
    } finally { setAuthBusy(false); }
  }

  async function requestRefund(event: FormEvent) {
    event.preventDefault();
    const sale = refundData?.sales.find((s) => s.id === refundSaleId);
    if (!sale) return;
    setRefundBusy(true);
    try {
      await api("/api/refunds", { method: "POST", body: JSON.stringify({ sale_id: sale.id, amount_cents: sale.total_cents, reason: refundReason }) });
      setRefundReason("");
      setNotice({ kind: "success", text: "Full-sale cash refund request saved. A manager must approve it before cash is returned." });
      await loadRefunds();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Refund request failed." });
    } finally { setRefundBusy(false); }
  }

  async function decideRefund(refundId: string, approve: boolean) {
    setRefundBusy(true);
    try {
      await api("/api/refunds/decision", { method: "PATCH", body: JSON.stringify({ refund_id: refundId, approve, decision_reason: refundDecisionReason }) });
      setRefundDecisionReason("");
      setNotice({ kind: "success", text: approve ? "Refund approved. A manager can now complete the cash return in an open till session." : "Refund request rejected and audited." });
      await loadRefunds();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Refund decision failed." });
    } finally { setRefundBusy(false); }
  }

  async function completeRefund(refundId: string) {
    if (!session) {
      setNotice({ kind: "error", text: "Open a cash session before completing a cash refund." });
      return;
    }
    if (!window.confirm("Confirm the full cash refund has been physically paid to the customer? This records the till cash outflow and voids valid tickets.")) return;
    setRefundBusy(true);
    try {
      await api("/api/refunds/complete", { method: "POST", body: JSON.stringify({ refund_id: refundId, cash_session_id: session.id, restock_returned_items: restockRefundedItems }) });
      setNotice({ kind: "success", text: "Cash refund completed and recorded. Returned stock handling and ticket invalidation were recorded." });
      await Promise.all([loadRefunds(), loadBootstrap()]);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Refund could not be completed." });
    } finally { setRefundBusy(false); }
  }

  async function loadReport(event: FormEvent) {
    event.preventDefault();
    setReportBusy(true);
    try {
      const result = await api<Report>(`/api/reports/summary?from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`);
      setReport(result);
      setNotice({ kind: "success", text: "Sales report loaded from the database." });
    } catch (error) {
      setReport(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not load sales report." });
    } finally { setReportBusy(false); }
  }

  async function adjustInventory(event: FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    try {
      const delta = Number(inventoryDelta);
      if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("Enter a non-zero whole-number stock change.");
      await api("/api/inventory/adjust", {
        method: "POST",
        body: JSON.stringify({ product_id: inventoryProductId, quantity_delta: delta, movement_type: inventoryMovement, reason: inventoryReason }),
      });
      setInventoryReason("");
      setNotice({ kind: "success", text: "Stock adjustment saved to the inventory ledger." });
      await loadBootstrap();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Inventory adjustment failed." });
    } finally { setAuthBusy(false); }
  }

  async function closeSession(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    if (offlineEntries.some((entry) => entry.cash_session_id === session.id && entry.status !== "synced")) {
      setNotice({ kind: "error", text: "This session has unsynced offline entries. Sync them or resolve conflicts before closing the till." });
      return;
    }
    setAuthBusy(true);
    try {
      const amount = Math.round(Number(countedCash) * 100);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Enter a valid counted cash amount.");
      const result = await api<{ session: { expected_cash_cents: number; counted_cash_cents: number; variance_cents: number } }>("/api/cash-sessions", {
        method: "POST", body: JSON.stringify({ action: "close", cash_session_id: session.id, amount_cents: amount }),
      });
      setSession(null); setCountedCash("");
      setNotice({ kind: "success", text: `Session closed. Expected ${money(result.session.expected_cash_cents)}, counted ${money(result.session.counted_cash_cents)}, variance ${money(result.session.variance_cents)}.` });
      await loadBootstrap();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not close cash session." });
    } finally { setAuthBusy(false); }
  }

  const nav = [
    { name: "Checkout", icon: "▦" }, { name: "Offline queue", icon: "↻" }, { name: "Tickets", icon: "▤" }, { name: "Refunds", icon: "↩" },
    { name: "Inventory", icon: "▣" }, { name: "Cash-up", icon: "◷" }, { name: "Reports", icon: "▥" },
  ];
  const headings: Record<string, string> = {
    Checkout: "Point of sale", "Offline queue": "Offline cash synchronization", Tickets: "Ticket admission", Refunds: "Refund requests", Inventory: "Inventory",
    "Cash-up": "Cash-up & reconciliation", Reports: "Sales reports",
  };

  if (!boot) return <div className="auth-shell">
    <div className="auth-card">
      <div className="brand auth-brand"><div className="brand-mark">M</div><div><strong>Museum POS</strong><small>Ticketing &amp; sales management</small></div></div>
      <h1>{loading ? "Connecting to the POS" : "Employee sign-in"}</h1>
      <p className="subtle">Sign in with your individual museum employee account. Your manager must provision your employee profile and PIN.</p>
      <div className={`notice notice-${notice.kind}`}>{notice.text}</div>
      {!loading && <form className="auth-form" onSubmit={signIn}>
        <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="primary-btn" disabled={authBusy}>{authBusy ? "Please wait…" : "Sign in"}</button>
      </form>}
      <div className="auth-divider" />
      <p className="helper">If you cannot sign in, confirm that Supabase Auth is configured and the employee has an active profile. Do not use a shared staff login.</p>
    </div>
  </div>;

  const pinUnlocked = boot.pinUnlocked;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">M</div><div><strong>Museum POS</strong><small>Ticketing &amp; sales</small></div></div>
      <div><div className="nav-label">Workspace</div><nav className="nav" aria-label="Main navigation">{nav.map((item) => <button key={item.name} className={active === item.name ? "active" : ""} onClick={() => setActive(item.name)}><span className="nav-icon">{item.icon}</span>{item.name}</button>)}</nav></div>
      <div className="side-bottom"><span className="online-dot" /> Supabase connected<br />{boot.employee.display_name} · {boot.employee.role}<br /><br /><button className="secondary-btn" onClick={signOut}>Sign out</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><div className="eyebrow">Museum operations / {active}</div><h1>{headings[active]}</h1></div><div className="top-actions"><div className="date-pill">{new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</div><div className="operator"><div className="avatar">{boot.employee.display_name.slice(0, 1).toUpperCase()}</div><div><strong style={{fontSize:12}}>{boot.employee.display_name}</strong><small>{boot.employee.role}</small></div></div></div></header>
      <div className={`notice notice-${notice.kind}`}>{notice.text}</div>
      {!pinUnlocked && <section className="panel unlock-panel"><div><h2>Unlock employee PIN</h2><p className="subtle">Enter your personal PIN to enable checkout, ticket redemption and cash-session operations.</p></div><form className="inline-form" onSubmit={unlockPin}><input aria-label="Employee PIN" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,8}" maxLength={8} placeholder="4–8 digit PIN" required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} /><button className="primary-btn" disabled={authBusy || pin.length < 4}>{authBusy ? "Checking…" : "Unlock"}</button></form></section>}
      <section className="metrics">
        <div className="metric"><span className="metric-symbol">↗</span><div className="metric-label">Cash session</div><div className="metric-value" style={{fontSize:19}}>{session ? "Open" : "Not open"}</div><div className="metric-foot">{activeDevice?.display_name ?? "No POS device selected"}</div></div>
        <div className="metric"><span className="metric-symbol">▤</span><div className="metric-label">Catalogue items</div><div className="metric-value">{catalogue.length}</div><div className="metric-foot">Loaded from Supabase</div></div>
        <div className="metric"><span className="metric-symbol">▣</span><div className="metric-label">Basket items</div><div className="metric-value">{itemCount}</div><div className="metric-foot">{money(total)} subtotal</div></div>
        <div className="metric"><span className="metric-symbol">✓</span><div className="metric-label">PIN status</div><div className="metric-value" style={{fontSize:19}}>{pinUnlocked ? "Unlocked" : "Locked"}</div><div className="metric-foot">Unlock window is server-enforced</div></div>
      </section>
      {active === "Checkout" && <div className="content-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>Sales catalogue</h2><div className="subtle" style={{marginTop:5}}>Database-priced admission and merchandise</div></div><span className="status">Live catalogue</span></div>
          <div className="catalog-tools"><input className="search" aria-label="Search catalogue" placeholder="Search name or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div className="category-row">{["All items", "Tickets", "Merchandise"].map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
          <div className="product-grid">{filtered.map((item) => <button className="product-card" key={item.kind + item.id} onClick={() => addItem(item)} disabled={item.price <= 0 || (item.kind === "product" && item.trackInventory && (item.stock ?? 0) < 1)}><div className="product-art">{item.category === "Tickets" ? "🎟️" : "🛍️"}</div><div className="product-name">{item.name}</div><div className="product-type">{item.detail}</div><div className="product-price">{item.price > 0 ? money(item.price) : "Price not set"}</div></button>)}</div>
          {catalogue.length === 0 && <div className="empty-state">No active catalogue items were returned by Supabase. Configure ticket types/products and prices before checkout.</div>}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Current basket</h2><div className="subtle" style={{marginTop:5}}>{itemCount} item(s)</div></div><button className="secondary-btn" onClick={() => setCart([])}>Clear</button></div>
          <div className="cart-body">{cart.length === 0 ? <div className="empty-cart">🧺<p>Your basket is empty</p><span>Choose an item from the live catalogue.</span></div> : cart.map(({ item, quantity }) => <div className="cart-item" key={item.id}><div><div className="cart-item-name">{item.name}</div><div className="cart-item-price">{money(item.price)} each</div></div><div className="qty-controls"><button aria-label={"Remove one " + item.name} onClick={() => changeQty(item.id, -1)}>−</button><span>{quantity}</span><button aria-label={"Add one " + item.name} onClick={() => changeQty(item.id, 1)}>+</button></div></div>)}</div>
          <div className="cart-summary"><div className="sum-row"><span>Subtotal</span><span>{money(total)}</span></div><div className="sum-row"><span>Tax</span><span>Unconfigured</span></div><div className="sum-row total"><span>Total before configured tax</span><span>{money(total)}</span></div>
            {!session ? <div className="notice notice-info">Open a cash session before completing sales.</div> : <div className="notice notice-info">Cash only. Card terminal processing is not configured.</div>}
            <button className="primary-btn" disabled={!pinUnlocked || !session || !cart.length || total <= 0 || authBusy} onClick={checkout}>{authBusy ? "Processing…" : (isOnline ? "Complete cash sale" : "Queue offline cash sale")}</button>
            {lastSale && <div className="sale-receipt"><strong>Sale completed</strong><div>Receipt: {lastSale.receipt_number}</div><div>Total: {money(lastSale.total_cents)}</div><small>Sale ID: {lastSale.sale_id}</small></div>}
            <div className="helper">Tax treatment remains unconfigured pending management/accounting confirmation. Do not use for real sales until this is confirmed.</div>
          </div>
        </section>
      </div>}
      {active === "Offline queue" && <section className="panel section-panel"><div className="panel-head"><div><h2>Offline cash queue</h2><p className="subtle">Entries are stored in this browser and become official sales only after server reconciliation.</p></div><button className="primary-btn" disabled={!isOnline || !boot.pinUnlocked || syncBusy || !offlineEntries.some((e) => e.status === "queued")} onClick={() => void syncOfflineEntries()}>{syncBusy ? "Syncing…" : "Sync queued entries"}</button></div><div className={`notice notice-${isOnline ? "info" : "error"}`}>{isOnline ? "Network available. PIN must be unlocked to sync." : "Offline. Only cash entries may be queued; do not close the related till session before synchronization."}</div><div className="stat-cards"><div className="stat-card"><span>Queued</span><strong>{offlineEntries.filter((e) => e.status === "queued").length}</strong></div><div className="stat-card"><span>Conflicts</span><strong>{offlineEntries.filter((e) => e.status === "conflict").length}</strong></div><div className="stat-card"><span>Synced</span><strong>{offlineEntries.filter((e) => e.status === "synced").length}</strong></div><div className="stat-card"><span>Local queued value</span><strong>{money(offlineEntries.filter((e) => e.status !== "synced").reduce((sum, e) => sum + e.display_items.reduce((s, item) => s + item.unit_price_cents * item.quantity, 0), 0))}</strong></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Local reference</th><th>Created</th><th>Items</th><th>Value</th><th>Status</th><th>Result</th></tr></thead><tbody>{offlineEntries.map((entry) => <tr key={entry.id}><td>{entry.id.slice(0,8).toUpperCase()}</td><td>{new Date(entry.created_at).toLocaleString("en-ZA")}</td><td>{entry.display_items.reduce((n, i) => n + i.quantity, 0)}</td><td>{money(entry.display_items.reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0))}</td><td><span className={entry.status === "synced" ? "status" : "status pending"}>{entry.status}</span></td><td>{entry.receipt_number ?? entry.error ?? "Waiting for sync"}</td></tr>)}</tbody></table>{offlineEntries.length === 0 && <div className="empty-state">No offline cash entries on this device.</div>}</div><div className="helper">The sync endpoint checks the cached price against the live catalogue, preserves idempotency, and refuses entries whose price, stock or session no longer matches. Conflicts require manager review; never delete a conflict to hide a till discrepancy.</div></section>}
      {active === "Tickets" && <section className="panel section-panel"><div className="panel-head"><div><h2>Validate admission ticket</h2><p className="subtle">Scan a barcode with a USB scanner or enter the ticket code.</p></div></div><form className="inline-form" onSubmit={redeemTicket}><input aria-label="Ticket barcode" placeholder="Scan barcode or ticket code" autoComplete="off" required minLength={8} maxLength={128} value={barcode} onChange={(e) => setBarcode(e.target.value)} /><button className="primary-btn" disabled={!pinUnlocked || authBusy}>{authBusy ? "Validating…" : "Validate and redeem"}</button></form>{lastTicket && <div className="sale-receipt"><strong>Admission accepted</strong><div>Ticket: {lastTicket.ticket_code}</div><div>Status: {lastTicket.status}</div><div>Redeemed: {new Date(lastTicket.redeemed_at).toLocaleString("en-ZA")}</div></div>}<div className="helper">Redemption is one-time only. An already redeemed or invalid ticket is rejected by the database.</div></section>}
      {active === "Refunds" && <section className="panel section-panel"><div className="panel-head"><div><h2>Full-sale cash refunds</h2><p className="subtle">Refund requests require independent manager approval. Card refunds are disabled until a payment-provider workflow exists.</p></div><button className="secondary-btn" onClick={() => void loadRefunds()}>Refresh</button></div><div className="notice notice-info">Current workflow supports full-sale cash refunds only. Completion requires an open cash session and a manager/administrator. Confirm the customer has physically received the cash before completing.</div><form className="session-form refund-request-form" onSubmit={requestRefund}><label>Sale to refund<select required value={refundSaleId} onChange={(e) => setRefundSaleId(e.target.value)}><option value="">Select a completed sale</option>{(refundData?.sales ?? []).map((s) => <option key={s.id} value={s.id}>{s.receipt_number ?? s.id.slice(0,8)} · {money(s.total_cents)} · {new Date(s.created_at).toLocaleString("en-ZA")}</option>)}</select></label>{refundSaleId && <div className="subtle">Refund amount: {money(refundData?.sales.find((s) => s.id === refundSaleId)?.total_cents ?? 0)} (full sale only)</div>}<label>Reason for refund<input required minLength={3} maxLength={500} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Reason supplied by customer" /></label><button className="primary-btn" disabled={!pinUnlocked || refundBusy || !refundSaleId}>Request refund approval</button></form><div className="inventory-adjust"><h3>Refund approval queue</h3><p className="subtle">The requesting employee cannot approve their own request.</p><label className="field-label">Decision reason<input value={refundDecisionReason} onChange={(e) => setRefundDecisionReason(e.target.value)} minLength={3} maxLength={500} placeholder="Reason for approving or rejecting" /></label><label className="restock-option"><input type="checkbox" checked={restockRefundedItems} onChange={(e) => setRestockRefundedItems(e.target.checked)} /> Restock returned merchandise items (confirm items are fit to return to stock)</label><div className="table-wrap"><table className="data-table"><thead><tr><th>Refund</th><th>Sale</th><th>Amount</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>{(refundData?.refunds ?? []).map((r) => <tr key={r.id}><td>{r.id.slice(0,8).toUpperCase()}</td><td>{r.sale_id.slice(0,8).toUpperCase()}</td><td>{money(r.amount_cents)}</td><td>{r.reason}</td><td>{r.status}</td><td>{r.status === "pending" && refundData?.canApprove ? <div className="row-actions"><button className="secondary-btn" disabled={refundBusy || refundDecisionReason.trim().length < 3} onClick={() => void decideRefund(r.id, false)}>Reject</button><button className="primary-btn" disabled={refundBusy || refundDecisionReason.trim().length < 3} onClick={() => void decideRefund(r.id, true)}>Approve</button></div> : r.status === "approved" && refundData?.canApprove ? <button className="primary-btn" disabled={refundBusy || !session} onClick={() => void completeRefund(r.id)}>Complete cash refund</button> : "—"}</td></tr>)}</tbody></table>{(refundData?.refunds.length ?? 0) === 0 && <div className="empty-state">No refund requests found.</div>}</div></div><div className="helper">Refund approval and completion are audited. Completing a refund updates the sale status, cash ledger and valid ticket statuses. Restock only items physically returned in resalable condition.</div></section>}
      {active === "Inventory" && <section className="panel section-panel"><div className="panel-head"><div><h2>Stock on hand</h2><p className="subtle">Current active product stock from Supabase.</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>SKU</th><th>Product</th><th>Price</th><th>Stock</th><th>Reorder level</th><th>Status</th></tr></thead><tbody>{(boot.products ?? []).map((p) => <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td>{money(p.unit_price_cents)}</td><td>{p.track_inventory ? p.stock_on_hand : "Not tracked"}</td><td>{p.track_inventory ? p.reorder_level : "—"}</td><td><span className={p.track_inventory && p.stock_on_hand <= p.reorder_level ? "status pending" : "status"}>{p.track_inventory && p.stock_on_hand <= p.reorder_level ? "Reorder" : "OK"}</span></td></tr>)}</tbody></table></div><div className="inventory-adjust"><h3>Record stock movement</h3><p className="subtle">Requires a supervisor, manager or administrator role and an unlocked PIN.</p><form className="session-form" onSubmit={adjustInventory}><label>Product<select required value={inventoryProductId} onChange={(e) => setInventoryProductId(e.target.value)}><option value="">Select tracked product</option>{boot.products.filter((p) => p.track_inventory).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label><label>Movement type<select value={inventoryMovement} onChange={(e) => setInventoryMovement(e.target.value)}><option value="restock">Restock</option><option value="adjustment">Stock correction</option><option value="return">Return to stock</option><option value="waste">Waste / damage</option><option value="opening_balance">Opening balance</option></select></label><label>Quantity change (+ in, − out)<input type="number" step="1" required value={inventoryDelta} onChange={(e) => setInventoryDelta(e.target.value)} /></label><label>Reason<input required minLength={3} maxLength={500} value={inventoryReason} onChange={(e) => setInventoryReason(e.target.value)} placeholder="e.g. supplier delivery reference" /></label><button className="primary-btn" disabled={!pinUnlocked || !inventoryProductId || authBusy}>Save stock movement</button></form></div><div className="helper">Completed sales reduce tracked stock in the same database transaction. All manual movements are recorded with a reason and audit entry.</div></section>}
      {active === "Cash-up" && <section className="panel section-panel"><div className="panel-head"><div><h2>Cash session</h2><p className="subtle">Open a till session or close and reconcile the physical cash count.</p></div></div><label className="field-label">POS device<select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Select device</option>{boot.devices.map((d) => <option key={d.id} value={d.id}>{d.display_name} ({d.device_code})</option>)}</select></label>{boot.devices.length === 0 && <div className="notice notice-error">No active POS devices are registered in Supabase. An administrator must register a device before sales.</div>}{anotherOpenSession && <div className="notice notice-error">This device has an open cash session owned by another employee. Select another device or ask the session owner/manager to close it.</div>}{session ? <form className="session-form" onSubmit={closeSession}><div className="stat-cards"><div className="stat-card"><span>Opening float</span><strong>{money(session.opening_float_cents)}</strong></div><div className="stat-card"><span>Opened</span><strong>{new Date(session.opened_at).toLocaleTimeString("en-ZA")}</strong></div></div><label>Counted cash at close (ZAR)<input type="number" min="0" step="0.01" required value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="0.00" /></label><button className="primary-btn" disabled={!pinUnlocked || authBusy}>{authBusy ? "Closing…" : "Close and reconcile session"}</button></form> : <form className="session-form" onSubmit={openSession}><label>Opening float (ZAR)<input type="number" min="0" step="0.01" required value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} /></label><button className="primary-btn" disabled={!pinUnlocked || authBusy || !deviceId || Boolean(anotherOpenSession)}>{authBusy ? "Opening…" : "Open cash session"}</button></form>}</section>}
      {active === "Reports" && <section className="panel section-panel"><div className="panel-head"><div><h2>Sales and refunds report</h2><p className="subtle">Restricted to supervisors, managers and administrators.</p></div></div><form className="report-filters" onSubmit={loadReport}><label>From<input type="date" required value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} /></label><label>To<input type="date" required min={reportFrom} value={reportTo} onChange={(e) => setReportTo(e.target.value)} /></label><button className="primary-btn" disabled={reportBusy}>{reportBusy ? "Loading…" : "Load report"}</button></form>{report && <><div className="stat-cards"><div className="stat-card"><span>Completed sales</span><strong>{report.totals.sales_count}</strong></div><div className="stat-card"><span>Gross sales</span><strong>{money(report.totals.gross_sales_cents)}</strong></div><div className="stat-card"><span>Completed refunds</span><strong>{money(report.totals.refunds_cents)}</strong></div><div className="stat-card"><span>Net after refunds</span><strong>{money(report.totals.net_after_refunds_cents)}</strong></div></div>{report.truncated && <div className="notice notice-info">This report is limited to the latest 1,000 sales or refunds in the selected period. Narrow the date range for a complete result.</div>}<h3 className="report-heading">Sales</h3><div className="table-wrap"><table className="data-table"><thead><tr><th>Receipt</th><th>Date</th><th>Status</th><th>Total</th></tr></thead><tbody>{report.sales.map((s) => <tr key={s.id}><td>{s.receipt_number ?? s.id.slice(0, 8)}</td><td>{new Date(s.created_at).toLocaleString("en-ZA")}</td><td>{s.status}</td><td>{money(s.total_cents)}</td></tr>)}</tbody></table>{report.sales.length === 0 && <div className="empty-state">No sales in this date range.</div>}</div><h3 className="report-heading">Refunds</h3><div className="table-wrap"><table className="data-table"><thead><tr><th>Reference</th><th>Date</th><th>Status</th><th>Amount</th></tr></thead><tbody>{report.refunds.map((r) => <tr key={r.id}><td>{r.id.slice(0, 8).toUpperCase()}</td><td>{new Date(r.created_at).toLocaleString("en-ZA")}</td><td>{r.status}</td><td>{money(r.amount_cents)}</td></tr>)}</tbody></table>{report.refunds.length === 0 && <div className="empty-state">No refunds in this date range.</div>}</div></>}</section>}
      <footer style={{padding:"22px 2px 0",fontSize:10,color:"#849088"}}>Museum POS · Supabase-backed development · Cash payments only · Tax rules pending confirmation</footer>
    </main>
  </div>;
}
