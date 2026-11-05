# DAP-1360 C1: isolated functionality evaluation

## Known facts and limits

The user supplied H/W C1 and F/W label 3.00 on 5 November 2026, disconnected its
Ethernet uplink from the MikroTik, and connected this PC's Wi-Fi (`wlo1`) to its
offline `dlink` setup network (BSSID ending `88:39`) using a temporary local-only
`192.168.0.49/24` profile (`ipv4.never-default=yes`) while preserving the wired
`enp4s0` default route. No settings change, reset, firmware flash, or upstream
connection to NDAHI Connect was performed, and the temporary Wi-Fi profile was
removed afterward.

Read-only HTTP/DOM inspection of `http://192.168.0.50/` (`GET`/`HEAD`/`OPTIONS`
only; all `POST` and external requests blocked; saved locally at
`/tmp/ndahi-dap-ui-inspection.json`) verified:

- **Runtime hardware/firmware (`/st_device.htm`):** `Hardware Version: C1`,
  `Firmware Version: 3.00 , 09, Nov, 2011`, LAN and Wireless MAC ending
  `88:39`.
- **Current state (`/st_device.htm`, `/lan.htm`, `/wireless.htm`):** Operating in
  `Access Point` mode (`mode0=0`), SSID `dlink`, security `Open / Disabled`, WPS
  `Enable / Unconfigured`, and LAN IPv4 `Dynamic IP (DHCP)` (`lan_type=1`, fallen
  back to `169.254.192.144` with uplink unplugged; static fallback address is
  `192.168.0.50/24` with an internal DHCP server range `192.168.0.100–200`
  disabled by default). Because `mode0=0` and `lan_type=1`, plugging its Ethernet
  port into the MikroTik bridges wireless clients directly onto the MikroTik LAN.
- **Wizard vs manual modes (`/wizard_select.htm` vs `/wireless.htm`):** The Setup
  Wizard (`#mode_select`) offers only `Access Point` (`0`), `Repeater` (`4`), and
  `Wireless Client` (`1`). The manual Wireless Setup page (`#mode0` on
  `/wireless.htm`) exposes all seven modes: `Access Point` (`0`),
  `Wireless Client` (`1`), `Bridge` (`2`), `Bridge with AP` (`3`),
  `Repeater` (`4`), `WISP Client Router` (`5`), and `WISP Repeater` (`6`).
- **Single-SSID constraint in WISP modes (`/wireless.htm`):** Selecting
  `WISP Client Router` (`5`) or `WISP Repeater` (`6`) reveals `WAN Settings`
  (`#wanType`: `Static IP`, `Dynamic IP(DHCP)`, `PPPoE`, `PPTP`, plus `hostName`,
  `dhcpMtuSize`, `dnsMode`, `wan_macAddr`). However, `/wireless.htm` provides only
  a **single** SSID field (`#ssid0`) and a **single** wireless security block
  (`#authType` / `#pskValue0` / `#wepKey0`), which configure the upstream (root)
  AP connection. Firmware 3.00 does **not** expose a second, independent local
  SSID or separate downstream WPA2 passphrase in `WISP Repeater` mode. If the
  upstream hotspot uses an open SSID, this UI provides no way to configure a
  separate WPA2-secured household network on the same unit. This is a UI-based
  compatibility finding; upstream association and wireless isolation have not
  been tested. Using its NAT (`WISP Client Router`) with a
  private WPA2 household SSID requires either a downstream AP on its Ethernet LAN
  port or a dual-VAP/WISP-router model that supports independent WAN client and
  LAN AP security.

D-Link's [RevC security notice SAP10495](https://supportannouncement.us.dlink.com/security/publication.aspx?name=SAP10495)
lists firmware 3.04 and earlier as affected and RevC as end-of-support, with no
security remediation available. The verified running 3.00 firmware (09 Nov 2011)
falls in that range. This unit is an isolated bench candidate only, not a
supported production acceptance device. Do not treat a bench NAT test as security
or standalone-CPE approval.

## Prepare an isolated test

1. Preserve the connected RB5009 management/recovery path through ether8. Do not
   attach an unknown DHCP server to that LAN or reset either the AP or RB5009.
2. Use an isolated bench network, synthetic customers and test clients without
   private data. Production Home stays disabled. A later full application pilot
   needs a separate test backend/database and provider test account, with tested
   router preparation from `ndahi-home.md`; these are not established here.
3. Open the D-Link's own settings on that isolated network and record runtime
   firmware, mode, LAN/WAN addresses and available private Wi-Fi controls. Never
   send administrator passwords in chat, logs or issue evidence.
4. Confirm that the isolated upstream test SSID is available on 2.4 GHz and maps
   to the intended test HotSpot/VLAN. Preserve the production SSID/VLAN policies.
5. Select the verified routed/NAT mode described above, use upstream DHCP, and
   choose an unused private LAN subnet distinct from the upstream and recovery
   networks. Enable only the LAN DHCP service and verify private Wi-Fi security.
   Keep remote administration, DMZ, WPS and unsolicited forwarding disabled.
6. From two test clients, verify private addresses, correct gateway, one observed
   upstream connection and combined traffic. Do not infer NAT from an SSID name,
   printed MAC, or public source IP alone.
7. Only after isolation, credentials and gateway prerequisites are established,
   execute the synthetic link/assignment/quota/expiry/renewal/reboot/replacement
   checklist in `ndahi-home.md`. Do not trigger a real Mobile Money request or
   use a customer's entitlement as a test fixture.

Before any native Home test, verify migration 008 in the isolated target database
with a read-only query. The production health endpoint does not prove these
indexes exist:

```sql
SELECT indexname FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN ('home_active_mac_unique', 'home_linked_customer_unique',
                    'home_operations_due');
```

All three must be present, with their reviewed definitions, before enablement.
This query has not been run against production in this verification.

## Current acceptance

| Item | State |
| --- | --- |
| H/W and running F/W | Verified `C1` / `3.00 , 09, Nov, 2011` (MAC ending `88:39`) |
| Runtime firmware/settings access | Verified read-only on isolated `192.168.0.50` (`mode0=0`, `lan_type=1`, `dlink` open AP) |
| WISP modes in manual UI (`/wireless.htm`) | `WISP Client Router` (`mode0=5`) and `WISP Repeater` (`mode0=6`) present with WAN DHCP/Static/PPPoE/PPTP |
| Independent private SSID/password | No independent controls exposed on F/W 3.00 (single `#ssid0` and `#authType` shared with root AP); runtime isolation not tested |
| Joined to isolated upstream | Not done |
| One upstream NAT identity with two private clients | Not tested (requires wired LAN clients or a downstream AP in `WISP Client Router` mode) |
| NDAHI native quota/expiry and recovery | Not tested |
| Production Home enablement | Disabled; not approved by this evaluation |

Record actual successes and failures. Keep the original supported-model pilot
candidate and all physical KPI gates pending; no compatibility promise is made
for other DAP-1360 hardware revisions or firmware.
