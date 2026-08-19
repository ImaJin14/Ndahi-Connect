# NDAHI Connect v3 direct-device student-zone baseline for RouterOS 7.
# Assumptions: ether1=Starlink WAN, ether2=EAP650-Outdoor uplink.
/interface bridge add name=br-hotspot comment="NDAHI student Wi-Fi"
/interface bridge port add bridge=br-hotspot interface=ether2
/ip address add address=10.20.0.1/22 interface=br-hotspot
/ip pool add name=pool-hotspot ranges=10.20.0.20-10.20.3.250
/ip dhcp-server add name=dhcp-hotspot interface=br-hotspot address-pool=pool-hotspot lease-time=1h disabled=no
/ip dhcp-server network add address=10.20.0.0/22 gateway=10.20.0.1 dns-server=10.20.0.1
/ip dhcp-client add interface=ether1 use-peer-dns=no add-default-route=yes disabled=no
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8
/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade
/ip firewall filter add chain=forward connection-state=established,related action=accept
/ip firewall filter add chain=forward connection-state=invalid action=drop
/ip firewall filter add chain=forward in-interface=br-hotspot out-interface=br-hotspot action=drop comment="client isolation"
/ip hotspot profile add name=ndahi-profile hotspot-address=10.20.0.1 dns-name=connect.ndahi.local login-by=http-chap,cookie
/ip hotspot add name=ndahi-hotspot interface=br-hotspot address-pool=pool-hotspot profile=ndahi-profile disabled=no
# The backend creates one Hotspot user/voucher per paid activation code.
# The management bridge receives schemaVersion, voucherId, username, password,
# profileId, expiresAt, limitBytesTotal, simultaneousUsers and enabled.
# It must map username/password to Hotspot credentials, simultaneousUsers to
# shared-users, expiresAt to scheduler/expiry enforcement, and limitBytesTotal
# to limit-bytes-total (null means no byte cap).
# Example after configuring external accounting/RADIUS:
# /ip hotspot user add name=NC-ABCD-5678 password=NC-ABCD-5678 shared-users=2 limit-bytes-total=5000000000
# Do not import the example line without replacing values and connecting accounting.
# Fair-use PCQ foundation; set measured limits only after peak-hour tests.
/queue type add kind=pcq name=pcq-download pcq-classifier=dst-address
/queue type add kind=pcq name=pcq-upload pcq-classifier=src-address
/queue simple add name="NDAHI fair share" target=10.20.0.0/22 queue=pcq-upload/pcq-download max-limit=0/0
# API must be exposed only through a VPN and restricted to the backend address.
/ip service set api disabled=yes
/ip service set api-ssl disabled=no port=8729 certificate=none
