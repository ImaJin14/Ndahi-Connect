// Shows the data-usage alerts pushed by the NDAHI API and opens the dashboard
// when one is tapped. Served from the site root so its scope covers the portal.

// The installed app is opened like any other app, sometimes with no
// connection. A page load that cannot reach the network shows a short offline
// screen instead of the browser's error page. Nothing is cached, and pages
// that load normally are left untouched.
const CACHE_NAME = "ndahi-shell-v2";
const SHELL_ASSETS = [
  "/styles.css",
  "/package-grid.css",
  "/onboarding.html",
  "/onboarding.js",
  "/manifest.webmanifest",
  "/shared/safe-html.js",
  "/shared/pending.js",
  "/compat.js",
  "/errors.js",
  "/payment-timing.js",
  "/checkout-store.js",
  "/hotspot-path.js",
  "/network-status.js",
  "/updates.js",
  "/wifi-pairing.js",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
];

const offlinePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#003b2b"><title>NDAHI Connect</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaf5;color:#10241c;font:16px/1.5 system-ui,sans-serif}main{max-width:26rem;padding:2rem 1.25rem}h1{margin:0 0 .5rem;color:#003b2b;font-size:1.4rem}a{display:inline-block;margin-top:1rem;padding:.7rem 1.1rem;border-radius:8px;background:#b9ee2e;color:#15210c;font-weight:700;text-decoration:none}</style></head><body><main><h1>You're offline</h1><p>Connect to the internet or NDAHI Wi-Fi, then try again.</p><a href="/onboarding.html">Browse packages</a></main></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (!event.request || event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.ok && typeof caches !== "undefined" && event.request.url) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone)).catch(() => {});
      }
      return res;
    }).catch(async () => {
      if (typeof caches !== "undefined" && event.request.url) {
        const cached = await caches.match(event.request).catch(() => null);
        if (cached) return cached;
      }
      return new Response(offlinePage, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
      });
    })
  );
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
