// A bundle's speed limit in words (#263; owner, 21 Nov: "a bundle with rate
// limit of 2mbps should clearly state it in the bundle description").
// "Up to 2 Mbps download, 1 Mbps upload". One limit covers all of a bundle's
// devices, so a bundle for more than one says it is shared. A bundle without a
// limit says nothing: never "unlimited speed".
// Takes a plan ({ downloadMbps, uploadMbps }) or a voucher's speedSnapshot,
// which is what the router applies to that voucher.
const WORDS = {
  en: { both: "Up to {down} Mbps download, {up} Mbps upload", down: "Up to {down} Mbps download", up: "Up to {up} Mbps upload",
    shared: "{speed}, shared by all devices" },
  fr: { both: "Jusqu’à {down} Mbit/s en téléchargement, {up} Mbit/s en envoi", down: "Jusqu’à {down} Mbit/s en téléchargement",
    up: "Jusqu’à {up} Mbit/s en envoi", shared: "{speed}, partagés entre tous les appareils" },
};
const limit = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

export function speedLimits(speeds) {
  return { down: limit(speeds?.downloadMbps), up: limit(speeds?.uploadMbps) };
}

export function hasSpeedLimit(speeds) {
  const { down, up } = speedLimits(speeds);
  return down !== null || up !== null;
}

export function speedText(speeds, { lang = "en", devices = 1 } = {}) {
  const { down, up } = speedLimits(speeds), words = WORDS[lang] || WORDS.en;
  if (down === null && up === null) return "";
  const number = (n) => new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-GB", { maximumFractionDigits: 3 }).format(n);
  const speed = (down !== null && up !== null ? words.both : down !== null ? words.down : words.up)
    .replace("{down}", down === null ? "" : number(down)).replace("{up}", up === null ? "" : number(up));
  return Number(devices) > 1 ? words.shared.replace("{speed}", speed) : speed;
}
