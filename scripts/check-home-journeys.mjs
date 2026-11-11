import assert from "node:assert/strict";
import http from "node:http";
import {randomUUID} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {setDefaultResultOrder} from "node:dns";
import {createStaticServer} from "../static-server.mjs";
import {pairingFixture} from "../test/helpers/wifi-pairing-fixture.mjs";
import {securityKey} from "../test/helpers/customer-security-key.mjs";
import {hashSecret} from "../lib/security.mjs";
import {homePilotTemplate} from "../lib/home-pilot.mjs";
import {uiV2} from "./admin-nav.mjs";

setDefaultResultOrder("ipv4first");
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
const browser=await chromium.launch({headless:true,...(process.env.PLAN_CHROME_PATH?{executablePath:process.env.PLAN_CHROME_PATH}:{})});
const output=process.env.HOME_QA_DIR||"/tmp/ndahi-home-qa";await mkdir(output,{recursive:true});let checks=0;
const listen=server=>new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const stop=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
try{
 for(const width of [320,1280]){
  const website=http.createServer(),adminWebsite=http.createServer();await listen(website);await listen(adminWebsite);
  const portal=`http://localhost:${website.address().port}`,admin=`http://localhost:${adminWebsite.address().port}`,gateway="https://connect.home.test/login";
  const fixturePassword=randomUUID(),proofs=new Set(),meters=new Map();let offline=false,ingress="203.0.113.10";
  const meter=v=>{if(!meters.has(v.id+(v.homeMeterId||v.homeGeneration)))meters.set(v.id+(v.homeMeterId||v.homeGeneration),{bytes:0,epoch:v.homeMeterId||v.homeGeneration,connected:false});return meters.get(v.id+(v.homeMeterId||v.homeGeneration));};
  const f=await pairingFixture({origin:portal,now:new Date(),liveClock:true,env:{NDAHI_HOME_ENABLED:"true",NODE_ENV:"test",PAYMENT_MODE:"mock",ADMIN_APP_URL:admin,ALLOWED_ADMIN_ORIGINS:admin,ADMIN_SESSION_SECRET:"home-admin-fixture",CUSTOMER_SESSION_SECONDS:"86400"},router:{
   async beginHomeEnrollment(ch){return {url:gateway,username:ch.id,password:fixturePassword};},
   async verifyHomeEnrollment(ch){if(!proofs.has(ch.id))throw Error("Local sign-in missing");return {challengeId:ch.id,mac:"AA:BB:CC:DD:EE:90",address:"10.20.0.90",hostId:"*h",sessionId:"*s"};},
   async endHomeEnrollment(){return {confirmed:true};},
   async disconnectVoucher(){if(offline)throw Error("Router offline");return {disconnected:true};},
   async readUsage(){return [{voucherId:"v1",usedBytes:20}];},
   async authorizeHome({voucher:v}){if(offline)throw Error("Router offline");meter(v).connected=true;return {...meter(v),generation:v.homeGeneration,base:v.homeAccounting?.base??v.usedBytes,confirmed:true};},
   async readHome(v){if(offline)throw Error("Router offline");return {...meter(v),generation:v.homeGeneration};},
   async revokeHome(v){if(offline)throw Error("Router offline");const reading={...meter(v),generation:v.homeGeneration};meter(v).connected=false;return {confirmed:true,reading};},
  }});
  f.handler.homeService.wake=()=>{};
  const api=f.api.replace("127.0.0.1","localhost");
  const assets=createStaticServer("customer",{apiUrl:api,hotspotLoginUrl:gateway,production:false}),adminAssets=createStaticServer("admin",{apiUrl:api,production:false});
  website.on("request",(req,res)=>assets.emit("request",req,res));adminWebsite.on("request",(req,res)=>adminAssets.emit("request",req,res));
  const context=await browser.newContext({viewport:{width,height:900}}),errors=[];
  await context.addCookies([{name:"customer_session",value:"main",domain:"localhost",path:"/api/account",httpOnly:true,sameSite:"Lax"}]);
  await context.addInitScript(()=>{Object.defineProperty(window,"sessionStorage",{get(){throw new DOMException("Blocked","SecurityError");}});});
  await context.addInitScript(()=>{if(window.SubmitEvent)Object.defineProperty(SubmitEvent.prototype,"submitter",{get(){return undefined;}});});
  await context.route("**/*",async route=>{
   const url=route.request().url();
   if(url===gateway){const input=new URLSearchParams(route.request().postData());assert.equal(input.get("password"),fixturePassword);proofs.add(input.get("username"));return route.fulfill({status:302,headers:{location:input.get("dst")},body:""});}
   if([portal,api,admin].includes(new URL(url).origin))return route.continue({headers:{...route.request().headers(),"cf-connecting-ip":ingress}});
   return route.abort("blockedbyclient");
  });
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(15000);
  try{
   await page.goto(portal+"/home-router.html");await page.locator("#enrollHome").waitFor();
   await page.getByRole("heading",{name:"Use any WISP/NAT router",exact:true}).waitFor();
   await page.locator("#enrollHome").click();await page.getByRole("button",{name:"Continue to local gateway sign-in",exact:true}).click();
   await page.locator("#confirmHome").waitFor();await page.locator('#confirmHome [name="name"]').fill("Family router");await page.locator('#confirmHome [name="confirm"]').check();
   await page.getByRole("button",{name:"Confirm household connection",exact:true}).click();await page.locator("#homeStatus h3").filter({hasText:"Family router"}).waitFor();checks++;
   await page.locator("#homePin").fill("2468");const modeResponse=page.waitForResponse(r=>r.url().endsWith("/home/mode"));await page.locator("#modeHome").click();assert.equal((await modeResponse).status(),202);
   await f.handler.homeService.run();await page.locator("#refreshHome").click();await page.locator("#homeStatus").getByText(/Router authorization confirmed/).waitFor();checks++;
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"Home layout must fit the viewport");
   await page.screenshot({path:`${output}/home-${width}.png`,fullPage:true});checks++;
   await page.locator('[data-language="fr"]').click();await page.getByRole("heading",{name:"Un forfait partagé à la maison",exact:true}).waitFor();await page.screenshot({path:`${output}/home-fr-${width}.png`,fullPage:true});checks++;
   await page.goto(portal+"/dashboard");await page.locator("#dataBalance").getByText("All home devices share this allowance.",{exact:true}).waitFor();assert.equal(await page.locator("#manageDevices").count(),0);assert.equal(await page.locator("#dataBalance").getByText("Connected devices",{exact:true}).count(),0);checks++;
   await f.store.transaction(s=>{const v=s.vouchers[0];meter(v).bytes=v.quotaBytes-v.homeAccounting.base;});f.advance(16);await f.handler.homeService.run();
   await page.goto(portal+"/home-router.html");await page.locator("#homePurchase").waitFor();await page.locator("#homeStatus").getByText(/Data exhausted/).waitFor();
   ingress="198.51.100.90";await page.locator('#homePurchase [name="planId"]').selectOption("family");
   const paymentResponse=page.waitForResponse(r=>r.url().endsWith("/plan/purchase"));await page.locator("#homePurchase button").click();const reserved=await paymentResponse;assert.equal(reserved.status(),201);const payment=await reserved.json();checks++;
   const confirmed=await context.request.post(api+`/api/payments/${payment.payment.id}/confirm`,{headers:{origin:portal,"cf-connecting-ip":ingress},data:{}});assert.equal(confirmed.status(),200);
   offline=true;await f.handler.homeService.run();await page.locator("#refreshHome").click();await page.locator("#homeStatus").getByText(/Payment confirmed/).waitFor();assert.equal((await f.store.snapshot()).vouchers.filter(v=>v.paymentId===payment.payment.id).length,1);checks++;
   offline=false;f.advance(65);await f.handler.homeService.run();await page.locator("#refreshHome").click();await page.locator("#homeStatus").getByText(/Router authorization confirmed/).waitFor();checks++;
   await f.store.transaction(s=>{s.adminUsers.push({id:"home-owner",username:"owner",role:"owner",active:true});s.adminSessions.push({id:"home-admin",userId:"home-owner",role:"owner",tokenHash:hashSecret("home-admin","home-admin-fixture"),csrfToken:"admin-csrf",expiresAt:new Date(+f.now()+3600000).toISOString()});});
   await context.addCookies([{name:"admin_session",value:"home-admin",domain:"localhost",path:"/api/admin",httpOnly:true,sameSite:"Lax"}]);
   await page.goto(admin+"/home-routers.html");await page.locator(uiV2?"#homeAdminList tbody tr":"#homeAdminList h2").filter({hasText:"Family router"}).waitFor();assert.equal((await page.locator("#homeAdminList").textContent()).includes("AA:BB:CC:DD:EE:90"),false);checks++;
   await page.locator("#homeQueueAge").waitFor();
   await page.route(api+"/api/admin/home/readiness",route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Synthetic readiness failure"})}));
   await page.locator("#checkHomeReadiness").focus();await page.keyboard.press("Enter");
   await page.locator("#homeAdminMessage").getByText("Synthetic readiness failure",{exact:true}).waitFor();
   assert.equal(await page.locator("#checkHomeReadiness").isEnabled(),true);
   await page.unroute(api+"/api/admin/home/readiness");
   await page.locator("#checkHomeReadiness").click();await page.locator("#homeReadiness").getByRole("heading",{name:"Readiness checks",exact:true}).waitFor();checks++;
   await page.locator("#homePilotFile").setInputFiles({name:"synthetic-pilot.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({...homePilotTemplate(),evidenceKind:"synthetic"}))});
   await page.locator("#homePilotReason").fill("Synthetic browser fixture; no physical acceptance");
   await page.locator("#homePilotImport button[type=submit]").click();
   await page.locator("#homePilotStatus").getByText("Incomplete or failed checks",{exact:true}).waitFor();checks++;
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"Home operations must fit the viewport");
   await page.screenshot({path:`${output}/home-admin-${width}.png`,fullPage:true});
   const key=securityKey(),cdp=await context.newCDPSession(page);await cdp.send("WebAuthn.enable");
   const {authenticatorId}=await cdp.send("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
   await cdp.send("WebAuthn.addCredential",{authenticatorId,credential:{credentialId:Buffer.from(key.record.id,"base64url").toString("base64"),isResidentCredential:false,rpId:"localhost",privateKey:key.privateKey.export({format:"der",type:"pkcs8"}).toString("base64"),signCount:0}});
   await f.store.transaction(s=>{delete s.customers[0].pinHash;s.customers[0].passkeys=[key.record];});
   await page.goto(portal+"/home-router.html");const revoked=page.waitForResponse(r=>r.url().endsWith("/home/revoke"));await page.locator("#revokeHomePasskey").click();assert.equal((await revoked).status(),202);
   await f.handler.homeService.run();assert.equal((await f.store.snapshot()).homeConnections.some(h=>h.status==="linked"),false);checks++;
   assert.deepEqual(errors,[]);console.log(`PASS ${width}px Home local challenge, assignment, shared balance, French, dashboard, off-site exhausted renewal, outage/recovery, masked admin view and PIN-less passkey revocation`);
  }finally{await context.close();await f.close();await stop(website);await stop(adminWebsite);}
 }
 console.log(JSON.stringify({checks,result:"passed",screenshots:output,evidence:"Local browser/API with synthetic gateway and mock payment only; no hardware, production network or charge."}));
}finally{await browser.close();}
