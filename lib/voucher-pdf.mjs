import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";
import {
  sanitizePrintableVoucher,
  VOUCHER_SLIP_DESIGN,
  voucherSlipRows,
  voucherSlipInstructions,
} from "../admin-app/voucher-slip.js";

export const voucherFilename = (voucher) =>
  `ndahi-voucher-${String(voucher.id).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
const fonts = (doc) => {
  doc.registerFont(
    "regular",
    fileURLToPath(
      new URL("./assets/fonts/DejaVuSansMono.ttf", import.meta.url),
    ),
  );
  doc.registerFont(
    "bold",
    fileURLToPath(
      new URL("./assets/fonts/DejaVuSansMono-Bold.ttf", import.meta.url),
    ),
  );
  return doc;
};
export async function prepareVoucherSlip({
  voucher,
  plan,
  portalUrl = "https://portal.ndahiconnect.net",
  issued = false,
}) {
  const origin = new URL(portalUrl).origin;
  const redemptionUrl = `${origin}/onboarding.html?action=connect&code=${encodeURIComponent(voucher.code)}`;
  const qrCode = await QRCode.toDataURL(redemptionUrl, {
    width: 320,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  // The explicit purchase snapshot is authoritative over any embedded mutable catalogue plan.
  return sanitizePrintableVoucher({ ...voucher, plan, qrCode }, plan, {
    issued,
  });
}

function layoutVoucherSlip(item, widthMm) {
  const width = widthMm === 80 ? 80 : 58,
    mm = 72 / 25.4,
    pageWidth = width * mm;
  const margin = 8,
    inner = pageWidth - margin * 2,
    operations = [];
  const measure = fonts(new PDFDocument({ margin: 0 }));
  let y = 8;
  const text = (value, size = 8, bold = false, align = "left", inset = 0) => {
    const options = { width: inner - inset * 2, align, lineGap: 1 };
    measure.font(bold ? "bold" : "regular").fontSize(size);
    const height = measure.heightOfString(String(value), options);
    operations.push({
      type: "text",
      value: String(value),
      size,
      bold,
      options,
      x: margin + inset,
      y,
    });
    y += height + 4;
  };
  const row = (label, value, size = 8, heading = false) => {
    const left = Math.floor(inner * 0.42),
      right = inner - left - 5;
    measure.font("bold").fontSize(size);
    const lh = measure.heightOfString(label, { width: left, lineGap: 1 });
    measure.font(heading ? "bold" : "regular");
    const rh = measure.heightOfString(value, { width: right, lineGap: 1 });
    operations.push({
      type: "text",
      value: label,
      size,
      bold: true,
      x: margin,
      y,
      options: { width: left, lineGap: 1 },
    });
    operations.push({
      type: "text",
      value,
      size,
      bold: heading,
      x: margin + left + 5,
      y,
      options: { width: right, align: "right", lineGap: 1 },
    });
    y += Math.max(lh, rh) + 4;
  };
  const line = () => {
    y += 2;
    operations.push({ type: "line", y });
    y += 6;
  };
  text(VOUCHER_SLIP_DESIGN.brand, 11, true, "center");
  text(VOUCHER_SLIP_DESIGN.subtitle, 7, true, "center");
  line();
  row(item.planName, item.priceLabel, 9, true);
  line();
  const boxTop = y;
  y += 5;
  text(VOUCHER_SLIP_DESIGN.codeLabel, 7, true, "center", 4);
  text(item.code, 12, true, "center", 4);
  operations.push({ type: "box", y: boxTop, height: y - boxTop + 2 });
  y += 8;
  if (item.qrCode) {
    operations.push({ type: "qr", y });
    y += 75;
  }
  line();
  for (const [label, value] of voucherSlipRows(item)) row(label, value);
  line();
  text("How to connect:", 8, true);
  voucherSlipInstructions(item).forEach((value, i) =>
    text(`${i + 1}. ${value}`, 7),
  );
  text(item.notice, 6.5);
  measure.end();
  measure.resume();
  return {
    operations,
    pageWidth,
    height: Math.max(200 * mm, y + 8),
    margin,
    inner,
  };
}

export async function voucherBatchPdf({ entries, widthMm = 58, portalUrl }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100)
    throw Error("Choose between 1 and 100 vouchers.");
  const pages = await Promise.all(
    entries.map(async (entry) => ({
      item: entry.slip || (await prepareVoucherSlip({ ...entry, portalUrl })),
      voucher: entry.voucher,
    })),
  );
  const date = Number.isFinite(Date.parse(pages[0].voucher.activatedAt))
    ? new Date(pages[0].voucher.activatedAt)
    : new Date(0);
  const doc = fonts(
    new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: "NDAHI Connect voucher",
        Author: "NDAHI Connect",
        CreationDate: date,
        ModDate: date,
      },
    }),
  );
  const chunks = [],
    done = new Promise((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  try {
    for (const { item } of pages) {
      const { operations, pageWidth, height, margin, inner } =
        layoutVoucherSlip(item, widthMm);
      doc.addPage({ size: [pageWidth, height], margin: 0 });
      for (const op of operations) {
        if (op.type === "text")
          doc
            .font(op.bold ? "bold" : "regular")
            .fontSize(op.size)
            .fillColor("#000")
            .text(op.value, op.x, op.y, op.options);
        if (op.type === "line")
          doc
            .lineWidth(0.7)
            .moveTo(margin, op.y)
            .lineTo(pageWidth - margin, op.y)
            .stroke();
        if (op.type === "box")
          doc.lineWidth(1.5).rect(margin, op.y, inner, op.height).stroke();
        if (op.type === "qr")
          doc.image(
            Buffer.from(item.qrCode.split(",")[1], "base64"),
            (pageWidth - 69) / 2,
            op.y,
            { width: 69, height: 69 },
          );
      }
    }
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return done;
}

export async function voucherPdf(entry) {
  return voucherBatchPdf({
    entries: [entry],
    widthMm: entry.widthMm,
    portalUrl: entry.portalUrl,
  });
}
