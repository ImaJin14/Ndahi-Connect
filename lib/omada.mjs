export class MockOmadaAdapter {
  async status() {
    return {
      configured: false,
      mode: "mock",
      connected: true,
      accessPoints: [],
    };
  }
}

export class OmadaAdapter {
  constructor({ url, token, siteId = "Default" }) {
    this.url = url;
    this.token = token;
    this.siteId = siteId;
  }
  configured() {
    return Boolean(this.url && this.token);
  }
  async request(path) {
    if (!this.configured()) {
      throw new Error("Omada controller is not configured");
    }
    if (!/^https:\/\//i.test(this.url)) {
      throw new Error("OMADA_API_URL must use HTTPS");
    }
    const response = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Omada controller request failed (${response.status})`);
    }
    return response.json();
  }
  async status() {
    const result = await this.request(
      `/openapi/v1/${encodeURIComponent(this.siteId)}/aps`,
    );
    const accessPoints = result.result?.data || result.data || [];
    return { configured: true, mode: "live", connected: true, accessPoints };
  }
}

export function omadaAdapter(env = process.env) {
  return env.OMADA_MODE === "live"
    ? new OmadaAdapter({
      url: env.OMADA_API_URL,
      token: env.OMADA_API_TOKEN,
      siteId: env.OMADA_SITE_ID,
    })
    : new MockOmadaAdapter();
}
