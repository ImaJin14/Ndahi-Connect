import { formatDataBalance, dataWarning } from "/shared/data-usage.js";
import { runButton } from "/shared/pending.js";

let stopPrevious;
export function mountDataBalance({ call, voucher }) {
  stopPrevious?.();
  const host = document.getElementById("dataBalance"), message = document.getElementById("dataBalanceMessage"), button = document.getElementById("refreshDataBalance");
  if (!host || !message || !button || !voucher) return;
  let checking = false, timer;
  function draw(v) {
    const remaining = Math.max(0, v.quotaBytes - v.usedBytes), percent = Math.min(100, v.usedBytes / v.quotaBytes * 100), level = dataWarning(v);
    host.querySelector("[data-remaining-data]").textContent = formatDataBalance(remaining);
    host.querySelector("[data-used-data]").textContent = percent.toFixed(1) + "%";
    const progress = host.querySelector("progress"); progress.value = percent; progress.setAttribute("aria-label", percent.toFixed(1) + "% of bundle used");
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
