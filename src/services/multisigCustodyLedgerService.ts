import { pool } from "../config/database";
import NodeCache from "node-cache";
import logger from "../utils/logger";
import * as crypto from "crypto";

export interface MultisigConfig {
  id?: string;
  account_type: "escrow" | "issuance" | "vault";
  account_id: string;
  required_signatures: number;
  total_signers: number;
  daily_cap_xaf: number;
  per_transaction_cap_xaf: number;
  time_lock_minutes: number;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface MultisigSigner {
  id?: string;
  config_id: string;
  signer_id: string;
  signer_name: string;
  signer_email?: string;
  public_key: string;
  weight: number;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface MultisigRequest {
  id?: string;
  config_id: string;
  request_type: "transfer" | "issuance" | "vault_operation";
  account_id: string;
  amount_xaf: number;
  destination: string;
  metadata?: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  required_signatures: number;
  collected_signatures: number;
  expires_at: Date;
  created_by: string;
  created_at?: Date;
  updated_at?: Date;
  executed_at?: Date;
  executed_by?: string;
}

export interface MultisigSignature {
  id?: string;
  request_id: string;
  signer_id: string;
  signature_data: string;
  signature_type: "webhook" | "manual" | "api";
  ip_address?: string;
  user_agent?: string;
  created_at?: Date;
}

export interface MultisigAuditLog {
  id?: string;
  request_id?: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
  ip_address?: string;
  created_at?: Date;
}

export interface MultisigCheckResult {
  requiresApproval: boolean;
  config?: MultisigConfig;
  reason?: string;
}

export class MultisigCustodyLedgerService {
  private cache: NodeCache;

  constructor() {
    // Cache for 2 minutes - configs change infrequently
    this.cache = new NodeCache({ stdTTL: 120, checkperiod: 240 });
  }

  /**
   * Check if a transaction requires multi-sig approval
   */
  async checkMultisigRequirement(
    accountType: "escrow" | "issuance" | "vault",
    accountId: string,
    amountXaf: number,
  ): Promise<MultisigCheckResult> {
    const config = await this.getMultisigConfig(accountType, accountId);

    if (!config || !config.is_active) {
      return {
        requiresApproval: false,
      };
    }

    // Check if amount exceeds per-transaction cap
    if (amountXaf > config.per_transaction_cap_xaf) {
      return {
        requiresApproval: true,
        config,
        reason: `Amount ${amountXaf} XAF exceeds per-transaction cap of ${config.per_transaction_cap_xaf} XAF`,
      };
    }

    // Check if amount would exceed daily cap
    const dailyTotal = await this.getDailyTotal(accountType, accountId);
    if (dailyTotal + amountXaf > config.daily_cap_xaf) {
      return {
        requiresApproval: true,
        config,
        reason: `Transaction would exceed daily cap of ${config.daily_cap_xaf} XAF (current: ${dailyTotal} XAF)`,
      };
    }

    return {
      requiresApproval: false,
      config,
    };
  }

  /**
   * Get multi-sig configuration for an account
   */
  async getMultisigConfig(
    accountType: "escrow" | "issuance" | "vault",
    accountId: string,
  ): Promise<MultisigConfig | null> {
    const cacheKey = `multisig_config_${accountType}_${accountId}`;
    const cached = this.cache.get<MultisigConfig>(cacheKey);

    if (cached) {
      return cached;
    }

    const query = `
      SELECT *
      FROM multisig_configs
      WHERE account_type = $1
        AND account_id = $2
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1;
    `;

    const result = await pool.query(query, [accountType, accountId]);

    if (result.rows.length === 0) {
      return null;
    }

    const config = result.rows[0];
    this.cache.set(cacheKey, config);
    return config;
  }

  /**
   * Get signers for a multi-sig configuration
   */
  async getSigners(configId: string): Promise<MultisigSigner[]> {
    const query = `
      SELECT *
      FROM multisig_signers
      WHERE config_id = $1
        AND is_active = true
      ORDER BY signer_id;
    `;

    const result = await pool.query(query, [configId]);
    return result.rows;
  }

  /**
   * Create a multi-sig approval request
   */
  async createApprovalRequest(
    configId: string,
    requestType: "transfer" | "issuance" | "vault_operation",
    accountId: string,
    amountXaf: number,
    destination: string,
    createdBy: string,
    metadata?: Record<string, unknown>,
  ): Promise<MultisigRequest> {
    const config = await this.getConfigById(configId);
    if (!config) {
      throw new Error("Multi-sig configuration not found");
    }

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + config.time_lock_minutes);

    const query = `
      INSERT INTO multisig_requests
        (config_id, request_type, account_id, amount_xaf, destination, metadata, required_signatures, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const result = await pool.query(query, [
      configId,
      requestType,
      accountId,
      amountXaf,
      destination,
      JSON.stringify(metadata || {}),
      config.required_signatures,
      expiresAt,
      createdBy,
    ]);

    const request = result.rows[0];

    // Log audit event
    await this.logAuditEvent(request.id, "created", createdBy, {
      requestType,
      amountXaf,
      destination,
      requiredSignatures: config.required_signatures,
    });

    return request;
  }

  /**
   * Add a signature to a multi-sig request
   */
  async addSignature(
    requestId: string,
    signerId: string,
    signatureData: string,
    signatureType: "webhook" | "manual" | "api",
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ success: boolean; message: string; fullyApproved: boolean }> {
    // Get the request
    const request = await this.getRequestById(requestId);
    if (!request) {
      return {
        success: false,
        message: "Request not found",
        fullyApproved: false,
      };
    }

    if (request.status !== "pending") {
      return {
        success: false,
        message: `Request is already ${request.status}`,
        fullyApproved: false,
      };
    }

    if (new Date() > request.expires_at) {
      await this.updateRequestStatus(requestId, "expired");
      return {
        success: false,
        message: "Request has expired",
        fullyApproved: false,
      };
    }

    // Get config and signers
    const config = await this.getConfigById(request.config_id);
    const signers = await this.getSigners(request.config_id);

    // Verify signer is authorized
    const signer = signers.find((s) => s.signer_id === signerId && s.is_active);
    if (!signer) {
      return {
        success: false,
        message: "Signer not authorized",
        fullyApproved: false,
      };
    }

    // Check if signature already exists
    const existingSignature = await this.getSignature(requestId, signerId);
    if (existingSignature) {
      return {
        success: false,
        message: "Signature already collected from this signer",
        fullyApproved: false,
      };
    }

    // Add signature
    const signatureQuery = `
      INSERT INTO multisig_signatures
        (request_id, signer_id, signature_data, signature_type, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    await pool.query(signatureQuery, [
      requestId,
      signerId,
      signatureData,
      signatureType,
      ipAddress,
      userAgent,
    ]);

    // Update collected signatures count
    const updatedRequest = await this.incrementSignatureCount(requestId);

    // Log audit event
    await this.logAuditEvent(requestId, "signature_added", signerId, {
      signerName: signer.signer_name,
      signatureType,
      collectedSignatures: updatedRequest.collected_signatures,
      requiredSignatures: updatedRequest.required_signatures,
    });

    const fullyApproved =
      updatedRequest.collected_signatures >= updatedRequest.required_signatures;

    if (fullyApproved) {
      // Auto-approve when threshold is met
      await this.updateRequestStatus(requestId, "approved");
      await this.logAuditEvent(requestId, "auto_approved", "system", {
        reason: "Signature threshold met",
      });
    }

    return {
      success: true,
      message: fullyApproved ? "Request fully approved" : "Signature recorded",
      fullyApproved,
    };
  }

  /**
   * Execute an approved multi-sig request
   */
  async executeApprovedRequest(
    requestId: string,
    executedBy: string,
  ): Promise<{ success: boolean; message: string }> {
    const request = await this.getRequestById(requestId);
    if (!request) {
      return { success: false, message: "Request not found" };
    }

    if (request.status !== "approved") {
      return {
        success: false,
        message: `Request must be approved (current: ${request.status})`,
      };
    }

    // Update request as executed
    const updateQuery = `
      UPDATE multisig_requests
      SET status = 'executed',
          executed_at = NOW(),
          executed_by = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;

    await pool.query(updateQuery, [executedBy, requestId]);

    // Log audit event
    await this.logAuditEvent(requestId, "executed", executedBy, {
      amountXaf: request.amount_xaf,
      destination: request.destination,
    });

    return {
      success: true,
      message: "Request executed successfully",
    };
  }

  /**
   * Cancel a multi-sig request (time-locked cancellation)
   */
  async cancelRequest(
    requestId: string,
    cancelledBy: string,
    reason: string,
  ): Promise<{ success: boolean; message: string }> {
    const request = await this.getRequestById(requestId);
    if (!request) {
      return { success: false, message: "Request not found" };
    }

    if (request.status !== "pending") {
      return {
        success: false,
        message: `Cannot cancel request in ${request.status} status`,
      };
    }

    // Check if time-lock has passed
    const config = await this.getConfigById(request.config_id);
    if (!config) {
      return { success: false, message: "Configuration not found" };
    }

    const timeLockMs = config.time_lock_minutes * 60 * 1000;
    const requestAge = Date.now() - new Date(request.created_at).getTime();

    if (requestAge < timeLockMs) {
      return {
        success: false,
        message: `Time-lock not expired. Wait ${Math.ceil((timeLockMs - requestAge) / 60000)} more minutes`,
      };
    }

    // Cancel the request
    const updateQuery = `
      UPDATE multisig_requests
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;

    await pool.query(updateQuery, [requestId]);

    // Log audit event
    await this.logAuditEvent(requestId, "cancelled", cancelledBy, {
      reason,
      timeLockMinutes: config.time_lock_minutes,
    });

    return {
      success: true,
      message: "Request cancelled successfully",
    };
  }

  /**
   * Get pending requests for a signer
   */
  async getPendingRequestsForSigner(
    signerId: string,
  ): Promise<MultisigRequest[]> {
    const query = `
      SELECT r.*
      FROM multisig_requests r
      INNER JOIN multisig_signers s ON r.config_id = s.config_id
      WHERE s.signer_id = $1
        AND s.is_active = true
        AND r.status = 'pending'
        AND r.expires_at > NOW()
      ORDER BY r.created_at DESC;
    `;

    const result = await pool.query(query, [signerId]);
    return result.rows;
  }

  /**
   * Get daily total for an account
   */
  private async getDailyTotal(
    accountType: string,
    accountId: string,
  ): Promise<number> {
    const query = `
      SELECT COALESCE(SUM(amount_xaf), 0) as total
      FROM multisig_requests
      WHERE account_type = $1
        AND account_id = $2
        AND status IN ('approved', 'executed')
        AND created_at >= CURRENT_DATE
    `;

    // Note: This query assumes account_type is stored in the request or we join with config
    // For now, we'll use a simplified version
    const result = await pool.query(
      `
      SELECT COALESCE(SUM(amount_xaf), 0) as total
      FROM multisig_requests r
      INNER JOIN multisig_configs c ON r.config_id = c.id
      WHERE c.account_type = $1
        AND c.account_id = $2
        AND r.status IN ('approved', 'executed')
        AND r.created_at >= CURRENT_DATE
    `,
      [accountType, accountId],
    );

    return parseFloat(result.rows[0]?.total || 0);
  }

  /**
   * Get configuration by ID
   */
  private async getConfigById(
    configId: string,
  ): Promise<MultisigConfig | null> {
    const query = `SELECT * FROM multisig_configs WHERE id = $1`;
    const result = await pool.query(query, [configId]);
    return result.rows[0] || null;
  }

  /**
   * Get request by ID
   */
  private async getRequestById(
    requestId: string,
  ): Promise<MultisigRequest | null> {
    const query = `SELECT * FROM multisig_requests WHERE id = $1`;
    const result = await pool.query(query, [requestId]);
    return result.rows[0] || null;
  }

  /**
   * Get signature for a request and signer
   */
  private async getSignature(
    requestId: string,
    signerId: string,
  ): Promise<MultisigSignature | null> {
    const query = `
      SELECT * FROM multisig_signatures
      WHERE request_id = $1 AND signer_id = $2
    `;
    const result = await pool.query(query, [requestId, signerId]);
    return result.rows[0] || null;
  }

  /**
   * Increment signature count
   */
  private async incrementSignatureCount(
    requestId: string,
  ): Promise<MultisigRequest> {
    const query = `
      UPDATE multisig_requests
      SET collected_signatures = collected_signatures + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    const result = await pool.query(query, [requestId]);
    return result.rows[0];
  }

  /**
   * Update request status
   */
  private async updateRequestStatus(
    requestId: string,
    status: string,
  ): Promise<void> {
    const query = `
      UPDATE multisig_requests
      SET status = $1, updated_at = NOW()
      WHERE id = $2
    `;
    await pool.query(query, [status, requestId]);
  }

  /**
   * Log audit event
   */
  private async logAuditEvent(
    requestId: string | null,
    action: string,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const query = `
      INSERT INTO multisig_audit_log
        (request_id, action, actor, details, ip_address)
      VALUES ($1, $2, $3, $4, $5)
    `;

    await pool.query(query, [
      requestId,
      action,
      actor,
      JSON.stringify(details || {}),
      null, // IP address would be passed from request context
    ]);
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: string,
    signature: string,
    publicKey: string,
  ): boolean {
    try {
      const verified = crypto.verify(
        "sha256",
        Buffer.from(payload),
        {
          key: publicKey,
          format: "pem",
        },
        Buffer.from(signature, "hex"),
      );
      return verified;
    } catch (error) {
      logger.error({ error }, "Failed to verify webhook signature");
      return false;
    }
  }

  /**
   * Generate a signature envelope for a request
   */
  generateSignatureEnvelope(
    requestId: string,
    signerId: string,
  ): {
    envelope: string;
    timestamp: number;
  } {
    const timestamp = Date.now();
    const envelope = crypto
      .createHmac("sha256", `${requestId}:${signerId}:${timestamp}`)
      .update(JSON.stringify({ requestId, signerId, timestamp }))
      .digest("hex");

    return { envelope, timestamp };
  }
}

export const multisigCustodyLedgerService = new MultisigCustodyLedgerService();
