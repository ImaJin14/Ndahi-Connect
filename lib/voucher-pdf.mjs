import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { palette, doualaTime } from "./brand.mjs";

export const voucherFilename = (voucher) => `ndahi-voucher-${String(voucher.id).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

export async function voucherPdf({ voucher, plan, phone, issued = false }) {
  const date = Number.isFinite(Date.parse(voucher.activatedAt)) ? new Date(voucher.activatedAt) : new Date(0);
  const doc = new PDFDocument({ size: "A5", margin: 32, info: { Title: "NDAHI Connect voucher", Author: "NDAHI Connect", CreationDate: date, ModDate: date } });
  const chunks = [], done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  try {
    doc.registerFont("regular", fileURLToPath(new URL("./assets/fonts/DejaVuSans.ttf", import.meta.url)));
    doc.registerFont("bold", fileURLToPath(new URL("./assets/fonts/DejaVuSans-Bold.ttf", import.meta.url)));
    doc.font("bold").fontSize(22).fillColor(palette.ink).text("NDAHI CONNECT");
    doc.moveDown().fontSize(13).text("YOUR VOUCHER");
    doc.moveDown().fontSize(23).text(voucher.code);
    doc.moveDown().font("regular").fontSize(11);
    for (const [label, value] of [
      ["Package", String(plan?.name || voucher.planId).slice(0, 160)],
      [issued ? "Status at issue" : "Status at download", voucher.status], ["Account number", phone],
      ["Activated", voucher.activatedAt ? doualaTime(voucher.activatedAt) : "Not activated"],
      ["Expires", voucher.expiresAt ? doualaTime(voucher.expiresAt) : "Not activated"],
      ["Device limit", voucher.deviceLimit ?? plan?.deviceLimit ?? "Not recorded"],
    ]) doc.text(`${label}: ${value}`).moveDown(0.6);
    doc.moveDown().fontSize(9).fillColor(palette.muted).text("Keep this code private. Downloading a voucher does not reactivate expired, replaced or refunded access. Your portal shows the current status.");
    doc.end();
  } catch (error) { doc.destroy(error); }
  return done;
}
