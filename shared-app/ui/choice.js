// Single-choice groups and tabs.
//
// enhanceChoiceGroup: buttons with aria-pressed inside a role="group", one
// pressed at a time. Used by the segmented control (language), option cards
// (plans, payment methods) and filter chips.
//   <div class="nd-segmented" role="group" aria-label="Language">
//     <button type="button" class="nd-segmented__option" aria-pressed="true" value="en">English</button>
//     <button type="button" class="nd-segmented__option" aria-pressed="false" value="fr">Français</button>
//   </div>
//
// enhanceTabs: the segmented control as tabs that switch panels, with arrow,
// Home and End keys (WAI-ARIA tabs pattern, automatic activation).
//   <div class="nd-segmented" role="tablist" aria-label="Internet">
//     <button type="button" class="nd-segmented__option" role="tab" id="tab-bundles"
//       aria-selected="true" aria-controls="panel-bundles">Bundles</button> …
//   </div>
//   <section id="panel-bundles" role="tabpanel" aria-labelledby="tab-bundles">…</section>

function valueOf(button) {
  return button.value || button.getAttribute("data-value") || button.id;
}

export function enhanceChoiceGroup(group, options) {
  const settings = options || {};
  const buttons = () => Array.prototype.slice.call(group.querySelectorAll("[aria-pressed]"));
  const select = (button, notify) => {
    buttons().forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    if (notify && settings.onChange) settings.onChange(valueOf(button), button);
  };
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[aria-pressed]");
    if (!button || !group.contains(button) || button.disabled) return;
    if (button.getAttribute("aria-pressed") === "true") return;
    select(button, true);
  });
  return {
    value() {
      const pressed = buttons().filter((button) => button.getAttribute("aria-pressed") === "true")[0];
      return pressed ? valueOf(pressed) : null;
    },
    select(value) {
      const match = buttons().filter((button) => valueOf(button) === value)[0];
      if (match) select(match, false);
    },
  };
}

export function enhanceTabs(tablist, options) {
  const settings = options || {};
  const tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
  const activate = (tab, focus, notify) => {
    tabs.forEach((other) => {
      const on = other === tab;
      other.setAttribute("aria-selected", String(on));
      other.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(other.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    if (notify && settings.onChange) settings.onChange(valueOf(tab), tab);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab, false, true));
    tab.addEventListener("keydown", (event) => {
      const keys = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
      if (!(event.key in keys)) return;
      event.preventDefault();
      activate(tabs[(keys[event.key] + tabs.length) % tabs.length], true, true);
    });
  });
  const initial = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")[0] || tabs[0];
  if (initial) activate(initial, false, false);
  return {
    select(value) {
      const match = tabs.filter((tab) => valueOf(tab) === value)[0];
      if (match) activate(match, false, false);
    },
  };
}
