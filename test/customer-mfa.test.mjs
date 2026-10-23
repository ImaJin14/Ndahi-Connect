import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { totpSecret, totpCode, hashSecret } from "../lib/security.mjs";

const management = "/api/account/security/mfa";
test("runtime authenticator routes are retired even without an offline purge marker and cannot mutate legacy enrollment", async t => {
  const f = await pairingFixture(); t.after(f.close);
  const secret = totpSecret();
  await f.store.transaction(s => { s.customers[0].totpSecret = secret; s.customers[0].recoveryCodes = [{ hash: hashSecret("ABCD-2345", "pairing-tests") }]; s.otpChallenges.push({ id: "legacy-login", customerId: "c1", attempts: 0, expiresAt: new Date(+f.now()+300000).toISOString() }); });
  const before = await f.store.snapshot();
  for (const [path, input] of [[management+"/status", undefined], ...["enroll","replace","resume","check","confirm","cancel","options"].map(action => [management+"/"+action, { pin: "2468", otp: totpCode(secret,+f.now()), code: totpCode(secret,+f.now()), challengeId: "old" }]), ["/api/account/security/recovery-codes/generate",{}], ["/api/account/login/request-authenticator",{phone:"670050001"}], ["/api/account/login/verify-authenticator",{challengeId:"legacy-login",otp:totpCode(secret,+f.now()),recoveryCode:"ABCD-2345"}]]) {
    const response = await f.call(path,input); assert.equal(response.status,410,path); assert.equal(response.body.code,"AUTHENTICATOR_RETIRED"); assert.doesNotMatch(JSON.stringify(response.body),new RegExp(secret+"|ABCD-2345|data:image"));
  }
  const after=await f.store.snapshot(); assert.deepEqual(after.customers,before.customers); assert.deepEqual(after.otpChallenges,before.otpChallenges); assert.deepEqual(after.dashboardSessions,before.dashboardSessions);
});

test("legacy OTP and authenticator recovery codes cannot create a PIN or establish migration readiness",async t=>{
 const f=await pairingFixture();t.after(f.close);const secret=totpSecret();
 await f.store.transaction(s=>{delete s.customers[0].pinHash;s.customers[0].totpSecret=secret;s.customers[0].recoveryCodes=[{hash:hashSecret("ABCD-2345","pairing-tests")}];});
 for(const input of [{otp:totpCode(secret,+f.now())},{recoveryCode:"ABCD-2345"},{}]){
  const response=await f.call("/api/account/authentication-migration/pin/start",{newPin:"1357",confirmPin:"1357",...input});assert.equal(response.status,401);
 }
 const state=await f.store.snapshot();assert.equal(state.customers[0].pinHash,undefined);assert.equal(state.customers[0].authMigration,undefined);assert.equal(state.dashboardSessions[0].authMigrationIntent,undefined);
 const dashboard=await f.call("/api/account/dashboard");assert.equal(dashboard.body.customer.authenticatorEnrolled,false);assert.equal(dashboard.body.customer.authenticatorRetired,true);assert.doesNotMatch(JSON.stringify(dashboard.body),new RegExp(secret+"|ABCD-2345|totpSecret"));
});
