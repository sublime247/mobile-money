import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import dotenv from "dotenv";
import { transactionTotal, transactionErrorsTotal } from "../../utils/metrics";
import { AssetService, getConfiguredPaymentAsset } from "./assetService";
import { sanctionService } from "../sanctionService";
import { resolveToBaseAddress } from "../../stellar/muxed";

dotenv.config();

// Response shape for fetched transaction history (Issue #36)
export interface TransactionRecord {
  hash: string;
  created_at: string;
  source_account: string;
  fee_charged: string;
  memo?: string;
  operations: StellarSdk.Horizon.ServerApi.OperationRecord[];
}

export interface TransactionHistoryResult {
  transactions: TransactionRecord[];
  cursor: string | null;
}

export class StellarService {
  private server: StellarSdk.Horizon.Server;
  private issuerKeypair: StellarSdk.Keypair | null = null;
  private feePayerKeypair: StellarSdk.Keypair | null = null;
  private isMockMode: boolean = false;
  private assetService = new AssetService();

  // Simple in-memory cache for recent transaction history results
  private historyCache: Map<
    string,
    { data: TransactionHistoryResult; expires: number }
  > = new Map();
  private readonly CACHE_TTL_MS = 30_000; // 30 seconds

  constructor() {
    this.server = getStellarServer();

    const secret = process.env.STELLAR_ISSUER_SECRET?.trim();
    const feePayerSecret = process.env.STELLAR_FEE_PAYER_SECRET?.trim();

    if (!secret) {
      console.warn("STELLAR_ISSUER_SECRET not set - running in MOCK mode");
      this.isMockMode = true;
    } else {
      try {
        this.issuerKeypair = StellarSdk.Keypair.fromSecret(secret);
      } catch (err) {
        console.warn(
          "STELLAR_ISSUER_SECRET invalid - falling back to mock mode",
          err instanceof Error ? err.message : err,
        );
        this.isMockMode = true;
      }
    }

    if (feePayerSecret) {
      try {
        this.feePayerKeypair = StellarSdk.Keypair.fromSecret(feePayerSecret);
        console.log(
          `[StellarService] Fee payer initialized: ${this.feePayerKeypair.publicKey()}`,
        );
      } catch (err) {
        console.warn(
          "STELLAR_FEE_PAYER_SECRET invalid",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Submits a transaction wrapped in a FeeBumpTransaction.
   * This allows the fee payer account to cover network fees for the transaction.
   *
   * @param innerTx - The already signed inner transaction
   * @returns Submission response
   */
  async submitFeeBumpTransaction(
    innerTx: StellarSdk.Transaction,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    if (this.isMockMode || !this.feePayerKeypair) {
      console.log("Mock Stellar fee-bump submission");
      // Return a minimal mock response
      return {
        hash: "mock_feebump_hash_" + Math.random().toString(36).substring(7),
        ledger: 12345,
        successful: true,
      } as any;
    }

    try {
      const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
        this.feePayerKeypair,
        (parseInt(innerTx.fee) + StellarSdk.BASE_FEE).toString(),
        innerTx,
        getNetworkPassphrase(),
      );

      feeBumpTx.sign(this.feePayerKeypair);
      const response = await this.server.submitTransaction(feeBumpTx);

      console.log("Stellar fee-bump payment successful", {
        hash: response.hash,
        innerHash: innerTx.hash(),
      });

      return response;
    } catch (error) {
      console.error("Stellar fee-bump submission failed:", error);
      throw error;
    }
  }

  async sendPayment(
    destinationAddress: string,
    amount: string,
    senderName?: string,
    receiverName?: string,
    useFeeBump?: boolean,
  ): Promise<{
    hash?: string;
    submittedAt?: Date;
  }> {
    try {
      // Resolve destination address (handle both G and M addresses)
      let resolvedDestinationAddress: string;
      try {
        resolvedDestinationAddress = resolveToBaseAddress(destinationAddress);
      } catch (error) {
        throw new Error(
          `Invalid destination address: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

      // Pre-flight sanction screening — blocks both sender and receiver
      if (senderName && receiverName) {
        await sanctionService.checkParties(senderName, receiverName);
      }

      // If address-based screening is preferred, use checkPartiesByAddress
      // This resolves muxed accounts and screens by the base address
      if (this.issuerKeypair) {
        const senderAddress = this.issuerKeypair.publicKey();
        try {
          await sanctionService.checkPartiesByAddress(
            senderAddress,
            resolvedDestinationAddress,
            senderName,
            receiverName,
          );
        } catch (error) {
          // If it's a SanctionScreeningError, re-throw it
          if (error instanceof Error && error.name === "SanctionScreeningError") {
            throw error;
          }
          // Log other errors but don't fail if address validation fails
          // (this maintains backward compatibility)
          console.warn("Address-based sanction screening warning:", error);
        }
      }

      // MOCK MODE (no crash)
      if (this.isMockMode || !this.issuerKeypair) {
        console.log("Mock Stellar payment:", {
          to: resolvedDestinationAddress,
          amount,
        });

        transactionTotal.inc({
          type: "stellar_payment",
          provider: "stellar",
          status: "success",
        });

        return {};
      }

      // REAL MODE
      const paymentAsset = getConfiguredPaymentAsset();
      if (!paymentAsset.isNative()) {
        const trusted = await this.assetService.hasTrustline(
          resolvedDestinationAddress,
          paymentAsset,
        );
        if (!trusted) {
          throw new Error(
            `Recipient has no trustline for ${paymentAsset.getCode()}. Add a trustline before paying this asset.`,
          );
        }
      }

      const account = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: resolvedDestinationAddress,
            asset: paymentAsset,
            amount: amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.issuerKeypair);

      // Check if fee bumping is requested
      let response: StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse;
      if (useFeeBump) {
        response = await this.submitFeeBumpTransaction(transaction);
      } else {
        response = await this.server.submitTransaction(transaction);
      }

      console.log("Stellar payment successful", {
        hash: response.hash,
        ledger: response.ledger,
      });

      transactionTotal.inc({
        type: "stellar_payment",
        provider: "stellar",
        status: "success",
      });

      return {
        hash: response.hash,
        submittedAt: new Date(),
      };
    } catch (error) {
      transactionTotal.inc({
        type: "stellar_payment",
        provider: "stellar",
        status: "failure",
      });

      transactionErrorsTotal.inc({
        type: "stellar_payment",
        provider: "stellar",
        error_type: "stellar_error",
      });

      throw error;
    }
  }

  async getBalance(address: string): Promise<string> {
    try {
      const asset = getConfiguredPaymentAsset();
      // MOCK MODE
      if (this.isMockMode) {
        console.log("Mock balance check for:", address, asset.getCode());
        return "1000";
      }

      return this.assetService.getAssetBalance(address, asset);
    } catch (error) {
      console.error("Balance fetch failed", error);
      return "0";
    }
  }

  /**
   * Fetch transaction history for a Stellar account with pagination support.
   * Results are cached for CACHE_TTL_MS to reduce redundant Horizon API calls.
   *
   * @param accountAddress - The Stellar public key of the account
   * @param limit          - Number of records to return (default 20, max 200)
   * @param cursor         - Pagination cursor (paging_token from a previous result)
   * @returns TransactionHistoryResult with transactions array and next cursor
   */
  async getTransactionHistory(
    accountAddress: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<TransactionHistoryResult> {
    // Clamp limit to accepted range
    const clampedLimit = Math.min(Math.max(1, limit), 200);

    const cacheKey = `${accountAddress}::${clampedLimit}::${cursor ?? ""}`;

    // Return cached result if still fresh
    const cached = this.historyCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    // MOCK MODE – return placeholder data
    if (this.isMockMode) {
      const mockResult: TransactionHistoryResult = {
        transactions: [
          {
            hash: "mock_hash_abc123",
            created_at: new Date().toISOString(),
            source_account: accountAddress,
            fee_charged: "100",
            memo: undefined,
            operations: [],
          },
        ],
        cursor: null,
      };
      this.historyCache.set(cacheKey, {
        data: mockResult,
        expires: Date.now() + this.CACHE_TTL_MS,
      });
      return mockResult;
    }

    try {
      // Build the Horizon transactions call for the account
      let call = this.server
        .transactions()
        .forAccount(accountAddress)
        .limit(clampedLimit)
        .order("desc")
        .includeFailed(false);

      if (cursor) {
        call = call.cursor(cursor);
      }

      const response = await call.call();

      const transactions: TransactionRecord[] = await Promise.all(
        response.records.map(async (tx: any) => {
          let operations: StellarSdk.Horizon.ServerApi.OperationRecord[] = [];

          try {
            const opsResponse = await tx.operations();
            operations = opsResponse.records;
          } catch {
            // If operations cannot be fetched, continue with empty array
          }

          return {
            hash: tx.hash,
            created_at: tx.created_at,
            source_account: tx.source_account,
            fee_charged: tx.fee_charged,
            memo: (tx as unknown as { memo?: string }).memo,
            operations,
          };
        }),
      );

      // Determine the next pagination cursor from the last record's paging_token
      const lastRecord = response.records[response.records.length - 1];
      const nextCursor = lastRecord ? lastRecord.paging_token : null;

      const result: TransactionHistoryResult = {
        transactions,
        cursor: nextCursor,
      };

      this.historyCache.set(cacheKey, {
        data: result,
        expires: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    } catch (error) {
      console.error("Failed to fetch transaction history:", error);
      throw error;
    }
  }

  /**
   * Enables clawback capability on the issuance account.
   * This sets the AUTH_CLAWBACK_ENABLED flag (0x8).
   */
  async enableClawback(): Promise<void> {
    if (this.isMockMode || !this.issuerKeypair) {
      console.log("Mock: Enabled clawback on issuer account");
      return;
    }

    try {
      const account = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.setOptions({
            setFlags: StellarSdk.xdr.AccountFlags.authClawbackEnabledFlag().value,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.issuerKeypair);
      await this.server.submitTransaction(transaction);
      console.log("Clawback capability enabled on issuance account");
    } catch (error) {
      console.error("Failed to enable clawback capability:", error);
      throw error;
    }
  }

  /**
   * Executes a clawback operation for a specific address and amount.
   */
  async executeClawback(
    fromAddress: string,
    amount: string,
    adminId?: string,
  ): Promise<{ hash?: string }> {
    // Validate inputs
    if (!fromAddress || fromAddress.length < 56) {
      throw new Error("Invalid destination address format");
    }
    if (parseFloat(amount) <= 0) {
      throw new Error("Clawback amount must be positive");
    }

    // Check if trying to claw back native XLM (not allowed)
    const paymentAsset = getConfiguredPaymentAsset();
    if (paymentAsset.isNative()) {
      throw new Error("Cannot claw back native XLM");
    }

    if (this.isMockMode || !this.issuerKeypair) {
      console.log("Mock Stellar clawback:", { fromAddress, amount });
      await this.logClawbackToAudit("mock_clawback_hash", fromAddress, amount, adminId, true);
      return { hash: "mock_clawback_hash" };
    }

    try {
      const account = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.clawback({
            from: fromAddress,
            asset: paymentAsset,
            amount: amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.issuerKeypair);
      const response = await this.server.submitTransaction(transaction);
      console.log("Stellar clawback successful", { hash: response.hash });

      // Log to audit trail
      await this.logClawbackToAudit(response.hash, fromAddress, amount, adminId, true);

      return { hash: response.hash };
    } catch (error) {
      console.error("Stellar clawback failed:", error);
      // Log failed attempt
      await this.logClawbackToAudit(null, fromAddress, amount, adminId, false, error);
      throw error;
    }
  }

  /**
   * Logs clawback operation to audit trail
   */
  private async logClawbackToAudit(
    txHash: string | null,
    fromAddress: string,
    amount: string,
    adminId?: string,
    success: boolean = true,
    error?: any,
  ): Promise<void> {
    try {
      const { pool } = await import("../../config/database.js");
      
      const auditData = {
        transaction_hash: txHash,
        from_address: fromAddress,
        amount: amount,
        success: success,
        error_message: error ? (error.message || String(error)) : null,
      };

      await pool.query(
        `INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          adminId || "system",
          "CLAWBACK_ASSET",
          "stellar_clawback",
          txHash || "failed",
          JSON.stringify(auditData),
        ]
      );
    } catch (auditError) {
      console.error("Failed to write clawback audit log:", auditError);
      // Don't throw - audit logging failure shouldn't break the operation
    }
  }
}
