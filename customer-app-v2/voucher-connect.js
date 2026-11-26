import { wifiHint } from "./wifi-pairing.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { loadPasskeys, randomId } from "./compat.js";
import { routerLoginUrl } from "./wifi-completion.js";
import {
  savedVoucherScan,
  saveVoucherScan,
  clearVoucherScan,
  voucherScanAttempt,
} from "./voucher-qr-context.js";
const api = window.NDAHI_CONFIG.apiUrl,
  message = document.querySelector("#qrMessage"),
  form = document.querySelector("#qrConnectForm"),
  pinButton = document.querySelector("#connectWithPin"),
  passkeyButton = document.querySelector("#connectWithPasskey");
const fragment = new URLSearchParams(location.hash.slice(1));
const saved = savedVoucherScan(),
  selection = fragment.get("qr")
    ? { qr: fragment.get("qr") }
    : fragment.get("legacy")
      ? { legacyCode: fragment.get("legacy") }
      : saved
        ? { qr: saved.qr, legacyCode: saved.legacyCode }
        : {};
history.replaceState(null, "", location.pathname + location.search);
let attempt,
  context,
  csrf = "",
  busy = false,
  stopped = false;
window.addEventListener("pagehide", () => {
  stopped = true;
  document.querySelector("#accountPin").value = "";
});
async function request(path, input, owned = false) {
  const response = await fetch(api + path, {
    credentials: "include",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    ...(input
      ? {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(owned ? { "x-csrf-token": csrf } : {}),
          },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.error || "The request could not be completed. Try again.",
    );
    error.code = value.code;
    error.account = value.account;
    error.endedAt = value.endedAt;
    error.status = response.status;
    error.retryAfter = Math.max(
      1,
      Math.min(
        15,
        Number(
          response.headers.get("retry-after") || value.retryAfterSeconds,
        ) || 2,
      ),
    );
    throw error;
  }
  return value;
}
function buttons(enabled) {
  pinButton.disabled = !enabled;
  passkeyButton.disabled = !enabled;
}
// No active bundle on the scanned account (canvas: PhoneScanNoBundle, #412;
// owner 26 Nov): the account as drawn (first name and initial, masked number),
// when its last bundle ended, then Buy a bundle or a voucher code. A purchase
// started here comes back to this scan, which then connects the new bundle
// after the PIN: no second scan.
function noBundle(error) {
  const none = document.querySelector("#qrNoBundle"), hint = wifiHint(), lang = currentLanguage();
  if (!none) return false;
  const L = (key, values) => format(key, values || {}, lang);
  const ended = Date.parse(error.endedAt), who = error.account || {};
  const text = Number.isFinite(ended)
    // "5 Nov"; French spells the month out ("5 novembre"), as "nov." would end on two stops.
    ? L("scanNoBundleEnded", { date: new Date(ended).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: lang === "fr" ? "long" : "short" }) })
    : L("scanNoBundleNone");
  document.querySelector("#qrNoBundleWho").hidden = !who.name;
  document.querySelector("#qrNoBundleInitial").textContent = String(who.name || "").charAt(0).toUpperCase();
  document.querySelector("#qrNoBundleName").textContent = who.name || "";
  document.querySelector("#qrNoBundlePhone").textContent = who.phone || "";
  document.querySelector("#qrNoBundleTitle").textContent = L("scanNoBundleTitle");
  document.querySelector(".scan-bar__help").textContent = L("navHelp");
  document.querySelector("#qrBuyBundle").textContent = L("scanBuyBundle");
  document.querySelector("#qrHaveVoucher").textContent = L("scanHaveVoucher");
  // The status line keeps the words (announced); the panel shows them visually.
  message.textContent = text;
  document.querySelector("#qrNoBundleText").textContent = text;
  // Kept long enough to pay with Mobile Money and come back.
  saveVoucherScan({ ...attempt, until: undefined }, 1800000);
  const buy = new URL("/onboarding.html", location.origin);
  buy.searchParams.set("from", "scan");
  if (hint) { buy.searchParams.set("mac", hint.mac); buy.searchParams.set("address", hint.address); }
  document.querySelector("#qrBuyBundle").href = buy.pathname + buy.search;
  document.querySelector("#qrConnectForm").hidden = true;
  none.closest("section.surface")?.setAttribute("data-no-bundle", "");
  none.hidden = false;
  return true;
}
function show(error) {
  if (error.code === "BUNDLE_INACTIVE" && noBundle(error)) return;
  message.textContent = error.message;
  document.querySelector("#switchAccount").hidden =
    error.code !== "DIFFERENT_ACCOUNT";
  if (error.code === "VOUCHER_NOT_ASSIGNED") {
    const link = document.createElement("a");
    link.href = "/login";
    link.textContent = "Activate or claim this voucher";
    link.id = "claimVoucher";
    message.append(" ", link);
  }
}
async function poll(id) {
  const end = Date.now() + 120000;
  while (!stopped && Date.now() < end) {
    let result;
    try {
      result = await request("/api/wifi/pairing/status", {
        id,
        key: attempt.key,
      });
    } catch (error) {
      if (error.status !== 429) throw error;
      message.textContent =
        "Connecting… Waiting for the router to confirm this device.";
      await new Promise((resolve) =>
        setTimeout(resolve, error.retryAfter * 1000),
      );
      continue;
    }
    const current = result.request;
    if (current.status === "connected" && current.completionReady !== false) {
      message.textContent = "The router confirmed this device is connected.";
      clearVoucherScan();
      location.replace("/dashboard#home");
      return;
    }
    if (
      !["connecting", "pending", "awaiting_confirmation", "connected"].includes(
        current.status,
      )
    ) {
      delete attempt.requestId;
      attempt.key = randomId();
      saveVoucherScan(attempt);
      context = null;
      throw Error(
        current.message ||
          "The connection was not confirmed. Check again or contact support.",
      );
    }
    message.textContent =
      "Connecting… Waiting for the router to confirm this device.";
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!stopped)
    throw Error(
      "Connection is taking longer than expected. Check again to continue the same request; do not pay again.",
    );
}
async function begin() {
  if (busy) return;
  buttons(false);
  context = null;
  document.querySelector("#switchAccount").hidden = true;
  document.querySelector("#qrNoBundle").hidden = true;
  document.querySelector("#qrNoBundle").closest("section.surface")?.removeAttribute("data-no-bundle");
  document.querySelector("#qrConnectForm").hidden = false;
  const hint = wifiHint();
  attempt = voucherScanAttempt(selection, hint);
  try {
    const result = await request("/api/account/qr-connect/begin", attempt);
    context = result.context;
    document.querySelector("#bundleName").textContent = result.planName;
    passkeyButton.hidden =
      !result.passkeyAvailable || !window.PublicKeyCredential;
    document.querySelector("#wifiGuidance").hidden = result.wifiReady;
    if (!result.wifiReady) {
      // #213: the PIN or passkey still signs in to the account here; connecting
      // this device waits until Wi-Fi sign-in identifies it.
      message.textContent =
        "NDAHI Wi-Fi has not identified this device yet. You can sign in with your PIN now, then open Wi-Fi sign-in to connect this device.";
      const login = routerLoginUrl(window.NDAHI_CONFIG.hotspotLoginUrl),
        link = document.querySelector("#openWifi");
      if (login) {
        login.searchParams.set(
          "dst",
          new URL("/voucher-connect.html", location.origin).href,
        );
        login.searchParams.set("popup", "false");
        link.href = login.href;
        link.hidden = false;
      }
      buttons(true);
      return;
    }
    if (attempt.requestId) {
      busy = true;
      await poll(attempt.requestId);
      busy = false;
      return;
    }
    message.textContent =
      "Your active voucher is ready. Authorize this device with your account PIN or passkey.";
    buttons(true);
  } catch (error) {
    busy = false;
    show(error);
  }
}
async function authorize(passkey = false) {
  if (busy || !context) return;
  busy = true;
  buttons(false);
  // Once the account proof succeeds the attempt is used up; before that, a
  // wrong PIN or a cancelled passkey leaves it ready for another try.
  let verifiedProof = false;
  try {
    const input = { ...attempt, context };
    if (passkey) {
      const proof = await request("/api/account/qr-connect/options", input),
        browser = await loadPasskeys();
      input.challengeId = proof.challengeId;
      input.response = await browser.startAuthentication({
        optionsJSON: proof.options,
      });
    } else input.pin = document.querySelector("#accountPin").value;
    const verified = await request("/api/account/qr-connect/verify", input);
    verifiedProof = true;
    document.querySelector("#accountPin").value = "";
    // Signed in, but Wi-Fi has not identified this device: no connection yet.
    if (verified.wifiRequired) {
      context = null;
      document.querySelector("#wifiGuidance").hidden = false;
      message.textContent =
        "You're signed in. Open Wi-Fi sign-in on this device to connect it, then confirm with your PIN again.";
      return;
    }
    const account = await request("/api/account/dashboard");
    csrf = account.csrfToken;
    const connected = await request(
      "/api/account/device-management/connect",
      {
        mac: attempt.mac,
        address: attempt.address,
        key: attempt.key,
        qrAuthorization: verified.qrAuthorization,
      },
      true,
    );
    attempt.requestId = connected.request.id;
    saveVoucherScan(attempt);
    await poll(attempt.requestId);
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError")
      error = new Error(
        "The passkey prompt was cancelled or unavailable. Check again and try your account PIN.",
      );
    show(error);
    const cancelled = passkey && /cancelled or unavailable/.test(error.message);
    if (!verifiedProof && context) {
      // A locked PIN can be tried again after the wait the API gives.
      if (error.status === 429)
        setTimeout(() => { if (context && !busy) buttons(true); }, error.retryAfter * 1000);
      else if (cancelled || error.code === "VERIFICATION_FAILED" || !error.status) buttons(true);
    }
  } finally {
    busy = false;
    document.querySelector("#accountPin").value = "";
  }
}
form.onsubmit = (event) => {
  event.preventDefault();
  void authorize(false);
};
passkeyButton.onclick = () => {
  void authorize(true);
};
document.querySelector("#restartQr").onclick = () => {
  void begin();
};
document.querySelector("#switchAccount").onclick = async () => {
  try {
    const account = await request("/api/account/dashboard");
    csrf = account.csrfToken;
    await request("/api/account/logout", {}, true);
    await begin();
  } catch (error) {
    show(error);
  }
};
if (selection.qr || selection.legacyCode) begin();
else
  message.textContent =
    "Scan your active voucher QR, or open a new QR from Vouchers in your account.";

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopped = false;
    busy = false;
    form.reset();
    void begin();
  }
});
