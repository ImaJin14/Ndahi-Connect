import test from "node:test";
import assert from "node:assert/strict";
import { HomeRouter, homeNames } from "../lib/home-router.mjs";
const now=new Date("2030-01-01T12:00:00Z"),mac="AA:BB:CC:DD:EE:90";
const voucher=()=>({id:"v1",code:"NC-AAAA-1111",quotaBytes:1000,usedBytes:200,expiresAt:new Date(+now+3600000).toISOString(),homeGeneration:"generation-1"});
function gateway(){
 const rows={"ip/hotspot":[{name:"ndahi-hotspot",profile:"secure",interface:"vlan20-hotspot"}],
  "ip/hotspot/profile":[{name:"secure","login-by":"https,mac-cookie","ssl-certificate":"trusted","dns-name":"connect.ndahiconnect.net"}],
  "ip/firewall/filter":[
   {chain:"forward",action:"jump","src-address-list":"ndahi-home-enrollment","jump-target":"ndahi-home-enroll",comment:"ndahi:home:entry:0"},
   {chain:"forward",action:"jump","src-address-list":"ndahi-home-clients","jump-target":"ndahi-home-forward",comment:"ndahi:home:entry:1"},
   {chain:"ndahi-home-enroll",action:"return","dst-address-list":"ndahi-home-required",comment:"ndahi:home:required"},
   {chain:"ndahi-home-enroll",action:"drop",comment:"ndahi:home:drop"},
   {chain:"ndahi-home-forward",action:"return","src-address-list":"ndahi-home-live",comment:"ndahi:home:live"},
   {chain:"ndahi-home-forward",action:"return","dst-address-list":"ndahi-home-required",comment:"ndahi:home:required"},
   {chain:"ndahi-home-forward",action:"drop",comment:"ndahi:home:drop"}],
  "ipv6/settings":[{"disable-ipv6":"true"}],"ipv6/firewall/filter":[],"ip/hotspot/ip-binding":[],
  "ip/firewall/address-list":[{list:"ndahi-home-required",address:"203.0.113.2",comment:"ndahi:home:required:api"}],
  "ip/hotspot/user/profile":[],"ip/hotspot/user":[],"ip/hotspot/active":[],"ip/hotspot/cookie":[],
  "ip/hotspot/host":[{".id":"*host",server:"ndahi-hotspot","mac-address":mac,address:"10.20.0.90"}],
  "system/scheduler":[],"system/script":[],"system/script/environment":[]};
 let id=0;const calls=[];const router=new HomeRouter({approvalKey:"fixture-".repeat(4),now:()=>now});
 router.request=async(path,method="GET",values)=>{
  calls.push({path,method,values:structuredClone(values)});
  if(method==="GET")return structuredClone(rows[path]||[]);
  if(path==="system/script/run"){
   const script=rows["system/script"].find(s=>s[".id"]===values[".id"]);if(!script)throw Error("script not found");
   const match=script.source.match(/:set (\w+) "([^"]+)"/);if(match){const old=rows["system/script/environment"].find(e=>e.name===match[1]);if(old)old.value=match[2];else rows["system/script/environment"].push({name:match[1],value:match[2]});}return {};
  }
  if(path==="ip/hotspot/active/login"){
   const user=rows["ip/hotspot/user"].find(u=>u.name===values.user);assert.equal(user.disabled,"false");assert.equal(user["mac-address"],values["mac-address"]);
   rows["ip/hotspot/active"].push({".id":"*session",user:values.user,server:"ndahi-hotspot","mac-address":values["mac-address"],address:values.ip,"bytes-in":"3","bytes-out":"4"});return {};
  }
  const segments=path.split("/"),isItem=segments.at(-1).startsWith("*"),table=isItem?segments.slice(0,-1).join("/"):path;
  rows[table]??=[];
  if(method==="PUT"){const item={".id":"*"+(++id),...values};rows[table].push(item);return structuredClone(item);}
  const item=rows[table].find(r=>r[".id"]===segments.at(-1));if(!item)throw Error("missing item: "+path);
  if(method==="PATCH"){Object.assign(item,values);return structuredClone(item);}
  if(method==="DELETE"){
   if(table==="ip/hotspot/active"){const u=rows["ip/hotspot/user"].find(u=>u.name===item.user);if(u){u["bytes-in"]=String(Number(u["bytes-in"]||0)+Number(item["bytes-in"]||0));u["bytes-out"]=String(Number(u["bytes-out"]||0)+Number(item["bytes-out"]||0));}}
   rows[table]=rows[table].filter(r=>r!==item);return {};
  }
  throw Error("Unexpected transport call");
 };
 return {rows,calls,router};
}
const challenge=()=>({id:"challenge-1",expiresAt:new Date(+now+120000).toISOString()});
test("Home readiness uses GET-only safety inspection and does not expose router records or credentials", async () => {
 const g=gateway();g.rows["ip/hotspot/profile"][0].password="never-expose";
 const good=await g.router.inspectHomeReadiness();assert.equal(good.status,"configuration_verified");
 assert.equal(good.nativePilot,"pending");assert.equal(good.checks.length,6);
 assert.equal(JSON.stringify(good).includes("never-expose"),false);assert.equal(g.calls.every(c=>c.method==="GET"),true);
 g.rows["ip/firewall/filter"]=[];const bad=await g.router.inspectHomeReadiness();
 assert.equal(bad.status,"blocked");assert.equal(bad.code,"HOME_NETWORK_UNVERIFIED");
 assert.equal(g.calls.every(c=>c.method==="GET"),true);
});
test("an invalid HotSpot or missing guest interface cannot pass static readiness", async () => {
 for(const alter of [r=>{r.invalid="true";},r=>{delete r.interface;}]){
  const g=gateway();alter(g.rows["ip/hotspot"][0]);
  assert.equal((await g.router.inspectHomeReadiness()).status,"blocked");
  await assert.rejects(g.router.beginHomeEnrollment(challenge()),{code:"HOME_NETWORK_UNVERIFIED"});
  assert.equal(g.calls.every(c=>c.method==="GET"),true);
 }
});
test("standard upstream sessions work across arbitrary vendor and locally administered MACs without a model registry", async () => {
 for(const upstream of ["00:11:22:33:44:55","D4:35:1D:00:00:01","02:00:00:00:00:01","FE:00:00:00:00:01"]){
  const g=gateway(),ch=challenge();g.rows["ip/hotspot/host"][0]["mac-address"]=upstream;
  const login=await g.router.beginHomeEnrollment(ch);
  g.rows["ip/hotspot/active"].push({".id":"*enroll",user:login.username,server:"ndahi-hotspot","mac-address":upstream,address:"10.20.0.90"});
  assert.equal((await g.router.verifyHomeEnrollment(ch)).mac,upstream);
 }
});
test("multicast and unspecified identities cannot become a verified Home router", async () => {
 for(const upstream of ["01:00:5E:00:00:01","FF:FF:FF:FF:FF:FF","00:00:00:00:00:00"]){
  const g=gateway(),ch=challenge();g.rows["ip/hotspot/host"][0]["mac-address"]=upstream;
  const login=await g.router.beginHomeEnrollment(ch);
  g.rows["ip/hotspot/active"].push({".id":"*enroll",user:login.username,server:"ndahi-hotspot","mac-address":upstream,address:"10.20.0.90"});
  await assert.rejects(g.router.verifyHomeEnrollment(ch),{code:"HOME_PROOF_REQUIRED"});
 }
});
test("Home authorization follows a new trusted DHCP address while a changed upstream MAC requires new linking", async () => {
 const g=gateway();g.rows["ip/hotspot/host"][0].address="10.20.1.33";
 const result=await g.router.authorizeHome({voucher:voucher(),connection:{mac,address:"10.20.0.90"}});
 assert.equal(result.address,"10.20.1.33");
 const changed=gateway();changed.rows["ip/hotspot/host"][0]["mac-address"]="02:00:00:00:00:09";
 await assert.rejects(changed.router.authorizeHome({voucher:voucher(),connection:{mac,address:"10.20.0.90"}}));
 assert.equal(changed.calls.every(c=>c.method==="GET"),true);
});
test("enrollment fails before writes if restricted forwarding is absent",async()=>{const g=gateway();g.rows["ip/firewall/filter"]=[];await assert.rejects(g.router.beginHomeEnrollment(challenge()),{code:"HOME_NETWORK_UNVERIFIED"});assert.equal(g.calls.some(c=>c.method!=="GET"),false);});
test("IPv6 or FastTrack bypass blocks Home authorization before credential creation",async()=>{
 for(const change of [g=>{g.rows["ipv6/settings"][0]["disable-ipv6"]="false";},g=>{g.rows["ip/firewall/filter"].push({chain:"forward",action:"fasttrack-connection"});}]){
  const g=gateway();change(g);await assert.rejects(g.router.authorizeHome({voucher:voucher(),connection:{mac,address:"10.20.0.90"}}),{code:"HOME_NETWORK_UNVERIFIED"});assert.equal(g.calls.some(c=>c.method!=="GET"),false);
 }
});
test("temporary enrollment uses a restricted no-cookie/no-speed-cap profile and actual gateway session",async()=>{
 const g=gateway(),ch=challenge(),login=await g.router.beginHomeEnrollment(ch),profile=g.rows["ip/hotspot/user/profile"][0];
 assert.equal(profile["address-list"],"ndahi-home-enrollment");assert.equal(profile["add-mac-cookie"],"no");assert.equal(profile["rate-limit"],"");assert.notEqual(login.password,voucher().code);
 g.rows["ip/hotspot/active"].push({".id":"*proof",server:"ndahi-hotspot",user:login.username,"mac-address":mac,address:"10.20.0.90"});
 const proof=await g.router.verifyHomeEnrollment(ch);assert.equal(proof.mac,mac);assert.equal(proof.sessionId,"*proof");
 await g.router.endHomeEnrollment(ch);assert.equal(g.rows["ip/hotspot/active"].length,0);assert.equal(g.rows["ip/hotspot/user"][0].disabled,"true");
});
test("ambiguous host records and unrestricted IP bindings cannot prove enrollment",async()=>{
 const g=gateway(),ch=challenge(),login=await g.router.beginHomeEnrollment(ch);
 g.rows["ip/hotspot/active"].push({".id":"*proof",server:"ndahi-hotspot",user:login.username,"mac-address":mac,address:"10.20.0.90"});
 g.rows["ip/hotspot/host"].push({...g.rows["ip/hotspot/host"][0],".id":"*duplicate"});await assert.rejects(g.router.verifyHomeEnrollment(ch),{code:"HOME_PROOF_REQUIRED"});
 g.rows["ip/hotspot/host"].pop();g.rows["ip/hotspot/ip-binding"].push({type:"bypassed","mac-address":mac});await assert.rejects(g.router.verifyHomeEnrollment(ch),{code:"HOME_PROOF_REQUIRED"});
});
test("Home user binds one upstream MAC with native remaining bytes and an independent calendar guard",async()=>{
 const g=gateway(),v=voucher(),result=await g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}}),n=homeNames(v),u=g.rows["ip/hotspot/user"][0],p=g.rows["ip/hotspot/user/profile"][0];
 assert.equal(result.confirmed,true);assert.equal(result.bytes,7);assert.equal(result.base,200);assert.equal(u["limit-bytes-total"],"800");assert.equal(u["mac-address"],mac);assert.equal(p["shared-users"],"1");assert.equal(p["rate-limit"],"");assert.equal(p["address-list"],"ndahi-home-clients");
 assert.equal(g.rows["system/scheduler"][0].interval,"00:00:01");assert.ok(g.rows["system/scheduler"][0]["on-event"].includes(":timestamp"));assert.equal(u.name,n.username);assert.notEqual(u.password,v.code);
 v.homeAccounting={base:200,raw:7,epoch:result.epoch};await g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}});assert.equal(g.rows["ip/hotspot/user"].length,1);assert.equal(g.rows["ip/hotspot/active"].length,1);assert.equal(u["limit-bytes-total"],"800");
});
test("after a reboot or raw counter loss an existing allowance cannot be rearmed",async()=>{
 const g=gateway(),v=voucher(),first=await g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}});v.homeAccounting={base:200,raw:7,epoch:first.epoch};
 g.rows["system/script/environment"]=[];const before=g.calls.length;await assert.rejects(g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}}),{code:"HOME_ACCOUNTING_REVIEW"});assert.equal(g.calls.slice(before).some(c=>c.method!=="GET"),false);
});
test("zero remaining quota cannot accidentally become RouterOS unlimited",async()=>{const g=gateway(),v={...voucher(),usedBytes:1000};await assert.rejects(g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}}),{code:"HOME_EXHAUSTED"});assert.equal(g.rows["ip/hotspot/user"].length,0);});
test("revocation removes the exact user's sessions/cookies/volatile permits while retaining final accounting",async()=>{
 const g=gateway(),v=voucher();await g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}});const n=homeNames(v);
 g.rows["ip/hotspot/cookie"].push({".id":"*owned",user:n.username},{".id":"*other",user:"unrelated"});
 g.rows["ip/firewall/address-list"].push({".id":"*permit",list:"ndahi-home-live",address:"10.20.0.90",comment:n.comment});
 const result=await g.router.revokeHome(v);assert.equal(result.confirmed,true);assert.equal(result.reading.bytes,7);assert.equal(g.rows["ip/hotspot/active"].length,0);assert.deepEqual(g.rows["ip/hotspot/cookie"].map(c=>c.user),["unrelated"]);assert.equal(g.rows["ip/firewall/address-list"].some(a=>a.comment===n.comment),false);assert.equal(g.rows["system/scheduler"][0].disabled,"true");
});
test("an inherited reserved-profile speed cap is rejected instead of rewriting unrelated profiles",async()=>{
 const g=gateway(),v=voucher(),n=homeNames(v);g.rows["ip/hotspot/user/profile"].push({name:n.profile,"shared-users":"1","rate-limit":"1M"});
 await assert.rejects(g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}}),{code:"HOME_NETWORK_UNVERIFIED"});assert.equal(g.rows["ip/hotspot/user/profile"][0]["rate-limit"],"1M");assert.equal(g.rows["ip/hotspot/user"].length,0);
});

test("narrowed firewall guards and IPv6 drops cannot pass safety verification",async()=>{
 for(const change of [g=>g.rows["ip/firewall/filter"][0]["protocol"]="tcp",
   g=>g.rows["ip/firewall/filter"][3]["src-address-list"]="another-list",
   g=>{g.rows["ipv6/settings"][0]["disable-ipv6"]="false";g.rows["ipv6/firewall/filter"]=[{chain:"forward",action:"drop","in-interface":"vlan20-hotspot","dst-port":"443"}];}]){
  const g=gateway();change(g);await assert.rejects(g.router.beginHomeEnrollment(challenge()),{code:"HOME_NETWORK_UNVERIFIED"});assert.equal(g.calls.some(c=>c.method!=="GET"),false);
 }
});
test("foreign target sessions and household queue caps are left untouched and block activation",async()=>{
 for(const foreign of [true,false]){
  const g=gateway();if(foreign)g.rows["ip/hotspot/active"].push({user:"another-account","mac-address":mac});
  else g.rows["queue/simple"]=[{target:"10.20.0.90/32","max-limit":"1M/1M"}];
  await assert.rejects(g.router.authorizeHome({voucher:voucher(),connection:{mac,address:"10.20.0.90"}}),{code:foreign?"HOME_LINK_CHANGED":"HOME_NETWORK_UNVERIFIED"});
  assert.equal(g.calls.some(c=>c.method!=="GET"),false);
 }
});
test("converted direct profiles retain a volatile boot guard and never rearm after native counter loss",async()=>{
 const g=gateway(),v={...voucher(),deviceLimit:3,homeMeterId:"fresh-meter"};
 await g.router.authorizeHome({voucher:v,connection:{mac,address:"10.20.0.90"}});await g.router.revokeHome(v);
 Object.assign(v,{homeDirectRaw:20,directUsageOffset:45});
 g.rows["ip/hotspot/user"].push({name:v.code,comment:"ndahi:voucher:v1","bytes-in":"20"});
 const profile=await g.router.prepareDirect(v),p=g.rows["ip/hotspot/user/profile"].find(p=>p.name===profile);
 assert.equal(p["shared-users"],"3");assert.equal(p["address-list"],"ndahi-home-clients");assert.ok(p["on-login"].includes("revoked:fresh-meter"));
 g.rows["system/script/environment"]=[];const before=g.calls.length;
 await assert.rejects(g.router.prepareDirect(v),{code:"HOME_ACCOUNTING_REVIEW"});assert.equal(g.calls.slice(before).some(c=>c.method!=="GET"),false);
});

test("unreviewed or unrestricted required destinations and trial login fail before enrollment writes",async()=>{
 for(const change of [g=>g.rows["ip/firewall/address-list"][0].address="0.0.0.0/0",
  g=>g.rows["ip/firewall/address-list"][0].comment="unmanaged",
  g=>g.rows["ip/hotspot/profile"][0]["login-by"]="https,trial"]){
  const g=gateway();change(g);await assert.rejects(g.router.beginHomeEnrollment(challenge()),{code:"HOME_NETWORK_UNVERIFIED"});assert.equal(g.calls.some(c=>c.method!=="GET"),false);
 }
});
