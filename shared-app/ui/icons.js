// Line icons from the design canvas (24 x 24, stroked). Icons are decorative
// by default (aria-hidden); pass `label` only when the icon is the sole content.
const SVG = "http://www.w3.org/2000/svg";

export const ICONS = {
  home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
  internet: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01",
  wifiOff: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01M3 3l18 18",
  shop: "M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7",
  activity: "M4 3h16v19l-4-2-4 2-4-2-4 2Zm4 5h8M8 12h8M8 16h5",
  account: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2",
  back: "M15 18 9 12l6-6",
  forward: "m9 18 6-6-6-6",
  check: "m5 12 5 5 9-10",
  close: "M6 6l12 12M18 6 6 18",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  voucher: "M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Zm12 0v14",
  passkey: "M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3V9h8.1A4 4 0 0 1 15 7Z",
  phone: "M5 2h14v20H5ZM10 18h4",
  phoneWait: "M5 2h14v20H5ZM10 18h4M12 7v4l2 2",
  device: "M7 2h10v20H7ZM11 18h2",
  laptop: "M4 5h16v11H4ZM2 19h20",
  qr: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h2v2h-2ZM18 18h2v2h-2ZM14 18h2M18 14h2",
  mail: "M3 5h18v14H3ZM3 6l9 7 9-7",
  location: "M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
};

export function icon(name, options) {
  const settings = options || {};
  const size = settings.size || 22;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(settings.strokeWidth || 1.8));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("focusable", "false");
  if (settings.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", settings.label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.appendChild(path);
  return svg;
}

// Static HTML can ask for an icon with <span data-nd-icon="back" data-nd-size="22"></span>.
export function renderIcons(root) {
  (root || document).querySelectorAll("[data-nd-icon]").forEach((slot) => {
    if (slot.firstChild) return;
    slot.appendChild(icon(slot.getAttribute("data-nd-icon"), {
      size: Number(slot.getAttribute("data-nd-size")) || undefined,
      strokeWidth: Number(slot.getAttribute("data-nd-stroke")) || undefined,
    }));
  });
}
