// Short receipt numbers (#369, owner 27 Nov): "NC-2411-0457" for the receipt
// and "NC-PAY-2411-0457" for its payment, numbered per month (Douala time).
// The month's counter lives in the `receiptNumbers` setting, so two receipts
// written at once conflict on it and one retries: numbers never repeat.
// Receipts issued before this keep the numbers they were issued with.
const pad = (n) => String(n).padStart(4, "0");
export function receiptMonth(at) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Douala", year: "2-digit", month: "2-digit" }).formatToParts(new Date(at));
  const part = (type) => parts.find((p) => p.type === type)?.value || "00";
  return part("year") + part("month");
}
export function nextReceiptNumber(s, at) {
  const month = receiptMonth(at);
  const counters = s.receiptNumbers && typeof s.receiptNumbers === "object" ? { ...s.receiptNumbers } : {};
  const serial = (Number.isSafeInteger(counters[month]) ? counters[month] : 0) + 1;
  counters[month] = serial;
  s.receiptNumbers = counters;
  return { number: `NC-${month}-${pad(serial)}`, paymentNumber: `NC-PAY-${month}-${pad(serial)}` };
}
