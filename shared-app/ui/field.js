// Form field behaviour: inline errors, the PIN show/hide toggle and busy buttons.
import { t } from "../i18n.js";
import { currentLanguage, h, clear } from "./dom.js";
import { icon } from "./icons.js";

function langOf(element) {
  const holder = element.closest("[lang]");
  const lang = holder ? holder.getAttribute("lang") : "";
  return lang === "en" || lang === "fr" ? lang : currentLanguage();
}

function describedBy(input, id, present) {
  const ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter((value) => value && value !== id);
  if (present) ids.push(id);
  if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  else input.removeAttribute("aria-describedby");
}

// Shows `message` under the field and links it to the input; an empty message
// clears it. The error element is <p class="nd-error" id="{input id}-error">,
// created at the end of the input's .nd-field if the page has none.
export function setFieldError(input, message) {
  if (!input.id) throw new Error("setFieldError needs an input with an id.");
  const id = input.id + "-error";
  let error = document.getElementById(id);
  if (!error) {
    error = h("p", { class: "nd-error", id });
    const field = input.closest(".nd-field");
    if (field) field.appendChild(error);
    else input.parentNode.insertBefore(error, input.nextSibling);
  }
  clear(error);
  if (message) {
    error.appendChild(icon("alert", { size: 16, strokeWidth: 2 }));
    error.appendChild(h("span", { text: message }));
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
  describedBy(input, id, Boolean(message));
  return error;
}

export function clearFieldError(input) {
  return setFieldError(input, "");
}

// Moves focus to the first invalid field, for use after a failed submit.
export function focusFirstError(form) {
  const invalid = form.querySelector('[aria-invalid="true"]');
  if (invalid) invalid.focus();
  return invalid;
}

// PIN show/hide. Markup:
//   <div class="nd-pin">
//     <input class="nd-input" id="pin" type="password" inputmode="numeric" autocomplete="current-password">
//     <button type="button" class="nd-pin__toggle" data-nd-pin-toggle aria-controls="pin">Show</button>
//   </div>
// The visible word is "Show" / "Hide"; the accessible name is "Show PIN" /
// "Hide PIN", and the change is announced. The PIN is hidden again on submit.
// Safe to call again after a language change: it relabels without rebinding.
export function enhancePinToggles(root) {
  (root || document).querySelectorAll("[data-nd-pin-toggle]").forEach((button) => {
    const input = document.getElementById(button.getAttribute("aria-controls"));
    if (!input) return;
    const container = button.parentNode;
    let status = container.querySelector("[data-nd-pin-status]");
    if (!status) {
      status = h("span", { class: "nd-visually-hidden", "aria-live": "polite", "data-nd-pin-status": "" });
      container.appendChild(status);
    }
    const render = (announceChange) => {
      const lang = langOf(button), shown = input.type === "text";
      button.textContent = t(shown ? "uiPinHide" : "uiPinShow", lang);
      button.setAttribute("aria-label", t(shown ? "uiPinHideLabel" : "uiPinShowLabel", lang));
      if (announceChange) status.textContent = t(shown ? "uiPinShown" : "uiPinHidden", lang);
    };
    if (!button.hasAttribute("data-nd-ready")) {
      button.setAttribute("data-nd-ready", "");
      button.addEventListener("click", () => {
        input.type = input.type === "password" ? "text" : "password";
        render(true);
      });
      if (input.form) {
        input.form.addEventListener("submit", () => {
          if (input.type === "text") { input.type = "password"; render(false); }
        });
      }
    }
    render(false);
  });
}

// Marks a button as working: disabled, aria-busy, with a spinner before its
// label. setBusy(button, false) restores it.
export function setBusy(button, busy) {
  const spinner = button.querySelector("[data-nd-spinner]");
  if (busy) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (!spinner) button.insertBefore(h("span", { class: "nd-spinner", "aria-hidden": "true", "data-nd-spinner": "" }), button.firstChild);
  } else {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (spinner) spinner.parentNode.removeChild(spinner);
  }
}
