// Home WISP Unlimited (#336; spec §5; decisions.md → "Unlimited catalogue and
// device locking"). A Home WISP bundle shares through one registered WISP
// router, and only through it. It runs on the NDAHI Home router path, which
// already provides the rules the spec asks for:
//
// - Registration binds the router's upstream MAC as RouterOS sees it during
//   the customer's local sign-in through that router, confirmed with the PIN
//   (home.mjs reserveHomeLink; canvas PhoneHomeRouter "found"). A MAC sent by
//   a browser is refused, and a MAC or vendor prefix alone never authorizes.
// - The bundle is a HotSpot user bound to that MAC, so another router can't
//   use it. Its sessions never join the ndahi-personal list, so the TTL rule
//   (#335) never matches them: that is the sharing exception, held only while
//   the subscription is active on the registered router.
// - Replacing the router revokes the old one first, then binds the new one
//   (queueHome "replace"). Expiry and revocation disconnect it. The Home
//   worker reconciles after failures, reconnects and router restarts, and
//   withholds access while it can't verify the entitlement (canvas: "Sharing
//   is paused"); admins can retry from Home routers.
//
// What this module adds: the bundle waits after payment or a gift, and the
// router's registration starts it, once, with the validity it was sold with
// (time starts at first activation, owner on #333). A Home WISP bundle is
// never started or used on the direct HotSpot path, by a code or a device's
// access request: that would let one phone share without the router binding.
import { randomUUID } from "node:crypto";
import { currentHome, queueHome } from "./home.mjs";

const HOUR = 36e5;
export const HOME_WISP = "home_wisp_unlimited";
export const isHomeWisp = (v) => v?.accessType === HOME_WISP;

export const HOME_WISP_ROUTER_REQUIRED = Object.freeze({ code: "HOME_WISP_ROUTER_REQUIRED",
  error: "Home WISP Unlimited works through your registered router. Register your router to start it; you don't need to pay again." });

// The customer's Home WISP bundle waiting for its router.
export const waitingHomeWisp = (s, customerId) =>
  s.vouchers.find((v) => v.customerId === customerId && isHomeWisp(v) && v.status === "available" && v.startsOnFirstConnection === true);

// Starts the customer's waiting Home WISP bundle on their linked router and
// hands it to the Home worker; returns the bundle, or null when there is no
// linked router or nothing waiting. Safe to call again: it starts once.
export function startHomeWisp(s, customerId, now) {
  const link = currentHome(s, customerId), v = link && waitingHomeWisp(s, customerId);
  if (!v) return null;
  // One bundle at a time: a gift saved behind a running bundle waits for it.
  const running = s.vouchers.find((x) => x.customerId === customerId && x.id !== v.id && x.status === "active" && Date.parse(x.expiresAt) > +new Date(now));
  if (running) return null;
  const at = new Date(now);
  Object.assign(v, { status: "active", activatedAt: at.toISOString(), expiresAt: new Date(+at + v.validityHours * HOUR).toISOString(), startedBy: "router_registration",
    accessMode: "home", homeConnectionId: link.id, homeGeneration: link.generation, homeStatus: "activation_pending", routerSyncStatus: "pending" });
  queueHome(s, "activate", customerId, at, { voucherId: v.id, connectionId: link.id, generation: link.generation, mode: "home" });
  s.auditLogs ??= [];
  s.auditLogs.unshift({ id: randomUUID(), action: "voucher.started_on_router_registration", actor: "system",
    meta: { voucherId: v.id, customerId, connectionId: link.id, macSuffix: link.mac.slice(-5), expiresAt: v.expiresAt }, at: at.toISOString() });
  return v;
}
