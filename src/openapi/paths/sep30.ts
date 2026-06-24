/**
 * OpenAPI path registrations for /sep30/* (Multi-Sig Key Recovery).
 */

import { z } from 'zod';
import { registry } from '../registry';
import {
  ManagedKeySchema,
  RecoverySignerSchema,
  RecoverySessionSchema,
  KeyRotationResultSchema,
  AuditLogEntrySchema,
  CreateKeyRequestSchema,
  OpenSessionRequestSchema,
  ApproveRequestSchema,
} from '../schemas/sep30';
import { ErrorResponseSchema } from '../schemas/common';

const TAG = 'SEP-30 Key Recovery';
const KEY_ID_PARAM = z.object({ keyId: z.string().uuid().openapi({ example: 'key-uuid-here' }) });
const SESSION_PARAM = z.object({ sessionId: z.string().uuid().openapi({ example: 'session-uuid-here' }) });

// ─── Key Management ───────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/sep30/keys',
  tags: [TAG],
  summary: 'Create a new managed Stellar key for a user',
  description:
    'Generates a fresh Stellar keypair, encrypts the secret with AES-256-GCM, ' +
    'and stores it. The plaintext secret never leaves the server.',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateKeyRequestSchema } } },
  },
  responses: {
    201: { description: 'Key created', content: { 'application/json': { schema: ManagedKeySchema } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/sep30/keys',
  tags: [TAG],
  summary: 'List managed keys for a user',
  request: {
    query: z.object({ userId: z.string().uuid().openapi({ example: 'user-uuid-here' }) }),
  },
  responses: {
    200: {
      description: 'Managed keys (no secrets)',
      content: {
        'application/json': {
          schema: z.object({ keys: z.array(ManagedKeySchema) }).openapi('Sep30KeyList'),
        },
      },
    },
    400: { description: 'Missing userId', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/sep30/keys/{keyId}/threshold',
  tags: [TAG],
  summary: 'Update the M-of-N recovery threshold for a managed key',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              userId: z.string().uuid(),
              newThreshold: z.number().int().min(1).openapi({ example: 2 }),
            })
            .openapi('Sep30UpdateThresholdRequest'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Threshold updated', content: { 'application/json': { schema: z.object({ message: z.string(), keyId: z.string(), newThreshold: z.number() }).openapi('Sep30ThresholdResponse') } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Recovery Signers ─────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/signers',
  tags: [TAG],
  summary: 'Register a recovery signer',
  description: 'Adds a guardian or device key that can participate in M-of-N recovery.',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              userId: z.string().uuid(),
              signerPublicKey: z.string().length(56),
              signerLabel: z.string().min(1).max(100).openapi({ example: 'My phone key' }),
            })
            .openapi('Sep30AddSignerRequest'),
        },
      },
    },
  },
  responses: {
    201: { description: 'Signer registered', content: { 'application/json': { schema: RecoverySignerSchema } } },
    400: { description: 'Invalid key or validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/sep30/keys/{keyId}/signers',
  tags: [TAG],
  summary: 'List recovery signers',
  request: {
    params: KEY_ID_PARAM,
    query: z.object({ userId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Recovery signers',
      content: {
        'application/json': {
          schema: z.object({ signers: z.array(RecoverySignerSchema) }).openapi('Sep30SignerList'),
        },
      },
    },
  },
});

// ─── Recovery Session Flow ────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/recovery/session',
  tags: [TAG],
  summary: '[Step 0] Open a new multi-sig recovery session',
  description:
    'Creates a recovery session in state `pending`. Each signer calls /initiate and ' +
    '/approve independently, referencing this session ID. Once M-of-N approvals are ' +
    'collected the session advances to `awaiting_completion` and /complete can be called.',
  request: {
    params: KEY_ID_PARAM,
    body: { required: true, content: { 'application/json': { schema: OpenSessionRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Session opened',
      content: {
        'application/json': {
          schema: z
            .object({ session: RecoverySessionSchema, instructions: z.string() })
            .openapi('Sep30OpenSessionResponse'),
        },
      },
    },
    400: { description: 'Active session already exists or validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/recovery/initiate',
  tags: [TAG],
  summary: '[Step 1] Issue a challenge token to a recovery signer',
  description:
    'Generates a cryptographically random token. The signer must sign the raw token ' +
    'bytes with their Stellar private key and submit the base64 signature to /approve.',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              signerPublicKey: z.string().length(56),
              sessionId: z.string().uuid().optional().openapi({ description: 'ID from /session. Required for multi-signer flows.' }),
            })
            .openapi('Sep30InitiateRequest'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Challenge token issued',
      content: {
        'application/json': {
          schema: z
            .object({
              token: z.string().openapi({ description: 'Raw hex token to sign with your Stellar private key.' }),
              expiresAt: z.string().datetime(),
              sessionId: z.string().uuid(),
              instructions: z.string(),
            })
            .openapi('Sep30InitiateResponse'),
        },
      },
    },
    400: { description: 'Signer not registered', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/recovery/approve',
  tags: [TAG],
  summary: '[Step 2] Submit cryptographic proof — signer approves recovery',
  description:
    'Verifies the Stellar signature over the challenge token. Adds the signer to the ' +
    '`approved_by` list. When `approved_by.length >= required_approvals`, session ' +
    'advances to `awaiting_completion`.',
  request: {
    params: KEY_ID_PARAM,
    body: { required: true, content: { 'application/json': { schema: ApproveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Approval recorded',
      content: {
        'application/json': {
          schema: z
            .object({
              approved: z.boolean(),
              session: RecoverySessionSchema,
              nextStep: z.string(),
            })
            .openapi('Sep30ApproveResponse'),
        },
      },
    },
    400: { description: 'Invalid signature or session state', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Signature verification failed', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/recovery/complete',
  tags: [TAG],
  summary: '[Step 3] Finalise recovery and rotate the key',
  description:
    'Rotates the managed key to a new keypair (or the pre-specified address), ' +
    'marks the old key inactive, and closes the session as `completed`. ' +
    'Only callable when session.state === "awaiting_completion".',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({ sessionId: z.string().uuid() })
            .openapi('Sep30CompleteRequest'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Key rotated successfully',
      content: { 'application/json': { schema: KeyRotationResultSchema } },
    },
    400: { description: 'Session not in awaiting_completion state', content: { 'application/json': { schema: ErrorResponseSchema } } },
    410: { description: 'Session expired', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/recovery/cancel',
  tags: [TAG],
  summary: 'Cancel an in-progress recovery session',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              sessionId: z.string().uuid(),
              reason: z.string().optional().openapi({ example: 'User cancelled' }),
            })
            .openapi('Sep30CancelRequest'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Session cancelled', content: { 'application/json': { schema: z.object({ message: z.string(), sessionId: z.string() }).openapi('Sep30CancelResponse') } } },
    400: { description: 'Session already in terminal state', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ─── Session Queries ──────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/sep30/keys/{keyId}/recovery/sessions',
  tags: [TAG],
  summary: 'List all recovery sessions for a managed key',
  request: {
    params: KEY_ID_PARAM,
    query: z.object({
      userId: z.string().uuid(),
      state: z.enum(['pending', 'collecting_approvals', 'awaiting_completion', 'completed', 'rejected']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Recovery sessions',
      content: {
        'application/json': {
          schema: z.object({ sessions: z.array(RecoverySessionSchema) }).openapi('Sep30SessionList'),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/sep30/keys/{keyId}/recovery/sessions/{sessionId}',
  tags: [TAG],
  summary: 'Get a specific recovery session',
  request: { params: KEY_ID_PARAM.merge(SESSION_PARAM) },
  responses: {
    200: { description: 'Recovery session', content: { 'application/json': { schema: RecoverySessionSchema } } },
    404: { description: 'Session not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/sep30/keys/{keyId}/recovery/sessions/{sessionId}/audit',
  tags: [TAG],
  summary: 'Get the full audit log for a recovery session',
  description: 'Returns every state transition, signer approval, and metadata event.',
  request: { params: KEY_ID_PARAM.merge(SESSION_PARAM) },
  responses: {
    200: {
      description: 'Audit log',
      content: {
        'application/json': {
          schema: z
            .object({ sessionId: z.string().uuid(), log: z.array(AuditLogEntrySchema) })
            .openapi('Sep30AuditLogResponse'),
        },
      },
    },
  },
});

// ─── Key Rotation ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/sep30/keys/{keyId}/rotate',
  tags: [TAG],
  summary: 'Planned key rotation (owner-initiated, no recovery required)',
  request: {
    params: KEY_ID_PARAM,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ userId: z.string().uuid() }).openapi('Sep30RotateRequest'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Key rotated', content: { 'application/json': { schema: KeyRotationResultSchema } } },
    400: { description: 'Error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
