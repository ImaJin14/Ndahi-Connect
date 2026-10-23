import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import {body,json} from './http.mjs';
import {NOT_HANDLED} from './routing.mjs';
import {sec,audit} from './state.mjs';
import {hashSecret,safeEqual} from '../security.mjs';
import {profileProofOptions,verifyProfileProof} from '../profile-proof.mjs';
import {adminProofOptions,verifyAdminProof} from '../admin-proof.mjs';
import {authenticatorRetired,authenticationReadiness,customerMigrationStatus,recordVerifiedMethod,verifiedMethods} from '../authentication-migration.mjs';
const customerRoot='/api/account/authentication-migration',adminRoot='/api/admin/authentication-migration';
const pinValid=i=>/^\d{4}$/.test(String(i.newPin||''))&&i.newPin===i.confirmPin;
const hashing={type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1};
const legacyVersion=(c,pepper)=>hashSecret(JSON.stringify([c.pinHash||'',c.totpSecret||'',(c.passkeys||[]).map(k=>[k.id,k.publicKey])]),pepper);
const throttle=(s,id,clock)=>s.securityEvents.filter(e=>e.type==='customer.migration.failed'&&e.meta?.customerId===id&&Date.parse(e.at)>+clock()-900000).length>=5;
export function createCustomerMigrationRoutes({mutate,auth,clock,pepper,previousPepper,customerRpID,customerOrigin,pinThrottle,recordPinFailure,clearPinFailures,refreshCustomerSession}){
 return async(req,res,url)=>{
  if(!url.pathname.startsWith(customerRoot))return NOT_HANDLED;
  const action=url.pathname.slice(customerRoot.length)||'/status';
  if(!['/status','/options','/confirm','/pin/start','/pin/confirm','/pin/cancel'].includes(action))return json(res,404,{error:'Migration action not found.'});
  if(req.method!==(action==='/status'?'GET':'POST'))return json(res,405,{error:'Method not allowed.'});
  const input=req.method==='POST'?await body(req):{};
  return mutate(async s=>{
   const a=auth(req,s,'dashboardSessions'),c=a&&s.customers.find(c=>c.id===a.customerId);
   if(!c)return json(res,401,{error:'Customer session expired.'});
   if(c.status==='suspended')return json(res,403,{error:'This account is suspended.'});
   if(req.method==='POST'&&(req.headers.origin!==customerOrigin||!a.csrfToken||!safeEqual(req.headers['x-csrf-token']||'',a.csrfToken||'')))return json(res,403,{error:'Refresh the page before verifying migration.'});
   if(action==='/status')return json(res,200,{...customerMigrationStatus(c,pepper),pendingPin:Boolean(a.authMigrationIntent?.version===2&&a.authMigrationIntent.proofMethod==='passkey'&&Date.parse(a.authMigrationIntent.expiresAt)>+clock()),legacyPreserved:!authenticatorRetired(s)});
   if(action==='/pin/cancel'){delete a.authMigrationIntent;return json(res,200,{cancelled:true});}
   if(throttle(s,c.id,clock))return json(res,429,{error:'Too many migration attempts. Try again in 15 minutes.'});
   const failure=()=>{sec(s,'customer.migration.failed',req,{customerId:c.id});return json(res,401,{code:'VERIFICATION_FAILED',error:'Verify the current credential for this migration.'});};
   if(action==='/options'){
    if(!c.passkeys?.length)return json(res,409,{error:'Use your PIN, passkey or audited account recovery.'});
    if(input.action==='pin'&&!pinValid(input))return json(res,400,{error:'Enter matching four-digit PINs.'});
    return json(res,200,await profileProofOptions({s,customer:c,session:a,type:input.action==='pin'?'migration_enroll_pin':'migration_confirm',target:input.action==='pin'?hashSecret(input.newPin,pepper):'supported-method-v1',clock,rpID:customerRpID}));
   }
   if(action==='/confirm'){
    const proof=await verifyProfileProof({s,customer:c,session:a,input,type:'migration_confirm',target:'supported-method-v1',clock,rpID:customerRpID,origin:customerOrigin,pinThrottle});
    if(proof.throttle)return json(res,429,{error:'Verification is temporarily locked.',...proof.throttle});
    if(!proof.verified){recordPinFailure(s,c,req,c.phone);return failure();}
    clearPinFailures(c);recordVerifiedMethod(c,proof.method,proof.credentialId,pepper,clock());sec(s,'customer.migration.method_verified',req,{customerId:c.id,method:proof.method});
    return json(res,200,customerMigrationStatus(c,pepper));
   }
   if(action==='/pin/start'){
    if(c.pinHash)return json(res,409,{error:'Verify your existing PIN or use the protected PIN-change flow.'});
    if(!pinValid(input))return json(res,400,{error:'Enter matching four-digit PINs.'});
    let verified=false;
    if(input.response){const proof=await verifyProfileProof({s,customer:c,session:a,input,type:'migration_enroll_pin',target:hashSecret(input.newPin,pepper),clock,rpID:customerRpID,origin:customerOrigin,pinThrottle});verified=proof.verified;}

    if(!verified)return failure();
    a.authMigrationIntent={version:2,proofMethod:'passkey',id:randomUUID(),hash:await argon2.hash(input.newPin,hashing),originalVersion:legacyVersion(c,pepper),expiresAt:new Date(+clock()+600000).toISOString(),attempts:0};
    sec(s,'customer.migration.pin_started',req,{customerId:c.id});return json(res,200,{intentId:a.authMigrationIntent.id,expiresAt:a.authMigrationIntent.expiresAt,confirmationRequired:true});
   }
   const intent=a.authMigrationIntent;
   if(!intent||intent.version!==2||intent.proofMethod!=='passkey'||intent.id!==input.intentId||Date.parse(intent.expiresAt)<=+clock()||intent.attempts>=5||!safeEqual(intent.originalVersion,legacyVersion(c,pepper)))return json(res,409,{code:'MIGRATION_INTENT_EXPIRED',error:'Migration setup expired or account credentials changed. Start again.'});
   intent.attempts++;
   if(!/^\d{4}$/.test(String(input.pin||''))||!await argon2.verify(intent.hash,String(input.pin)).catch(()=>false))return failure();
   c.pinHash=intent.hash;c.pinCreatedAt=clock().toISOString();delete a.authMigrationIntent;recordVerifiedMethod(c,'pin',undefined,pepper,clock());
   s.dashboardSessions=s.dashboardSessions.filter(x=>x.customerId!==c.id||x.id===a.id);
   for(const key of ['customerPasskeyChallenges','customerAccessChallenges','pinResetChallenges'])s[key]=s[key].filter(x=>x.customerId!==c.id&&x.phone!==c.phone);
   clearPinFailures(c);refreshCustomerSession(req,res,a);sec(s,'customer.migration.pin_confirmed',req,{customerId:c.id});
   return json(res,200,{...customerMigrationStatus(c,pepper),legacyPreserved:!authenticatorRetired(s)});
  },{res});
 };
}
export function createAdminMigrationRoutes({mutate,auth,clock,pepper,rpID,adminOrigin}){
 return async(req,res,url)=>{
  if(!url.pathname.startsWith(adminRoot))return NOT_HANDLED;
  const action=url.pathname.slice(adminRoot.length)||'/status';
  if(!['/status','/options','/confirm','/review'].includes(action))return json(res,404,{error:'Migration action not found.'});
  if(req.method!==(action==='/status'?'GET':'POST'))return json(res,405,{error:'Method not allowed.'});
  const input=req.method==='POST'?await body(req):{};
  return mutate(async s=>{
   const session=auth(req,s,'adminSessions'),user=session&&s.adminUsers.find(u=>u.id===session.userId&&u.active!==false);
   if(session&&!session.userId&&!authenticatorRetired(s))return json(res,409,{code:'ADMIN_REAUTHENTICATION_REQUIRED',error:'Sign in again with your administrator account before preparing credential migration.'});
   if(!user||!['owner','operator','reseller','auditor'].includes(user.role))return json(res,401,{error:'Admin session expired.'});
   if(req.method==='POST'&&(req.headers.origin!==adminOrigin||!session.csrfToken||!safeEqual(req.headers['x-csrf-token']||'',session.csrfToken||'')))return json(res,403,{error:'Refresh the admin app before verifying migration.'});
   if(action==='/status')return json(res,200,user.role==='owner'?authenticationReadiness(s,{pepper,now:clock()}):{version:1,replacementVerified:verifiedMethods(user,pepper,true).length>0,aggregateRestricted:true});
   const reviewing=action==='/review'||input.action==='review';
   if(reviewing&&user.role!=='owner')return json(res,403,{error:'Only an active owner can review retirement readiness.'});
   const report=authenticationReadiness(s,{pepper,now:clock()});
   if(reviewing&&(!/^[a-f0-9]{64}$/.test(input.expectedDigest||'')||!safeEqual(input.expectedDigest,report.digest)))return json(res,409,{code:'READINESS_CHANGED',error:'The readiness report changed. Refresh and review the current report before recording evidence.'});
   const type=reviewing?'auth_cutover_attestation':'migration_confirm';
   const target=reviewing?JSON.stringify([report.digest,input.rollbackRevision,input.evidenceReference]):'supported-method-v1';
   if(action==='/options')return json(res,200,await adminProofOptions({s,user,session,type,target,clock,rpID}));
   const proof=await verifyAdminProof({s,user,session,input,type,target,clock,rpID,origin:adminOrigin});
   if(proof.throttle)return json(res,429,{error:'Admin verification is temporarily locked.',...proof.throttle});
   if(!proof.verified)return json(res,401,{code:'VERIFICATION_FAILED',error:'Verify your current admin password or passkey.'});
   if(action==='/confirm'){recordVerifiedMethod(user,proof.method,proof.credentialId,pepper,clock());audit(s,'admin.migration.method_verified',req,{method:proof.method});return json(res,200,{verified:true});}
   if(!/^[a-f0-9]{40}$/.test(input.rollbackRevision||'')||!/^[A-Za-z0-9][A-Za-z0-9 /_.:#-]{5,159}$/.test(input.evidenceReference||'')||input.supportRecoveryVerified!==true||input.authenticationPilotVerified!==true)return json(res,400,{error:'Record the compatible rollback revision and reviewed recovery/authentication pilot evidence.'});
   // Owner-reviewed external acceptance is explicit; a configured credential or
   // a session alone cannot manufacture this attestation or erase its blockers.
   s.zone.authenticationMigrationReview={version:1,digest:report.digest,rollbackRevision:input.rollbackRevision,evidenceReference:input.evidenceReference,supportRecoveryVerified:true,authenticationPilotVerified:true,at:clock().toISOString()};
   audit(s,'admin.migration.readiness_reviewed',req,{version:1});return json(res,200,authenticationReadiness(s,{pepper,now:clock()}));
  },{res});
 };
}
