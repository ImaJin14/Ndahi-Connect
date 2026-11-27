import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./brand.mjs";
import { chargedAmounts } from "./payment-fees.mjs";
const requirePaid = (order) => {
  if (!order?.payment?.confirmedAt)
    throw Object.assign(
      Error("A receipt is available only after verified payment."),
      { status: 409 },
    );
};
const feeFields = (payment) => {
  const { fee, total } = chargedAmounts(payment);
  return fee === null ? {} : { fee, total, network: payment.network || null };
};
const fcfa = (value) => `${Number(value).toLocaleString()} FCFA`;
const feeLabel = (network) => network === "orange" ? "Orange Money fee" : network === "mtn" ? "MTN Mobile Money fee" : "Mobile Money fee";
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
    // The Mobile Money fee on top of the price (#297), when known.
    ...feeFields(order.payment),
    seller: structuredClone(
      order.seller || { name: "NDAHI Store", contact: "" },
    ),
    buyerName: order.payment.customerName || order.contact.name,
    item: {
      name: structuredClone(order.product.name),
      sku: order.product.sku,
      // The price actually charged: a promotion's (#302) when there was one.
      unitPrice: order.unitPrice ?? order.product.price,
      quantity: order.quantity,
    },
    // A kit order's parts (#427): the kit or its deposit, installation, travel.
    ...(order.breakdown ? { breakdown: structuredClone(order.breakdown) } : {}),
    ...(order.promotion?.bonus ? { included: { days: Math.round(order.promotion.bonus.validityHours / 24), planName: order.promotion.bonus.planName || order.promotion.bonus.planId,
      // Given at collection and started within this many days (#423); absent for 20 Nov orders.
      ...(order.promotion.bonus.startsAt === "customer_start" ? { startWithinDays: order.promotion.bonus.startWithinDays ?? 60 } : {}) } } : {}),
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
// link: a guest's short private link (#401), when the order has one.
// Reminders (#425, #426): a plan's next payment, staff's reminder, and an
// installation booked and the day before.
export function storeReminderEmail(order, reminder) {
  const day = (at) => new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Douala" });
  const name = order.kit?.name?.en || order.product.name.en;
  const slot = (b) => b.slot === "morning" ? "morning (8:00–12:00)" : "afternoon (13:00–17:00)";
  const subject = reminder.about === "plan" ? `Payment ${reminder.n} of 3 for your ${name} is due ${day(reminder.dueAt)}`
    : reminder.kind === "tomorrow" ? `Your installation is tomorrow ${slot(order.installation)}` : `Installation booked: ${order.installation.reference}`;
  const lines = reminder.about === "plan"
    ? [`Hello ${order.contact.name},`, `Payment ${reminder.n} of 3 (${fcfa(reminder.amount)}) for your ${name} is due by ${day(reminder.dueAt)}.`,
      "You can pay early, or pay everything left at once, from the order in your account.",
      `If a payment is ${order.plan.rules.grace} days late, the plan is cancelled, the kit goes back on sale and everything you paid is refunded except the Mobile Money fees.`, `Order: ${order.reference}`]
    : [`Hello ${order.contact.name},`, reminder.kind === "tomorrow" ? `Our technician comes tomorrow, ${day(order.installation.startsAt || `${order.installation.day}T12:00:00Z`)}, in the ${slot(order.installation)}.` : `Your installation is booked for ${day(`${order.installation.day}T12:00:00Z`)}, ${slot(order.installation)}.`,
      `${order.installation.area.name}${order.installation.area.town ? " · " + order.installation.area.town : ""}: the technician calls ${order.installation.phone} 30 minutes before arriving.`,
      "Please have power near the spot and someone over 18 at home. You can move or cancel it free up to 24 h before.", `Booking: ${order.installation.reference} · Order: ${order.reference}`];
  return { subject, text: lines.join("\n\n"), html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("") };
}
export function storeOrderEmail(order, { link = null } = {}) {
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
    `Order total: ${fcfa(order.payment.amount)}`,
    ...(chargedAmounts(order.payment).fee === null ? [] : [
      `${feeLabel(order.payment.network)}: ${fcfa(chargedAmounts(order.payment).fee)}`,
      `Total to approve: ${fcfa(chargedAmounts(order.payment).total)}`]),
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
    link
      ? `Track your order with your private link: ${link}`
      : "Keep the private tracking link saved at checkout.",
    `${link ? "Anyone with the link can see this order. " : ""}Do not post it publicly. Hardware purchases do not include internet service unless the offer expressly says so.`,
  ].filter(Boolean);
  const linkLine = link && `Track your order with your private link: ${link}`;
  return {
    subject: `NDAHI Store — ${title} — ${order.reference}`,
    text: lines.join("\n"),
    html: `<h2>${escapeHtml(title)}</h2>${lines.map((line) => line === linkLine
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:#b9ee2e;color:#15210c;font-weight:bold;text-decoration:none">Track my order</a></p><p>${escapeHtml(link)}</p>`
      : `<p>${escapeHtml(line)}</p>`).join("")}`,
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
    for (const part of r.breakdown || []) row({ kit: "Kit", deposit: "Kit deposit", installation: "Installation", travel: "Travel" }[part.part] || part.part, fcfa(part.amount));
    if (r.included) row("Included free", `${r.included.days} days of ${r.included.planName}${r.included.startWithinDays ? `, given when you collect; start within ${r.included.startWithinDays} days` : ""}`);
    if (Number.isFinite(r.fee)) {
      row("Price", fcfa(r.amount));
      row(feeLabel(r.network), fcfa(r.fee));
      row("Total paid", fcfa(r.total), true);
    } else row("Total paid", fcfa(r.amount), true);
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
