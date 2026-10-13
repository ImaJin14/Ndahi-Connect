const pending = new WeakSet();

export const isPending = (control) => pending.has(control);

// Lock related actions together so another submit or sign-in method cannot race
// the current request. Restore the controls even when the request fails.
export async function runButton(button, pendingText, task, { controls = [] } = {}) {
  const related = [...new Set([button, ...controls].filter(Boolean))];
  if (button.disabled || button.matches(":disabled") || related.some(isPending)) return;
  const original = button.textContent, busy = button.getAttribute("aria-busy"),
    disabled = related.map((control) => control.disabled);
  related.forEach((control) => { pending.add(control); control.disabled = true; });
  button.textContent = pendingText;
  button.setAttribute("aria-busy", "true");
  try { return await task(); }
  finally {
    related.forEach((control, index) => { pending.delete(control); control.disabled = disabled[index]; });
    button.textContent = original;
    if (busy === null) button.removeAttribute("aria-busy");
    else button.setAttribute("aria-busy", busy);
  }
}
