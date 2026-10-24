import { createHash } from 'node:crypto';
import { notificationItems, notificationPreferences } from './notifications.mjs';
import { deliveryId, recipientSubscriptions } from './notification-delivery.mjs';
import { deliverEmail, emailVersion } from './email-delivery.mjs';
import { linkedEmail } from './email-state.mjs';
import { usageNotificationId } from '../shared-app/data-usage.js';

const keyFor = (recipient, item) => 'notification-email:' + createHash('sha256').update(JSON.stringify([recipient, item.id, item.version])).digest('hex');
// Known-unavailable push falls back; provider acceptance is not a device receipt.
// Transaction/payment/security mail remains in its existing dedicated outboxes.
export function createNotificationEmailSender({ store, email, config, now = () => new Date(), timeoutMs = 10000 }) {
  const candidate = (s, customerId, eventId) => {
    const c = s.customers.find(c => c.id === customerId), actor = 'customer:' + customerId;
    const prefs = notificationPreferences(s, actor), to = linkedEmail(c);
    if (!c || c.status === 'suspended' || c.suspended || !c.emailVerifiedAt || !to || !prefs.emailFallback || !prefs.categories.usage) return null;
    const item = notificationItems(s, { type: 'customer', id: customerId }, now()).find(n => n.id === eventId && n.category === 'usage' && !n.read && !n.archived && Date.parse(n.updatedAt) >= +now() - 86400000);
    if (!item) return null;
    if (item.id.startsWith('usage:')) {
      const pair = s.vouchers.flatMap(v => Object.entries(v.usageAlerts || {}).map(([level, alert]) => ({ v, level, alert })))
        .find(({ v, level }) => v.customerId === customerId && usageNotificationId(v, level) === item.id);
      if (!pair || ['skipped', 'superseded', 'cancelled'].includes(pair.alert.status) ||
        c.activeVoucherId && c.activeVoucherId !== pair.v.id || pair.level !== '100' && (Date.parse(pair.v.lastUsageSyncAt || pair.alert.readingAt || pair.alert.at) < +now() - 120000 || Date.parse(pair.v.expiresAt) <= +now())) return null;
    } else if (!item.id.startsWith('bundle-expiring:') && !item.id.startsWith('bundle:')) return null;
    const subscriptions = recipientSubscriptions(s, actor);
    if (config.enabled && prefs.pushEnabled && prefs.usagePush && subscriptions.length) {
      const rows = subscriptions.map(sub => s.notificationStates.find(n => n.id === deliveryId(actor, item.id, sub)));
      if (rows.some(row => row?.status === 'sent') || !rows.every(row => ['failed', 'gone', 'cancelled'].includes(row?.status))) return null;
    }
    return { item, to };
  };
  let running;
  async function runOnce() {
    const snapshot = await store.snapshot(); let sent = 0;
    for (const c of snapshot.customers) {
      const actor = 'customer:' + c.id;
      const items = notificationItems(snapshot, { type: 'customer', id: c.id }, now()).filter(n => candidate(snapshot, c.id, n.id)).slice(0, 10);
      for (const item of items) {
        const key = keyFor(actor, item);
        const result = await deliverEmail({ store, now, timeoutMs, key,
          configured: () => email.configured?.() !== false && typeof email.sendAccountMessage === 'function',
          locate(s) {
            let row = s.notificationStates.find(n => n.id === key);
            if (!row) { row = { id: key, actor, notificationId: item.id, status: 'pending', attempts: 0 }; s.notificationStates.push(row); }
            return row;
          },
          resolve(s) {
            const current = candidate(s, c.id, item.id);
            if (!current || current.item.version !== item.version) return null;
            return { version: emailVersion([actor, current.to, item.id, item.version]), message: { to: current.to,
              subject: 'NDAHI Connect bundle update', lines: [current.item.title, 'Open your portal for the latest balance and bundle status. Delivery does not confirm Wi-Fi or internet access.'], path: '/dashboard#bundles' } };
          },
          send: (message, deliveryKey) => email.sendAccountMessage({ ...message, deliveryKey }),
        });
        if (result.delivered) sent++;
      }
    }
    return { sent };
  }
  return () => running || (running = runOnce().finally(() => { running = undefined; }));
}
