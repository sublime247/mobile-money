import * as StellarSdk from "@stellar/stellar-sdk";
import { queryWrite, queryRead } from "../../config/database";
import { createError } from "../../middleware/errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";
import logger from "../../utils/logger";

export interface ColdVaultTransferRequest {
  destinationPublicKey: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}

export interface VaultTransferRecord {
  id: string;
  envelopeXdr: string;
  destinationPublicKey: string;
  amount: string;
  asset: string;
  status: "pending_signatures" | "signed" | "executed" | "failed";
  requiredSignatures: number;
  registeredSignatures: string[];
  createdAt: Date;
  executedAt?: Date | null;
}

export class ColdVaultService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;

  constructor() {
    const horizonUrl = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
    this.server = new StellarSdk.Horizon.Server(horizonUrl);
    this.networkPassphrase = process.env.STELLAR_NETWORK === "PUBLIC"
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;
  }

  /**
   * AC-1: Generate transaction envelope for cold-wallet transfer.
   */
  async generateTransferEnvelope(
    vaultPublicKey: string,
    request: ColdVaultTransferRequest,
    initiatorId: string
  ): Promise<VaultTransferRecord> {
    try {
      const sourceAccount = await this.server.loadAccount(vaultPublicKey);
      
      let asset = StellarSdk.Asset.native();
      if (request.assetCode && request.assetIssuer) {
        asset = new StellarSdk.Asset(request.assetCode, request.assetIssuer);
      }

      const txBuilder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      }).addOperation(
        StellarSdk.Operation.payment({
          destination: request.destinationPublicKey,
          asset,
          amount: request.amount,
        })
      );

      if (request.memo) {
        txBuilder.addMemo(StellarSdk.Memo.text(request.memo));
      }

      const transaction = txBuilder.setTimeout(300).build();
      const envelopeXdr = transaction.toEnvelope().toXDR("base64");

      const transferId = `VAULT-TX-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      await queryWrite(
        `INSERT INTO cold_vault_transfers (
           id, envelope_xdr, destination_publicKey, amount, asset,
           status, required_signatures, registered_signatures, created_at, initiator_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9)`,
        [
          transferId,
          envelopeXdr,
          request.destinationPublicKey,
          request.amount,
          request.assetCode ? `${request.assetCode}:${request.assetIssuer}` : "native",
          "pending_signatures",
          2,
          JSON.stringify([]),
          initiatorId,
        ]
      );

      logger.info("Cold vault transfer envelope generated", { transferId, vaultPublicKey });

      return {
        id: transferId,
        envelopeXdr,
        destinationPublicKey: request.destinationPublicKey,
        amount: request.amount,
        asset: request.assetCode ? `${request.assetCode}:${request.assetIssuer}` : "native",
        status: "pending_signatures",
        requiredSignatures: 2,
        registeredSignatures: [],
        createdAt: new Date(),
      };
    } catch (error) {
      logger.error("Failed to generate cold vault transfer envelope", { error });
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate transfer envelope for cold vault");
    }
  }

  /**
   * AC-2: Provide secure dashboard to collect secondary authorization signatures.
   */
  async registerSignature(transferId: string, signerPublicKey: string, signedEnvelopeXdr: string): Promise<VaultTransferRecord> {
    const res = await queryRead(
      `SELECT id, envelope_xdr, destination_public_key, amount, asset, status, required_signatures, registered_signatures, created_at, executed_at
         FROM cold_vault_transfers WHERE id = $1`,
      [transferId]
    );

    if (res.rows.length === 0) {
      throw createError(ERROR_CODES.NOT_FOUND, "Vault transfer request not found");
    }

    const row = res.rows[0];
    if (row.status === "executed" || row.status === "failed") {
      throw createError(ERROR_CODES.CONFLICT, `Transfer is already in terminal state: ${row.status}`);
    }

    let registeredSignatures: string[] = [];
    try {
      registeredSignatures = typeof row.registered_signatures === "string"
        ? JSON.parse(row.registered_signatures)
        : (row.registered_signatures || []);
    } catch {
      registeredSignatures = [];
    }

    if (registeredSignatures.includes(signerPublicKey)) {
      throw createError(ERROR_CODES.CONFLICT, "Signer has already registered a signature for this transfer");
    }

    // Verify signature validity against transaction envelope
    const tx = new StellarSdk.Transaction(signedEnvelopeXdr, this.networkPassphrase);
    const hasSignature = tx.signatures.some((sig) => {
      try {
        const keypair = StellarSdk.Keypair.fromPublicKey(signerPublicKey);
        return keypair.verify(tx.hash(), sig.signature);
      } catch {
        return false;
      }
    });

    if (!hasSignature) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provided signature does not match signer public key");
    }

    registeredSignatures.push(signerPublicKey);
    const nextStatus = registeredSignatures.length >= row.required_signatures ? "signed" : "pending_signatures";

    await queryWrite(
      `UPDATE cold_vault_transfers
          SET registered_signatures = $1, status = $2
        WHERE id = $3`,
      [JSON.stringify(registeredSignatures), nextStatus, transferId]
    );

    logger.info("Cold vault secondary signature registered", { transferId, signerPublicKey, count: registeredSignatures.length });

    return {
      id: row.id,
      envelopeXdr: row.envelope_xdr,
      destinationPublicKey: row.destination_public_key,
      amount: row.amount,
      asset: row.asset,
      status: nextStatus,
      requiredSignatures: row.required_signatures,
      registeredSignatures,
      createdAt: row.created_at,
      executedAt: row.executed_at,
    };
  }

  /**
   * AC-3: Block transfer execution until both signatures are registered.
   */
  async executeTransfer(transferId: string): Promise<{ success: boolean; resultXdr: string }> {
    const res = await queryRead(
      `SELECT id, envelope_xdr, status, required_signatures, registered_signatures
         FROM cold_vault_transfers WHERE id = $1`,
      [transferId]
    );

    if (res.rows.length === 0) {
      throw createError(ERROR_CODES.NOT_FOUND, "Vault transfer request not found");
    }

    const row = res.rows[0];
    let registeredSignatures: string[] = [];
    try {
      registeredSignatures = typeof row.registered_signatures === "string"
        ? JSON.parse(row.registered_signatures)
        : (row.registered_signatures || []);
    } catch {
      registeredSignatures = [];
    }

    if (registeredSignatures.length < row.required_signatures) {
      throw createError(
        ERROR_CODES.FORBIDDEN,
        `Transfer execution blocked: insufficient signatures registered (${registeredSignatures.length}/${row.required_signatures})`
      );
    }

    const transaction = new StellarSdk.Transaction(row.envelope_xdr, this.networkPassphrase);

    try {
      const response = await this.server.submitTransaction(transaction);

      await queryWrite(
        `UPDATE cold_vault_transfers SET status = 'executed', executed_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [transferId]
      );

      logger.info("Cold vault transfer successfully executed", { transferId, hash: response.hash });

      return {
        success: true,
        resultXdr: response.hash,
      };
    } catch (error: any) {
      logger.error("Failed to submit multi-sig cold vault transaction", { error: error.response?.data || error.message });
      await queryWrite(
        `UPDATE cold_vault_transfers SET status = 'failed' WHERE id = $1`,
        [transferId]
      );
      throw createError(ERROR_CODES.TRANSACTION_FAILED, `Stellar submission failed: ${error.message}`);
    }
  }

  async listTransfers(): Promise<VaultTransferRecord[]> {
    const res = await queryRead(
      `SELECT id, envelope_xdr, destination_public_key, amount, asset, status, required_signatures, registered_signatures, created_at, executed_at
         FROM cold_vault_transfers ORDER BY created_at DESC LIMIT 50`
    );

    return res.rows.map((row) => ({
      id: row.id,
      envelopeXdr: row.envelope_xdr,
      destinationPublicKey: row.destination_public_key,
      amount: row.amount,
      asset: row.asset,
      status: row.status,
      requiredSignatures: row.required_signatures,
      registeredSignatures: typeof row.registered_signatures === "string" ? JSON.parse(row.registered_signatures) : (row.registered_signatures || []),
      createdAt: row.created_at,
      executedAt: row.executed_at,
    }));
  }
}

export const coldVaultService = new ColdVaultService();
