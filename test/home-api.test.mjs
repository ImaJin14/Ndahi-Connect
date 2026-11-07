import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";
import { receiptView } from "../lib/receipt.mjs";
import { ensureHome, reserveHomeLink } from "../lib/home.mjs";
const root="/api/account/home",mac="AA:BB:CC:DD:EE:90";
async function fixture(env={}){
 const calls=[],meters=new Map();
 const meter=v=>{const id=v.homeMeterId||v.homeGeneration;if(!meters.has(id))meters.set(id,{bytes:0,epoch:id,connected:false});return meters.get(id);};
 const f=await pairingFixture({env:{NDAHI_HOME_ENABLED:"true",...env},router:{
  async beginHomeEnrollment(ch){calls.push(["begin",ch.id]);return {url:"https://connect.ndahiconnect.net/login",username:"one-use",password:"temporary-enrollment-secret"};},
  async verifyHomeEnrollment(ch){calls.push(["proof",ch.id]);return {challengeId:ch.id,mac,address:"10.20.0.90",hostId:"*gateway",sessionId:"*actual"};},
  async endHomeEnrollment(ch){calls.push(["end",ch.id]);return {confirmed:true};},
  async disconnectVoucher(){return {disconnected:true};},
  async readUsage(){return [{voucherId:"v1",usedBytes:20}];},
  async authorizeHome({voucher:v}){meter(v).connected=true;return {...meter(v),generation:v.homeGeneration,base:v.usedBytes,confirmed:true};},
  async readHome(v){return {...meter(v),generation:v.homeGeneration};},
  async revokeHome(v){const reading={...meter(v),generation:v.homeGeneration};meter(v).connected=false;return {confirmed:true,reading};},
 }});
 // This fixture exercises production auth/CSRF with a synthetic gateway/store.
 // Database definition validation is covered against PostgreSQL separately.
 f.store.homeSchemaReadiness = async () => ({ status: "ready", checks: [] });
 f.handler.homeService.wake=()=>{};
 return {...f,calls};
}
test("a new unpaid Home customer can register and link, without overwriting an existing account",async()=>{
 const f=await fixture({NODE_ENV:"test",PAYMENT_MODE:"mock"});try{
  const registration=await f.call(root+"/register",{phone:"670050009",name:"New household",pin:"2468",confirmPin:"2468"},{session:""});
  assert.equal(registration.status,200);const session=registration.headers.get("set-cookie").match(/customer_session=([^;]+)/)[1];
  const account=await f.call("/api/account/dashboard",undefined,{session}),csrf=account.body.csrfToken;
  const start=await f.call(root+"/enroll",{},{session,csrf});assert.equal(start.status,201);
  assert.equal((await f.call(root+"/confirm",{enrollmentId:start.body.enrollmentId,confirm:true},{session,csrf})).status,202);
  const purchase=await f.call("/api/account/plan/purchase",{planId:"daily",action:"switch",accessMode:"home",requestKey:"z".repeat(48)},{session,csrf});
  assert.equal(purchase.status,201,JSON.stringify(purchase.body));
  assert.equal((await f.call(`/api/payments/${purchase.body.payment.id}/confirm`,{}, {session})).status,200);
  await f.handler.homeService.run();
  const issued=(await f.store.snapshot()).vouchers.find(v=>v.paymentId===purchase.body.payment.id);assert.equal(issued.homeStatus,"connected");
  const original=(await f.store.snapshot()).customers.find(c=>c.phone==="670050009");
  assert.equal((await f.call(root+"/register",{phone:"670050009",pin:"9999",confirmPin:"9999"},{session:""})).status,409);
  const after=(await f.store.snapshot()).customers.find(c=>c.phone==="670050009");assert.equal(after.id,original.id);assert.equal(after.pinHash,original.pinHash);assert.equal(after.phoneOwnershipVerified,false);
 }finally{await f.close();}
});
test("feature off preserves direct mode and cannot start Home enrollment",async()=>{
 const f=await fixture({NDAHI_HOME_ENABLED:"false"});try{assert.equal((await f.call(root)).body.enabled,false);assert.equal((await f.call(root+"/enroll",{})).status,404);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test("enrollment requires authenticated session, CSRF and local site ingress",async()=>{
 const f=await fixture();try{
  assert.equal((await f.call(root+"/enroll",{}, {session:""})).status,401);
  assert.equal((await f.call(root+"/enroll",{}, {csrf:"wrong"})).status,403);
  assert.equal((await f.call(root+"/enroll",{}, {address:"198.51.100.9"})).status,403);
  assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test("local challenge derives identity at gateway; supplied identifiers are rejected and proof is single use",async()=>{
 const f=await fixture();try{
  assert.equal((await f.call(root+"/enroll",{mac:"AA:BB:CC:DD:EE:77"})).status,400);
  const start=await f.call(root+"/enroll",{});assert.equal(start.status,201);const id=start.body.enrollmentId;
  assert.equal((await f.call(root+"/confirm",{enrollmentId:id,confirm:true},{session:"other"})).status,409);
  assert.equal((await f.call(root+"/confirm",{enrollmentId:id,confirm:true,name:"House"})).status,202);
  const s=await f.store.snapshot();assert.equal(s.homeConnections[0].mac,mac);assert.equal(s.homeConnections[0].customerId,"c1");
  const again=await f.call(root+"/confirm",{enrollmentId:id,confirm:true});assert.equal(again.status,409);
  const view=await f.call(root);assert.equal(view.body.link.name,"House");assert.equal(JSON.stringify(view.body).includes(mac),false);assert.equal(JSON.stringify(s).includes("temporary-enrollment-secret"),false);
 }finally{await f.close();}
});
test("expired or cross-account gateway challenges cannot create links",async()=>{
 const f=await fixture();try{const start=await f.call(root+"/enroll",{});f.advance(121);assert.equal((await f.call(root+"/confirm",{enrollmentId:start.body.enrollmentId,confirm:true})).status,409);assert.equal((await f.store.snapshot()).homeConnections.length,0);}finally{await f.close();}
});
test("replacement requires fresh owner proof and keeps previous link until revocation",async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{ensureHome(s);s.homeChallenges.push({id:"old",customerId:"c1",status:"ready",routerRevision:"router-1",expiresAt:new Date(+f.now()+100000).toISOString()});reserveHomeLink(s,"c1",{challengeId:"old",mac:"AA:BB:CC:DD:EE:89",address:"10.20.0.89",hostId:"*old",sessionId:"*old"},"old","Old",f.now());});
  const start=await f.call(root+"/enroll",{}),enrollmentId=start.body.enrollmentId;
  assert.equal((await f.call(root+"/confirm",{enrollmentId,confirm:true,pin:"9999"})).status,401);
  f.advance(3);assert.equal((await f.call(root+"/confirm",{enrollmentId,confirm:true,pin:"2468"})).status,202);
  const s=await f.store.snapshot();assert.equal(s.homeConnections.filter(h=>h.status==="reserved").length,1);assert.equal(s.homeConnections.filter(h=>h.status==="retiring").length,1);assert.equal(s.homeOperations.at(-1).kind,"replace");
 }finally{await f.close();}
});
test("linked exhausted household can initiate renewal from mobile data without weakening direct coverage",async()=>{
 const f=await fixture({PAYMENT_MODE:"mock",NODE_ENV:"test"});try{
  await f.store.transaction(s=>{ensureHome(s);const v=s.vouchers[0];v.usedBytes=v.quotaBytes;v.planId="family";
   s.homeChallenges.push({id:"ch",customerId:"c1",status:"ready",routerRevision:"router-1",expiresAt:new Date(+f.now()+100000).toISOString()});
   reserveHomeLink(s,"c1",{challengeId:"ch",mac,address:"10.20.0.90",hostId:"*h",sessionId:"*s"},"ch","House",f.now());});
  const offsite={address:"198.51.100.8"},input={planId:"family",action:"renew",accessMode:"home",requestKey:"f".repeat(48)};
  const result=await f.call("/api/account/plan/purchase",input,offsite);assert.equal(result.status,201,JSON.stringify(result.body));
  const duplicate=await f.call("/api/account/plan/purchase",input,offsite);assert.ok([200,201].includes(duplicate.status));assert.equal((await f.store.snapshot()).payments.length,1);
  assert.equal((await f.call("/api/account/plan/purchase",{...input,accessMode:"direct",requestKey:"b".repeat(48)},offsite)).status,403);
 }finally{await f.close();}
});
test("verified duplicate payment confirmation creates one Home entitlement and pending activation",async()=>{
 const f=await fixture({PAYMENT_MODE:"mock",NODE_ENV:"test"});try{
  await f.store.transaction(s=>{ensureHome(s);s.vouchers[0].usedBytes=s.vouchers[0].quotaBytes;
   s.homeChallenges.push({id:"ch",customerId:"c1",status:"ready",routerRevision:"router-1",expiresAt:new Date(+f.now()+100000).toISOString()});reserveHomeLink(s,"c1",{challengeId:"ch",mac,address:"10.20.0.90",hostId:"*h",sessionId:"*s"},"ch","House",f.now());});
  const created=await f.call("/api/account/plan/purchase",{planId:"family",action:"renew",accessMode:"home",requestKey:"f".repeat(48)});assert.equal(created.status,201);
  const id=created.body.payment.id;
  // Confirmation is a development-only mock provider boundary, not a browser
  // success redirect or a real Mobile Money charge.
  const first=await f.call(`/api/payments/${id}/confirm`,{});assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal((await f.call(`/api/payments/${id}/confirm`,{})).status,200);
  const s=await f.store.snapshot(),issued=s.vouchers.filter(v=>v.paymentId===id);assert.equal(issued.length,1);assert.equal(issued[0].accessMode,"home");assert.equal(issued[0].homeStatus,"activation_pending");assert.equal(s.homeOperations.filter(o=>o.voucherId===issued[0].id).length,1);
  assert.match(receiptView(s.payments[0].receipt).deviceLabel,/Shared Home access/);
 }finally{await f.close();}
});
test("Home allocation rejects old direct connect paths",async()=>{
 const f=await fixture();try{await f.store.transaction(s=>{s.vouchers[0].accessMode="home";});const response=await f.call("/api/account/device-management/connect",{mac,address:"10.20.0.90",key:"a".repeat(32)});assert.ok(response.status>=400);assert.equal(f.calls.some(c=>c[0]==="home.authorize"),false);}finally{await f.close();}
});

test("Home admin actions require an allowed role, CSRF and an audited reason",async()=>{
 const adminOrigin="http://admin.test",secret="home-admin-role-fixture",f=await fixture({ADMIN_APP_URL:adminOrigin,ALLOWED_ADMIN_ORIGINS:adminOrigin,ADMIN_SESSION_SECRET:secret});
 try{
  await f.store.transaction(s=>{for(const role of ["owner","operator","auditor","reseller"]){s.adminUsers.push({id:role,username:role,role,active:true});s.adminSessions.push({id:role,userId:role,role,tokenHash:hashSecret(role,secret),csrfToken:"csrf",expiresAt:new Date(+f.now()+3600000).toISOString()});}});
  const request=(role,path,input,csrf="csrf")=>fetch(f.api+path,{method:input?"POST":"GET",headers:{origin:adminOrigin,cookie:`admin_session=${role}`,"x-csrf-token":csrf,"content-type":"application/json"},body:input?JSON.stringify(input):undefined});
  for(const role of ["auditor","reseller"])assert.equal((await request(role,"/api/admin/home")).status,403);
  assert.equal((await request("operator","/api/admin/home")).status,200);
  const input={customerId:"c1",reason:"Customer requested household revocation"};
  assert.equal((await request("operator","/api/admin/home/revoke",input,"bad")).status,403);
  assert.equal((await request("owner","/api/admin/home/revoke",{customerId:"c1"})).status,400);
  assert.equal((await request("operator","/api/admin/home/revoke",input)).status,202);
  const s=await f.store.snapshot();assert.equal(s.homeOperations.filter(o=>o.kind==="revoke").length,1);assert.equal(s.auditLogs.some(a=>a.type==="home.admin.operation"||a.action==="home.admin.operation"),true);
 }finally{await f.close();}
});
