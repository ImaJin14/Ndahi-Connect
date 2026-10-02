import PDFDocument from "pdfkit";
import { openSync } from "fontkit";
import { fileURLToPath } from "node:url";
import { palette as c } from "./brand.mjs";
import { receiptView } from "./receipt.mjs";

const font = (name, file) => {
  const path = fileURLToPath(new URL(`./assets/fonts/${file}`, import.meta.url));
  return { name, path, face: openSync(path) };
};
const fonts = {
  regular: font("Receipt-Regular", "DejaVuSans.ttf"),
  bold: font("Receipt-Bold", "DejaVuSans-Bold.ttf"),
};
// Keep supported Unicode intact; an explicit replacement marks characters the font lacks.
// Line-break whitespace is handled by PDFKit rather than the font's glyph map.
const pdfText = (value, bold = false) => Array.from(String(value), (character) =>
  /[\n\r\t]/.test(character) || fonts[bold ? "bold" : "regular"].face.hasGlyphForCodePoint(character.codePointAt(0))
    ? character : "\ufffd",
).join("");

export const receiptFilename = (receipt) =>
  `ndahi-receipt-${String(receipt.paymentId || "payment").replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

// No browser, external assets or live plan lookups are needed to render a receipt.
export async function receiptPdf(receipt) {
  const d = receiptView(receipt), paidAt = new Date(receipt.paidAt);
  const date = Number.isNaN(paidAt.getTime()) ? new Date(0) : paidAt;
  const doc = new PDFDocument({ size: "A4", margin: 42, info: {
    Title: `NDAHI Connect receipt ${receipt.number}`, Author: "NDAHI Connect",
    Subject: "Payment receipt", CreationDate: date, ModDate: date,
  } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  try {
    for (const { name, path } of Object.values(fonts)) doc.registerFont(name, path);
    const width = doc.page.width - 84;
    doc.rect(0, 0, doc.page.width, 96).fill(c.ink);
    doc.circle(61, 47, 20).lineWidth(2).stroke(c.lime);
    doc.font(fonts.bold.name).fontSize(12).fillColor(c.lime).text("NC", 51, 43, { lineBreak: false });
    doc.fontSize(22).fillColor("#ffffff").text("NDAHI", 96, 30);
    doc.fontSize(9).fillColor(c.lime).text("CONNECT", 97, 57, { characterSpacing: 3 });
    doc.fontSize(11).fillColor(c.onInk).text("PAYMENT RECEIPT", 345, 42, { width: 207, align: "right" });

    doc.font(fonts.regular.name).fontSize(10).fillColor(c.muted).text("AMOUNT PAID", 42, 121);
    doc.font(fonts.bold.name).fontSize(34).fillColor(c.ink).text(pdfText(d.amountLabel, true), 42, 140, { width });
    doc.roundedRect(42, 188, 47, 22, 11).fill(c.lime);
    doc.fontSize(10).fillColor(c.ink).text("Paid", 42, 195, { width: 47, align: "center" });
    doc.font(fonts.regular.name).fillColor(c.muted).text(pdfText(d.paidAtLabel), 100, 195, { width: width - 58 });

    let y = 237;
    const row = (label, value, bold = false) => {
      doc.font(fonts[bold ? "bold" : "regular"].name).fontSize(11);
      const renderedValue = pdfText(value, bold);
      const height = Math.max(18, doc.heightOfString(renderedValue, { width: width - 163 })) + 17;
      if (y + height > doc.page.height - 80) { doc.addPage(); y = 42; }
      const startingPage = doc.page, startingY = y;
      doc.fillColor(c.muted).text(label, 42, y + 8, { width: 145 });
      doc.fillColor(c.ink).text(renderedValue, 205, y + 8, { width: width - 163, align: "right" });
      // Oversized values may span pages: continue below the final text line on its actual page.
      y = doc.page === startingPage ? startingY + height : doc.y + 9;
      doc.moveTo(42, y).lineTo(42 + width, y).lineWidth(0.5).stroke(c.line);
    };
    row("Package", d.plan.name, true);
    row("Data", d.dataLabel);
    row("Validity", d.validityLabel);
    row("Devices", d.deviceLabel);
    y += 12;
    row("Receipt number", d.number);
    row("Billed to", d.customerName);
    row("Paid on", d.paidAtLabel);
    row("Payment method", d.methodLabel);
    row("Provider reference", d.providerReference);
    row("Total paid", d.amountLabel, true);
    y += 20;
    if (y + 70 > doc.page.height - 42) { doc.addPage(); y = 42; }
    doc.font(fonts.regular.name).fontSize(9).fillColor(c.muted).text(
      "Provider fees, if any, are shown separately by your payment provider. This receipt records the package payment; your dashboard shows current access and any refund.",
      42, y, { width, lineGap: 3 },
    );
    doc.moveDown().text(pdfText(`NDAHI Connect · Managed public Wi-Fi${receipt.policyVersion ? ` · Billing rules ${receipt.policyVersion}` : ""}`), { width });
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return done;
}
