/**
 * Transaction domain schemas — derived from src/controllers/transactionController.ts
 * and src/middleware/validateTransaction.ts
 */

import { z } from 'zod';
import { registry } from '../registry';

export const TransactionRequestSchema = registry.register(
  'TransactionRequest',
  z
    .object({
      amount: z.number().positive().openapi({ example: 5000 }),
      phoneNumber: z
        .string()
        .regex(/^\+?\d{10,15}$/)
        .openapi({ example: '+237670000000', description: 'E.164 or local format phone number' }),
      provider: z.enum(['mtn', 'airtel', 'orange']).openapi({ example: 'mtn' }),
      stellarAddress: z
        .string()
        .regex(/^G[A-Z2-7]{55}$/)
        .openapi({
          example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
          description: 'Stellar public key (56 chars, starts with G)',
        }),
      userId: z.string().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
      notes: z.string().max(256).optional().openapi({ example: 'School fees payment' }),
    })
    .openapi('TransactionRequest'),
);

export const TransactionResponseSchema = registry.register(
  'TransactionResponse',
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      transactionId: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
      referenceNumber: z.string().openapi({ example: 'TXN-20240425-001' }),
      status: z
        .enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'review', 'dispute', 'reversed', 'clawed_back'])
        .openapi({ example: 'pending' }),
      amount: z.number().openapi({ example: 5000 }),
      provider: z.string().openapi({ example: 'mtn' }),
      createdAt: z.string().datetime().openapi({ example: '2024-04-25T10:00:00.000Z' }),
    })
    .openapi('TransactionResponse'),
);

export const TransactionDetailSchema = registry.register(
  'TransactionDetail',
  z
    .object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
      referenceNumber: z.string().openapi({ example: 'TXN-20240425-001' }),
      type: z.enum(['deposit', 'withdraw']).openapi({ example: 'deposit' }),
      status: z
        .enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'review', 'dispute', 'reversed', 'clawed_back'])
        .openapi({ example: 'completed' }),
      amount: z.number().openapi({ example: 5000 }),
      provider: z.string().openapi({ example: 'mtn' }),
      phoneNumber: z.string().openapi({ example: '+237670000000' }),
      stellarAddress: z.string().openapi({
        example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      }),
      notes: z.string().optional().openapi({ example: 'School fees payment' }),
      metadata: z.record(z.string(), z.unknown()).optional(),
      createdAt: z.string().datetime().openapi({ example: '2024-04-25T10:00:00.000Z' }),
      updatedAt: z.string().datetime().openapi({ example: '2024-04-25T10:05:00.000Z' }),
    })
    .openapi('TransactionDetail'),
);

export const TransactionListResponseSchema = registry.register(
  'TransactionListResponse',
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      data: z.array(TransactionDetailSchema),
      pagination: z.object({
        total: z.number().int().openapi({ example: 120 }),
        limit: z.number().int().openapi({ example: 20 }),
        offset: z.number().int().openapi({ example: 0 }),
      }),
    })
    .openapi('TransactionListResponse'),
);

export const UpdateNotesRequestSchema = registry.register(
  'UpdateNotesRequest',
  z
    .object({
      notes: z.string().max(256).openapi({ example: 'Updated payment note' }),
    })
    .openapi('UpdateNotesRequest'),
);

export const MetadataRequestSchema = registry.register(
  'MetadataRequest',
  z
    .object({
      metadata: z.record(z.string(), z.unknown()).openapi({
        example: { category: 'utilities', invoiceId: 'INV-001' },
      }),
    })
    .openapi('MetadataRequest'),
);

export const DeleteMetadataKeysRequestSchema = registry.register(
  'DeleteMetadataKeysRequest',
  z
    .object({
      keys: z.array(z.string()).openapi({ example: ['category', 'invoiceId'] }),
    })
    .openapi('DeleteMetadataKeysRequest'),
);
