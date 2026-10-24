import { customerDestination } from "./customer-destination.js";
import { replaceContent, sessionStore } from "./compat.js";

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function responseError(response, result = {}) {
  const error = new ApiError(response.status, result.error, result.code);
  if (result.code === "PAYMENT_IN_PROGRESS") {
    error.retryAfterSeconds = Number(result.retryAfterSeconds);
    if (result.payment && typeof result.payment.id === "string") error.payment = result.payment;
  }
  return error;
}

export function friendlyError(error, context = "general") {
  const name = String(error && error.name || ""), message = String(error && error.message || "");
  if (name === "TimeoutError") return { title: "Taking longer than expected", message: "Stay on NDAHI Wi-Fi and try again. Your details have been kept on this page." };
  if (context === "passkey") {
    if (name === "NotAllowedError" || name === "AbortError" || /timed out|not allowed|abort signal/i.test(message)) {
      return { title: "Passkey not completed", message: "No passkey was used. Try again or sign in with your voucher and PIN." };
    }
    if (name === "InvalidStateError") {
      return { title: "Passkey already connected", message: "This passkey is already connected to your account." };
    }
    if (name === "NotSupportedError") {
      return { title: "Passkeys unavailable", message: "Passkeys aren’t supported on this device. Use voucher and PIN instead." };
    }
    if (name === "SecurityError") {
      return { title: "Secure portal required", message: "Passkeys are unavailable here. Open the secure NDAHI portal and try again." };
    }
    if (!(error instanceof ApiError)) {
      return { title: "Passkey verification failed", message: "We couldn’t complete passkey verification. Please try another sign-in method." };
    }
  }
  if (error instanceof ApiError) {
    if (error.status >= 500) return { title: "Service temporarily unavailable", message: "We couldn’t complete that request. Please wait a moment and try again." };
    return { title: "Unable to continue", message: error.message || "Check your details and try again." };
  }
  if (name === "TypeError" || /fetch|network|offline/i.test(message)) {
    return { title: "Connection problem", message: "Check your internet connection and try again." };
  }
  return { title: "Something went wrong", message: "We couldn’t complete that request. Please try again." };
}

export function whatsappSupportUrl({ phone, voucher, mac, error, context } = {}) {
  const config = window.NDAHI_CONFIG || {};
  const supportNumber = String(config.supportPhone || "").replace(/[^0-9]/g, "");
  if (!supportNumber) return null;
  const lines = [
    "Hello NDAHI Support,",
    "I need assistance with my NDAHI Connect account / connection.",
    phone ? `Phone: ${phone}` : "",
    voucher ? `Voucher: ${voucher}` : "",
    mac ? `Device MAC: ${mac}` : "",
    context ? `Area: ${context}` : "",
    error ? `Details: ${error}` : "",
  ].filter(Boolean);
  return `https://wa.me/${encodeURIComponent(supportNumber)}?text=${encodeURIComponent(lines.join("\n"))}`;
}

export function showError(target, error, { context = "general", actions = [], includeSupport = false, diagnostics = {} } = {}) {
  const copy = friendlyError(error, context), card = document.createElement("div"),
    title = document.createElement("strong"), body = document.createElement("p");
  card.className = "error-card";
  card.setAttribute("role", "alert");
  title.textContent = copy.title;
  body.textContent = copy.message;
  card.append(title, body);
  const errorMsg = (error && error.message) || copy.message;
  const waUrl = whatsappSupportUrl({ phone: diagnostics.phone, voucher: diagnostics.voucher, mac: diagnostics.mac, context: context, error: errorMsg });
  if (actions.length || (waUrl && includeSupport)) {
    const controls = document.createElement("div");
    controls.className = "error-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-action";
      button.textContent = action.label;
      button.onclick = action.run;
      controls.append(button);
    }
    if (waUrl && includeSupport) {
      const waLink = document.createElement("a");
      waLink.className = "button secondary-action whatsapp-support-link";
      waLink.href = waUrl;
      waLink.target = "_blank";
      waLink.rel = "noopener";
      waLink.textContent = "💬 WhatsApp support";
      controls.append(waLink);
    }
    card.append(controls);
  }
  replaceContent(target, card);
}

export function saveReturnPath(path = location.pathname + location.search + location.hash) {
  const safe = customerDestination(path, null);
  if (safe) sessionStore.set("ndahi-return-to", safe);
  else sessionStore.remove("ndahi-return-to");
}

export function consumeReturnPath(fallback = "/dashboard") {
  const path = sessionStore.get("ndahi-return-to");
  sessionStore.remove("ndahi-return-to");
  return customerDestination(path, fallback);
}
