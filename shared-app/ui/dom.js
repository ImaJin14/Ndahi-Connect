// Small DOM helpers for the design kit. Text always goes in through
// textContent, never innerHTML, so API data cannot inject markup.
// Browser floor: Chrome 73 / Safari 12.1, so no ?. or ?? in kit modules.
import { getPreferredLanguage, t } from "../i18n.js";

const LANGUAGES = ["en", "fr"];

// h("a", { class: "nd-btn", href: "/x", onClick }, icon("back"), "Back")
// Attributes set to null, undefined or false are skipped. `style` takes an
// object and is applied through CSSOM, which the CSP allows (a style="" string
// attribute would be blocked and reported).
export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  const attributes = props || {};
  Object.keys(attributes).forEach((key) => {
    const value = attributes[key];
    if (value === null || value === undefined || value === false) return;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "dataset") Object.keys(value).forEach((name) => { element.dataset[name] = value[name]; });
    else if (key === "style") Object.keys(value).forEach((name) => { element.style[name] = value[name]; });
    else if (/^on[A-Z]/.test(key) && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  });
  append(element, children);
  return element;
}

export function append(parent, children) {
  [].concat(children).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return append(parent, child);
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  });
  return parent;
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

// The kit follows <html lang>. Pages set it once with setDocumentLanguage().
export function currentLanguage() {
  const lang = typeof document !== "undefined" ? document.documentElement.getAttribute("lang") : "";
  return LANGUAGES.indexOf(lang) >= 0 ? lang : getPreferredLanguage();
}

export function setDocumentLanguage(lang) {
  const selected = LANGUAGES.indexOf(lang) >= 0 ? lang : "en";
  document.documentElement.setAttribute("lang", selected);
  return selected;
}

// Fills static HTML from the dictionary:
//   <h1 data-i18n="key">English fallback</h1>
//   <button data-i18n-aria-label="key">
// Use data-i18n only on elements whose content is plain text.
const ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];
export function localize(root, lang, lookup) {
  const scope = root || document;
  const read = lookup || t;
  const selected = lang || currentLanguage();
  scope.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = read(element.getAttribute("data-i18n"), selected);
  });
  ATTRIBUTES.forEach((attribute) => {
    scope.querySelectorAll("[data-i18n-" + attribute + "]").forEach((element) => {
      element.setAttribute(attribute, read(element.getAttribute("data-i18n-" + attribute), selected));
    });
  });
  return selected;
}

// Screen-reader announcement through one polite live region that stays in
// the page, so messages are read even when the visible text is replaced.
let liveRegion;
export function announce(message) {
  if (!liveRegion || !document.body.contains(liveRegion)) {
    liveRegion = h("div", { class: "nd-visually-hidden", role: "status", "aria-live": "polite", "data-nd-live": "" });
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = "";
  // A short delay lets screen readers notice the change, including repeats.
  setTimeout(() => { liveRegion.textContent = message; }, 60);
}
