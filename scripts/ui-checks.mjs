// Shared browser checks for redesigned (v2) pages.
// Measures every rendered text run against the background it actually sits
// on (semi-transparent layers blended), so a light-surface colour used on a
// dark surface fails here even though each token pair passes on its own.
// Large text (24px, or 18.66px bold) needs 3:1, the rest 4.5:1.
export const lowContrastText = (page) => page.evaluate(() => {
  const rgba = (value) => {
    const parts = value.match(/[\d.]+/g).map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const blend = ([r, g, b, a], under) => [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) { layers.push(colour); if (colour[3] === 1) break; }
    }
    return layers.reduceRight((under, layer) => blend(layer, under), [255, 255, 255]);
  };
  const failures = [];
  document.querySelectorAll("body *").forEach((element) => {
    const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
    const box = element.getBoundingClientRect();
    if (!text || !box.width || !box.height || element.closest(".nd-visually-hidden, [disabled], [aria-disabled='true'], .nd-skip-link")) return;
    const style = getComputedStyle(element);
    const under = backdrop(element), colour = blend(rgba(style.color), under);
    const [light, dark] = [luminance(colour), luminance(under)].sort((a, b) => b - a);
    const ratio = (light + 0.05) / (dark + 0.05), size = parseFloat(style.fontSize);
    const minimum = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    if (ratio < minimum) failures.push(`${element.tagName}.${element.className} "${text.slice(0, 30)}" ${ratio.toFixed(2)}:1`);
  });
  return failures;
});
