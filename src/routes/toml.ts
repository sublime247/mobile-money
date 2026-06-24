import { Router, Request, Response } from "express";
import crypto from "crypto";
import { AnchoredAssetModel, AnchoredAsset } from "../models/anchoredAsset";

/**
 * Dynamic stellar.toml Generation — SEP-01
 *
 * Serves /.well-known/stellar.toml with content driven by the current
 * anchored asset configuration in the database. That means asset changes
 * take effect immediately without needing redeploys or static TOML updates.
 * Supports ETag-based conditional GET so wallets and tools can cache efficiently.
 *
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
 */

// ============================================================================
// Asset config
// ============================================================================

interface AssetEntry {
  code: string;
  issuer?: string;       // absent means native XLM
  status: "live" | "test" | "private" | "dead";
  desc?: string;
  displayDecimals?: number;
  isAssetAnchored?: boolean;
  anchorAssetType?: string;
  anchorAsset?: string;
}

/**
 * Reads supported assets from environment variables.
 *
 * Primary asset: STELLAR_ASSET_CODE + STELLAR_ASSET_ISSUER
 * Additional assets: STELLAR_EXTRA_ASSETS (JSON array of AssetEntry objects)
 *
 * XLM is always included as native.
 */
const assetModel = new AnchoredAssetModel();
export { assetModel };

function mapAnchoredAssetStatus(dbStatus: AnchoredAsset["status"], network: string): AssetEntry["status"] {
  switch (dbStatus) {
    case "draft":
      return "private";
    case "disabled":
    case "locked":
      return "dead";
    case "active":
    default:
      return network === "mainnet" ? "live" : "test";
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function buildAssetEntryFromAnchoredAsset(asset: AnchoredAsset, network: string): AssetEntry {
  const metadata = asset.metadata || {};
  const desc = metadata.desc || metadata.description || `${asset.assetCode} issued by this anchor`;
  const displayDecimals = metadata.display_decimals ?? metadata.displayDecimals;
  const isAssetAnchored = parseBoolean(metadata.is_asset_anchored ?? metadata.isAssetAnchored);
  const anchorAssetType = metadata.anchor_asset_type || metadata.anchorAssetType || "fiat";
  const anchorAsset = metadata.anchor_asset || metadata.anchorAsset || asset.assetCode.replace(/[^A-Z]/g, "");

  return {
    code: asset.assetCode,
    issuer: asset.issuerPublicKey,
    status: mapAnchoredAssetStatus(asset.status, network),
    desc,
    displayDecimals: displayDecimals !== undefined ? Number(displayDecimals) : 7,
    isAssetAnchored: isAssetAnchored !== undefined ? isAssetAnchored : true,
    anchorAssetType,
    anchorAsset,
  };
}

function parseExtraAssetsFromEnv(): AssetEntry[] {
  const extraRaw = process.env.STELLAR_EXTRA_ASSETS || "";
  if (!extraRaw) {
    return [];
  }

  try {
    const extra: AssetEntry[] = JSON.parse(extraRaw);
    return Array.isArray(extra) ? extra : [];
  } catch {
    console.warn("[stellar.toml] STELLAR_EXTRA_ASSETS is not valid JSON — skipping");
    return [];
  }
}

function getPrimaryEnvAsset(network: string): AssetEntry | null {
  const assetCode = (process.env.STELLAR_ASSET_CODE || "").trim();
  const assetIssuer = (process.env.STELLAR_ASSET_ISSUER || "").trim();

  if (!assetCode || !assetIssuer) {
    return null;
  }

  return {
    code: assetCode,
    issuer: assetIssuer,
    status: network === "mainnet" ? "live" : "test",
    desc: process.env.STELLAR_ASSET_DESC || `${assetCode} issued by this anchor`,
    displayDecimals: parseInt(process.env.STELLAR_ASSET_DECIMALS || "7", 10),
    isAssetAnchored: process.env.STELLAR_ASSET_ANCHORED !== "false",
    anchorAssetType: process.env.STELLAR_ASSET_ANCHOR_TYPE || "fiat",
    anchorAsset: process.env.STELLAR_ASSET_ANCHOR_ASSET || assetCode.replace(/[^A-Z]/g, ""),
  };
}

async function getAssets(): Promise<AssetEntry[]> {
  const network = process.env.STELLAR_NETWORK || "testnet";
  const assets: AssetEntry[] = [
    {
      code: "XLM",
      status: "live",
      desc: "Stellar Lumens — native network asset",
      displayDecimals: 7,
      isAssetAnchored: false,
    },
  ];

  let anchoredAssets: AssetEntry[] = [];
  try {
    const rows = await assetModel.findAll();
    anchoredAssets = rows.map((row) => buildAssetEntryFromAnchoredAsset(row, network));
  } catch (error) {
    console.warn("[stellar.toml] failed to load anchored assets from DB", error);
  }

  if (anchoredAssets.length > 0) {
    assets.push(...anchoredAssets);
  } else {
    const primaryAsset = getPrimaryEnvAsset(network);
    if (primaryAsset) {
      assets.push(primaryAsset);
    }
  }

  assets.push(...parseExtraAssetsFromEnv());

  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ============================================================================
// TOML builders
// ============================================================================

/** Escape a string value for TOML (wrap in quotes, escape backslashes and quotes). */
function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildGeneralSection(): string {
  const network = process.env.STELLAR_NETWORK || "testnet";
  const isMainnet = network === "mainnet";

  const passphrase = isMainnet
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

  const baseUrl = (process.env.STELLAR_FEDERATION_SERVER_URL || `https://${process.env.STELLAR_WEB_AUTH_DOMAIN || "mobilemoney.com"}`).replace(/\/$/, "");

  const lines: string[] = [
    `NETWORK_PASSPHRASE=${tomlStr(passphrase)}`,
  ];

  // FEDERATION_SERVER (SEP-02)
  const federationServer = process.env.STELLAR_FEDERATION_SERVER
    || (process.env.STELLAR_FEDERATION_DOMAIN ? `https://${process.env.STELLAR_FEDERATION_DOMAIN}/federation` : `${baseUrl}/federation`);
  lines.push(`FEDERATION_SERVER=${tomlStr(federationServer)}`);

  // AUTH_SERVER (SEP-10)
  if (process.env.STELLAR_AUTH_SERVER) {
    lines.push(`AUTH_SERVER=${tomlStr(process.env.STELLAR_AUTH_SERVER)}`);
  }

  // TRANSFER_SERVER_SEP0024 (SEP-24)
  const sep24Url = process.env.SEP24_TRANSFER_SERVER || `${baseUrl}/sep24`;
  lines.push(`TRANSFER_SERVER_SEP0024=${tomlStr(sep24Url)}`);

  // KYC_SERVER (SEP-12)
  const sep12Url = process.env.SEP12_KYC_SERVER || `${baseUrl}/sep12`;
  lines.push(`KYC_SERVER=${tomlStr(sep12Url)}`);

  // DIRECT_PAYMENT_SERVER (SEP-31)
  const sep31Url = process.env.SEP31_SERVER || `${baseUrl}/sep31`;
  lines.push(`DIRECT_PAYMENT_SERVER=${tomlStr(sep31Url)}`);

  // SIGNING_KEY
  const signingKey = process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_ACCOUNT || "";
  if (signingKey) {
    lines.push(`SIGNING_KEY=${tomlStr(signingKey)}`);
  }

  return lines.join("\n");
}

function buildDocumentationSection(): string {
  const orgName = process.env.ORG_NAME || "Mobile Money Anchor";
  const orgDba = process.env.ORG_DBA || "";
  const orgUrl = process.env.ORG_URL || "";
  const orgLogo = process.env.ORG_LOGO || "";
  const orgDescription = process.env.ORG_DESCRIPTION || "Mobile money to Stellar asset anchor";
  const orgSupportEmail = process.env.ORG_SUPPORT_EMAIL || "";

  const lines = ["[DOCUMENTATION]", `ORG_NAME=${tomlStr(orgName)}`];

  if (orgDba) lines.push(`ORG_DBA=${tomlStr(orgDba)}`);
  if (orgUrl) lines.push(`ORG_URL=${tomlStr(orgUrl)}`);
  if (orgLogo) lines.push(`ORG_LOGO=${tomlStr(orgLogo)}`);
  lines.push(`ORG_DESCRIPTION=${tomlStr(orgDescription)}`);
  if (orgSupportEmail) lines.push(`ORG_OFFICIAL_EMAIL=${tomlStr(orgSupportEmail)}`);

  return lines.join("\n");
}

function buildCurrenciesSection(assets: AssetEntry[]): string {
  return assets
    .map((asset) => {
      const lines = [
        "[[CURRENCIES]]",
        `code=${tomlStr(asset.code)}`,
      ];

      if (asset.issuer) {
        lines.push(`issuer=${tomlStr(asset.issuer)}`);
      } else {
        lines.push(`status="live"`);
        lines.push(`name=${tomlStr("Stellar Lumens")}`);
        lines.push(`display_decimals=7`);
        return lines.join("\n");
      }

      lines.push(`status=${tomlStr(asset.status)}`);

      if (asset.desc) lines.push(`desc=${tomlStr(asset.desc)}`);
      if (asset.displayDecimals !== undefined) lines.push(`display_decimals=${asset.displayDecimals}`);
      if (asset.isAssetAnchored !== undefined) lines.push(`is_asset_anchored=${asset.isAssetAnchored}`);
      if (asset.anchorAssetType) lines.push(`anchor_asset_type=${tomlStr(asset.anchorAssetType)}`);
      if (asset.anchorAsset) lines.push(`anchor_asset=${tomlStr(asset.anchorAsset)}`);

      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Generate the full stellar.toml content from the current environment.
 * Called on every request — no server-side caching — so config changes
 * are picked up immediately.
 */
export async function generateToml(): Promise<string> {
  const assets = await getAssets();

  const sections = [
    "# stellar.toml — generated dynamically from the current anchor asset database configuration",
    "# See https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md",
    "",
    buildGeneralSection(),
    "",
    buildDocumentationSection(),
    "",
    buildCurrenciesSection(assets),
  ];

  return sections.join("\n");
}

/** SHA-256 ETag for the given content (double-quoted per RFC 7232 §2.3). */
function computeETag(content: string): string {
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
  return `"${hash}"`;
}

// ============================================================================
// Router
// ============================================================================

const router = Router();

/**
 * GET /.well-known/stellar.toml
 *
 * Headers set:
 *   Content-Type: text/plain; charset=utf-8
 *   Access-Control-Allow-Origin: *   (required by SEP-01)
 *   Cache-Control: no-cache           (must revalidate, but can store)
 *   ETag: "<sha256>"                  (content fingerprint)
 *
 * Returns 304 Not Modified when the client's If-None-Match matches.
 */
router.get("/", async (req: Request, res: Response) => {
  const toml = await generateToml();
  const etag = computeETag(toml);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  // Conditional GET — client already has current version
  const clientETag = req.headers["if-none-match"];
  if (clientETag === etag) {
    return res.status(304).end();
  }

  return res.status(200).send(toml);
});

export default router;
