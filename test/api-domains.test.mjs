import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, createStore } from "../server.mjs";
import { createPublicRoutes } from "../lib/api/public.mjs";
import { createBundlesRoutes } from "../lib/api/bundles.mjs";
import { createReportingRoutes } from "../lib/api/reporting.mjs";
import { NOT_HANDLED } from "../lib/api/routing.mjs";
import { blank, plans } from "../lib/api/state.mjs";

function response() {
  return {
    headers: {},
    ends: 0,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers = {}) {
      assert.equal(this.headersSent, undefined, "response headers must only be sent once");
      this.status = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(text) {
      this.text = text;
      this.ends++;
    },
  };
}
const request = (path, origin) => ({
  method: "GET",
  url: path,
  socket: { remoteAddress: "127.0.0.1" },
  headers: { host: "api.test", ...(origin ? { origin } : {}) },
});
const url = (path) => new URL(path, "http://api.test");
const handler = (store, customerOrigin = "https://customer.test") =>
  createHandler({
    store,
    validateConfig: false,
    env: { NODE_ENV: "test", PAYMENT_MODE: "mock", CUSTOMER_APP_URL: customerOrigin },
  });

test("unmatched domain routes return the sentinel without reading state or sending a response", async () => {
  const res = response();
  for (const factory of [createPublicRoutes, createBundlesRoutes, createReportingRoutes]) {
    const route = factory({});
    assert.equal(
      await route(request("/api/unmatched"), res, url("/api/unmatched"), {}),
      NOT_HANDLED,
    );
  }
  assert.equal(res.ends, 0);
  assert.equal(res.headersSent, undefined);
});

test("public catalogue handler runs independently of HTTP server and adapters", async () => {
  const state = blank();
  state.bundles.push({ id: "custom-plan", name: "Custom", price: 250 });
  const route = createPublicRoutes({ mutate: (fn) => fn(state), paymentProviders: ["mock"] });
  const res = response();
  assert.equal(await route(request("/api/plans"), res, url("/api/plans")), undefined);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.text);
  assert.equal(payload.plans.length, plans.length + 1);
  assert.equal(payload.plans.at(-1).id, "custom-plan");
  assert.equal(payload.paymentProvider, "mock");
  assert.equal(res.ends, 1);
});

test("bundle validation is testable directly and rejects invalid data without mutating state", async () => {
  const state = blank(),
    before = structuredClone(state),
    res = response();
  const route = createBundlesRoutes({ clock: () => new Date("2026-09-27T12:00:00Z") });
  await route({ method: "POST" }, res, url("/api/admin/bundles"), {
    s: state,
    i: { name: "Invalid", price: -1 },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(state, before);
});

test("composition stops after a handled response and produces one 404 for unmatched public routes", async () => {
  const api = handler(createStore({ persistent: false }));
  for (const [path, expected] of [
    ["/api/plans", 200],
    ["/api/unmatched", 404],
  ]) {
    const res = response();
    await api(request(path), res);
    assert.equal(res.status, expected);
    assert.equal(res.ends, 1);
  }
});

test("origin and administrator authorization gates run before domain operations", async () => {
  let reads = 0;
  const store = createStore({ persistent: false });
  const api = handler({
    ...store,
    snapshot() {
      reads++;
      return store.snapshot();
    },
    transaction(fn) {
      reads++;
      return store.transaction(fn);
    },
  });
  const rejected = response();
  await api(request("/api/admin/export", "https://untrusted.test"), rejected);
  assert.equal(rejected.status, 403);
  assert.equal(reads, 0);
  const unauthenticated = response();
  await api(request("/api/admin/export"), unauthenticated);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.ends, 1);
  assert.equal(unauthenticated.headers["content-type"], "application/json; charset=utf-8");
});

test("composed API instances isolate their state and trusted origins", async () => {
  const firstStore = createStore({ persistent: false }),
    secondStore = createStore({ persistent: false });
  await firstStore.transaction((state) => state.bundles.push({ id: "first-only", name: "First" }));
  const first = handler(firstStore, "https://first.test"),
    second = handler(secondStore, "https://second.test");
  const firstResponse = response(),
    secondResponse = response(),
    crossOrigin = response();
  await first(request("/api/plans", "https://first.test"), firstResponse);
  await second(request("/api/plans", "https://second.test"), secondResponse);
  await second(request("/api/plans", "https://first.test"), crossOrigin);
  assert.ok(JSON.parse(firstResponse.text).plans.some((plan) => plan.id === "first-only"));
  assert.ok(!JSON.parse(secondResponse.text).plans.some((plan) => plan.id === "first-only"));
  assert.equal(crossOrigin.status, 403);
});
