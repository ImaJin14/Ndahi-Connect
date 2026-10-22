import test from "node:test";
import assert from "node:assert/strict";
import { t, getPreferredLanguage, setPreferredLanguage, formatWhatsAppVoucherShare, TRANSLATIONS } from "../shared-app/i18n.js";
import { createStore } from "../server.mjs";
import { createAccountToolsRoutes } from "../lib/api/account-tools.mjs";

test("i18n translations cover required bilingual keys for English and French", () => {
  const keys = [
    "navHome", "navBundles", "navAccount", "navNotifications", "logout",
    "activeBundle", "noActiveBundle", "remaining", "used", "expires",
    "myVouchers", "voucherCodes", "copyCode", "downloadPdf", "shareWhatsApp", "showQrCode"
  ];
  for (const k of keys) {
    assert.ok(TRANSLATIONS.en[k], `Missing English translation for ${k}`);
    assert.ok(TRANSLATIONS.fr[k], `Missing French translation for ${k}`);
    assert.equal(t(k, "en"), TRANSLATIONS.en[k]);
    assert.equal(t(k, "fr"), TRANSLATIONS.fr[k]);
  }
  // Fallback test
  assert.equal(t("nonExistentKey", "fr"), "nonExistentKey");
});

test("formatWhatsAppVoucherShare produces properly encoded WhatsApp share URL", () => {
  const v = {
    id: "v123",
    code: "NC-TEST-VOUCH",
    plan: { name: "Weekly Flex" }
  };
  const url = formatWhatsAppVoucherShare(v, "https://connect.ndahi.net");
  assert.ok(url.startsWith("https://wa.me/?text="));
  const decoded = decodeURIComponent(url.replace("https://wa.me/?text=", ""));
  assert.match(decoded, /NC-TEST-VOUCH/);
  assert.match(decoded, /Weekly Flex/);
  assert.match(decoded, /action=connect/);

  // Missing code
  assert.equal(formatWhatsAppVoucherShare(null), "");
  assert.equal(formatWhatsAppVoucherShare({}), "");
});

test("API /api/account/vouchers/:id/qr enforces session and returns QR data URL", async () => {
  const store = createStore({ persistent: false });
  const clock = () => new Date("2026-10-22T12:00:00Z");
  let customerId, voucherId, sessionId;
  await store.transaction((s) => {
    s.customers.push({ id: "cust-1", phone: "677001122", pinHash: "pin" });
    s.dashboardSessions.push({ id: "sess-1", customerId: "cust-1", expiresAt: "2026-10-22T13:00:00Z" });
    s.vouchers.push({ id: "vouch-1", customerId: "cust-1", code: "NC-ABCD-1234", planId: "daily-100", status: "active" });
    customerId = "cust-1";
    sessionId = "sess-1";
    voucherId = "vouch-1";
  });

  const routes = createAccountToolsRoutes({
    mutate: (fn, opts) => store.transaction(fn, opts),
    auth: (_req, s) => s.dashboardSessions.find((x) => x.id === sessionId),
    clock,
    refreshCustomerSession: () => {},
    issueCustomerSession: () => {},
    pinThrottle: () => ({ ok: true }),
    recordPinFailure: () => {},
    clearPinFailures: () => {},
    customerRpID: "localhost",
    customerOrigin: "https://connect.ndahi.net",
  });

  // 1. Success response
  let resStatus = null, resHeaders = null, resBody = null;
  const mockRes = {
    writeHead: (st, hd) => { resStatus = st; resHeaders = hd; },
    end: (b) => { resBody = b; },
  };

  const url = new URL(`https://localhost/api/account/vouchers/${voucherId}/qr`);
  await routes({ method: "GET", headers: {} }, mockRes, url);

  assert.equal(resStatus, 200);
  const data = JSON.parse(resBody);
  assert.equal(data.voucherId, voucherId);
  assert.equal(data.code, "NC-ABCD-1234");
  assert.match(data.qrCode, /^data:image\/png;base64,/);
  assert.match(data.redemptionUrl, /action=connect/);

  // 2. Non-existent voucher
  let errStatus = null, errBody = null;
  const errRes = {
    writeHead: (st) => { errStatus = st; },
    end: (b) => { errBody = b; },
  };
  const missingUrl = new URL("https://localhost/api/account/vouchers/missing/qr");
  await routes({ method: "GET", headers: {} }, errRes, missingUrl);
  assert.equal(errStatus, 404);
});
