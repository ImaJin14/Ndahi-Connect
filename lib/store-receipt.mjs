import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./brand.mjs";
const requirePaid = (order) => {
  if (!order?.payment?.confirmedAt)
    throw Object.assign(
      Error("A receipt is available only after verified payment."),
      { status: 409 },
    );
};
export function storeReceipt(order) {
  requirePaid(order);
  if (order.receipt) return structuredClone(order.receipt);
  return {
    version: 1,
    number: `NSR-${order.id.toUpperCase()}`,
    orderId: order.id,
    orderReference: order.reference,
    paidAt: order.payment.confirmedAt,
    currency: "XAF",
    amount: order.payment.amount,
    seller: structuredClone(
      order.seller || { name: "NDAHI Store", contact: "" },
    ),
    buyerName: order.payment.customerName || order.contact.name,
    item: {
      name: structuredClone(order.product.name),
      sku: order.product.sku,
      unitPrice: order.product.price,
      quantity: order.quantity,
    },
    provider: order.payment.provider,
    providerReference: order.payment.providerReference,
    payerPhone: order.payment.payerPhone,
    pickup: order.pickup,
    hours: order.hours,
    warranty: structuredClone(order.product.warranty),
    returns: structuredClone(order.returns),
  };
}
export const storeReceiptFilename = (receipt) =>
  `ndahi-store-receipt-${receipt.orderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
export function storeOrderEmail(order) {
  const titles = {
    awaiting_payment: "Order received — payment pending",
    preparing: "Payment confirmed — preparing your order",
    ready: "Your order is ready for pickup",
    collected: "Your order has been collected",
    review: "Payment received — your order needs review",
    cancelled:
      order.payment.status === "refunded"
        ? "Your store refund is confirmed"
        : "Your order was cancelled",
    expired: "Your payment reservation expired",
  };
  let title = titles[order.status] || "Your store order update";
  if (
    ["requested", "pending", "uncertain"].includes(order.payment.refund?.status)
  )
    title = "Your store refund is being processed";
  if (order.payment.refund?.status === "failed")
    title = "Your store refund needs support review";
  const lines = [
    `Hello ${order.contact.name},`,
    title,
    `Order: ${order.reference}`,
    `${order.product.name.en} — ${order.product.sku} × ${order.quantity}`,
    `Order total: ${order.payment.amount.toLocaleString()} FCFA`,
    order.payment.confirmedAt
      ? `Payment confirmed: ${order.payment.confirmedAt}`
      : "Payment is not confirmed. This message is not a payment receipt.",
    order.payment.refund
      ? `Refund status: ${order.payment.refund.status}.${order.payment.refund.status === "completed" ? " Your refund is confirmed." : " A pending request is not a completed refund."}`
      : "",
    order.status === "review"
      ? "Do not pay again. Contact the store while we check your payment and available stock."
      : "",
    `Pickup: ${order.pickup}`,
    order.hours,
    order.status === "ready" && order.payment.status === "paid"
      ? `Collection code: ${order.collectionCode}. Share it only at pickup.`
      : "",
    order.payment.confirmedAt
      ? `Your original payment receipt ${storeReceipt(order).number} is attached. It records the original payment; see the order status for fulfilment and refunds.`
      : "",
    order.seller?.contact ? `Store support: ${order.seller.contact}` : "",
    "Keep the private tracking link saved at checkout. Do not post it publicly. Hardware purchases do not include internet service unless the offer expressly says so.",
  ].filter(Boolean);
  return {
    subject: `NDAHI Store — ${title} — ${order.reference}`,
    text: lines.join("\n"),
    html: `<h2>${escapeHtml(title)}</h2>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}`,
  };
}
export async function storeReceiptPdf(order) {
  const r = storeReceipt(order);
  const fonts = {
    regular: fileURLToPath(
      new URL("./assets/fonts/DejaVuSans.ttf", import.meta.url),
    ),
    bold: fileURLToPath(
      new URL("./assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
    ),
  };
  const doc = new PDFDocument({
    size: "A4",
    margin: 42,
    info: {
      Title: `NDAHI Store receipt ${r.number}`,
      Author: "NDAHI Store",
      CreationDate: new Date(r.paidAt),
      ModDate: new Date(r.paidAt),
    },
  });
  const chunks = [],
    result = new Promise((resolve, reject) => {
      doc.on("data", (data) => chunks.push(data));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  try {
    doc.registerFont("Store-Regular", fonts.regular);
    doc.registerFont("Store-Bold", fonts.bold);
    doc.rect(0, 0, doc.page.width, 110).fill("#003b2b");
    doc.circle(66, 51, 25).lineWidth(2).stroke("#b9ee2e");
    doc
      .font("Store-Bold")
      .fontSize(20)
      .fillColor("#b9ee2e")
      .text("NS", 44, 39, { width: 44, align: "center" });
    doc.fontSize(22).fillColor("#fff").text("NDAHI STORE", 108, 30);
    doc
      .font("Store-Regular")
      .fontSize(11)
      .text("Equipment purchase receipt / Reçu d’achat", 108, 64);
    let y = 135;
    const row = (label, value, bold = false) => {
      const text = String(value || "—");
      doc.font(bold ? "Store-Bold" : "Store-Regular").fontSize(10);
      const height = Math.max(
        20,
        doc.heightOfString(text, { width: 320 }) + 14,
      );
      if (y + height > 750) {
        doc.addPage();
        y = 42;
      }
      doc.fillColor("#53645c").text(label, 42, y, { width: 140 });
      doc.fillColor("#003b2b").text(text, 195, y, { width: 320 });
      y = Math.max(y + height, doc.y + 10);
    };
    row("Receipt number", r.number);
    row("Order reference", r.orderReference);
    row("Store", r.seller.name || "NDAHI Store");
    if (r.seller.contact) row("Store contact", r.seller.contact);
    row("Customer", r.buyerName);
    row("Payment confirmed", new Date(r.paidAt).toISOString());
    row(
      "Equipment",
      `${r.item.name.en}${r.item.name.fr && r.item.name.fr !== r.item.name.en ? " / " + r.item.name.fr : ""}`,
    );
    row("SKU / model", r.item.sku);
    row("Quantity", r.item.quantity);
    row("Unit price", `${r.item.unitPrice.toLocaleString()} FCFA`);
    row("Total paid", `${r.amount.toLocaleString()} FCFA`, true);
    row("Payment provider", r.provider);
    row("Provider reference", r.providerReference);
    row("Payment number", r.payerPhone);
    row("Pickup", r.pickup);
    row("Pickup hours", r.hours);
    row(
      "Current payment",
      order.payment.status === "refunded"
        ? "REFUNDED — this is the original payment receipt, not an outstanding balance."
        : order.payment.refund
          ? `Original payment confirmed; refund ${order.payment.refund.status}.`
          : "Payment confirmed. This does not confirm collection.",
    );
    row(
      "Warranty",
      [r.warranty?.en, r.warranty?.fr].filter(Boolean).join("\n"),
    );
    row("Returns", [r.returns?.en, r.returns?.fr].filter(Boolean).join("\n"));
    row(
      "Important",
      "Equipment purchase only. Internet is separate unless expressly included. This payment receipt does not assert VAT registration or replace any legally required tax invoice.",
    );
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return result;
}
