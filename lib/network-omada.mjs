import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const at = (object, path) => String(path || "").split(".").filter(Boolean).reduce((v, k) => v?.[k], object);
const set = (object, path, value) => {
  const parts = path.split(".");
  if (parts.some((k) => ["__proto__", "constructor", "prototype"].includes(k))) throw Error("Invalid controller profile.");
  let target = object;
  for (const k of parts.slice(0, -1)) target = target[k] ??= {};
  target[parts.at(-1)] = value;
};

// Write schemas vary across controller releases. A deployment-owned profile
// must be taken from that controller's Platform Integration API document.
// No arbitrary URL, method, or vendor payload is accepted from the browser.
export class OmadaProvisioner {
  constructor(connection, { profile, fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) { this.c = connection; this.profile = profile; this.fetcher = fetcher; this.wait = wait; }
  async raw(path, method = "GET", payload, token) {
    if (!path.startsWith("/openapi/") || path.includes("..") || path.includes("\\") || path.includes("#")) throw Error("Invalid Open API path.");
    const response = await this.fetcher(this.c.url + path, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", ...(token ? { authorization: `AccessToken=${token}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) throw Error(`Omada request failed (${response.status}).`);
    let result;
    try { result = await response.json(); } catch { throw Error("Omada returned an invalid response."); }
    if (result.errorCode !== 0) throw Error("Omada rejected the request. Verify API permissions and controller compatibility.");
    return result.result;
  }
  async request(path, method = "GET", payload) {
    if (!this.token || Date.now() >= this.tokenExpires) {
      this.authorizing ??= (async () => {
        const result = await this.raw("/openapi/authorize/token?grant_type=client_credentials", "POST", { omadacId: this.c.controllerId, client_id: this.c.clientId, client_secret: this.c.clientSecret });
        if (!result?.accessToken) throw Error("Omada did not issue an access token.");
        this.token = result.accessToken; this.tokenExpires = Date.now() + Math.max(0, Math.min(Number(result.expiresIn || 3600), 3600) - 60) * 1000;
      })().finally(() => { this.authorizing = undefined; });
      await this.authorizing;
    }
    return this.raw(path, method, payload, this.token);
  }
  path(template, config = {}) {
    return template.replace(/\{(controllerId|siteId|wlanId|ssidId|mac)\}/g, (_, key) => encodeURIComponent(config[key] ?? this.c[key] ?? ""));
  }
  base() { return `/openapi/v1/${encodeURIComponent(this.c.controllerId)}/sites/${encodeURIComponent(this.c.siteId)}`; }
  async pages(path) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=100`);
      if (!Array.isArray(result?.data)) throw Error("Unsupported Omada inventory response.");
      all.push(...result.data);
      if (result.data.length < 100 || (Number.isFinite(result.totalRows) && all.length >= result.totalRows)) return all;
    }
    throw Error("Controller inventory exceeds the supported site size.");
  }
  async compatible() {
    const p = this.profile;
    if (!p?.versionPath || !p?.versionField || !Array.isArray(p.versions)) return false;
    const value = await this.request(this.path(p.versionPath));
    return p.versions.includes(String(at(value, p.versionField)));
  }
  async inventory() {
    return this.pages(this.base() + `/wireless-network/wlans/${encodeURIComponent(this.c.wlanId)}/ssids`);
  }
  async discover() {
    const [devices, ssids, compatible] = await Promise.all([this.pages(this.base() + "/devices"), this.inventory(), this.compatible()]);
    return { accessPoints: devices.filter((d) => d.type === "ap" || d.type === "eap" || d.type === 1).map((d) => ({ name: d.name, mac: d.mac, model: d.model, status: d.status })),
      ssids: ssids.map((s) => ({ id: s.id, name: s.name || s.ssidName })), capabilities: { configureSsid: compatible && Boolean(this.profile.ssid), adopt: compatible && Boolean(this.profile.adopt) },
      message: compatible ? "Controller matches the installed API profile." : "Monitoring is available. Install a version-matched controller API profile to enable SSID configuration and adoption." };
  }
  async preview(input) {
    if (!await this.compatible()) throw Error("Controller provisioning requires a server-side API profile matching the controller version. Use Omada Platform Integration → Online API Document.");
    if (input.action === "adopt") {
      const recipe = this.profile.adopt;
      if (!recipe || !/^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(input.mac || "")) throw Error("Select a supported AP MAC address.");
      const devices = await this.pages(this.base() + "/devices"), device = devices.find((d) => d.mac?.toLowerCase() === input.mac.toLowerCase());
      if (!device || !recipe.pendingStates.includes(at(device, recipe.stateField))) throw Error("AP is not in a supported adoption state in this site.");
      return { config: { action: "adopt", mac: input.mac }, fingerprint: hash(device), conflicts: [], warnings: ["Adoption transfers device management to this controller site. Recovery requires the controller interface."], changes: [`Adopt ${input.mac} into the configured site`] };
    }
    const r = this.profile.ssid;
    if (!r) throw Error("SSID configuration is unsupported by the installed profile.");
    const config = { action: "ssid", ssidId: String(input.ssidId || ""), name: String(input.name || ""), security: input.security, password: String(input.password || ""), vlan: Number(input.vlan || 0), isolation: true };
    if (!config.name.trim() || Buffer.byteLength(config.name) > 32 || /[\x00-\x1f]/.test(config.name)) throw Error("Wi-Fi name must contain 1–32 bytes without control characters.");
    if (!["open", "wpa2"].includes(config.security) || !Number.isInteger(config.vlan) || config.vlan < 0 || config.vlan > 4094) throw Error("Select a supported security mode and VLAN (0 means untagged).");
    if (config.security === "wpa2" && (!/^[\x20-\x7e]{8,63}$/.test(config.password))) throw Error("WPA2 password must be 8–63 printable ASCII characters.");
    if (config.security === "open") config.password = "";
    const inventory = await this.inventory(), before = inventory.find((s) => String(s.id) === config.ssidId);
    if (config.ssidId && !before) throw Error("SSID no longer exists.");
    if (!before && !r.create) throw Error("This controller profile supports updates only.");
    if (inventory.some((s) => (s.name || s.ssidName) === config.name && String(s.id) !== config.ssidId)) throw Error("Another SSID already has this name.");
    const payload = structuredClone(r.defaults || {});
    for (const [field, path] of Object.entries(r.fields || {})) {
      if (!Object.hasOwn(config, field)) throw Error("Invalid SSID field mapping.");
      let value = config[field];
      if (r.values?.[field]) {
        value = r.values[field][String(value)];
        if (value === undefined) throw Error("This setting is unsupported by the profile.");
      }
      set(payload, path, value);
    }
    if (!["name", "security", "password", "vlan", "isolation"].every((k) => r.fields?.[k])) throw Error("Controller profile must map all Wi-Fi settings including client isolation.");
    const restore = {};
    if (before) for (const path of Object.values(r.fields)) {
      const value = at(before, path);
      if (value === undefined || (path === r.fields.password && String(value).includes("***"))) throw Error("Controller does not provide restorable SSID settings; use its interface for this change.");
      set(restore, path, value);
    }
    return { config, payload, before: before ? { payload: { ...structuredClone(r.defaults || {}), ...restore }, fingerprint: hash(before) } : null,
      fingerprint: hash(inventory), conflicts: [], warnings: ["Changing Wi-Fi settings can disconnect wireless clients. Keep a wired management connection.", "For the simple MikroTik topology use VLAN 0; tagged VLANs require matching switch and gateway configuration."], changes: [`${before ? "Update" : "Create"} Wi-Fi ${config.name}`, `Security: ${config.security}; VLAN: ${config.vlan || "untagged"}; client isolation enabled`] };
  }
  async execute(recipe, config, payload) {
    if (!recipe || !["POST", "PATCH", "PUT", "DELETE"].includes(recipe.method)) throw Error("Unsupported controller write operation.");
    return this.request(this.path(recipe.path, config), recipe.method, payload);
  }
  async apply(plan, progress) {
    if (!await this.compatible()) throw Error("Controller version changed.");
    if (plan.config.action === "adopt") {
      const fresh = await this.preview(plan.config);
      if (fresh.fingerprint !== plan.fingerprint) throw Error("Device state changed; preview again.");
      const r = this.profile.adopt, payload = structuredClone(r.payload || {});
      set(payload, r.macField, plan.config.mac);
      await progress("Requesting AP adoption");
      await this.execute(r, plan.config, payload);
      for (let attempt = 0; attempt < 24; attempt++) {
        const device = (await this.pages(this.base() + "/devices")).find((d) => d.mac?.toLowerCase() === plan.config.mac.toLowerCase());
        if (device && r.adoptedStates.includes(at(device, r.stateField))) return;
        await progress(`Waiting for AP adoption (${attempt + 1}/24)`);
        await this.wait(5000);
      }
      throw Error("Adoption is still pending; inspect the controller before retrying.");
    }
    if (hash(await this.inventory()) !== plan.fingerprint) throw Error("SSID configuration changed; preview again.");
    const r = this.profile.ssid;
    await progress("Applying reviewed Wi-Fi settings");
    await this.execute(plan.before ? r.update : r.create, plan.config, plan.payload);
    const current = (await this.inventory()).find((s) => plan.config.ssidId ? String(s.id) === plan.config.ssidId : at(s, r.fields.name) === plan.config.name);
    if (!current || Object.values(r.fields).filter((path) => path !== r.fields.password).some((path) => at(current, path) !== at(plan.payload, path))) throw Error("Controller read-back did not match the requested Wi-Fi settings.");
  }
  async rollback(plan) {
    if (!await this.compatible()) throw Error("Controller version changed; recover locally.");
    if (plan.config.action === "adopt") throw Error("Adoption recovery must be completed in the Omada controller.");
    const r = this.profile.ssid;
    if (!plan.before) throw Error("Recover new SSID creation in the controller; an uncertain create response cannot safely identify ownership.");
    const current = (await this.inventory()).find((s) => String(s.id) === plan.config.ssidId);
    if (!current) throw Error("SSID disappeared; recover locally.");
    const matches = (payload) => Object.values(r.fields).every((path) => at(current, path) === at(payload, path));
    if (!matches(plan.payload) && !matches(plan.before.payload)) throw Error("SSID changed outside this job; recover locally.");
    await this.execute(r.update, plan.config, plan.before.payload);
    const restored = (await this.inventory()).find((s) => String(s.id) === plan.config.ssidId);
    if (!restored || Object.values(r.fields).filter((path) => path !== r.fields.password).some((path) => at(restored, path) !== at(plan.before.payload, path))) throw Error("SSID rollback could not be verified.");
  }
}
