import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingFixture } from './helpers/wifi-pairing-fixture.mjs';
const path='/api/account/bundle-status';
async function fixture(t){const f=await pairingFixture({now:new Date(),liveClock:true});t.after(f.close);return f;}
test('shared allowance has one recorded deduction across device reads and one coalesced router sync',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.vouchers[0].usedBytes=125000000;s.vouchers[0].lastUsageSyncAt=new Date(+f.now()-30000).toISOString();});
 const first=await f.call(path),second=await f.call(path,undefined,{session:'secondary'});
 assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');assert.equal(first.body.bundle.usedBytes,125000000);assert.equal(second.body.bundle.remainingBytes,875000000);assert.equal(first.body.bundle.devices.count,2);
 const s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,125000000);assert.equal(s.routerCommands.filter(c=>c.action==='sync_usage').length,1);assert.equal(first.body.purchase.allowed,false);
 assert.doesNotMatch(JSON.stringify(first.body),/NC-AAAA|670050001|AA:BB|csrf|controller/);
});
test('anonymous and another customer cannot read an allocation',async t=>{
 const f=await fixture(t);assert.equal((await f.call(path,undefined,{session:''})).status,401);const r=await f.call(path,undefined,{session:'other'});assert.equal(r.body.bundle,null);assert.equal(r.body.activeId,null);
 assert.equal((await f.call(path,{})).status,405);
});
test('automatic balance reads never extend authentication and an expired session cannot read or queue usage',async t=>{
 const f=await fixture(t),before=(await f.store.snapshot()).dashboardSessions.find(s=>s.id==='main').expiresAt;
 assert.equal((await f.call(path)).status,200);assert.equal((await f.store.snapshot()).dashboardSessions.find(s=>s.id==='main').expiresAt,before);
 await f.store.transaction(s=>{s.dashboardSessions.find(s=>s.id==='main').expiresAt=new Date(+f.now()-1).toISOString();s.routerCommands=[];});
 const r=await f.call(path);assert.equal(r.status,401);assert.equal(r.body.bundle,undefined);assert.equal((await f.store.snapshot()).routerCommands.some(c=>c.action==='sync_usage'),false);
});
test('unlimited and unavailable usage stay distinct from zero; stale router counts remain unknown',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.vouchers[0].quotaBytes=null;s.vouchers[0].usedBytes=2000000000;});
 let r=await f.call(path);assert.equal(r.body.bundle.remainingBytes,null);assert.equal(r.body.bundle.usedBytes,2000000000);assert.equal(r.body.bundle.usagePercentage,null);
 await f.store.transaction(s=>{delete s.vouchers[0].usedBytes;s.vouchers[0].wifiDevicesAt=new Date(+f.now()-121000).toISOString();});r=await f.call(path);assert.equal(r.body.bundle.usedBytes,undefined);assert.equal(r.body.bundle.usage.state,'unavailable');assert.equal(r.body.bundle.devices.count,null);assert.equal(r.body.bundle.devices.state,'unknown');
});
for(const state of ['expired','exhausted'])test('server confirms '+state+' and eligible purchase independently from router connectivity',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{const v=s.vouchers[0];if(state==='expired')v.expiresAt=f.now().toISOString();else v.usedBytes=v.quotaBytes;});
 const r=await f.call(path);assert.equal(r.body.activeId,null);assert.equal(r.body.bundle.status,state);assert.equal(r.body.purchase.allowed,true);
});
test('dead-letter read cannot claim current usage or device count and cannot restart itself',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.vouchers[0].lastUsageSyncAt=f.now().toISOString();s.routerCommands.push({id:'router:sync_usage:global',action:'sync_usage',status:'dead_letter'});});
 const r=await f.call(path);assert.equal(r.body.bundle.usage.state,'stale');assert.equal(r.body.bundle.devices.count,null);assert.equal((await f.store.snapshot()).routerCommands[0].status,'dead_letter');
});
test('device count deduplicates repeated router observations and suspension blocks purchases',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.vouchers[0].wifiDevices.push({...s.vouchers[0].wifiDevices[0]});s.customers[0].suspended=true;});
 const r=await f.call(path);assert.equal(r.body.bundle.devices.count,2);assert.equal(r.body.bundle.status,'suspended');assert.equal(r.body.purchase.allowed,false);
});
