# DAP-1360 C1: isolated functionality evaluation

## Known facts and limits

The user supplied H/W C1 and F/W label 3.00 on 5 November 2026 and confirmed the
unit is not joined to NDAHI Connect. The label is not a runtime firmware reading.
No connection, reset, firmware flash or settings change has been performed.

D-Link's [RevC security notice SAP10495](https://supportannouncement.us.dlink.com/security/publication.aspx?name=SAP10495)
lists firmware 3.04 and earlier as affected and RevC as end-of-support, with no
security remediation available. The supplied 3.00 label falls in that range.
This unit is an isolated functionality candidate, not a supported production
acceptance device. Do not treat a successful NAT test as security approval.

The official [RevC manual](https://ftp.dlink.de/dap/dap-1360/documentation/DAP-1360_man_revc_Manual_en.pdf),
printed pages 18–19 and 41–42, describes WISP Repeater as a routed/NAT mode for
wired and wireless clients, while WISP Client Router serves wired clients.
Its radio operates at 2.4 GHz. These mode names differ from ordinary Repeater or
Bridge. Confirm the actual firmware offers an independent private SSID/password;
the current evidence does not establish that capability. If unavailable, this
single unit does not meet the complete private household Wi-Fi journey.

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
| H/W and label F/W | User-reported C1 / 3.00 |
| Runtime firmware/settings access | Pending |
| Joined to isolated upstream | Not done |
| Independent private SSID/password | Not verified |
| One upstream NAT identity with two private clients | Not tested |
| NDAHI native quota/expiry and recovery | Not tested |
| Production Home enablement | Disabled; not approved by this evaluation |

Record actual successes and failures. Keep the original supported-model pilot
candidate and all physical KPI gates pending; no compatibility promise is made
for other DAP-1360 hardware revisions or firmware.
