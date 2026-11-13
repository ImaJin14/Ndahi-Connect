// Progress components: vertical steps (order progress), the horizontal
// stepper (admin network setup), "Step 1 of 3" and the data meter.
import { format, t } from "../i18n.js";
import { currentLanguage, h } from "./dom.js";
import { icon } from "./icons.js";

const STATE_TEXT = { done: "uiStepDone", current: "uiStepCurrent", todo: "uiStepTodo" };

// renderSteps([{ title, meta, state: "done" | "current" | "todo" }], { label })
export function renderSteps(steps, options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  return h("ol", { class: "nd-steps", "aria-label": settings.label },
    steps.map((step) => {
      const state = STATE_TEXT[step.state] ? step.state : "todo";
      return h("li", {
        class: "nd-steps__item nd-steps__item--" + state,
        "aria-current": state === "current" ? "step" : null,
      },
      h("span", { class: "nd-steps__dot", "aria-hidden": "true" }, state === "done" ? icon("check", { size: 12, strokeWidth: 3.5 }) : null),
      h("span", null,
        h("strong", { class: "nd-steps__title" }, step.title, h("span", { class: "nd-visually-hidden", text: ", " + t(STATE_TEXT[state], lang) })),
        step.meta ? h("span", { class: "nd-steps__meta", text: step.meta }) : null));
    }));
}

// renderStepper(["Router", "Access points", "Wi-Fi", "Review"], { current: 1, onSelect })
// `current` is the zero-based index. With onSelect the steps are buttons.
export function renderStepper(labels, options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  const current = settings.current || 0;
  return h("ol", { class: "nd-stepper", "aria-label": settings.label },
    labels.map((label, index) => {
      const done = index < current, on = index === current;
      return h("li", null, h(settings.onSelect ? "button" : "span", {
        class: "nd-stepper__step" + (done ? " nd-stepper__step--done" : ""),
        type: settings.onSelect ? "button" : null,
        "aria-current": on ? "step" : null,
        onClick: settings.onSelect ? () => settings.onSelect(index) : null,
      },
      h("span", { class: "nd-stepper__num", "aria-hidden": "true" }, done ? icon("check", { size: 14, strokeWidth: 2.6 }) : String(index + 1)),
      label,
      done ? h("span", { class: "nd-visually-hidden", text: ", " + t("uiStepDone", lang) }) : null));
    }));
}

// "Step 1 of 3" (1-based).
export function stepCount(current, total, lang) {
  return format("uiStepCount", { current, total }, lang || currentLanguage());
}

// The meter is decorative: always show the amount as text next to it
// (for example "3.2 GB of 5 GB left"). `fraction` runs from 0 to 1.
export function renderMeter(fraction) {
  const meter = h("div", { class: "nd-meter", "aria-hidden": "true" }, h("div", { class: "nd-meter__fill" }));
  setMeter(meter, fraction);
  return meter;
}

export function setMeter(meter, fraction) {
  const value = Math.min(1, Math.max(0, Number(fraction) || 0));
  const fill = meter.querySelector(".nd-meter__fill");
  // CSSOM writes are allowed by the CSP; style="" attributes are not.
  if (fill) fill.style.width = Math.round(value * 1000) / 10 + "%";
  return meter;
}
