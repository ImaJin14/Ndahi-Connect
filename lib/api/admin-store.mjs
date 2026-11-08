import { storeReceipt } from "../store-receipt.mjs";
import { randomUUID } from "node:crypto";
import { json } from "./http.mjs";
import { audit } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import {
  normalizeCameroonPhone,
  validCameroonPhone,
} from "../../shared-app/cameroon-phone.js";
import { secureToken, hashSecret } from "../security.mjs";
import {
  storeState,
  fail,
  text,
  localized,
  integer,
  productInput,
  checkVersion,
  movement,
  available,
  expireReservations,
  orderView,
} from "../device-store.mjs";

export function createAdminStoreRoutes({ clock, pepper }) {
  return async (req, res, url, { s, i, role, effects }) => {
    if (!url.pathname.startsWith("/api/admin/store")) return NOT_HANDLED;
    if (!["owner", "operator"].includes(role))
      return json(res, 403, {
        error: "Your role does not permit store management.",
      });
    storeState(s);
    expireReservations(s, clock());
    const snapshot = () => ({
      settings: s.storeSettings,
      categories: s.storeCategories,
      products: s.storeProducts.map((p) => ({
        ...p,
        ...(role === "owner" ? {} : { cost: undefined }),
        available: available(s, p, clock()),
      })),
      orders: s.storeOrders.map((o) => orderView(o, { admin: true })),
      movements: s.storeMovements.slice(0, 100),
      role,
    });
    if (req.method === "GET" && url.pathname === "/api/admin/store")
      return json(res, 200, snapshot());
    if (req.method !== "POST") return json(res, 404, { error: "Not found." });
    try {
      const action = url.pathname.slice("/api/admin/store/".length),
        at = clock().toISOString();
      let returnedToken;
      if (action === "receipt") {
        const order = s.storeOrders.find((o) => o.id === i.orderId);
        if (!order) fail("Order not found.", 404);
        storeReceipt(order);
        effects.storeReceiptOrder = structuredClone(order);
        return;
      }
      if (action === "products/save") {
        const old = i.id && s.storeProducts.find((p) => p.id === i.id);
        if (i.id && !old) fail("Product not found.", 404);
        if (old) checkVersion(old, i);
        const data = productInput(
          s,
          { ...i, cost: role === "owner" ? i.cost : old?.cost || 0 },
          old,
        );
        if (old)
          Object.assign(old, data, { version: old.version + 1, updatedAt: at });
        else
          s.storeProducts.unshift({
            id: randomUUID(),
            ...data,
            stock: 0,
            version: 1,
            createdAt: at,
            updatedAt: at,
          });
      } else if (action === "products/delete") {
        const p = s.storeProducts.find((p) => p.id === i.id);
        if (!p) fail("Product not found.", 404);
        checkVersion(p, i);
        if (
          s.storeOrders.some((o) => o.productId === p.id) ||
          s.storeMovements.some((m) => m.productId === p.id)
        )
          fail("Archive products with order or stock history instead.", 409);
        s.storeProducts = s.storeProducts.filter((p) => p.id !== i.id);
      } else if (action === "categories/save") {
        const old = i.id && s.storeCategories.find((c) => c.id === i.id);
        if (i.id && !old) fail("Category not found.", 404);
        if (old) checkVersion(old, i);
        const data = {
          name: localized(i.name, 100, true),
          hidden: i.hidden === true,
          position: integer(i.position, 0, 1000),
        };
        if (old) Object.assign(old, data, { version: old.version + 1 });
        else s.storeCategories.push({ id: randomUUID(), version: 1, ...data });
      } else if (action === "categories/delete") {
        const row = s.storeCategories.find((c) => c.id === i.id);
        if (!row) fail("Category not found.", 404);
        checkVersion(row, i);
        if (s.storeProducts.some((p) => p.categoryId === i.id))
          fail("Move products out of this category before deleting it.", 409);
        s.storeCategories = s.storeCategories.filter((c) => c.id !== i.id);
      } else if (action === "settings/save") {
        checkVersion(s.storeSettings, i);
        const next = {
          id: "store",
          version: s.storeSettings.version + 1,
          open: i.open === true,
          name: text(i.name, 100, true),
          introduction: localized(i.introduction, 1000),
          banner: localized(i.banner, 500),
          contact: text(i.contact, 300),
          pickup: text(i.pickup, 1000),
          hours: text(i.hours, 300),
          warranty: localized(i.warranty, 3000),
          returns: localized(i.returns, 3000),
        };
        if (
          next.open &&
          (!next.pickup ||
            !next.contact ||
            !next.returns.en ||
            !next.returns.fr ||
            !next.warranty.en ||
            !next.warranty.fr)
        )
          fail(
            "Set contact details, pickup, and EN/FR warranty and returns terms before opening.",
          );
        s.storeSettings = next;
      } else if (action === "stock/adjust") {
        const p = s.storeProducts.find((p) => p.id === i.id);
        if (!p) fail("Product not found.", 404);
        const delta = i.delta;
        integer(Math.abs(delta), 1, 1000000);
        const reason = text(i.reason, 300, true),
          operationKey = text(i.operationKey, 100, true);
        if (!/^[A-Za-z0-9_-]{24,100}$/.test(operationKey))
          fail("Invalid stock operation key.");
        const prior = s.storeOperations.find((op) => op.key === operationKey),
          fingerprint = JSON.stringify([p.id, delta, reason]);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail("Stock operation key conflict.", 409);
          return json(res, 200, { ...snapshot(), replayed: true });
        }
        checkVersion(p, i);
        movement(s, p, delta, reason, req.adminActor, clock(), operationKey);
        s.storeOperations.push({
          id: randomUUID(),
          key: operationKey,
          fingerprint,
          at,
        });
      } else if (action === "orders/update") {
        const o = s.storeOrders.find((o) => o.id === i.id);
        if (!o) fail("Order not found.", 404);
        checkVersion(o, i);
        if (i.action === "ready") {
          if (o.payment.status !== "paid" || o.status !== "preparing")
            fail("Only paid, preparing orders can be marked ready.", 409);
          o.status = "ready";
        } else if (i.action === "collect") {
          if (
            o.payment.status !== "paid" ||
            o.status !== "ready" ||
            i.collectionCode !== o.collectionCode
          )
            fail(
              "A ready, paid order and correct collection code are required.",
              409,
            );
          o.status = "collected";
        } else if (i.action === "cancel") {
          if (o.payment.confirmedAt)
            fail("Use the refund workflow for paid orders.", 409);
          o.status = "cancelled";
          o.stockState = "released";
        } else if (i.action === "contact") {
          const name = text(i.name, 120, true),
            phone = normalizeCameroonPhone(i.phone),
            email = text(i.email || "", 254);
          if (
            !validCameroonPhone(phone) ||
            (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          )
            fail("Enter valid order contact details.");
          o.contact = { name, phone, email };
        } else if (i.action === "notes") {
          const notes = text(i.notes || "", 2000),
            serialNumbers = text(i.serialNumbers || "", 1000);
          if (
            !["none", "requested", "received", "resolved"].includes(
              i.returnStatus,
            )
          )
            fail("Invalid return status.");
          o.notes = notes;
          o.serialNumbers = serialNumbers;
          o.returnStatus = i.returnStatus;
        } else if (i.action === "rotate-link") {
          returnedToken = secureToken();
          o.trackingHash = hashSecret(returnedToken, pepper);
        } else if (i.action === "refund") {
          if (role !== "owner")
            fail("Only the owner can authorize refunds.", 403);
          if (!o.payment.confirmedAt || o.payment.refund)
            fail("Refund unavailable or already requested.", 409);
          if (typeof i.restock !== "boolean")
            fail("Confirm whether the equipment is available to restock.");
          const reason = text(i.reason, 300, true);
          o.payment.refund = {
            id: randomUUID(),
            status: "requested",
            reason,
            restock: i.restock,
            requestedAt: at,
          };
          o.payment.status = "refund-pending";
          effects.storeRefundId = o.id;
        } else if (i.action === "refund-reference") {
          if (
            role !== "owner" ||
            o.payment.refund?.status !== "uncertain" ||
            o.payment.refund.providerReference
          )
            fail("This refund cannot accept a recovery reference.", 409);
          o.payment.refund.providerReference = text(
            i.providerReference,
            200,
            true,
          );
          o.payment.refund.status = "pending";
          delete o.payment.refund.nextCheckAt;
          effects.storeRefundId = o.id;
        } else if (i.action === "verify") {
          effects.storeVerifyId = o.id;
        } else fail("Unknown order action.");
        o.version++;
        o.history.push({ action: i.action, actor: req.adminActor, at });
      } else return json(res, 404, { error: "Not found." });
      audit(s, `store.${action.replaceAll("/", ".")}`, req, { id: i.id });
      return json(res, 200, {
        ...snapshot(),
        ...(returnedToken ? { token: returnedToken } : {}),
      });
    } catch (error) {
      if (!error.status) throw error;
      return json(res, error.status, { error: error.message });
    }
  };
}
