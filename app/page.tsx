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
type Bootstrap = { employee: Employee; ticketTypes: TicketType[]; products: Product[]; devices: Device[]; openSessions: CashSession[]; categories: Category[]; pinUnlocked: boolean };
type CartLine = { item: CatalogItem; quantity: number };
type Notice = { kind: "success" | "error" | "info"; text: string };

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

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Bootstrap>("/api/pos/bootstrap");
      setBoot(data);
      setDeviceId((old) => old || data.devices[0]?.id || "");
      setNotice({ kind: "success", text: "Connected to Supabase. Prices and stock below come from the current catalogue." });
    } catch (error) {
      setBoot(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not connect to the POS backend." });
    } finally {
      setLoading(false);
    }
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

  useEffect(() => {
    if (!boot || !deviceId) { setSession(null); return; }
    const existing = boot.openSessions.find((s) => s.device_id === deviceId && s.opened_by === boot.employee.id);
    setSession(existing ?? null);
  }, [boot, deviceId]);

  const catalogue = useMemo<CatalogItem[]>(() => [
    ...((boot?.ticketTypes ?? []).map((t) => ({
      id: t.id, kind: "ticket" as const, name: t.name, code: t.code, category: "Tickets" as const,
      price: t.base_price_cents, detail: t.description || "Admission ticket",
    }))),
    ...((boot?.products ?? []).map((p) => ({
      id: p.id, kind: "product" as const, name: p.name, code: p.sku, category: "Merchandise" as const,
      price: p.unit_price_cents, detail: p.track_inventory ? `Stock: ${p.stock_on_hand}` : "Stock not tracked",
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

  async function checkout() {
    if (!boot || !session || !deviceId || !cart.length) return;
    setAuthBusy(true); setLastSale(null);
    try {
      const result = await api<{ sale: { sale_id: string; receipt_number: string; total_cents: number; status: string } }>("/api/checkout/cash", {
        method: "POST",
        body: JSON.stringify({
          device_id: deviceId, cash_session_id: session.id,
          client_transaction_id: uuid(), idempotency_key: uuid(),
          payment_method: "cash",
          items: cart.map((line) => ({ kind: line.item.kind, id: line.item.id, quantity: line.quantity })),
        }),
      });
      setLastSale(result.sale);
      setCart([]);
      await loadBootstrap();
      setNotice({ kind: "success", text: `Sale completed: ${result.sale.receipt_number}. Cash payment was recorded in the database.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Checkout result could not be confirmed. Check the sales ledger before retrying." });
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

  async function closeSession(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
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
    { name: "Checkout", icon: "▦" }, { name: "Tickets", icon: "▤" },
    { name: "Inventory", icon: "▣" }, { name: "Cash-up", icon: "◷" }, { name: "Reports", icon: "▥" },
  ];
  const headings: Record<string, string> = {
    Checkout: "Point of sale", Tickets: "Ticket admission", Inventory: "Inventory",
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
            <button className="primary-btn" disabled={!pinUnlocked || !session || !cart.length || total <= 0 || authBusy} onClick={checkout}>{authBusy ? "Processing…" : "Complete cash sale"}</button>
            {lastSale && <div className="sale-receipt"><strong>Sale completed</strong><div>Receipt: {lastSale.receipt_number}</div><div>Total: {money(lastSale.total_cents)}</div><small>Sale ID: {lastSale.sale_id}</small></div>}
            <div className="helper">Tax treatment remains unconfigured pending management/accounting confirmation. Do not use for real sales until this is confirmed.</div>
          </div>
        </section>
      </div>}
      {active === "Tickets" && <section className="panel section-panel"><div className="panel-head"><div><h2>Validate admission ticket</h2><p className="subtle">Scan a barcode with a USB scanner or enter the ticket code.</p></div></div><form className="inline-form" onSubmit={redeemTicket}><input aria-label="Ticket barcode" placeholder="Scan barcode or ticket code" autoComplete="off" required minLength={8} maxLength={128} value={barcode} onChange={(e) => setBarcode(e.target.value)} /><button className="primary-btn" disabled={!pinUnlocked || authBusy}>{authBusy ? "Validating…" : "Validate and redeem"}</button></form>{lastTicket && <div className="sale-receipt"><strong>Admission accepted</strong><div>Ticket: {lastTicket.ticket_code}</div><div>Status: {lastTicket.status}</div><div>Redeemed: {new Date(lastTicket.redeemed_at).toLocaleString("en-ZA")}</div></div>}<div className="helper">Redemption is one-time only. An already redeemed or invalid ticket is rejected by the database.</div></section>}
      {active === "Inventory" && <section className="panel section-panel"><div className="panel-head"><div><h2>Stock on hand</h2><p className="subtle">Current active product stock from Supabase.</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>SKU</th><th>Product</th><th>Price</th><th>Stock</th><th>Reorder level</th><th>Status</th></tr></thead><tbody>{(boot.products ?? []).map((p) => <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td>{money(p.unit_price_cents)}</td><td>{p.track_inventory ? p.stock_on_hand : "Not tracked"}</td><td>{p.track_inventory ? p.reorder_level : "—"}</td><td><span className={p.track_inventory && p.stock_on_hand <= p.reorder_level ? "status pending" : "status"}>{p.track_inventory && p.stock_on_hand <= p.reorder_level ? "Reorder" : "OK"}</span></td></tr>)}</tbody></table></div><div className="helper">Stock quantities update transactionally during completed checkout. Stock adjustment and restock management screens still need to be implemented.</div></section>}
      {active === "Cash-up" && <section className="panel section-panel"><div className="panel-head"><div><h2>Cash session</h2><p className="subtle">Open a till session or close and reconcile the physical cash count.</p></div></div><label className="field-label">POS device<select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Select device</option>{boot.devices.map((d) => <option key={d.id} value={d.id}>{d.display_name} ({d.device_code})</option>)}</select></label>{boot.devices.length === 0 && <div className="notice notice-error">No active POS devices are registered in Supabase. An administrator must register a device before sales.</div>}{anotherOpenSession && <div className="notice notice-error">This device has an open cash session owned by another employee. Select another device or ask the session owner/manager to close it.</div>}{session ? <form className="session-form" onSubmit={closeSession}><div className="stat-cards"><div className="stat-card"><span>Opening float</span><strong>{money(session.opening_float_cents)}</strong></div><div className="stat-card"><span>Opened</span><strong>{new Date(session.opened_at).toLocaleTimeString("en-ZA")}</strong></div></div><label>Counted cash at close (ZAR)<input type="number" min="0" step="0.01" required value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="0.00" /></label><button className="primary-btn" disabled={!pinUnlocked || authBusy}>{authBusy ? "Closing…" : "Close and reconcile session"}</button></form> : <form className="session-form" onSubmit={openSession}><label>Opening float (ZAR)<input type="number" min="0" step="0.01" required value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} /></label><button className="primary-btn" disabled={!pinUnlocked || authBusy || !deviceId || Boolean(anotherOpenSession)}>{authBusy ? "Opening…" : "Open cash session"}</button></form>}</section>}
      {active === "Reports" && <section className="panel section-panel"><div className="panel-head"><div><h2>Sales reporting</h2><p className="subtle">Financial reports will appear here after the reporting endpoints and date filters are connected.</p></div></div><div className="notice notice-info">The live catalogue, employee authentication, cash checkout, ticket redemption and cash session endpoints are connected in this interface. Aggregate reports, refunds, offline sync and stock adjustment workflows are still to be completed.</div></section>}
      <footer style={{padding:"22px 2px 0",fontSize:10,color:"#849088"}}>Museum POS · Supabase-backed development · Cash payments only · Tax rules pending confirmation</footer>
    </main>
  </div>;
}
