import { randomUUID } from "node:crypto";
import { routerRevision } from "./device-identities.mjs";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { ensureHome, homeEnabled, homeError, homeAudit, currentHome, queueHome, usable, applyHomeUsage } from "./home.mjs";

const pending = o => ["queued", "retry", "processing"].includes(o.status);
const cleanError = e => ["HOME_ACCOUNTING_REVIEW", "HOME_NETWORK_UNVERIFIED", "HOME_LINK_CHANGED", "HOME_DISABLED", "HOME_EXHAUSTED"].includes(e.code) ? e.code : "HOME_ROUTER_UNAVAILABLE";
export function createHomeService({ store, router, env, now = () => new Date() }) {
  const enabled = () => homeEnabled(env);
  const transaction = fn => store.transaction(s => { ensureHome(s); return fn(s); });
  async function begin(customerId, sessionId) {
    if (!enabled()) throw homeError("HOME_DISABLED", "Home router enrollment is not enabled.", 404);
    const challenge = await transaction(s => {
      const c=s.customers.find(c=>c.id===customerId);
      if(!c || c.suspended || c.status==="suspended") throw homeError("HOME_FORBIDDEN","Account is unavailable.",403);
      const recent=s.homeChallenges.filter(ch=>ch.customerId===customerId && Date.parse(ch.createdAt)>+now()-900000);
      if(recent.length>=5 || recent.some(ch=>["creating","ready"].includes(ch.status) && Date.parse(ch.expiresAt)>+now()))
        throw homeError("HOME_CHALLENGE_PENDING","Finish the current sign-in challenge or wait for it to expire.",429);
      const ch={id:randomUUID(),customerId,sessionId,routerRevision:routerRevision(s),status:"creating",createdAt:now().toISOString(),expiresAt:new Date(+now()+120000).toISOString()};
      s.homeChallenges.push(ch);return structuredClone(ch);
    });
    try {
      const login=await router.beginHomeEnrollment(challenge);
      await transaction(s=>{ const ch=s.homeChallenges.find(c=>c.id===challenge.id); ch.status="ready"; });
      return {enrollmentId:challenge.id,expiresAt:challenge.expiresAt,login};
    } catch(error) {
      await transaction(s=>{const ch=s.homeChallenges.find(c=>c.id===challenge.id);ch.status="failed";ch.errorCode=cleanError(error);});
      throw homeError(cleanError(error),"Home enrollment could not be prepared. Contact support if network preparation is pending.",503);
    }
  }
  async function proof(customerId,sessionId,id) {
    const s=ensureHome(await store.snapshot()),ch=s.homeChallenges.find(ch=>ch.id===id && ch.customerId===customerId && ch.sessionId===sessionId);
    if(!enabled() || !ch || ch.status!=="ready" || Date.parse(ch.expiresAt)<=+now() || ch.routerRevision!==routerRevision(s))
      throw homeError("HOME_PROOF_REQUIRED","This router sign-in challenge is unavailable or expired.");
    return router.verifyHomeEnrollment(ch);
  }
  async function end(id) {
    const s=ensureHome(await store.snapshot()),ch=s.homeChallenges.find(ch=>ch.id===id);
    if(ch){await router.endHomeEnrollment(ch);await transaction(s=>{s.homeChallenges.find(ch=>ch.id===id).cleanedAt=now().toISOString();});}
  }
  async function directRevocation(v) {
    const s=await store.snapshot();
    if((s.routerCommands||[]).some(c=>c.status==="processing" && Date.parse(c.leaseUntil)>+now() &&
      (c.targetId===v.id || c.device?.voucherId===v.id || c.action==="connect_wifi_device")))
      throw homeError("HOME_DRAIN_PENDING","Waiting for an earlier direct-device router operation.");
    const result=await router.disconnectVoucher(v.id);
    if(!result?.disconnected) throw Error("Direct revocation was not confirmed.");
    const readings=await router.readUsage();
    const reading=Array.isArray(readings) && readings.find(r=>r.voucherId===v.id);
    // A missing direct user is safe only when it has never accumulated traffic.
    if(!reading && (v.usedBytes||0)>0) throw homeError("HOME_ACCOUNTING_REVIEW","Final direct usage could not be reconciled.");
    return reading ? Number(reading.usedBytes) : 0;
  }
  async function revokeAndObserve(v) {
    const result=await router.revokeHome(v);
    if(!result?.confirmed) throw Error("Home revocation was not confirmed.");
    return result.reading || await router.readHome(v);
  }
  async function operate(job) {
    let state=ensureHome(await store.snapshot()), c=state.customers.find(c=>c.id===job.customerId), v=state.vouchers.find(v=>v.id===job.voucherId);
    const commit=fn=>transaction(s=>{
      const op=s.homeOperations.find(o=>o.id===job.id);
      if(!op || op.leaseToken!==job.leaseToken || op.status!=="processing") throw homeError("HOME_OPERATION_CHANGED","Operation ownership changed.");
      return fn(s,op);
    });
    if(job.kind==="replace" || job.kind==="revoke") {
      const victims=state.vouchers.filter(v=>v.customerId===job.customerId && v.accessMode==="home" && v.homeGeneration && v.homeStatus!=="revoked");
      for(const victim of victims){
        const reading=await revokeAndObserve(victim);
        await commit(s=>{const live=s.vouchers.find(v=>v.id===victim.id);if(live.homeAccounting)applyHomeUsage(s,live,reading,now());live.homeStatus="revoked";});
      }
      await commit((s,op)=>{
        const customer=s.customers.find(c=>c.id===job.customerId);
        if(job.kind==="replace"){
          const old=s.homeConnections.find(h=>h.id===job.oldConnectionId),next=s.homeConnections.find(h=>h.id===job.connectionId);
          if(!next || next.status!=="reserved")throw homeError("HOME_LINK_CHANGED","Replacement connection changed.");
          old.status="replaced";next.status="linked";customer.homeConnectionId=next.id;
          for(const item of s.vouchers.filter(v=>v.customerId===customer.id && v.accessMode==="home" && usable(v,now()))){
            item.homeConnectionId=next.id;item.homeGeneration=next.generation;delete item.homeAccounting;item.homeMeterId=randomUUID();item.homeStatus="pending";
            queueHome(s,"activate",customer.id,now(),{voucherId:item.id,connectionId:next.id,generation:next.generation,mode:"home"});
          }
        } else {
          for(const link of s.homeConnections.filter(h=>h.customerId===customer.id && ["linked","retiring","reserved"].includes(h.status)))link.status="revoked";
          delete customer.homeConnectionId;customer.accessModeIntent="direct";
        }
        op.status="processed";op.processedAt=now().toISOString();
        homeAudit(s,`router.${job.kind}_confirmed`,customer.id,now(),{operationId:op.id});
      });return;
    }
    if(!v || !c) throw homeError("HOME_LINK_CHANGED","The account or entitlement changed.");
    if(job.kind==="mode" && job.phase==="revoke" || job.kind==="activate" && job.phase==="revoke"){
      let reading, direct;
      if(job.kind==="activate")for(const prior of state.vouchers.filter(item=>item.customerId===job.customerId && item.id!==v.id)){
        if(prior.accessMode==="home" && prior.homeGeneration && prior.homeStatus!=="revoked"){
          const final=await revokeAndObserve(prior);
          await commit(s=>{const old=s.vouchers.find(item=>item.id===prior.id);if(old.homeAccounting)applyHomeUsage(s,old,final,now());old.homeStatus="revoked";});
        }else if(prior.accessMode!=="home" && !(await router.disconnectVoucher(prior.id))?.disconnected)throw Error("Earlier direct access revocation remains pending.");
      }
      if(v.accessMode==="home" && v.homeAccounting) reading=await revokeAndObserve(v);
      else if(v.accessMode==="home" && v.homeDirectRevoked) { /* final prior-generation usage is already durable */ }
      else direct=await directRevocation(v);
      await commit((s,op)=>{
        const item=s.vouchers.find(v=>v.id===job.voucherId),customer=s.customers.find(c=>c.id===job.customerId);
        if(reading)applyHomeUsage(s,item,reading,now());
        else if(direct!==undefined) {
          const total=direct+(item.directUsageOffset||0);
          if(!Number.isSafeInteger(total) || total<(item.usedBytes||0)) throw homeError("HOME_ACCOUNTING_REVIEW","Final usage is inconsistent.");
          item.usedBytes=Math.max(item.usedBytes||0,total);item.homeDirectRaw=direct;
        }
        // Revoke saved direct grants only after their gateway access is disabled.
        for(const grant of s.wifiDeviceGrants||[])if(grant.customerId===customer.id && grant.status==="approved")grant.status="revoked";
        for(const session of s.sessions||[])if(session.voucherId===item.id && session.status==="online")session.status="disconnected";
        if(job.mode==="direct"){
          item.directUsageOffset=item.usedBytes-(item.homeDirectRaw||0);
          item.accessMode="direct";item.homeStatus="revoked";item.homeDirectRevoked=false;delete item.accessTransitionId;
          customer.accessModeIntent="direct";enqueueRouterCommand(s,{action:"sync_voucher",targetId:item.id},now);
          op.status="processed";op.processedAt=now().toISOString();
        } else {
          const link=currentHome(s,customer.id);
          if(!link || link.id!==job.connectionId || link.generation!==job.generation)throw homeError("HOME_LINK_CHANGED","The linked connection changed.");
          item.accessMode="home";item.homeConnectionId=link.id;item.homeGeneration=link.generation;delete item.homeAccounting;item.homeMeterId=randomUUID();
          item.homeStatus="pending";item.homeDirectRevoked=true;op.phase="activate";customer.accessModeIntent="home";
        }
        homeAudit(s,"mode.revocation_confirmed",customer.id,now(),{voucherId:item.id,mode:job.mode});
      });
      state=ensureHome(await store.snapshot());v=state.vouchers.find(v=>v.id===job.voucherId);
      if(job.mode==="direct")return;
    }
    job.executionMeterId=v.homeMeterId;
    const link=currentHome(state,job.customerId);
    if(!enabled() || !usable(v,now()) || c.suspended || c.status==="suspended" || !link || link.id!==v.homeConnectionId || link.generation!==v.homeGeneration || link.routerRevision!==routerRevision(state)){
      if(v.homeGeneration){
        const reading=await revokeAndObserve(v);
        await commit((s,op)=>{const item=s.vouchers.find(item=>item.id===v.id);if(item.homeAccounting)applyHomeUsage(s,item,reading,now());
          item.homeStatus="revoked";item.routerSyncStatus="disconnected";delete item.accessTransitionId;op.status="processed";op.processedAt=now().toISOString();});
      } else throw homeError("HOME_LINK_CHANGED","The linked connection changed.");
      return;
    }
    let reading=v.homeAccounting && await router.readHome(v);
    if(reading){await commit(s=>applyHomeUsage(s,s.vouchers.find(item=>item.id===v.id),reading,now()));
      v=(await store.snapshot()).vouchers.find(item=>item.id===v.id);
      if(!usable(v,now())){await router.revokeHome(v);await commit((s,op)=>{s.vouchers.find(item=>item.id===v.id).homeStatus="exhausted";op.status="processed";op.processedAt=now().toISOString();});return;}}
    if(!reading?.connected) reading=await router.authorizeHome({voucher:v,connection:link});
    await commit((s,op)=>{
      const item=s.vouchers.find(item=>item.id===v.id),current=currentHome(s,job.customerId);
      if(!current || current.id!==link.id || item.homeGeneration!==v.homeGeneration ||
        s.homeOperations.some(o=>o.customerId===job.customerId && o.id!==job.id && o.kind==="revoke" && pending(o)))
        throw homeError("HOME_LINK_CHANGED","Authorization was superseded; revocation remains pending.");
      const previousStatus=item.homeStatus;
      item.homeAccounting??={base:reading.base ?? item.usedBytes,raw:0,epoch:reading.epoch};
      applyHomeUsage(s,item,reading,now());item.homeStatus=reading.connected?"connected":"pending";
      item.routerSyncStatus="synchronized";delete item.accessTransitionId;
      if(!item.homeAuthorizedAt)item.homeAuthorizedAt=now().toISOString();
      op.status="processed";op.processedAt=now().toISOString();delete op.leaseToken;delete op.leaseUntil;
      if(job.kind!=="refresh" || previousStatus!=="connected")homeAudit(s,"authorization.confirmed",item.customerId,now(),{voucherId:item.id,operationId:op.id});
    });
  }
  async function pass() {
    const snapshot=ensureHome(await store.snapshot());
    if(!snapshot.homeOperations.length && !snapshot.homeConnections.length && !snapshot.homeChallenges.length)return {processed:0};
    for(const ch of snapshot.homeChallenges.filter(ch=>!ch.cleanedAt && (ch.status==="consumed" || Date.parse(ch.expiresAt)<=+now())).slice(0,10))
      await end(ch.id).catch(()=>{});
    await transaction(s=>{
      for(const v of s.vouchers.filter(v=>v.accessMode==="home" && v.homeGeneration && !["revoked","accounting_review"].includes(v.homeStatus) &&
        (v.homeStatus!=="connected" || +now()-Date.parse(v.lastUsageSyncAt||0)>=15000)))
        if(!s.homeOperations.some(o=>o.customerId===v.customerId && (pending(o)||o.status==="needs_review")))queueHome(s,"refresh",v.customerId,now(),{voucherId:v.id,mode:"home"});
    });
    const job=await transaction(s=>{
      const op=[...s.homeOperations].sort((a,b)=>Number(a.kind==="refresh")-Number(b.kind==="refresh")).find(o=>(["queued","retry"].includes(o.status) && Date.parse(o.nextAttemptAt)<=+now() || o.status==="processing" && Date.parse(o.leaseUntil)<=+now()) &&
        !s.homeOperations.some(other=>other.id!==o.id && other.customerId===o.customerId && other.status==="processing" && Date.parse(other.leaseUntil)>+now()));
      if(!op)return null;
      op.status="processing";op.attempts++;op.leaseToken=randomUUID();op.leaseUntil=new Date(+now()+600000).toISOString();
      return {...structuredClone(op),claimedGeneration:s.vouchers.find(v=>v.id===op.voucherId)?.homeGeneration,claimedMeterId:s.vouchers.find(v=>v.id===op.voucherId)?.homeMeterId};
    });
    if(!job)return {processed:0};
    try {await operate(job);return {processed:1};}
    catch(error){
      // If a stale/uncertain authorize call reached the gateway, revoke its
      // generation before exposing any completion. A replacement waits on this.
      const s=await store.snapshot(),v=s.vouchers.find(v=>v.id===job.voucherId);
      const failedGeneration=job.claimedGeneration || job.generation;
      if(v?.accessMode==="home" && failedGeneration)await router.revokeHome({...v,homeGeneration:failedGeneration,homeMeterId:job.executionMeterId||job.claimedMeterId||v.homeMeterId}).catch(()=>{});
      await transaction(s=>{
        const op=s.homeOperations.find(o=>o.id===job.id);if(op?.leaseToken!==job.leaseToken)return;
        op.errorCode=cleanError(error);op.status=error.code==="HOME_ACCOUNTING_REVIEW" || op.attempts>=8 ? "needs_review":"retry";
        op.nextAttemptAt=new Date(+now()+Math.min(60000,2000*2**Math.min(op.attempts-1,5))).toISOString();
        delete op.leaseToken;delete op.leaseUntil;
        const v=s.vouchers.find(v=>v.id===job.voucherId);
        if(v){v.homeStatus=error.code==="HOME_ACCOUNTING_REVIEW"?"accounting_review":"activation_pending";v.routerSyncStatus="pending";}
        homeAudit(s,"synchronization.failed",job.customerId,now(),{operationId:job.id,code:op.errorCode});
      });return {processed:0,error:cleanError(error)};
    }
  }
  let running;
  const run=()=>running??=(async()=>{try{let processed=0;for(let i=0;i<25;i++){const result=await pass();processed+=result.processed;if(!result.processed&&!result.error)break;}return {processed};}finally{running=undefined;}})();
  const wake=()=>{void run().catch(()=>{});};
  return {begin,proof,end,run,wake};
}
