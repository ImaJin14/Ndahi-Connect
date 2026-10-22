import { escapeHtml as h } from "/shared/safe-html.js";

export function paymentClock(payment) {
  if (!["pending", "processing"].includes(payment.status) || !payment.paymentClosesAt) return "";
  return `<p class="payment-clock" data-payment-clock="${h(payment.id)}" data-approval="${h(payment.paymentExpiresAt || "")}" data-deadline="${h(payment.paymentClosesAt)}" data-server-time="${h(payment.serverTime || "")}">Checking payment deadline…</p>`;
}

export function ussdInstructions(phone = "") {
  const clean = String(phone || "").replace(/[^0-9]/g, "");
  const isMtn = /^237?6(7|8|5[0-4])/.test(clean) || /^6(7|8|5[0-4])/.test(clean);
  const isOrange = /^237?6(9|5[5-9])/.test(clean) || /^6(9|5[5-9])/.test(clean);
  return `<div class="ussd-waiting-card" role="region" aria-label="Mobile Money USSD instructions">
    <div class="ussd-waiting-header"><span class="ussd-pulse" aria-hidden="true"></span><strong>Approve prompt on your phone</strong></div>
    <p>A Mobile Money prompt was sent to your phone. If you missed it, dial to authorize manually:</p>
    <div class="ussd-codes">
      <div class="ussd-badge${isMtn ? " ussd-recommended" : ""}"><strong>MTN MoMo:</strong> <code>*126#</code>${isMtn ? " (Detected)" : ""}</div>
      <div class="ussd-badge${isOrange ? " ussd-recommended" : ""}"><strong>Orange Money:</strong> <code>*150#</code>${isOrange ? " (Detected)" : ""}</div>
    </div>
  </div>`;
}

// Monotonic elapsed time avoids changing the countdown when a device clock is wrong.
export function mountPaymentTimers({ onExpired = () => {} } = {}) {
  const observed = new WeakMap(), expired = new Set();
  const monotonic = () => performance.now();
  function tick() {
    if (document.hidden) return;
    document.querySelectorAll("[data-payment-clock]").forEach((element) => {
      let start = observed.get(element);
      if (!start) {
        start = { at: monotonic(), server: Date.parse(element.dataset.serverTime) || Date.now() };
        observed.set(element, start);
      }
      const now = start.server + monotonic() - start.at, deadline = Date.parse(element.dataset.deadline), approval = Date.parse(element.dataset.approval);
      if (!Number.isFinite(deadline)) { element.textContent = "Recheck this payment for its current status."; return; }
      const grace = now >= approval, seconds = Math.max(0, Math.ceil(((grace ? deadline : approval) - now) / 1000));
      element.textContent = now >= deadline ? "Payment window ended. Checking the recorded result…"
        : `${grace ? "Checking confirmation" : "Approve payment within"}: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      if (now >= deadline && !expired.has(element.dataset.paymentClock)) {
        expired.add(element.dataset.paymentClock);
        Promise.resolve(onExpired(element.dataset.paymentClock)).catch(() => { expired.delete(element.dataset.paymentClock); });
      }
    });
  }
  const interval = setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  tick();
  return () => { clearInterval(interval); document.removeEventListener("visibilitychange", tick); };
}
