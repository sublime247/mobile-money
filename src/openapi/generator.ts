/**
 * OpenAPI document generator.
 *
 * Imports all schema and path registration modules (side-effects only),
 * then generates a fresh OpenAPI 3.0 document from the registry.
 *
 * Called at server start — never cached to disk.
 */

// ── Schema registrations (must run before path registrations) ─────────────────
import './schemas/common';
import './schemas/auth';
import './schemas/transactions';
import './schemas/vaults';
import './schemas/contacts';
import './schemas/fees';
import './schemas/kyc';
import './schemas/htlc';
import './schemas/prices';
import './schemas/sep38';
import './schemas/sep30';

// ── Path registrations ────────────────────────────────────────────────────────
import './paths/auth';
import './paths/transactions';
import './paths/vaults';
import './paths/contacts';
import './paths/fees';
import './paths/kyc';
import './paths/htlc';
import './paths/prices';
import './paths/sep38';
import './paths/sep30';

import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';

/**
 * Generate a fresh OpenAPI 3.0 document on every call.
 * No caching — the spec always reflects the current schema state.
 */
export function generateOpenAPIDocument(): Record<string, unknown> {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Mobile Money Bridge API',
      version: '1.0.0',
      description:
        'API for bridging mobile money providers (MTN, Airtel, Orange) with the Stellar network. ' +
        'This spec is generated at runtime from Zod schemas — it is always in sync with validation logic.',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Local development server',
      },
    ],
    tags: [
      { name: 'Auth', description: 'Authentication and token management' },
      { name: 'Transactions', description: 'Mobile money ↔ Stellar transactions' },
      { name: 'Vaults', description: 'Savings vaults' },
      { name: 'Contacts', description: 'Saved payment contacts' },
      { name: 'Fees', description: 'Fee configuration' },
      { name: 'Fee Strategies', description: 'Dynamic fee strategy engine' },
      { name: 'KYC', description: 'Know Your Customer identity verification' },
      { name: 'HTLC', description: 'Hash Time-Locked Contracts on Stellar' },
      { name: 'Prices', description: 'Historical price data' },
      { name: 'SEP-38 Quotes', description: 'SEP-38 Quote & Price Stream protocol — firm quotes locked in Redis' },
      { name: 'SEP-30 Key Recovery', description: 'SEP-30 Multi-Sig Key Recovery — M-of-N cryptographic recovery sessions with full audit trail' },
    ],
  }) as unknown as Record<string, unknown>;
}
