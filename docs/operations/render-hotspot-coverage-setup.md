# Render portal accessible through the NDAHI hotspot

This walkthrough uses the confirmed MikroTik RB5009UPr+S+IN, TP-Link EAP650-Outdoor, standard Starlink, and `https://portal.ndahiconnect.net/login`.

The portal, customer API, admin dashboard, and database stay on Render. A separate cloud VM provides a WireGuard endpoint with a dedicated public IPv4 address and a restricted HTTPS relay for router management. No on-site computer is required.

These are configuration templates and application change instructions. They have not been applied to the hardware or Render. The two application integrations in steps 13–14 are **not currently installed** in the repository. Do not expect the end-to-end journey to work before implementing and deploying them.

The initial design sends customer IPv4 internet traffic through the cloud gateway using MikroTik's main routing table. This avoids relying on unsupported HotSpot policy-routing behavior. Account for the cloud gateway's transfer allowance, throughput, and added latency. AP management and the existing wired recovery LAN can keep using Starlink directly via a separate routing table.

```text
Customer phone
    |
NDAHI Connect SSID / VLAN 20
    |
EAP650-Outdoor
    | ether2: untagged AP management + tagged VLAN 20
RB5009UPr+S+IN
    | ether1
Starlink
    | encrypted WireGuard connection
Cloud gateway: dedicated public IPv4
    |
Render customer portal and API

Render API --> authenticated HTTPS relay on cloud gateway
           --> WireGuard --> router REST API
```

## 1. Record the values before configuring anything

| Item | Example used below |
| --- | --- |
| Portal | `https://portal.ndahiconnect.net` |
| API | `https://api.ndahiconnect.net` — verify in Render |
| Admin | `https://admin.ndahiconnect.net` — verify in Render |
| Local HotSpot login hostname | `connect.ndahiconnect.net` |
| Router certificate hostname | `router.ndahiconnect.net` |
| Cloud relay hostname | `gateway.ndahiconnect.net` |
| Starlink uplink | `ether1` |
| AP uplink | `ether2` |
| Wired recovery connection | `ether8`, existing LAN configuration |
| Guest interface | `vlan20-hotspot` |
| Guest network | `10.20.0.0/22` |
| Guest gateway | `10.20.0.1` |
| Guest DHCP range | `10.20.0.20–10.20.3.250` |
| AP management network | `192.168.50.0/24` |
| AP management gateway | `192.168.50.1` |
| AP management address | `192.168.50.2` |
| Existing recovery LAN | `192.168.88.0/24` — substitute the actual subnet |
| Cloud WireGuard address | `10.77.0.1/24` |
| Router WireGuard address | `10.77.0.2/24` |
| Cloud public IPv4 | `VPS_PUBLIC_IP` — replace everywhere |
| Cloud public NIC | `VPS_NIC`, often `ens3`, `eth0`, or `enp1s0` |
| Current Starlink DHCP gateway | `STARLINK_GW` — obtain from the router |

Do not reuse these subnets if they overlap an existing network or VPN. `VPS_PUBLIC_IP`, `VPS_NIC`, `STARLINK_GW`, key strings, passwords, and Render outbound CIDRs are placeholders, not executable values.

## 2. Back up and inspect the router

1. Connect a laptop to `ether8` and sign into WinBox using the existing working recovery configuration.
2. In Files, create an encrypted binary backup and download it. Also export a configuration with sensitive values omitted. Keep both privately.
3. Record the RouterOS version and the existing port, route, DHCP, and firewall configuration:

```routeros
/system resource print
/system device-mode print
/interface bridge port print
/ip address print
/ip dhcp-client print detail
/ip route print detail
/ip firewall filter print
/ip firewall nat print
/interface ethernet poe print
```

4. Confirm RouterOS 7 and that HotSpot, Scheduler, and Proxy are enabled in device-mode. HotSpot is needed for captive authentication; Scheduler is needed by the shipped voucher expiry adapter. On this installation, the generated hostname walled-garden entries remained inactivated until the separate Proxy permission was enabled. If one is `no`, finish or roll back the current Safe Mode session, then run:

```routeros
/system device-mode update hotspot=yes scheduler=yes proxy=yes
```

Within the confirmation window shown by the router, physically disconnect all router power inputs briefly and reconnect them. This interrupts the router and its PoE-powered AP. A normal software reboot does **not** confirm the change. Reconnect and run `/system device-mode print`; verify `hotspot: yes`, `scheduler: yes`, and `proxy: yes`. If all were already enabled, skip the update and power cycle. Setting only these feature options preserves the other mode settings. This grants device-mode permission; it does not require enabling a separate general-purpose proxy listener.

Reference: [MikroTik device-mode changes and physical confirmation](https://manual.mikrotik.com/docs/system-information-and-utilities/device-mode/).
5. Confirm `ether1` is the Starlink uplink and that reassigning `ether2` will not disconnect an existing service. Retain `ether8` and its existing LAN.
6. Use WinBox Safe Mode during each network stage. Verify the stage, then commit it before starting the next stage. Do not reset the router or import the repository's pilot script over an unknown existing configuration.

## 3. Connect and power the AP

1. Connect Starlink's Ethernet handoff to `ether1`. With a Starlink kit whose router remains in the path, enable bypass mode according to that kit's instructions; an Ethernet adapter depends on the kit generation.
2. Power the RB5009 using its suitable 48 V supply. Its PoE output does not turn a 24 V supply into 48 V.
3. Connect `ether2` directly to the EAP650-Outdoor Ethernet port. Use outdoor-rated cabling and the AP's waterproof cable seal outdoors.
4. Enable automatic PoE detection on the AP port and disable PoE output toward Starlink:

```routeros
/interface ethernet poe set ether1 poe-out=off
/interface ethernet poe set ether2 poe-out=auto-on
/interface ethernet poe monitor ether2 once
```

5. Confirm the AP powers on and Ethernet links. This router supports 802.3af/at output, and the EAP supports 802.3at or 48 V passive PoE. If the actual supply or cable arrangement is unsuitable, use the AP's supplied injector instead; do not force power detection.

References: [RB5009 specifications](https://mikrotik.com/product/rb5009upr_s_in), [EAP650-Outdoor specifications](https://www.omadanetworks.com/uk/business-networking/omada-wifi-outdoor/eap650-outdoor/), [RouterOS PoE controls](https://manual.mikrotik.com/docs/hardware/poe-out/).

## 4. Separate guest Wi-Fi from AP management

This example uses a dedicated, unbridged `ether2`. Management traffic is untagged; customer traffic is tagged VLAN 20. The existing recovery LAN remains separate.

1. If `ether2` belongs to the existing LAN bridge, remove **that port only**, after confirming the laptop is connected through another port:

```routeros
/interface bridge port remove [find where interface=ether2]
```

2. Create the AP management network and its initial DHCP service:

```routeros
/ip address add address=192.168.50.1/24 interface=ether2 comment="ndahi:ap-management"
/ip pool add name=ndahi-ap-management ranges=192.168.50.20-192.168.50.50
/ip dhcp-server add name=ndahi-ap-management interface=ether2 address-pool=ndahi-ap-management disabled=no
/ip dhcp-server network add address=192.168.50.0/24 gateway=192.168.50.1 dns-server=192.168.50.1
/interface vlan add name=vlan20-hotspot interface=ether2 vlan-id=20
/ip address add address=10.20.0.1/22 interface=vlan20-hotspot comment="ndahi:guest-gateway"
```

3. Ensure the router's firewall permits administration from the existing recovery LAN to the AP management network. Do not allow guest clients into that network.
4. Find the AP's initial address under IP → DHCP Server → Leases.
5. Open that address from the wired administration laptop. Use the existing controller if the AP is already adopted; otherwise configure it in standalone mode.
6. Set the AP management address to `192.168.50.2/24`, gateway and DNS `192.168.50.1`, or reserve that address for its actual management MAC. Keep its management VLAN untagged for this example.
7. Use separate customer SSIDs so the selected band is visible in the connection name:

| Setting | Value |
| --- | --- |
| 2.4 GHz-only SSID | `NDAHI Connect 2.4GHz` |
| 5 GHz-only SSID | `NDAHI Connect 5GHz` |
| Customer VLAN on both SSIDs | 20 |
| Client/SSID isolation | Enabled |
| Omada portal authentication | Disabled for this SSID |
| Wi-Fi security | Open for the initial captive-portal pilot |

In standalone mode, edit the SSID separately under each band in Wireless → Wireless Settings, then confirm VLAN 20 for each under Wireless → VLAN (or the SSID's own VLAN field, depending on firmware). In a controller, create two wireless networks and select only the corresponding band for each, with VLAN 20 on both. Save each change and reconnect clients using the new names.

Check `/interface ethernet monitor ether2 once`. The EAP650-Outdoor's uplink supports 1 Gbps; the deployed link was observed negotiating at 100 Mbps while `ether1` negotiated at 1 Gbps. Check the cable, terminations, and any injector/switch along that path with a known-good short Cat5e/Cat6 cable before tuning software. Keep auto-negotiation enabled. A 100 Mbps link limits capacity but does not by itself explain a measured 23 Mbps result.

The observed comparison was 100/24 Mbps down/up with 24 ms unloaded latency on direct Starlink, versus 23/6.1 Mbps and 220 ms through NDAHI. The latter showed the cloud gateway's public IP and US test servers. The tests therefore used different network paths; after the uplink and band checks, measure cloud-tunnel throughput separately. Changing SSID names alone does not remove this route or its latency.

8. Delete or disable factory/test SSIDs after confirming administration works. Avoid a second guest SSID that bypasses MikroTik enforcement.

If a managed switch sits between the router and AP, its router/AP ports must carry tagged VLAN 20 and untagged AP management traffic. A standalone PoE injector normally passes Ethernet VLAN tags transparently.

The repository's automatic router planner supports untagged AP traffic, not this VLAN design. Configure this topology manually; do not run its topology provisioning over it. The saved-router voucher adapter can still operate against the resulting HotSpot server.

Reference: [TP-Link SSID VLAN and isolation configuration](https://www.tp-link.com/us/configuration-guides/configuring_eap_standalone_eap/).

## 5. Create the cloud networking gateway

1. Create a fresh Ubuntu 24.04 LTS cloud VM with a dedicated, retained public IPv4 address and SSH key access. Do not use a shared consumer VPN exit.
2. Size bandwidth and network throughput for customer internet traffic. This initial design routes that traffic through the VM; it is not only a management tunnel.
3. In the cloud provider firewall allow SSH from your administration address, UDP 51820 for WireGuard, and TCP 80 for certificate validation. TCP 443 will be limited to the API service's Render outbound ranges in step 11.
4. SSH into the VM and install the packages:

```bash
sudo apt update
sudo apt install wireguard iptables nginx certbot python3-certbot-nginx
ip -4 route show default
```

5. Record the interface shown after `dev` in the default route as `VPS_NIC`.
6. Enable IPv4 forwarding:

```bash
sudo tee /etc/sysctl.d/90-ndahi-forwarding.conf >/dev/null <<'EOF'
net.ipv4.ip_forward=1
EOF
sudo sysctl --system
```

7. Generate the cloud WireGuard private/public key pair into root-only files. Only the public key is copied to the router:

```bash
sudo install -d -m 700 /etc/wireguard
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/cloud.key; wg pubkey < /etc/wireguard/cloud.key > /etc/wireguard/cloud.pub'
sudo cat /etc/wireguard/cloud.pub
```

Private keys stay on their owning devices. Do not send them in chat, commit them, or put them in frontend configuration.

## 6. Create the router's WireGuard interface

In the router terminal:

```routeros
/interface wireguard add name=wg-ndahi listen-port=51820 mtu=1420
/ip address add address=10.77.0.2/24 interface=wg-ndahi
```

Find the interface's **public key** in WinBox → Interfaces → WireGuard. Copy that public key for the cloud peer configuration. Do not export the private key.

Add the cloud peer, replacing the placeholders:

```routeros
/interface wireguard peers add interface=wg-ndahi public-key="CLOUD_PUBLIC_KEY" endpoint-address=VPS_PUBLIC_IP endpoint-port=51820 allowed-address=0.0.0.0/0 persistent-keepalive=25s
```

The router initiates the connection through Starlink; no inbound port forwarding through Starlink is required. The broad allowed-address on this **trusted cloud peer** permits internet destinations; routes and firewall rules still determine what uses it.

Reference: [WireGuard quick start](https://www.wireguard.com/quickstart/), [RouterOS WireGuard](https://manual.mikrotik.com/docs/virtual-private-networks/wireguard/).

## 7. Configure and start WireGuard on the cloud VM

1. Open `/etc/wireguard/wg0.conf` with `sudoedit`.
2. Replace `VPS_NIC`, `CLOUD_PRIVATE_KEY`, and `ROUTER_PUBLIC_KEY`. Insert the cloud private key from its local file using your local editor; do not transmit it elsewhere.
3. On a fresh VM, ensure any existing host firewall permits the following WireGuard forwarding rules. Do not mix this example with an unknown pre-existing UFW/Docker/nftables ruleset.

```ini
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = CLOUD_PRIVATE_KEY

PostUp = iptables -I FORWARD 1 -i %i -o VPS_NIC -s 10.20.0.0/22 -j ACCEPT
PostUp = iptables -I FORWARD 1 -i %i -o VPS_NIC -s 10.77.0.2/32 -j ACCEPT
PostUp = iptables -I FORWARD 1 -i VPS_NIC -o %i -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostUp = iptables -I INPUT 1 -i %i -s 10.20.0.0/22 -j DROP
PostUp = iptables -t nat -A POSTROUTING -s 10.20.0.0/22 -o VPS_NIC -j MASQUERADE
PostUp = iptables -t nat -A POSTROUTING -s 10.77.0.2/32 -o VPS_NIC -j MASQUERADE

PostDown = iptables -D FORWARD -i %i -o VPS_NIC -s 10.20.0.0/22 -j ACCEPT
PostDown = iptables -D FORWARD -i %i -o VPS_NIC -s 10.77.0.2/32 -j ACCEPT
PostDown = iptables -D FORWARD -i VPS_NIC -o %i -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
PostDown = iptables -D INPUT -i %i -s 10.20.0.0/22 -j DROP
PostDown = iptables -t nat -D POSTROUTING -s 10.20.0.0/22 -o VPS_NIC -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s 10.77.0.2/32 -o VPS_NIC -j MASQUERADE

[Peer]
PublicKey = ROUTER_PUBLIC_KEY
AllowedIPs = 10.77.0.2/32, 10.20.0.0/22
```

4. Start it:

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

5. Check that a recent handshake appears. From the router:

```routeros
/ping 10.77.0.1 count=5
```

Proceed only after the private tunnel works. Guest traffic retains its `10.20.0.0/22` source inside the tunnel; the VM performs public NAT. Do not add a guest masquerade rule on the router's WireGuard interface for this version of the design.

Reference: [Ubuntu WireGuard gateway configuration](https://ubuntu.com/server/docs/how-to/wireguard-vpn/vpn-as-the-default-gateway/).

## 8. Route customer traffic through the cloud gateway

1. Obtain the current `gateway` from the bound `ether1` DHCP client.
2. Pin the cloud endpoint to Starlink **before** changing the default route:

```routeros
/ip route add dst-address=VPS_PUBLIC_IP/32 gateway=STARLINK_GW%ether1 comment="ndahi-wg-endpoint"
/ip route add dst-address=162.159.200.1/32 gateway=STARLINK_GW%ether1 comment="ndahi-ntp-bootstrap"
/ip dhcp-client set [find where interface=ether1] default-route-distance=10
/ip route add dst-address=0.0.0.0/0 gateway=10.77.0.1 distance=1 routing-table=main comment="ndahi-cloud-default"
```

3. If the router has other active default routes or routing/mangle rules, reconcile them first. Do not leave an equally preferred direct default route that can split customer connections between Starlink and the tunnel.
4. To keep the example recovery LAN and AP management network using Starlink directly, create a separate table. Local destinations must use the main table before the source-based direct rules:

```routeros
/routing table add name=ndahi-direct fib
/ip route add dst-address=0.0.0.0/0 gateway=STARLINK_GW@main routing-table=ndahi-direct comment="ndahi-direct-default"
/routing rule add dst-address=10.20.0.0/22 action=lookup-only-in-table table=main
/routing rule add dst-address=10.77.0.0/24 action=lookup-only-in-table table=main
/routing rule add dst-address=192.168.50.0/24 action=lookup-only-in-table table=main
/routing rule add dst-address=192.168.88.0/24 action=lookup-only-in-table table=main
/routing rule add src-address=192.168.50.0/24 action=lookup-only-in-table table=ndahi-direct
/routing rule add src-address=192.168.88.0/24 action=lookup-only-in-table table=ndahi-direct
```

Keep these local-destination exceptions ahead of the two source rules. Substitute the actual recovery subnet. The existing Starlink masquerade rule should cover the direct management subnets; inspect it instead of adding a duplicate.

5. Add drop rules at the beginning of the forward chain to prevent guest fallback and prevent other LANs from using the customer tunnel:

```routeros
/ip firewall filter add chain=forward in-interface=vlan20-hotspot out-interface=!wg-ndahi action=drop place-before=0 comment="ndahi:guest tunnel required"
/ip firewall filter add chain=forward out-interface=wg-ndahi in-interface=!vlan20-hotspot action=drop place-before=0 comment="ndahi:guest-only tunnel forwarding"
/ip firewall filter add chain=forward in-interface=vlan20-hotspot dst-address=10.77.0.0/24 action=drop place-before=0 comment="ndahi:block guest tunnel management"
```

These do not block traffic generated by the router itself, such as DNS and NTP. If the forward chain has a final drop, add a guest-to-WireGuard accept rule **below HotSpot's dynamic authentication rules** and above that final drop. Never place a broad guest accept before HotSpot's authentication rules.

6. Disable FastTrack for the initial pilot so it cannot bypass hotspot accounting/enforcement:

```routeros
/ip firewall filter disable [find where action=fasttrack-connection]
```

7. In IP → DHCP Client → ether1 → Script, append this lease hook to any existing required script rather than overwriting it:

```routeros
:if ($bound=1) do={
    :local nextHop ($"gateway-address" . "%ether1")
    /ip route set [find where comment="ndahi-wg-endpoint"] gateway=$nextHop
    /ip route set [find where comment="ndahi-direct-default"] gateway=($"gateway-address" . "@main")
    :local ntpRoute [/ip route find where comment="ndahi-ntp-bootstrap"]
    :if ([:len $ntpRoute] > 0) do={ /ip route set $ntpRoute gateway=$nextHop }
}
```

8. Renew the lease in a controlled test and verify the endpoint, direct-default, and NTP routes update. If there is no DHCP client or a different WAN setup, this lease hook must be adapted.

Keep guest IPv6 routing and router advertisements disabled, and block guest IPv6 forwarding on `vlan20-hotspot`. Configure that restriction on the guest interface rather than blindly disabling IPv6 on unrelated networks. The current HotSpot implementation enforces IPv4.

Reference: [HotSpot routing and IPv4 limitations](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/).

## 8A. Selective egress for the existing installation

The measured gateway RTT was 224 ms after the AP cable problem was fixed. The
reviewed live configuration uses the main cloud default, a distance-10 DHCP
Starlink default, two MSS-only mangle rules, and a WAN-list masquerade. To remove
the cloud detour from ordinary customer traffic, use the migration prepared in
`/tmp/ndahi-selective-egress-v2/` and the downloadable ZIP at
`/tmp/ndahi-selective-egress-v2.zip`. These files contain site-specific commands
and were kept local. The first import stopped at a read-only preflight, and the
subsequent route output confirmed no migration changes. V2 counts matching
entries directly and reads enabled state separately. The user subsequently ran
the V2 dry-run successfully, then applied it successfully on the physical
router. The supplied output confirms the cloud default is disabled, the DHCP
Starlink default is active, both portal VPN routes are active, and both fallback
blackholes are unselected. Guest latency, portal/API access, outside-coverage
denial, and unauthenticated guest enforcement still need post-migration checks.

Current portal/API destinations were checked as `216.24.57.16` and
`216.24.57.18`. The migration adds specific VPN routes and higher-distance
blackhole routes in the main table, narrows the existing guest tunnel guard to
those destinations without moving it ahead of HotSpot rules, and disables the
old cloud default. Ordinary traffic then uses the existing Starlink default and
masquerade. The WireGuard endpoint route, NTP bootstrap route, management policy
rules, IPv6 restrictions, disabled FastTrack, and local HotSpot enforcement stay
in place.

Run `/import file-name=ndahi-selective-apply-v2.rsc verbose=yes dry-run` first;
`dry-run` is a bare switch, without `=yes`. Stop on any error. Use Safe Mode over
a wired WinBox session, and verify the portal/API both work inside coverage and remain denied
outside. An authenticated guest should show Starlink at a general IP-check site
after this migration; the earlier full-tunnel IP-check expectation no longer
applies. Test an unauthenticated guest and revoke a designated test voucher to
confirm enforcement before committing the changes. The files include rollback
commands and tunnel-down verification steps. Specific routes and the guard list
must be reviewed if Render changes the destination addresses; the application
coverage guard rejects new unrouted addresses instead of opening access.

The existing portal/API restriction was verified to return HTTP 403 and the
coverage message from direct Starlink before preparing this migration. Keep
`COVERAGE_ALLOWED_IPS` set to the cloud gateway address, not the ISP address. The
portal itself retains the cloud-route latency; ordinary internet avoids it.

## 9. Prepare trusted certificates and local DNS

The cloud portal keeps Render's existing certificate. The **local router login** needs a separate trusted certificate because the browser will submit credentials to it.

1. On the cloud VM issue a DNS-validated RSA certificate for the local HotSpot and router-management names:

```bash
sudo certbot certonly --manual --preferred-challenges dns --key-type rsa \
  -d connect.ndahiconnect.net -d router.ndahiconnect.net
```

2. Add each TXT record requested by Certbot at the domain's DNS provider. Wait for propagation before continuing. These hostnames do not need to expose the router publicly; DNS-01 validates domain control through TXT records.
3. Transfer the issued `fullchain.pem` and `privkey.pem` to RouterOS Files through your private administration connection. Import both using System → Certificates → Import; identify the leaf certificate with its private key and rename **only that leaf** `ndahi-router-tls`. Keep the intermediate and root certificate names distinct. In `/certificate print`, the leaf should have the `K` private-key flag and common name `connect.ndahiconnect.net`; do not rename all imported certificates with an unrestricted `find`.
4. Remove the uploaded private-key file after successful import, retaining the original securely on the certificate-owning VM. Do not put it in Render or the repository.
5. Configure DNS on the router, permitting DNS requests only from the intended local networks:

```routeros
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8
/ip dns static add name=connect.ndahiconnect.net address=10.20.0.1
```

6. Do not change `portal.ndahiconnect.net` or `api.ndahiconnect.net` to a private router address; both still resolve to Render.
7. Synchronize the router clock with NTP; the existing voucher adapter enforces absolute expiry on the router. Use the direct Starlink host route created in step 8 so time synchronization can recover while WireGuard is down. Cloudflare documents `162.159.200.1` as one of its NTP servers. The following assumes the NTP server list is empty; inspect existing entries before adding a duplicate:

```routeros
/system clock set time-zone-autodetect=no time-zone-name=Africa/Douala
/system ntp client servers add address=162.159.200.1
/system ntp client set enabled=yes
/system ntp client print
/system clock print
```

Wait for `status: synchronized` and check the date and time. A router clock that moves backwards can also stop WireGuard handshakes: the responder discards initiation timestamps older than the greatest one previously accepted for that peer. Clock differences between peers alone do not establish that this is the failure; confirm recovery with a fresh handshake and tunnel traffic. If the direct NTP route is missing on an existing installation, add it once using the current WAN gateway before enabling NTP.

8. Record certificate expiry and a renewal date well before it. The manual DNS method requires repeating issuance and router import; `certbot renew` alone cannot automate a manual DNS challenge. For unattended operation, use the DNS provider's supported automation and a private deployment hook to update the router certificate.

Reference: [Let's Encrypt DNS-01 validation](https://letsencrypt.org/docs/challenge-types/), [Certbot manual and renewal behavior](https://eff-certbot.readthedocs.io/en/stable/using.html), [RouterOS NTP client](https://help.mikrotik.com/docs/spaces/ROS/pages/40992869/NTP), [Cloudflare NTP addresses](https://developers.cloudflare.com/time-services/ntp/usage/), [WireGuard handshake timestamp checks](https://www.wireguard.com/protocol/).

## 10. Configure MikroTik HotSpot

Before starting the wizard, check the current prerequisites:

```routeros
/system device-mode print
/interface bridge port print where interface=ether2
/interface vlan print detail where name=vlan20-hotspot
/ip hotspot print detail
/certificate print
```

- Device-mode must show `hotspot: yes`; enable `scheduler` as described in step 2 for voucher expiry.
- In this particular direct-port VLAN design, `ether2` must no longer be a port of the default bridge. If it is, connect the administration laptop through `ether8` and complete step 4's removal of **ether2 only**. A VLAN/DHCP service created on a bridge slave port will not work as intended.
- The VLAN must be enabled, use VLAN ID 20, and have parent `ether2`.
- If a HotSpot already exists on `vlan20-hotspot`, inspect and finish that server instead of rerunning the wizard and creating duplicate resources.
- The imported `ndahi-router-tls` leaf certificate must include its private key, match `connect.ndahiconnect.net`, and be valid according to the router's clock. If it is absent, complete step 9 before configuring the production HTTPS login.

1. In WinBox → IP → Hotspot → Hotspot Setup, select `vlan20-hotspot`.
2. Use the following values:

| Prompt | Value |
| --- | --- |
| Local address | `10.20.0.1/22` |
| Masquerade network | **No**, because the VM performs customer public NAT |
| Address pool | `10.20.0.20–10.20.3.250` |
| SSL certificate | `ndahi-router-tls` |
| SMTP server | `0.0.0.0` |
| DNS servers (wizard) | `1.1.1.1,8.8.8.8` |
| DNS name | `connect.ndahiconnect.net` |
| Initial local user | Temporary lab user with a unique password |

3. Rename the created server to **`ndahi-hotspot`**. The shipped voucher adapter expects that exact server name.
4. Read the new server's `profile` field and rename **that assigned profile** to `ndahi-profile` (the wizard commonly creates `hsprof1`). Do not confuse it with the built-in profile marked `*`. If the built-in profile was previously renamed `ndahi-profile`, restore its name to `default` first, then rename the actual assigned profile and explicitly bind the server to it. Set the active profile's login methods to HTTPS and cookie:

```routeros
/ip hotspot profile set [find where name="ndahi-profile"] login-by=https,cookie
/ip hotspot profile print detail where name="ndahi-profile"
```

Verify the result contains `login-by=cookie,https`, without `http-chap`. Do not include the obsolete `https-redirect` parameter in this command: it is absent from the current [HotSpot profile CLI reference](https://manual.mikrotik.com/docs/cli-reference/ip/hotspot/profile/), despite still appearing in the overview documentation. An unsupported parameter can reject the entire update. Use the fixed local HTTPS login URL for testing and captive-portal detection for discovery.
5. The wizard's DNS prompt uses upstream resolvers. After completing it, inspect IP → DNS and keep the router's upstream servers as `1.1.1.1,8.8.8.8`, with local DNS requests enabled and appropriately firewalled. In IP → DHCP Server → Networks, set the guest gateway and advertised DNS to `10.20.0.1`. Do not set the router's upstream DNS to its own guest address. Reuse the wizard-created guest DHCP server; do not create a duplicate.
6. Ensure firewall input rules permit guest DHCP, local DNS, and the actual HotSpot listener/redirect ports. RouterOS commonly uses TCP 64872–64875 and UDP 64872 internally for HotSpot DNS/proxy/login. Preserve the generated dynamic rules and verify their behavior against the installed release.
7. Restrict router management separately. Disable plain WebFig `www`, move `www-ssl` management to port 8443 in step 11, and block guest WinBox/SSH/API access. Do not expose management just to make the local login work.
8. Add walled-garden entries for the portal and API. For HTTPS, use the IP walled-garden hostname entries:

```routeros
/ip hotspot walled-garden ip add server=ndahi-hotspot action=accept protocol=tcp dst-port=443 dst-host=portal.ndahiconnect.net
/ip hotspot walled-garden ip add server=ndahi-hotspot action=accept protocol=tcp dst-port=443 dst-host=api.ndahiconnect.net
```

9. If Google-hosted fonts remain in the frontend, permit only their required hostnames or self-host the fonts. Add payment domains only if the browser actually visits them; a server-side payment call from Render does not require customer walled-garden access.
10. Add the exact Render customer/API service hostnames only if the browser actually uses them. Prefer the custom domains so the list stays small.
11. Connect a phone with mobile data disabled. Verify it receives a guest address, detects the captive portal, and can reach the Render portal/API without an active internet voucher. The original MikroTik login still serves until step 14 is deployed.
12. Test the temporary lab user and confirm paid-style internet traffic leaves through `VPS_PUBLIC_IP`. Remove the temporary user and any trial/bypass configuration after testing.

HTTPS IP exceptions can also allow other sites sharing a destination IP. Keep exemptions narrow and test the unpaid-access scope on the actual deployment.

## 11. Connect the Render backend to RouterOS securely

Use the shipped **saved-router REST adapter** through a restricted HTTPS relay on the cloud VM. This avoids installing an application server on site.

1. Create a router service account with a long unique password. For voucher operations it needs the read/write/policy/test and API/REST policies required to create users, profiles, and expiry schedulers. Add further permissions only if a tested operation requires them. Restrict the user to source `10.77.0.1/32`:

```routeros
/user group add name=ndahi-voucher-api policy=read,write,policy,test,api,rest-api
/user add name=ndahi-vouchers group=ndahi-voucher-api address=10.77.0.1/32 password="REPLACE_WITH_A_LONG_RANDOM_PASSWORD"
```

Generate the service password privately with `openssl rand -hex 24`, and save it in a password manager. This password belongs in the admin dashboard's **Service password** field and at the Ubuntu `curl --user ndahi-vouchers` prompt. It is separate from `NETWORK_CONFIG_KEY`, the 64-character key that encrypts saved connections in Render. If the service password is lost, an existing MikroTik administrator can set a replacement with `/user set ndahi-vouchers password="NEW_PRIVATE_SERVICE_PASSWORD"`; then save the new service password in the dashboard and discover the router again. This changes that account's credentials while preserving its group/source restriction and the network configuration. Retain the current `NETWORK_CONFIG_KEY` when rotating a router password.

2. Configure the HTTPS management service:

```routeros
/ip service set www disabled=yes
/ip service set www-ssl disabled=no port=8443 certificate=ndahi-router-tls available-from=10.77.0.1/32
```

Current releases call the service source restriction `available-from`; the old service argument `address` is deprecated. The user account's separate `address` argument above remains valid.

3. Permit the cloud VM's HTTPS management traffic through the router input firewall. Add this once, ahead of input drop rules:

```routeros
/ip firewall filter add chain=input action=accept in-interface=wg-ndahi src-address=10.77.0.1 protocol=tcp dst-port=8443 place-before=0 comment="ndahi:cloud REST access"
```

Keep guest management blocked. No Starlink/public WAN port forward is needed. Before configuring the Render relay, SSH into the cloud VM (`ssh root@VPS_PUBLIC_IP`, substituting the actual SSH account and address). Run the following inside that remote shell, not in the laptop's local terminal, to verify HTTPS, the certificate name, and REST authentication through the private tunnel. The source restriction permits only the VM's `10.77.0.1` address:

```bash
curl --fail-with-body --connect-timeout 10 --max-time 20 \
  --resolve router.ndahiconnect.net:8443:10.77.0.2 \
  --user ndahi-vouchers \
  https://router.ndahiconnect.net:8443/rest/system/resource
```

Enter the service-account password at the prompt; it is not included in the command or URL. A successful response is JSON containing the RouterOS version and board name. `--resolve` routes this test to the WireGuard address while preserving certificate validation against `router.ndahiconnect.net`; no public DNS record for the router is required. Resolve any timeout, authentication failure, or certificate error before proceeding to the public relay.

4. Add a public DNS A record `gateway.ndahiconnect.net` → `VPS_PUBLIC_IP`. Keep it DNS-only if the DNS provider has a proxy toggle.
5. In Render, open the **API service** → Connect → Outbound. Copy all outbound CIDRs. These are Render-to-router management sources, not customer sources.

For this deployment, the API service's reported outbound ranges on 2026-10-16 are `74.220.51.0/24` and `74.220.59.0/24`. Recheck Render if the service moves regions or its outbound configuration changes. These shared ranges are combined with the router service account's unique credentials.

6. Configure the cloud firewall's TCP 443 allowlist for those CIDRs. Keep your SSH restriction and WireGuard rule.

This VM is managed in IONOS Cloud Panel. Edit the TCP 443 row's **Allowed IP**, save with the checkmark, and create a second TCP 443 rule for the other Render range. If the source field does not accept CIDR, IONOS documents start/end range notation: `74.220.51.0-74.220.51.255` and `74.220.59.0-74.220.59.255`. Keep the `/24` notation in Nginx. The existing SSH, HTTP challenge, and WireGuard rules remain necessary during this step. See [IONOS firewall editing](https://www.ionos.com/help/server-cloud-infrastructure/firewall-vps/editing-a-firewall-policy-vps-migrated-cloud-servers-and-vps/) and [Cloud Panel IP range notation](https://www.ionos.com/help/server-cloud-infrastructure/firewall-policies/editing-a-firewall-policy/).

7. Create `/etc/nginx/sites-available/ndahi-gateway` using `sudoedit` with this initial HTTP virtual host:

```nginx
server {
    listen 80;
    server_name gateway.ndahiconnect.net;
    location / { return 404; }
}
```

Enable it and issue its certificate:

```bash
sudo ln -s /etc/nginx/sites-available/ndahi-gateway /etc/nginx/sites-enabled/ndahi-gateway
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d gateway.ndahiconnect.net
```

If a symlink already exists, edit that configuration rather than duplicating it.
8. Configure its HTTPS server with a restricted REST location. Replace each CIDR placeholder, and repeat `allow` for every applicable Render outbound range:

```nginx
server {
    listen 443 ssl;
    server_name gateway.ndahiconnect.net;
    ssl_certificate /etc/letsencrypt/live/gateway.ndahiconnect.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.ndahiconnect.net/privkey.pem;

    location /rest/ {
        allow 74.220.51.0/24;
        allow 74.220.59.0/24;
        deny all;

        proxy_pass https://10.77.0.2:8443;
        proxy_ssl_server_name on;
        proxy_ssl_name router.ndahiconnect.net;
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 3;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Host router.ndahiconnect.net;
    }

    location / { return 404; }
}
```

Replace the generated HTTPS block with this block; do not create a duplicate server for the same hostname. Keep the HTTP ACME configuration generated by Certbot for renewal. Alternatively, when replacing this site's entire file, keep the initial port-80 server above alongside the HTTPS server: the Nginx authenticator can install its temporary challenge configuration for renewal. Verify that path with the certificate-specific dry run below. Do not leave another default virtual host or broad proxy location exposing RouterOS. Authentication is performed by the restricted RouterOS service account over verified TLS. Render's outbound ranges may be shared with other tenants; the unique service credentials remain essential.

9. Run `sudo nginx -t`, reload Nginx, and test `sudo certbot renew --cert-name gateway.ndahiconnect.net --dry-run`. Select only this automatically renewed relay certificate; the separate manual DNS-validated router certificate requires its own renewal process.
10. Generate a persistent network encryption key privately, if one is not already configured. Preserve the existing key if saved connections already exist:

```bash
openssl rand -hex 32
```

11. In the Render API service configure:

```dotenv
NETWORK_ROUTER_SOURCE=saved
MIKROTIK_MODE=live
NETWORK_CONFIG_KEY=<persistent 64-character hexadecimal key>
NETWORK_ALLOWED_ORIGINS=https://gateway.ndahiconnect.net
NETWORK_PROVISIONING_ENABLED=false
```

Append the relay origin to an existing `NETWORK_ALLOWED_ORIGINS` list rather than discarding an existing controller origin. Update the Blueprint/environment declarations consistently with the repository's environment validation.

12. Redeploy the API. In Admin → Network setup, save a **live** MikroTik connection at `https://gateway.ndahiconnect.net` with the router service account, then select Discover router.
13. Confirm the discovery inventory shows the expected model and firmware. The existing `ndahi-hotspot` server is checked on the backend during activation; the discovery UI exposes only the sanitized device inventory. A successful HTTPS request alone does not establish voucher enforcement.
14. After the physical lab checks succeed, deploy the API release containing existing-hotspot activation support, set `NETWORK_PROVISIONING_ENABLED=true`, redeploy, then select **Use saved router for vouchers** and confirm the tested-hotspot requirement. The local source now supports read-only validation of an existing manually configured HotSpot without requiring a completed automatic provisioning job. It checks the HTTPS profile, guest gateway/DHCP/local DNS, synchronized NTP, and device-mode HotSpot/Scheduler flags, while still rejecting unresolved setup work and rollback watchdogs. This code change must reach Render before the manual activation path can work. Do not apply the automatic untagged topology planner to this manual VLAN configuration.
15. Confirm the UI reports the saved router as the active enforcement target. Preserve or migrate any existing live vouchers deliberately; changing adapter configuration does not automatically prove historical router state is synchronized.

References: [RouterOS REST and service-account policies](https://manual.mikrotik.com/docs/developer-guides/rest-api/), [Render outbound addresses](https://render.com/docs/outbound-ip-addresses), [Nginx upstream TLS verification](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [existing network runbook](network-provisioning.md).

## 12. Verify the network before restricting Render

1. Test the original HotSpot page using the temporary lab credentials before deleting that user.
2. From an authorized guest phone with mobile data off, check the public IPv4 using a public IP check page. It must equal the cloud VM's actual public exit IPv4.
3. Confirm the AP management address and recovery LAN do not use the guest exit route.
4. Disable the router's WireGuard interface briefly. Guest internet must stop; it must not fall back to direct Starlink access. Re-enable it and verify recovery.
5. Confirm AP management, WinBox, SSH, DNS, and the private management tunnel remain appropriately restricted.
6. Only now proceed with the application guard. Applying it before the tunnel works would lock customer access out.

## 13. Deploy and verify the Render coverage guard

The coverage guard is now implemented in `lib/coverage-access.mjs`, both server
entry points, and the Render/environment checks. Follow
[coverage-only customer access](coverage-access.md). The earlier template-only
instructions have been superseded by the implementation and its tests.

For this site's existing cloud gateway, keep both the customer and API services
configured with `COVERAGE_ACCESS_ENABLED=true` and
`COVERAGE_ALLOWED_IPS=209.46.126.73`, with `TRUST_PROXY=render`. Customer service
health probes use `/healthz`. Customer portal/API requests must use the cloud
exit; admin routes and signed webhooks retain their own access checks.

With a full tunnel a general IP-check page shows the cloud exit. With the
selective migration in section 8A, it instead shows Starlink; verify the
portal/API's specific routes and inside/outside access directly. After changing
routes, verify fresh requests to both the portal and `/api/plans` work from
NDAHI Wi-Fi and are denied on mobile data. A tunnel outage must fail closed for
portal/API traffic. A changed Render destination address requires updating the
specific routes and guards.

## 14. Deploy the portal-to-HotSpot login handoff

The application handoff is implemented in [PR #28](https://github.com/ImaJin14/Ndahi-Connect/pull/28). Follow the generic [external HotSpot login runbook](external-hotspot-login.md); the earlier template-only instructions have been replaced by the application and page generator.

1. Merge the reviewed change after CI passes. Deploy the resulting `main` release to both **ndahi-api** and **ndahi-customer**.
2. In Render → **ndahi-customer** → Environment, add `HOTSPOT_LOGIN_URL=https://connect.ndahiconnect.net/login`. Save and redeploy the customer service. The setting enables the handoff after sign-in, PIN setup, authenticator/passkey verification, bundle activation and the dashboard Connect action. It also allows the router origin in `form-action` CSP.
3. Keep the router HotSpot profile DNS name `connect.ndahiconnect.net`, its local DNS resolution to `10.20.0.1`, and its existing trusted certificate. The customer-facing portal remains `https://portal.ndahiconnect.net/login`.
4. Confirm the portal and API remain reachable without an authenticated HotSpot session through the walled garden.
5. Generate the three router pages locally:

```sh
node scripts/prepare-hotspot-pages.mjs https://portal.ndahiconnect.net /tmp/ndahi-hotspot-pages
```

6. In WinBox → Files, download a backup of the current `hotspot` directory. Upload the generated `login.html`, `rlogin.html`, and `flogin.html` into that existing directory, replacing those three files. Preserve the other router files, including `api.json`, `alogin.html` and `status.html`. The existing `alogin.html` must honor the posted `dst`.
7. Use a test phone on guest Wi-Fi with mobile data off and no active test-account session/cookie. The popup should redirect to the Render portal's `/login`. Sign in using the customer phone number, voucher and PIN; first-time customers create their PIN. The portal waits for provisioning and POSTs the voucher credentials to the router. Username/password do not go in URLs or browser storage.
8. Confirm the router has an active session for that phone and that internet access works through the cloud gateway. Revoke the test voucher and verify internet stops. A rejected router login must return to an explicit retry page without continuously resubmitting credentials.

Local browser fixtures passed, but physical phone/router behavior still needs the deployment test above. Coverage access restrictions in step 13 are a separate prerequisite for limiting the publicly hosted portal to the guest network.

Reference: [MikroTik external authentication](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/hotspot-customisation/).

## 15. Verify payments, vouchers, and failure behavior

Run the following tests using a low-value pilot plan and the normal verified-payment flow:

| Test | Required result |
| --- | --- |
| Phone joins guest SSID without a bundle | Portal and required checkout/API work; general internet remains blocked |
| Confirmed payment | Voucher is created and synchronized to the physical router |
| Customer signs in | Local HTTPS HotSpot form runs; router shows the client's active session |
| Unconfirmed/failed payment | Internet remains blocked |
| Shared-user/device limit reached | Router rejects the extra HotSpot login |
| Voucher expires | Router disables it and removes active sessions |
| Quota exhausted | Router stops internet access; verify actual traffic counters |
| Voucher revoked in admin | Router user/session/cookies are removed or disabled as implemented |
| WireGuard fails | Customer connectivity stops without direct-WAN fallback |
| Router or cloud VM reboots | Tunnel and enforcement recover; router expiry still works |
| Mobile data used outside Wi-Fi | Portal and customer API return 403 |
| Direct customer `onrender.com` URL | Same outside-network denial |
| Cached customer assets requested outside | No public cache bypass |
| Forged original-client-IP header | No outside-network bypass |
| Admin accessed remotely | Existing admin authentication still works |
| Payment callback from provider | Signature verification and settlement still work |
| Guest accesses AP/router/cloud management | Access denied |
| Guest IPv6 attempt | No unauthenticated IPv6 internet path |

Check WinBox → IP → Hotspot → Active, the managed HotSpot users, the application's network command queue, and usage synchronization. Do not rely only on the portal's Network online badge.

## 16. Roll out and retain recovery instructions

1. Remove the lab HotSpot user, trial access, broad bypass entries, and temporary allow rules.
2. Start with a few phones and measure connection reliability, captive-portal behavior, and gateway latency/throughput.
3. Review aggregated IP rate limits: customers share the cloud exit IP. Preserve per-account/PIN protections while sizing the site's shared-IP limits for legitimate load.
4. Configure alerts for tunnel health, certificate expiry, cloud bandwidth use, and failed router commands. Keep a current router backup and a known-good configuration version.
5. If the cloud public IP changes, update the WireGuard endpoint route/peer, DNS, and the customer/API allowlist in a coordinated change. Reserve the IP to avoid unnecessary changes.
6. If a rollout fails, restore the previous application release and reviewed router/cloud configuration using the wired recovery path. Preserve payment and customer records. Do not restore an old production database merely to undo network settings.

Coverage here is a network-access condition: new customer requests must travel through the designated hotspot. It cannot erase an already displayed page, enforce an exact geographic radius, or prevent a connected customer from sharing their connection. Customers must stay connected to NDAHI Wi-Fi, with VPN/mobile fallback disabled when those paths would send portal traffic elsewhere.
