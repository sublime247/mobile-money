export type MobileNetworkName =
  | "MTN"
  | "AIRTEL"
  | "ORANGE"
  | "VODACOM"
  | "TIGO";

/**
 * Common network prefixes for target mobile money providers.
 * Keys are normalized numeric prefixes used to identify a destination network.
 */
export const NETWORK_PREFIXES: Record<string, MobileNetworkName> = {
  // Cameroon
  "23765": "ORANGE",
  "23766": "AIRTEL",
  "23767": "MTN",
  "23768": "MTN",
  "23769": "ORANGE",

  // Uganda
  "25670": "AIRTEL",
  "25675": "AIRTEL",
  "25677": "MTN",
  "25678": "MTN",

  // Ghana
  "23324": "MTN",
  "23326": "AIRTEL",
  "23354": "MTN",
  "23355": "MTN",
  "23356": "AIRTEL",
  "23357": "AIRTEL",
  "23359": "MTN",

  // Ivory Coast
  "22507": "ORANGE",

  // Senegal
  "22177": "ORANGE",

  // Tanzania — Vodacom
  "255740": "VODACOM",
  "255762": "VODACOM",
  "255763": "VODACOM",
  "255764": "VODACOM",
  "255765": "VODACOM",
  "255766": "VODACOM",
  "255767": "VODACOM",
  "255768": "VODACOM",
  "255769": "VODACOM",

  // Tanzania — Tigo
  "255713": "TIGO",
  "255714": "TIGO",
  "255715": "TIGO",
  "255716": "TIGO",
  "255717": "TIGO",
  "255718": "TIGO",
  "255719": "TIGO",
  "255752": "TIGO",
  "255753": "TIGO",
  "255754": "TIGO",
  "255755": "TIGO",
};
