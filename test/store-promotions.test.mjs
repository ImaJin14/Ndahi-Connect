import test from "node:test";
import assert from "node:assert/strict";
import { activeStorePromotion, promotionStatus, numberAlreadyUsed, promotionInput } from "../lib/store-promotions.mjs";

const offer = () => ({
  id: "test-offer", enabled: true,
  name: { en: "Test offer", fr: "Offre test" },
  productIds: ["router-1", "router-2"], salePrice: 100000,
  startsAt: "2026-11-26T23:00:00Z", endsAt: "2026-11-30T23:00:00Z",
  terms: { en: "Terms", fr: "Conditions" },
  bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation" },
});
const at = (time, p = [offer()], id = "router-1") => activeStorePromotion(p, id, new Date(time));

test("selects only explicit products within the inclusive start and exclusive end", () => {
  assert.equal(at("2026-11-26T22:59:59.999Z"), null);
  assert.equal(at("2026-11-26T23:00:00Z").salePrice, 100000);
  assert.equal(at("2026-11-30T22:59:59.999Z").bonus.validityHours, 1080);
  assert.equal(at("2026-11-30T23:00:00Z"), null);
  assert.equal(at("2026-11-27T12:00:00Z", [offer()], "router-2").id, "test-offer");
  assert.equal(at("2026-11-27T12:00:00Z", [offer()], "other-AX1500"), null);
});

test("requires an explicitly enabled offer with valid UTC boundaries and bilingual terms", () => {
  const invalid = [
    { startsAt: "2026-11-27T00:00:00+01:00" },
    { startsAt: "2026-02-30T00:00:00Z" }, { endsAt: "2026-11-20T00:00:00Z" },
    { salePrice: 0 }, { salePrice: 100000.5 }, { terms: { en: "Terms", fr: "" } },
    { productIds: ["router-1", "router-1"] }, { productIds: [] },
    { productIds: null }, { productIds: "router-1" }, { productIds: ["", "router-1"] },
    { bonus: { planId: "unlimited", validityHours: 1080, startsAt: "redemption" } },
    { bonus: { planId: "unlimited", validityHours: 0, startsAt: "payment_confirmation" } },
    { bonus: { planId: "", validityHours: 1080, startsAt: "payment_confirmation" } },
    { perNumberLimit: 0 }, { perNumberLimit: 11 }, { endedEarlyAt: "yesterday" },
  ];
  for (const change of invalid) assert.throws(() => at("2026-11-27T12:00:00Z", [{ ...offer(), ...change }]));
  assert.equal(at("2026-11-27T12:00:00Z", [{ ...offer(), enabled: false }]), null);
  assert.throws(() => activeStorePromotion([offer()], "router-1", new Date("bad")));
  assert.equal(activeStorePromotion(null, "router-1", new Date()), null);
  assert.throws(() => activeStorePromotion({}, "router-1", new Date()));
  assert.throws(() => activeStorePromotion([{}], "router-1", new Date()));
  assert.throws(() => activeStorePromotion([], "", new Date()));
});

test("overlapping or malformed enabled promotions fail closed", () => {
  const now = "2026-11-27T12:00:00Z";
  assert.throws(() => at(now, [offer(), { ...offer(), id: "another" }]), /Overlapping/);
  assert.throws(() => at(now, [offer(), { ...offer(), id: "bad", salePrice: -1 }]), /Invalid/);
  assert.throws(() => at(now, [offer(), { ...offer(), id: "bad", productIds: null }]), /Invalid/);
  assert.throws(() => at(now, [offer(), { ...offer(), id: "other", productIds: ["other"], salePrice: -1 }]), /Invalid/);
  assert.throws(() => at(now, [offer(), { ...offer(), productIds: ["other"] }]), /Duplicate/);
  assert.equal(at(now, [offer(), { ...offer(), id: "disabled", enabled: false }]).id, "test-offer");
  assert.equal(at(now, [offer(), { ...offer(), id: "other", productIds: ["other"] }]).id, "test-offer");
});

test("returned order snapshot remains unchanged when its configuration is edited", () => {
  const configured = offer();
  const snapshot = at("2026-11-27T12:00:00Z", [configured]);
  configured.productIds[0] = "changed";
  configured.salePrice = 999;
  configured.name.en = "Changed";
  configured.terms.en = "Changed";
  configured.bonus.validityHours = 24;
  assert.equal(snapshot.productIds[0], "router-1");
  assert.equal(snapshot.salePrice, 100000);
  assert.equal(snapshot.name.en, "Test offer");
  assert.equal(snapshot.terms.en, "Terms");
  assert.equal(snapshot.bonus.validityHours, 1080);
});

// Added on takeover (20 Nov): End early, the per-number limit, a promotion
// without a free bundle, and the admin validation.
test("ending early stops the offer from that moment, and the list shows it ended", () => {
  const ended = { ...offer(), endedEarlyAt: "2026-11-28T10:00:00.000Z" };
  assert.equal(at("2026-11-28T09:59:59.999Z", [ended]).salePrice, 100000);
  assert.equal(at("2026-11-28T10:00:00.000Z", [ended]), null);
  assert.equal(promotionStatus(ended, new Date("2026-11-28T10:00:00Z")), "ended");
  assert.equal(promotionStatus(offer(), new Date("2026-11-26T22:00:00Z")), "scheduled");
  assert.equal(promotionStatus(offer(), new Date("2026-11-27T12:00:00Z")), "live");
  assert.equal(promotionStatus({ ...offer(), enabled: false }, new Date("2026-11-27T12:00:00Z")), "draft");
  assert.equal(at("2026-11-27T12:00:00Z", [{ ...offer(), bonus: null }]).bonus, null, "an offer may have no free bundle");
  assert.equal(at("2026-11-27T12:00:00Z").perNumberLimit, 1, "one per number unless set");
});

test("one per phone number: the paying number, the contact number and the account all count", () => {
  const promotion = at("2026-11-27T12:00:00Z");
  const order = (extra) => ({ promotion: { id: "test-offer" }, status: "awaiting_payment", contact: { phone: "670000001" },
    payment: { status: "pending", payerPhone: "670000002" }, customerId: null, ...extra });
  const s = { storeOrders: [order()] };
  assert.equal(numberAlreadyUsed(s, promotion, { payerPhone: "670000002", contactPhone: "690000000" }), true, "same paying number");
  assert.equal(numberAlreadyUsed(s, promotion, { payerPhone: "690000000", contactPhone: "670000001" }), true, "same contact number");
  assert.equal(numberAlreadyUsed(s, promotion, { payerPhone: "670000001", contactPhone: "690000000" }), true, "a number paid with before");
  assert.equal(numberAlreadyUsed(s, promotion, { payerPhone: "690000000", contactPhone: "690000001" }), false);
  assert.equal(numberAlreadyUsed({ storeOrders: [order({ customerId: "c1" })] }, promotion, { payerPhone: "690000000", contactPhone: "690000001", customerId: "c1" }), true, "same account");
  for (const gone of [{ status: "expired" }, { status: "cancelled" }, { payment: { status: "failed", payerPhone: "670000002" } }])
    assert.equal(numberAlreadyUsed({ storeOrders: [order(gone)] }, promotion, { payerPhone: "670000002", contactPhone: "670000001" }), false, JSON.stringify(gone));
});

test("the admin form refuses incomplete, unknown or overlapping offers", () => {
  const now = new Date("2026-11-20T12:00:00Z"), plans = [{ id: "unlimited", name: "Unlimited Home" }];
  const bundle = { id: "unlimited-30d-1", name: "Personal Unlimited", accessType: "personal_unlimited", deviceSlots: 1, validityHours: 720, price: 6000, status: "published" };
  const s = { storeProducts: [{ id: "router-1" }, { id: "router-2" }], storeOrders: [], storeSettings: { promotions: [] }, bundles: [bundle] };
  // New promotions give an Unlimited catalogue bundle (#345): its length is the bundle's.
  const input = { ...offer(), id: undefined, bonus: { bundleId: bundle.id, givenAt: "collection", startWithinDays: 60 } };
  const saved = promotionInput(s, input, null, now, plans);
  assert.match(saved.id, /^promo-/);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.bonus, { bundleId: bundle.id, validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 });
  assert.equal(promotionInput(s, { ...input, bonus: { ...input.bonus, givenAt: "payment" } }, null, now, plans).bonus.givenAt, "payment", "or as soon as payment is confirmed");
  for (const [change, message] of [[{ productIds: ["missing"] }, /existing products/], [{ salePrice: 0 }, /sale price/],
    [{ endsAt: "2026-11-26T00:00:00Z" }, /end after the start/], [{ name: { en: "x", fr: "" } }, /name/],
    [{ bonus: { bundleId: "nope", givenAt: "collection" } }, /Unlimited catalogue/], [{ bonus: { bundleId: bundle.id, givenAt: "whenever" } }, /free bundle/],
    [{ bonus: { planId: "unlimited", validityHours: 720, startsAt: "customer_start" } }, /Unlimited catalogue/], [{ units: 0 }, /units/]])
    assert.throws(() => promotionInput(s, { ...input, ...change }, null, now, plans), message);
  s.storeSettings.promotions.push(saved);
  assert.throws(() => promotionInput(s, { ...input, productIds: ["router-2"] }, null, now, plans), /Another offer/);
  assert.ok(promotionInput(s, { ...input, startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z" }, null, now, plans));
  // Once orders exist, the price and the free bundle are fixed.
  s.storeOrders.push({ promotion: { id: saved.id }, status: "preparing", payment: { status: "paid" } });
  assert.throws(() => promotionInput(s, { ...input, salePrice: 90000 }, saved, now, plans), /End it and create a new one/);
  assert.equal(promotionInput(s, { ...input, terms: { en: "New terms", fr: "Nouvelles conditions" } }, saved, now, plans).terms.en, "New terms");
  // A promotion saved earlier with a plan keeps it while it's unchanged.
  const legacy = { ...offer(), bonus: { planId: "unlimited", validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 } };
  const t = { ...s, storeOrders: [], storeSettings: { promotions: [] } };
  assert.equal(promotionInput(t, { ...legacy, terms: { en: "Edited", fr: "Modifié" } }, legacy, now, plans).bonus.planId, "unlimited");
});
