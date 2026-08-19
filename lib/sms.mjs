export class MockSmsAdapter {
  async sendOtp({ phone, code }) {
    return { delivered: true, provider: "mock", phone, developmentCode: code };
  }
}

export class HttpSmsAdapter {
  constructor({ url, apiKey, sender = "NDAHI" }) {
    this.url = url;
    this.apiKey = apiKey;
    this.sender = sender;
  }

  configured() {
    return Boolean(this.url && this.apiKey);
  }

  async sendOtp({ phone, code }) {
    if (!this.configured()) throw new Error("SMS provider is not configured");
    if (!/^https:\/\//i.test(this.url)) {
      throw new Error("SMS_API_URL must use HTTPS");
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: `+237${phone}`,
        from: this.sender,
        message:
          `Your NDAHI Connect verification code is ${code}. It expires in 5 minutes.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`SMS delivery failed (${response.status})`);
    }
    return { delivered: true, provider: "http", phone };
  }
}

export function smsAdapter(env = process.env) {
  return (env.OTP_DELIVERY || "mock") === "mock"
    ? new MockSmsAdapter()
    : new HttpSmsAdapter({
      url: env.SMS_API_URL,
      apiKey: env.SMS_API_KEY,
      sender: env.SMS_SENDER,
    });
}
