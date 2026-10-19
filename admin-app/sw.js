// Operational records and API replies are never stored for offline use.
const offline = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NDAHI Admin</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f8f3;color:#12231c;font:16px/1.6 system-ui,sans-serif}main{max-width:28rem;padding:2rem}h1{color:#003b2b}a{display:inline-block;padding:.7rem 1rem;background:#b9ee2e;border-radius:8px;color:#12231c}</style></head><body><main><h1>You're offline</h1><p>Connect to the internet to view current devices and manage your network.</p><a href="/dashboard?retry=__RETRY__">Try again</a></main></body></html>`;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(offline.replace("__RETRY__", String(Date.now())), { status: 503, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  } })));
});
