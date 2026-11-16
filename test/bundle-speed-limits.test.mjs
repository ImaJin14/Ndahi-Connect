import test from "node:test";
import assert from "node:assert/strict";
import { createBundlesRoutes } from "../lib/api/bundles.mjs";
import { blank, plans } from "../lib/api/state.mjs";

const input = { name: "Test", price: 100, quotaGb: 1, validityHours: 24, deviceLimit: 1 };
const route = createBundlesRoutes({ clock: () => new Date("2026-11-16T00:00:00Z") });
async function call(state, path, body) {
  const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  await route({ method: "POST" }, res, new URL(path, "http://test"), { s: state, i: body });
  return res;
}

test("bundle speed limits survive legacy edits and can be cleared explicitly", async () => {
  const state = blank();
  let response = await call(state, "/api/admin/bundles", { ...input, downloadMbps: 12.5, uploadMbps: "2.125" });
  assert.equal(response.status, 201);
  const id = response.body.bundle.id;
  assert.equal(response.body.bundle.downloadMbps, 12.5);
  assert.equal(response.body.bundle.uploadMbps, 2.125);
  response = await call(state, "/api/admin/bundles/update", { ...input, bundleId: id });
  assert.equal(response.status, 200);
  assert.equal(response.body.bundle.downloadMbps, 12.5);
  assert.equal(response.body.bundle.uploadMbps, 2.125);
  response = await call(state, "/api/admin/bundles/update", { ...input, bundleId: id, downloadMbps: null, uploadMbps: "" });
  assert.equal(response.status, 200);
  assert.equal(response.body.bundle.downloadMbps, null);
  assert.equal(response.body.bundle.uploadMbps, null);
});

test("invalid speed settings never alter a custom bundle or its audit trail", async () => {
  const state = blank();
  const created = await call(state, "/api/admin/bundles", input);
  const id = created.body.bundle.id;
  for (const value of [0, -1, 10001, 0.0001, "1e3", " ", true, {}, Infinity]) {
    const before = structuredClone(state);
    const result = await call(state, "/api/admin/bundles/update", { ...input, bundleId: id, downloadMbps: value });
    assert.equal(result.status, 400, String(value));
    assert.deepEqual(state, before);
  }
});

test("built-in bundle speed settings persist in overrides and are preserved by older clients", async (t) => {
  const state = blank(), plan = plans.find((item) => item.id === "daily"), original = structuredClone(plan);
  t.after(() => { for (const key of Object.keys(plan)) delete plan[key]; Object.assign(plan, original); });
  let result = await call(state, "/api/admin/bundles/update", { ...input, bundleId: plan.id, downloadMbps: 15, uploadMbps: 3 });
  assert.equal(result.status, 200);
  assert.equal(state.bundleOverrides.daily.downloadMbps, 15);
  result = await call(state, "/api/admin/bundles/update", { ...input, bundleId: plan.id });
  assert.equal(result.status, 200);
  assert.equal(state.bundleOverrides.daily.downloadMbps, 15);
  assert.equal(state.bundleOverrides.daily.uploadMbps, 3);
});
