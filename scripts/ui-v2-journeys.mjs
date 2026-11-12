// Runs the existing browser journeys against the v2 front end without editing them:
//   npm run test:browser:v2
// Every Playwright context starts with the ndahi_ui=v2 cookie that ?ui=new sets (and
// keeps it after clearCookies), and every customer or admin page must carry the v2
// marker. Loaded with NODE_OPTIONS="--import ./scripts/ui-v2-journeys.mjs".
import { chromium } from "playwright";

// Journeys that differ between versions read this (see scripts/portal-tabs.mjs).
process.env.NDAHI_UI_VARIANT = "v2";

const cookies = ["127.0.0.1", "localhost"].map((domain) => ({ name: "ndahi_ui", value: "v2", domain, path: "/", httpOnly: true, sameSite: "Lax" }));
const prepared = new WeakSet(), wrong = new Set();
let launched = false, pages = 0;

function wrap(target, method, after) {
  const original = target[method];
  target[method] = async function (...args) {
    const result = await original.apply(this, args);
    await after(this, result);
    return result;
  };
}

// Reads page responses rather than the live page, so the check never races a
// journey's own navigation. Only customer and admin pages vary by cookie.
async function check(response) {
  try {
    if (response.request().resourceType() !== "document" || response.status() !== 200) return;
    if (!/\bcookie\b/i.test(response.headers().vary || "")) return;
    if (/<html[^>]* data-ui-variant="v2"/.test(await response.text())) pages++;
    else wrong.add(new URL(response.url()).pathname);
  } catch { /* The page closed or navigated again before its body could be read. */ }
}

async function prepare(context) {
  if (prepared.has(context)) return;
  prepared.add(context);
  const prototype = Object.getPrototypeOf(context);
  if (!prototype.ndahiUiV2) {
    prototype.ndahiUiV2 = true;
    // A journey that clears cookies is a new visitor, who still gets v2 here.
    wrap(prototype, "clearCookies", (self) => prepared.has(self) && self.addCookies(cookies));
  }
  await context.addCookies(cookies);
  context.on("response", check);
}

// Page requests a journey makes from Node (such as reading /version.json) come from
// the same visitor. API requests are left exactly as the journey wrote them.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const target = input instanceof Request ? input.url : String(input);
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?!api\/)/.test(target)) return nodeFetch(input, init);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("cookie", [headers.get("cookie"), "ndahi_ui=v2"].filter(Boolean).join("; "));
  return nodeFetch(input, { ...init, headers });
};

const browserType = Object.getPrototypeOf(chromium);
wrap(browserType, "launch", (_, browser) => {
  const prototype = Object.getPrototypeOf(browser);
  if (!launched) {
    wrap(prototype, "newContext", (_, context) => prepare(context));
    wrap(prototype, "newPage", (_, page) => prepare(page.context()));
  }
  launched = true;
});

process.on("exit", () => {
  if (!launched) return;
  console.log(`UI v2 journeys: ${pages} customer/admin page loads used v2.`);
  if (wrong.size) {
    console.error(`UI v2 journeys: pages served without the v2 marker: ${[...wrong].join(", ")}`);
    process.exitCode = 1;
  }
});
