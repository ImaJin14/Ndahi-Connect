import test from 'node:test';
import assert from 'node:assert/strict';
import { connectivityState } from '../lib/connectivity-state.mjs';
import { networkBannerState, probeBrowserInternet } from '../customer-app/network-status.js';
import { pairingFixture,mainMac } from './helpers/wifi-pairing-fixture.mjs';
const publicPath='/api/account/connectivity';
async function fixture(t) {const f=await pairingFixture({now:new Date(),liveClock:true});t.after(f.close);return f;}
async function identify(f){const r=await f.call('/api/account/device-management/current/identify',{mac:mainMac,address:'10.20.0.1'});assert.equal(r.status,200);return r;}

test('anonymous trusted ingress detects network without requiring a paid bundle or disclosing account metadata',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.vouchers=[];});const r=await f.call(publicPath,undefined,{session:''});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.body.network.state,'confirmed');assert.equal(r.body.hotspot.state,'unknown');assert.equal(r.body.internet.state,'unknown');assert.equal(r.body.decision.action,'sign-in');assert.equal(r.body.subscription.state,'unknown');assert.doesNotMatch(JSON.stringify(r.body),/670050001|Imajin|c1|v1|NC-AAAA/);
 const banner=networkBannerState({connectivity:r.body});assert.equal(banner.actionHref,'/login');assert.doesNotMatch(banner.message,/join|connect to NDAHI Wi-Fi/i);
});
test('an active bundle and arbitrary browser-supplied MAC cannot establish this device HotSpot authorization',async t=>{
 const f=await fixture(t);const r=await f.call(publicPath+'?mac='+mainMac+'&address=10.20.0.1');assert.equal(r.body.hotspot.state,'unknown');assert.equal(r.body.subscription.state,'active');assert.notEqual(networkBannerState({connectivity:r.body}).status,'active');
});
test('exact session-bound router evidence confirms HotSpot access but never invents working internet',async t=>{
 const f=await fixture(t);await identify(f);const r=await f.call(publicPath);assert.equal(r.body.hotspot.state,'authenticated');assert.equal(r.body.router.state,'reachable');assert.equal(r.body.internet.state,'unknown');assert.match(networkBannerState({connectivity:r.body}).message,/Internet availability is not confirmed/);
 const other=await f.call(publicPath,undefined,{session:'secondary'});assert.equal(other.body.hotspot.state,'unknown');
});
test('off-network ingress and disabled coverage remain distinct from a physical SSID claim',async t=>{
 const f=await fixture(t);await identify(f);const r=await f.call(publicPath,undefined,{address:'198.51.100.10'});assert.equal(r.body.network.state,'unconfirmed');assert.equal(r.body.hotspot.state,'unknown');assert.equal(r.body.account.state,'authenticated');assert.equal(r.body.decision.href,'/dashboard');assert.doesNotMatch(networkBannerState({connectivity:r.body}).message,/you are.*mobile|join NDAHI/i);
 const s=await f.store.snapshot();assert.equal(connectivityState(s,{session:s.dashboardSessions[0],ingress:true,coverageEnabled:false,now:f.now()}).network.state,'unknown');
});
for(const state of ['expired','exhausted','none'])test(state+' subscription selects eligible plans only after account authentication',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{if(state==='none')s.vouchers=[];else{s.vouchers[0].status=state;if(state==='exhausted')s.vouchers[0].usedBytes=s.vouchers[0].quotaBytes;}});const r=await f.call(publicPath);assert.equal(r.body.subscription.state,state);assert.equal(r.body.decision.href,'/dashboard#bundles');assert.equal((await f.call(publicPath,undefined,{session:''})).body.subscription.state,'unknown');
});
test('stale identity/router failures cannot become Connected or prove internet failure',async t=>{
 const f=await fixture(t);await identify(f);f.advance(901);const failedAt=f.now().toISOString();await f.store.transaction(s=>{s.routerCommands.push({id:'router:sync_usage:global',status:'dead_letter',lastAttemptAt:failedAt});});const r=await f.call(publicPath);assert.equal(r.body.hotspot.state,'unknown');assert.equal(r.body.router.state,'unavailable');assert.equal(r.body.router.observedAt,failedAt);assert.equal(r.body.internet.state,'unknown');
});
test('expired account sessions are anonymous, and endpoint cannot mutate or accept client evidence',async t=>{
 const f=await fixture(t);await identify(f);f.advance(86401);const r=await f.call(publicPath);assert.equal(r.body.account.state,'signed-out');assert.equal(r.body.subscription.state,'unknown');assert.equal((await f.call(publicPath,{network:{state:'confirmed'}})).status,405);
});
test('browser internet check requires a real CORS-readable response and never sends account credentials',async()=>{
 let options;const success=await probeBrowserInternet({request:async(url,o)=>{assert.match(url,/^https:\/\/www\.cloudflare\.com\/cdn-cgi\/trace\?ndahi_check=\d+$/);options=o;return new Response('h=www.cloudflare.com\ncolo=CDG\n',{headers:{'content-type':'text/plain'}});}});assert.equal(success.state,'available');assert.equal(success.scope,'browser-path');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');
 for(const response of [new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}}),new Response('h=attacker.test\ncolo=CDG\n',{headers:{'content-type':'text/plain'}}),new Response('',{status:503})]) assert.equal((await probeBrowserInternet({request:async()=>response})).state,'unavailable');
});
test('a slow response body remains bounded and opaque/public API success is not internet evidence',async()=>{
 const result=await probeBrowserInternet({request:async()=>({ok:true,redirected:false,headers:new Headers({'content-type':'text/plain'}),text:()=>new Promise(()=>{})})});assert.equal(result.state,'unavailable');
 const opaque=await probeBrowserInternet({request:async()=>({ok:false,type:'opaque',headers:new Headers(),text:async()=>''})});assert.equal(opaque.state,'unavailable');
});
