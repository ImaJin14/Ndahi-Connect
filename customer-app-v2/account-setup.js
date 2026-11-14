import { escapeHtml as h } from "/shared/safe-html.js";
import { t } from "/shared/i18n.js";
import { currentLanguage, localize } from "/shared/ui/dom.js";

const marker = "ndahi-email-setup-prompt";
const api = window.NDAHI_CONFIG.apiUrl;
let dashboard,
  busy = false,
  banner,
  dialog,
  opener;
const storage = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  },
};
async function call(path, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(api + path, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      ...(input
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": dashboard.csrfToken,
            },
            body: JSON.stringify(input),
          }
        : {}),
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(
          body.error || "Account setup could not be completed. Try again.",
        ),
        { status: response.status },
      );
    return body;
  } catch (error) {
    if (error.name === "AbortError")
      throw Object.assign(
        new Error("The request timed out. Check your connection and retry."),
        { name: "TimeoutError" },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const pending = () =>
  dashboard.customer.pendingEmail &&
  Date.parse(dashboard.customer.pendingEmail.expiresAt) > Date.now()
    ? dashboard.customer.pendingEmail
    : null;
function reviewAccount() {
  dialog.close();
  location.hash = "account";
}
async function run(form, action) {
  if (busy || !form.reportValidity()) return;
  busy = true;
  const controls = [...dialog.querySelectorAll("input, button")];
  controls.forEach((el) => {
    el.disabled = true;
  });
  const message = dialog.querySelector("#setupMessage");
  message.textContent = "Please wait…";
  try {
    await action();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    if (form.elements.pin) form.elements.pin.value = "";
    controls.forEach((el) => {
      el.disabled = false;
    });
    busy = false;
  }
}
function requestEmail() {
  const c = dashboard.customer;
  dialog.querySelector("#setupMessage").textContent = "";
  if (c.pendingProfile) {
    dialog.querySelector("#setupBody").innerHTML =
      '<p>Your profile changes are awaiting confirmation. Review those changes in Account before confirming an email.</p><button type="button" id="setupReview">Review profile changes</button>';
    dialog.querySelector("#setupReview").onclick = reviewAccount;
    return;
  }
  if (!c.pinConfigured) {
    dialog.querySelector("#setupBody").innerHTML =
      '<p>Use your account credentials to link an email. Open Account to finish PIN setup or verify with a passkey.</p><button type="button" id="setupReview">Open Account settings</button>';
    dialog.querySelector("#setupReview").onclick = reviewAccount;
    return;
  }
  dialog.querySelector("#setupBody").innerHTML =
    `<form id="setupEmailForm"><h3>Step 1: Confirm your email address</h3><p>${c.email ? "We kept the email entered during signup. Check that it is correct." : "Add an email for account updates, receipts and PIN recovery."}</p><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" value="${h(pending()?.email || c.email || "")}" required></label><label>Current account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label><button type="submit">Send verification code</button></form>`;
  const form = dialog.querySelector("#setupEmailForm");
  form.onsubmit = (event) => {
    event.preventDefault();
    const email = form.elements.email.value.trim().toLowerCase(),
      pin = form.elements.pin.value;
    void run(form, async () => {
      try {
        await call("/api/account/profile/email", { email, pin });
      } catch (error) {
        if (!["TypeError", "TimeoutError", "SyntaxError"].includes(error.name))
          throw error;
        dashboard = await call("/api/account/dashboard");
        if (
          dashboard.customer.pendingEmail?.email !== email ||
          dashboard.customer.pendingProfile
        )
          throw error;
      }
      dashboard = await call("/api/account/dashboard");
      if (dashboard.customer.pendingEmail?.email !== email)
        throw Error(
          "The code request could not be confirmed. Check Account before requesting another.",
        );
      confirmEmail();
    });
  };
}
function confirmEmail() {
  if (dashboard.customer.pendingProfile) return requestEmail();
  const p = pending();
  if (!p) return requestEmail();
  dialog.querySelector("#setupMessage").textContent = "";
  dialog.querySelector("#setupBody").innerHTML =
    `<form id="setupConfirmForm"><h3>Step 2: Check your inbox</h3><p>A code was requested for <strong>${h(p.email)}</strong>. Delivery may take a moment. Check spam or junk too.</p><p>It expires at ${h(new Date(p.expiresAt).toLocaleTimeString())}. Enter the six-digit code here to finish linking your email.</p><label>Verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Verify and link email</button></form><button type="button" id="setupResend" class="secondary-action">Change email or request another code</button><p>To request another code, confirm your PIN again. Requests are rate limited; wait at least a minute between requests.</p>`;
  dialog.querySelector("#setupResend").onclick = requestEmail;
  const form = dialog.querySelector("#setupConfirmForm");
  form.onsubmit = (event) => {
    event.preventDefault();
    const code = form.elements.code.value.trim();
    void run(form, async () => {
      try {
        await call("/api/account/profile/email/confirm", { code });
      } catch (error) {
        if (!["TypeError", "TimeoutError", "SyntaxError"].includes(error.name))
          throw error;
        const recovered = await call("/api/account/dashboard");
        if (
          !recovered.customer.emailLinked ||
          recovered.customer.email !== p.email
        )
          throw error;
      }
      dashboard = await call("/api/account/dashboard");
      if (
        !dashboard.customer.emailLinked ||
        dashboard.customer.email !== p.email
      )
        throw Error(
          "Email confirmation could not be checked. Open Account to review its status.",
        );
      banner.hidden = true;
      dialog.querySelector("#setupBody").innerHTML =
        '<h3>Email linked</h3><p>Your email is confirmed for account updates, receipts and PIN recovery. Your other portal sessions were signed out to protect your account.</p><button type="button" id="setupContinue">Continue to my account</button>';
      dialog.querySelector("#setupMessage").textContent =
        "Account email setup complete.";
      dialog.querySelector("#setupContinue").onclick = () => location.reload();
      dialog.querySelector("#setupContinue").focus();
    });
  };
}
async function openSetup(event) {
  if (busy || dialog.open) return;
  opener = event?.currentTarget || banner.querySelector("button");
  dialog.showModal();
  dialog.querySelector("#setupBody").textContent =
    "Loading your account setup…";
  dialog.querySelector("#setupMessage").textContent = "";
  try {
    dashboard = await call("/api/account/dashboard");
    if (dashboard.customer.emailLinked) {
      banner.hidden = true;
      dialog.querySelector("#setupBody").textContent =
        "Your email is already linked.";
    } else if (pending()) confirmEmail();
    else requestEmail();
  } catch (error) {
    dialog.querySelector("#setupMessage").textContent = error.message;
  }
}
async function init() {
  if (!document.querySelector("#dashboard")) return;
  try {
    dashboard = await call("/api/account/dashboard");
  } catch {
    return;
  }
  if (dashboard.customer.emailLinked) {
    storage.remove(marker);
    return;
  }
  banner = document.createElement("section");
  banner.className = "account-setup-reminder";
  banner.setAttribute("aria-label", t("homeSetupReminder", currentLanguage()));
  banner.innerHTML =
    '<div><strong data-i18n="homeSetupTitle"></strong><p data-i18n="homeSetupBody"></p></div><button type="button" data-i18n="homeSetupTitle"></button>';
  const translateReminder = () => { localize(banner, currentLanguage()); banner.setAttribute("aria-label", t("homeSetupReminder", currentLanguage())); };
  translateReminder();
  window.addEventListener("ndahi:language", translateReminder);
  document.querySelector("#dashboardMessage").after(banner);
  banner.querySelector("button").onclick = openSetup;
  dialog = document.createElement("dialog");
  dialog.id = "accountSetupDialog";
  dialog.className = "account-setup-dialog";
  dialog.setAttribute("aria-labelledby", "setupTitle");
  dialog.innerHTML =
    '<div class="account-setup-heading"><h2 id="setupTitle">Link your email</h2><button type="button" id="setupClose" class="secondary-action">Not now</button></div><p>An email entered at signup is saved, but its mailbox must be verified before it can be linked for account notifications and recovery.</p><ol><li>Review your email and confirm your account PIN.</li><li>Check your inbox for the verification code.</li><li>Enter the code to finish linking your email.</li></ol><div id="setupBody"></div><p id="setupMessage" role="status" aria-live="polite"></p><a href="#account" id="setupAccount">Use Account settings instead</a>';
  document.body.append(dialog);
  dialog.querySelector("#setupClose").onclick = () => dialog.close();
  dialog.querySelector("#setupAccount").onclick = (event) => {
    event.preventDefault();
    reviewAccount();
  };
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (busy || banner.hidden) {
      if (banner.hidden) location.reload();
    } else opener?.focus();
  });
  const auto = storage.get(marker) === "1";
  storage.remove(marker);
  if (
    auto &&
    dashboard.customer.email &&
    !document.querySelector("dialog[open]")
  )
    await openSetup();
}
void init();
