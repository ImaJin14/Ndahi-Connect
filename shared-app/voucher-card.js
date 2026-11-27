// The printed voucher slip's words, as drawn (canvas: VoucherSlip, #368; owner
// 26 Nov): the colour card shown on screen and in the slip PDF. Thermal
// printing keeps its own layout (admin-app-v2/voucher-slip.js). One model for
// both, so the screen and the PDF always say the same thing. `t(key, values)`
// gives the admin's language. Terms come from the voucher's own snapshot.
const hoursText = (t, hours) => {
  const n = Number(hours) || 0;
  return n >= 48 && n % 24 === 0 ? t("adminSlipDays", { count: n / 24 }) : t("adminSlipHours", { count: n });
};
const devicesText = (t, count) => (Number(count) === 1 ? t("adminSlipDevice") : t("adminSlipDevices", { count }));

// "Unlimited · 7 days · 2 devices", "Home WISP Unlimited · 30 days", or a
// data-capped bundle's "5 GB · 7 days · 1 device".
export function voucherCardTerms(v = {}, plan = {}, t) {
  const hours = v.validityHours ?? plan.validityHours, time = hours ? hoursText(t, hours) : "";
  if (v.accessType === "home_wisp_unlimited") return [t("adminSlipHomeWisp"), time].filter(Boolean).join(" · ");
  const unlimited = v.accessType === "personal_unlimited" || v.quotaBytes === null || plan.quotaGb === null;
  const data = unlimited ? t("adminSlipUnlimited") : plan.quotaGb != null ? `${plan.quotaGb} GB` : `${Math.round((Number(v.quotaBytes) || 0) / 1e8) / 10} GB`;
  return [data, time, devicesText(t, v.deviceSlots ?? v.deviceLimit ?? plan.deviceLimit ?? 1)].filter(Boolean).join(" · ");
}

export function voucherCardModel(v = {}, plan = {}, t, { lang = "en" } = {}) {
  const price = Number(v.faceValue ?? plan.price ?? 0);
  const date = Number.isFinite(Date.parse(v.useBy))
    ? new Date(v.useBy).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Douala" }) : "";
  return {
    brand: t("adminSlipBrand"), kind: t("adminSlipKind"),
    price: `${(Number.isFinite(price) ? price : 0).toLocaleString("en-US")} FCFA`,
    plan: v.plan?.name || plan.name || "", terms: voucherCardTerms(v, plan, t),
    // The code without "NC-", as drawn (owner, 26 Nov); typed either way it works.
    codeLabel: t("adminSlipCode"), code: String(v.code || "").replace(/^NC-/, ""), qr: v.qrCode || "", qrLabel: t("adminSlipQr", { code: String(v.code || "").replace(/^NC-/, "") }),
    // Each step with its bold part: "Join the Wi-Fi network **NDAHI**".
    steps: [["adminSlipStep1", { network: t("adminSlipNetwork") }, "network"], ["adminSlipStep2", { button: t("adminSlipButton") }, "button"], ["adminSlipStep3", {}, null]]
      .map(([key, values, bold]) => {
        const text = t(key, values), strong = bold ? values[bold] : "", at = strong ? text.lastIndexOf(strong) : -1;
        return at < 0 ? { before: text, strong: "", after: "" } : { before: text.slice(0, at), strong, after: text.slice(at + strong.length) };
      }),
    // A code made before the use-by rule has no date (owner, 26 Nov).
    use: date ? t("adminSlipUseBefore", { date }) : t("adminSlipSingleUse"),
    batch: v.batchReference ? [t("adminSlipBatch", { batch: v.batchReference }), v.resellerName].filter(Boolean).join(" · ") : "",
  };
}
