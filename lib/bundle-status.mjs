import { findPlan } from './api/state.mjs';
import { activeSubscription, subscriptionPurchaseAccess } from './subscription-policy.mjs';
import { wifiReadingMaxAgeMs } from './wifi-devices.mjs';
const fresh = (at, now, after) => Number.isFinite(Date.parse(at)) && +now-Date.parse(at)>=-5000 && +now-Date.parse(at)<=wifiReadingMaxAgeMs && (!after || Date.parse(at)>=Date.parse(after));
// This is a read model of the shared allowance, never a new usage deduction.
export function bundleStatus(s, customer, now, { live = false } = {}) {
  const active = activeSubscription(s,customer.id,now);
  const latest = s.vouchers.filter(v=>v.customerId===customer.id).sort((a,b)=>(Date.parse(b.activatedAt)||0)-(Date.parse(a.activatedAt)||0))[0];
  const v=active||latest, read=s.routerCommands.find(c=>c.id==='router:sync_usage:global');
  let bundle=null;
  if(v){
    const known=Number.isFinite(v.usedBytes)&&v.usedBytes>=0, quota=v.quotaBytes===null?null:Number.isFinite(v.quotaBytes)&&v.quotaBytes>=0?v.quotaBytes:undefined;
    const state=customer.suspended||customer.status==='suspended'?'suspended':Number.isFinite(Date.parse(v.expiresAt))&&Date.parse(v.expiresAt)<=+now?'expired':quota!==null&&quota!==undefined&&known&&v.usedBytes>=quota?'exhausted':v.status;
    const usageFresh=fresh(v.lastUsageSyncAt,now,v.activatedAt)&&read?.status!=='dead_letter';
    const deviceFresh=Boolean(active)&&fresh(v.wifiDevicesAt,now,v.activatedAt)&&read?.status!=='dead_letter'&&Array.isArray(v.wifiDevices)&&v.wifiDevices.every(d=>d.mac&&d.sessionId&&Number.isFinite(Date.parse(d.startedAt)));
    bundle={id:v.id,plan:findPlan(s,v.planId)||{id:v.planId,name:'Bundle'},status:state,expiresAt:v.expiresAt||null,activatedAt:v.activatedAt||null,
      quotaBytes:quota,usedBytes:known?v.usedBytes:undefined,remainingBytes:quota===null?null:known&&quota!==undefined?Math.max(0,quota-v.usedBytes):undefined,
      usagePercentage:quota>0&&known?Math.min(100,v.usedBytes/quota*100):null,
      usage:{state:!known?'unavailable':!live?'recorded':usageFresh?'fresh':'stale',observedAt:v.lastUsageSyncAt||null,source:live?'router':'accounting'},
      devices:{count:live?(deviceFresh?new Set(v.wifiDevices.map(d=>d.mac.toUpperCase())).size:null):s.sessions.filter(x=>x.voucherId===v.id&&x.status==='online').length,
        limit:Number.isInteger(v.deviceLimit)?v.deviceLimit:null,state:live?(deviceFresh?'fresh':'unknown'):'recorded',observedAt:live?v.wifiDevicesAt||null:now.toISOString(),source:live?'router':'account-sessions'},
      provisioning:v.routerSyncStatus||null};
  }
  return {version:1,observedAt:now.toISOString(),expiresAt:new Date(+now+45000).toISOString(),activeId:active?.id||null,bundle,purchase:subscriptionPurchaseAccess(s,customer,now)};
}
