# NDAHI Home RouterOS 7 REVIEW TEMPLATE. No command below has been run live.
# Refuse whole-file import: resolve interface/destinations/rule ordering first.
:error "Review ndahi-home.md and execute approved scoped commands individually"

# Keep NDAHI_HOME_ENABLED=false. Export configuration; preserve ether8 recovery.
# Replace vlan20-hotspot below with the actual ndahi-hotspot interface.
# Existing HotSpot needs valid HTTPS certificate/DNS and correct clock/NTP.
# Do not add a comment to HotSpot USER PROFILES (RouterOS rejects it).
/ip hotspot user profile add name=ndahi-home-enrollment-v1 shared-users=1 session-timeout=2m idle-timeout=none keepalive-timeout=2m address-list=ndahi-home-enrollment rate-limit="" add-mac-cookie=no

# Populate ndahi-home-required ONLY with reviewed portal/API/payment destination
# addresses. These EXAMPLE addresses are reserved documentation IPs, not a
# production allowlist. Replace with the exact dependency inventory; audit CDN
# address sharing. Maintain the separate unauthenticated HotSpot walled garden.
/ip firewall address-list add list=ndahi-home-required address=192.0.2.10 comment="ndahi:home:required:portal-EXAMPLE"
/ip firewall address-list add list=ndahi-home-required address=192.0.2.11 comment="ndahi:home:required:api-EXAMPLE"
# Add reviewed provider/asset/status hosts individually. Do not allow 0.0.0.0/0,
# entire private ranges or arbitrary WireGuard management addresses.

# Return to the EXISTING HotSpot policy; never accept general traffic here.
/ip firewall filter add chain=ndahi-home-enroll action=return dst-address-list=ndahi-home-required comment="ndahi:home:enroll:permit-required"
/ip firewall filter add chain=ndahi-home-enroll action=drop comment="ndahi:home:enroll:drop-general"
/ip firewall filter add chain=ndahi-home-forward action=return src-address-list=ndahi-home-live comment="ndahi:home:forward:permit-live"
/ip firewall filter add chain=ndahi-home-forward action=return dst-address-list=ndahi-home-required comment="ndahi:home:forward:permit-required"
/ip firewall filter add chain=ndahi-home-forward action=drop comment="ndahi:home:forward:drop-general"

# Both jumps MUST precede established/related accepts and FastTrack. Add in
# reverse order at place-before=0 so enrollment becomes the FIRST forward rule.
# Review resulting order, including dynamic rules; API rejects other first rules.
/ip firewall filter add chain=forward action=jump src-address-list=ndahi-home-clients jump-target=ndahi-home-forward place-before=0 comment="ndahi:home:entry:1"
/ip firewall filter add chain=forward action=jump src-address-list=ndahi-home-enrollment jump-target=ndahi-home-enroll place-before=0 comment="ndahi:home:entry:0"

# Audit each existing FastTrack rule. Edit ONLY its reviewed .id, retaining its
# other conditions, to exclude the guest interface in BOTH directions. Never
# bulk rewrite all FastTrack rules. Examples intentionally commented:
# /ip firewall filter set *REVIEWED-ID in-interface=!vlan20-hotspot out-interface=!vlan20-hotspot
# Clear affected pre-existing FastTrack connections in the maintenance window
# using reviewed exact session tuples; changing rules alone is not sufficient.

# If IPv6 is already globally disabled, leave it unchanged. Otherwise apply a
# scoped FIRST forward drop from the actual guest interface, without narrowing
# protocol/address/port matches. Do not disable IPv6 globally for this feature.
/ipv6 firewall filter add chain=forward in-interface=vlan20-hotspot action=drop place-before=0 comment="ndahi:home:drop-guest-ipv6"

# Do not add static ndahi-home-live permits or unrestricted IP bindings.
# The adapter owns per-generation users, profiles and calendar/volatile guards.
# Inspect script errors and packet captures, then complete every hardware gate.
# Rollback: drain/disable exact affected users and sessions FIRST; retain counters
# and records. Remove individually inventoried Home resources only after verified
# revocation. See ndahi-home.md; no broad deletes, reset or global IPv6 changes.
