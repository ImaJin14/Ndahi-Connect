# Live captive-page inspection — 2026-10-21

The wired peer PC can reach the router at `192.168.88.1` through its
`192.168.88.254` Ethernet interface. Its existing authenticated WinBox session
was used for read-only inspection. Web management on ports 80/443 refused
connections; the other PC's wireless-only route could not reach the router.

Read-only RouterOS terminal output confirmed:

| Field | Observed value |
| --- | --- |
| RouterOS | 7.24.5 |
| HotSpot server | `ndahi-hotspot` |
| Server profile | `ndahi-profile` |
| HTML Directory | `hotspot` |
| HTML Directory Override | empty |

All three installed landing pages omit the MAC/IP candidates needed by the
portal. This is confirmed installed behavior, rather than an assumption from an
old configuration record:

| Installed file | Redirect |
| --- | --- |
| `hotspot/login.html` | `/login`; on error, `/hotspot?router-error=1` |
| `hotspot/rlogin.html` | `/login` |
| `hotspot/flogin.html` | `/hotspot?router-error=1` |

These redirect to the production portal, but none carries `mac=$(mac)` or
`address=$(ip)`. The restricted portal therefore cannot start a verified access
request from these redirects. Deploying the application does not replace them.

## Preserved originals and proposed repair

The installed contents match the earlier committed page generator. Original
copies were reconstructed from that generator and checked against MD5 values
printed by the live router. All three matched. They are verified reconstructions,
not raw WinBox downloads:

| File | Bytes | Router-matched MD5 |
| --- | ---: | --- |
| `login.html` | 835 | `8d4b0109ca2905c08b7819fd8c777704` |
| `rlogin.html` | 386 | `cb4678a9774a1015e2968d9010c15d77` |
| `flogin.html` | 420 | `286b3e5170847b00d3641835be6ef144` |

The copies and an inspection manifest are preserved in
`~/Downloads/ndahi-hotspot-backup` on both PCs. The manifest also records local
SHA-256 values. `/tmp/ndahi-router-landing-review.zip` on both PCs contains the
originals, generated replacements and prepared apply/rollback scripts. Those
scripts guard the active profile, effective directory and all three expected
file checksums before changing the contents of the existing files. They do not
change routing, accounts, profiles or device-approval policy.

No router file or configuration was changed during this inspection. The scripts
have not been executed. PR #54 remains open under the user's explicit review
hold; no merge/deployment or coordinated router rollout has occurred. After
review approval, deploy the tested application and install the reviewed pages,
then verify actual signup, secondary approval, browsing and both approved-device
reconnections after separate router/AP restarts. File inspection and synthetic
tests do not establish physical connection success.
