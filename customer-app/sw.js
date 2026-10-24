// Network-only navigation: never store account pages, checkout URLs, private
// API replies or one-time credentials. The offline shell is public inline text.
const offlinePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#003b2b"><title>NDAHI Connect — offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaf5;color:#10241c;font:16px/1.5 system-ui,sans-serif}main{max-width:26rem;padding:2rem 1.25rem}h1{margin:0 0 .5rem;color:#003b2b;font-size:1.4rem}a{display:block;margin-top:1rem;padding:.7rem 1.1rem;border-radius:8px;background:#b9ee2e;color:#15210c;font-weight:700;text-decoration:none}</style></head><body><main><h1>You're offline</h1><p>Join NDAHI Wi-Fi or restore your internet connection, then try again. This screen cannot confirm a connection or a payment.</p><p>Your voucher and receipts remain in your account. Sign in again if this app uses a separate browser session.</p><a href="/dashboard">Try Dashboard again</a><a href="/onboarding.html">Browse packages when online</a><a href="/login?account=1">Sign in or recover account access</a><a href="/help">Help when online</a></main></body></html>`;

self.addEventListener("install", (event) => {
  // No shell dependencies: a partial/blocked pre-auth install still has a useful
  // fallback. This worker never reloads clients; page updates defer while busy.
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      // Retire only this application's obsolete caches, leaving others intact.
      await Promise.all(keys.filter((key) => key.startsWith("ndahi-shell-")).map((key) => caches.delete(key)));
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!request || request.mode !== "navigate" || (request.method && request.method !== "GET")) return;
  if (request.url && new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(() => new Response(offlinePage, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
  })));
});
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Fall back to the generic message. */ }
  event.waitUntil(self.registration.showNotification(data.title || "NDAHI Connect", {
    body: data.body || "Open NDAHI Connect to check your bundle.",
    tag: data.tag || "ndahi-usage",
    renotify: true,
    data: { url: data.url || "/dashboard" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => new URL(client.url).origin === target.origin && new URL(client.url).pathname === target.pathname);
    if (!open) return self.clients.openWindow(target.href);
    return Promise.resolve(open.url === target.href ? open : open.navigate(target.href)).then((client) => (client || open).focus());
  }));
});
