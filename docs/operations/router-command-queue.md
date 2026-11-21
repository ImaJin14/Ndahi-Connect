# RouterOS command queue (NET-001)

Voucher sync, disconnect (from expiry, quota exhaustion, suspension, revocation,
or a customer/admin ending a device session), the inactive-session marker, and
the admin-triggered usage pull no longer call the MikroTik bridge synchronously
inside a request or webhook transaction. Each side effect is recorded as a
durable command and applied by a background worker outside any database lock.

Records use the existing `routerCommands` collection and normalized `events`
table (`kind = 'router_command'`). No database migration is required. Enqueuing
a command is a plain state write; no network I/O happens inside the transaction
that enqueues it, so a slow or unreachable router can no longer hold open the
single write lock the store uses for every request.

## Commands

- `sync_voucher`: register a voucher (id, code, plan, expiry, quota, device
  limit) with the router.
- `disconnect_voucher`: disconnect all sessions for a voucher.
- `disconnect_device`: disconnect one device by ID.
- `mark_inactive`: tell the router to drop sessions it considers stale.
- `sync_usage`: pull usage readings and apply them to vouchers monotonically
  (a reading is only ever used to raise `usedBytes`, matching the previous
  admin-triggered behavior). See [Router counter restarts](#router-counter-restarts).

A command's ID is derived from its action and target (`router:<action>:<target>`),
so enqueuing the same action for the same target while an attempt is already
queued, processing, or retrying is a no-op. Enqueuing again after a command has
finished (`processed`) starts a fresh cycle; total attempts still accumulate.

## Automatic processing

A background worker starts when the server listens and runs every 15 seconds
(`NETWORK_QUEUE_INTERVAL_SECONDS`), processing up to 25 due commands per pass.
`NETWORK_QUEUE_ENABLED=false` disables this background worker only; commands
are still enqueued and visible in the store. Two paths that previously blocked
the caller on the router call — resale voucher redemption/claim and the admin
usage-sync endpoint — still resolve synchronously: they enqueue and then
process that one command inline before responding, so their response shape and
timing are unchanged from before this change.

- `queued`: durable command awaiting processing.
- `processing`: claimed with a lease (router timeout + 15 seconds).
- `retry`: last attempt failed. Backoff is 30, 60, 120, 240... seconds,
  doubling per attempt and capped at one hour (five minutes for `sync_usage`,
  which keeps usage counting and quotas enforced).
- `dead_letter`: the attempt limit (`NETWORK_QUEUE_MAX_ATTEMPTS`, default 8 —
  roughly an hour of retrying) was reached, or the failure was permanent (a
  `sync_voucher` command whose voucher no longer exists dead-letters on its
  first attempt rather than retrying pointlessly). See NET-003
  (`router-command-dead-letter.md`) for review, alerting, and replay. A
  dead-lettered `sync_usage` (about 22 minutes of failed reads) alerts as usual,
  then the usage scheduler queues it again after a 15-minute cool-down
  (`network.usage_read_resumed` event); before 18 November 2026 usage stopped
  counting until an operator replayed it.
- `processed`: the router accepted the command.

Voucher-affecting commands (`sync_voucher`, `disconnect_voucher`) set
`routerSyncStatus` on the voucher: `pending` while queued/retrying, `dead_letter`
if the command exhausts its attempts, and `synchronized` or `disconnected` once
the worker succeeds. `routerError` holds the last failure reason. The command's
completion and the voucher's status commit atomically, so a crash between the
router call and the completion transaction leaves the command `processing`
with a lease that expires and is safely reclaimed — it does not leave a
voucher's router status stuck on a lie.

## Router counter restarts

A reading is the hotspot user's own counters plus its live sessions, i.e. what
the router has counted since those counters last started. RouterOS restarts
them from zero when the router reboots (for example after a power cut) or the
hotspot user is re-created. Since 18 November 2026 the worker notices this when
a user's own counters (`counterBytes`) go down, or when a voucher's total stays
below its recorded usage for 45 seconds or more (one lower reading is normal: a
session ending between the router's two reads is missed once). It then:

- keeps the usage counted so far in `routerUsageOffset` and adds new readings to it;
- records `routerCountersRestartedAt` and a `network.usage_counters_restarted` event;
- re-syncs an active fixed-quota voucher, so the router's `limit-bytes-total`
  becomes the data actually left instead of the whole quota again.

Before this, recorded usage froze until the new counters passed it, and the
router allowed the full quota again. Admin voucher detail shows when usage was
last read from the router, and warns when an active bundle has not been read for
ten minutes.

## Verification and limits

Run `node --test test/router-queue.test.mjs test/integration.test.mjs
test/postgres-schema.test.mjs test/state-migration.test.mjs test/retention.test.mjs`,
`npm run check`, and `npm test`. Tests use a fake router adapter; no live
MikroTik bridge is contacted. Tests cover idempotent enqueue, requeue after
completion, bounded exponential backoff, restart/crash recovery via an expired
lease, that a hanging router call no longer blocks the HTTP response, and that
a fresh server picks up commands enqueued before it started.

Before production rollout, confirm queue drain and `routerSyncStatus` recovery
against a MikroTik bridge in staging. No live-router or deployed-environment
verification is implied by local tests. NET-002 (RouterOS reconciliation)
repairs drift through this same queue; NET-003 (`router-command-dead-letter.md`)
adds the attempt limit, alerting, and operator replay controls described above.

## Bundle speed limits (#263)

A bundle can carry a download and upload limit in Mbps (`downloadMbps`, `uploadMbps`, set through the admin bundle API). Every voucher records the limits of the plan it was issued from (`speedSnapshot`). A purchase keeps the speed it was bought with, and later catalogue edits never change it.

**One limit shared by the bundle's devices.** This is the owner's decision of 19 November: two devices on a 10 Mbps bundle share 10 Mbps.
- **How the router applies it:** one simple queue per bundle, `ndahi-speed-<voucherId>`, with comment `ndahi:speed:<voucherId>`. Its `target` is the addresses of that bundle's devices online now, and its `max-limit` is upload/download in bit/s.
- **How it stays current:** when the usage sync sees the device list change, it queues `sync_speed`.
- **Removal:** the queue is removed once the bundle has no device online, no limit, or has ended.
- **Unmanaged queues:** a queue with the same name but another comment is never touched.
- **Timing:** a newly connected device is limited from the next usage read.

**Off by default.** Nothing changes on the router until the API service has `ROUTER_SPEED_LIMITS=on`.
- **Where it's set:** `render.yaml` declares it with `sync: false`. Set it in Render → `ndahi-api` → Environment; it's never committed as on.
- **Allowed values:** unset and `off` change nothing. Any value other than `on` or `off` fails `npm run check:environment -- ndahi-api`, which stops the deploy.
- **When:** turn it on only after the check below.

**1. Know which path reaches the router.**
- **Saved router:** Admin → Network setup shows "Use saved router for vouchers" switched on. The API calls RouterOS itself (`lib/router-hotspot.mjs`, deployed with the API), so there is nothing to update on site.
- **Bridge:** if that switch is off, the API posts to the on-site bridge at `MIKROTIK_API_URL`, which runs `npm run start:bridge` (`scripts/network-bridge.mjs`).
  - The bridge must run a version with `POST /ndahi/syncSpeedQueue`: commit `a610005` (#307) or later.
  - An older bridge answers 404 "Unknown bridge action", so every `sync_speed` command would fail and be dead-lettered.
  - Update the bridge first (see *Updating the bridge* below).

**2. The RouterOS service user.** It needs read and write on `/queue/simple`, which the `write` policy covers; that user already writes hotspot users. Check with:

```routeros
/user print detail where name=<ROUTER_REST_USER>
/user group print detail where name=<that user's group>
```

**3. Exclude the hotspot network from FastTrack.**
- Fast-tracked traffic skips simple queues, and the default configuration has a `fasttrack-connection` rule in the forward chain.
- At the time of writing the hotspot network is 10.20.0.0/24 on `vlan20-hotspot`. Confirm with `/ip address print where interface=vlan20-hotspot`.

```routeros
/ip firewall filter print where action=fasttrack-connection
# If exactly one rule is listed, accept hotspot traffic before it, both ways:
/ip firewall filter add chain=forward action=accept connection-state=established,related src-address=10.20.0.0/24 place-before=[find where action=fasttrack-connection] comment="ndahi: no fasttrack for hotspot (upload)"
/ip firewall filter add chain=forward action=accept connection-state=established,related dst-address=10.20.0.0/24 place-before=[find where action=fasttrack-connection] comment="ndahi: no fasttrack for hotspot (download)"
/ip firewall filter print where comment~"ndahi: no fasttrack"
```

Both new rules must sit above the fasttrack rule. Connections already fast-tracked keep skipping queues until they close, so reconnect the test devices after adding the rules.

**4. Check on the RB5009, with only a test bundle limited.** The switch covers every bundle with a limit, so in Admin → Bundles make sure no other bundle has one during the check.
1. In Admin → Bundles → Edit, give a test bundle a low limit (for example 2 Mbps down, 1 Mbps up), and issue a voucher from it.
2. Turn the switch on (step 5), connect two devices with that voucher, and wait a minute.
   - `/queue simple print where name~"ndahi-speed"` shows one queue with both addresses and `max-limit=1000000/2000000`.
   - Simple queues are matched in order and the first match takes the traffic. If `/queue simple print` lists other queues above it that match the same addresses (for example dynamic hotspot queues, flag `D`), the bundle queue never sees the traffic. Stop, and turn the switch off again.
3. Run a speed test on both devices at once. Together they stay near the limit. The queue's counters (`/queue simple print stats where name~"ndahi-speed"`) rise while the tests run.
4. Run `/ip firewall filter print stats where comment~"ndahi: no fasttrack"`: both rules count packets, and the fasttrack rule's counter stops rising for hotspot traffic.
5. Disconnect both devices. The queue is removed after the next usage read.

**5. Turn it on, or back off.**
- **On:** Render → `ndahi-api` → Environment → `ROUTER_SPEED_LIMITS` = `on` → Save, rebuild and deploy. The deploy's environment check accepts only `on` or `off`.
  - Admin → Bundles → Edit no longer says "Not applied on the router yet".
  - Admin → Router commands shows `sync_speed` commands completing, none failing.
- **Off:** set `off` and deploy. The API stops changing queues but doesn't remove the ones already on the router, so remove them:

  ```routeros
  /queue simple remove [find where comment~"^ndahi:speed:"]
  ```

  Remove the FastTrack exceptions only if you want FastTrack back for the hotspot, and only after the queues are gone.

**Updating the bridge.**
- Only for the bridge path in step 1. The bridge host needs Node 22 (`node -v`). On the bridge host, in its checkout of this repository:
  ```sh
  git fetch origin && git checkout <tag or commit at or after a610005>
  npm ci --omit=dev
  ```
  Then restart the service that runs `npm run start:bridge` with its existing environment (`ROUTER_REST_*`, `BRIDGE_*`, `MIKROTIK_USER`, `MIKROTIK_PASSWORD`).
- **Confirm the new action from the host.** An authenticated empty request must reach the router code, not 404:
  ```sh
  curl -sk -u "$MIKROTIK_USER:$MIKROTIK_PASSWORD" -X POST "https://$BRIDGE_HOST:$BRIDGE_PORT/ndahi/syncSpeedQueue" -d '{}' -o /dev/null -w '%{http_code}\n'
  ```
  It prints `502`: "Invalid bundle speed queue." is rejected as a failed operation. `404` means the bridge is still the old version.
  - `-k` only skips verification of the bridge's own certificate on this local check.
  - Run the command with `set +o history`, or read the password from the service's environment file, so it doesn't stay in shell history.
