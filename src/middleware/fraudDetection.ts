import logger from "../utils/logger";
import { Request, Response, NextFunction } from 'express';
import { fraudService, FraudTransactionInput, FraudResult } from '../services/fraud';
import { Transaction, TransactionStatus } from '../models/transaction';
import { TransactionModel } from '../models/transaction';

/**
 * Fraud Detection Middleware
 * 
 * Automatically analyzes transactions for fraud using 10+ heuristics.
 * High-risk transactions are automatically set to 'Review' status.
 */
export class FraudDetectionMiddleware {
  private transactionModel: TransactionModel;

  constructor() {
    this.transactionModel = new TransactionModel();
  }

  /**
   * Express middleware for fraud detection
   * Analyzes incoming transactions and applies appropriate actions
   */
  detectFraud = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Extract transaction data from request
      const transactionData = this.extractTransactionData(req);
      
      if (!transactionData) {
        // No transaction data to analyze, continue
        return next();
      }

      // Run fraud detection
      const fraudResult = await fraudService.processTransaction(transactionData);

      // Store fraud result in request for later use
      (req as any).fraudResult = fraudResult;

      // Handle high-risk transactions
      if (fraudResult.isFraud || fraudResult.recommendedAction === 'review') {
        await this.handleSuspiciousTransaction(transactionData.id, fraudResult);
      }

      // Block critical risk transactions
      if (fraudResult.recommendedAction === 'block') {
        res.status(403).json({
          error: 'Transaction blocked due to fraud detection',
          fraudScore: fraudResult.score,
          riskLevel: fraudResult.riskLevel,
          reasons: fraudResult.reasons
        });
        return;
      }

      // Continue with normal processing
      next();
    } catch (error) {
      logger.error('Fraud detection middleware error:', error);
      // Continue processing even if fraud detection fails
      next();
    }
  };

  /**
   * Extract transaction data from request
   */
  private extractTransactionData(req: Request): FraudTransactionInput | null {
    const body = req.body;
    
    // Handle different request formats
    let transactionData: any;
    
    if (body.transaction) {
      transactionData = body.transaction;
    } else if (body.amount && body.phoneNumber) {
      transactionData = body;
    } else {
      return null;
    }

    // Extract IP and user agent from request
    const ipAddress = req.ip || req.connection.remoteAddress || null;
    const userAgent = req.get('User-Agent') || null;

    // Generate device fingerprint (simplified)
    const deviceFingerprint = this.generateDeviceFingerprint(ipAddress, userAgent);

    return {
      id: transactionData.id || transactionData.referenceNumber || `temp_${Date.now()}`,
      userId: transactionData.userId || req.user?.id || null,
      amount: parseFloat(transactionData.amount || '0'),
      phoneNumber: transactionData.phoneNumber || '',
      timestamp: new Date(),
      location: transactionData.location || null,
      status: this.mapTransactionStatus(transactionData.status),
      ipAddress,
      userAgent,
      deviceFingerprint,
      type: transactionData.type || 'deposit',
      provider: transactionData.provider || 'unknown',
      metadata: transactionData.metadata || null
    };
  }

  /**
   * Map transaction status to fraud service format
   */
  private mapTransactionStatus(status?: string): "SUCCESS" | "FAILED" | "PENDING" {
    if (!status) return "PENDING";
    
    const statusLower = status.toLowerCase();
    if (statusLower === 'completed' || statusLower === 'success') return "SUCCESS";
    if (statusLower === 'failed' || statusLower === 'error') return "FAILED";
    return "PENDING";
  }

  /**
   * Generate simple device fingerprint
   */
  private generateDeviceFingerprint(ipAddress?: string | null, userAgent?: string | null): string {
    const components = [
      ipAddress || 'unknown',
      userAgent || 'unknown',
      // Add more components in production for better fingerprinting
    ];
    
    // Simple hash - in production use a proper fingerprinting library
    return Buffer.from(components.join('|')).toString('base64').substring(0, 32);
  }

  /**
   * Handle suspicious transactions by setting them to Review status
   */
  private async handleSuspiciousTransaction(
    transactionId: string, 
    fraudResult: FraudResult
  ): Promise<void> {
    try {
      // Set transaction to Review status
      await fraudService.setTransactionToReview(transactionId);
      
      console.log(`Transaction ${transactionId} flagged for review:`, {
        score: fraudResult.score,
        riskLevel: fraudResult.riskLevel,
        reasons: fraudResult.reasons,
        heuristicsTriggered: fraudResult.heuristicsTriggered
      });
    } catch (error) {
      logger.error(`Failed to handle suspicious transaction ${transactionId}:`, error);
    }
  }

  /**
   * Post-transaction hook for analyzing completed transactions
   * Can be called after transaction processing to update fraud models
   */
  analyzeCompletedTransaction = async (
    transaction: Transaction,
    req: Request
  ): Promise<void> => {
    try {
      const transactionInput: FraudTransactionInput = {
        id: transaction.id,
        userId: transaction.userId,
        amount: parseFloat(transaction.amount),
        phoneNumber: transaction.phoneNumber,
        timestamp: transaction.createdAt,
        location: this.extractLocationFromMetadata(transaction.locationMetadata),
        status: this.mapTransactionStatus(transaction.status),
        ipAddress: req.ip || null,
        userAgent: req.get('User-Agent') || null,
        deviceFingerprint: this.generateDeviceFingerprint(req.ip, req.get('User-Agent')),
        type: transaction.type as "deposit" | "withdraw",
        provider: transaction.provider,
        metadata: transaction.metadata
      };

      // Run fraud detection for learning purposes
      await fraudService.detectFraud(transactionInput);
    } catch (error) {
      logger.error('Failed to analyze completed transaction:', error);
    }
  };

  /**
   * Extract location from transaction metadata
   */
  private extractLocationFromMetadata(
    locationMetadata: Transaction['locationMetadata']
  ): { lat: number; lng: number } | null {
    if (!locationMetadata || locationMetadata.status !== 'resolved') {
      return null;
    }

    // In production, parse actual coordinates from metadata
    // For now, return null as we don't have coordinate data
    return null;
  }
}

// Export singleton instance
export const fraudDetectionMiddleware = new FraudDetectionMiddleware();

// Export middleware function for direct use
export const detectFraud = fraudDetectionMiddleware.detectFraud;
