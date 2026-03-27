import * as StellarSdk from "stellar-sdk";

export const STELLAR_NETWORKS = {
  TESTNET: "testnet",
  MAINNET: "mainnet",
} as const;

export type StellarNetwork =
  (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS];

const HORIZON_URLS = {
  [STELLAR_NETWORKS.TESTNET]: "https://horizon-testnet.stellar.org",
  [STELLAR_NETWORKS.MAINNET]: "https://horizon.stellar.org",
};

const NETWORK_PASSPHRASES = {
  [STELLAR_NETWORKS.TESTNET]: StellarSdk.Networks.TESTNET,
  [STELLAR_NETWORKS.MAINNET]: StellarSdk.Networks.PUBLIC,
};

export const validateStellarNetwork = () => {
  const network = process.env.STELLAR_NETWORK;
  if (!network) {
    console.warn("⚠️  STELLAR_NETWORK not set, defaulting to testnet");
    process.env.STELLAR_NETWORK = STELLAR_NETWORKS.TESTNET;
    return;
  }

  // FIX: Change 'network as any' to 'network as StellarNetwork' or 'network as string'
  const validNetworks: string[] = Object.values(STELLAR_NETWORKS);
  if (!validNetworks.includes(network)) {
    throw new Error(
      `Invalid STELLAR_NETWORK: ${network}. Must be 'testnet' or 'mainnet'`,
    );
  }

  // Prevent accidental mainnet use in development
  if (
    network === STELLAR_NETWORKS.MAINNET &&
    process.env.NODE_ENV === "development" &&
    process.env.ALLOW_MAINNET_IN_DEV !== "true"
  ) {
    throw new Error(
      "CRITICAL: Mainnet is disabled in development mode. Set ALLOW_MAINNET_IN_DEV=true to override.",
    );
  }
};

export const logStellarNetwork = () => {
  const network = (process.env.STELLAR_NETWORK ||
    STELLAR_NETWORKS.TESTNET) as StellarNetwork;
  console.log(`[Stellar] Current Network: ${network.toUpperCase()}`);
  if (network === STELLAR_NETWORKS.MAINNET) {
    console.warn(
      "⚠️  WARNING: Using Stellar MAINNET. Real assets are being moved!",
    );
  }
};

export const getStellarServer = () => {
  const network = (process.env.STELLAR_NETWORK ||
    STELLAR_NETWORKS.TESTNET) as StellarNetwork;
  const horizonUrl = HORIZON_URLS[network];
  return new StellarSdk.Horizon.Server(horizonUrl);
};

export const getNetworkPassphrase = () => {
  const network = (process.env.STELLAR_NETWORK ||
    STELLAR_NETWORKS.TESTNET) as StellarNetwork;
  return NETWORK_PASSPHRASES[network];
};

// SEP-24 Configuration
export const getSep24Config = () => ({
  webAuthDomain: process.env.STELLAR_WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
  interactiveUrlBase: process.env.SEP24_INTERACTIVE_URL || "https://wallet.mobilemoney.com",
  feeServer: process.env.SEP24_FEE_SERVER,
  issuerAccount: process.env.STELLAR_ISSUER_ACCOUNT,
  signingKey: process.env.STELLAR_SIGNING_KEY,
});

// Fee Bump Configuration
export const getFeeBumpConfig = () => ({
  // Fee payer account that covers network fees for user transactions
  feePayerPublicKey: process.env.STELLAR_FEE_PAYER_PUBLIC_KEY || "",
  feePayerPrivateKey: process.env.STELLAR_FEE_PAYER_SECRET || "",
  // Maximum fee willing to pay (in stroops)
  maxFeePerTransaction: parseInt(process.env.STELLAR_MAX_FEE_STROOPS || "100000", 10),
  // Base fee for transactions (in stroops)
  baseFeeStroops: parseInt(process.env.STELLAR_BASE_FEE_STROOPS || "100", 10),
  // Maximum number of operations per transaction
  maxOperationsPerTransaction: parseInt(process.env.STELLAR_MAX_OPS || "100", 10),
});
