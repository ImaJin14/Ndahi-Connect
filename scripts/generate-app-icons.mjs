import { mkdir } from "node:fs/promises";

// Renders the portal's app icons from the NC brand mark (forest background,
// lime ring and letters). Run after changing the brand:
//   node scripts/generate-app-icons.mjs
// Maskable icons keep the mark inside the central safe zone so launchers can
// crop them to any shape.
const out = new URL("../customer-app/assets/icons/", import.meta.url).pathname,
  icons = [
    { file: "icon-192.png", size: 192, ring: 0.74 },
    { file: "icon-512.png", size: 512, ring: 0.74 },
    { file: "icon-maskable-512.png", size: 512, ring: 0.56 },
    { file: "apple-touch-icon.png", size: 180, ring: 0.7 },
  ];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  await mkdir(out, { recursive: true });
  const page = await browser.newPage();
  for (const { file, size, ring } of icons) {
    const mark = Math.round(size * ring), border = Math.max(3, Math.round(mark * 0.06)), font = Math.round(mark * 0.36);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=block"><style>
      html,body{margin:0;width:${size}px;height:${size}px;background:#003b2b;display:grid;place-items:center}
      div{box-sizing:border-box;width:${mark}px;height:${mark}px;border:${border}px solid #b9ee2e;border-radius:50%;display:grid;place-items:center;color:#b9ee2e;font:700 ${font}px/1 'DM Sans',sans-serif;letter-spacing:.02em}
    </style></head><body><div>NC</div></body></html>`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: out + file, omitBackground: false });
    console.log(`Wrote ${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
