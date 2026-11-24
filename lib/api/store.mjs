import { storeReceipt, storeReceiptPdf, storeReceiptFilename } from "../store-receipt.mjs";
import { randomUUID } from "node:crypto";
import { body, json, ip } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { hashSecret, safeEqual } from "../security.mjs";
import { paymentFeeRules } from "../payment-fees.mjs";
// The bundle catalogue: it describes a promotion's free bundle (#302).
import { catalogue as bundleCatalogue } from "./state.mjs";
import { startPromotionBonus, bonusView } from "../store-promotion-bonus.mjs";
import {
  catalogue,
  storeState,
  reserveOrder,
  canTrack,
  orderView,
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
                orders: state.storeOrders
                  .filter((o) => o.customerId === customer.id)
                  .map((o) => orderView(o)),
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
      if (url.pathname.endsWith("/checkout"))
        await storeCommerce.start(result.order.id);
      if (url.pathname.endsWith("/verify"))
        await storeCommerce.verify(result.order.id);
      const updated = storeState(await store.snapshot()).storeOrders.find(
        (o) => o.id === result.order.id,
      );
      if (url.pathname.endsWith("/receipt")) {
        const receipt = storeReceipt(updated), data = await storeReceiptPdf(updated);
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${storeReceiptFilename(receipt)}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(data);
      }
      return json(res, 200, {
        order: orderView(updated),
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
