/**
 * OpenAPI path registrations for /api/transactions/* and /api/v1/transactions/*
 */

import { z } from 'zod';
import { registry } from '../registry';
import {
  TransactionRequestSchema,
  TransactionResponseSchema,
  TransactionDetailSchema,
  TransactionListResponseSchema,
  UpdateNotesRequestSchema,
  MetadataRequestSchema,
  DeleteMetadataKeysRequestSchema,
} from '../schemas/transactions';
import { ErrorResponseSchema } from '../schemas/common';

const TAG = 'Transactions';
const SECURITY = [{ bearerAuth: [] }];

// ─── Deposit ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/api/v1/transactions/deposit',
  tags: [TAG],
  summary: 'Initiate a mobile money deposit to Stellar',
  security: SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: TransactionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Deposit initiated',
      content: { 'application/json': { schema: TransactionResponseSchema } },
    },
    400: { description: 'Validation error or limit exceeded', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Withdraw ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/api/v1/transactions/withdraw',
  tags: [TAG],
  summary: 'Initiate a Stellar withdrawal to mobile money',
  security: SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: TransactionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Withdrawal initiated',
      content: { 'application/json': { schema: TransactionResponseSchema } },
    },
    400: { description: 'Validation error or limit exceeded', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── List transactions ────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/transactions',
  tags: [TAG],
  summary: 'List transactions with pagination',
  security: SECURITY,
  request: {
    query: z.object({
      limit: z.coerce.number().int().positive().max(100).optional().openapi({ example: 20 }),
      offset: z.coerce.number().int().min(0).optional().openapi({ example: 0 }),
      before: z.string().optional().openapi({ description: 'Cursor for backward pagination' }),
      after: z.string().optional().openapi({ description: 'Cursor for forward pagination' }),
    }),
  },
  responses: {
    200: {
      description: 'Paginated list of transactions',
      content: { 'application/json': { schema: TransactionListResponseSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Get transaction ──────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/transactions/{id}',
  tags: [TAG],
  summary: 'Get a single transaction by ID',
  security: SECURITY,
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    }),
  },
  responses: {
    200: {
      description: 'Transaction details',
      content: { 'application/json': { schema: TransactionDetailSchema } },
    },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/transactions/{id}/invoice',
  tags: [TAG],
  summary: 'Download a completed transaction invoice as a PDF',
  security: SECURITY,
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    }),
    query: z.object({
      download: z.string().optional().openapi({ description: 'Set to 0 to display inline instead of downloading' }),
    }),
  },
  responses: {
    200: {
      description: 'PDF invoice generated',
      content: {
        'application/pdf': {
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
    },
    400: { description: 'Invoice download only available for completed transactions', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Cancel transaction ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/api/v1/transactions/{id}/cancel',
  tags: [TAG],
  summary: 'Cancel a pending transaction',
  security: SECURITY,
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    }),
  },
  responses: {
    200: { description: 'Transaction cancelled' },
    400: { description: 'Cannot cancel transaction in current state', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Update notes ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'patch',
  path: '/api/v1/transactions/{id}/notes',
  tags: [TAG],
  summary: 'Update transaction notes',
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: UpdateNotesRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Notes updated' },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'put',
  path: '/api/v1/transactions/{id}/metadata',
  tags: [TAG],
  summary: 'Replace transaction metadata',
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: MetadataRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Metadata replaced' },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/transactions/{id}/metadata',
  tags: [TAG],
  summary: 'Merge transaction metadata keys',
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: MetadataRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Metadata merged' },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/transactions/{id}/metadata',
  tags: [TAG],
  summary: 'Delete specific metadata keys from a transaction',
  security: SECURITY,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: DeleteMetadataKeysRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Metadata keys deleted' },
    404: { description: 'Transaction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
