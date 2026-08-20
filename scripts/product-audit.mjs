import { mkdir, readFile, writeFile } from "node:fs/promises";
import { totpCode } from "../lib/security.mjs";

const out = "/tmp/ndahi-product-audit";
await mkdir(out, { recursive: true });
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("Chrome page target not found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let next = 0;
const pending = new Map(), errors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.exceptionThrown" ||
    message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    errors.push(message.params);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++next;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const wait = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const navigate = async (url) => {
  await send("Page.navigate", { url });
  await wait(1200);
};
const waitFor = async (expression, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluate(expression);
    if (value) return value;
    await wait(200);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
};
const viewport = (width, height, mobile = false) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const shot = async (name) => {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = `${out}/${name}.png`;
  await writeFile(path, Buffer.from(result.result.data, "base64"));
  return path;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await viewport(1440, 1024);

const report = [];
await navigate("http://localhost:8080/onboarding.html");
report.push({ step: "customer-packages", screenshot: await shot("01-customer-packages"), controls: await evaluate(`({plans:document.querySelectorAll('[data-plan]').length,choose:!!document.querySelector('a[href="#packages"]'),continueHidden:document.querySelector('#selectionBar').hidden})`) });
report.push({ step: "customer-checkout", controls: await evaluate(`document.querySelector('[data-plan="weekly"]').click();document.querySelector('#continue').click();({selected:document.querySelector('.plan.selected')?.dataset.card,modal:!document.querySelector('#checkout').hidden,fields:[...document.querySelectorAll('#purchase [name]')].map(x=>x.name)})`), screenshot: await shot("02-customer-checkout") });
report.push({ step: "checkout-close", controls: await evaluate(`document.querySelector('#closeCheckout').click();({closed:document.querySelector('#checkout').hidden})`) });

await navigate("http://localhost:8080/login");
report.push({ step: "customer-login", screenshot: await shot("03-customer-login"), controls: await evaluate(`({submit:!!document.querySelector('#login button'),back:document.querySelector('.onboarding-link a')?.getAttribute('href')})`) });

const database = JSON.parse(await readFile("data/db.json", "utf8"));
const voucher = database.vouchers.find((item) => item.status === "active");
const customer = voucher && database.customers.find((item) => item.id === voucher.customerId);
if (voucher && customer) {
  await evaluate(`document.querySelector('[name="phone"]').value=${JSON.stringify(customer.phone)};document.querySelector('[name="code"]').value=${JSON.stringify(voucher.code.toLowerCase().replaceAll("-", ""))};document.querySelector('#login button').click()`);
  const secret = await waitFor(`JSON.parse(sessionStorage.getItem('ndahi-login-challenge') || 'null')?.secret`);
  const otp = totpCode(secret);
  await waitFor(`location.pathname === '/verify.html'`);
  await evaluate(`document.querySelector('[name="otp"]').value=${JSON.stringify(otp)};document.querySelector('#verify button').click()`);
  await wait(1100);
  report.push({ step: "customer-dashboard", screenshot: await shot("04-customer-dashboard"), controls: await evaluate(`({url:location.pathname,logout:!!document.querySelector('#logout'),redeem:!!document.querySelector('#redeem button'),disconnects:document.querySelectorAll('[data-session]').length})`) });
}

await navigate("http://localhost:8081/login");
report.push({ step: "admin-login", screenshot: await shot("05-admin-login"), controls: await evaluate(`({submit:!!document.querySelector('#login button'),pinType:document.querySelector('[name="pin"]').type})`) });
await evaluate(`document.querySelector('[name="pin"]').value='2468';document.querySelector('#login button').click()`);
await wait(1100);
report.push({ step: "admin-dashboard", screenshot: await shot("06-admin-dashboard"), controls: await evaluate(`({url:location.pathname,buttons:[...document.querySelectorAll('button')].map(button=>({text:button.textContent.trim(),id:button.id,data:Object.keys(button.dataset)})),forms:[...document.querySelectorAll('form')].map(form=>form.id)})`) });

await viewport(390, 844, true);
await navigate("http://localhost:8080/onboarding.html");
report.push({ step: "customer-packages-mobile", screenshot: await shot("07-customer-packages-mobile"), controls: await evaluate(`({bodyWidth:document.body.scrollWidth,viewport:innerWidth,plans:document.querySelectorAll('[data-plan]').length})`) });

await writeFile(`${out}/report.json`, JSON.stringify({ report, consoleErrors: errors.map((error) => error.entry?.text || error.exceptionDetails?.text || "unknown") }, null, 2));
console.log(JSON.stringify({ report, consoleErrors: errors.length, output: `${out}/report.json` }, null, 2));
socket.close();
if (errors.length) process.exitCode = 1;
