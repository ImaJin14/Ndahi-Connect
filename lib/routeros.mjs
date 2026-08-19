export function routerVoucherPayload(voucher) {
  if (!voucher?.id || !voucher?.code || !voucher?.planId || !voucher?.expiresAt) {
    throw new Error("Voucher is missing required RouterOS subscription fields");
  }
  const deviceLimit = Number(voucher.deviceLimit),
    quotaBytes = voucher.quotaBytes === null ? null : Number(voucher.quotaBytes);
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1) {
    throw new Error("Voucher device limit is invalid");
  }
  if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0)) {
    throw new Error("Voucher quota is invalid");
  }
  if (Number.isNaN(Date.parse(voucher.expiresAt))) {
    throw new Error("Voucher expiry is invalid");
  }
  return {
    schemaVersion: 1,
    voucherId: voucher.id,
    username: voucher.code,
    password: voucher.code,
    profileId: voucher.planId,
    expiresAt: voucher.expiresAt,
    limitBytesTotal: quotaBytes,
    simultaneousUsers: deviceLimit,
    enabled: voucher.status === "active",
  };
}

export class MockRouterOSAdapter {
  async syncVoucher(voucher) {
    const payload = routerVoucherPayload(voucher);
    return { synchronized: true, mode: "mock", voucherId: payload.voucherId };
  }
  async disconnectDevice(deviceId) {
    return { disconnected: true, mode: "mock", deviceId };
  }
  async disconnectVoucher(voucherId) {
    return { disconnected: true, mode: "mock", voucherId };
  }
  async readUsage() {
    return [];
  }
  async markInactive() {
    return { synchronized: true, mode: "mock" };
  }
}

export class RouterOSAdapter {
  constructor({ url, username, password }) {
    if (url && !/^https:\/\//i.test(url)) {
      throw new Error(
        "MIKROTIK_API_URL must use HTTPS through a VPN or restricted management network",
      );
    }
    this.url = url;
    this.username = username;
    this.password = password;
  }
  configured() {
    return Boolean(this.url && this.username && this.password);
  }
  async request(action, payload = {}) {
    if (!this.configured()) {
      throw new Error("MikroTik credentials are not configured");
    }
    const response = await fetch(
      `${this.url.replace(/\/$/, "")}/ndahi/${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${
            Buffer.from(`${this.username}:${this.password}`).toString("base64")
          }`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `MikroTik management request failed (${response.status})`,
      );
    }
    return response.json();
  }
  async syncVoucher(voucher) {
    return this.request("syncVoucher", routerVoucherPayload(voucher));
  }
  async disconnectDevice(deviceId) {
    return this.request("disconnectDevice", { deviceId });
  }
  async disconnectVoucher(voucherId) {
    return this.request("disconnectVoucher", { voucherId });
  }
  async readUsage() {
    return this.request("readUsage");
  }
  async markInactive() {
    return this.request("markInactive");
  }
}

export function routerAdapter(env = process.env) {
  return env.MIKROTIK_MODE === "live"
    ? new RouterOSAdapter({
      url: env.MIKROTIK_API_URL,
      username: env.MIKROTIK_USER,
      password: env.MIKROTIK_PASSWORD,
    })
    : new MockRouterOSAdapter();
}
