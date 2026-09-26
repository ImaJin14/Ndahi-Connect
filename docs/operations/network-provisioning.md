# Network setup and provisioning

The owner dashboard has a **Network setup** tab. It saves encrypted management connections, discovers equipment, previews changes, runs durable provisioning jobs, and provides confirmation and recovery controls. Operators, resellers, and auditors cannot use these setup APIs. Existing voucher operations retain their existing permissions.

## Deployment prerequisites

The server must reach the router and controller over a private management network or tunnel. A factory-reset device cannot be reached through the public dashboard without this initial connection. Bootstrap that connection locally, retain a wired recovery port, and configure trusted HTTPS certificates. For RouterOS REST, enable `www-ssl` with its certificate and restrict its source addresses; `api-ssl` on port 8729 is a different protocol. Never disable certificate verification. Use `NODE_EXTRA_CA_CERTS` for an internal CA.

Configure these backend variables (do not put them in frontend configuration):

```dotenv
NETWORK_CONFIG_KEY=<64 hexadecimal characters from 32 random bytes>
NETWORK_ALLOWED_ORIGINS=https://router.management.example,https://controller.management.example:8043
NETWORK_PROVISIONING_ENABLED=false

# Use these when connections will be entered in the dashboard instead of
# configuring the existing bridge/token adapters through environment variables.
NETWORK_ROUTER_SOURCE=saved
NETWORK_OMADA_SOURCE=saved
MIKROTIK_MODE=live
OMADA_MODE=live
```

Generate the key with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. Store it in the deployment secret manager and backup recovery vault. All API replicas and recovery tools must use the same key. Losing or replacing it makes saved credentials, Wi-Fi recovery settings, and backup passwords unreadable. Rotation requires an offline re-encryption migration; do not simply replace the environment variable.

The origin allowlist accepts exact HTTPS origins, including non-default ports. No URL credentials, paths, queries, fragments, or redirects are allowed. DNS and tunnel configuration remain deployment responsibilities. Live provisioning remains disabled until a lab test has passed and `NETWORK_PROVISIONING_ENABLED=true` is set. Connection discovery and previews work while writes are disabled. Simulation is available only outside production and never activates voucher enforcement.

Connections use AES-256-GCM encryption with fresh nonces and authenticated context. Credentials are never returned to the browser. Blank secret fields keep an existing secret only for the same target URL. Normalized PostgreSQL stores connections in `app_settings.networkSetup` and jobs as `events` of kind `network_setup_job`; no new table migration is required after the existing normalized schema has been installed. Local JSON persistence is also supported. Terminal jobs are archived after 90 days; unresolved jobs are retained. Encrypted archives need the original encryption key.

## MikroTik workflow

1. Save the router's HTTPS origin and restricted service credentials, then select **Discover router**. Discovery rejects RouterOS versions outside major version 7. The installed script commands and exact device firmware still require lab validation.
2. Select a WAN interface and a dedicated, unused AP port. Enter the private hotspot gateway/prefix, DHCP range, external DNS servers, and hotspot DNS name.
3. Review the preview. Existing bridge membership, overlapping IP subnets, unmanaged resource-name conflicts, and invalid address ranges block apply. Existing WAN DHCP is reused. This first topology assumes a DHCP internet uplink and untagged AP traffic; static WAN, PPPoE, VLAN trunks, multi-router, and multi-site provisioning are not supported by this planner.
4. Apply. The backend rechecks the plan against current router state, creates an encrypted binary backup on the router, installs an on-router rollback script and watchdog, applies only `ndahi:*` managed resources, and reads the configuration back.
5. Test Wi-Fi, Hotspot login, internet access, and management reachability. Select **Keep changes** within eight minutes. The watchdog runs rollback after approximately ten one-minute scheduler ticks. A separate boot scheduler rolls back on reboot while the job remains unconfirmed.
6. After confirming the topology, select **Use saved router for vouchers**. This explicitly switches new voucher commands and usage reads to the encrypted saved connection. Existing voucher queue/reconciliation logic is reused. New configurations do not silently change the enforcement target.

The planner configures the bridge, AP bridge port, IPv4 addressing, DHCP pool/server/network, DHCP WAN client when needed, source NAT, a routed client-isolation rule, and Hotspot server/profile. Existing firewall rules are preserved; the preview calls this out because their order can still block service or override intended policy. Wireless and layer-2 client isolation must be verified on the controller/AP/switch. No automatic firewall-wide rewrite, factory reset, firmware upgrade, or management-port move is performed.

Router provisioning uses a physical-management service account with read/write/policy/test/sensitive permissions as needed for backups and schedulers. Review least privilege in the lab. Router backup files and rollback scripts stay on the device; remove obsolete ones only after verifying you retain a usable recovery copy. Watchdog behavior has automated transport/plan tests but must be exercised on the actual RouterOS release before enabling production writes.

## Voucher enforcement and management bridge

The saved-router adapter provisions an owned Hotspot user, byte limit, shared-user profile, and absolute-expiry scheduler. Expiry is checked every 30 seconds on the router, so synchronize its clock with NTP. Quota zero disables the voucher; an unlimited quota maps to the RouterOS zero/no-limit setting. Revocation disables the user and removes active sessions and cookies. Usage imports preserve the backend's existing monotonic-counter check.

Browser device IDs are not trusted MAC addresses. Individual-device disconnection fails explicitly unless a trusted hotspot MAC mapping exists. The new adapter reports session mapping as unavailable, so reconciliation does not incorrectly mark browser sessions offline. Per-device disconnection, the branded captive-portal handoff, and quota behavior across router reboots need field validation/integration before claiming a complete live customer journey. Voucher-wide revocation is supported independently of browser IDs.

For an on-site bridge deployment, `npm run start:bridge` implements the existing `/ndahi/syncVoucher`, `/ndahi/disconnectDevice`, `/ndahi/disconnectVoucher`, `/ndahi/readUsage`, `/ndahi/readState`, and `/ndahi/markInactive` contract over HTTPS. Configure:

```dotenv
ROUTER_REST_URL=https://router.management.example
ROUTER_REST_USER=<router service user>
ROUTER_REST_PASSWORD=<router service password>
BRIDGE_TLS_KEY=/secure/path/bridge.key
BRIDGE_TLS_CERT=/secure/path/bridge.crt
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8443
MIKROTIK_USER=<bridge service user>
MIKROTIK_PASSWORD=<at least 24 characters>
```

Bind only to the required private/tunnel interface. The backend's existing `MIKROTIK_API_URL` points to the bridge HTTPS origin; backend `MIKROTIK_USER`/`MIKROTIK_PASSWORD` authenticate to the bridge, not to RouterOS. The bridge exposes only the listed actions, limits request size and pending work, serializes operations, and returns sanitized errors. Do not run the saved-router and legacy bridge paths against different live gateways without a planned migration.

## Omada workflow and compatibility profiles

Create a site-scoped **Client mode** Open API application in the controller's **Platform Integration** settings. Save its interface origin, controller ID, site ID, WLAN group ID, client ID, and client secret in the dashboard. The backend obtains access tokens server-side and paginates device and SSID inventory. Read-only discovery does not require a write profile.

Write endpoints and request field schemas must be checked against that controller's **Online API Document**. Set `OMADA_PROVISIONING_PROFILE` to a JSON object matching the schema below. There is deliberately no guessed universal write profile: without a matching version probe, adoption and SSID configuration stay disabled.

```json
{
  "versionPath": "/openapi/<documented controller information path>",
  "versionField": "<version field in result>",
  "versions": ["<exact lab-tested controller version>"],
  "ssid": {
    "defaults": {},
    "fields": {
      "name": "<name payload field>",
      "security": "<security payload field>",
      "password": "<password payload field>",
      "vlan": "<VLAN payload field>",
      "isolation": "<client isolation payload field>"
    },
    "values": {
      "security": {"open": "<documented enum>", "wpa2": "<documented enum>"}
    },
    "update": {"method": "PATCH", "path": "/openapi/<documented update path>/{ssidId}"},
    "create": {"method": "POST", "path": "/openapi/<documented create path>"}
  },
  "adopt": {
    "method": "POST",
    "path": "/openapi/<documented adoption path>",
    "payload": {},
    "macField": "<MAC payload field>",
    "stateField": "<device status field>",
    "pendingStates": ["<documented pending state>"],
    "adoptedStates": ["<documented adopted state>"]
  }
}
```

This is a schema illustration, not a deployable controller profile. Methods must come from the controller document; `PATCH`/`POST` above are placeholders. Dotted field paths are supported. Path placeholders are `{controllerId}`, `{siteId}`, `{wlanId}`, `{ssidId}`, and `{mac}`; values are URL-encoded. `defaults` supplies other required vendor fields. Optional `values` mappings translate UI values to vendor enums. All five SSID settings, including isolation, must be mapped. Omit `create` or `adopt` if unsupported. The profile must return matching field paths in SSID inventory for safe preview/read-back/restore. Masked passwords or incomplete before-images block updates because they cannot be safely restored.

The UI supports open hotspot/WPA2, untagged or explicit VLAN IDs, SSID create/update, and supported AP adoption into the configured site. VLAN selection does not provision a switch or gateway trunk. Existing SSID updates save an encrypted before-image and offer verified rollback. Uncertain create responses and adoption require recovery in the controller, because ownership cannot safely be inferred from a name alone. No controller-wide automatic backup is claimed.

## Failure and restart recovery

Jobs are persisted before execution. Network I/O happens outside the application database transaction. The worker resumes queued jobs every 30 seconds, rechecks the live-write gate, and claims them transactionally. Repeated apply requests do not replay physical mutations. Cancel a queued job to discard it before it starts.

Running jobs interrupted by an API restart are not blindly retried. After ten minutes they require recovery. The router watchdog is independent of the API. **Check device status** checks whether the watchdog is armed; missing watchdogs do not automatically count as success. Use **Roll back**, or recover locally and explicitly record manual recovery. New jobs and connection replacement remain blocked while recovery is unresolved. Same-target password rotation for an active router requires a successful discovery with the replacement credentials.

**Backup recovery details** reveals the router backup filename and password to the owner, with a separate audit entry. Download that binary backup from RouterOS Files before modifying the device. Restore it locally with WinBox if management reachability is lost; a full backup restore reboots the router. Do not trigger an old rollback script after later configuration changes.

## Validation and rollout

Automated checks: `npm run check`, `npm test`. Optional browser test: install Playwright separately, set `PLAYWRIGHT_MODULE` to its `index.mjs` if needed and `CHROME_PATH` to Chrome, then run `node scripts/check-network-ui.mjs`. It starts isolated in-memory servers, exercises the simulation flow, and writes desktop/mobile screenshots under `/tmp/ndahi-network-qa` by default.

Before production activation, record the actual MikroTik model/firmware, AP models, controller version/profile, and wiring diagram. On an isolated gateway/AP, verify backup restore, loss of tunnel during apply, API restart during apply, router reboot before confirmation, stale preview rejection, repeated setup, DHCP/DNS, Wi-Fi isolation, captive portal login, voucher quota/expiry/shared-user enforcement, revocation, and usage after reboot. Then pilot a single gateway/AP with a wired recovery connection. Multi-site, arbitrary WAN types, firmware management, and radio tuning remain outside this first supported topology.

References: [MikroTik REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api/), [RouterOS scheduler](https://help.mikrotik.com/docs/spaces/ROS/pages/40992881/Scheduler), [RouterOS scripting](https://manual.mikrotik.com/docs/developer-guides/scripting/), [TP-Link Open API cookbook](https://static-community.tp-link.com/attach/5/8/2024/5618de6a9a5246198042214da4090186.pdf).
