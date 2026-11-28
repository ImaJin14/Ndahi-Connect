// Rewards (#530, canvas: AdminRewards) at #rewards, owners only (the API
// checks too). The figures; the Points and Referrals settings, each with its
// switch; the bundles customers can redeem (points price and Redeemable switch);
// Save rewards settings (one save for all of it, audited, and it never rewrites
// the ledger); referrals held for review with Approve / Reject; recent activity.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const fr = () => currentLanguage() === "fr";
const num = (n) => Number(n || 0).toLocaleString(fr() ? "fr-FR" : "en-US").replace(/[   ]/g, " ");
const MONTHS = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] };
const day = (at) => { const d = new Date(at); return `${d.getDate()} ${MONTHS[fr() ? "fr" : "en"][d.getMonth()]}`; };
const HOME = "home_wisp_unlimited";
const length = (hours) => (hours >= 48 && hours % 24 === 0 ? L("arDayCount", { count: hours / 24 }) : L("arHours", { count: hours }));
const devices = (n) => (n === 1 ? L("arDevice") : L("arDevices", { count: n }));
// "24 hours · 1 device"; Home WISP: "30 days".
const terms = (b) => [length(b.validityHours), b.accessType === HOME ? null : devices(b.deviceSlots || 1)].filter(Boolean).join(" · ");
const signed = (n) => (n > 0 ? `+${num(n)}` : `−${num(-n)}`);
// "Amina N.", as drawn; an account without a name shows its masked number.
const who = (c) => {
  const parts = String(c?.name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length || c.name === "Customer") return c?.phone || "";
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0];
};
const switchButton = (id, on, label) => `<button type="button" role="switch" class="admin-rewards__switch" id="${id}" aria-checked="${on}" aria-label="${h(label)}"><span></span></button>`;

function activityRow(r, months) {
  if (r.system) return [L("arSystem"), L(r.customers === 1 ? "arExpiredOne" : "arExpired", { months, count: num(r.customers) })];
  const bundle = r.bundle ? `${r.bundle.name} ${terms(r.bundle)}` : "";
  const what = r.kind === "earned" ? L("arEarned", { bundle }) : r.kind === "referral" ? L("arReferral", { friend: r.friend || "" })
    : r.kind === "welcome" ? L("arWelcome", { code: r.invitedBy?.code || "" }) : r.kind === "redeemed" ? L("arRedeemed", { bundle })
    : r.kind === "refunded" ? L("arRefund") : r.kind === "expired" ? L("arExpiredOne", { months }) : L("arAdjusted", { reason: r.reason || "" });
  return [who(r.customer), what];
}

// Held referrals, grouped by code and reason: "KOFI-3QP → 6•• •• 12 77, 6•• •• 12 78, +5".
function groups(review) {
  const map = new Map();
  for (const r of review) {
    const key = `${r.code}|${[...r.reasons].sort().join(",")}`;
    if (!map.has(key)) map.set(key, { key, code: r.code, reasons: r.reasons, items: [] });
    map.get(key).items.push(r);
  }
  return [...map.values()].map((g) => {
    const phones = g.items.map((r) => r.friend.phone), shown = phones.slice(0, 2).join(", ") + (phones.length > 2 ? `, +${phones.length - 2}` : "");
    const n = g.items.length, has = (x) => g.reasons.includes(x);
    const one = n === 1 ? "One" : "";
    const why = has("same_device") ? L("arSameDevice") : has("burst") && has("same_payer") ? L("arBurstPayer" + one, { count: n })
      : has("burst") ? L("arBurst" + one, { count: n }) : L("arSamePayer" + one, { count: n });
    return { ...g, who: `${g.code} → ${shown}`, why };
  });
}

export async function showRewards(host, { call }) {
  if (!host) return;
  // The cards to review stay in place once decided (with their result) until the page is opened again.
  const state = { data: null, cards: [], error: "" };
  const saved = document.getElementById("rewardsSaved");
  const render = () => {
    const d = state.data;
    if (!d) { host.innerHTML = state.error ? `<p class="admin-rewards__error" role="alert">${h(state.error)}</p>` : ""; return; }
    const p = d.settings.points, r = d.settings.referrals, m = d.metrics, months = p.expiryMonths;
    const option = (values, current, word) => values.map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${h(L(word, { count: v }))}</option>`).join("");
    const review = state.cards;
    host.innerHTML = `<div class="admin-rewards">
  <div class="admin-rewards__metrics">
    <div class="admin-rewards__metric"><strong>${h(num(m.outstandingPoints))}</strong><span>${h(L("arOutstanding", { xaf: num(m.outstandingXaf) }))}</span></div>
    <div class="admin-rewards__metric"><strong>${h(num(m.redeemedThisMonth.points))}</strong><span>${h(L(m.redeemedThisMonth.bundles === 1 ? "arRedeemedMonthOne" : "arRedeemedMonth", { count: num(m.redeemedThisMonth.bundles) }))}</span></div>
    <div class="admin-rewards__metric"><strong>${h(num(m.friendsThisMonth.count))}</strong><span>${h(L("arFriendsMonth", { points: num(m.friendsThisMonth.points) }))}</span></div>
    <div class="admin-rewards__metric"><strong>${h(num(groups(d.review).length))}</strong><span>${h(L("arFlagged"))}</span></div>
  </div>
  <div class="admin-rewards__row">
    <section class="admin-rewards__panel admin-rewards__panel--half" aria-labelledby="rewardsPointsTitle">
      <div class="admin-rewards__panel-head"><h2 class="admin-rewards__h2" id="rewardsPointsTitle">${h(L("arPoints"))}</h2>${switchButton("rewardsPointsOn", p.enabled, L("arPointsSwitch"))}</div>
      <div class="admin-rewards__grid">
        <div><label class="admin-rewards__lbl" for="rewardsXafPerPoint">${h(L("arXafPerPoint"))}</label><input class="admin-rewards__in" id="rewardsXafPerPoint" inputmode="numeric" value="${h(p.xafPerPoint)}"><p class="admin-rewards__hint">${h(L("arXafPerPointHint"))}</p></div>
        <div><label class="admin-rewards__lbl" for="rewardsPointValue">${h(L("arPointValue"))}</label><input class="admin-rewards__in" id="rewardsPointValue" inputmode="numeric" value="${h(p.pointValueXaf)}"><p class="admin-rewards__hint">${h(L("arPointValueHint", { value: num(p.pointValueXaf) }))}</p></div>
        <div><label class="admin-rewards__lbl" for="rewardsExpiry">${h(L("arExpire"))}</label><select class="admin-rewards__in" id="rewardsExpiry">${option([6, 12, 24], p.expiryMonths, "arMonths")}</select></div>
        <div><label class="admin-rewards__lbl" for="rewardsStartWithin">${h(L("arStartWithin"))}</label><select class="admin-rewards__in" id="rewardsStartWithin">${option([30, 60, 90], p.startWithinDays, "arDays")}</select></div>
      </div>
      <p class="admin-rewards__hint admin-rewards__note">${h(L("arPointsNote"))}</p>
    </section>
    <section class="admin-rewards__panel admin-rewards__panel--half" aria-labelledby="rewardsReferralsTitle">
      <div class="admin-rewards__panel-head"><h2 class="admin-rewards__h2" id="rewardsReferralsTitle">${h(L("arReferrals"))}</h2>${switchButton("rewardsReferralsOn", r.enabled, L("arReferralsSwitch"))}</div>
      <div class="admin-rewards__grid">
        <div><label class="admin-rewards__lbl" for="rewardsReferrer">${h(L("arReferrerPoints"))}</label><input class="admin-rewards__in" id="rewardsReferrer" inputmode="numeric" value="${h(r.referrerPoints)}"></div>
        <div><label class="admin-rewards__lbl" for="rewardsWelcome">${h(L("arWelcomePoints"))}</label><input class="admin-rewards__in" id="rewardsWelcome" inputmode="numeric" value="${h(r.welcomePoints)}"></div>
        <div><label class="admin-rewards__lbl" for="rewardsCap">${h(L("arCap"))}</label><input class="admin-rewards__in" id="rewardsCap" inputmode="numeric" value="${h(r.monthlyCap)}"></div>
        <div><label class="admin-rewards__lbl" for="rewardsMinFirst">${h(L("arMinFirst"))}</label><input class="admin-rewards__in" id="rewardsMinFirst" inputmode="numeric" value="${h(r.minFirstBundleXaf)}"></div>
      </div>
      <p class="admin-rewards__hint admin-rewards__note">${h(L("arReferralsNote"))}</p>
    </section>
  </div>
  <section class="admin-rewards__panel" aria-labelledby="rewardsBundlesTitle">
    <div><h2 class="admin-rewards__h2" id="rewardsBundlesTitle">${h(L("arBundles"))}</h2><p class="admin-rewards__sub">${h(L("arBundlesSub"))}</p></div>
    <div class="admin-rewards__scroll"><table class="admin-rewards__table">
      <thead><tr><th scope="col">${h(L("arColBundle"))}</th><th scope="col">${h(L("arColPrice"))}</th><th scope="col">${h(L("arColPoints"))}</th><th scope="col">${h(L("arColRedeemed"))}</th><th scope="col">${h(L("arColRedeemable"))}</th></tr></thead>
      <tbody>${d.offers.map((o) => `<tr data-offer="${h(o.id)}"><td><strong>${h(o.name)}</strong><br><span class="admin-rewards__terms">${h(terms(o))}</span></td><td>${h(num(o.price))}</td><td><input class="admin-rewards__in admin-rewards__pts" aria-label="${h(L("arPointsFor", { name: o.name, terms: terms(o) }))}" inputmode="numeric" value="${h(o.points)}"></td><td>${o.redeemed30d ? h(num(o.redeemed30d)) : "—"}</td><td>${switchButton(`rewardsOffer-${h(o.id)}`, o.redeemable, L("arRedeemableFor", { name: o.name, terms: terms(o) }))}</td></tr>`).join("")}</tbody>
    </table></div>
    ${state.error ? `<p class="admin-rewards__error" role="alert">${h(state.error)}</p>` : ""}
    <div><button type="button" class="admin-rewards__save" id="rewardsSave">${h(L("arSave"))}</button></div>
  </section>
  <div class="admin-rewards__row">
    <section class="admin-rewards__panel admin-rewards__panel--wide" aria-labelledby="rewardsReviewTitle">
      <div><h2 class="admin-rewards__h2" id="rewardsReviewTitle">${h(L("arReview"))}</h2><p class="admin-rewards__sub">${h(L("arReviewSub"))}</p></div>
      ${review.map((g) => `<div class="admin-rewards__flag${g.result ? " is-closed" : ""}" data-flag="${h(g.key)}"><span class="admin-rewards__flag-text"><strong>${h(g.who)}</strong><span>${h(g.why)}</span></span>${g.result
        ? `<span class="admin-rewards__pill admin-rewards__pill--${g.result}">${h(L(g.result === "ok" ? "arApproved" : "arRejected"))}</span>`
        : `<span class="admin-rewards__flag-actions"><button type="button" class="admin-rewards__go2" data-decide="approve">${h(L("arApprove"))}</button><button type="button" class="admin-rewards__go2 admin-rewards__go2--no" data-decide="reject">${h(L("arReject"))}</button></span>`}</div>`).join("")}
    </section>
    <section class="admin-rewards__panel admin-rewards__panel--wide" aria-labelledby="rewardsActivityTitle">
      <div class="admin-rewards__activity-head"><h2 class="admin-rewards__h2" id="rewardsActivityTitle">${h(L("arActivity"))}</h2><a href="/dashboard#audit">${h(L("arFullLedger"))}</a></div>
      <table class="admin-rewards__table admin-rewards__ledger"><tbody>${d.activity.map((a) => { const [name, what] = activityRow(a, months);
        return `<tr><td><strong>${h(name)}</strong><br><span>${h(what)}</span></td><td><strong class="${a.points < 0 ? "is-minus" : "is-plus"}">${h(signed(a.points))}</strong><br><span>${h(day(a.at))}</span></td></tr>`; }).join("")}</tbody></table>
    </section>
  </div>
</div>`;
  };
  const flip = (button) => { button.setAttribute("aria-checked", String(button.getAttribute("aria-checked") !== "true")); if (saved) saved.textContent = ""; };
  host.onclick = async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.getAttribute("role") === "switch") { flip(button); return; }
    if (button.id === "rewardsSave") {
      const value = (id) => Number(host.querySelector(`#${id}`).value.trim());
      const on = (id) => host.querySelector(`#${id}`).getAttribute("aria-checked") === "true";
      button.disabled = true;
      try {
        state.data = await call("/api/admin/rewards/settings", { method: "POST", body: JSON.stringify({
          points: { enabled: on("rewardsPointsOn"), xafPerPoint: value("rewardsXafPerPoint"), pointValueXaf: value("rewardsPointValue"), expiryMonths: value("rewardsExpiry"), startWithinDays: value("rewardsStartWithin") },
          referrals: { enabled: on("rewardsReferralsOn"), referrerPoints: value("rewardsReferrer"), welcomePoints: value("rewardsWelcome"), monthlyCap: value("rewardsCap"), minFirstBundleXaf: value("rewardsMinFirst") },
          offers: [...host.querySelectorAll("tr[data-offer]")].map((row) => ({ bundleId: row.dataset.offer, points: Number(row.querySelector(".admin-rewards__pts").value.trim()),
            redeemable: row.querySelector("[role=switch]").getAttribute("aria-checked") === "true" })),
        }) });
        state.error = "";
        render();
        if (saved) saved.textContent = L("arSaved");
      } catch (error) { state.error = error.message || L("arFailed"); render(); }
      return;
    }
    if (button.dataset.decide) {
      const row = button.closest("[data-flag]"), group = state.cards.find((g) => g.key === row.dataset.flag && !g.result);
      if (!group) return;
      row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        let latest;
        const path = (id) => (button.dataset.decide === "approve" ? `/api/admin/rewards/referrals/${encodeURIComponent(id)}/approve` : `/api/admin/rewards/referrals/${encodeURIComponent(id)}/reject`);
        for (const item of group.items) latest = await call(path(item.id), { method: "POST", body: "{}" });
        group.result = button.dataset.decide === "approve" ? "ok" : "no";
        state.data = latest.rewards;
        state.error = "";
      } catch (error) { state.error = error.message || L("arFailed"); }
      render();
    }
  };
  try { state.data = await call("/api/admin/rewards"); state.cards = groups(state.data.review); }
  catch (error) { state.error = error.message || L("arFailed"); }
  render();
}
