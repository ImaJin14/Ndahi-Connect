import { storeReceipt, storeReceiptPdf, storeReceiptFilename } from "../store-receipt.mjs";
import { randomUUID } from "node:crypto";
import { body, json, ip } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { hashSecret, safeEqual } from "../security.mjs";
import { paymentFeeRules } from "../payment-fees.mjs";
// The bundle catalogue: it describes a promotion's free bundle (#302).
import { catalogue as bundleCatalogue } from "./state.mjs";
import { startPromotionBonus, bonusView } from "../store-promotion-bonus.mjs";
import { installSettings, installsOpen, availability, kitQuote, moveBooking, cancelBooking, newPlanPayment, planEligible, planOffered, planQuotes } from "../store-kit-orders.mjs";
import { kitBuyable } from "../store-kits.mjs";
import {
  catalogue,
  storeState,
  reserveOrder,
  canTrack,
  trackedOrder,
  orderView,
  cancelUnpaidOrder,
  readyHoldDays,
  fail,
} from "../device-store.mjs";

export function createStoreRoutes({
  store,
  mutate,
  auth,
  pepper,
  clock,
  env,
  paymentProviders,
  storeCommerce,
  bootstrapMode,
}) {
  return async (req, res, url) => {
    const account = url.pathname.startsWith("/api/account/store/");
    if (!url.pathname.startsWith("/api/store/") && !account) return NOT_HANDLED;
    // A product photo by the SHA-256 of its bytes: one row read, no state, and
    // cached for a year, since that address never shows anything else.
    const photo = /^\/api\/store\/photos\/([0-9a-f]{64})$/.exec(url.pathname);
    if (photo && (req.method === "GET" || req.method === "HEAD")) {
      const found = await store.photos.get(photo[1]), etag = `"${photo[1]}"`;
      if (!found) return json(res, 404, { error: "Photo not found." });
      const cache = { etag, "cache-control": "public, max-age=31536000, immutable" };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, cache); return res.end(); }
      const bytes = Buffer.from(found.data, "base64");
      res.writeHead(200, { ...cache, "content-type": found.mime, "content-length": bytes.length, "x-content-type-options": "nosniff" });
      return res.end(req.method === "HEAD" ? undefined : bytes);
    }
    let input;
    try {
      res.setHeader("cache-control", "no-store");
      if (req.method === "GET" && url.pathname === "/api/store/catalogue") {
        const state = storeState(await store.snapshot());
        return json(res, 200, {
          ...catalogue(state, clock(), paymentFeeRules(env), bundleCatalogue(state)),
          paymentProviders: bootstrapMode ? [] : paymentProviders,
          portalUrl: env.CUSTOMER_APP_URL || "http://localhost:8080",
        });
      }
      // Installation (#425): the price, the areas with their travel fees and the
      // next days with places left, for the booking screen.
      if (req.method === "GET" && url.pathname === "/api/store/installations") {
        const state = storeState(await store.snapshot()), c = installSettings(state);
        return json(res, 200, { open: installsOpen(state), price: c.price, currency: "XAF",
          areas: c.areas.map(({ id, name, town, travelFee }) => ({ id, name, town, travelFee })), days: installsOpen(state) ? availability(state, clock(), 8) : [] });
      }
      // A kit's totals for each choice (#427): the kit page and the next screens
      // show these, never their own sums. Pay in 3 says whether this account may.
      if (req.method === "GET" && url.pathname === "/api/store/kits/quote") {
        const state = storeState(await store.snapshot()), kit = state.storeKits.find((k) => k.id === url.searchParams.get("kitId"));
        if (!kit || !kitBuyable(state, kit)) return json(res, 404, { error: "Kit unavailable." });
        const setup = url.searchParams.get("setup") === "install" ? "install" : "self", pay = url.searchParams.get("pay") === "plan" ? "plan" : "full";
        const session = auth(req, state, "dashboardSessions");
        return json(res, 200, { kitId: kit.id, setup, pay, planOffered: planOffered(state, kit), installationOffered: kit.installation === true && installsOpen(state),
          ...(session ? { planEligible: planEligible(state, session.customerId, clock()) } : {}),
          ...kitQuote(state, kit, { setup, areaId: url.searchParams.get("areaId") || null, pay, network: url.searchParams.get("network") || null }, clock(), paymentFeeRules(env)) });
      }
      // Store routes use the API's existing /api/account session-cookie path.
      if (
        req.method === "GET" &&
        url.pathname === "/api/account/store/context"
      ) {
        const state = storeState(await store.snapshot()),
          session = auth(req, state, "dashboardSessions");
        const customer =
          session &&
          state.customers.find(
            (c) =>
              c.id === session.customerId &&
              c.status !== "suspended" &&
              !c.suspended,
          );
        return json(
          res,
          200,
          customer
            ? {
                authenticated: true,
                csrfToken: session.csrfToken,
                customer: {
                  name: customer.name,
                  phone: customer.phone,
                  email: customer.email || "",
                },
                // A plan's later payments show inside their kit order (#426).
                orders: state.storeOrders
                  .filter((o) => o.customerId === customer.id && o.kind !== "plan_payment")
                  .map((o) => orderView(o, { holdDays: readyHoldDays(state) })),
              }
            : { authenticated: false, orders: [] },
        );
      }
      if (req.method !== "POST") return json(res, 404, { error: "Not found." });
      input = await body(req);
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail("Invalid request.");
      const limited = await mutate((s) => {
        const scope = "store-request",
          recent = s.rateLimitEvents.filter(
            (e) =>
              e.scope === scope &&
              e.ip === ip(req) &&
              Date.parse(e.at) > +clock() - 60000,
          );
        if (recent.length >= 30) return true;
        s.rateLimitEvents.push({
          id: randomUUID(),
          scope,
          ip: ip(req),
          at: clock().toISOString(),
        });
        return false;
      });
      if (limited)
        return json(
          res,
          429,
          { error: "Too many requests. Wait a minute before trying again." },
          { "retry-after": "60" },
        );
      // The short private link (/o/<token>, #401) carries the token alone:
      // the order is the one that token tracks.
      if (typeof input.orderId !== "string" && typeof input.token === "string") {
        const tracked = trackedOrder(storeState(await store.snapshot()).storeOrders, input.token, pepper);
        if (tracked) input.orderId = tracked.id;
      }
      // Change payment (#397): ask the provider first, so a payment approved
      // a moment ago is found and settled instead of cancelled.
      // A guest changes payment on a guest order with its private link (#400;
      // owner 26 Nov); an account's order stays the account's to change.
      if (["/api/account/store/cancel", "/api/store/cancel"].includes(url.pathname) && typeof input.orderId === "string") {
        const before = storeState(await store.snapshot()), session = account && auth(req, before, "dashboardSessions"),
          mine = before.storeOrders.find((o) => o.id === input.orderId && (account ? session && o.customerId === session.customerId : !o.customerId && canTrack(o, input.token, pepper)));
        if (mine && mine.status === "awaiting_payment" && !mine.payment.confirmedAt && mine.payment.creationState !== "reserved") await storeCommerce.verify(mine.id, { force: true });
      }
      let result;
      await mutate((s) => {
        storeState(s);
        const session = account && auth(req, s, "dashboardSessions");
        if (account && !session) fail("Sign in again.", 401);
        if (
          account &&
          (!session.csrfToken ||
            !safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken))
        )
          fail("Refresh your account session.", 403);
        const customer =
          session &&
          s.customers.find(
            (c) =>
              c.id === session.customerId &&
              c.status !== "suspended" &&
              !c.suspended,
          );
        if (account && !customer) fail("Account unavailable.", 403);
        if (
          ["/api/store/checkout", "/api/account/store/checkout"].includes(
            url.pathname,
          )
        ) {
          if (bootstrapMode)
            fail("Purchases are paused during service setup.", 503);
          const provider =
            input.provider ||
            paymentProviders.find((p) => p !== "mock") ||
            paymentProviders[0];
          if (
            !paymentProviders.includes(provider) ||
            (env.NODE_ENV === "production" && provider === "mock")
          )
            fail("Payment method unavailable.");
          result = reserveOrder(s, input, {
            now: clock(),
            secret: pepper,
            customerId: customer?.id,
            provider,
            clientIp: ip(req),
            feeRules: paymentFeeRules(env),
            plans: bundleCatalogue(s),
          });
          return;
        }
        // An installation moved or cancelled by its customer, free up to 24 h before (#425).
        if (url.pathname === "/api/account/store/installation") {
          if (!customer) fail("Not found.", 404);
          const order = s.storeOrders.find((o) => o.id === input.orderId && o.customerId === customer.id && o.installation);
          if (!order) fail("Order not found.", 404);
          if (input.action === "move") moveBooking(s, order, input, clock(), "customer");
          else if (input.action === "cancel") cancelBooking(s, order, clock(), "customer");
          else fail("Choose to move or cancel.");
          order.version++;
          result = { order };
          return;
        }
        // A plan's next payment, or everything left at once (#426): its own Mobile Money payment.
        if (url.pathname === "/api/account/store/plan/pay") {
          if (bootstrapMode) fail("Purchases are paused during service setup.", 503);
          if (!customer) fail("Not found.", 404);
          const parent = s.storeOrders.find((o) => o.id === input.orderId && o.customerId === customer.id && o.plan);
          if (!parent) fail("Order not found.", 404);
          const provider = input.provider || paymentProviders.find((p) => p !== "mock") || paymentProviders[0];
          if (!paymentProviders.includes(provider) || (env.NODE_ENV === "production" && provider === "mock")) fail("Payment method unavailable.");
          const made = newPlanPayment(s, parent, input, { now: clock(), secret: pepper, provider, clientIp: ip(req), feeRules: paymentFeeRules(env) });
          result = { order: made.order, parentId: parent.id, replayed: made.replayed, planPayment: true };
          return;
        }
        // The customer starts their free month (#423). It may belong to the
        // account of the number that paid rather than the order's account, so
        // it is found by the free month itself, which must be this account's.
        if (url.pathname === "/api/account/store/bonus/start") {
          if (!account) fail("Not found.", 404);
          if (typeof input.voucherId !== "string" || !input.voucherId) fail("Choose the free month to start.");
          const started = startPromotionBonus(s, input.voucherId, customer, clock());
          if (!started.order) fail("Order not found.", 404);
          // Only the free month: the order may not be this account's.
          const v = started.voucher;
          result = { bonusStart: { bonus: bonusView(started.order), voucher: { id: v.id, status: v.status, activatedAt: v.activatedAt, expiresAt: v.expiresAt },
            replayed: started.replayed } };
          return;
        }
        const order = s.storeOrders.find((o) => o.id === input.orderId);
        if (
          !order ||
          !(
            canTrack(order, input.token, pepper) ||
            (customer && order.customerId === customer.id)
          )
        )
          fail("Order not found.", 404);
        if (url.pathname === "/api/account/store/claim") {
          if (!canTrack(order, input.token, pepper))
            fail("Order link verification required.", 403);
          if (order.customerId && order.customerId !== customer.id)
            fail("This order already belongs to another account.", 409);
          order.customerId = customer.id;
          order.version++;
        } else if (url.pathname === "/api/account/store/cancel") {
          // Only the account's own orders; an order link alone can't cancel.
          if (!customer || order.customerId !== customer.id) fail("Order not found.", 404);
          cancelUnpaidOrder(order, clock());
        } else if (url.pathname === "/api/store/cancel") {
          // Only a guest order, and only with its private link.
          if (order.customerId || !canTrack(order, input.token, pepper)) fail("Order not found.", 404);
          cancelUnpaidOrder(order, clock());
        } else if (
          ![
            "/api/store/receipt",
            "/api/account/store/receipt",
            "/api/store/order",
            "/api/store/verify",
            "/api/account/store/order",
            "/api/account/store/verify",
          ].includes(url.pathname)
        )
          fail("Not found.", 404);
        result = { order };
      });
      if (result?.bonusStart) return json(res, 200, result.bonusStart);
      if (result?.limited)
        return json(
          res,
          429,
          { error: "Too many requests. Wait a minute before trying again." },
          { "retry-after": "60" },
        );
      if (url.pathname.endsWith("/checkout") || (result?.planPayment && !result.replayed))
        await storeCommerce.start(result.order.id);
      if (url.pathname.endsWith("/verify"))
        await storeCommerce.verify(result.order.id);
      const after = storeState(await store.snapshot()),
        updated = after.storeOrders.find((o) => o.id === result.order.id);
      if (url.pathname.endsWith("/receipt")) {
        const receipt = storeReceipt(updated), data = await storeReceiptPdf(updated);
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${storeReceiptFilename(receipt)}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(data);
      }
      const quotes = updated.plan ? planQuotes(updated, paymentFeeRules(env)) : null;
      return json(res, 200, {
        order: orderView(updated, { holdDays: readyHoldDays(after) }),
        // A running plan's next payment and the rest, with their fees (#375).
        ...(quotes ? { planQuotes: quotes } : {}),
        // A plan payment comes back with its kit order (#426).
        ...(result.parentId ? { parent: orderView(after.storeOrders.find((o) => o.id === result.parentId), { holdDays: readyHoldDays(after) }), replayed: result.replayed } : {}),
        ...(result.token
          ? { token: result.token, replayed: result.replayed }
          : {}),
      });
    } catch (error) {
      if (!error.status) throw error;
      const checkoutNotCreated =
        url.pathname.endsWith("/checkout") &&
        typeof input?.checkoutKey === "string"
          ? !storeState(await store.snapshot()).storeOrders.some(
              (o) =>
                o.checkoutKeyHash === hashSecret(input.checkoutKey, pepper),
            )
          : undefined;
      return json(res, error.status, {
        error: error.message,
        checkoutNotCreated,
      });
    }
  };
}
