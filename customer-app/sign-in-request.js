import { requestJson } from "./compat.js";
import { responseError } from "./errors.js";

const phoneNumber = (value) => String(value || "").replace(/\D/g, "").replace(/^237/, "");

// Completing a challenge can issue a session even when its response is lost.
// Check the expected account before asking the customer to try again; never
// automatically replay the one-use completion request.
export async function completeSignIn(api, path, data, phone) {
  try {
    const { response, body } = await requestJson(api + path, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    });
    if (!response.ok) throw responseError(response, body);
    return body;
  } catch (error) {
    if (["TimeoutError", "TypeError", "SyntaxError"].includes(error.name)) {
      try {
        const { response, body } = await requestJson(api + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
        if (response.ok && body.customer && phoneNumber(phone) && phoneNumber(body.customer.phone) === phoneNumber(phone)) return { recovered: true };
      } catch (_) { /* Preserve the original completion failure. */ }
    }
    throw error;
  }
}
