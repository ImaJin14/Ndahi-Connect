import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { totpSecret, totpCode } from "../lib/security.mjs";

test("retired authenticator inputs never authorize main-device management without fresh supported proof",async t=>{
 const f=await pairingFixture();t.after(f.close);const secret=totpSecret();await f.store.transaction(s=>s.customers[0].totpSecret=secret);
 const path="/api/account/device-management/main",mac="AA:BB:CC:DD:EE:01";
 const denied=await f.call(path,{mac,otp:totpCode(secret,+f.now())});assert.equal(denied.status,401);f.advance(2);
 assert.equal((await f.call(path,{mac,pin:"2468",otp:"wrong-legacy"})).status,200);
 const info=await f.call("/api/account/device-management");assert.equal(info.body.authenticatorEnrolled,false);assert.equal(info.body.authenticatorRetired,true);
});
