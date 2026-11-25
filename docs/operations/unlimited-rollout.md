# Unlimited catalogue: rollout and rollback (#337)

How to turn on the Unlimited catalogue (#331) safely, and how to turn it off again. The owner runs every step. Nothing here changes a bundle that was already bought: turning the catalogue on only changes what can be bought from then on, and rollback never touches bundles bought under either catalogue (decisions.md → "Current customers keep their terms until their bundle ends").

## What is switched

| Piece | Where | Off (today) | On |
|---|---|---|---|
| **Catalogue switch** | Owner: `POST /api/admin/catalogue/mode {"mode":"unlimited"}` (audited as `catalogue.mode_changed`) | Customers buy the current plans. | Customers buy only the published Unlimited bundles; the earlier plans are archived, still honoured. |
| **Device slots** (#334) | Needs device approval live on the router (Admin → Network setup → assisted connections). The catalogue view reports `deviceApproval`. | — | Personal Unlimited bundles bind their slots to the MAC RouterOS sees. |
| **Sharing rules** (#335) | Network setup → preview `{"kind":"router","plan":"sharing"}`, apply, keep. | No `ndahi:sharing-` rules. | TTL 1 toward Personal Unlimited sessions; IPv6 forwarding blocked on the HotSpot. |
| **Home WISP** (#336) | `NDAHI_HOME_ENABLED=true` on the API, after NDAHI Home's readiness checks. | Checkout refuses Home WISP Unlimited. | Home WISP runs on the registered router. |

The switches are independent. **Turn the catalogue on last**, once the others are in place and tested.

## Before every step: check a live legacy bundle

Pick one customer on a **legacy bundle** (for example Weekly or Connect Family) with a device online, and one legacy NDAHI Home household if there is one. Before and after **each** step below, check:

- [ ] The legacy customer still browses, on the same devices, with the same data left and end date (Admin → the voucher).
- [ ] Their phone's hotspot still shares (legacy sessions are never matched by the sharing rules).
- [ ] The NDAHI Home household still browses behind its router.
- [ ] Nothing in Admin → Router commands has failed.

Stop and roll back the step if any check fails.

## Rollout

### 1. Staging (test environment, test HotSpot)

1. Deploy the same release as production.
2. Run the on-site test plans on the test HotSpot and fill in their results tables:
   - device slots: `unlimited-device-slots-test-plan.md` (#334);
   - sharing rules: `unlimited-sharing-rules-test-plan.md` (#335);
   - Home WISP: `home-wisp-test-plan.md` (#336).
3. Copy every result into `unlimited-hardware-test-report.md`.
4. Go on only when every row passes, or the owner has accepted a known failure in writing on #337.

### 2. Prepare production (RB5009), switch still off

1. **Device approval:** Admin → Network setup → turn on assisted connections (device approval) if it isn't on. Check that `GET /api/admin/catalogue` reports `"deviceApproval": true`.
2. **Sharing rules:** Network setup → preview, apply and keep the sharing rules on the RB5009 (`unlimited-sharing-rules-test-plan.md` → "Apply the rules"). With the switch off no session is on `ndahi-personal`, so the rules match nothing yet.
3. **Home WISP (optional now):** pass NDAHI Home's readiness checks (`ndahi-home-readiness.md`), then set `NDAHI_HOME_ENABLED=true` on the API. Or leave it off and unpublish Home WISP Unlimited in Admin → Bundles until Home is ready. Checkout refuses Home WISP while Home is off.
4. **Catalogue:** in Admin → Bundles, check prices, publication and order.
5. Check the legacy bundle (above).

### 3. One access point

The catalogue switch is site-wide; access points can't be switched one by one. Use one AP as the test area:

1. Switch on: `POST /api/admin/catalogue/mode {"mode":"unlimited"}`.
2. On that AP, with test phones, buy a Personal Unlimited bundle (1 device) and a Home WISP bundle if Home is on.
3. Repeat staging tests 2–3 of #334 and 1–2 of #335 on the RB5009.
4. Check the legacy bundle.
5. Watch for an hour: payments, Admin → Router commands, and `/system resource print` (CPU, since Personal traffic skips FastTrack).
6. If anything fails, roll back (below) and record what failed on #337.

### 4. All access points

1. Leave the switch on.
2. Announce the new bundles.
3. For the first day, check Admin → Payments, Router commands and Customers (time left, slots) a few times, and keep checking the legacy bundle once a day until the last legacy bundle ends.

## Rollback

Rollback stops new Unlimited sales and removes the router rules. It **keeps all new data**: every Unlimited order, voucher, device registration and audit entry stays, and there is no destructive down-migration. Bundles already bought keep their own terms until they end.

1. **Switch the catalogue back:** `POST /api/admin/catalogue/mode {"mode":"legacy"}`. The current plans are on sale again at once; Unlimited bundles are off sale (checkout answers "no longer on sale").
2. **Remove the sharing rules** if they cause trouble. On the RB5009:

   ```
   /ip firewall mangle remove [find where comment="ndahi:sharing-ttl"]
   /ip firewall filter remove [find where comment~"^ndahi:sharing-"]
   /ipv6 firewall filter remove [find where comment~"^ndahi:sharing-"]
   ```

   Running Personal Unlimited bundles keep working, but without the TTL restriction.
3. **Home WISP:** to stop new Home WISP sales, unpublish it in Admin → Bundles, or set `NDAHI_HOME_ENABLED=false`. Turning Home off also makes the Home worker withhold access for running Home bundles, legacy NDAHI Home included, so prefer unpublishing while any are running.
4. **Device slots** need no rollback: they apply only to Personal Unlimited bundles, and switching back stops new ones being sold.
5. Check the legacy bundle (above), and record the rollback and its reason on #337.

Running Unlimited bundles bought before a rollback keep working until they end: their slots, their sharing rule (while the rules are on) and their Home WISP router.
