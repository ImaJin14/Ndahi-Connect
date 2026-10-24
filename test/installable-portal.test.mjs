import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
import { createStaticServer } from "../static-server.mjs";

async function portal(t) {
  const server = createStaticServer("customer", { apiUrl: "https://api.test", env: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the portal publishes an installable app manifest with real icons", async (t) => {
  const base = await portal(t), response = await fetch(base + "/manifest.webmanifest");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/manifest+json");
  const manifest = await response.json();
  assert.equal(manifest.name, "NDAHI Connect");
  assert.equal(manifest.start_url, "/dashboard");
  assert.equal(manifest.display, "standalone");
  for (const size of ["192x192", "512x512"]) assert.ok(manifest.icons.some((icon) => icon.sizes === size && icon.purpose === "any"), size);
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of [...manifest.icons, { src: "/assets/icons/apple-touch-icon.png", sizes: "180x180" }]) {
    const image = await fetch(base + icon.src);
    assert.equal(image.headers.get("content-type"), "image/png", icon.src);
    const bytes = Buffer.from(await image.arrayBuffer()), [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [width, height], icon.src);
  }
});

test("every customer page links the manifest, theme color and home-screen icon", async (t) => {
  const base = await portal(t), pages = (await readdir(new URL("../customer-app/", import.meta.url))).filter((file) => file.endsWith(".html"));
  assert.ok(pages.length >= 7);
  for (const file of pages) {
    const html = await readFile(new URL(`../customer-app/${file}`, import.meta.url), "utf8");
    for (const tag of ['rel="manifest"', 'name="theme-color"', 'rel="apple-touch-icon"']) assert.ok(html.includes(tag), `${file} ${tag}`);
  }
  const served = await (await fetch(base + "/login")).text(), href = served.match(/rel="manifest" href="([^"]+)"/)[1];
  assert.match(href, /^\/static\/manifest\.[0-9a-f]+\.webmanifest$/);
  assert.equal((await fetch(base + href)).status, 200);
});

test("the service worker shows an offline screen only when a page cannot load", async () => {
  const listeners = {}, source = await readFile(new URL("../customer-app/sw.js", import.meta.url), "utf8");
  let network = async () => new Response("live page");
  const self = { addEventListener: (type, listener) => { listeners[type] = listener; }, registration: {}, clients: {}, location: { origin: "https://portal.test" } };
  vm.runInNewContext(source, { self, Response, URL, fetch: (...args) => network(...args) });
  const load = async (mode) => {
    let response;
    listeners.fetch({ request: { mode }, respondWith: (value) => { response = value; } });
    return response && (await response);
  };
  assert.equal(await (await load("navigate")).text(), "live page");
  assert.equal(await load("cors"), undefined, "assets and API calls are not intercepted");
  network = async () => { throw new TypeError("Failed to fetch"); };
  const offline = await load("navigate");
  assert.equal(offline.status, 503);
  assert.equal(offline.headers.get("cache-control"), "no-store");
  assert.match(await offline.text(), /You're offline/);
});

test("navigation never populates or reads a cache, including private queries and non-OK responses", async () => {
  const listeners = {}, deleted = [], calls = [], origin = "https://portal.test";
  const self = { location: { origin }, addEventListener: (n, f) => { listeners[n] = f; },
    clients: { claim: async () => {} }, skipWaiting: async () => {} };
  const forbidden = () => { throw Error("private navigation touched Cache API"); };
  let network = async () => new Response("private", { status: 401 });
  vm.runInNewContext(await readFile(new URL("../customer-app/sw.js", import.meta.url), "utf8"), {
    self, Response, URL, Promise, fetch: (...a) => { calls.push(a); return network(...a); },
    caches: { keys: async () => ["ndahi-shell-v1", "ndahi-shell-v2", "another-app"], delete: async k => deleted.push(k), open: forbidden, match: forbidden },
  });
  let pending;
  listeners.activate({ waitUntil: p => { pending = p; } }); await pending;
  assert.deepEqual(deleted, ["ndahi-shell-v1", "ndahi-shell-v2"]);
  const request = { mode: "navigate", method: "GET", url: origin + "/verify.html?code=private&key=secret" };
  listeners.fetch({ request, respondWith: p => { pending = p; } });
  assert.equal((await pending).status, 401, "online authentication errors must reach the page");
  network = async () => { throw Error("offline"); };
  listeners.fetch({ request, respondWith: p => { pending = p; } });
  const offline = await pending, html = await offline.text();
  assert.equal(offline.status, 503); assert.doesNotMatch(html, /private|secret/);
  assert.match(html, /Try Dashboard again/); assert.match(html, /recover account/);
  assert.match(offline.headers.get("content-security-policy"), /default-src 'none'/);
  for (const request of [{ mode: "cors", method: "GET", url: origin + "/api/account/dashboard" },
    { mode: "navigate", method: "POST", url: origin + "/login" }, { mode: "navigate", method: "GET", url: "https://elsewhere.test" }])
    listeners.fetch({ request, respondWith: forbidden });
  assert.equal(calls.length, 2);
});
