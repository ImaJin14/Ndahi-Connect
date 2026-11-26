// The hotspot's name on the Wi-Fi page (PhoneHotspot, #404; owner 26 Nov):
// "Choose how you'd like to get online at <name>." Set by the owner in
// Network setup, in English and French; blank leaves the sentence without it.
const MAX = 40;
const clean = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

export function validHotspotName(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Give the hotspot's name in English and French." };
  const en = clean(input.en), fr = clean(input.fr);
  if (typeof input.en !== "string" || typeof input.fr !== "string") return { error: "Give the hotspot's name in English and French." };
  if (en.length > MAX || fr.length > MAX) return { error: `Keep the hotspot's name to ${MAX} characters.` };
  if (/[<>]/.test(en + fr)) return { error: "The hotspot's name can't contain < or >." };
  return { value: { en, fr } };
}

// What the public status shows: the name in each language (French falls back
// to English), or nothing when it isn't set.
export function hotspotNameView(zone) {
  const name = zone?.hotspotName, en = clean(name?.en), fr = clean(name?.fr) || en;
  return en || fr ? { en: en || fr, fr } : null;
}
