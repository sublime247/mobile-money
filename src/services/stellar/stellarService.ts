import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import dotenv from "dotenv";
import { transactionTotal, transactionErrorsTotal } from "../../utils/metrics";
import { AssetService, getConfiguredPaymentAsset } from "./assetService";

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
  }

  async sendPayment(destinationAddress: string, amount: string): Promise<{
    hash?: string;
    submittedAt?: Date;
  }> {
    try {
      // MOCK MODE (no crash)
      if (this.isMockMode || !this.issuerKeypair) {
        console.log("Mock Stellar payment:", {
          to: destinationAddress,
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
          destinationAddress,
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
            destination: destinationAddress,
            asset: paymentAsset,
            amount: amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.issuerKeypair);
      const response: StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse =
        await this.server.submitTransaction(transaction);

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
}
