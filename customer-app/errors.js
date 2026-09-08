export class ApiError extends Error {
  constructor(status, message, code) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function responseError(response, result = {}) {
  return new ApiError(response.status, result.error, result.code);
}

export function friendlyError(error, context = "general") {
  const name = String(error?.name || ""), message = String(error?.message || "");
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

export function showError(target, error, { context = "general", actions = [] } = {}) {
  const copy = friendlyError(error, context), card = document.createElement("div"),
    title = document.createElement("strong"), body = document.createElement("p");
  card.className = "error-card";
  card.setAttribute("role", "alert");
  title.textContent = copy.title;
  body.textContent = copy.message;
  card.append(title, body);
  if (actions.length) {
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
    card.append(controls);
  }
  target.replaceChildren(card);
}

export function saveReturnPath(path = location.pathname + location.search) {
  if (path.startsWith("/") && !path.startsWith("//")) sessionStorage.setItem("ndahi-return-to", path);
}

export function consumeReturnPath(fallback = "/dashboard") {
  const path = sessionStorage.getItem("ndahi-return-to");
  sessionStorage.removeItem("ndahi-return-to");
  return path?.startsWith("/") && !path.startsWith("//") ? path : fallback;
}
