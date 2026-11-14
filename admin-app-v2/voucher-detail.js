// Voucher detail (canvas: AdminVoucherDetail, #258) for #voucher/<id>: the
// ticket with its QR, usage, a history from the audit trail, details and the
// actions v1 has (mark sold/gift, resend receipt email, print, revoke with an
// inline confirmation). Data: GET /api/admin/vouchers/:id/details?full=1.
// A voucher reserved for a number (#254) shows "Waiting for claim": the
// number, days left to claim, wrong tries, and Change number.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { maskPhone } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB"), ZONE = "Africa/Douala";
const when = (value, withYear) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at), today = new Date().toLocaleDateString("en-CA", { timeZone: ZONE }) === date.toLocaleDateString("en-CA", { timeZone: ZONE });
  const day = today ? L("adminVoucherToday") : date.toLocaleDateString(locale(), { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: ZONE });
  return `${day} · ${date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE })}`;
};
const dateOnly = (value, withYear) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(locale(), { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: ZONE }) : "—";
const gb = (bytes) => `${(Math.max(0, Number(bytes) || 0) / 1e9).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;
const duration = (hours) => hours % 24 === 0 ? L(hours === 24 ? "adminOneDay" : "adminDays", { count: hours / 24 }) : L("adminHours", { count: hours });
// Status pill tones as drawn: in use, not used, used up, revoked.
const STATUS = { active: ["adminVoucherInUse", "success"], available: ["adminVoucherNotUsed", "info"], exhausted: ["adminVoucherUsedUp", ""],
  expired: ["adminVoucherExpired", ""], revoked: ["adminVoucherRevoked", "danger"], suspended: ["adminVoucherSuspended", "warning"],
  refunded: ["adminVoucherRefunded", ""], replaced: ["adminVoucherReplaced", ""], renewed: ["adminVoucherRenewed", ""], switched: ["adminVoucherSwitched", ""] };

export async function showVoucherDetail(host, { call, id, canManage, setHead, statusHost, printPreview, notice }) {
  host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
  let data;
  try { data = await call(`/api/admin/vouchers/${encodeURIComponent(id)}/details?full=1`); }
  catch (error) { host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(error.message || L("adminVoucherMissing"))}</p>`; return false; }
  render(host, data, { call, id, canManage, setHead, statusHost, printPreview, notice });
  return true;
}

function render(host, data, context) {
  const { call, id, canManage, setHead, statusHost, printPreview, notice } = context;
  const v = data.voucher, d = data.detail || {}, plan = data.plan || {}, code = d.code || "";
  const r = d.reservation, waiting = v.status === "available" && r?.status === "waiting", reservedPhone = r?.phone ? `+237 ${maskPhone(r.phone)}` : "";
  const [statusKey, tone] = waiting ? ["adminVoucherWaitingClaim", "claim"] : STATUS[v.status] || ["adminVoucherExpired", ""];
  const dim = ["exhausted", "expired", "revoked", "refunded"].includes(v.status);
  const unlimited = v.quotaBytes == null, kind = d.saleType === "gift" ? "gift" : d.saleType === "sold" ? "sold" : "";
  setHead({ title: code || L("adminVoucher") });
  // The code is the title, with its status pill and Copy code beside it.
  const heading = document.getElementById("adminTitle");
  heading?.classList.add("admin-title--code");
  heading?.parentElement?.classList.add("admin-head-title--inline");
  if (statusHost && heading && statusHost.previousElementSibling !== heading) heading.after(statusHost);
  if (statusHost) statusHost.innerHTML = `<span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L(statusKey))}</span>${code ? `<button type="button" class="admin-voucher__copy" data-voucher-copy>${h(L("adminCopyCode"))}</button>` : ""}`;
  const created = (d.history || []).find((e) => e.kind === "created"), customer = data.ownership || {};
  const facts = [unlimited ? L("adminUnlimitedData") : `${plan.quotaGb ?? Math.round((v.quotaBytes || 0) / 1e8) / 10} GB`, plan.validityHours ? duration(plan.validityHours) : "", v.deviceLimit === 1 ? L("adminOneDevice") : v.deviceLimit ? L("adminUpToDevices", { count: v.deviceLimit }) : ""].filter(Boolean).join(" · ");
  const validLine = waiting ? (r.phone ? L("adminOnlyFor", { phone: maskPhone(r.phone), date: dateOnly(r.expiresAt, true) }) : L("adminClaimBy", { date: dateOnly(r.expiresAt, true) }))
    : v.status === "active" ? L("adminEndsOn", { date: when(v.expiresAt, true) }) : v.status === "available" ? L("adminStartsWhenRedeemed")
    : v.status === "revoked" ? L("adminVoucherRevoked") : v.expiresAt ? L("adminVoucherEndedOn", { date: when(d.exhaustedAt || v.expiresAt) }) : "";
  // Usage: data (data used for unlimited bundles), time left, devices.
  const usedBytes = Number(v.usedBytes) || 0, quota = Number(v.quotaBytes) || 0, share = unlimited || !quota ? 0 : Math.min(100, Math.round(usedBytes / quota * 100));
  const hoursLeft = Math.max(0, (Date.parse(v.expiresAt) - Date.now()) / 36e5);
  const usage = ["active", "exhausted", "expired"].includes(v.status) ? `<section class="nd-panel admin-voucher__panel" aria-labelledby="voucherUsage"><h2 class="admin-voucher__h2" id="voucherUsage">${h(L("adminUsage"))}</h2>
    <div class="admin-voucher__stats">
      <div class="admin-voucher__stat"><b>${h(unlimited ? gb(usedBytes) : gb(data.remainingBytes))}</b><span>${h(unlimited ? L("adminDataUsedUnlimited") : L("adminOfLeft", { total: gb(quota), used: gb(usedBytes) }))}</span></div>
      <div class="admin-voucher__stat"><b>${h(v.status === "active" ? (hoursLeft >= 24 ? L("adminDays", { count: Math.floor(hoursLeft / 24) }) : L("adminHours", { count: Math.max(1, Math.floor(hoursLeft)) })) : L("adminEnded"))}</b><span>${h(v.status === "active" ? L("adminEndsOn", { date: when(v.expiresAt) }) : v.status === "exhausted" ? L("adminDataRanOut", { date: when(d.exhaustedAt || v.expiresAt) }) : L("adminValidityRanOut", { date: when(v.expiresAt) }))}</span></div>
      <div class="admin-voucher__stat"><b>${h(L("adminDevicesOf", { used: d.activeDevices || 0, limit: v.deviceLimit || 0 }))}</b><span>${h(L("adminDevicesConnected"))}</span></div>
    </div>${unlimited ? "" : `<div class="admin-voucher__bar" role="img" aria-label="${h(L("adminUsedOf", { used: gb(usedBytes), total: gb(quota) }))}"><i data-share="${share}"></i></div>`}</section>` : "";
  const daysLeft = waiting ? Math.max(0, Math.ceil((Date.parse(r.expiresAt) - Date.now()) / 864e5)) : 0;
  const reserved = waiting ? `<section class="nd-panel admin-voucher__panel admin-voucher__reserved" aria-labelledby="voucherReserved"><h2 class="admin-voucher__h2" id="voucherReserved">${h(L("adminReservedTitle"))}</h2>
    ${reservedPhone ? `<p class="admin-voucher__reserved-for"><strong>${h(reservedPhone)}</strong> · ${h(L("adminNoAccountYet"))}</p>` : ""}
    <div class="admin-voucher__stats"><div class="admin-voucher__stat"><b>${h(daysLeft === 1 ? L("adminOneDay") : L("adminDays", { count: daysLeft }))}</b><span>${h(L("adminLeftToClaim", { date: dateOnly(r.expiresAt) }))}</span></div>
      <div class="admin-voucher__stat"><b>${h(String(r.wrongAttempts || 0))}</b><span>${h(L("adminWrongClaims"))}</span></div>
      <div class="admin-voucher__stat"><b>${h(L("adminCodeAndNumber"))}</b><span>${h(L("adminBothNeeded"))}</span></div></div>
    <p class="admin-voucher__note">${h(L("adminAutoClaimNote"))}</p>
    <form class="admin-voucher__renumber" data-voucher-renumber hidden><div><label for="voucherNewPhone">${h(L("adminNewPhone"))}</label><input id="voucherNewPhone" name="phone" type="tel" inputmode="tel" autocomplete="off" required></div>
      <button type="submit" class="admin-voucher__go">${h(L("adminSaveNumber"))}</button></form>
    <p class="admin-voucher__saved" role="status" aria-live="polite">${notice ? h(notice) : ""}</p></section>` : "";
  const unused = v.status === "available" && !waiting ? `<section class="nd-panel admin-voucher__panel admin-voucher__unused"><span aria-hidden="true">!</span><p>${h(L("adminNotRedeemedYet", { duration: plan.validityHours ? duration(plan.validityHours) : L("adminBundle") }))}</p></section>` : "";
  const revokedEntry = (d.history || []).filter((e) => e.kind === "revoked").pop();
  const revoked = v.status === "revoked" ? `<p class="admin-voucher__revoked" role="status"><strong>${h(revokedEntry ? L("adminRevokedWhen", { when: when(revokedEntry.at), by: revokedEntry.by || L("adminStaff") }) : L("adminVoucherRevoked"))}</strong> ${h(L("adminRevokedNote"))}</p>` : "";
  const line = (e) => {
    const staff = e.by ? ` ${L("adminBy", { name: e.by })}` : "";
    if (e.kind === "created") return [L("adminCreated"), (e.online ? L("adminAfterPayment") : e.reservedFor ? L("adminCreatedFor", { phone: e.reservedFor }) : e.quantity > 1 ? L("adminInBatch", { count: e.quantity }) : "") + staff];
    if (e.kind === "claimed") return [L("adminClaimed"), L(e.how === "payment" ? "adminClaimedByPayment" : "adminClaimedByCode")];
    if (e.kind === "number_changed") return [L("adminNumberChangedEvent"), [e.to ? L("adminNumberTo", { phone: e.to }) : "", staff.trim()].filter(Boolean).join(" ")];
    if (e.kind === "classified") return [e.saleType === "gift" ? L("adminGift") : L("adminSold"), `— ${L(e.saleType === "gift" ? "adminGiftLine" : "adminSoldLine")}${staff}`];
    if (e.kind === "redeemed") return [L("adminRedeemed"), e.customer && customer.customerId ? { html: `${h(L("adminByPrefix"))} <a href="/dashboard#customer/${encodeURIComponent(customer.customerId)}">${h(e.customer)}</a>` } : ""];
    if (e.kind === "printed") return [L("adminPrinted"), staff.trim()];
    if (e.kind === "email_resent") return [L("adminEmailResent"), e.sent ? "" : L("adminEmailNotSent")];
    if (e.kind === "used_up") return [L("adminUsedUpEvent"), ""];
    if (e.kind === "expired") return [L("adminExpiredEvent"), ""];
    if (e.kind === "revoked") return [L("adminVoucherRevoked"), staff.trim()];
    return [e.kind, ""];
  };
  const timeline = (d.history || []).map((e) => {
    const [title, rest] = line(e), danger = e.kind === "revoked";
    return `<li><span class="admin-voucher__dot${danger ? " admin-voucher__dot--danger" : ""}"></span><strong${danger ? ' class="admin-voucher__danger"' : ""}>${h(title)}</strong> ${rest && rest.html ? rest.html : h(rest || "")}<br><span class="admin-voucher__when">${h(when(e.at))}</span></li>`;
  }).join("") + (waiting ? `<li><span class="admin-voucher__dot admin-voucher__dot--future"></span><span class="admin-voucher__future"><strong>${h(L("adminExpires"))}</strong> ${h(L("adminExpiresIfUnclaimed", { date: dateOnly(r.expiresAt, true) }))}</span></li>` : "") + (v.status === "active" ? `<li><span class="admin-voucher__dot admin-voucher__dot--future"></span><span class="admin-voucher__future"><strong>${h(L("adminEnds"))}</strong> ${h(unlimited ? when(v.expiresAt) : L("adminEndsOrData", { date: when(v.expiresAt) }))}</span></li>` : "");
  const sync = d.routerSync || {};
  const router = v.status === "available" ? L("adminRouterWaiting") : sync.status === "synchronized" ? L("adminRouterSynced", { when: when(sync.at || "") })
    : sync.commandStatus === "processed" && sync.action === "disconnect_voucher" ? L("adminRouterDisconnected") : sync.status === "failed" ? L("adminRouterFailed") : sync.status ? L("adminRouterPending") : "—";
  const email = !d.email ? null : d.email.status === "sent" ? L("adminEmailDelivered", { when: when(d.email.sentAt) }) : v.status === "available" ? L("adminEmailWhenRedeemed") : d.email.status ? L(`adminEmail_${d.email.status}`, {}) : "—";
  const details = `<section class="nd-panel admin-voucher__panel" aria-labelledby="voucherDetails"><h2 class="admin-voucher__h2" id="voucherDetails">${h(L("adminDetails"))}</h2><dl class="admin-voucher__kv">
    <dt>${h(L("adminColCustomer"))}</dt><dd>${waiting ? `${h(r.phone ? maskPhone(r.phone) : "—")} · <span class="admin-voucher__muted">${h(L("adminNoAccountShort"))}</span>` : customer.customerId ? `<a href="/dashboard#customer/${encodeURIComponent(customer.customerId)}">${h(customer.name || L("adminUnnamedCustomer"))}</a>${customer.accountPhone ? ` · ${h(maskPhone(customer.accountPhone))}` : ""}` : h(v.status === "available" ? L("adminNotRedeemedShort") : "—")}</dd>
    <dt>${h(L("adminType"))}</dt><dd>${h((data.payment && !kind ? [L("adminBoughtOnline"), `${Number(data.payment.amount).toLocaleString("en-CM")} FCFA`] : [kind ? L(kind === "gift" ? "adminGift" : "adminSold") : "", d.faceValue != null ? L("adminFaceValue", { amount: `${Number(d.faceValue).toLocaleString("en-CM")} FCFA` }) : ""]).filter(Boolean).join(" · ") || "—")}</dd>
    ${r ? `<dt>${h(L("adminReservedFor"))}</dt><dd>${h(L("adminGivenInPerson"))}</dd>` : `<dt>${h(L("adminBatch"))}</dt><dd>${h(created && created.quantity > 1 ? L("adminBatchOf", { count: created.quantity }) : L("adminSingleVoucher"))}</dd>`}
    <dt>${h(L("adminRouter"))}</dt><dd><span class="admin-voucher__ok">${h(router)}</span></dd>
    ${email === null ? "" : `<dt>${h(L("adminReceiptEmail"))}</dt><dd>${h(email)}</dd>`}</dl></section>`;
  const actions = canManage && v.status !== "revoked" ? `<section class="nd-panel admin-voucher__panel admin-voucher__actions" aria-labelledby="voucherActions"><h2 class="admin-voucher__h2" id="voucherActions">${h(L("adminActions"))}</h2>
    <div class="admin-voucher__buttons">${d.generatedByAdmin && !data.payment ? `<button type="button" class="admin-voucher__go" data-voucher-classify="${kind === "gift" ? "sold" : "gift"}">${h(L(kind === "gift" ? "adminMarkAsSold" : "adminMarkAsGift"))}</button>` : ""}
      ${waiting && r.phone ? `<button type="button" class="admin-voucher__go" data-voucher-change-number>${h(L("adminChangeNumber"))}</button>` : ""}
      ${data.payment && d.email ? `<button type="button" class="admin-voucher__go" data-voucher-resend>${h(L("adminResendReceipt"))}</button>` : ""}
      ${["active", "available", "suspended"].includes(v.status) ? `<button type="button" class="admin-voucher__go admin-voucher__go--danger" data-voucher-ask-revoke>${h(L("adminRevokeVoucher"))}</button>` : ""}</div>
    <div class="admin-voucher__confirm" role="alertdialog" aria-label="${h(L("adminConfirmRevoke"))}" hidden><span><strong>${h(L("adminRevokeCode", { code }))}</strong> ${h(v.status === "active" ? L("adminRevokeWarnActive", { name: customer.name || L("adminTheCustomer") }) : L("adminRevokeWarnUnused"))}</span>
      <button type="button" class="admin-voucher__go" data-voucher-keep>${h(L("adminKeepIt"))}</button><button type="button" class="admin-voucher__revoke" data-voucher-revoke>${h(L("adminRevoke"))}</button></div>
    <p class="admin-voucher__message" role="status" aria-live="polite"></p></section>` : "";
  const printable = code && ["active", "available"].includes(v.status);
  host.innerHTML = `<div class="admin-voucher">
    <div class="admin-voucher__left"><section class="admin-voucher__ticket${dim ? " admin-voucher__ticket--dim" : ""}" aria-label="${h(L("adminVoucher"))}">
      <div class="admin-voucher__top"><div class="admin-voucher__brand"><span class="admin-voucher__mark">NC</span><strong>NDAHI</strong>${kind ? `<span class="admin-voucher__kind">${h(L(kind === "gift" ? "adminGift" : "adminSold"))}</span>` : ""}</div>
        <p class="admin-voucher__plan">${h(plan.name || "—")}</p><p class="admin-voucher__facts">${h(facts)}</p></div>
      <div class="admin-voucher__tear" aria-hidden="true"></div>
      <div class="admin-voucher__bottom">${d.qr ? `<img class="admin-voucher__qr" src="${h(d.qr)}" alt="${h(L("adminQrFor", { code }))}">` : ""}${code ? `<p class="admin-voucher__code">${h(code)}</p>` : ""}<p class="admin-voucher__valid">${h(validLine)}</p></div></section>
      <div class="admin-voucher__ticket-actions">${printable ? `<button type="button" class="admin-voucher__go" data-voucher-print>${h(L("adminPrintSlip"))}</button>` : ""}${code ? `<button type="button" class="admin-voucher__go" data-voucher-copy>${h(L("adminCopyCode"))}</button>` : ""}</div>
      <div id="voucherDetailPrint" data-sensitive-output role="status" aria-live="polite"></div></div>
    <div class="admin-voucher__right">${revoked}${usage}${reserved}${unused}<section class="nd-panel admin-voucher__panel" aria-labelledby="voucherHistory"><h2 class="admin-voucher__h2" id="voucherHistory">${h(L("adminHistory"))}</h2><ol class="admin-voucher__timeline">${timeline}</ol></section>${details}${actions}</div></div>`;
  // CSP allows no inline style attributes: the data bar's width is set here.
  const bar = host.querySelector(".admin-voucher__bar i");
  if (bar) bar.style.width = `${Number(bar.dataset.share) || 0}%`;
  // Actions: the same endpoints v1 uses; the page reloads its data after each.
  const message = host.querySelector(".admin-voucher__message");
  const run = async (button, work) => {
    button.disabled = true;
    try { await work(); await showVoucherDetail(host, context); }
    catch (error) { if (message) message.textContent = error.message; }
    finally { button.disabled = false; }
  };
  const copy = async (button) => {
    try { await navigator.clipboard.writeText(code); } catch { /* The code stays visible on the ticket. */ }
    for (const each of document.querySelectorAll("[data-voucher-copy]")) each.textContent = L("adminCopied");
    button.focus();
  };
  document.querySelectorAll("[data-voucher-copy]").forEach((button) => { button.onclick = () => void copy(button); });
  host.querySelector("[data-voucher-print]")?.addEventListener("click", (event) => run(event.currentTarget, async () => {
    printPreview?.(host.querySelector("#voucherDetailPrint"), await call("/api/admin/vouchers/print", { method: "POST", body: JSON.stringify({ voucherId: id }) }));
  }));
  host.querySelector("[data-voucher-classify]")?.addEventListener("click", (event) => run(event.currentTarget, () =>
    call("/api/admin/vouchers/classify", { method: "POST", body: JSON.stringify({ voucherId: id, saleType: event.currentTarget.dataset.voucherClassify }) })));
  host.querySelector("[data-voucher-resend]")?.addEventListener("click", (event) => run(event.currentTarget, async () => {
    const result = await call("/api/admin/vouchers/resend-email", { method: "POST", body: JSON.stringify({ voucherId: id }) });
    if (!result.sent) throw Error(result.error || L("adminEmailNotSent"));
  }));
  // Change number (#254): the form opens in the reservation panel; after saving,
  // the page reloads and says what changed.
  const renumber = host.querySelector("[data-voucher-renumber]");
  host.querySelector("[data-voucher-change-number]")?.addEventListener("click", () => { renumber.hidden = false; renumber.elements.phone.focus(); });
  renumber?.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = renumber.querySelector("button"), next = renumber.elements.phone.value.trim();
    button.disabled = true;
    call("/api/admin/vouchers/reservation", { method: "POST", body: JSON.stringify({ voucherId: id, phone: next }) })
      .then((result) => showVoucherDetail(host, { ...context, notice: L("adminNumberChanged", { phone: maskPhone(result.voucher.reservation.phone) }) }))
      .catch((error) => { const saved = host.querySelector(".admin-voucher__saved"); if (saved) saved.textContent = error.message; button.disabled = false; });
  });
  const confirm = host.querySelector(".admin-voucher__confirm");
  host.querySelector("[data-voucher-ask-revoke]")?.addEventListener("click", () => { confirm.hidden = false; confirm.querySelector("[data-voucher-keep]").focus(); });
  host.querySelector("[data-voucher-keep]")?.addEventListener("click", () => { confirm.hidden = true; host.querySelector("[data-voucher-ask-revoke]").focus(); });
  host.querySelector("[data-voucher-revoke]")?.addEventListener("click", (event) => run(event.currentTarget, () =>
    call("/api/admin/vouchers/revoke", { method: "POST", body: JSON.stringify({ voucherId: id }) })));
}
