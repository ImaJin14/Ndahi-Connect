// Shows the data-usage alerts pushed by the NDAHI API and opens the dashboard
// when one is tapped. Served from the site root so its scope covers the portal.
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
    const open = windows.find((client) => new URL(client.url).pathname === target.pathname);
    return open ? open.focus() : self.clients.openWindow(target.href);
  }));
});
