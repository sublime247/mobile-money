/**
 * SEP-30 Multi-Sig Key Recovery — Zod/OpenAPI schema definitions.
 */

import { z } from 'zod';
import { registry } from '../registry';

// ─── Primitives ───────────────────────────────────────────────────────────────

export const StellarPublicKeySchema = z
  .string()
  .length(56)
  .openapi({ example: 'GABC...XYZ', description: '56-character Stellar public key (G...)' });

// ─── Recovery Session ─────────────────────────────────────────────────────────

export const RecoverySessionStateSchema = z.enum([
  'pending',
  'collecting_approvals',
  'awaiting_completion',
  'completed',
  'rejected',
]);

export const RecoverySessionSchema = registry.register(
  'Sep30RecoverySession',
  z
    .object({
      id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
      managedKeyId: z.string().uuid(),
      requiredApprovals: z.number().int().openapi({ example: 2 }),
      state: RecoverySessionStateSchema.openapi({
        description:
          'FSM state: pending → collecting_approvals → awaiting_completion → completed | rejected',
      }),
      approvedBy: z
        .array(StellarPublicKeySchema)
        .openapi({ description: 'List of signer public keys that have submitted valid signatures' }),
      requestedNewAddress: StellarPublicKeySchema.nullable().optional().openapi({
        description: 'Optional custom Stellar address to rotate to. NULL = generate fresh keypair.',
      }),
      expiresAt: z.string().datetime().openapi({ example: '2024-04-25T10:30:00.000Z' }),
      completedAt: z.string().datetime().nullable().optional(),
      rejectedReason: z.string().nullable().optional(),
      newPublicKey: StellarPublicKeySchema.nullable().optional(),
      oldPublicKey: StellarPublicKeySchema.nullable().optional(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    })
    .openapi('Sep30RecoverySession', {
      description: 'Multi-sig key recovery session tracking state, approvals, and audit info.',
    }),
);

// ─── Managed Key ─────────────────────────────────────────────────────────────

export const ManagedKeySchema = registry.register(
  'Sep30ManagedKey',
  z
    .object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      publicKey: StellarPublicKeySchema,
      recoveryThreshold: z.number().int().openapi({ example: 2 }),
      isActive: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    })
    .openapi('Sep30ManagedKey', { description: 'An AES-256-GCM-encrypted Stellar keypair.' }),
);

// ─── Recovery Signer ─────────────────────────────────────────────────────────

export const RecoverySignerSchema = registry.register(
  'Sep30RecoverySigner',
  z
    .object({
      id: z.string().uuid(),
      managedKeyId: z.string().uuid(),
      signerPublicKey: StellarPublicKeySchema,
      signerLabel: z.string().openapi({ example: 'My phone key' }),
      createdAt: z.string().datetime(),
    })
    .openapi('Sep30RecoverySigner'),
);

// ─── Key Rotation Result ──────────────────────────────────────────────────────

export const KeyRotationResultSchema = registry.register(
  'Sep30KeyRotationResult',
  z
    .object({
      newPublicKey: StellarPublicKeySchema,
      oldPublicKey: StellarPublicKeySchema,
      rotatedAt: z.string().datetime(),
      sessionId: z.string().uuid().optional(),
    })
    .openapi('Sep30KeyRotationResult'),
);

// ─── Audit Log Entry ──────────────────────────────────────────────────────────

export const AuditLogEntrySchema = registry.register(
  'Sep30AuditLogEntry',
  z
    .object({
      id: z.string().uuid(),
      sessionId: z.string().uuid(),
      eventType: z.string().openapi({ example: 'signer_approved' }),
      signerPublicKey: StellarPublicKeySchema.nullable().optional(),
      fromState: RecoverySessionStateSchema.nullable().optional(),
      toState: RecoverySessionStateSchema,
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      occurredAt: z.string().datetime(),
      ipAddress: z.string().nullable().optional(),
    })
    .openapi('Sep30AuditLogEntry'),
);

// ─── Request bodies ───────────────────────────────────────────────────────────

export const CreateKeyRequestSchema = registry.register(
  'Sep30CreateKeyRequest',
  z
    .object({
      userId: z.string().uuid().openapi({ example: 'user-uuid-here' }),
      recoveryThreshold: z.number().int().min(1).optional().openapi({ example: 2 }),
    })
    .openapi('Sep30CreateKeyRequest'),
);

export const OpenSessionRequestSchema = registry.register(
  'Sep30OpenSessionRequest',
  z
    .object({
      requestedNewAddress: StellarPublicKeySchema.optional().openapi({
        description: 'Optional: rotate to a specific Stellar address instead of generating a fresh one.',
      }),
    })
    .openapi('Sep30OpenSessionRequest'),
);

export const ApproveRequestSchema = registry.register(
  'Sep30ApproveRequest',
  z
    .object({
      sessionId: z.string().uuid(),
      signerPublicKey: StellarPublicKeySchema,
      token: z.string().min(1).openapi({ description: 'Raw token from the /initiate response.' }),
      signature: z.string().min(1).openapi({
        description: 'Base64 Stellar signature of the token bytes made with the signer\'s private key.',
      }),
    })
    .openapi('Sep30ApproveRequest'),
);
