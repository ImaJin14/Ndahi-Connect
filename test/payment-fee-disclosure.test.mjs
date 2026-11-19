// The price, the Mobile Money fee and the total reach the customer before they pay,
// stay on the payment, and explain a low balance afterwards (#297). The fee comes
// from the PAYMENT_FEE_* rule; MeSomb's reported fee replaces it once known.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createHandler, createStore } from "../server.mjs";
import { createBillingService, ensureReceipt, paymentView, recordGatewayFailure } from "../lib/billing.mjs";
import { receiptDocument, receiptText, receiptView } from "../lib/receipt.mjs";
import { receiptPdf } from "../lib/receipt-pdf.mjs";
import { storeReceipt, storeOrderEmail, storeReceiptPdf } from "../lib/store-receipt.mjs";
import { catalogue, orderView, reserveOrder, settleOrder, storeState } from "../lib/device-store.mjs";
import { createStoreCommerce } from "../lib/store-commerce.mjs";
import { MeSombPaymentAdapter } from "../lib/payments.mjs";
import { paymentFeeRules } from "../lib/payment-fees.mjs";
import { silentLogger } from "../lib/logger.mjs";

const feeEnv = { PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: "percent=2", PAYMENT_FEE_ORANGE: "percent=2,on=gross,round=down" };

async function api(t, { env = {}, createPayment } = {}) {
  const handler = createHandler({ store: createStore({ persistent: false }), validateConfig: false, logger: silentLogger,
    payments: { mesomb: { configured: () => true, createPayment: createPayment || (async (p) => ({ providerReference: `ref-${p.id}`, status: "pending" })),
      async verifyPayment() { return { status: "pending" }; } } },
    env: { NODE_ENV: "test", CUSTOMER_APP_URL: "http://customer.test", SECRET_PEPPER: "fee-tests", CUSTOMER_SESSION_SECRET: "fee-tests",
      BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent", ...feeEnv, ...env } });
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json() })),
    purchase: (fields) => fetch(base + "/api/purchase", { method: "POST", headers: { "content-type": "application/json", origin: "http://customer.test" },
      body: JSON.stringify({ phone: "670000502", name: "Guest", planId: "weekly", network: "mtn", requestKey: randomUUID().replaceAll("-", ""), ...fields }) })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
  };
}

test("each plan carries its fee and total per network, from the server's rule", async (t) => {
  const { get } = await api(t);
  const { body } = await get("/api/plans");
  const weekly = body.plans.find((plan) => plan.id === "weekly");
  assert.ok(weekly.price > 0);
  const mtnFee = Math.ceil(weekly.price * 0.02), orangeFee = Math.floor(weekly.price * 2 / 98);
  assert.deepEqual(weekly.paymentQuotes.mtn, { price: weekly.price, fee: mtnFee, total: weekly.price + mtnFee, network: "mtn" });
  assert.deepEqual(weekly.paymentQuotes.orange, { price: weekly.price, fee: orangeFee, total: weekly.price + orangeFee, network: "orange" });
  // Without a rule the fee is unknown, never zero.
  const none = await api(t, { env: { PAYMENT_FEE_MTN: "", PAYMENT_FEE_ORANGE: "" } });
  const plain = (await none.get("/api/plans")).body.plans.find((plan) => plan.id === "weekly");
  assert.deepEqual(plain.paymentQuotes.mtn, { price: weekly.price, fee: null, total: null, network: "mtn" });
});

test("the quoted fee and total are stored on the payment; the amount sent stays the price", async (t) => {
  const sent = [];
  const { purchase } = await api(t, { createPayment: async (p) => { sent.push(p.amount); return { providerReference: `ref-${p.id}`, status: "pending" }; } });
  const { status, body } = await purchase({ network: "orange" });
  assert.equal(status, 201, JSON.stringify(body));
  const price = body.payment.amount, fee = Math.floor(price * 2 / 98);
  assert.deepEqual([body.payment.fee, body.payment.total, body.payment.network], [fee, price + fee, "orange"]);
  assert.deepEqual(sent, [price], "MeSomb is still asked for the price; it adds its own fee");
});

test("a low balance names the total, the bundle and the fee; check_balance asks to check it covers the total", async (t) => {
  let code = "low_balance";
  const { purchase } = await api(t, { createPayment: async () => { throw Object.assign(Error("refused"), { refusal: { failureCode: code } }); } });
  const low = (await purchase({})).body, price = low.payment.amount, fee = Math.ceil(price * 0.02);
  const money = (value) => new Intl.NumberFormat("en", { style: "currency", currency: "XAF", maximumFractionDigits: 0 }).format(value);
  assert.deepEqual([low.payment.failureCode, low.payment.fee, low.payment.total, low.payment.moneyTaken], ["low_balance", fee, price + fee, false]);
  assert.equal(low.checkout.message, `Your Mobile Money balance was below ${money(price + fee)}: the bundle (${money(price)}) plus the Mobile Money fee (${money(fee)}), so no money was taken. Add money, then try again or choose a smaller bundle.`);
  code = "check_balance";
  const check = (await purchase({ phone: "670000503" })).body;
  assert.match(check.checkout.message, new RegExp(`usually means the balance was too low\\. No money was taken\\. Check your balance covers ${money(price + fee).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: the bundle`));
  // Without a fee rule the sentence says the fee was in the prompt, with no number.
  const p = { amount: 1000, fee: null, total: null, payerPhone: "670000501", network: "mtn" };
  recordGatewayFailure(p, { failureCode: "low_balance" }, new Date());
  assert.match(p.failureReason, /below the bundle \(FCFA\s1,000\) plus the Mobile Money fee shown in your prompt, so no money was taken/);
});

function billing(result) {
  const store = createStore({ persistent: false }), now = () => new Date("2030-05-01T10:00:00Z"), warnings = [];
  const logger = { ...silentLogger, warn: (event, fields) => warnings.push({ event, ...fields }) };
  const service = createBillingService({ store, now, logger, planFor: () => null, settle: async (s, p) => { p.status = "paid"; p.confirmedAt = now().toISOString(); ensureReceipt(p); },
    payments: { mesomb: { async createPayment(p) { return { providerReference: `ref-${p.id}`, status: "pending", ...result.made }; },
      async verifyPayment(p) { return { status: "paid", providerReference: `ref-${p.id}`, transactionReference: p.id, amount: p.amount, currency: "XAF", ...result.verified }; } } } });
  const reserve = () => store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670000501" });
    s.payments.push({ id: "pay-1", customerId: "c1", amount: 5000, fee: 100, total: 5100, currency: "XAF", network: "mtn", payerPhone: "670000501",
      provider: "mesomb", status: "pending", creationState: "reserved", createdAt: now().toISOString(),
      paymentExpiresAt: new Date(+now() + 300000).toISOString(), paymentClosesAt: new Date(+now() + 300000).toISOString() });
  });
  return { store, service, reserve, warnings, now };
}

test("MeSomb's reported fee is recorded beside the quote, logged once when it differs, and reaches the receipt", async () => {
  const f = billing({ made: { providerFee: 102, providerTotal: 5102 }, verified: { providerFee: 102, providerTotal: 5102 } });
  await f.reserve();
  await f.service.startPayment("pay-1");
  let p = (await f.store.snapshot()).payments[0];
  assert.deepEqual([p.fee, p.total, p.providerFee, p.providerTotal], [100, 5100, 102, 5102]);
  assert.deepEqual(paymentView(p, { now: f.now() }).fee, 102, "the customer sees what was actually asked");
  await f.service.recheckPayment("pay-1");
  p = (await f.store.snapshot()).payments[0];
  assert.equal(p.status, "paid");
  assert.deepEqual([p.receipt.fee, p.receipt.total, p.receipt.feeReported], [102, 5102, true]);
  assert.deepEqual(f.warnings.filter((w) => w.event === "payment.fee_mismatch").map(({ quotedFee, reportedFee }) => [quotedFee, reportedFee]), [[100, 102]]);
  // A matching report is not a mismatch.
  const g = billing({ made: { providerFee: 100, providerTotal: 5100 } });
  await g.reserve();
  await g.service.startPayment("pay-1");
  assert.equal(g.warnings.filter((w) => w.event === "payment.fee_mismatch").length, 0);
});

test("the MeSomb adapter reads the fee only from a successful transaction", async () => {
  const transaction = { pk: "mesomb-1", status: "PENDING", amount: 5000, fees: 102, trxamount: 5102, currency: "XAF" };
  const adapter = new MeSombPaymentAdapter({ applicationKey: "a", accessKey: "b", secretKey: "c", client: {
    async makeCollect() { return { success: true, status: "PENDING", isOperationSuccess: () => true, isTransactionSuccess: () => false, transaction: { ...transaction, getData: () => transaction } }; },
    async checkTransactions() { return [{ ...transaction, status: "SUCCESS", getData: () => ({ ...transaction, status: "SUCCESS" }) }]; },
  } });
  // A pending request's fee is not final (it may still read 0), so the quote stays.
  const made = await adapter.createPayment({ id: "pay-1", amount: 5000, currency: "XAF", network: "mtn", payerPhone: "670000501", customerName: "Ada" });
  assert.deepEqual([made.status, made.providerFee, made.providerTotal], ["pending", undefined, undefined]);
  const verified = await adapter.verifyPayment({ id: "pay-1", providerReference: "mesomb-1" });
  assert.deepEqual([verified.status, verified.amount, verified.providerFee, verified.providerTotal], ["paid", 5000, 102, 5102]);
});

test("bundle receipts list the price, the Mobile Money fee and the total paid", async () => {
  const receipt = { number: "NC-pay-1", paymentId: "pay-1", paidAt: "2030-05-01T10:00:00Z", provider: "mesomb", network: "orange", payerPhone: "690000001",
    providerReference: "ref-1", amount: 5000, fee: 102, total: 5102, currency: "XAF", customerName: "Ada", plan: { name: "Weekly", quotaGb: 10, validityHours: 168, deviceLimit: 2 } };
  const view = receiptView(receipt);
  assert.deepEqual([view.amountLabel, view.priceLabel, view.feeName, view.feeLabel], ["FCFA 5,102", "FCFA 5,000", "Orange Money fee", "FCFA 102"]);
  const text = receiptText(receipt);
  assert.match(text, /Amount paid: FCFA\s5,102\nPackage price: FCFA\s5,000\nOrange Money fee: FCFA\s102/);
  assert.match(text, /package price plus the fee your Mobile Money provider charged/);
  const html = receiptDocument(receipt);
  assert.match(html, /Package price<\/th><td[^>]*>FCFA\s5,000/);
  assert.match(html, /Orange Money fee<\/th><td[^>]*>FCFA\s102/);
  assert.match(html, /Total paid<\/th><td[^>]*>FCFA\s5,102/);
  assert.ok((await receiptPdf(receipt)).subarray(0, 5).equals(Buffer.from("%PDF-")));
  // A historical payment with no recorded fee keeps the old receipt, with no fee line.
  const old = receiptView({ ...receipt, fee: undefined, total: undefined });
  assert.deepEqual([old.amountLabel, old.feeLabel], ["FCFA 5,000", undefined]);
  assert.match(receiptText({ ...receipt, fee: undefined, total: undefined }), /Provider fees, if any, are shown separately/);
});

function shop() {
  const s = storeState({});
  Object.assign(s.storeSettings, { open: true, pickup: "Office", hours: "09–17" });
  s.storeProducts.push({ id: "p1", version: 1, sku: "TR", name: { en: "Travel router", fr: "Routeur" }, price: 10000, cost: 5000, stock: 3,
    status: "published", categoryId: "", images: [], warranty: { en: "One year", fr: "Un an" } });
  return s;
}
const now = new Date("2030-01-01T10:00:00Z");
const order = (s, network = "mtn", quantity = 2) => reserveOrder(s, { productId: "p1", quantity, expectedPrice: 10000, name: "Buyer", phone: "670000001",
  payerPhone: "670000001", network, checkoutKey: randomUUID() }, { now, secret: "fee-tests", provider: "mesomb", feeRules: paymentFeeRules(feeEnv) }).order;

test("the store quotes every quantity per network and keeps the quote on the order", () => {
  const s = shop(), product = catalogue(s, now, paymentFeeRules(feeEnv)).products[0];
  assert.equal(product.paymentQuotes.mtn.length, 3, "one quote per quantity in stock");
  assert.deepEqual(product.paymentQuotes.mtn[1], { quantity: 2, price: 20000, fee: 400, total: 20400, network: "mtn" });
  assert.deepEqual(product.paymentQuotes.orange[0], { quantity: 1, price: 10000, fee: 204, total: 10204, network: "orange" });
  assert.equal(catalogue(s, now).products[0].paymentQuotes.mtn[0].fee, null, "no rule, no number");
  const o = order(s);
  assert.deepEqual([o.payment.amount, o.payment.fee, o.payment.total], [20000, 400, 20400]);
  const view = orderView(o);
  assert.deepEqual([view.amount, view.fee, view.total, view.network], [20000, 400, 20400, "mtn"]);
});

test("store receipts and order emails show the fee actually charged", async () => {
  const s = shop(), o = order(s, "orange", 1), warnings = [];
  // MeSomb reports its own fee when the payment settles.
  settleOrder(s, o, { status: "paid", transactionReference: o.payment.id, providerReference: "ref-1", amount: 10000, currency: "XAF", providerFee: 205, providerTotal: 10205 }, now);
  assert.deepEqual([o.payment.fee, o.payment.providerFee], [204, 205]);
  const r = storeReceipt(o);
  assert.deepEqual([r.amount, r.fee, r.total, r.network], [10000, 205, 10205, "orange"]);
  assert.ok((await storeReceiptPdf(o)).subarray(0, 5).equals(Buffer.from("%PDF-")));
  const email = storeOrderEmail(o).text;
  assert.match(email, /Order total: 10,000 FCFA\nOrange Money fee: 205 FCFA\nTotal to approve: 10,205 FCFA/);
  // Store commerce logs the difference between quote and report.
  const store = createStore({ persistent: false });
  await store.transaction((state) => { Object.assign(state, shop()); state.storeOrders.push(order(state, "mtn", 1)); });
  const id = (await store.snapshot()).storeOrders[0].id;
  const commerce = createStoreCommerce({ store, clock: () => now, logger: { warn: (event, fields) => warnings.push({ event, ...fields }) },
    pays: { mesomb: { async createPayment(p) { return { providerReference: "ref-2", status: "pending", providerFee: 210, providerTotal: 10210 }; } } } });
  await commerce.start(id);
  assert.deepEqual(warnings.map(({ event, quotedFee, reportedFee }) => [event, quotedFee, reportedFee]), [["store.fee_mismatch", 200, 210]]);
});
