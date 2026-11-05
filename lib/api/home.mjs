import { body, json } from "./http.mjs";
import argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import { phone, phoneOk } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { audit, catalogue } from "./state.mjs";
import { routerRevision } from "../device-identities.mjs";
import { verifyProfileProof, profileProofOptions } from "../profile-proof.mjs";
import { ensureHome, homeEnabled, homeError, homeView, currentHome, reserveHomeLink, requestHomeMode, queueHome } from "../home.mjs";
import { homeOperationalSummary } from "../home-observability.mjs";
import { evaluateHomePilot, homePilotTemplate } from "../home-pilot.mjs";

const root="/api/account/home";
const actions=["enroll","confirm","mode","revoke","retry","options"];
const target=i=>JSON.stringify([i.action||"",i.enrollmentId||"",i.voucherId||"",i.mode||""]);
export function createHomeRoutes(ctx) {
  const {mutate,auth,clock,env,coverage,homeService,customerRpID,customerOrigin,pinThrottle,recordPinFailure,clearPinFailures,issueCustomerSession}=ctx;
  async function ownerProof(s,c,a,i,req){
    const result=await verifyProfileProof({s,customer:c,session:a,input:i,type:"home_router",target:target(i),clock,rpID:customerRpID,origin:customerOrigin,pinThrottle});
    if(result.throttle)throw homeError("VERIFICATION_THROTTLED","Owner verification is temporarily locked.",429);
    if(!result.verified){recordPinFailure(s,c,req,c.phone);return false;}
    clearPinFailures(c);return true;
  }
  return async(req,res,url)=>{
    if(req.method==="GET" && url.pathname==="/api/home/config")return json(res,200,{enabled:homeEnabled(env)});
    if(url.pathname!==root && !url.pathname.startsWith(root+"/"))return NOT_HANDLED;
    res.setHeader("cache-control","no-store");
    const action=url.pathname.slice(root.length+1),i=req.method==="POST"?await body(req):{};
    try{
      if(["mac","address","routerId","homeGeneration","customerId"].some(k=>Object.hasOwn(i,k)))throw homeError("HOME_UNTRUSTED_IDENTIFIER","Do not supply a router identifier; complete local sign-in instead.",400);
      if(req.method==="POST" && action==="register"){
        if(!homeEnabled(env))throw homeError("HOME_DISABLED","Home enrollment is not enabled.",404);
        if(!coverage.enabled || !coverage.access(req).allowed)throw homeError("WIFI_REQUIRED","Connect through your WISP router on NDAHI Wi-Fi to start Home setup.",403);
        if(!phoneOk(i.phone) || !/^\d{4}$/.test(i.pin||"") || i.pin!==i.confirmPin)
          throw homeError("HOME_REGISTRATION_INVALID","Enter a valid Cameroon number and matching four-digit PINs.",400);
        const pinHash=await argon2.hash(i.pin,{type:argon2.argon2id});
        return mutate(s=>{
          if(s.customers.some(c=>c.phone===phone(i.phone)))return json(res,409,{error:"Account setup is unavailable for these details. Sign in or use account recovery."});
          const customer={id:randomUUID(),phone:phone(i.phone),name:String(i.name||"Customer").trim().slice(0,100),pinHash,
            createdAt:clock().toISOString(),pinCreatedAt:clock().toISOString(),phoneOwnershipVerified:false,passkeys:[]};
          s.customers.push(customer);return issueCustomerSession(s,customer.id,res,req,{method:"pin"});
        },{res});
      }
      if(req.method!=="GET" && req.method!=="POST")return json(res,405,{error:"GET or POST required."});
      const prepared=await mutate(async s=>{
        ensureHome(s);
        const a=auth(req,s,"dashboardSessions"),c=a&&s.customers.find(c=>c.id===a.customerId);
        if(!c)throw homeError("HOME_AUTH_REQUIRED","Sign in to your account.",401);
        if(c.suspended || c.status==="suspended")throw homeError("HOME_FORBIDDEN","Account is suspended.",403);
        if(req.method==="GET" && !action)return {view:{...homeView(s,c.id,clock(),homeEnabled(env)),plans:catalogue(s)}};
        if(req.method!=="POST" || !actions.includes(action))throw homeError("HOME_NOT_FOUND","Home action not found.",404);
        if(!homeEnabled(env) && !["revoke","retry","options"].includes(action) && !(action==="mode"&&i.mode==="direct"))
          throw homeError("HOME_DISABLED","Home enrollment is not enabled.",404);
        if(["enroll","confirm"].includes(action) && (!coverage.enabled || !coverage.access(req).allowed))
          throw homeError("WIFI_REQUIRED","Connect through your WISP router on NDAHI Wi-Fi to link or replace it.",403);
        if(action==="options"){
          if(!["confirm","mode","revoke"].includes(i.action) || !c.passkeys?.length)throw homeError("HOME_PROOF_REQUIRED","Use your current PIN.",400);
          return {view:await profileProofOptions({s,customer:c,session:a,type:"home_router",target:target(i),clock,rpID:customerRpID})};
        }
        if(action==="enroll")return {customerId:c.id,sessionId:a.id};
        if(action==="confirm"){
          if(i.confirm!==true)throw homeError("HOME_CONFIRM_REQUIRED","Confirm this is your household connection.",400);
          const ch=s.homeChallenges.find(ch=>ch.id===i.enrollmentId && ch.customerId===c.id && ch.sessionId===a.id);
          if(!ch || ch.status!=="ready" || ch.routerRevision!==routerRevision(s) || Date.parse(ch.expiresAt)<=+clock())
            throw homeError("HOME_PROOF_REQUIRED","Complete a new local sign-in challenge.");
          if(s.homeConnections.some(h=>h.customerId===c.id && ["linked","reserved","retiring"].includes(h.status)) && !await ownerProof(s,c,a,{...i,action},req))return {verificationFailed:true};
          return {customerId:c.id,sessionId:a.id,revision:routerRevision(s),pinVersion:c.pinHash};
        }
        if(action==="mode" || action==="revoke"){
          if(!await ownerProof(s,c,a,{...i,action},req))return {verificationFailed:true};
          if(action==="mode")requestHomeMode(s,c.id,i.voucherId,i.mode,clock());
          else {c.homeRevokedAt=clock().toISOString();queueHome(s,"revoke",c.id,clock());}
          return {wake:true};
        }
        if(action==="retry"){
          const job=s.homeOperations.find(o=>o.id===i.operationId && o.customerId===c.id && ["retry","needs_review"].includes(o.status));
          if(!job)throw homeError("HOME_RETRY_UNAVAILABLE","No failed operation is available.");
          job.status="queued";job.nextAttemptAt=clock().toISOString();job.attempts=0;return {wake:true};
        }
      });
      if(prepared.verificationFailed)return json(res,401,{code:"VERIFICATION_FAILED",error:"Verify account ownership with your current PIN or passkey."});
      if(prepared.view)return json(res,200,prepared.view);
      if(action==="enroll")return json(res,201,await homeService.begin(prepared.customerId,prepared.sessionId));
      if(action==="confirm"){
        const proof=await homeService.proof(prepared.customerId,prepared.sessionId,i.enrollmentId);
        const result=await mutate(s=>{
          const a=auth(req,s,"dashboardSessions");
          const c=s.customers.find(c=>c.id===prepared.customerId);
          if(!a || a.id!==prepared.sessionId || c?.pinHash!==prepared.pinVersion || routerRevision(s)!==prepared.revision)throw homeError("HOME_PROOF_REQUIRED","Account or router changed; sign in again.");
          const link=reserveHomeLink(s,prepared.customerId,proof,i.enrollmentId,i.name,clock());
          return {link:{id:link.id,name:link.name,status:link.status,identifierSuffix:link.mac.slice(-5)}};
        });
        // Challenge revocation is independently recoverable; cleanup also runs
        // after a crash or lost response, and its profile never grants Internet.
        await homeService.end(i.enrollmentId).catch(()=>{});homeService.wake();return json(res,202,result);
      }
      if(prepared.wake)homeService.wake();return json(res,202,{pending:true});
    }catch(error){return json(res,error.status||503,{code:error.code||"HOME_ROUTER_UNAVAILABLE",error:error.status?error.message:"Router confirmation is pending. Do not pay again."});}
  };
}

// Runs inside the existing admin authorization/CSRF/audit transaction wrapper.
export function createAdminHomeRoutes({clock,env}){
  return async(req,res,url,{s,i,role,effects})=>{
    if(!url.pathname.startsWith("/api/admin/home"))return NOT_HANDLED;
    if(!["owner","operator"].includes(role))return json(res,403,{error:"Your role does not permit Home management."});
    ensureHome(s);
    if (req.method === "GET" && url.pathname === "/api/admin/home/pilot-template")
      return json(res, 200, homePilotTemplate());
    if (req.method === "GET" && url.pathname === "/api/admin/home/readiness") {
      effects.homeReadiness = true;
      return;
    }
    if(req.method==="GET" && url.pathname==="/api/admin/home")return json(res,200,{enabled:homeEnabled(env),
      diagnostics: homeOperationalSummary(s, clock()),
      households:s.customers.filter(c=>s.homeConnections.some(h=>h.customerId===c.id)).map(c=>({customerId:c.id,name:c.name||"Customer",...homeView(s,c.id,clock(),homeEnabled(env))}))});
    if(req.method!=="POST")return json(res,405,{error:"POST required."});
    if (url.pathname === "/api/admin/home/pilot") {
      if (!String(i.reason || "").trim()) return json(res, 400, { error: "Enter an audit reason for the pilot report." });
      if (!i.report || typeof i.report !== "object" || Array.isArray(i.report) || i.report.version !== 1 ||
          !["physical", "synthetic"].includes(i.report.evidenceKind))
        return json(res, 400, { error: "Choose a version 1 physical or synthetic JSON pilot report." });
      const summary = evaluateHomePilot(i.report, { now: clock() });
      const evidenceHash = createHash("sha256").update(JSON.stringify(i.report ?? null)).digest("hex");
      const previous = s.homeUsageObservations.find(o => o.type === "pilot.report" && o.evidenceHash === evidenceHash);
      if (previous) return json(res, 200, { replayed: true, summary: previous.summary });
      s.homeUsageObservations.push({ id: randomUUID(), type: "pilot.report", evidenceHash,
        source: "operator-reported", at: clock().toISOString(), summary });
      audit(s, "home.pilot.reported", req, { evidenceHash, status: summary.status, reason: String(i.reason).trim().slice(0, 300) });
      return json(res, 201, { summary, requiresIndependentReview: true, enabled: homeEnabled(env) });
    }
    const c=s.customers.find(c=>c.id===i.customerId);
    if(!c || !String(i.reason||"").trim())return json(res,400,{error:"Choose an account and enter an audit reason."});
    if(url.pathname==="/api/admin/home/revoke"){
      c.homeRevokedAt=clock().toISOString();queueHome(s,"revoke",c.id,clock());
    }else if(url.pathname==="/api/admin/home/retry"){
      const op=s.homeOperations.find(o=>o.id===i.operationId && o.customerId===c.id && ["retry","needs_review"].includes(o.status));
      if(!op)return json(res,409,{error:"No retryable Home operation."});
      op.status="queued";op.attempts=0;op.nextAttemptAt=clock().toISOString();
    }else return json(res,404,{error:"Action not found. Router replacement requires the customer's local possession challenge."});
    audit(s,"home.admin.operation",req,{customerId:c.id,operation:url.pathname.endsWith("retry")?"retry":"revoke",reason:String(i.reason).slice(0,300)});
    effects.homeWake=true;return json(res,202,{pending:true});
  };
}
