// Compatibility exports for older open pages. Authenticator access has retired.
export function renderAuthenticatorSetup(container) { if (container) container.textContent = "Use PIN or passkey in Account."; }
export function mountAuthenticatorManagement({ container } = {}) { if (container) container.remove(); return {}; }
