"use client";

import { useEffect, useMemo, useState } from "react";

type Product = { id: string; name: string; category: "Tickets" | "Merchandise"; price: number; icon: string; detail: string };
type CartLine = { product: Product; quantity: number };
type QueuedSale = { id: string; createdAt: string; total: number; items: { name: string; quantity: number; unitPrice: number }[]; status: "Pending sync" };

const products: Product[] = [
  { id: "adult", name: "Adult admission", category: "Tickets", price: 6000, icon: "🎟️", detail: "Single entry · draft price" },
  { id: "child", name: "Child admission", category: "Tickets", price: 4000, icon: "🎫", detail: "Single entry · draft price" },
  { id: "family", name: "Family admission", category: "Tickets", price: 0, icon: "👨‍👩‍👧", detail: "Price not configured" },
  { id: "guide", name: "Exhibition guide", category: "Merchandise", price: 8500, icon: "📗", detail: "Illustrative price" },
  { id: "postcard", name: "Museum postcard", category: "Merchandise", price: 1800, icon: "🖼️", detail: "Illustrative price" },
  { id: "tote", name: "Museum tote bag", category: "Merchandise", price: 12000, icon: "🛍️", detail: "Illustrative price" },
];
const money = (cents: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(cents / 100);

export default function Home() {
  const [active, setActive] = useState("Checkout");
  const [category, setCategory] = useState("All items");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [notice, setNotice] = useState("Preview mode only. No database is connected.");
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let live = true;
    const open = indexedDB.open("museum-pos-dev", 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("cash-queue")) open.result.createObjectStore("cash-queue", { keyPath: "id" });
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("cash-queue", "readonly");
      const req = tx.objectStore("cash-queue").getAll();
      req.onsuccess = () => { if (live) { setQueue(req.result as QueuedSale[]); setStorageReady(true); } db.close(); };
      req.onerror = () => { if (live) setNotice("Local queue could not be read. Do not use this preview for real sales."); db.close(); };
    };
    open.onerror = () => { if (live) setNotice("Browser storage is unavailable. Local queue disabled."); };
    return () => { live = false; };
  }, []);

  const filtered = useMemo(() => products.filter((p) => (category === "All items" || p.category === category) && p.name.toLowerCase().includes(search.toLowerCase())), [category, search]);
  const total = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const add = (product: Product) => {
    if (product.price <= 0) { setNotice("This catalogue item has no configured price and cannot be added."); return; }
    setCart((old) => {
      const found = old.find((line) => line.product.id === product.id);
      return found ? old.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...old, { product, quantity: 1 }];
    });
  };
  const changeQty = (id: string, delta: number) => setCart((old) => old.map((line) => line.product.id === id ? { ...line, quantity: line.quantity + delta } : line).filter((line) => line.quantity > 0));
  const queueCashSale = async () => {
    if (!storageReady || !cart.length || total <= 0) return;
    const sale: QueuedSale = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), total, items: cart.map(({ product, quantity }) => ({ name: product.name, quantity, unitPrice: product.price })), status: "Pending sync" };
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("museum-pos-dev", 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("cash-queue", "readwrite");
        tx.objectStore("cash-queue").add(sale);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      setQueue((old) => [sale, ...old]);
      setCart([]);
      setNotice("Added to this browser's local demo queue only. Not synced, not in the official ledger, and no valid ticket was issued.");
      setActive("Offline queue");
    } catch {
      setNotice("The entry was not queued because browser storage failed. No sale was completed.");
    }
  };

  const nav = [{ name: "Checkout", icon: "▦" }, { name: "Offline queue", icon: "↻" }, { name: "Tickets", icon: "▤" }, { name: "Inventory", icon: "▣" }, { name: "Cash-up", icon: "◷" }, { name: "Reports", icon: "▥" }];
  const headings: Record<string, string> = { Checkout: "Point of sale", "Offline queue": "Offline cash queue", Tickets: "Ticket management", Inventory: "Inventory", "Cash-up": "Cash-up & reconciliation", Reports: "Sales reports" };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">M</div><div><strong>Museum POS</strong><small>Ticketing &amp; sales</small></div></div>
      <div><div className="nav-label">Workspace</div><nav className="nav" aria-label="Main navigation">{nav.map((item) => <button key={item.name} className={active === item.name ? "active" : ""} onClick={() => setActive(item.name)}><span className="nav-icon">{item.icon}</span>{item.name}</button>)}</nav></div>
      <div className="side-bottom"><span className="online-dot" /> Local preview running<br />No live database connected<br /><br />Museum POS · Development build</div>
    </aside>
    <main className="main">
      <header className="topbar"><div><div className="eyebrow">Museum operations / {active}</div><h1>{headings[active]}</h1></div><div className="top-actions"><div className="date-pill">{new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</div><div className="operator"><div className="avatar">D</div><div><strong style={{fontSize:12}}>Demo operator</strong><small>Not authenticated</small></div></div></div></header>
      <div className="notice"><strong>Development mode:</strong> {notice} Real payments, valid ticket issuance and production database writes are disabled.</div>
      {active === "Checkout" && <>
        <section className="metrics">
          <div className="metric"><span className="metric-symbol">↗</span><div className="metric-label">Session sales</div><div className="metric-value">R 0.00</div><div className="metric-foot">Live ledger not connected</div></div>
          <div className="metric"><span className="metric-symbol">▤</span><div className="metric-label">Tickets issued</div><div className="metric-value">0</div><div className="metric-foot">No valid tickets issued</div></div>
          <div className="metric"><span className="metric-symbol">↻</span><div className="metric-label">Pending sync</div><div className="metric-value">{queue.length}</div><div className="metric-foot">Local browser queue only</div></div>
          <div className="metric"><span className="metric-symbol">◷</span><div className="metric-label">Cash session</div><div className="metric-value" style={{fontSize:19}}>Not open</div><div className="metric-foot">Cash-up not enabled</div></div>
        </section>
        <div className="content-grid">
          <section className="panel">
            <div className="panel-head"><div><h2>Sales catalogue</h2><div className="subtle" style={{marginTop:5}}>Select an item to add it to the basket</div></div><span className="status">Demo catalogue</span></div>
            <div className="catalog-tools"><input className="search" aria-label="Search catalogue" placeholder="Search tickets or merchandise…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <div className="category-row">{["All items", "Tickets", "Merchandise"].map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
            <div className="product-grid">{filtered.map((product) => <button className="product-card" key={product.id} onClick={() => add(product)}><div className="product-art">{product.icon}</div><div className="product-name">{product.name}</div><div className="product-type">{product.detail}</div><div className="product-price">{product.price > 0 ? money(product.price) : "Price not set"}</div></button>)}</div>
          </section>
          <section className="panel">
            <div className="panel-head"><div><h2>Current basket</h2><div className="subtle" style={{marginTop:5}}>{cart.reduce((n, line) => n + line.quantity, 0)} item(s)</div></div><button className="secondary-btn" onClick={() => setCart([])}>Clear</button></div>
            <div className="cart-body">{cart.length === 0 ? <div className="empty-cart">🧺<p>Your basket is empty</p><span>Choose an item from the catalogue.</span></div> : cart.map(({ product, quantity }) => <div className="cart-item" key={product.id}><div><div className="cart-item-name">{product.name}</div><div className="cart-item-price">{money(product.price)} each</div></div><div className="qty-controls"><button aria-label={"Remove one " + product.name} onClick={() => changeQty(product.id, -1)}>−</button><span>{quantity}</span><button aria-label={"Add one " + product.name} onClick={() => changeQty(product.id, 1)}>+</button></div></div>)}</div>
            <div className="cart-summary"><div className="sum-row"><span>Subtotal</span><span>{money(total)}</span></div><div className="sum-row"><span>Tax</span><span>Not configured</span></div><div className="sum-row total"><span>Displayed total*</span><span>{money(total)}</span></div><button className="primary-btn" disabled={!storageReady || cart.length === 0 || total <= 0} onClick={queueCashSale}>{storageReady ? "Queue demo cash sale" : "Preparing local storage…"}</button><div className="helper">*Illustrative prices only. Tax rules are pending management confirmation. This records a local demo queue entry, not a real sale. Card payment is unavailable.</div></div>
          </section>
        </div>
      </>}
      {active === "Offline queue" && <section className="panel section-panel"><h2>Locally queued cash entries</h2><p className="subtle">Stored in this browser only. Synchronization is not implemented yet.</p><div className="stat-cards"><div className="stat-card"><span>Pending entries</span><strong>{queue.length}</strong></div><div className="stat-card"><span>Local demo value</span><strong>{money(queue.reduce((sum, sale) => sum + sale.total, 0))}</strong></div><div className="stat-card"><span>Synced entries</span><strong>0</strong></div></div>{queue.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Local reference</th><th>Created</th><th>Items</th><th>Value</th><th>Status</th></tr></thead><tbody>{queue.map((sale) => <tr key={sale.id}><td>{sale.id.slice(0, 8).toUpperCase()}</td><td>{new Date(sale.createdAt).toLocaleString("en-ZA")}</td><td>{sale.items.reduce((n, i) => n + i.quantity, 0)}</td><td>{money(sale.total)}</td><td><span className="status pending">{sale.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state">No local demo entries yet. Add a basket in Checkout to test the browser queue.</div>}</section>}
      {active === "Tickets" && <section className="panel section-panel"><h2>Ticket management</h2><p className="subtle">Issuance and barcode redemption require a trusted database, which is not connected.</p><div className="stat-cards"><div className="stat-card"><span>Issued tickets</span><strong>0</strong></div><div className="stat-card"><span>Redeemed tickets</span><strong>0</strong></div><div className="stat-card"><span>Draft admission prices</span><strong>2</strong></div></div><div className="notice">Adult R60 and child R40 are draft catalogue values from the initial specification. Confirm before real sales. No barcode in this preview is a valid admission credential.</div></section>}
      {active === "Inventory" && <section className="panel section-panel"><h2>Inventory overview</h2><p className="subtle">This preview does not track real stock; the authoritative inventory ledger is not connected.</p><div className="table-wrap"><table className="data-table"><thead><tr><th>Item</th><th>Category</th><th>Displayed price</th><th>Stock status</th></tr></thead><tbody>{products.filter((p) => p.category === "Merchandise").map((p) => <tr key={p.id}><td>{p.icon} &nbsp;{p.name}</td><td>Merchandise</td><td>{money(p.price)}</td><td><span className="status pending">Not tracked</span></td></tr>)}</tbody></table></div></section>}
      {active === "Cash-up" && <section className="panel section-panel"><h2>Cash-up &amp; reconciliation</h2><p className="subtle">Cash sessions are not connected. Do not use this screen to reconcile real funds.</p><div className="stat-cards"><div className="stat-card"><span>Opening float</span><strong>—</strong></div><div className="stat-card"><span>Expected cash</span><strong>—</strong></div><div className="stat-card"><span>Variance</span><strong>—</strong></div></div><span className="status pending">Awaiting trusted cash-session operations</span></section>}
      {active === "Reports" && <section className="panel section-panel"><h2>Sales reports</h2><p className="subtle">Reports will use authoritative database records after transaction and permission testing.</p><div className="stat-cards"><div className="stat-card"><span>Recorded sales</span><strong>0</strong></div><div className="stat-card"><span>Refunds</span><strong>0</strong></div><div className="stat-card"><span>Gross revenue</span><strong>R 0.00</strong></div></div><span className="status">No live financial data connected</span></section>}
      <footer style={{padding:"22px 2px 0",fontSize:10,color:"#849088"}}>Museum POS · Local-first development · No live payment gateway · No production database connection</footer>
    </main>
  </div>;
}
