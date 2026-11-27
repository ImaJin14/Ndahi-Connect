import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";
import { voucherCardModel } from "../shared-app/voucher-card.js";
import { en, fr } from "../shared-app/i18n/admin.js";
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

// The voucher's own PDF (account download and email attachment) is the colour
// card as drawn (canvas: VoucherSlip, #368; owner 26 Nov): one A6 page per
// voucher, the board's 420 x 595 layout scaled to fit. The print page's PDF
// stays the thermal slip at the chosen width: it is how phones print on
// thermal printers (voucherBatchPdf, unchanged).
// The board's fonts, bundled with their open licences (owner, 26 Nov):
// DM Sans for the text, Playfair Display for "NDAHI Connect"; the code in
// DejaVu Sans Mono, as the board's system monospace.
const font = (name) => fileURLToPath(new URL(`./assets/fonts/${name}`, import.meta.url));
const FONTS = { sans: font("DMSans-Regular.ttf"), sansBold: font("DMSans-Bold.ttf"), display: font("PlayfairDisplay-Bold.ttf"), mono: font("DejaVuSansMono-Bold.ttf") };
const A6_WIDTH = 297.64, BOARD_WIDTH = 420, BOARD_HEIGHT = 595;
const strings = (lang) => (key, values = {}) =>
  String((lang === "fr" ? fr : en)[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");

// Draws one card in the board's 420 x 595 coordinates, scaled to the page.
function drawVoucherCard(doc, card) {
  const k = A6_WIDTH / BOARD_WIDTH, u = (n) => n * k, px = (pt) => pt / k;
  const set = (name, size, color) => doc.font(name).fontSize(u(size)).fillColor(color);
  const height = (value, name, size, width, lineGap = 0) => px(doc.font(name).fontSize(u(size)).heightOfString(value, { width: u(width), lineGap: u(lineGap) }));
  const write = (value, x, y, name, size, color, opts = {}) => {
    set(name, size, color).text(value, u(x), u(y), { lineBreak: Boolean(opts.width), ...opts, width: opts.width ? u(opts.width) : undefined, height: opts.height ? u(opts.height) : undefined,
      characterSpacing: u(opts.spacing || 0), lineGap: u(opts.lineGap || 0) });
    return px(doc.y);
  };
  // The dashed card in its page; the forest head clipped to its corners.
  doc.save();
  doc.roundedRect(u(20), u(20), u(380), u(555), u(12)).clip();
  doc.rect(u(20), u(20), u(380), u(73)).fill("#003b2b");
  doc.restore();
  doc.lineWidth(u(2)).dash(u(6), { space: u(4) }).roundedRect(u(19), u(19), u(382), u(557), u(14)).strokeColor("#9aa8a0").stroke().undash();
  // Head: the NC mark, NDAHI Connect and WI-FI VOUCHER, the price.
  // Positions are the board's own boxes (head 20–93, mark centred at 56,57).
  doc.lineWidth(u(2)).circle(u(56), u(57), u(17)).strokeColor("#b9ee2e").stroke();
  write("NC", 38, 50, "sansBold", 11, "#b9ee2e", { width: 36, align: "center" });
  write(card.brand, 84, 34, "display", 18, "#ffffff");
  write(card.kind, 84, 65, "sansBold", 9, "#b9ee2e", { spacing: 2.34 });
  write(card.price, 220, 46, "sansBold", 16, "#ffffff", { width: 162, align: "right" });
  // Body: the QR beside the plan, the terms and the code, centred on the QR.
  // The plan name is one line, as drawn; a longer one ends in an ellipsis.
  const column = 206, planLine = height("A", "sansBold", 11, column), block = planLine + 4 + height(card.terms, "sansBold", 16, column) + 10
    + height(card.codeLabel, "sans", 12, column) + 2 + height(card.code, "mono", 26, column);
  if (card.qr) doc.image(Buffer.from(card.qr.split(",")[1], "base64"), u(39), u(110), { width: u(120), height: u(120) });
  doc.lineWidth(u(1)).rect(u(38.5), u(109.5), u(121), u(121)).strokeColor("#dfe5dc").stroke();
  let y = 109 + Math.max(0, (122 - block) / 2);
  write(card.plan.toUpperCase(), 176, y, "sansBold", 11, "#4d6b00", { width: column, spacing: 1.32, height: planLine, ellipsis: true });
  y += planLine + 4;
  y = write(card.terms, 176, y, "sansBold", 16, "#10241c", { width: column }) + 10;
  y = write(card.codeLabel, 176, y, "sans", 12, "#5c6963", { width: column }) + 2;
  write(card.code, 176, y, "mono", 26, "#10241c", { width: column, spacing: 2.6 });
  // The three steps in their sage box, with their bold parts (line height 1.7).
  // Line height 1.7 as drawn: each 13 px line is 22.1 px apart.
  const top = 109 + 122 + 16, lineHeight = height("Ag", "sans", 13, 302), gap = 13 * 1.7 - lineHeight;
  const lines = card.steps.map((s) => height(s.before + s.strong + s.after, "sans", 13, 302, gap));
  doc.roundedRect(u(38), u(top), u(344), u(lines.reduce((a, b) => a + b, 0) + 24), u(10)).fill("#eef3e9");
  y = top + 12 + gap / 2;
  card.steps.forEach((step, index) => {
    write(`${index + 1}.`, 46, y, "sans", 13, "#3d4a44", { width: 18, align: "right" });
    set("sans", 13, "#3d4a44").text(step.before, u(68), u(y), { width: u(302), lineGap: u(gap), continued: Boolean(step.strong || step.after) });
    if (step.strong) doc.font("sansBold").text(step.strong, { continued: Boolean(step.after) });
    if (step.after) doc.font("sans").text(step.after);
    y += lines[index];
  });
  // Foot: the use-by date and the batch, smaller if both don't fit.
  doc.lineWidth(u(1)).moveTo(u(20), u(536.5)).lineTo(u(400), u(536.5)).strokeColor("#dfe5dc").stroke();
  let size = 11;
  const width = (value) => value ? px(doc.font("sans").fontSize(u(size)).widthOfString(value)) : 0;
  while (size > 8 && width(card.use) + width(card.batch) + 16 > 344) size -= 0.5;
  write(card.use, 38, 549, "sans", size, "#5c6963");
  if (card.batch) write(card.batch, 382 - width(card.batch) - 1, 549, "sans", size, "#5c6963");
}

export async function voucherCardPdf({ entries, portalUrl, lang = "en" }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100)
    throw Error("Choose between 1 and 100 vouchers.");
  const pages = await Promise.all(
    entries.map(async (entry) => ({
      item: entry.slip || (await prepareVoucherSlip({ ...entry, portalUrl })),
      voucher: entry.voucher,
      plan: entry.plan || entry.voucher?.plan || {},
    })),
  );
  const date = Number.isFinite(Date.parse(pages[0].voucher.activatedAt))
    ? new Date(pages[0].voucher.activatedAt)
    : new Date(0);
  const doc = new PDFDocument({
    autoFirstPage: false,
    margin: 0,
    info: { Title: "NDAHI Connect voucher", Author: "NDAHI Connect", CreationDate: date, ModDate: date },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  const chunks = [],
    done = new Promise((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  const t = strings(lang === "fr" ? "fr" : "en");
  try {
    for (const { item, voucher, plan } of pages) {
      doc.addPage({ size: [A6_WIDTH, (BOARD_HEIGHT * A6_WIDTH) / BOARD_WIDTH], margin: 0 });
      drawVoucherCard(doc, voucherCardModel({ ...voucher, code: item.code, qrCode: item.qrCode }, plan, t, { lang }));
    }
    doc.end();
  } catch (error) {
    doc.end();
    throw error;
  }
  return done;
}

export async function voucherPdf(entry) {
  return voucherCardPdf({ entries: [entry], portalUrl: entry.portalUrl, lang: entry.lang });
}
