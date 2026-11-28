#!/usr/bin/env node
// Builds the customer quick-start guide (#434) as print-ready A4 PDFs in
// English and French, from the design canvas boards `BrochureEN` and
// `BrochureFR` (the `Brochure` board in each language, as rendered in
// docs/redesign/screens/png), the way the first edition was printed
// (Chromium's PDF).
//
//   node scripts/brochure-pdf.mjs --whatsapp "+237 671 493 902" [--phone "+237 …"] [--out docs/brochure]
//
// The board keeps its [SUPPORT NUMBER] and [WHATSAPP NUMBER] placeholders;
// the numbers are filled in at print time, so the board itself never changes.
// With only a WhatsApp number (owner, 27 Nov), the contact reads "WhatsApp …"
// and the phone line is left out.
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const whatsapp = option("whatsapp") || process.env.BROCHURE_WHATSAPP || "", phone = option("phone") || process.env.BROCHURE_PHONE || "";
const out = resolve(ROOT, option("out") || "docs/brochure");
if (!whatsapp && !phone) {
  console.error("Give the support contact: --whatsapp \"+237 …\" and/or --phone \"+237 …\".");
  process.exit(1);
}

const screens = join(ROOT, "docs/redesign/screens"), TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://x").pathname.replace(/^\//, "");
  try {
    const body = name === "support.js" ? await readFile(join(ROOT, "scripts/redesign-preview-canvas.js")) : await readFile(join(screens, name));
    res.writeHead(200, { "content-type": TYPES[extname(name)] || "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
// Unhinted glyph widths, as the board was rendered and the first edition
// printed: headless Chromium's default hinting rounds every glyph's width,
// which sets DM Sans about 3% wider and re-wraps lines.
const browser = await chromium.launch({ headless: true, args: ["--font-render-hinting=none"] });
await mkdir(out, { recursive: true });
try {
  for (const [lang, board, file] of [["en", "BrochureEN", "NDAHI-Connect-Pay-Get-Online-EN.pdf"], ["fr", "BrochureFR", "NDAHI-Connect-Pay-Get-Online-FR.pdf"]]) {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    // Only the board and its fonts; nothing else is fetched. The font
    // stylesheet is asked for as a plain client, so Google sends each weight as
    // a static TrueType file, embedded as such in the PDF (a browser gets the
    // variable font, which Chromium embeds as Type 3, which print checks flag).
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("https://fonts.googleapis.com/")) return route.continue({ headers: { ...route.request().headers(), "user-agent": "brochure-pdf" } });
      return url.startsWith(base) || url.startsWith("https://fonts.gstatic.com/") ? route.continue() : route.abort();
    });
    await page.goto(`${base}/${board}.dc.html`);
    await page.waitForSelector("html[data-dc-ready]", { state: "attached", timeout: 20000 });
    // The board's typefaces (Google Fonts): wait for every face it uses, and
    // never print the fallback font.
    // The imported board adds its font stylesheet after the canvas is ready, so
    // wait for every stylesheet first. (document.fonts.check() can't tell: it
    // answers true while no face of the family is known yet.)
    const missing = await page.evaluate(async () => {
      const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => !link.sheet)
        .map((link) => new Promise((done) => { link.addEventListener("load", done, { once: true }); link.addEventListener("error", done, { once: true }); }));
      await Promise.race([Promise.all(sheets), new Promise((done) => setTimeout(done, 20000))]);
      const faces = [["DM Sans", "400"], ["DM Sans", "500"], ["DM Sans", "600"], ["DM Sans", "700"], ["Playfair Display", "600"], ["Playfair Display", "700"]];
      await Promise.all(faces.map(([family, weight]) => document.fonts.load(`${weight} 16px '${family}'`, "Aé").catch(() => [])));
      await document.fonts.ready;
      const loaded = new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => `${face.family.replace(/["']/g, "")} ${face.weight}`));
      return faces.map(([family, weight]) => `${family} ${weight}`).filter((face) => !loaded.has(face));
    });
    if (missing.length) throw new Error(`The ${lang} board's fonts didn't load: ${missing.join(", ")}.`);
    const filled = await page.evaluate(({ whatsapp, phone }) => {
      // The canvas keeps the board's source in <x-dc>; only the rendered copy is printed.
      const strong = [...document.querySelectorAll("strong")].find((el) => !el.closest("x-dc") && el.textContent.trim() === "[SUPPORT NUMBER]");
      if (!strong) return false;
      const box = strong.parentElement;
      if (phone) strong.textContent = phone;
      else strong.textContent = `WhatsApp ${whatsapp}`;
      // The "WhatsApp [WHATSAPP NUMBER]" line: filled, or left out (with its line break) when it's the only contact.
      for (const node of [...box.childNodes]) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.includes("[WHATSAPP NUMBER]")) continue;
        if (phone && whatsapp) node.textContent = node.textContent.replace("[WHATSAPP NUMBER]", whatsapp);
        else { if (node.nextSibling?.nodeName === "BR") node.nextSibling.remove(); node.remove(); }
      }
      const printed = document.body.cloneNode(true);
      printed.querySelectorAll("x-dc").forEach((el) => el.remove());
      return !/\[(SUPPORT|WHATSAPP) NUMBER\]/.test(printed.innerHTML);
    }, { whatsapp, phone });
    if (!filled) throw new Error(`The ${lang} board's contact placeholders weren't found or filled.`);
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: join(out, file), format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
    console.log(`${file}: written`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
