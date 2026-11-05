// Capabilities, not a manufacturer/OUI/model allow-list. The gateway can prove
// the upstream session, but it cannot see through NAT to certify the private LAN.
export const homeCompatibility = Object.freeze({
  contract: "wisp-nat-ipv4-v1",
  vendorIndependent: true,
  vendorConfiguration: "customer-managed",
  required: ["wireless-upstream", "ipv4-nat", "private-lan", "stable-upstream-mac"],
  privateLanOptions: ["integrated-wifi", "ethernet-clients", "external-lan-access-point"],
  unsupportedModes: ["bridge-only", "repeater-without-nat"],
  identityProof: "single-use-local-gateway-session",
  setupEvidence: "owner-declaration-and-physical-pilot",
  modelCertification: false,
});

export const homeGatewayCheckIds = Object.freeze([
  "hotspot_https_configured", "enrollment_forwarding", "home_forwarding", "required_destinations",
  "fasttrack_exclusion", "guest_ipv6_block",
]);
