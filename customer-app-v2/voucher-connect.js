import { wifiHint } from "./wifi-pairing.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { loadPasskeys, randomId } from "./compat.js";
import { routerLoginUrl } from "./wifi-completion.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { fmt, timeLeft } from "./active-bundle.js";
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
// Scan to connect (#371, canvas PhoneScanConnect): checking, the account's card
// before the PIN (owner 27 Nov: first name, time left and slots, as drawn),
// Join NDAHI Wi-Fi first, Someone else is signed in here, no active bundle
// (#412) and You're online. One state shows at a time.
const lang = currentLanguage(), L = (key, values) => format(key, values || {}, lang);
document.documentElement.lang = lang;
document.querySelectorAll("[data-scan-l]").forEach((node) => { node.textContent = L(node.dataset.scanL); });
// "Open Wi-Fi settings and join NDAHI", with the network's name in bold.
const bold = (key, values) => {
  const marks = Object.fromEntries(Object.keys(values).map((name, i) => [name, "\u0001" + i + "\u0002"]));
  let html = h(L(key, marks));
  Object.values(values).forEach((value, i) => { html = html.replace("\u0001" + i + "\u0002", "<strong>" + h(value) + "</strong>"); });
  return html;
};
document.querySelectorAll("[data-scan-html]").forEach((node) => { node.innerHTML = bold(node.dataset.scanHtml, { network: "NDAHI" }); });
let scanned = null;
function state(name) {
  document.querySelectorAll("[data-scan]").forEach((node) => { node.hidden = node.dataset.scan !== name; });
  document.querySelectorAll("[data-scan-only]").forEach((node) => { node.hidden = node.dataset.scanOnly !== name; });
  document.querySelector("#qrNoBundle").hidden = name !== "nobundle";
  if (name) document.body.dataset.scanState = name; else delete document.body.dataset.scanState;
}
// The card before the PIN: "Hi Amina — confirm it's you", "Active · Personal
// Unlimited", the time left (an earlier bundle: its data left), and "Ends 25
// Nov · 1 of 2 device slots used".
function fillReady(result) {
  const first = result.account?.first, bundle = result.bundle || {}, ends = Date.parse(bundle.expiresAt);
  document.querySelector("#readyTitle").textContent = first ? L("scanHi", { name: first }) : L("scanConfirm");
  document.querySelector("#bundleName").textContent = L("scanActivePlan", { plan: result.planName });
  const left = Number.isFinite(bundle.remainingBytes) ? fmt(bundle.remainingBytes) : Number.isFinite(ends) ? timeLeft(ends - Date.now()) : "";
  document.querySelector("#bundleLeft").textContent = left ? L("scanLeft", { left }) : "";
  const date = Number.isFinite(ends) ? new Date(ends).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: lang === "fr" ? "long" : "short" }) : "";
  document.querySelector("#bundleEnds").textContent = [date ? L("scanEnds", { date }) : "", bundle.slots ? L("scanSlots", { used: bundle.slots.used, total: bundle.slots.total }) : ""].filter(Boolean).join(" · ");
}
// Someone else is signed in here: both accounts by first name and initial.
function wrongAccount(error) {
  const account = error.account || {}, current = error.current || {};
  const stop = (name) => /\.$/.test(name) ? name : name + ".";
  // An account without a name on file still gets the drawn screen, in plain words.
  document.querySelector("#wrongText").innerHTML = bold("scanWrongText", { current: stop(current.name || L("scanAnotherAccount")), account: stop(account.name || L("scanAnotherAccount")) });
  document.querySelector("#wrongNote").textContent = current.first ? L("scanWrongNote", { name: current.first }) : L("scanWrongNotePlain");
  document.querySelector("#switchAccount").textContent = account.first ? L("scanSwitch", { name: account.first }) : L("scanSwitchPlain");
  document.querySelector("#stayAccount").textContent = current.first ? L("scanStay", { name: current.first }) : L("scanStayPlain");
  message.textContent = "";
  state("wrong");
  return true;
}
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
    error.current = value.current;
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
  none.closest("section.surface")?.setAttribute("data-no-bundle", "");
  state("nobundle");
  return true;
}
function show(error) {
  if (error.code === "BUNDLE_INACTIVE" && noBundle(error)) return;
  if (error.code === "DIFFERENT_ACCOUNT" && wrongAccount(error)) return;
  // Every slot is full: this device can take another one's slot (#371 → #350).
  if (error.code === "DEVICE_SLOTS_FULL" && attempt?.mac && attempt?.address) {
    location.assign("/replace-device.html?" + new URLSearchParams({ mac: attempt.mac, address: attempt.address }));
    return;
  }
  // Any other answer to the scan: the reason, and Check again.
  if (document.body.dataset.scanState === "checking") state("error");
  message.textContent = error.message;
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
      // You're online (#371): "This device now uses Amina's Personal Unlimited
      // bundle. It shows up in Amina's Devices list." (owner: names, not pronouns).
      clearVoucherScan();
      message.textContent = "";
      const first = scanned?.account?.first;
      document.querySelector("#doneText").textContent = first ? L("scanDoneText", { name: first, plan: scanned.planName }) : L("scanDoneTextYour");
      state("done");
      document.querySelector("#scanDone").focus();
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
  message.textContent = "";
  state("checking");
  document.querySelector("#qrNoBundle").closest("section.surface")?.removeAttribute("data-no-bundle");
  const hint = wifiHint();
  attempt = voucherScanAttempt(selection, hint);
  try {
    const result = await request("/api/account/qr-connect/begin", attempt);
    context = result.context;
    scanned = result;
    fillReady(result);
    passkeyButton.hidden =
      !result.passkeyAvailable || !window.PublicKeyCredential;
    document.querySelector("#passkeyOr").hidden = passkeyButton.hidden;
    if (!result.wifiReady) {
      // Join NDAHI Wi-Fi first (#371, as drawn): the steps, Open Wi-Fi sign-in
      // and Check again; this device connects once Wi-Fi identifies it.
      state("wifi");
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
      return;
    }
    state("ready");
    if (attempt.requestId) {
      busy = true;
      await poll(attempt.requestId);
      busy = false;
      return;
    }
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
      state("wifi");
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
document.querySelector("#retryScan").onclick = () => { void begin(); };
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
  state(null), message.textContent =
    "Scan your active voucher QR, or open a new QR from Vouchers in your account.";

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopped = false;
    busy = false;
    form.reset();
    void begin();
  }
});
