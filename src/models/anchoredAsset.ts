import { pool } from "../config/database";
import { v4 as uuidv4 } from "uuid";
import { encryptModelFields, decryptModelFields } from "../utils/crypto";

/**
 * Secret columns whose values must never be written to disk in plaintext.
 * Both Stellar seed keys are AES-256-GCM encrypted at rest (Issue #2031).
 */
const SECRET_FIELDS = ["issuerSecretKey", "distributionSecretKey"] as const;

export interface AnchoredAsset {
  id: string;
  assetCode: string;
  issuerPublicKey: string;
  issuerSecretKey: string;
  distributionPublicKey: string;
  distributionSecretKey: string;
  issuanceLimit: string;
  status: "active" | "draft" | "disabled" | "locked";
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnchoredAssetRow {
  id: string;
  assetCode: string;
  issuerPublicKey: string;
  issuerSecretKey: string;
  distributionPublicKey: string;
  distributionSecretKey: string;
  issuanceLimit: string;
  status: AnchoredAsset["status"];
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export class AnchoredAssetModel {
  async findAll(): Promise<AnchoredAsset[]> {
    const result = await pool.query<AnchoredAssetRow>(
      `SELECT 
        id, asset_code as "assetCode", issuer_public_key as "issuerPublicKey", 
        issuer_secret_key as "issuerSecretKey", distribution_public_key as "distributionPublicKey",
        distribution_secret_key as "distributionSecretKey", issuance_limit as "issuanceLimit",
        status, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM anchored_assets`,
    );
    return result.rows.map(mapAnchoredAssetRow);
  }

  async findByCode(code: string): Promise<AnchoredAsset | null> {
    const result = await pool.query<AnchoredAssetRow>(
      `SELECT 
        id, asset_code as "assetCode", issuer_public_key as "issuerPublicKey", 
        issuer_secret_key as "issuerSecretKey", distribution_public_key as "distributionPublicKey",
        distribution_secret_key as "distributionSecretKey", issuance_limit as "issuanceLimit",
        status, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM anchored_assets 
      WHERE asset_code = $1`,
      [code],
    );
    return result.rows.length > 0 ? mapAnchoredAssetRow(result.rows[0]) : null;
  }

  async insert(
    asset: Omit<AnchoredAsset, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const id = uuidv4();
    // Encrypt the Stellar seed keys before they touch the database. The hook is
    // idempotent, so callers that hand us an already-encrypted value (e.g. the
    // issuance service) are not double-encrypted.
    const secured = encryptModelFields(
      asset as unknown as Record<string, unknown>,
      SECRET_FIELDS,
    );
    await pool.query(
      `INSERT INTO anchored_assets (
        id, asset_code, issuer_public_key, issuer_secret_key, 
        distribution_public_key, distribution_secret_key, issuance_limit, 
        status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        secured.assetCode,
        secured.issuerPublicKey,
        secured.issuerSecretKey,
        secured.distributionPublicKey,
        secured.distributionSecretKey,
        secured.issuanceLimit,
        secured.status,
        JSON.stringify(secured.metadata),
      ],
    );
    return id;
  }

  async updateStatus(
    id: string,
    status: AnchoredAsset["status"],
  ): Promise<void> {
    await pool.query("UPDATE anchored_assets SET status = $1 WHERE id = $2", [
      status,
      id,
    ]);
  }
}

function mapAnchoredAssetRow(row: AnchoredAssetRow): AnchoredAsset {
  // Decrypt the seed keys transparently on read so callers always receive
  // plaintext secrets. decryptSecret verifies the GCM auth tag and passes
  // through legacy plaintext rows untouched.
  return decryptModelFields(
    {
      id: row.id,
      assetCode: row.assetCode,
      issuerPublicKey: row.issuerPublicKey,
      issuerSecretKey: row.issuerSecretKey,
      distributionPublicKey: row.distributionPublicKey,
      distributionSecretKey: row.distributionSecretKey,
      issuanceLimit: row.issuanceLimit,
      status: row.status,
      metadata: row.metadata ?? {},
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    } as unknown as Record<string, unknown>,
    SECRET_FIELDS,
  ) as unknown as AnchoredAsset;
}
