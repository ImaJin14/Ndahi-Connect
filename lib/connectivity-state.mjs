import { currentWifiView } from './current-wifi-device.mjs';
import { currentIdentityMaxAgeMs } from './current-wifi-device.mjs';
import { activeSubscription } from './subscription-policy.mjs';
const fresh = (stamp, now, maxAge = 120000) => Number.isFinite(Date.parse(stamp)) && +now - Date.parse(stamp) >= -5000 && +now - Date.parse(stamp) <= maxAge;

// This contract describes evidence. It is never a purchase/access authorization.
// Trusted ingress proves the request's path, not an SSID or a physical browser.
export function connectivityState(s, { session, ingress, now, coverageEnabled }) {
  const customer = session && s.customers.find(c => c.id === session.customerId), authenticated = Boolean(customer && customer.status !== 'suspended' && !customer.suspended);
  const confirmed = coverageEnabled === true && ingress === true;
  const network = { state: confirmed ? 'confirmed' : coverageEnabled ? 'unconfirmed' : 'unknown', scope: 'request-path', source: confirmed ? 'trusted-ingress' : 'none', observedAt: now.toISOString() };
  const current = authenticated ? currentWifiView(s, customer.id, session.currentWifi, now, { inCoverage: confirmed, sessionId: session.id }) : null;
  const usage = s.routerCommands.find(c => c.id === 'router:sync_usage:global');
  const identityAt = session?.currentWifi?.verifiedAt;
  const routerAt = fresh(identityAt, now) ? identityAt : fresh(usage?.processedAt, now) && usage?.status === 'processed' ? usage.processedAt : null;
  const live = s.networkSetup?.runtimeRouterEnabled === true && s.networkSetup.connections?.router?.mode === 'live';
  const routerFailed = usage?.status === 'dead_letter' && fresh(usage.lastAttemptAt, now) && (!routerAt || Date.parse(usage.lastAttemptAt) > Date.parse(routerAt));
  const router = { state: !live ? 'unknown' : routerFailed ? 'unavailable' : routerAt ? 'reachable' : 'unknown', observedAt: !live ? null : routerFailed ? usage.lastAttemptAt : routerAt, scope: 'management-path' };
  const hotspot = { state: current?.state === 'connected' && fresh(current.checkedAt, now) && fresh(identityAt, now, currentIdentityMaxAgeMs) ? 'authenticated' : current?.state === 'disconnected' && fresh(current.checkedAt, now) ? 'unauthenticated' : 'unknown', observedAt: current?.checkedAt || null, scope: 'session-bound-device' };
  const owned = customer ? s.vouchers.filter(v => v.customerId === customer.id) : [];
  const active = customer && activeSubscription(s, customer.id, now);
  const latest = owned[0];
  const subscription = { state: !customer ? 'unknown' : customer.status === 'suspended' || customer.suspended ? 'suspended' : active ? 'active' : latest && (latest.status === 'exhausted' || latest.quotaBytes !== null && Number.isFinite(latest.quotaBytes) && (latest.usedBytes || 0) >= latest.quotaBytes) ? 'exhausted' : latest && (latest.status === 'expired' || Date.parse(latest.expiresAt) <= +now) ? 'expired' : 'none' };
  let action = 'check-connection', href = '/hotspot';
  if (customer && (customer.status === 'suspended' || customer.suspended)) { action = 'support'; href = '/help#recovery'; }
  else if (authenticated) { action = ['expired','exhausted','none'].includes(subscription.state) && confirmed ? 'plans' : 'dashboard'; href = action === 'plans' ? '/dashboard#bundles' : '/dashboard'; }
  else if (confirmed) { action = 'sign-in'; href = '/login'; }
  return { version: 1, observedAt: now.toISOString(), expiresAt: new Date(+now + 45000).toISOString(), network, router, hotspot,
    account: { state: authenticated ? 'authenticated' : 'signed-out' }, subscription,
    internet: { state: 'unknown', scope: 'browser-path', observedAt: null }, decision: { action, href } };
}
