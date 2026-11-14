// Renewal moments (#252, redesign PhoneRenew): a reminder the day a bundle ends
// ("today"/"tomorrow" at its local time) and an ended notice that leads to
// buying it again, both under the customer's bundle-updates preference.
import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../server.mjs";
import { notificationItems } from "../lib/notifications.mjs";

const now = new Date("2026-11-14T10:00:00Z"); // 11:00 in Douala
const state = (voucher, prefs) => {
  const s = blank();
  s.customers.push({ id: "c1", phone: "670001245", name: "Amina" });
  s.vouchers.push({ id: "v1", customerId: "c1", planId: "weekly", status: "active", activatedAt: "2026-11-08T17:03:00Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 3, ...voucher });
  if (prefs) s.notificationStates.push({ id: "preferences:customer:c1", ...prefs });
  return s;
};
const items = (s) => notificationItems(s, { type: "customer", id: "c1" }, now);

test("a bundle ending within a day gets one reminder with its local time", () => {
  const tomorrow = items(state({ expiresAt: "2026-11-15T08:00:00Z" })).find((n) => n.id.startsWith("bundle-ending:"));
  assert.deepEqual([tomorrow.title, tomorrow.body, tomorrow.url, tomorrow.pushEligible], ["Weekly ends tomorrow at 09:00",
    "You'll be able to buy your next bundle in one tap once it ends.", "/dashboard#home", true]);
  const today = items(state({ expiresAt: "2026-11-14T19:30:00Z" })).find((n) => n.id.startsWith("bundle-ending:"));
  assert.equal(today.title, "Weekly ends today at 20:30");
  for (const expiresAt of ["2026-11-15T17:03:00Z", "2026-11-14T10:30:00Z"])
    assert.equal(items(state({ expiresAt })).some((n) => n.id.startsWith("bundle-ending:")), false, `${expiresAt}: not more than a day ahead, and the one-hour warning covers the last hour`);
  assert.equal(items(state({ expiresAt: "2026-11-15T08:00:00Z" }, { subscriptionUpdates: false })).some((n) => n.id.startsWith("bundle-ending:")), false, "the customer can turn bundle reminders off");
  assert.equal(items(state({ activatedAt: "2026-11-14T09:00:00Z", expiresAt: "2026-11-15T08:00:00Z" })).some((n) => n.id.startsWith("bundle-ending:")), false, "a daily bundle gets no reminder");
});

test("an ended bundle says so and leads to buying it again", () => {
  const ended = items(state({ status: "expired", expiresAt: "2026-11-14T09:00:00Z" })).find((n) => n.id === "bundle:v1");
  assert.deepEqual([ended.title, ended.body, ended.url], ["Your Weekly has ended", "Tap to buy it again in one step.", "/dashboard#home"]);
});
