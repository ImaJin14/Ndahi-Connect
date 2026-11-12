// Open synchronously from a user gesture; no awaited network call can consume it.
export function openVoucherPrintPreview({
  voucherIds = [],
  widthMm = 58,
  layout,
  target = window,
} = {}) {
  const ids = [
    ...new Set(
      voucherIds.filter((id) => typeof id === "string" && id.length <= 100),
    ),
  ];
  if (!ids.length || ids.length > 100)
    throw Error("Choose 1–100 vouchers to print.");
  const fragment = new URLSearchParams({
    ids: JSON.stringify(ids),
    // "a6": voucher cards four to an A4 page (pages that offer it); else a thermal width.
    width: layout === "a6" ? "a6" : widthMm === 80 ? "80" : "58",
  });
  const url = "/voucher-print.html#" + fragment;
  const page = target.open(url, "_blank", "noopener");
  // noopener may return null even after opening. Always offer a same-tab link in UI.
  return { url, page };
}
