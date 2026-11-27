import { storeReceipt } from "../store-receipt.mjs";
import { randomUUID } from "node:crypto";
import { json } from "./http.mjs";
import { audit, catalogue as bundleCatalogue, uniqueActivationCode } from "./state.mjs";
import { promotionInput, promotionStatus, promotionOrders, unitsSold, soldAtRegular } from "../store-promotions.mjs";
import { endPromotionBonus, issuePromotionBonus, bonusRule } from "../store-promotion-bonus.mjs";
import { maskPhone } from "../reservations.mjs";
import { kitInput, kitStatusChange, adminKitView, issueKitBundle, withdrawKitBundle, newKitId, bundleSummary } from "../store-kits.mjs";
import { isUnlimitedBundle } from "../catalogue.mjs";
import { installSettings, installSettingsInput, availability, cancelBooking, refundPart, refundable, planRules, planRulesInput, planMetrics, cancelPlan, extendPlan } from "../store-kit-orders.mjs";
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
  readyHoldDays,
  checkVersion,
  movement,
  available,
  expireReservations,
  orderView,
  photoView,
  photoUpload,
  newPhotoIds,
  orderLines,
} from "../device-store.mjs";

// What staff do next with an order (#427): set it up, install it, wait for a
// plan's payments, hand it over.
export function nextAction(o) {
  if (o.kind === "plan_payment") return null;
  if (o.payment.status !== "paid" || ["cancelled", "collected", "review", "expired"].includes(o.status)) return null;
  if (o.plan && o.plan.status !== "completed") return o.plan.status === "running" ? "await_plan" : null;
  if (o.setup && o.setup.status !== "done") return "setup";
  if (o.installation && ["booked", "moved", "on_the_way"].includes(o.installation.status)) return "install";
  return o.status === "ready" ? "hand_over" : "make_ready";
}
export function createAdminStoreRoutes({ clock, pepper, store }) {
  return async (req, res, url, { s, i, role, effects }) => {
    if (!url.pathname.startsWith("/api/admin/store")) return NOT_HANDLED;
    if (!["owner", "operator"].includes(role))
      return json(res, 403, {
        error: "Your role does not permit store management.",
      });
    storeState(s);
    expireReservations(s, clock());
    // Each promotion with its figures (#302, canvas: AdminPromotions). Paid,
    // unrefunded orders only; the free bundles are gifts and never revenue.
    // A buyer is new to NDAHI when this order is their first paid purchase:
    // no earlier paid bundle or store order on the account or the paying
    // number ("new customers from it", #345; owner, 27 Nov).
    const firstPurchase = (o) => {
      const before = Date.parse(o.payment.confirmedAt || o.createdAt), mine = (x) => (o.customerId && x.customerId === o.customerId) || x.payerPhone === o.payment.payerPhone;
      return !(s.payments || []).some((x) => x.confirmedAt && Date.parse(x.confirmedAt) < before && mine(x)) &&
        !s.storeOrders.some((x) => x.id !== o.id && x.payment.confirmedAt && Date.parse(x.payment.confirmedAt) < before &&
          ((o.customerId && x.customerId === o.customerId) || x.payment.payerPhone === o.payment.payerPhone));
    };
    const promotions = () => (s.storeSettings.promotions || []).map((p) => {
      const orders = promotionOrders(s, p.id), paid = orders.filter((o) => o.payment.confirmedAt && !o.payment.refund);
      const bonus = (state) => orders.filter((o) => o.bonus?.status === state).length;
      return { ...p, status: promotionStatus(p, clock()),
        figures: { orders: orders.length, unitsSold: paid.reduce((n, o) => n + o.quantity, 0), unitsTaken: unitsSold(s, p.id), units: p.units ?? null,
          revenue: paid.reduce((n, o) => n + o.payment.amount, 0),
          bonusActive: bonus("active"), bonusReserved: bonus("reserved"), bonusGiven: bonus("given"),
          bonusEnded: bonus("ended") + bonus("expired") + bonus("cancelled"), bonusReview: bonus("needs_review"),
          // The drawn figures: free bundles given (in an account or waiting for
          // their number) and started; buyers new to NDAHI.
          freeGiven: orders.filter((o) => o.bonus?.voucherId).length,
          freeStarted: orders.filter((o) => o.bonus?.startedAt || (o.bonus?.status === "active") || (o.bonus?.status === "ended" && o.bonus.startedAt)).length,
          newCustomers: paid.filter(firstPurchase).length },
        orders: orders.map((o) => ({ id: o.id, reference: o.reference, status: o.status, paymentStatus: o.payment.status, refundStatus: o.payment.refund?.status || null, createdAt: o.createdAt,
          payer: maskPhone(o.payment.payerPhone), account: Boolean(o.customerId), name: o.customerId ? o.contact?.name || "" : "",
          bonus: o.bonus?.status || "pending", bonusEndsAt: o.bonus?.endsAt || null, bonusStartedAt: o.bonus?.startedAt || null,
          bonusStartBy: o.bonus?.startBy || null, bonusRule: bonusRule(o), bonusGivenAt: o.promotion?.bonus?.givenAt || "collection" })) };
    });
    const snapshot = () => ({
      settings: s.storeSettings,
      promotions: promotions(),
      // Countdowns run on the server's clock, not the browser's.
      serverTime: clock().toISOString(),
      categories: s.storeCategories,
      products: s.storeProducts.map((p) => ({
        ...p,
        images: (p.images || []).map((image) => photoView(image, { admin: true })),
        ...(role === "owner" ? {} : { cost: undefined }),
        available: available(s, p, clock()),
        // The crossed-out price may show only after real sales at it (#345).
        soldAtRegular30d: soldAtRegular(s, p, clock()),
      })),
      orders: s.storeOrders.map((o) => ({ ...orderView(o, { admin: true }), nextAction: nextAction(o) })),
      // Kits (#424, canvas AdminStoreServices): figures from current prices and stock.
      kits: s.storeKits.map((k) => adminKitView(s, k, clock())),
      // The Unlimited bundles a kit can give first (the Edit kit form's First bundle, #347).
      kitBundles: (s.bundles || []).filter((b) => isUnlimitedBundle(b) && b.status !== "archived").map(bundleSummary),
      // The free bundles a promotion can give (#345): published Unlimited
      // bundles, and any a promotion already gives even if archived since.
      promotionBundles: (s.bundles || []).filter((b) => isUnlimitedBundle(b) && (b.status === "published" ||
        (s.storeSettings.promotions || []).some((p) => p.bonus?.bundleId === b.id))).map(bundleSummary),
      // Installations (#425) and Pay in 3 (#426): settings, the coming days and each plan.
      installations: { settings: installSettings(s), days: availability(s, clock(), 5) },
      plans: { rules: planRules(s), metrics: planMetrics(s, clock()) },
      movements: s.storeMovements.slice(0, 100),
      role,
    });
    if (req.method === "GET" && url.pathname === "/api/admin/store")
      return json(res, 200, snapshot());
    if (req.method !== "POST") return json(res, 404, { error: "Not found." });
    try {
      const action = url.pathname.slice("/api/admin/store/".length),
        at = clock().toISOString();
      let returnedToken, refundReason, stockChange, kitId, extra;
      if (action === "receipt") {
        const order = s.storeOrders.find((o) => o.id === i.orderId);
        if (!order) fail("Order not found.", 404);
        storeReceipt(order);
        effects.storeReceiptOrder = structuredClone(order);
        return;
      }
      // A photo for a product (up to 30), uploaded on its own so that saving
      // a product never sends them all at once. It is stored after this
      // transaction commits; the product refers to it when saved.
      if (action === "photos") {
        effects.storePhoto = photoUpload(i.data);
        return;
      }
      // Kits (#424): saved as drafts, put on sale only when buyable, archived
      // rather than deleted (orders keep their own copy).
      // Installation settings (#425; the Installations tab's panel, owner and operator).
      if (action === "installations/settings") {
        s.storeSettings.installations = installSettingsInput(i, installSettings(s));
      } else if (action === "installations/update") {
        // A job (#425): assign a technician, on the way, installed with the
        // signal and a photo, couldn't install (refunds installation and
        // travel), or cancel.
        const o = s.storeOrders.find((x) => x.id === i.id), b = o?.installation;
        if (!b) fail("Installation not found.", 404);
        checkVersion(o, i);
        const tech = (id) => installSettings(s).technicians.find((t) => t.id === id);
        if (i.action === "assign") {
          if (i.technicianId !== null && !tech(i.technicianId)) fail("Choose a technician.");
          b.technicianId = i.technicianId;
        } else if (i.action === "on_the_way") {
          if (!["booked", "moved"].includes(b.status) || o.payment.status !== "paid") fail("Only a paid, booked installation can start.", 409);
          b.status = "on_the_way";
        } else if (i.action === "installed") {
          if (!["booked", "moved", "on_the_way"].includes(b.status) || o.payment.status !== "paid") fail("Only a paid, booked installation can be marked installed.", 409);
          if (o.plan && o.plan.status !== "completed") fail("The kit is handed over only once its plan is fully paid.", 409);
          const signal = text(i.signal, 40, true), photoId = text(i.photoId || "", 64);
          if (photoId && !/^[0-9a-f]{64}$/.test(photoId)) fail("Upload the installation photo first.");
          Object.assign(b, { status: "installed", signal, photoId: photoId || null, installedAt: at, installedBy: req.adminActor });
          // Handed over at the visit: set up there, collected, and the kit's first bundle given.
          if (o.setup && o.setup.status !== "done") o.setup = { status: "done", doneAt: at, doneBy: req.adminActor };
          o.status = "collected";
          (o.history ||= []).push({ action: "collect", actor: req.adminActor, at, via: "installation" });
          if (o.kit) issueKitBundle(s, o, clock(), uniqueActivationCode);
        } else if (i.action === "not_installed") {
          if (!["booked", "moved", "on_the_way"].includes(b.status) || o.payment.status !== "paid") fail("Only a paid, booked installation can be marked not installed.", 409);
          Object.assign(b, { status: "not_installed", reason: text(i.reason || "", 300), notInstalledAt: at });
          // Exactly the installation part comes back; the kit can be collected or returned unopened.
          refundPart(o, b.price + b.travelFee, "Couldn't install", clock());
          refundReason = "Couldn't install";
          effects.storeRefundId = o.id;
        } else if (i.action === "cancel") {
          cancelBooking(s, o, clock(), req.adminActor, { cutoff: false });
          if (o.payment.refund) effects.storeRefundId = o.id;
        } else fail("Unknown installation action.");
        b.history.push({ action: i.action, actor: req.adminActor, at, ...(i.action === "assign" ? { technicianId: i.technicianId } : {}) });
        o.version++; extra = { orderAction: "installation." + i.action };
      } else if (action === "plans/rules") {
        // Pay in 3 rules (#426): copied onto each new plan. The owner sets them.
        if (role !== "owner") fail("Only the owner can change the plan rules.", 403);
        s.storeSettings.payPlans = planRulesInput(i, planRules(s));
      } else if (action === "plans/update") {
        const o = s.storeOrders.find((x) => x.id === i.id);
        if (!o?.plan) fail("Payment plan not found.", 404);
        checkVersion(o, i);
        if (i.action === "remind") {
          if (o.plan.status !== "running") fail("Only a running plan gets reminders.", 409);
          (o.plan.reminders ||= []).push({ at, by: req.adminActor });
        } else if (i.action === "extend") extendPlan(o, clock(), req.adminActor);
        else if (i.action === "cancel") {
          // Cancelling refunds what was paid: the owner authorizes refunds, as on Store orders.
          if (role !== "owner") fail("Only the owner can authorize refunds.", 403);
          cancelPlan(s, o, clock(), "admin", req.adminActor); effects.storeRefundId = o.id;
        }
        else fail("Unknown plan action.");
        o.version++; extra = { orderAction: "plan." + i.action };
      } else if (action === "kits/save") {
        const old = i.id && s.storeKits.find((k) => k.id === i.id);
        if (i.id && !old) fail("Kit not found.", 404);
        if (old) checkVersion(old, i);
        const data = kitInput(s, i);
        if (old) Object.assign(old, data, { version: old.version + 1, updatedAt: at });
        else s.storeKits.unshift({ id: newKitId(), status: "draft", version: 1, createdAt: at, updatedAt: at, ...data });
        kitId = old ? old.id : s.storeKits[0].id;
      } else if (action === "kits/status") {
        const k = s.storeKits.find((k) => k.id === i.id);
        if (!k) fail("Kit not found.", 404);
        checkVersion(k, i);
        k.status = kitStatusChange(s, k, i.status);
        if (k.status === "archived") k.archivedAt = at;
        k.version++; k.updatedAt = at; kitId = k.id;
      } else if (action === "products/save") {
        const old = i.id && s.storeProducts.find((p) => p.id === i.id);
        if (i.id && !old) fail("Product not found.", 404);
        if (old) checkVersion(old, i);
        const ids = newPhotoIds(i.images, old),
          stored = new Map(ids.length ? (await store.photos.info(ids)).map((p) => [p.id, p]) : []);
        const data = productInput(
          s,
          { ...i, cost: role === "owner" ? i.cost : old?.cost || 0 },
          old,
          stored,
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
          s.storeOrders.some((o) => orderLines(o).some((line) => line.productId === p.id)) ||
          s.storeMovements.some((m) => m.productId === p.id)
        )
          fail("Archive products with order or stock history instead.", 409);
        if (s.storeKits.some((k) => k.items.some((item) => item.productId === p.id)))
          fail("This product is in a kit. Take it out of the kit, or archive the product instead.", 409);
        s.storeProducts = s.storeProducts.filter((p) => p.id !== i.id);
      } else if (action === "categories/save") {
        const old = i.id && s.storeCategories.find((c) => c.id === i.id);
        if (i.id && !old) fail("Category not found.", 404);
        if (old) checkVersion(old, i);
        const data = {
          name: localized(i.name, 100, true),
          // The shop's chip label (PhoneShop, #414), e.g. "Travel" for "Travel
          // routers"; blank uses the full name. A form without the field
          // (the frozen v1 admin) keeps the saved one.
          shortName: i.shortName === undefined && old ? old.shortName || { en: "", fr: "" } : localized(i.shortName || { en: "", fr: "" }, 30),
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
          // Promotions are saved on their own (promotions/save); keep them.
          promotions: s.storeSettings.promotions || [],
          open: i.open === true,
          name: text(i.name, 100, true),
          // The store shows the boards' fixed words now (#403/#418; owner 26 Nov),
          // so the v2 admin has no Introduction field; a form without it keeps the saved one.
          introduction: i.introduction === undefined ? s.storeSettings.introduction || { en: "", fr: "" } : localized(i.introduction, 1000),
          banner: localized(i.banner, 500),
          contact: text(i.contact, 300),
          pickup: text(i.pickup, 1000),
          hours: text(i.hours, 300),
          warranty: localized(i.warranty, 3000),
          returns: localized(i.returns, 3000),
          // A form without the field (the frozen v1 admin) keeps the saved one.
          readyHoldDays: i.readyHoldDays === undefined ? readyHoldDays(s) : integer(Number(i.readyHoldDays), 1, 90),
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
      } else if (action === "promotions/save") {
        // Owner and operator (this route's roles); every change is audited below.
        const list = (s.storeSettings.promotions ||= []);
        const old = i.id ? list.find((p) => p.id === i.id) : null;
        if (i.id && !old) fail("Promotion not found.", 404);
        if (old && old.version !== i.version) fail("This promotion changed. Reload before saving.", 409);
        const next = promotionInput(s, i, old, clock(), bundleCatalogue(s));
        if (old) Object.assign(old, next);
        else list.unshift(next);
        i.id = next.id;
      } else if (action === "promotions/end") {
        const p = (s.storeSettings.promotions || []).find((p) => p.id === i.id);
        if (!p) fail("Promotion not found.", 404);
        if (!["live", "scheduled"].includes(promotionStatus(p, clock()))) fail("Only a live or scheduled promotion can be ended.", 409);
        // Orders already placed keep their price and free bundle.
        p.endedEarlyAt = at;
        p.updatedAt = at;
        p.version = (p.version || 0) + 1;
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
        const before = p.stock;
        movement(s, p, delta, reason, req.adminActor, clock(), operationKey);
        // "Changed stock 3 → 2" in the audit log (AdminAudit, #378).
        stockChange = { from: before, to: p.stock };
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
        if (i.action === "setup") {
          // A kit set up for the buyer's account (#424): staff prepare the router first.
          if (!o.setup || o.setup.status === "done" || o.payment.status !== "paid" || o.status !== "preparing")
            fail("Only a paid kit order waiting for its Set up step can be marked set up.", 409);
          o.setup = { status: "done", doneAt: at, doneBy: req.adminActor };
        } else if (i.action === "ready") {
          if (o.payment.status !== "paid" || o.status !== "preparing")
            fail("Only paid, preparing orders can be marked ready.", 409);
          if (o.setup && o.setup.status !== "done")
            fail("Set up the router for the buyer's account before marking the order ready.", 409);
          if (o.plan && o.plan.status !== "completed")
            fail("A plan's kit is ready only once it's fully paid.", 409);
          if (o.installation && ["booked", "moved", "on_the_way"].includes(o.installation.status))
            fail("This kit is handed over at its installation. Mark it installed there instead.", 409);
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
          // A promotion's free month is given when the router is collected
          // (owner, 23 Nov, #423). Orders under the 20 Nov rule already have it.
          if (o.promotion?.bonus) issuePromotionBonus(s, o, clock(), {
            plan: bundleCatalogue(s).find((plan) => plan.id === o.promotion.bonus.planId), code: uniqueActivationCode });
          // A kit's first bundle, unstarted, in the buyer's account (#424).
          if (o.kit) issueKitBundle(s, o, clock(), uniqueActivationCode);
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
          // The drawn refund on Store orders (owner, 25 Nov, #391): an order
          // not yet handed over is refunded in one step, and its device goes
          // back into stock once the provider confirms. Any other refund (a
          // return, a late payment) still names a reason and the restock.
          const beforeCollection = i.beforeCollection === true;
          if (beforeCollection && !["preparing", "ready"].includes(o.status))
            fail("Only an order not yet handed over can be refunded this way.", 409);
          if (!beforeCollection && typeof i.restock !== "boolean")
            fail("Confirm whether the equipment is available to restock.");
          const reason = beforeCollection ? "Refunded before collection" : text(i.reason, 300, true);
          refundReason = reason;
          o.payment.refund = {
            id: randomUUID(),
            status: "requested",
            reason,
            // What is left after any partial refund (#425 Couldn't install).
            amount: refundable(o.payment),
            restock: beforeCollection ? true : i.restock,
            requestedAt: at,
          };
          o.payment.status = "refund-pending";
          effects.storeRefundId = o.id;
          // A refund cancels a promotion's free month not yet started, or
          // ends a started one and resumes any bundle paused for it (#423).
          endPromotionBonus(s, o, clock(), "refund");
          // A kit's first bundle not yet started is taken back (#424).
          if (o.kit) withdrawKitBundle(s, o, clock());
          // A refunded kit's plan ends and its booking is cancelled (#425, #426).
          if (o.plan && ["running", "pending"].includes(o.plan.status)) Object.assign(o.plan, { status: "cancelled", cancelledAt: at, cancelReason: "refund" });
          if (o.installation && ["booked", "moved", "on_the_way"].includes(o.installation.status)) o.installation.status = "cancelled";
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
      // A refund's audit entry names its reason; an order's, what was done
      // ("Handed over order after code check"); a stock change, from and to.
      audit(s, `store.${action.replaceAll("/", ".")}`, req, { id: kitId || i.id, ...(extra || {}), ...(action === "kits/status" ? { status: i.status } : {}), ...(action === "orders/update" && typeof i.action === "string" ? { orderAction: i.action } : {}), ...(refundReason ? { refund: true, reason: refundReason } : {}), ...(stockChange || {}) });
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
