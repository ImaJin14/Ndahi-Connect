import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";
import {
  sanitizePrintableVoucher,
  VOUCHER_SLIP_DESIGN,
  voucherSlipRows,
  voucherSlipInstructions,
} from "../admin-app/voucher-slip.js";
import {
  VOUCHER_CARD,
  voucherCardFacts,
  voucherCardSteps,
  voucherCardStatus,
} from "../shared-app/voucher-card.js";

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
  doc.registerFont(
    "sans",
    fileURLToPath(new URL("./assets/fonts/DejaVuSans.ttf", import.meta.url)),
  );
  doc.registerFont(
    "sans-bold",
    fileURLToPath(new URL("./assets/fonts/DejaVuSans-Bold.ttf", import.meta.url)),
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
  let redemptionUrl = `${origin}/onboarding.html?action=connect&code=${encodeURIComponent(voucher.code)}`;
  try {
    const candidate = new URL(voucher.qrRedemptionUrl);
    if (candidate.origin === origin && candidate.pathname === "/voucher-connect.html" && (!candidate.search || candidate.search === "?action=connect") && /^#qr=[A-Za-z0-9_-]{32,128}$/.test(candidate.hash)) redemptionUrl = candidate.href;
  } catch { /* Legacy documents retain their activation URL. */ }
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

// One A6 card (canvas: VoucherSlip) with its top-left corner at (ox, oy).
// Coordinates are the canvas's pixels; one pixel is a quarter millimetre.
function drawVoucherCard(doc, item, ox, oy) {
  const u = (0.25 * 72) / 25.4,
    X = (px) => ox + px * u,
    Y = (px) => oy + px * u;
  const ink = "#10241c", muted = "#5c6963", forest = "#003b2b", lime = "#b9ee2e";
  // Dashed frame with the forest band clipped to its rounded top.
  doc.save();
  doc.roundedRect(X(18), Y(18), 384 * u, 559 * u, 14 * u).clip();
  doc.rect(X(18), Y(18), 384 * u, 60 * u).fill(forest);
  doc.restore();
  doc.save();
  doc.lineWidth(2 * u).dash(5 * u, { space: 4 * u }).strokeColor("#9aa8a0");
  doc.roundedRect(X(19), Y(19), 382 * u, 557 * u, 13 * u).stroke();
  doc.undash();
  doc.restore();
  // Head: mark, name and price.
  doc.lineWidth(2 * u).strokeColor(lime).circle(X(52), Y(48), 15 * u).stroke();
  doc.font("sans-bold").fontSize(10 * u).fillColor(lime).text("NC", X(36), Y(42), { width: 32 * u, align: "center", lineBreak: false });
  doc.font("sans-bold").fontSize(17 * u).fillColor("#ffffff").text(VOUCHER_CARD.brand, X(78), Y(30), { lineBreak: false });
  doc.font("sans-bold").fontSize(8 * u).fillColor(lime).text(VOUCHER_CARD.subtitle, X(78), Y(54), { characterSpacing: 2 * u, lineBreak: false });
  doc.font("sans-bold").fontSize(15 * u).fillColor("#ffffff").text(item.priceLabel, X(220), Y(38), { width: 164 * u, align: "right", lineBreak: false });
  // Body: QR beside the plan, facts and code, centred on the QR.
  if (item.qrCode) {
    doc.image(Buffer.from(item.qrCode.split(",")[1], "base64"), X(36), Y(94), { width: 120 * u, height: 120 * u });
    doc.lineWidth(0.5).strokeColor("#dfe5dc").rect(X(36), Y(94), 120 * u, 120 * u).stroke();
  } else {
    doc.font("sans").fontSize(10 * u).fillColor(muted).text("QR unavailable — enter the voucher code.", X(40), Y(140), { width: 112 * u, align: "center" });
  }
  const left = X(172), width = 212 * u, status = voucherCardStatus(item);
  const lines = [
    { value: item.planName.toUpperCase(), font: "sans-bold", size: 10.5, color: "#4d6b00", gap: 4, spacing: 1.2 },
    { value: voucherCardFacts(item), font: "sans-bold", size: 15, color: ink, gap: 10 },
    { value: VOUCHER_CARD.codeLabel, font: "sans", size: 11.5, color: muted, gap: 2 },
    { value: item.code, font: "bold", size: 21, color: ink, gap: status ? 6 : 0 },
    ...(status ? [{ value: `${item.statusHeading}: ${status}`, font: "sans-bold", size: 11, color: "#8a2a1c", gap: 0 }] : []),
  ];
  const heights = lines.map((line) => doc.font(line.font).fontSize(line.size * u).heightOfString(line.value, { width, characterSpacing: (line.spacing || 0) * u }));
  let y = Y(94) + Math.max(0, (120 * u - heights.reduce((sum, height, i) => sum + height + lines[i].gap * u, 0)) / 2);
  lines.forEach((line, i) => {
    doc.font(line.font).fontSize(line.size * u).fillColor(line.color).text(line.value, left, y, { width, characterSpacing: (line.spacing || 0) * u });
    y += heights[i] + line.gap * u;
  });
  // How to connect, in the sage box.
  const steps = voucherCardSteps(item), stepWidth = 306 * u;
  doc.font("sans").fontSize(12.5 * u);
  const stepHeights = steps.map((step) => doc.heightOfString(step, { width: stepWidth, lineGap: 4 * u }));
  const boxHeight = 24 * u + stepHeights.reduce((sum, height) => sum + height, 0) + 2 * 3 * u;
  doc.roundedRect(X(36), Y(230), 348 * u, boxHeight, 10 * u).fill("#eef3e9");
  let stepY = Y(242);
  steps.forEach((step, i) => {
    doc.font("sans").fontSize(12.5 * u).fillColor("#3d4a44").text(`${i + 1}.`, X(48), stepY, { lineBreak: false });
    doc.text(step, X(66), stepY, { width: stepWidth, lineGap: 4 * u });
    stepY += stepHeights[i] + 3 * u;
  });
  // Footer: activation note and the privacy reminder.
  doc.lineWidth(0.5).strokeColor("#dfe5dc").moveTo(X(20), Y(538)).lineTo(X(400), Y(538)).stroke();
  doc.font("sans").fontSize(10.5 * u).fillColor(muted).text(item.expiryNote, X(36), Y(551), { width: 200 * u, lineBreak: false });
  doc.text(VOUCHER_CARD.privacy, X(220), Y(551), { width: 164 * u, align: "right", lineBreak: false });
}

export async function voucherBatchPdf({ entries, widthMm = 58, portalUrl, layout }) {
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
    // A6 cards: four to an A4 page, edge to edge.
    if (layout === "a6") {
      const mm = 72 / 25.4;
      pages.forEach(({ item }, i) => {
        if (i % VOUCHER_CARD.perPage === 0) doc.addPage({ size: "A4", margin: 0 });
        const slot = i % VOUCHER_CARD.perPage;
        drawVoucherCard(doc, item, (slot % 2) * 105 * mm, Math.floor(slot / 2) * 148 * mm);
      });
      doc.end();
      return done;
    }
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
