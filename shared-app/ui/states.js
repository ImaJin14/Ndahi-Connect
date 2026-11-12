// Full-screen and inline states: success, waiting, error, info and empty.
//   renderState({ tone: "waiting", title: "Approve on your phone", body: "…",
//                 list: ["Open the payment prompt", "…"], actions: [button] })
// Put the primary actions in an .nd-actionbar instead when the screen has one.
import { announce, h } from "./dom.js";
import { icon } from "./icons.js";

const TONES = { success: "check", waiting: "phoneWait", error: "alert", info: "internet", empty: "activity" };

export function renderState(options) {
  const settings = options || {};
  const tone = TONES[settings.tone] ? settings.tone : "empty";
  const level = "h" + Math.min(6, Math.max(1, Number(settings.headingLevel) || 1));
  const state = h("section", {
    class: "nd-state nd-state--" + tone + (settings.compact ? " nd-state--compact" : ""),
    "aria-labelledby": settings.id ? settings.id + "-title" : null,
    id: settings.id,
  },
  h("div", { class: "nd-state__icon", "aria-hidden": "true" }, icon(settings.icon || TONES[tone], { size: settings.compact ? 26 : 38, strokeWidth: tone === "success" ? 2.2 : 1.8 })),
  h(level, { class: "nd-state__title", id: settings.id ? settings.id + "-title" : null, tabindex: settings.focus ? "-1" : null, text: settings.title }),
  settings.body ? h("p", { class: "nd-state__body" }, settings.body) : null,
  settings.list && settings.list.length ? h("ol", { class: "nd-state__list" }, settings.list.map((item) => h("li", null, item))) : null,
  settings.actions && settings.actions.length ? h("div", { class: "nd-state__actions" }, settings.actions) : null);
  // Waiting screens change on their own, so their title is announced unless
  // the caller passes announce: false.
  const shouldAnnounce = settings.announce === undefined ? tone === "waiting" : settings.announce;
  if (shouldAnnounce) announce(settings.title);
  return state;
}

// Moves focus to a state's title after it replaces a form, so keyboard and
// screen-reader users start reading from the new screen.
export function focusState(state) {
  const title = state.querySelector(".nd-state__title");
  if (!title) return;
  if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
  title.focus();
}
