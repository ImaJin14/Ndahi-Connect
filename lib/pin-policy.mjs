// Customer PINs are 4 to 6 digits (PhoneForgotPin and PhoneChangePin, #399;
// owner 26 Nov). PINs set before this are 4 digits and keep working. Staff PINs
// follow their own rule (lib/api/admin-profile.mjs).
export const CUSTOMER_PIN_PATTERN = "[0-9]{4,6}";
export const validCustomerPin = (value) => /^\d{4,6}$/.test(String(value ?? ""));
export const CUSTOMER_PIN_RULE = "Your PIN must be 4 to 6 digits.";
