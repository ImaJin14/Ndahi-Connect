import { randomUUID } from "node:crypto";
import { hashSecret, secureToken } from "./security.mjs";
import { routerRevision } from "./device-identities.mjs";
import { cookies } from "./api/http.mjs";

export const wifiAppCookie = "ndahi_wifi_app";
export const wifiAppLifetimeSeconds = 365 * 86400;
const grantFor = (s, customerId, mac) => (s.wifiDeviceGrants || []).find((g) =>
  g.customerId === customerId && g.mac === mac && g.routerRevision === routerRevision(s));
const version = (g) => g?.generation || g?.approvedAt || null;

// This handle remembers a candidate, never an authentication factor, grant or
// main-device controller. Each account has a separate hashed association.
export function appAssociation(s, req, session, now, pepper, previousPepper) {
  s.wifiAppAssociations ??= [];
  let token = cookies(req)[wifiAppCookie];
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) token = secureToken();
  const hashes = [pepper, previousPepper].filter(Boolean).map((key) => hashSecret(session.customerId + ":" + token, key));
  let row = s.wifiAppAssociations.find((a) => a.customerId === session.customerId && hashes.includes(a.tokenHash) &&
    a.routerRevision === routerRevision(s) && Date.parse(a.expiresAt) > +now);
  if (!row) {
    row = { id: randomUUID(), customerId: session.customerId, tokenHash: hashes[0], routerRevision: routerRevision(s), createdAt: now.toISOString() };
    s.wifiAppAssociations.push(row);
  }
  row.tokenHash = hashes[0]; row.lastSeenAt = now.toISOString();
  row.expiresAt = new Date(+now + wifiAppLifetimeSeconds * 1000).toISOString();
  session.wifiAppAssociationId = row.id;
  if (!session.currentWifi && row.candidate && !row.invalidatedAt) {
    const grant = grantFor(s, session.customerId, row.candidate.mac);
    if ((!row.grantVersion || row.grantVersion === version(grant)) && (!grant || grant.status === "approved")) {
      // A new account session must obtain fresh router proof, even when the
      // remembered candidate's former proof was recent.
      session.currentWifi = { ...row.candidate, sessionId: session.id, verifiedAt: null, lastConfirmedAt: row.lastConfirmedAt };
    }
  }
  return { row, token };
}

export function rememberAppDevice(s, session, now) {
  const row = (s.wifiAppAssociations || []).find((a) => a.id === session.wifiAppAssociationId && a.customerId === session.customerId), candidate = session.currentWifi;
  if (!row || !candidate || row.routerRevision !== routerRevision(s) || !candidate.verifiedAt) return;
  const grant = grantFor(s, session.customerId, candidate.mac);
  const owned = s.vouchers.some((v) => v.customerId === session.customerId && (v.wifiDevices || []).some((d) => d.mac === candidate.mac));
  if (grant?.status === "revoked" || (!owned && grant?.status !== "approved")) return;
  row.candidate = { mac: candidate.mac, address: candidate.address, loginAddress: candidate.loginAddress, routerRevision: candidate.routerRevision };
  row.grantVersion = version(grant); delete row.invalidatedAt;
  row.lastSeenAt = now.toISOString();
}

export function invalidateAppDevice(s, customerId, mac, now) {
  for (const a of s.wifiAppAssociations || []) if (a.customerId === customerId && a.candidate?.mac === mac) {
    a.invalidatedAt = now.toISOString(); delete a.candidate; delete a.lastConfirmedAt;
  }
  for (const session of s.dashboardSessions || []) if (session.customerId === customerId && session.currentWifi?.mac === mac) delete session.currentWifi;
}
