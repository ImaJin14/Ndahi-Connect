import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import {pairingFixture} from './helpers/wifi-pairing-fixture.mjs';
import {totpSecret,totpCode,hashSecret} from '../lib/security.mjs';
import {authenticationReadiness,recordVerifiedMethod,credentialVersion} from '../lib/authentication-migration.mjs';
const root='/api/account/authentication-migration',secret='pairing-tests';
async function fixture(t){const f=await pairingFixture({env:{ADMIN_APP_URL:'http://customer.test',ADMIN_SESSION_SECRET:secret}});t.after(f.close);const passwordHash=await argon2.hash('a sufficiently long admin password');await f.store.transaction(s=>{s.adminUsers.push({id:'owner',username:'owner',role:'owner',active:true,passwordHash,passkeys:[]});s.adminSessions.push({userId:'owner',role:'owner',tokenHash:hashSecret('owner',secret),csrfToken:'csrf',expiresAt:new Date(+f.now()+3600000).toISOString()});});const admin=async(path,input,token='owner')=>{const r=await fetch(f.api+'/api/admin/authentication-migration'+path,{method:input===undefined?'GET':'POST',headers:{origin:'http://customer.test',cookie:'admin_session='+token,'content-type':'application/json','x-csrf-token':'csrf'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:r.status,body:await r.json()};};return {...f,admin};}
async function legacy(f){let key;await f.store.transaction(s=>{const c=s.customers[0];delete c.pinHash;c.totpSecret=key=totpSecret();});return key;}

test('readiness is aggregate, read-only and distinguishes configured from actually verified replacements',async t=>{const f=await fixture(t);await f.store.transaction(s=>{s.customers[0].totpSecret=totpSecret();});const before=await f.store.snapshot();let r=authenticationReadiness(before,{pepper:secret,now:f.now()});assert.equal(r.customers.authenticatorUnverified,1);assert.equal(r.administrators.unverified,1);assert.equal(r.ready,false);assert.doesNotMatch(JSON.stringify(r),/670050001|NC-AAAA|a sufficiently|\$argon2|totpSecret/);assert.deepEqual(await f.store.snapshot(),before);await f.store.transaction(s=>{recordVerifiedMethod(s.customers[0],'pin',null,secret,f.now());recordVerifiedMethod(s.adminUsers[0],'password',null,secret,f.now());});r=authenticationReadiness(await f.store.snapshot(),{pepper:secret,now:f.now()});assert.equal(r.customers.authenticatorUnverified,0);assert.equal(r.administrators.unverified,0);assert.deepEqual(r.blockers,['RECOVERY_AND_PILOT_REVIEW_REQUIRED']);});



test('fresh PIN proof is required, CSRF enforced and failed verification is bounded',async t=>{const f=await fixture(t);assert.equal((await f.call(root+'/confirm',{}, {csrf:'bad'})).status,403);assert.equal((await f.call(root+'/confirm',{pin:'0000'})).status,401);f.advance(2);assert.equal((await f.call(root+'/confirm',{pin:'2468'})).status,200);const s=await f.store.snapshot();assert.equal(s.customers[0].authMigration.methods.pin.method,'pin');assert.equal((await f.call(root,undefined,{session:'secondary'})).body.replacementVerified,true);assert.equal((await f.call(root,undefined,{session:'other'})).body.replacementVerified,false);for(let n=0;n<6;n++){f.advance(61);await f.call(root+'/confirm',{pin:'0000'});}assert.equal((await f.call(root+'/confirm',{pin:'2468'})).status,429);});

test('voucher setup cannot replace a PIN-less existing authenticator or passkey account',async t=>{for(const factor of ['totp','passkey']){const f=await fixture(t);await f.store.transaction(s=>{delete s.customers[0].pinHash;if(factor==='totp')s.customers[0].totpSecret=totpSecret();else s.customers[0].passkeys=[{id:'protected-key',publicKey:'unused'}];});assert.equal((await f.call('/api/account/setup/pin',{phone:'670050001',code:'NC-AAAA-1111',pin:'1357',confirmPin:'1357'})).status,401);assert.equal((await f.call('/api/account/access/begin',{phone:'670050001',code:'NC-AAAA-1111'})).status,409);assert.equal((await f.store.snapshot()).customers[0].pinHash,undefined);}});

test('already issued voucher setup intent cannot outlive adoption of an existing factor',async t=>{const f=await fixture(t);await f.store.transaction(s=>delete s.customers[0].pinHash);const begin=await f.call('/api/account/access/begin',{phone:'670050001',code:'NC-AAAA-1111'});assert.equal(begin.status,200);await f.store.transaction(s=>s.customers[0].totpSecret=totpSecret());const end=await f.call('/api/account/access/complete',{token:begin.body.token,pin:'1357',confirmPin:'1357'});assert.equal(end.status,409);assert.equal((await f.store.snapshot()).customers[0].pinHash,undefined);});

test('owner readiness review requires fresh password, explicit recovery evidence and current inventory',async t=>{const f=await fixture(t);await f.store.transaction(s=>recordVerifiedMethod(s.adminUsers[0],'password',null,secret,f.now()));const input={expectedDigest:(await f.admin('/status')).body.digest,password:'a sufficiently long admin password',rollbackRevision:'a'.repeat(40),evidenceReference:'STAGING-RECOVERY-TEST-1',supportRecoveryVerified:true,authenticationPilotVerified:true};assert.equal((await f.admin('/review',{...input,password:'wrong'})).status,401);assert.equal((await f.admin('/review',{...input,supportRecoveryVerified:false})).status,400);let r=await f.admin('/review',input);assert.equal(r.status,200);assert.equal(r.body.ready,true);assert.equal((await f.admin('/status')).body.ready,true);await f.store.transaction(s=>s.adminUsers[0].passwordHash=undefined);assert.equal((await f.admin('/status')).body.ready,false);});

test('revoked staff cannot view aggregate readiness or reuse a verification session',async t=>{const f=await fixture(t);await f.store.transaction(s=>s.adminUsers[0].active=false);assert.equal((await f.admin('/status')).status,401);assert.equal((await f.admin('/confirm',{password:'a sufficiently long admin password'})).status,401);});

test('legacy destructive admin authenticator reset is retired and preserves the last credential',async t=>{const f=await fixture(t),key=await legacy(f);const r=await fetch(f.api+'/api/admin/customers/reset-authenticator',{method:'POST',headers:{origin:'http://customer.test',cookie:'admin_session=owner','content-type':'application/json','x-csrf-token':'csrf'},body:JSON.stringify({customerId:'c1'})});assert.equal(r.status,410);assert.equal((await f.store.snapshot()).customers[0].totpSecret,key);});

test('migration responses are withheld when storage commit fails',async t=>{const f=await fixture(t),original=f.store.transaction.bind(f.store);f.store.transaction=(fn,...args)=>original(async s=>{const v=await fn(s);if(s.customers[0].authMigration)throw Error('Synthetic commit failure');return v;},...args);const r=await f.call(root+'/confirm',{pin:'2468'});assert.notEqual(r.status,200);assert.equal((await f.store.snapshot()).customers[0].authMigration,undefined);assert.doesNotMatch(JSON.stringify((await f.call('/api/account/dashboard')).body),/authMigration/);});

test('preparation rollback honors the retired marker despite leftover factors and environment flags',async t=>{
 const f=await fixture(t);await legacy(f);await f.store.transaction(s=>{s.zone.authenticatorRetirement={version:1};s.adminProfile={mfaEnabled:true,totpSecret:totpSecret()};s.otpChallenges.push({id:'old',customerId:'c1',attempts:0,expiresAt:new Date(+f.now()+300000).toISOString()});});
 for(const [path,input] of [['/api/account/security/mfa/status',undefined],['/api/account/security/mfa/enroll',{}],['/api/account/security/recovery-codes/generate',{}],['/api/account/login/request-authenticator',{phone:'670050001'}],['/api/account/login/verify-authenticator',{challengeId:'old',otp:'123456'}]]){const r=await f.call(path,input);assert.equal(r.status,410,path);assert.equal(r.body.code,'AUTHENTICATOR_RETIRED');}
 for(const path of ['/api/admin/profile/mfa/enroll','/api/admin/login/mfa']){const r=await fetch(f.api+path,{method:'POST',headers:{origin:'http://customer.test',cookie:'admin_session=owner','content-type':'application/json','x-csrf-token':'csrf'},body:'{}'});assert.equal(r.status,410,path);}
 const login=await fetch(f.api+'/api/admin/login',{method:'POST',headers:{origin:'http://customer.test','content-type':'application/json'},body:JSON.stringify({username:'owner',password:'a sufficiently long admin password'})});assert.equal(login.status,200);assert.equal((await login.json()).mfaRequired,undefined);
});

test('staff record and dashboard projections never expose private credential markers or readiness review payloads',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{recordVerifiedMethod(s.customers[0],'pin',null,secret,f.now());s.zone.authenticationMigrationReview={version:1,evidenceReference:'PRIVATE-REVIEW',digest:'PRIVATE-DIGEST'};});
 for(const path of ['/api/admin/dashboard','/api/admin/records?collection=customers']){const r=await fetch(f.api+path,{headers:{origin:'http://customer.test',cookie:'admin_session=owner'}});assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/authMigration|PRIVATE-REVIEW|PRIVATE-DIGEST/);}
});

test('preparation cannot remove the sole usable sign-in credential',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{delete s.customers[0].pinHash;s.customers[0].passkeys=[{id:'only-key',publicKey:'protected'}];});
 const r=await f.call('/api/account/passkeys/remove',{passkeyId:'only-key'});assert.equal(r.status,401);assert.equal(r.body.code,'VERIFICATION_FAILED');assert.equal((await f.store.snapshot()).customers[0].passkeys.length,1);
});

test('zone GET cannot mutate readiness state and ordinary admin responses keep credential internals private',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{s.zone.authenticationMigrationReview={evidenceReference:'PRIVATE-ZONE-REVIEW'};s.customers[0].passkeys=[{id:'internal',publicKey:'PRIVATE-PUBLIC-KEY',counter:15}];});
 const before=(await f.store.snapshot()).zone;
 const get=await fetch(f.api+'/api/admin/zone',{headers:{origin:'http://customer.test',cookie:'admin_session=owner'}});assert.equal(get.status,404);assert.deepEqual((await f.store.snapshot()).zone,before);
 const headers={origin:'http://customer.test',cookie:'admin_session=owner','content-type':'application/json','x-csrf-token':'csrf'};
 const zone=await fetch(f.api+'/api/admin/zone',{method:'POST',headers,body:JSON.stringify({status:'online',notes:'Synthetic change'})});assert.equal(zone.status,200);assert.doesNotMatch(await zone.text(),/PRIVATE-ZONE-REVIEW|authenticationMigrationReview/);assert.equal((await f.store.snapshot()).zone.authenticationMigrationReview.evidenceReference,'PRIVATE-ZONE-REVIEW');
 const suspend=await fetch(f.api+'/api/admin/customers/suspend',{method:'POST',headers,body:JSON.stringify({customerId:'c1'})});assert.equal(suspend.status,200);const body=await suspend.json();assert.equal(body.customer.passkeys,1);assert.doesNotMatch(JSON.stringify(body),/PRIVATE-PUBLIC-KEY|counter/);
});

test('credential evidence accepts only canonical supported method tags and never treats an unknown method as PIN',async t=>{
 const f=await fixture(t),c=(await f.store.snapshot()).customers[0];
 for(const tag of ['arbitrary','PASSWORD',{toString(){return 'pin';}},undefined]){assert.equal(credentialVersion(tag,c,null,secret),null);assert.throws(()=>recordVerifiedMethod(c,tag,null,secret,f.now()));}
 assert.equal(typeof credentialVersion('pin',c,null,secret),'string');
});

test('legacy admin sessions require explicit reauthentication for preparation without expiring ordinary dashboard access',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>s.adminSessions.push({role:'owner',tokenHash:hashSecret('legacy',secret),csrfToken:'csrf',expiresAt:new Date(+f.now()+3600000).toISOString()}));
 for(const [path,input]of[['/status',undefined],['/confirm',{password:'a sufficiently long admin password'}]]){const r=await f.admin(path,input,'legacy');assert.equal(r.status,409);assert.equal(r.body.code,'ADMIN_REAUTHENTICATION_REQUIRED');}
 const r=await fetch(f.api+'/api/admin/dashboard',{headers:{origin:'http://customer.test',cookie:'admin_session=legacy'}});assert.equal(r.status,200);
});

test('readiness evidence remains stable when JSONB reorders nested proof fields',async t=>{
 const f=await fixture(t);await f.store.transaction(s=>{recordVerifiedMethod(s.customers[0],'pin',null,secret,f.now());recordVerifiedMethod(s.adminUsers[0],'password',null,secret,f.now());s.zone.authenticationMigrationReview={version:1,digest:authenticationReadiness(s,{pepper:secret,now:f.now()}).digest,rollbackRevision:'b'.repeat(40),evidenceReference:'SYNTHETIC-JSONB-ROUNDTRIP',supportRecoveryVerified:true,authenticationPilotVerified:true,at:f.now().toISOString()};});
 const state=await f.store.snapshot(),reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverse(item)])):value;
 const original=authenticationReadiness(state,{pepper:secret,now:f.now()}),reordered=authenticationReadiness(reverse(state),{pepper:secret,now:f.now()});assert.equal(original.ready,true);assert.equal(reordered.digest,original.digest);assert.equal(reordered.ready,true);
});


test('owner review and passkey options reject absent or changed inventory without recording evidence',async t=>{
 const f=await fixture(t), before=await f.admin('/status');
 const input={expectedDigest:before.body.digest,password:'a sufficiently long admin password',rollbackRevision:'a'.repeat(40),evidenceReference:'SYNTHETIC-REVIEW-82',supportRecoveryVerified:true,authenticationPilotVerified:true};
 assert.equal((await f.admin('/review',{...input,expectedDigest:undefined})).status,409);
 await f.store.transaction(s=>s.customers[0].status='suspended');
 for(const path of ['/review','/options']){const r=await f.admin(path,{...input,action:'review'});assert.equal(r.status,409);assert.equal(r.body.code,'READINESS_CHANGED');}
 assert.equal((await f.store.snapshot()).zone.authenticationMigrationReview,undefined);
 assert.equal((await f.store.snapshot()).zone.authenticatorRetirement,undefined);
 const current=await f.admin('/status');assert.notEqual(current.body.digest,before.body.digest);
 assert.equal((await f.admin('/review',{...input,expectedDigest:current.body.digest})).status,200);
 assert.equal((await f.store.snapshot()).zone.authenticationMigrationReview.digest,current.body.digest);
 assert.equal((await f.store.snapshot()).zone.authenticatorRetirement,undefined);
});

test('administrator readiness binds both hashes and never counts a stale independent PIN alias as password readiness',async t=>{
 const f=await fixture(t);await f.store.transaction(async s=>{const u=s.adminUsers[0];u.pinHash=await argon2.hash('1357');recordVerifiedMethod(u,'pin',null,secret,f.now());});
 let state=await f.store.snapshot(),before=authenticationReadiness(state,{pepper:secret,now:f.now()});assert.equal(before.administrators.unverified,1);
 await f.store.transaction(async s=>{s.adminUsers[0].passwordHash=await argon2.hash('Rotated current administrator password 82!');});
 let after=authenticationReadiness(await f.store.snapshot(),{pepper:secret,now:f.now()});assert.notEqual(after.digest,before.digest,'changing a password cannot preserve a reviewed inventory through an unchanged alias');
 await f.store.transaction(s=>recordVerifiedMethod(s.adminUsers[0],'password',null,secret,f.now()));
 after=authenticationReadiness(await f.store.snapshot(),{pepper:secret,now:f.now()});assert.equal(after.administrators.unverified,0);
});
