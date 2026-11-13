// Local preview of the redesign, for watching screens change and checking
// them against the design canvas. In-memory data and mock providers only:
// no database, no Mobile Money, no router, no email is ever contacted.
//
//   node scripts/redesign-preview.mjs
//
//   Portal (v2 by default)  http://localhost:8080   sign-in details are printed at start
//   API                     http://localhost:8082
//   Design + comparisons    http://localhost:8090
//
// The portal reloads its files when customer-app-v2/, admin-app-v2/ or
// shared-app/ change; open tabs then offer "Refresh app". Ports can be moved
// with PREVIEW_PORTAL_PORT, PREVIEW_API_PORT and PREVIEW_DESIGN_PORT.
import http from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
import { publishInitialStoreCatalogue } from "../lib/initial-store-catalogue.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const screensDir = join(root, "docs/redesign/screens");
const portalPort = Number(process.env.PREVIEW_PORTAL_PORT || 8080);
const apiPort = Number(process.env.PREVIEW_API_PORT || 8082);
const designPort = Number(process.env.PREVIEW_DESIGN_PORT || 8090);
const portal = `http://localhost:${portalPort}`, api = `http://localhost:${apiPort}`, design = `http://localhost:${designPort}`;
const captures = "/tmp/ndahi-redesign-preview";
export const DEMO = { phone: "670000001", pin: "2468", name: "Amina Nfor", email: "amina@example.test" };

// Built screens and the canvas artboards they follow. Status says how far each has come.
export const SCREENS = [
  { id: "home", title: "Home", status: "Redesigned", phone: "PhoneHome", desktop: "Main", path: "/dashboard#home" },
  { id: "internet", title: "Internet", status: "Navigation only — screen not rebuilt yet", phone: "PhoneInternet", desktop: "DesktopInternet", path: "/dashboard#internet" },
  { id: "shop", title: "Shop", status: "Navigation only — store panel until Phase 4", phone: "PhoneShop", desktop: "Shop", path: "/dashboard#shop" },
  { id: "activity", title: "Activity", status: "Navigation only — screen not rebuilt yet", phone: "PhoneActivity", desktop: "DesktopActivity", path: "/dashboard#activity" },
  { id: "account", title: "Account", status: "Navigation only — screen not rebuilt yet", phone: "PhoneAccount", desktop: "DesktopAccount", path: "/dashboard#account" },
];

// Local demo prices for the initial catalogue (the owner's launch prices).
const DEMO_PRICES = { "ND-TPLINK-AX1500": 100000, "ND-TPLINK-CPE210": 80000, "ND-WAVLINK-AC1200": 70000, "ND-WAVLINK-MINI": 60000 };

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const listen = (server, port) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

async function startApi() {
  setDefaultResultOrder("ipv4first");
  const store = createStore({ persistent: false });
  const server = createServer({ store, email: new MockEmailAdapter(), env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    CUSTOMER_APP_URL: portal, SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
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
    for (const product of s.storeProducts) if (DEMO_PRICES[product.sku]) product.price = DEMO_PRICES[product.sku];
    s.storeSettings.open = true;
  });
  return { server, cookie, code: paid.body.access.code };
}

// The portal's static server caches its files, so a change swaps in a fresh one.
function startPortal() {
  const make = () => createStaticServer("customer", { apiUrl: api, portalUrl: portal, supportEmail: "support@example.test", supportPhone: "+237 670 000 000", env: { UI_V2_PERCENT: "100" } });
  let current = make(), timer;
  const server = http.createServer((req, res) => current.emit("request", req, res));
  for (const folder of ["customer-app-v2", "admin-app-v2", "shared-app"]) {
    watch(join(root, folder), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { current = make(); console.log(`[preview] ${new Date().toLocaleTimeString()} files changed; open tabs will offer Refresh app`); }, 300);
    });
  }
  return listen(server, portalPort).then(() => server);
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
  const built = SCREENS.map((s) => `<div class="card"><strong>${escape(s.title)}</strong> <span class="pill${s.status === "Redesigned" ? " done" : ""}">${escape(s.status)}</span>
    <p class="meta">Design: <a href="/design/${s.phone}.dc.html">phone</a> · <a href="/design/${s.desktop}.dc.html">desktop</a><br>Build: <a href="${portal}${s.path}">${escape(portal + s.path)}</a></p></div>`).join("");
  const design = groups.map((g) => `<section><h2>${escape(g.title)}</h2><div class="cards">${g.items.map((i) => `<div class="card"><a href="/design/${escape(i.file)}"><strong>${escape(i.title)}</strong></a><p class="meta">${escape(i.file)} · ${i.width} × ${i.height}</p></div>`).join("")}</div></section>`).join("");
  return page("Screens", `<section><h1>Customer portal — built so far</h1>
    <p>Sign in at <a href="${portal}/login">${portal}/login</a>: phone <code>${DEMO.phone}</code>, voucher code <code>${escape(state.code)}</code>, then PIN <code>${DEMO.pin}</code> (today's sign-in still asks for the code; the PIN-only sign-in is a later phase). In-memory demo data; payments use the mock provider (look for <em>Simulate payment approval</em>). Add <code>?ui=old</code> to any portal address to see v1, <code>?ui=new</code> to come back.</p>
    <div class="cards">${built}</div><p class="meta">Design kit reference: <a href="${portal}/ui-kit.html">${portal}/ui-kit.html</a></p></section>
    <section><h1>The design canvas</h1><p class="meta">Rendered locally from <code>docs/redesign/screens/</code>. Links between screens work as on the canvas; props go in the address, for example <a href="/design/PhoneOrder.dc.html?guest=true">PhoneOrder.dc.html?guest=true</a>.</p></section>${design}`);
}

async function comparePage() {
  const stamp = Date.now();
  const rows = SCREENS.map((s) => `<section><h2>${escape(s.title)} <span class="pill${s.status === "Redesigned" ? " done" : ""}">${escape(s.status)}</span></h2>
    ${[390, 1280].map((width) => `<div class="pair"><figure><figcaption>Design · ${width}px (${width < 768 ? s.phone : s.desktop})</figcaption><img loading="lazy" src="/captures/${s.id}-design-${width}.png?${stamp}" alt="Design ${escape(s.title)} at ${width}px"></figure><figure><figcaption>Build · ${width}px</figcaption><img loading="lazy" src="/captures/${s.id}-build-${width}.png?${stamp}" alt="Build ${escape(s.title)} at ${width}px"></figure></div>`).join("")}</section>`).join("");
  return page("Design vs build", `<section><h1>Design vs build</h1><p>Captures of each canvas artboard beside the running v2 portal (signed in as the demo customer). Phone captures are one 390 × 844 screen; desktop captures are the whole page.</p>
    <form method="post" action="/captures"><button>Capture again</button></form><p class="meta">Captures are saved in <code>${captures}</code>.</p></section>${rows}`);
}

export async function capture({ cookie, only } = {}) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  await mkdir(captures, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const screen of SCREENS.filter((s) => !only || only.includes(s.id))) {
      for (const width of [390, 1280]) {
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
          { name: "customer_session", value: cookie.split("=")[1], domain: "localhost", path: "/api/account", httpOnly: true, sameSite: "Lax" },
        ]);
        const buildPage = await context.newPage();
        await buildPage.goto(portal + screen.path);
        await buildPage.waitForSelector(`[data-portal-tab="${screen.id}"][aria-current="page"]`).catch(() => {});
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
        await capture({ cookie: state.cookie });
        res.writeHead(303, { location: "/compare" }); return res.end();
      }
      if (url.pathname === "/design/support.js") return send(200, TYPES[".js"], await readFile(join(root, "scripts/redesign-preview-canvas.js")));
      const [, area, name] = /^\/(design|captures)\/([\w.-]+)$/.exec(url.pathname) || [];
      if (area && name && !name.includes("..")) {
        const file = area === "design" ? join(screensDir, name) : join(captures, name);
        if (normalize(file).startsWith(area === "design" ? screensDir : captures)) return send(200, TYPES[extname(name)] || "application/octet-stream", await readFile(file));
      }
      send(404, "text/plain", "Not found");
    } catch (error) {
      // The stack stays in the terminal running the preview, never in a response.
      if (error.code !== "ENOENT") console.error("[preview]", error);
      send(error.code === "ENOENT" ? 404 : 500, "text/plain", error.code === "ENOENT" ? "Not captured yet: use Capture again on the comparison page." : "Preview error. See the terminal running the preview.");
    }
  });
  return listen(server, designPort).then(() => server);
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const state = await startApi();
  await startPortal();
  await startDesign(state);
  console.log(`[preview] Portal  ${portal}/login  (phone ${DEMO.phone}, voucher code ${state.code}, then PIN ${DEMO.pin}; v2 by default)`);
  console.log(`[preview] Design  ${design}  (canvas screens, design vs build)`);
  console.log(`[preview] API     ${api}  (in-memory, mock providers)`);
  if (process.argv.includes("--capture")) {
    await capture({ cookie: state.cookie });
    console.log(`[preview] Captures written to ${captures}`);
  }
}
