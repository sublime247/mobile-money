import { pool } from "../config/database";
import { v4 as uuidv4 } from "uuid";

export interface AnchoredAsset {
  id: string;
  assetCode: string;
  issuerPublicKey: string;
  issuerSecretKey: string;
  distributionPublicKey: string;
  distributionSecretKey: string;
  issuanceLimit: string;
  status: "active" | "draft" | "disabled" | "locked";
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
}

export class AnchoredAssetModel {
  async findAll(): Promise<AnchoredAsset[]> {
    const result = await pool.query(
      `SELECT 
        id, asset_code as "assetCode", issuer_public_key as "issuerPublicKey", 
        issuer_secret_key as "issuerSecretKey", distribution_public_key as "distributionPublicKey",
        distribution_secret_key as "distributionSecretKey", issuance_limit as "issuanceLimit",
        status, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM anchored_assets`,
    );
    return result.rows;
  }

  async findByCode(code: string): Promise<AnchoredAsset | null> {
    const result = await pool.query(
      `SELECT 
        id, asset_code as "assetCode", issuer_public_key as "issuerPublicKey", 
        issuer_secret_key as "issuerSecretKey", distribution_public_key as "distributionPublicKey",
        distribution_secret_key as "distributionSecretKey", issuance_limit as "issuanceLimit",
        status, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM anchored_assets 
      WHERE asset_code = $1`,
      [code],
    );
    return result.rows[0] || null;
  }

  async insert(
    asset: Omit<AnchoredAsset, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO anchored_assets (
        id, asset_code, issuer_public_key, issuer_secret_key, 
        distribution_public_key, distribution_secret_key, issuance_limit, 
        status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        asset.assetCode,
        asset.issuerPublicKey,
        asset.issuerSecretKey,
        asset.distributionPublicKey,
        asset.distributionSecretKey,
        asset.issuanceLimit,
        asset.status,
        JSON.stringify(asset.metadata),
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
