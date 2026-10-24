import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingFixture } from './helpers/wifi-pairing-fixture.mjs';
import { notificationPreferences, notificationItems, deliverActivityPush } from '../lib/notifications.mjs';
import { createUsageAlertSender, recordUsageAlerts } from '../lib/usage-alerts.mjs';
const endpoint='/api/account/notifications', actor={type:'customer',id:'c1'};
const config={enabled:true,subject:'mailto:fixture@example.test',publicKey:'fixture',privateKey:'fixture'};
async function fixture(t){const f=await pairingFixture();t.after(f.close);return f;}

test('defaults preserve existing alerts while one-hour expiry warnings require opt-in',async t=>{
 const f=await fixture(t), prefs=notificationPreferences(await f.store.snapshot(),'customer:c1');
 assert.deepEqual(prefs.usageThresholds,['90','low','100']);assert.equal(prefs.expiryWarnings,false);assert.equal(prefs.subscriptionUpdates,true);
 await f.store.transaction(s=>{s.vouchers[0].expiresAt=new Date(+f.now()+1800000).toISOString();});
 assert.equal(notificationItems(await f.store.snapshot(),actor,f.now()).some(n=>n.id.startsWith('bundle-expiring:')),false);
});

test('preferences validate atomically, merge partial concurrent saves, and persist across accounts/sessions',async t=>{
 const f=await fixture(t);
 await Promise.all([f.call(endpoint,{action:'preferences',usageThresholds:['low'],expiryWarnings:true}),f.call(endpoint,{action:'preferences',categories:{service:false},emailSecurity:false})]);
 const prefs=(await f.call(endpoint,undefined,{session:'secondary'})).body.preferences;
 assert.deepEqual(prefs.usageThresholds,['low']);assert.equal(prefs.expiryWarnings,true);assert.equal(prefs.emailSecurity,false);assert.equal(prefs.categories.service,false);
 for(const bad of [['75'],['low','low'],[90],null]){
  assert.equal((await f.call(endpoint,{action:'preferences',usageThresholds:bad,subscriptionUpdates:false})).status,400);
 }
 assert.deepEqual((await f.call(endpoint)).body.preferences,prefs);
 assert.equal((await f.call(endpoint,{action:'preferences',expiryWarnings:'yes'})).status,400);
 assert.equal((await f.call(endpoint,{action:'preferences',expiryWarnings:false},{csrf:'bad'})).status,403);
 assert.equal((await f.call(endpoint,undefined,{session:'other'})).body.preferences.expiryWarnings,false);
});

test('selected thresholds and subscription notices filter inbox without changing quota, expiry or payments',async t=>{
 const f=await fixture(t);
 await f.store.transaction(s=>{const v=s.vouchers[0];v.usedBytes=900000000;recordUsageAlerts(v,f.now);v.expiresAt=new Date(+f.now()+1800000).toISOString();});
 await f.call(endpoint,{action:'preferences',usageThresholds:[],expiryWarnings:true});
 const inbox=(await f.call(endpoint)).body, item=inbox.items.find(n=>n.id.startsWith('bundle-expiring:'));assert.ok(item);assert.equal(inbox.items.some(n=>n.title==='90% of your data used'),false);
 const before=await f.store.snapshot();await f.call(endpoint,{action:'read',id:item.id});await f.call(endpoint,{action:'archive',id:item.id});
 const after=await f.store.snapshot();for(const key of ['vouchers','payments','routerCommands','wifiPairingRequests'])assert.deepEqual(after[key],before[key]);
 assert.equal((await f.call(endpoint)).body.items.find(n=>n.id===item.id).archived,true);
 await f.store.transaction(s=>{s.vouchers[0].status='expired';});
 assert.ok((await f.call(endpoint)).body.items.some(n=>n.id==='bundle:v1'));
 await f.call(endpoint,{action:'preferences',subscriptionUpdates:false});assert.equal((await f.call(endpoint)).body.items.some(n=>n.id==='bundle:v1'),false);
});

test('delivery workers recheck changed threshold and usage channel consent, then deduplicate expiry warnings',async t=>{
 const f=await fixture(t), sent=[];
 await f.store.transaction(s=>{s.customers[0].pushSubscriptions=[{endpoint:'https://fcm.googleapis.com/fixture',keys:{p256dh:'fixture',auth:'fixture'}}];s.vouchers[0].usedBytes=998000000;recordUsageAlerts(s.vouchers[0],f.now);s.vouchers[0].lastUsageSyncAt=f.now().toISOString();});
 const original=f.store.snapshot.bind(f.store);
 const store={transaction:(...a)=>f.store.transaction(...a),snapshot:async()=>{const old=await original();await f.call(endpoint,{action:'preferences',usageThresholds:['90']});return old;}};
 await createUsageAlertSender({store,config,now:f.now,send:async(...a)=>sent.push(a)})();assert.equal(sent.length,0);
 await f.store.transaction(s=>{s.vouchers[0].expiresAt=new Date(+f.now()+3600000).toISOString();});
 await f.call(endpoint,{action:'preferences',pushEnabled:true,expiryWarnings:true,usagePush:false});
 await deliverActivityPush({store:f.store,config,now:f.now,send:async(...a)=>sent.push(a)});assert.equal(sent.length,0);
 await f.call(endpoint,{action:'preferences',usagePush:true});
 await Promise.all([1,2].map(()=>deliverActivityPush({store:f.store,config,now:f.now,send:async(...a)=>sent.push(a)})));
 assert.equal(sent.length,1);await deliverActivityPush({store:f.store,config,now:f.now,send:async(...a)=>sent.push(a)});assert.equal(sent.length,1);
});
