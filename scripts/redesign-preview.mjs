// Local preview of the redesign, for watching screens change and checking
// them against the design canvas. In-memory data and mock providers only:
// no database, no Mobile Money, no router, no email is ever contacted.
//
//   node scripts/redesign-preview.mjs
//
//   Portal (v2 by default)  http://localhost:8080   sign-in details are printed at start
//   Admin (v2)              http://localhost:8081   one-click sign-in from :8090
//   API                     http://localhost:8082
//   Design + comparisons    http://localhost:8090
//
// Both apps reload their files when customer-app-v2/, admin-app-v2/ or
// shared-app/ change; open tabs then offer "Refresh app". Ports can be moved
// with PREVIEW_PORTAL_PORT, PREVIEW_ADMIN_PORT, PREVIEW_API_PORT and
// PREVIEW_DESIGN_PORT. Cookies ignore ports, so :8090 can sign a browser in to
// the local apps.
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
import { publishInitialStoreCatalogue } from "../lib/initial-store-catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";
import { plans as PLANS } from "../lib/api/state.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const screensDir = join(root, "docs/redesign/screens");
const portalPort = Number(process.env.PREVIEW_PORTAL_PORT || 8080);
const adminPort = Number(process.env.PREVIEW_ADMIN_PORT || 8081);
const apiPort = Number(process.env.PREVIEW_API_PORT || 8082);
const designPort = Number(process.env.PREVIEW_DESIGN_PORT || 8090);
const portal = `http://localhost:${portalPort}`, admin = `http://localhost:${adminPort}`, api = `http://localhost:${apiPort}`, design = `http://localhost:${designPort}`;
const captures = "/tmp/ndahi-redesign-preview";
export const DEMO = { phone: "670000001", pin: "2468", name: "Amina Nfor", email: "amina@example.test" };

// Built screens and the canvas artboards they follow. Status says how far each has come.
const NOT_YET = "Navigation only — screen not rebuilt yet", SHELL = "Admin shell — screen not rebuilt yet";
export const SCREENS = [
  { id: "home", app: "portal", title: "Home", status: "Redesigned", phone: "PhoneHome", desktop: "Main", path: "/dashboard#home" },
  { id: "internet", app: "portal", title: "Internet", status: NOT_YET, phone: "PhoneInternet", desktop: "DesktopInternet", path: "/dashboard#internet" },
  { id: "shop", app: "portal", title: "Shop", status: "Navigation only — store panel until Phase 4", phone: "PhoneShop", desktop: "Shop", path: "/dashboard#shop" },
  { id: "activity", app: "portal", title: "Activity", status: NOT_YET, phone: "PhoneActivity", desktop: "DesktopActivity", path: "/dashboard#activity" },
  { id: "account", app: "portal", title: "Account", status: NOT_YET, phone: "PhoneAccount", desktop: "DesktopAccount", path: "/dashboard#account" },
  // Admin artboards are desktop (1280px) only.
  ...[
    ["admin-login", "Sign in", "AdminLogin", "/login", "Redesigned look; today's username + password or passkey stays until Phase 6 (no email + PIN two-step yet)"],
    ["admin-home", "Home", "Admin", "/dashboard#home", "Redesigned"],
    ["admin-devices", "Live devices", "AdminDevices", "/dashboard#devices", "Redesigned (no access point, signal or today's usage: the router doesn't report them)"],
    ["admin-connections", "Connections", "AdminConnections", "/dashboard#connections", "Redesigned (no uplink speed, per-network payment health or check times: none are recorded)"],
    ["admin-homerouters", "Home routers", "AdminHomeRouters", "/home-routers.html", "Redesigned (pilot evidence is a JSON report with an audit reason, not free notes)"],
    ["admin-setup", "Network setup", "AdminNetworkSetup", "/dashboard#network-setup", "Redesigned (four steps over the existing forms; status, enforcement and history stay below)"],
    ["admin-bundles", "Bundles", "AdminBundles", "/dashboard#bundles", "Redesigned (no Pause / Put on sale or drafts: the API has neither; sold this week shown as vouchers issued)"],
    ["admin-bundle-edit", "Edit bundle", "AdminBundleEdit", "/dashboard#bundles", "Redesigned", "a[href*=\"#bundle/\"]"],
    ["admin-vouchers", "Vouchers", "AdminVouchers", "/dashboard#vouchers", "Redesigned (no Batch column: vouchers carry no batch number)"],
    ["admin-voucher-print", "Print a voucher batch", "AdminVoucherPrint", "/dashboard#vouchers", "Redesigned — create a batch, then Print slips (58/80 mm thermal slips, not A6 sheets)"],
    ["admin-payments", "Payments", "AdminPayments", "/dashboard#payments", "Redesigned"],
    ["admin-store", "Store orders", "AdminStore", "/dashboard#store"],
    ["admin-products", "Products", "AdminProducts", "/dashboard#products"],
    ["admin-product-edit", "Edit product", "AdminProductEdit", "/dashboard#products"],
    ["admin-cash", "Cash & settlements", "AdminCash", "/dashboard#cash", "Redesigned (no provider settlements or period switch until the API records them)"],
    ["admin-customers", "Customers", "AdminCustomers", "/dashboard#customers", "Redesigned"],
    ["admin-customer-detail", "Customer detail", "AdminCustomerDetail", "/dashboard#customers", "Redesigned (no Remove lost passkeys: that arrives with Phase 6 sign-in)", "a.admin-name"],
    ["admin-resellers", "Resellers", "AdminResellers", "/dashboard#resellers", "Redesigned (commission is set per reseller, so there is no single split in the head)"],
    ["admin-audit", "Audit log", "AdminAudit", "/dashboard#audit", "Redesigned"],
    ["admin-profile", "Profile & security", "AdminProfile", "/dashboard#profile", "Redesigned (password, not PIN, until Phase 6; no name or email editing: the API has none; add staff instead of invitations)"],
  ].map(([id, title, desktop, path, status, open]) => ({ id, app: "admin", title, status: status || SHELL, desktop, path, ...(open ? { open } : {}) })),
];

// Local demo prices for the initial catalogue (the owner's launch prices).
const DEMO_PRICES = { "ND-TPLINK-AX1500": 100000, "ND-TPLINK-CPE210": 80000, "ND-WAVLINK-AC1200": 70000, "ND-WAVLINK-MINI": 60000 };

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const listen = (server, port) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

async function startApi() {
  setDefaultResultOrder("ipv4first");
  const store = createStore({ persistent: false }), adminSecret = randomUUID();
  const staff = { owner: randomUUID(), operator: randomUUID(), reseller: randomUUID() };
  const server = createServer({ store, email: new MockEmailAdapter(), env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    CUSTOMER_APP_URL: portal, SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    ADMIN_SESSION_SECRET: adminSecret, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
  } });
  await listen(server, apiPort);
  const post = async (path, input, cookie = "") => {
    const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return { response, body };
  };
  // Demo customer: a paid Weekly bundle with some data used, a verified email,
  // an older expired bundle, and a PIN for signing in.
  const purchase = await post("/api/purchase", { phone: DEMO.phone, name: DEMO.name, email: DEMO.email, planId: "weekly" });
  const paid = await post(`/api/payments/${purchase.body.payment.id}/confirm`, {});
  const setup = await post("/api/account/setup/pin", { phone: DEMO.phone, code: paid.body.access.code, pin: DEMO.pin, confirmPin: DEMO.pin });
  const cookie = setup.response.headers.get("set-cookie").split(";")[0];
  await publishInitialStoreCatalogue({ store });
  await store.transaction((s) => {
    const now = Date.now(), customer = s.customers.find((c) => c.phone.endsWith(DEMO.phone));
    customer.emailVerifiedAt = new Date(now).toISOString();
    const active = s.vouchers.find((v) => v.status === "active");
    if (active && Number.isFinite(active.quotaBytes)) active.usedBytes = Math.round(active.quotaBytes * 0.36);
    s.vouchers.push({ ...structuredClone(active), id: "preview-history", code: "NC-HIST-0001", status: "expired", paymentId: undefined,
      activatedAt: new Date(now - 12 * 864e5).toISOString(), expiresAt: new Date(now - 5 * 864e5).toISOString() });
    // Demo payments for the admin Payments and Cash screens: two waiting (one
    // over 10 minutes), gateway-confirmed sales this month, one failed today
    // and one expired yesterday. Gateway references are made up; no provider is called.
    const base = s.payments[0], plans = [...PLANS, ...s.bundles].filter((plan) => plan.price > 0);
    const demoPayment = (id, minutes, planIndex, phone, network, extra) => {
      const plan = plans[planIndex % (plans.length || 1)];
      const snapshot = plan ? { ...base.planSnapshot, id: plan.id, name: plan.name, price: plan.price } : base.planSnapshot;
      return { ...structuredClone(base), id, planId: snapshot.id, planSnapshot: snapshot, amount: snapshot.price, payerPhone: phone, network, provider: "mesomb",
        providerReference: `PREVIEW-${id.toUpperCase()}`, createdAt: new Date(now - minutes * 60000).toISOString(), confirmedAt: null, receipt: undefined, refund: undefined, ...extra };
    };
    const confirmed = (minutes) => ({ status: "paid", confirmedAt: new Date(now - (minutes - 1) * 60000).toISOString() });
    s.payments.push(
      demoPayment("wait-1", 4, 1, "237670121245", "mtn", { status: "pending" }),
      demoPayment("wait-2", 17, 0, "237690337731", "orange", { status: "pending" }),
      demoPayment("paid-1", 46, 2, "237670884019", "mtn", confirmed(46)),
      demoPayment("paid-2", 130, 1, "237650220366", "orange", confirmed(130)),
      demoPayment("failed-1", 190, 1, "237690550366", "orange", { status: "failed" }),
      demoPayment("expired-1", 26 * 60, 0, "237670772210", "mtn", { status: "expired" }),
      demoPayment("paid-3", 4 * 24 * 60, 2, "237670118802", "mtn", confirmed(4 * 24 * 60)),
    );
    for (const product of s.storeProducts) if (DEMO_PRICES[product.sku]) product.price = DEMO_PRICES[product.sku];
    s.storeSettings.open = true;
    // Demo staff with ready sessions (as the admin journeys do); the preview's
    // sign-in links hand these to the browser.
    const expiresAt = new Date(now + 30 * 864e5).toISOString();
    for (const [role, token] of Object.entries(staff)) {
      s.adminUsers.push({ id: `preview-${role}`, username: `demo-${role}`, name: `Demo ${role}`, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `preview-${role}`, tokenHash: hashSecret(token, adminSecret), role, csrfToken: randomUUID(), expiresAt });
    }
  });
  return { server, cookie, code: paid.body.access.code, staff };
}

// The static servers cache their files, so a change swaps in fresh ones.
function startApps() {
  const makers = {
    portal: () => createStaticServer("customer", { apiUrl: api, portalUrl: portal, supportEmail: "support@example.test", supportPhone: "+237 670 000 000", env: { UI_V2_PERCENT: "100" } }),
    admin: () => createStaticServer("admin", { apiUrl: api, portalUrl: portal }),
  };
  const current = { portal: makers.portal(), admin: makers.admin() };
  let timer;
  for (const folder of ["customer-app-v2", "admin-app-v2", "shared-app"]) {
    watch(join(root, folder), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { current.portal = makers.portal(); current.admin = makers.admin(); console.log(`[preview] ${new Date().toLocaleTimeString()} files changed; open tabs will offer Refresh app`); }, 300);
    });
  }
  return Promise.all([
    listen(http.createServer((req, res) => current.portal.emit("request", req, res)), portalPort),
    listen(http.createServer((req, res) => current.admin.emit("request", req, res)), adminPort),
  ]);
}

async function boards() {
  const canvas = JSON.parse(await readFile(join(screensDir, "canvas.json"), "utf8"));
  const rows = Object.values(canvas.notes || {}).filter((note) => note.kind === "title1").sort((a, b) => a.y - b.y);
  const groups = rows.map((row) => ({ title: row.text, items: [] }));
  for (const name of canvas.order) {
    const board = canvas.boards[name];
    let index = 0;
    rows.forEach((row, i) => { if (row.y <= board.y) index = i; });
    groups[index].items.push({ file: name, title: board.title || name, width: board.w, height: board.h, x: board.x });
  }
  groups.forEach((group) => group.items.sort((a, b) => a.x - b.x));
  return groups;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} — NDAHI redesign preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Playfair+Display:wght@600&display=swap">
<style>body{margin:0;background:#fbfaf5;color:#10241c;font:15px/1.5 'DM Sans',system-ui,sans-serif}a{color:#003b2b}header{background:#003b2b;color:#fff;padding:18px 24px}header a{color:#b9ee2e}h1,h2{font-family:'Playfair Display',serif;font-weight:600;margin:0}main{max-width:1280px;margin:0 auto;padding:24px}section{margin:0 0 32px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px}.card{background:#fffef9;border:1px solid #dfe5dc;border-radius:12px;padding:14px}.meta{color:#5c6963;font-size:13px}.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:#eef0ee;color:#3d4a44;font-size:12px;font-weight:700}.pill.done{background:#eaf6d5;color:#345000}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;margin-top:12px}.pair img{display:block;max-width:100%;border:1px solid #dfe5dc;border-radius:8px;background:#fff}.pair figure{margin:0}.pair figcaption{font-weight:700;margin-bottom:6px}button{min-height:44px;padding:0 16px;border:0;border-radius:10px;background:#b9ee2e;color:#15210c;font:700 15px 'DM Sans',sans-serif;cursor:pointer}code{background:#eef3e9;padding:1px 5px;border-radius:5px}</style>
</head><body><header><strong>NDAHI redesign preview</strong> · <a href="/">Screens</a> · <a href="/compare">Design vs build</a> · <a href="${portal}/dashboard">Open the portal</a></header><main>${body}</main></body></html>`;
}

async function indexPage(state) {
  const groups = await boards();
  const card = (s) => s.app === "admin"
    ? `<div class="card"><strong>${escape(s.title)}</strong> <span class="pill${s.status === "Redesigned" ? " done" : ""}">${escape(s.status)}</span>
    <p class="meta">Design: <a href="/design/${s.desktop}.dc.html">${escape(s.desktop)}</a><br>Build: <a href="${admin}${s.path}">${escape(admin + s.path)}</a></p></div>`
    : null;
  const built = SCREENS.filter((s) => s.app === "portal").map((s) => `<div class="card"><strong>${escape(s.title)}</strong> <span class="pill${s.status === "Redesigned" ? " done" : ""}">${escape(s.status)}</span>
    <p class="meta">Design: <a href="/design/${s.phone}.dc.html">phone</a> · <a href="/design/${s.desktop}.dc.html">desktop</a><br>Build: <a href="${portal}${s.path}">${escape(portal + s.path)}</a></p></div>`).join("");
  const design = groups.map((g) => `<section><h2>${escape(g.title)}</h2><div class="cards">${g.items.map((i) => `<div class="card"><a href="/design/${escape(i.file)}"><strong>${escape(i.title)}</strong></a><p class="meta">${escape(i.file)} · ${i.width} × ${i.height}</p></div>`).join("")}</div></section>`).join("");
  return page("Screens", `<section><h1>Customer portal — built so far</h1>
    <p>Sign in at <a href="${portal}/login">${portal}/login</a>: phone <code>${DEMO.phone}</code>, voucher code <code>${escape(state.code)}</code>, then PIN <code>${DEMO.pin}</code> (today's sign-in still asks for the code; the PIN-only sign-in is a later phase). In-memory demo data; payments use the mock provider (look for <em>Simulate payment approval</em>). Add <code>?ui=old</code> to any portal address to see v1, <code>?ui=new</code> to come back.</p>
    <p><a href="/sign-in/portal"><strong>Open the portal signed in as ${escape(DEMO.name)}</strong></a> (skips the sign-in form).</p>
    <div class="cards">${built}</div><p class="meta">Design kit reference: <a href="${portal}/ui-kit.html">${portal}/ui-kit.html</a></p></section>
    <section><h1>Admin — built so far</h1><p>Open the admin signed in as <a href="/sign-in/admin/owner"><strong>owner</strong></a>, <a href="/sign-in/admin/operator">operator</a> or <a href="/sign-in/admin/reseller">reseller</a> (demo staff; today's admin sign-in method stays until Phase 6).</p>
    <div class="cards">${SCREENS.filter((s) => s.app === "admin").map(card).join("")}</div></section>
    <section><h1>The design canvas</h1><p class="meta">Rendered locally from <code>docs/redesign/screens/</code>. Links between screens work as on the canvas; props go in the address, for example <a href="/design/PhoneOrder.dc.html?guest=true">PhoneOrder.dc.html?guest=true</a>.</p></section>${design}`);
}

async function comparePage() {
  const stamp = Date.now();
  const rows = SCREENS.map((s) => `<section><h2>${s.app === "admin" ? "Admin · " : ""}${escape(s.title)} <span class="pill${s.status === "Redesigned" ? " done" : ""}">${escape(s.status)}</span></h2>
    ${(s.app === "admin" ? [1280] : [390, 1280]).map((width) => `<div class="pair"><figure><figcaption>Design · ${width}px (${width < 768 ? s.phone : s.desktop})</figcaption><img loading="lazy" src="/captures/${s.id}-design-${width}.png?${stamp}" alt="Design ${escape(s.title)} at ${width}px"></figure><figure><figcaption>Build · ${width}px</figcaption><img loading="lazy" src="/captures/${s.id}-build-${width}.png?${stamp}" alt="Build ${escape(s.title)} at ${width}px"></figure></div>`).join("")}</section>`).join("");
  return page("Design vs build", `<section><h1>Design vs build</h1><p>Captures of each canvas artboard beside the running v2 portal (signed in as the demo customer). Phone captures are one 390 × 844 screen; desktop captures are the whole page.</p>
    <form method="post" action="/captures"><button>Capture again</button></form><p class="meta">Captures are saved in <code>${captures}</code>.</p></section>${rows}`);
}

export async function capture({ cookie, staff, only } = {}) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  await mkdir(captures, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const screen of SCREENS.filter((s) => !only || only.includes(s.id))) {
      for (const width of screen.app === "admin" ? [1280] : [390, 1280]) {
        const phone = width < 768, height = phone ? 844 : 900;
        const designPage = await browser.newPage({ viewport: { width, height } });
        await designPage.goto(`${design}/design/${phone ? screen.phone : screen.desktop}.dc.html`);
        await designPage.waitForSelector("html[data-dc-ready]");
        await designPage.evaluate(() => document.fonts.ready);
        await designPage.waitForTimeout(300);
        await designPage.screenshot({ path: `${captures}/${screen.id}-design-${width}.png`, fullPage: !phone });
        await designPage.close();
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addCookies([
          { name: "ndahi_ui", value: "v2", domain: "localhost", path: "/" },
          screen.app === "admin"
            ? { name: "admin_session", value: staff.owner, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }
            : { name: "customer_session", value: cookie.split("=")[1], domain: "localhost", path: "/api/account", httpOnly: true, sameSite: "Lax" },
        ]);
        const buildPage = await context.newPage();
        await buildPage.goto((screen.app === "admin" ? admin : portal) + screen.path);
        if (screen.app === "admin") await buildPage.waitForSelector("#adminSideMenu nav", { timeout: 15000 }).catch(() => {});
        // Screens reached from a list (for example a customer's detail page) open its first link.
        if (screen.open) await buildPage.locator(screen.open).first().click({ timeout: 15000 }).catch(() => {});
        else await buildPage.waitForSelector(`[data-portal-tab="${screen.id}"][aria-current="page"]`).catch(() => {});
        await buildPage.evaluate(() => document.fonts.ready);
        await buildPage.waitForTimeout(800);
        await buildPage.screenshot({ path: `${captures}/${screen.id}-build-${width}.png`, fullPage: !phone });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png" };
function startDesign(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, design);
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    try {
      if (url.pathname === "/") return send(200, TYPES[".html"], await indexPage(state));
      if (url.pathname === "/compare") return send(200, TYPES[".html"], await comparePage());
      if (url.pathname === "/captures" && req.method === "POST") {
        await capture({ cookie: state.cookie, staff: state.staff });
        res.writeHead(303, { location: "/compare" }); return res.end();
      }
      // One-click sign-in: hand the demo session to this browser (cookies ignore ports).
      const signIn = /^\/sign-in\/(portal|admin\/(owner|operator|reseller))$/.exec(url.pathname);
      if (signIn) {
        const cookies = ["ndahi_ui=v2; Path=/; SameSite=Lax; HttpOnly", signIn[2]
          ? `admin_session=${state.staff[signIn[2]]}; Path=/; SameSite=Lax; HttpOnly`
          : `${state.cookie}; Path=/api/account; SameSite=Lax; HttpOnly`];
        res.writeHead(303, { "set-cookie": cookies, location: signIn[2] ? `${admin}/dashboard` : `${portal}/dashboard` });
        return res.end();
      }
      if (url.pathname === "/design/support.js") return send(200, TYPES[".js"], await readFile(join(root, "scripts/redesign-preview-canvas.js")));
      const [, area, name] = /^\/(design|captures)\/([\w.-]+)$/.exec(url.pathname) || [];
      if (area && name && !name.includes("..")) {
        const file = area === "design" ? join(screensDir, name) : join(captures, name);
        if (normalize(file).startsWith(area === "design" ? screensDir : captures)) return send(200, TYPES[extname(name)] || "application/octet-stream", await readFile(file));
      }
      send(404, "text/plain", "Not found");
    } catch (error) {
      send(error.code === "ENOENT" ? 404 : 500, "text/plain", error.code === "ENOENT" ? "Not captured yet: use Capture again on the comparison page." : String(error.stack || error));
    }
  });
  return listen(server, designPort).then(() => server);
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const state = await startApi();
  await startApps();
  await startDesign(state);
  console.log(`[preview] Portal  ${portal}/login  (phone ${DEMO.phone}, voucher code ${state.code}, then PIN ${DEMO.pin}; v2 by default)`);
  console.log(`[preview] Admin   ${admin}  (sign in as demo staff from ${design})`);
  console.log(`[preview] Design  ${design}  (canvas screens, design vs build, one-click sign-in)`);
  console.log(`[preview] API     ${api}  (in-memory, mock providers)`);
  if (process.argv.includes("--capture")) {
    await capture({ cookie: state.cookie, staff: state.staff });
    console.log(`[preview] Captures written to ${captures}`);
  }
}
