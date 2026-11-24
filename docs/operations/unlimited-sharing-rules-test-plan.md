# Personal Unlimited sharing rules: on-site test plan (#335)

Run on the **test HotSpot first**, then on the RB5009, before the Unlimited catalogue is switched on (#337). Post the filled results table on #335. #337's rollout uses these results.

**What this restricts, and what it doesn't.** TTL and Hop Limit restrict ordinary forwarding; they do not guarantee that all proxying or packet rewriting is blocked. A phone or router that rewrites TTL, or a proxy app, can still share. Customer copy says "restricts sharing", never "prevents" or "blocks all sharing".

## What the rules do

Network setup adds five firewall rules, each with a comment starting `ndahi:sharing-`. Every IPv4 rule matches only the `ndahi-personal` address list.

| Rule | Where | What it does |
|---|---|---|
| `ndahi:sharing-ttl` | `/ip firewall mangle`, first in the `forward` chain | Sets **TTL to 1** on forwarded internet replies leaving the router toward a Personal Unlimited session. The phone can use them, but anything it forwards them to gets TTL 0 and is dropped. |
| `ndahi:sharing-established-in` and `-out` | `/ip firewall filter`, just above the FastTrack rule | Accept established Personal Unlimited traffic before FastTrack. FastTracked packets skip mangle, so without these the TTL rule would only see the first packets of a connection. All other traffic keeps FastTrack. |
| `ndahi:sharing-ipv6-in` and `-out` | `/ipv6 firewall filter`, first in the `forward` chain | Drop IPv6 forwarding to and from the HotSpot interface. |

**Who is matched.** A HotSpot session joins `ndahi-personal` only when its bundle's own terms say Personal Unlimited: its HotSpot user gets a `ndahi-users-<n>-<approval|presence>-personal-v1` profile with `address-list=ndahi-personal`. RouterOS adds the session's address when it logs in and removes it when it logs out, expires or is removed, so reconnects, address changes, expiry and device replacement follow the session. Bundles added later in Admin, and the owner's custom Personal Unlimited gifts, are matched the same way, because the profile follows the access type, not a bundle id.

**Who is never matched.** Legacy bundles (data plans, Gig Standard, vouchers issued before the switch, NDAHI Home) keep their `ndahi-users-<n>-…-v1` profiles, which are never changed, so their sessions never join the list. Home WISP routers (#336) get their own profile without the list, so they keep sharing. No exception rule is needed for them.

**IPv6.** HotSpot sign-in covers IPv4 only, and per-device IPv6 authorization isn't built yet. Until it is, and its Hop Limit rule passes this plan's IPv6 tests, IPv6 forwarding stays blocked on the HotSpot interface (the rollout safeguard in #335). The preview refuses to apply if the HotSpot interface has an IPv6 address, so the block can't take IPv6 away from anyone who uses it today. IPv6 neighbour discovery and the router's own services are not forwarded traffic and keep working.

**Queues (#326).** The `ndahi: no fasttrack for hotspot` rules from `router-command-queue.md` already keep all HotSpot traffic off FastTrack. If they are present, the two `sharing-established` rules change nothing; they make the TTL rule independent of them. The TTL rule runs first in the mangle `forward` chain, so a queue's mark rule with `passthrough=no` can't skip it. Traffic that skips FastTrack uses more router CPU: watch `/system resource print` during test 2.

## Before you start

- Router: the test HotSpot (later the RB5009, in a quiet window). Write down the RouterOS version and board.
- Admin → Network setup: the saved router connection works, and **device approval is on** (#334). No provisioning job is waiting for confirmation.
- `NETWORK_PROVISIONING_ENABLED=true` on the API of the test environment.
- Catalogue switch on **in the test environment only** (owner: `POST /api/admin/catalogue/mode {"mode":"unlimited"}`).
- **Phone A**: a Personal Unlimited bundle (for example 24 hours · 1 device), registered on NDAHI Wi-Fi.
- **Phone B**: any phone that can join Phone A's hotspot. **Mobile data off on every phone** throughout.
- A **test WISP router** enrolled on a Personal Unlimited bundle, with a laptop behind it. For the IPv6 tests, use a router that actually routes IPv6 to its downstream clients.
- A **legacy bundle** (for example Weekly or Connect Family) on another account, with a phone online that shares its connection by hotspot.
- A laptop with WinBox or SSH to read the rules.

## Apply the rules

1. Signed in to Admin as the owner, open the browser console on the Admin page and preview:

   ```js
   const api = window.NDAHI_CONFIG.apiUrl;
   const csrf = (await (await fetch(`${api}/api/admin/dashboard`, { credentials: "include" })).json()).csrfToken;
   const post = (action, body) => fetch(`${api}/api/admin/network/setup/${action}`, { method: "POST", credentials: "include",
     headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) }).then((r) => r.json());
   const { job } = await post("preview", { kind: "router", plan: "sharing" });
   job.plan.conflicts; job.plan.operations;
   ```
2. Check the preview: **no conflicts**, and five `create` operations on the interface you expect (`vlan20-hotspot` on the RB5009). A conflict about IPv6 on the HotSpot interface means stop and raise it on #335.
3. Apply within 15 minutes: `await post("apply", { jobId: job.id, reviewed: true });`
4. Admin → Network setup → **Provisioning history** shows the job *awaiting confirmation*. The router keeps an encrypted backup and rolls everything back after about 10 minutes unless you keep the changes.
5. Within the deadline, quickly check: Phone A browses, and the legacy phone browses. Then tick the box and **Keep changes**. Run the full tests below after keeping.
   - If anything is wrong before keeping: **Roll back**.

On the router, `/ip firewall filter print where comment~"ndahi:sharing-"` lists both accept rules **above** the `fasttrack-connection` rule, and `/ip firewall mangle print where comment~"ndahi:sharing-"` lists the TTL rule first in `forward`.

## Tests

Test IPv4 and IPv6 separately, with mobile data off.

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | **Registered phone browses** | On Phone A, open several sites and run a speed test. | Works as before. `/ip firewall mangle print stats where comment="ndahi:sharing-ttl"` counts packets. |
| 2 | **Hotspot sharing restricted (IPv4)** | Turn on Phone A's hotspot. Join Phone B to it and try to browse. | Phone B can't load pages through ordinary forwarding. Phone A still browses. |
| 3 | **WISP router on Personal Unlimited (IPv4)** | Connect the test WISP router as the Personal Unlimited device, and the laptop behind it. | The router itself can reach the internet; the laptop can't browse through it. |
| 4 | **IPv6 blocked** | On the laptop behind the test WISP router, open `https://ipv6.google.com` or run `ping -6 2001:4860:4860::8888`. Repeat on Phone A. | No IPv6 internet for any HotSpot client. `/ipv6 firewall filter print stats where comment~"ndahi:sharing-ipv6"` counts any attempts. |
| 5 | **Unauthenticated or expired client** | Connect a phone with no bundle, and one whose test bundle has expired. | Neither reaches the internet over IPv4 or IPv6. |
| 6 | **Replacement device inherits the rule** | Replace Phone A with Phone C (#334 test 6). Repeat test 2 with Phone C sharing. | Phone C browses; a phone behind Phone C's hotspot can't. `/ip firewall address-list print where list=ndahi-personal` shows Phone C's address, not Phone A's. |
| 7 | **Legacy session still shares** | On the legacy bundle, turn on its phone's hotspot and join another phone to it. | The phone behind it browses, exactly as before the rules. Its address is **not** in `ndahi-personal`. |
| 8 | **Home WISP still shares** | After #336: an authorized Home WISP router with a laptop behind it. | The laptop browses on the protocols enabled for its plan. |
| 9 | **Idempotent** | Preview again: `await post("preview", { kind: "router", plan: "sharing" })`. | No operations: "Configuration already matches" if applied. |
| 10 | **Rollback** | On the test HotSpot only: apply on a router without the rules, wait past the deadline without keeping. | After about 10 minutes the five rules are gone and the job shows *recovery required* or *rolled back*; legacy and Personal phones browse as before. |

## Turn the rules off after keeping them

Keeping removes the automatic rollback. To remove the rules later, on the router:

```
/ip firewall mangle remove [find where comment="ndahi:sharing-ttl"]
/ip firewall filter remove [find where comment~"^ndahi:sharing-"]
/ipv6 firewall filter remove [find where comment~"^ndahi:sharing-"]
```

Personal Unlimited phones then share like any other session. The `-personal-` HotSpot profiles stay; their address list is harmless without the rules.

## Record the results

| # | Date | Router (test HotSpot / RB5009) | RouterOS version | IPv4 pass / fail | IPv6 pass / fail | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | n/a | |
| 2 | | | | | n/a | |
| 3 | | | | | n/a | |
| 4 | | | | n/a | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |
| 9 | | | | | | |
| 10 | | | | | | |

Also note the router's CPU load during test 2, and anything that differed from this plan.
