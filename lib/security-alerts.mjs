import { randomUUID } from "node:crypto";
import { correlation } from "./correlation.mjs";
import { silentLogger } from "./logger.mjs";
import { linkedEmail } from "./email-state.mjs";
import { deliverEmail, emailVersion } from "./email-delivery.mjs";
import { notificationPreferences } from "./notifications.mjs";

// Queued inside the same transaction as the triggering change; delivery
// happens later so a slow or unreachable email provider never blocks the
// customer-facing request (mirrors lib/billing.mjs's receipt delivery).
export function queueSecurityAlert(s, { customerId, kind, subject, lines, recipient, sourceSignInId, signIn }, now = new Date()) {
  s.securityAlerts ??= [];
  s.securityAlerts.push({
    id: randomUUID(), type: "security_alert", customerId, kind, subject, lines, ...(sourceSignInId ? { sourceSignInId, signIn } : {}),
    recipient: recipient === undefined ? linkedEmail(s.customers.find((c) => c.id === customerId)) || null : recipient,
    status: "pending", attempts: 0,
    at: now.toISOString(), nextAttemptAt: now.toISOString(),
    ...(correlation().correlationId ? { correlationId: correlation().correlationId } : {}),
  });
  s.securityAlerts = s.securityAlerts.slice(-500);
}

export function createSecurityAlertService({ store, email, now = () => new Date(), timeoutMs = 10000, logger = silentLogger }) {
  async function deliver(id) {
    return deliverEmail({store,now,key:'security-alert/'+id,timeoutMs,maxAttempts:8,
      configured:()=>email.configured?.()!==false,
      locate:s=>(s.securityAlerts||[]).find(a=>a.id===id),
      resolve(s){
        const a=(s.securityAlerts||[]).find(a=>a.id===id),customer=s.customers.find(c=>c.id===a?.customerId);
        if(!a||!customer)return{blocked:'cancelled',reason:'Account is no longer available.'};
        if(!notificationPreferences(s,'customer:'+a.customerId).emailSecurity)return{blocked:'skipped',reason:'Email security notices are disabled in notification preferences.'};
        // A replacement warning deliberately targets the old verified mailbox.
        // Other alerts are cancelled when their verified association changes.
        const to=Object.hasOwn(a,'recipient')?a.recipient:linkedEmail(customer);
        if(!to)return{blocked:'skipped',reason:'No account email on file.'};
        if(!['email_replaced','email_removed'].includes(a.kind)&&to!==linkedEmail(customer))return{blocked:'cancelled',reason:'The linked account email changed.'};
        const alert={id:a.id,kind:a.kind,subject:a.subject,lines:[...a.lines]};
        return{version:emailVersion([to,alert]),message:{to,alert}};
      },send:(message,deliveryKey)=>email.sendSecurityAlert({...message,deliveryKey})});
  }
  let running;
  function run() {
    if (running) return running;
    running = (async () => {
      const state = await store.snapshot();
      for (const a of (state.securityAlerts || []).filter((a) => !["sent", "cancelled", "skipped"].includes(a.status) && (a.attempts || 0) < 8 && !(Date.parse(a.nextAttemptAt) > +now()) && !(a.status === "sending" && Date.parse(a.leaseUntil) > +now())).slice(0, 25)) {
        await deliver(a.id);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { run, deliver };
}
