import { formatDataBalance, dataWarning, formatExpiryCountdown, fuelStatusClass } from "/shared/data-usage.js";
import { runButton } from "/shared/pending.js";

let stopPrevious;
export function mountDataBalance({ call, voucher }) {
  stopPrevious?.();
  const host = document.getElementById("dataBalance"), message = document.getElementById("dataBalanceMessage"), button = document.getElementById("refreshDataBalance");
  if (!host || !message || !button || !voucher) return;
  let checking = false, timer;

  function updateGauge(v, remaining, percent) {
    const status = fuelStatusClass(remaining, v.quotaBytes);
    const fill = host.querySelector(".fuel-fill");
    if (fill) {
      const circumference = 301.59;
      const remainingPct = v.quotaBytes === null ? 100 : Math.max(0, 100 - percent);
      const offset = (circumference * (100 - remainingPct) / 100).toFixed(2);
      fill.style.strokeDashoffset = offset;
      fill.classList.remove("fuel-good", "fuel-warning", "fuel-danger", "fuel-unlimited");
      fill.classList.add(status);
    }
    const svg = host.querySelector(".fuel-gauge-svg");
    if (svg) {
      svg.setAttribute("aria-label", `${formatDataBalance(remaining)} remaining out of ${v.quotaBytes ? formatDataBalance(v.quotaBytes) : "unlimited"}`);
    }
  }

  function draw(v) {
    const remaining = v.quotaBytes === null ? null : Math.max(0, v.quotaBytes - v.usedBytes);
    const percent = v.quotaBytes ? Math.min(100, v.usedBytes / v.quotaBytes * 100) : 0;
    const level = dataWarning(v);

    host.querySelectorAll("[data-remaining-data]").forEach((el) => {
      el.textContent = formatDataBalance(remaining);
    });
    host.querySelectorAll("[data-used-data]").forEach((el) => {
      el.textContent = percent.toFixed(1) + "%";
    });

    const countdown = host.querySelector("[data-expiry-countdown]");
    if (countdown && v.expiresAt) {
      countdown.textContent = formatExpiryCountdown(v.expiresAt) || "Active";
    }

    const progress = host.querySelector("progress");
    if (progress) {
      progress.value = percent;
      progress.setAttribute("aria-label", percent.toFixed(1) + "% of bundle used");
    }

    updateGauge(v, remaining, percent);

    const age = Date.now() - Date.parse(v.lastUsageSyncAt), fresh = age >= -5000 && age <= 120000 && !(Date.parse(v.lastUsageSyncAt) < Date.parse(v.activatedAt));
    const warning = v.status === "expired" ? "This bundle's time has expired. Choose a plan to reconnect." : level === "100" ? "Your bundle's data is used up. Renew or choose another plan." :
      level === "low" ? "Low data: " + formatDataBalance(remaining) + " left. Renew before your data runs out." : level === "90" ? "You've used over 90% of your shared bundle. Plan a renewal before data runs out." : "";
    message.textContent = (fresh ? "" : "Last recorded balance; current router readings are unavailable or out of date. ") + warning;
    message.hidden = !message.textContent;
  }
  async function refresh() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const result = await call("/api/account/dashboard"), current = result.vouchers.find((v) => v.id === voucher.id);
      if (result.activeBundle && result.activeBundle.id !== voucher.id) { message.hidden = false; message.textContent = "Your bundle changed. Refresh the dashboard to see the new allocation."; return; }
      if (current) draw(current);
    } catch (_) { message.hidden = false; message.textContent = "Current balance could not be checked. The displayed balance may be out of date. Try Refresh balance again."; }
    finally { checking = false; }
  }
  draw(voucher);
  button.onclick = () => void runButton(button, "Checking…", refresh);
  const poll = () => { clearInterval(timer); timer = setInterval(() => { if (!["", "#home"].includes(location.hash)) return; void refresh(); }, 15000); };
  const visibility = () => { if (!document.hidden && ["", "#home"].includes(location.hash)) void refresh(); };
  document.addEventListener("visibilitychange", visibility); window.addEventListener("pageshow", poll); window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  stopPrevious = () => { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pageshow", poll); };
  poll();
}
