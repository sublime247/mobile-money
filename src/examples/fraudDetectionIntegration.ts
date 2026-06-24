/**
 * Example: Integrating Fraud Detection with Transaction Processing
 * 
 * This file demonstrates how to integrate the enhanced fraud detection
 * system with existing transaction controllers and services.
 */

import { Request, Response } from 'express';
import { fraudDetectionMiddleware } from '../middleware/fraudDetection';
import { TransactionModel } from '../models/transaction';
import { fraudService, FraudTransactionInput } from '../services/fraud';
import { TransactionStatus } from '../models/transaction';

/**
 * Enhanced Transaction Controller with Fraud Detection
 */
export class EnhancedTransactionController {
  private transactionModel: TransactionModel;

  constructor() {
    this.transactionModel = new TransactionModel();
  }

  /**
   * Create a new transaction with fraud detection
   */
  async createTransaction(req: Request, res: Response): Promise<void> {
    try {
      // Apply fraud detection middleware
      await fraudDetectionMiddleware.detectFraud(req, res, async () => {
        // Transaction creation logic here
        const transactionData = req.body;
        
        // Create transaction
        const transaction = await this.transactionModel.create({
          type: transactionData.type,
          amount: transactionData.amount,
          phoneNumber: transactionData.phoneNumber,
          provider: transactionData.provider,
          stellarAddress: transactionData.stellarAddress,
          status: TransactionStatus.Pending,
          userId: transactionData.userId || req.user?.id,
          metadata: transactionData.metadata,
          locationMetadata: transactionData.locationMetadata
        });

        // Check if fraud was detected
        const fraudResult = (req as any).fraudResult;
        if (fraudResult?.isFraud) {
          // Transaction already set to Review status by middleware
          res.status(202).json({
            message: 'Transaction created and flagged for review',
            transaction,
            fraudAnalysis: {
              score: fraudResult.score,
              riskLevel: fraudResult.riskLevel,
              reasons: fraudResult.reasons,
              recommendedAction: fraudResult.recommendedAction
            }
          });
        } else {
          res.status(201).json({
            message: 'Transaction created successfully',
            transaction
          });
        }
      });
    } catch (error) {
      console.error('Transaction creation error:', error);
      res.status(500).json({ error: 'Failed to create transaction' });
    }
  }

  /**
   * Get transactions with fraud analysis
   */
  async getTransactions(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 50, offset = 0, status } = req.query;
      
      // Get transactions with optional status filter
      const transactions = await this.transactionModel.list(
        parseInt(limit as string),
        parseInt(offset as string),
        undefined,
        undefined,
        status ? { status } as any : undefined
      );

      // Enrich with fraud analysis for review transactions
      const enrichedTransactions = await Promise.all(
        transactions.map(async (transaction) => {
          if (transaction.status === TransactionStatus.Review) {
            // Get fraud analysis for review transactions
            const fraudInput: FraudTransactionInput = {
              id: transaction.id,
              userId: transaction.userId,
              amount: parseFloat(transaction.amount),
              phoneNumber: transaction.phoneNumber,
              timestamp: transaction.createdAt,
              location: null, // Extract from metadata if needed
              type: transaction.type as "deposit" | "withdraw",
              provider: transaction.provider,
              metadata: transaction.metadata
            };

            const fraudResult = await fraudService.detectFraud(fraudInput);
            
            return {
              ...transaction,
              fraudAnalysis: fraudResult
            };
          }
          return transaction;
        })
      );

      res.json({
        transactions: enrichedTransactions,
        total: transactions.length
      });
    } catch (error) {
      console.error('Get transactions error:', error);
      res.status(500).json({ error: 'Failed to get transactions' });
    }
  }

  /**
   * Get fraud review queue
   */
  async getReviewQueue(req: Request, res: Response): Promise<void> {
    try {
      const reviewQueue = fraudService.getReviewQueue();
      
      res.json({
        reviewQueue,
        count: reviewQueue.length
      });
    } catch (error) {
      console.error('Get review queue error:', error);
      res.status(500).json({ error: 'Failed to get review queue' });
    }
  }

  /**
   * Process transaction from review queue
   */
  async processReviewTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { transactionId, action, notes } = req.body;
      
      if (!transactionId || !action) {
        res.status(400).json({ error: 'Transaction ID and action are required' });
        return;
      }

      const transaction = await this.transactionModel.findById(transactionId);
      if (!transaction) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      // Update transaction status based on action
      let newStatus: TransactionStatus;
      switch (action.toLowerCase()) {
        case 'approve':
          newStatus = TransactionStatus.Completed;
          break;
        case 'reject':
          newStatus = TransactionStatus.Failed;
          break;
        case 'block':
          newStatus = TransactionStatus.Cancelled;
          break;
        default:
          res.status(400).json({ error: 'Invalid action' });
          return;
      }

      await this.transactionModel.updateStatus(transactionId, newStatus);
      
      // Add admin notes if provided
      if (notes) {
        await this.transactionModel.updateAdminNotes(transactionId, notes);
      }

      // Remove from review queue
      const reviewQueue = fraudService.getReviewQueue();
      const updatedQueue = reviewQueue.filter(tx => tx.id !== transactionId);
      fraudService.clearReviewQueue();
      updatedQueue.forEach(tx => fraudService.addToReviewQueue(tx));

      res.json({
        message: `Transaction ${action.toLowerCase()}d successfully`,
        transactionId,
        newStatus
      });
    } catch (error) {
      console.error('Process review transaction error:', error);
      res.status(500).json({ error: 'Failed to process review transaction' });
    }
  }

  /**
   * Get fraud statistics
   */
  async getFraudStatistics(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.query;
      
      // Get transactions in date range
      const transactions = await this.transactionModel.list(
        1000, // Large limit for stats
        0,
        startDate as string,
        endDate as string
      );

      // Calculate fraud statistics
      const stats = {
        totalTransactions: transactions.length,
        reviewTransactions: transactions.filter(t => t.status === TransactionStatus.Review).length,
        completedTransactions: transactions.filter(t => t.status === TransactionStatus.Completed).length,
        failedTransactions: transactions.filter(t => t.status === TransactionStatus.Failed).length,
        fraudRate: 0,
        reviewQueueSize: fraudService.getReviewQueue().length
      };

      stats.fraudRate = (stats.reviewTransactions / stats.totalTransactions) * 100;

      res.json(stats);
    } catch (error) {
      console.error('Get fraud statistics error:', error);
      res.status(500).json({ error: 'Failed to get fraud statistics' });
    }
  }
}

/**
 * Example route setup
 */
export function setupFraudDetectionRoutes(app: any): void {
  const controller = new EnhancedTransactionController();

  // Apply fraud detection middleware to transaction creation
  app.post('/api/transactions', fraudDetectionMiddleware.detectFraud, controller.createTransaction.bind(controller));
  
  // Other routes
  app.get('/api/transactions', controller.getTransactions.bind(controller));
  app.get('/api/fraud/review-queue', controller.getReviewQueue.bind(controller));
  app.post('/api/fraud/review-queue/:transactionId/process', controller.processReviewTransaction.bind(controller));
  app.get('/api/fraud/statistics', controller.getFraudStatistics.bind(controller));
}

/**
 * Example usage in existing transaction controller
 */
export function enhanceExistingController(existingController: any): void {
  // Add fraud detection to existing create method
  const originalCreate = existingController.createTransaction;
  
  existingController.createTransaction = async (req: Request, res: Response) => {
    // Apply fraud detection middleware
    await fraudDetectionMiddleware.detectFraud(req, res, async () => {
      // Call original method
      await originalCreate.call(existingController, req, res);
    });
  };

  // Add fraud analysis to existing transaction processing
  const originalProcess = existingController.processTransaction;
  
  existingController.processTransaction = async (req: Request, res: Response) => {
    // Call original method
    await originalProcess.call(existingController, req, res);
    
    // Analyze completed transaction for fraud learning
    if (res.locals.transaction) {
      await fraudDetectionMiddleware.analyzeCompletedTransaction(res.locals.transaction, req);
    }
  };
}
