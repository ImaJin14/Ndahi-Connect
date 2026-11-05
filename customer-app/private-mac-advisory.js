import { sessionStore } from "./compat.js";

const DETECTED_MAC_KEY = "ndahi_detected_mac";
const DISMISSED_MAC_KEY = "ndahi_private_mac_dismissed";
const HINT_TTL_MS = 900000;

function h(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeMac(value) {
  const raw = typeof value === "string" ? value.trim().toUpperCase().replace(/-/g, ":") : "";
  return /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(raw) ? raw : "";
}

// IEEE 802 locally administered unicast MAC addresses have bit 1 (0x02) set
// and bit 0 (0x01) clear in the first octet, so the second hex digit is 2, 6, A, or E.
export function isRandomizedMac(value) {
  const mac = normalizeMac(value);
  return Boolean(mac && /^[0-9A-F][26AE](?::[0-9A-F]{2}){5}$/.test(mac));
}

export function detectClientPlatform(userAgent) {
  const ua = typeof userAgent === "string"
    ? userAgent
    : (typeof navigator === "object" && navigator && typeof navigator.userAgent === "string" ? navigator.userAgent : "");
  if (/iPhone|iPad|iPod|iOS/i.test(ua)) return "ios";
  if (/Macintosh|Mac OS X/i.test(ua) && typeof navigator === "object" && navigator && Number(navigator.maxTouchPoints) > 1) {
    return "ios";
  }
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export function currentCaptiveMac(search) {
  const rawSearch = typeof search === "string"
    ? search
    : (typeof location === "object" && location && typeof location.search === "string" ? location.search : "");
  const params = new URLSearchParams(rawSearch);
  const direct = normalizeMac(params.get("mac") || params.get("client_mac") || params.get("mac-address") || "");
  if (direct) {
    sessionStore.set(DETECTED_MAC_KEY, JSON.stringify({ mac: direct, at: Date.now() }));
    return direct;
  }
  for (const key of ["ndahi_wifi_hint", DETECTED_MAC_KEY]) {
    try {
      const saved = JSON.parse(sessionStore.get(key) || "null");
      if (saved && normalizeMac(saved.mac) && Number.isFinite(saved.at) && Date.now() - saved.at < HINT_TTL_MS) {
        return normalizeMac(saved.mac);
      }
    } catch (_) {}
  }
  return "";
}

export function isMacAdvisoryDismissed(mac) {
  const dismissed = sessionStore.get(DISMISSED_MAC_KEY);
  if (!dismissed) return false;
  const normalized = normalizeMac(mac);
  return dismissed === "1" || Boolean(normalized && dismissed === normalized);
}

export function dismissMacAdvisory(mac) {
  sessionStore.set(DISMISSED_MAC_KEY, normalizeMac(mac) || "1");
}

export function privateMacGuidance(mac, platform) {
  const normalized = normalizeMac(mac);
  const detectedPlatform = platform === "ios" || platform === "android" ? platform : "other";
  const ios = {
    id: "ios",
    label: "iOS (iPhone / iPad)",
    steps: 'Settings → Wi-Fi → NDAHI Connect → Turn off "Private Wi-Fi Address".',
    toggleLabel: "Private Wi-Fi Address",
    toggleState: "Off",
    recommended: detectedPlatform === "ios",
  };
  const android = {
    id: "android",
    label: "Android",
    steps: 'Settings → Network → NDAHI Connect → Privacy → "Use device MAC".',
    toggleLabel: "Privacy",
    toggleState: "Use device MAC",
    recommended: detectedPlatform === "android",
  };
  return {
    mac: normalized,
    macSuffix: normalized ? normalized.slice(-5) : "",
    platform: detectedPlatform,
    title: "Private Wi-Fi address detected",
    summary: "Randomized Wi-Fi addresses change how the hotspot sees your phone or tablet, which can use up device slots early or ask for repeated sign-in approvals.",
    platforms: detectedPlatform === "android" ? [android, ios] : [ios, android],
  };
}

export function mountPrivateMacAdvisory(options) {
  const opts = options || {};
  const container = opts.container !== undefined
    ? opts.container
    : (typeof document === "object" && document ? document.getElementById("privateMacAdvisory") : null);
  const mac = opts.mac !== undefined ? normalizeMac(opts.mac) : currentCaptiveMac(opts.search);
  if (!container) return { visible: false, mac };
  if (!isRandomizedMac(mac) || isMacAdvisoryDismissed(mac)) {
    container.hidden = true;
    container.innerHTML = "";
    return { visible: false, mac };
  }
  const info = privateMacGuidance(mac, opts.platform || detectClientPlatform(opts.userAgent));
  const cards = info.platforms.map((item) =>
    `<div class="private-mac-platform${item.recommended ? " private-mac-platform-active" : ""}" data-mac-platform="${h(item.id)}">` +
      `<div class="private-mac-platform-head"><strong>${h(item.label)}</strong>${item.recommended ? '<span class="private-mac-pill">This device</span>' : ""}</div>` +
      `<p class="private-mac-steps">${h(item.steps)}</p>` +
      `<div class="private-mac-toggle-hint" aria-label="${h(item.toggleLabel)}: ${h(item.toggleState)}">` +
        `<span class="private-mac-toggle-name">${h(item.toggleLabel)}</span>` +
        `<span class="private-mac-toggle-chip"><span class="private-mac-toggle-dot" aria-hidden="true"></span>${h(item.toggleState)}</span>` +
      `</div>` +
    `</div>`
  ).join("");
  container.innerHTML =
    `<div class="private-mac-head">` +
      `<div>` +
        `<p class="private-mac-eyebrow">Keep your connection slot</p>` +
        `<h2 class="private-mac-title">${h(info.title)} <span class="private-mac-code">(${h(info.mac)})</span></h2>` +
      `</div>` +
      `<button type="button" class="secondary-action private-mac-dismiss" data-dismiss-mac-advisory aria-label="Dismiss Private Wi-Fi Address advice">Got it — dismiss</button>` +
    `</div>` +
    `<p class="private-mac-summary">${h(info.summary)}</p>` +
    `<div class="private-mac-grid">${cards}</div>`;
  container.hidden = false;
  const dismissBtn = container.querySelector("[data-dismiss-mac-advisory]");
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      dismissMacAdvisory(info.mac);
      container.hidden = true;
      container.innerHTML = "";
    };
  }
  return { visible: true, mac: info.mac, platform: info.platform };
}
