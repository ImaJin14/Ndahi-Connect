# Current-device connection status (#57)

The Home view replaces its unconditional Connect link with a current-device card.
It shows Connecting, Connected, Disconnecting, Disconnected, unknown/stale or
failure, a last-checked time, and nearby progress/errors. Connected requires a
fresh complete router reading of the associated MAC/login address and a valid
session identity. Names, account sessions, saved approval and shared egress alone
never establish that state.

## Identity and readings

Successful owner connections associate their verified target with that dashboard
session after router confirmation. This works without browser storage or a MAC in
the destination URL. Browserless/manual approvals and another dashboard session
cannot set the association for this browser.

Alternatively, `POST /api/account/device-management/current/identify` checks the
Wi-Fi landing page's MAC/IP candidates against the current router host. It needs
the authenticated customer, trusted origin, CSRF token and configured coverage
guard, then rechecks the session and router revision after the external read.
Candidates are not ownership credentials; all actions remain scoped to the
account and exact observed session. This does not provide hardware attestation:
the browser cannot read its MAC itself, so accurate router landing details remain
necessary. Failed re-identification clears the old association instead of letting
the next poll revive an old Connected indication.

The association expires after 15 minutes; the complete router reading expires
after two minutes. `GET /api/account/device-management/current` polls state and
requests an ordinary batched router refresh as needed. It never starts a login.
Missing/changed hints, disabled live routing, unknown identity, off-network access,
stale/future readings and failed reads cannot show Connected. Refresh re-verifies
the current candidate; a changed IP requires opening Wi-Fi sign-in again.

## Disconnect versus Forget

Current customer controls explicitly request `retainApproval: true` together with
MAC, router session ID and start time. This ends that exact session and clears its
router cookie while retaining saved approval and main-device designation. Main
disconnection still uses the existing fresh owner verification and enrolled
authenticator protection. An older/replaced session cannot authorize removing a
newer one.

The slot remains occupied while a disconnect is queued, processing or retrying.
Lost responses are reconciled by polling the existing operation. Reconnect stays
blocked until confirmation and requires an explicit user action afterward;
background polling cannot undo an intentional disconnect. A queued connection is
cancelled when the session is ended; an already-processing connection must finish
before a disconnect can be requested.

Forget device remains the owner-verified action that revokes saved approval,
cancels unused requests and removes router sessions/cookies. A retaining
disconnect can never restore a grant revoked concurrently by Forget. Legacy/API
clients that omit `retainApproval` retain their previous revoking behavior; all
current customer Disconnect buttons opt into session retention. No credential or
new access permission is introduced by the status association.

## Verification and release

Run `npm test`, `npm run check`, `npm run check:current-wifi:browser` and the complete
`npm run test:browser`. Regression cases cover current-session/account isolation,
CSRF, failed/lying router reads, sign-out during identification, stale identity,
owner association after confirmation, exact-session replacement, main-device
verification/preservation, lost disconnect replies, slot retention, queued versus
in-flight connects, explicit grant-authorized reconnect and monotonic revocation.
The 320px browser journey denies storage and verifies immediate and confirmed
states and reconnect identity.

This PR follows [#64](https://github.com/ImaJin14/Ndahi-Connect/pull/64) so its diff
contains only #57. Review/merge that parent first. No schema migration or live
network change is included. Deploy the API/customer release together. Retaining
jobs use a new kind that older API workers ignore during a rolling deployment;
the existing exact-session disconnect bridge contract is unchanged.

Physical release checks remain pending:

1. With mobile data off, identify a phone through the actual Wi-Fi landing page;
   verify Connected matches the router and real browsing.
2. Disconnect secondary and main devices separately. Confirm internet stops,
   slots stay occupied until confirmation, saved approval/main designation remain,
   and no background action reconnects them.
3. Explicitly reconnect, then Forget a saved device. Confirm approval is now
   required, including after a router/AP restart and browser-storage denial.
4. Test stale/offline router data, changed private MAC/IP, a replaced session,
   lost replies and denied owner verification. Verify no other device is labelled
   as this one or disconnected by an old request.

Keep #57 open until production and physical acceptance are recorded. Related:
[captive completion](captive-completion.md), [assisted approval](assisted-wifi-pairing.md)
and [connection reliability](connection-reliability.md).
