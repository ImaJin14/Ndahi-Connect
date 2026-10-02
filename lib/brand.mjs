// Shared look and formatting for customer documents: the voucher email and receipts.
export const palette = Object.freeze({
  ink: "#082d25",
  lime: "#b4f228",
  card: "#f4f8f4",
  line: "#d8e3dc",
  muted: "#587069",
  page: "#eef3ee",
  onInk: "#cfe0d6",
});

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

export const money = (amount, currency = "XAF") =>
  new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);

// Customers are in Cameroon; an unparseable historical value is shown as recorded.
export function doualaTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Douala" }).format(date)} (Africa/Douala)`;
}
