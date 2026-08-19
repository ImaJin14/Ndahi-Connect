import { activationCode, VOUCHER_PATTERN } from "./security.mjs";

export function migrateVoucherCodes(state, { generate = activationCode } = {}) {
  if (!state || !Array.isArray(state.vouchers)) {
    throw new Error("Voucher migration requires a valid state object");
  }
  const used = new Set(), changes = [];
  for (const voucher of state.vouchers) {
    if (VOUCHER_PATTERN.test(voucher.code) && !used.has(voucher.code)) {
      used.add(voucher.code);
      continue;
    }
    const previousCode = voucher.code;
    let code;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = generate();
      if (VOUCHER_PATTERN.test(candidate) && !used.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error(`Unable to generate a unique code for voucher ${voucher.id}`);
    voucher.code = code;
    used.add(code);
    changes.push({ voucherId: voucher.id, previousCode, code });
  }
  return { examined: state.vouchers.length, migrated: changes.length, changes };
}
