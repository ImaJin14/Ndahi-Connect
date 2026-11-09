const api = window.NDAHI_CONFIG.apiUrl,
  admin = window.NDAHI_CONFIG.app === "admin";
const root = admin ? "/api/admin" : "/api/account",
  message = document.querySelector("#printMessage"),
  surface = document.querySelector("#printSurface");
const print = document.querySelector("#printNow"),
  download = document.querySelector("#downloadPdf"),
  width = document.querySelector("#paperWidth");
let csrf = "",
  ids = [],
  ready = false,
  sequence = 0;
const params = new URLSearchParams(location.hash.slice(1));
try {
  ids = JSON.parse(params.get("ids") || "[]");
} catch {
  ids = [];
}
width.value = params.get("width") === "80" ? "80" : "58";
history.replaceState(null, "", location.pathname);
window.opener = null;
async function call(path, input) {
  const response = await fetch(api + root + path, {
    credentials: "include",
    cache: "no-store",
    ...(input
      ? {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify(input),
        }
      : {}),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw Error(
      value.error || "Sign in again, then reopen this voucher preview.",
    );
  }
  return response;
}
async function render() {
  const current = ++sequence;
  ready = false;
  print.disabled = true;
  download.disabled = true;
  surface.replaceChildren();
  message.textContent = "Preparing voucher slips…";
  try {
    if (!csrf) csrf = (await (await call("/dashboard")).json()).csrfToken || "";
    const result = await (
      await call("/vouchers/print-preview", {
        voucherIds: ids,
        widthMm: Number(width.value),
      })
    ).json();
    if (current !== sequence) return;
    surface.className =
      "voucher-print-sheet voucher-print-thermal voucher-print-thermal-" +
      width.value;
    document.body.dataset.voucherPrintLayout = "thermal-" + width.value;
    surface.innerHTML = result.html;
    await Promise.all(
      [...surface.querySelectorAll("img")].map((img) => img.decode()),
    );
    await document.fonts.ready;
    if (current !== sequence) return;
    ready = true;
    print.disabled = false;
    download.disabled = false;
    message.textContent = `${result.count} voucher slip${result.count === 1 ? "" : "s"} ready. Choose Print to select your printer.`;
  } catch (error) {
    if (current === sequence) message.textContent = error.message;
  }
}
width.onchange = render;
print.onclick = () => {
  if (ready) {
    message.textContent =
      "If the printer picker does not appear, use your browser’s Share → Print or Download PDF.";
    window.print();
  }
};
download.onclick = async () => {
  if (!ready) return;
  download.disabled = true;
  try {
    const response = await call("/vouchers/print-pdf", {
      voucherIds: ids,
      widthMm: Number(width.value),
    });
    const blob = await response.blob();
    if (
      !(response.headers.get("content-type") || "").startsWith(
        "application/pdf",
      ) ||
      (await blob.slice(0, 5).text()) !== "%PDF-"
    )
      throw Error("The PDF is unavailable. Try again.");
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "ndahi-voucher-slips.pdf";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    message.textContent =
      "PDF offered to your browser. Open it to print or save; this page cannot confirm it was saved.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    download.disabled = false;
  }
};
if (ids.length && ids.length <= 100) render();
else
  message.textContent =
    "Reopen Print voucher from your signed-in account. No voucher was selected.";

// Recheck authorization after browser back/forward restoration; do not retain a private slip in a frozen page.
window.addEventListener("pagehide", () => {
  ready = false;
  surface.replaceChildren();
  print.disabled = true;
  download.disabled = true;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && ids.length) render();
});
