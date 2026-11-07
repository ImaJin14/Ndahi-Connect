import test from "node:test";
import assert from "node:assert/strict";
import { blank, createStore } from "../lib/api/state.mjs";
import { ensureHome, reserveHomeLink, requestHomeMode, homePaymentFields, homeView, applyHomeUsage, queueHome } from "../lib/home.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { routerVoucherPayload } from "../lib/routeros.mjs";
import { createHomeService } from "../lib/home-service.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";
import { createRouterReconciler } from "../lib/router-reconciliation.mjs";
const at=new Date("2030-01-01T12:00:00Z"),mac="AA:BB:CC:DD:EE:99";
const voucher=(more={})=>({id:"v1",customerId:"c1",planId:"daily",code:"NC-AAAA-1111",status:"active",quotaBytes:1000,usedBytes:20,deviceLimit:3,activatedAt:at.toISOString(),expiresAt:new Date(+at+86400000).toISOString(),...more});
function state(){const s=blank();s.customers.push({id:"c1",phone:"670050001"},{id:"c2",phone:"670050002"});s.networkSetup={connections:{router:{mode:"live",revision:"r1"}},runtimeRouterEnabled:true};return s;}
function challenge(s,id="ch1",customerId="c1"){ensureHome(s).homeChallenges.push({id,customerId,sessionId:"s1",status:"ready",expiresAt:new Date(+at+120000).toISOString(),routerRevision:"r1"});return {challengeId:id,mac,address:"10.20.0.9",hostId:"*h1",sessionId:"*s1"};}
function link(s){return reserveHomeLink(s,"c1",challenge(s),"ch1","My home",at);}
async function fixture({fail=false}={}){
 const store=createStore({persistent:false}),calls=[],meter={bytes:0,epoch:null,connected:false};let clock=at,offline=fail;
 await store.transaction(s=>{Object.assign(s,state());s.vouchers.push(voucher());link(s);});
 const router={
  async disconnectVoucher(id){calls.push(["direct.revoke",id]);if(offline)throw Error("offline");return {disconnected:true};},
  async readUsage(){return [{voucherId:"v1",usedBytes:20}];},
  async authorizeHome({voucher:v}){calls.push(["home.authorize",v.homeGeneration]);if(offline)throw Error("offline");if(meter.epoch&&meter.epoch!==(v.homeMeterId||v.homeGeneration))meter.bytes=0;meter.epoch=v.homeMeterId||v.homeGeneration;meter.connected=true;return {...meter,generation:v.homeGeneration,base:v.usedBytes,confirmed:true};},
  async readHome(v){return {...meter,generation:v.homeGeneration};},
  async revokeHome(v){calls.push(["home.revoke",v.homeGeneration]);const reading={...meter,generation:v.homeGeneration};meter.connected=false;return {confirmed:true,reading};},
 };
 const service=createHomeService({store,router,env:{NDAHI_HOME_ENABLED:"true"},now:()=>clock});
 return {store,calls,meter,service,router,setOffline(v){offline=v;},advance(ms=60001){clock=new Date(+clock+ms);}};
}

test("additive state defaults to direct without altering existing allowance",()=>{const s=state();s.vouchers.push(voucher());const original=structuredClone(s.vouchers[0]);assert.equal(homeView(s,"c1",at,false).accessMode,"direct");assert.deepEqual(s.vouchers[0],original);});
test("one-use enrollment rejects replay, expired proof and cross-account claims",()=>{
 const s=state(),proof=challenge(s);reserveHomeLink(s,"c1",proof,"ch1","Router",at);
 assert.throws(()=>reserveHomeLink(s,"c1",proof,"ch1","Router",at),{code:"HOME_PROOF_REQUIRED"});
 const foreign=challenge(s,"ch2","c2");assert.throws(()=>reserveHomeLink(s,"c2",foreign,"ch2","Router",at),{code:"HOME_ALREADY_LINKED"});
 const late=challenge(s,"ch3","c2");assert.throws(()=>reserveHomeLink(s,"c2",late,"ch3","Router",new Date(+at+121000)),{code:"HOME_PROOF_REQUIRED"});
 assert.equal(s.homeConnections.length,1);
});
test("two concurrent household claims have exactly one winner",async()=>{
 const store=createStore({persistent:false});await store.transaction(s=>{Object.assign(s,state());challenge(s,"a","c1");challenge(s,"b","c2");});
 const results=await Promise.allSettled(["c1","c2"].map((id,index)=>store.transaction(s=>reserveHomeLink(s,id,{challengeId:index?"b":"a",mac,address:"10.20.0.9",hostId:"*h",sessionId:"*s"},index?"b":"a","Home",at))));
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal((await store.snapshot()).homeConnections.length,1);
});
test("direct-to-home revokes before activation and preserves used allowance and calendar expiry",async()=>{
 const f=await fixture();const original=(await f.store.snapshot()).vouchers[0];
 await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));
 assert.equal((await f.store.snapshot()).vouchers[0].accessMode,undefined);
 await f.service.run();const s=await f.store.snapshot(),v=s.vouchers[0];
 assert.equal(v.accessMode,"home");assert.equal(v.usedBytes,20);assert.equal(v.quotaBytes,original.quotaBytes);assert.equal(v.expiresAt,original.expiresAt);
 assert.equal(v.homeStatus,"connected");assert.equal(s.homeOperations[0].status,"processed");assert.deepEqual(f.calls.map(c=>c[0]),["direct.revoke","home.authorize"]);
});
test("router outage retains entitlement and retries without authorizing or charging twice",async()=>{
 const f=await fixture({fail:true});await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));
 await f.service.run();let s=await f.store.snapshot();assert.equal(s.homeOperations[0].status,"retry");assert.equal(s.vouchers[0].usedBytes,20);assert.equal(f.calls.some(c=>c[0]==="home.authorize"),false);
 f.setOffline(false);f.advance();await f.service.run();s=await f.store.snapshot();assert.equal(s.vouchers.length,1);assert.equal(s.vouchers[0].homeStatus,"connected");assert.equal(s.payments.length,0);
});
test("one measured allowance covers household traffic; repeated observations never double-count",async()=>{
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();
 f.meter.bytes=120;f.advance(15001);await f.service.run();f.advance(15001);await f.service.run();let s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,140);
 f.meter.bytes=200;f.advance(15001);await f.service.run();s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,220);assert.equal(s.homeUsageObservations.filter(o=>o.type==="usage.high_water").length,1);
 assert.ok(s.homeOperations.length<=2,"refresh reuses a bounded durable job rather than adding a heartbeat row");
});
test("counter or reboot epoch discontinuity fails closed without resetting balance",async()=>{
 for(const change of [meter=>{meter.bytes=0;},meter=>{meter.epoch=null;}]){
  const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();f.meter.bytes=100;f.advance(15001);await f.service.run();
  change(f.meter);f.advance(15001);await f.service.run();const s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,120);assert.equal(s.vouchers[0].homeStatus,"accounting_review");assert.equal(f.meter.connected,false);assert.equal(s.homeOperations.at(-1).status,"needs_review");
 }
});
test("home-to-direct waits for revocation and final usage before enabling direct sync",async()=>{
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();f.meter.bytes=45;
 await f.store.transaction(s=>requestHomeMode(s,"c1","v1","direct",at));await f.service.run();const s=await f.store.snapshot();assert.equal(s.vouchers[0].accessMode,"direct");assert.equal(s.vouchers[0].usedBytes,65);assert.equal(f.meter.connected,false);assert.equal(s.routerCommands.at(-1).action,"sync_voucher");
});
test("replacement revokes old authorization, retains usage/expiry and binds one new generation",async()=>{
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();f.meter.bytes=80;
 let replacement;
 await f.store.transaction(s=>{const proof=challenge(s,"new");proof.mac="AA:BB:CC:DD:EE:88";replacement=reserveHomeLink(s,"c1",proof,"new","Replacement",at);});
 await f.service.run();let s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,100);assert.equal(s.homeConnections.filter(h=>h.status==="linked").length,1);assert.equal(s.customers[0].homeConnectionId,replacement.id);assert.equal(f.meter.connected,true);
 f.meter.bytes=0;f.advance(15001);await f.service.run();s=await f.store.snapshot();assert.equal(s.vouchers[0].usedBytes,100);assert.equal(s.vouchers[0].homeGeneration,replacement.generation);assert.equal(s.vouchers[0].homeStatus,"connected");
});
test("exhausted unexpired linked households can reserve renewal; active-with-data stays protected",()=>{
 const s=state();link(s);s.vouchers.push(voucher({usedBytes:1000}));
 const options={clock:()=>at,provider:"mock",accountCustomerId:"c1",requester:{ip:"198.51.100.2"},homeEnabled:true};
 const first=reservePurchase(s,{planId:"daily",action:"renew",accessMode:"home",requestKey:"a".repeat(32)},options);assert.equal(first.status,201);assert.equal(first.payment.accessMode,"home");
 const duplicate=reservePurchase(s,{planId:"daily",action:"renew",accessMode:"home",requestKey:"a".repeat(32)},options);assert.equal(duplicate.status,200);assert.equal(s.payments.length,1);
 const active=state();link(active);active.vouchers.push(voucher());assert.equal(reservePurchase(active,{planId:"daily",action:"renew",accessMode:"home"},options).body.code,"ACTIVE_BUNDLE_EXISTS");
});
test("home payment is rejected without a verified owned link or while the feature is off",()=>{
 const s=state();assert.throws(()=>homePaymentFields(s,s.customers[0],"home",true),{code:"HOME_LINK_REQUIRED"});link(s);assert.throws(()=>homePaymentFields(s,s.customers[0],"home",false),{code:"HOME_LINK_REQUIRED"});
});
test("legacy reconciliation cannot reenable direct credentials for home or switching entitlements",async()=>{
 const store=createStore({persistent:false});await store.transaction(s=>{s.vouchers.push(voucher({accessMode:"home"}),voucher({id:"v2",accessTransitionId:"pending"}));});
 await createRouterReconciler({store,router:{readState:async()=>({vouchers:[]})},now:()=>at})();assert.equal((await store.snapshot()).routerCommands.length,0);
});
test("finite native-quota observation exhausts without modifying validity; unlimited remains unbounded",()=>{
 const s=state(),v=voucher({accessMode:"home",homeGeneration:"g",homeAccounting:{base:20,raw:0,epoch:"e"}});s.vouchers.push(v);
 applyHomeUsage(s,v,{bytes:980,epoch:"e",generation:"g"},at);assert.equal(v.status,"exhausted");assert.equal(v.usedBytes,1000);assert.equal(v.expiresAt,voucher().expiresAt);
 const u=voucher({quotaBytes:null,homeGeneration:"g",homeAccounting:{base:0,raw:0,epoch:"e"}});applyHomeUsage(s,u,{bytes:1e12,epoch:"e",generation:"g"},at);assert.equal(u.status,"active");
});

test("confirmed quota cutoff records final usage once and does not queue terminal households forever", async () => {
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();
 const expires=(await f.store.snapshot()).vouchers[0].expiresAt;
 f.meter.bytes=1000;f.advance();await f.service.run();
 let state=await f.store.snapshot();assert.equal(state.vouchers[0].homeStatus,"exhausted");
 assert.equal(state.vouchers[0].usedBytes,1020);assert.equal(state.vouchers[0].expiresAt,expires);
 assert.equal(f.meter.connected,false);
 assert.equal(state.homeUsageObservations.filter(o=>o.type==="authorization.cutoff_confirmed").length,1);
 const operations=state.homeOperations.length;f.advance();await f.service.run();state=await f.store.snapshot();
 assert.equal(state.homeOperations.length,operations);
 assert.equal(state.homeUsageObservations.filter(o=>o.type==="authorization.cutoff_confirmed").length,1);
});

test("an unconfirmed native revocation never becomes a successful cutoff observation", async () => {
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();
 f.router.revokeHome=async()=>({confirmed:false});f.meter.bytes=1000;f.advance();await f.service.run();
 const state=await f.store.snapshot();
 assert.equal(state.homeUsageObservations.some(o=>o.type==="authorization.cutoff_confirmed"),false);
 assert.equal(state.vouchers[0].homeStatus,"activation_pending");
 assert.equal(state.homeOperations.some(o=>o.status==="retry"),true);
});

test("repeated direct/Home switches retain all traffic with a fresh Home meter and reduced direct cap",async()=>{
 const f=await fixture();await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();
 const initial=(await f.store.snapshot()).vouchers[0];f.meter.bytes=45;
 await f.store.transaction(s=>requestHomeMode(s,"c1","v1","direct",at));await f.service.run();
 let v=(await f.store.snapshot()).vouchers[0];assert.equal(v.usedBytes,65);assert.equal(v.directUsageOffset,45);assert.equal(routerVoucherPayload(v).limitBytesTotal,955);
 await f.store.transaction(s=>requestHomeMode(s,"c1","v1","home",at));await f.service.run();v=(await f.store.snapshot()).vouchers[0];
 assert.notEqual(v.homeMeterId,initial.homeMeterId);assert.equal(v.usedBytes,65);assert.equal(v.homeAccounting.base,65);
 f.meter.bytes=15;f.advance();await f.service.run();v=(await f.store.snapshot()).vouchers[0];assert.equal(v.usedBytes,80);
 assert.equal(v.expiresAt,initial.expiresAt);
});

test("direct usage after Home includes the durable offset and ignores obsolete direct readings in Home mode",async()=>{
 const store=createStore({persistent:false});await store.transaction(s=>{s.vouchers.push(voucher({usedBytes:65,directUsageOffset:45}),voucher({id:"v2",accessMode:"home",usedBytes:200}));enqueueRouterCommand(s,{action:"sync_usage"},()=>at);});
 const processor=createRouterCommandProcessor({store,now:()=>at,router:{readUsage:async()=>[{voucherId:"v1",usedBytes:40},{voucherId:"v2",usedBytes:700}]}});
 await processor.process();const s=await store.snapshot();assert.equal(s.vouchers[0].usedBytes,85);assert.equal(s.vouchers[1].usedBytes,200);
});
