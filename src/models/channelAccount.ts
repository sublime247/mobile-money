/**
 * Channel Account Model
 *
 * Database-backed persistence layer for Stellar channel accounts.
 * Handles encrypted key storage, atomic acquisition via row-level locking,
 * and stale-lock recovery.
 *
 * Issue: #843
 */

import { queryRead, queryWrite, pool } from "../config/database";
import {
  encryptAES,
  decryptAES,
  deriveKey,
  serializePayload,
  deserializePayload,
} from "../utils/encryption";
import { env } from "../config/env";

// Types

/** Status of a channel account in the pool */
export type ChannelAccountStatus = "idle" | "busy" | "disabled" | "funding";

/** Row shape returned from the channel_accounts table */
export interface ChannelAccountRow {
  id: string;
  publicKey: string;
  encryptedKey: string;
  status: ChannelAccountStatus;
  sequence: string; // bigint comes back as string from pg
  errorCount: number;
  lockedAt: Date | null;
  disabledAt: Date | null;
  lastUsedAt: Date | null;
  fundedAt: Date | null;
  balance: string;
  createdAt: Date;
  updatedAt: Date;
}

// Key derivation — domain-separated from PII keys

const CHANNEL_KEY_INFO = "channel-accounts";

function getChannelKey(): Buffer {
  return deriveKey(env.DB_ENCRYPTION_KEY, CHANNEL_KEY_INFO);
}

// Column mapping

const SELECT_COLUMNS = `
  id,
  public_key      AS "publicKey",
  encrypted_key   AS "encryptedKey",
  status,
  sequence::text  AS "sequence",
  error_count     AS "errorCount",
  locked_at       AS "lockedAt",
  disabled_at     AS "disabledAt",
  last_used_at    AS "lastUsedAt",
  funded_at       AS "fundedAt",
  balance::text   AS "balance",
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`;

// Model

export class ChannelAccountModel {
  // Create

  /**
   * Insert a new channel account with an encrypted secret key.
   */
  async create(
    publicKey: string,
    secretKey: string,
    opts: {
      balance?: string;
      sequence?: string;
      status?: ChannelAccountStatus;
    } = {},
  ): Promise<ChannelAccountRow> {
    const key = getChannelKey();
    const encryptedKey = serializePayload(encryptAES(secretKey, key));

    const result = await queryWrite<ChannelAccountRow>(
      `INSERT INTO channel_accounts
         (public_key, encrypted_key, balance, sequence, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [
        publicKey,
        encryptedKey,
        opts.balance ?? "0",
        opts.sequence ?? "0",
        opts.status ?? "idle",
      ],
    );

    return result.rows[0];
  }

  // Acquire / Release  (hot path — row-level locking)

  /**
   * Atomically acquire an idle channel account.
   *
   * Uses `FOR UPDATE SKIP LOCKED` so concurrent callers never contend on the
   * same row — each gets a different idle account or NULL if none available.
   */
  async acquireIdle(): Promise<ChannelAccountRow | null> {
    const result = await queryWrite<ChannelAccountRow>(
      `UPDATE channel_accounts
       SET status     = 'busy',
           locked_at  = NOW(),
           last_used_at = NOW()
       WHERE id = (
         SELECT id FROM channel_accounts
         WHERE status = 'idle'
         ORDER BY last_used_at ASC NULLS FIRST, error_count ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${SELECT_COLUMNS}`,
    );

    return result.rows[0] ?? null;
  }

  /**
   * Release a channel account after transaction completion.
   *
   * On success: resets to idle, clears error count, updates sequence.
   * On failure: increments error count; disables if threshold exceeded.
   */
  async release(
    id: string,
    success: boolean,
    opts: { newSequence?: string; maxErrors?: number } = {},
  ): Promise<ChannelAccountRow | null> {
    const maxErrors = opts.maxErrors ?? 5;

    if (success) {
      const params: unknown[] = [id];
      let seqClause = "";
      if (opts.newSequence !== undefined) {
        seqClause = ", sequence = $2";
        params.push(opts.newSequence);
      }

      const result = await queryWrite<ChannelAccountRow>(
        `UPDATE channel_accounts
         SET status      = 'idle',
             locked_at   = NULL,
             error_count = 0
             ${seqClause}
         WHERE id = $1
         RETURNING ${SELECT_COLUMNS}`,
        params,
      );
      return result.rows[0] ?? null;
    }

    // Failure path: increment error_count, conditionally disable
    const result = await queryWrite<ChannelAccountRow>(
      `UPDATE channel_accounts
       SET status      = CASE WHEN error_count + 1 >= $2 THEN 'disabled' ELSE 'idle' END,
           locked_at   = NULL,
           disabled_at = CASE WHEN error_count + 1 >= $2 THEN NOW() ELSE disabled_at END,
           error_count = error_count + 1
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, maxErrors],
    );

    return result.rows[0] ?? null;
  }

  // Recovery

  /**
   * Recover channel accounts stuck in 'busy' state past a timeout threshold.
   * Returns the number of recovered accounts.
   */
  async recoverStale(timeoutMs: number): Promise<number> {
    const result = await queryWrite(
      `UPDATE channel_accounts
       SET status    = 'idle',
           locked_at = NULL,
           error_count = error_count + 1
       WHERE status = 'busy'
         AND locked_at < NOW() - ($1 || ' milliseconds')::INTERVAL`,
      [timeoutMs],
    );

    return result.rowCount ?? 0;
  }

  /**
   * Re-enable disabled accounts that have been disabled for longer than
   * the recovery period.
   */
  async recoverDisabled(recoveryMs: number): Promise<number> {
    const result = await queryWrite(
      `UPDATE channel_accounts
       SET status      = 'idle',
           disabled_at = NULL,
           error_count = 0
       WHERE status = 'disabled'
         AND disabled_at < NOW() - ($1 || ' milliseconds')::INTERVAL`,
      [recoveryMs],
    );

    return result.rowCount ?? 0;
  }

  // Queries

  async findAll(): Promise<ChannelAccountRow[]> {
    const result = await queryRead<ChannelAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM channel_accounts ORDER BY created_at ASC`,
    );
    return result.rows;
  }

  async findById(id: string): Promise<ChannelAccountRow | null> {
    const result = await queryRead<ChannelAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM channel_accounts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findByPublicKey(publicKey: string): Promise<ChannelAccountRow | null> {
    const result = await queryRead<ChannelAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM channel_accounts WHERE public_key = $1`,
      [publicKey],
    );
    return result.rows[0] ?? null;
  }

  async findByStatus(
    status: ChannelAccountStatus,
  ): Promise<ChannelAccountRow[]> {
    const result = await queryRead<ChannelAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM channel_accounts WHERE status = $1 ORDER BY last_used_at ASC`,
      [status],
    );
    return result.rows;
  }

  async countByStatus(status: ChannelAccountStatus): Promise<number> {
    const result = await queryRead<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channel_accounts WHERE status = $1`,
      [status],
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async countAll(): Promise<number> {
    const result = await queryRead<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channel_accounts`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  // Updates

  async updateSequence(id: string, sequence: string): Promise<void> {
    await queryWrite(
      `UPDATE channel_accounts SET sequence = $2 WHERE id = $1`,
      [id, sequence],
    );
  }

  async updateBalance(id: string, balance: string): Promise<void> {
    await queryWrite(
      `UPDATE channel_accounts SET balance = $2, funded_at = NOW() WHERE id = $1`,
      [id, balance],
    );
  }

  async disable(id: string): Promise<void> {
    await queryWrite(
      `UPDATE channel_accounts
       SET status = 'disabled', disabled_at = NOW(), locked_at = NULL
       WHERE id = $1`,
      [id],
    );
  }

  async enable(id: string): Promise<void> {
    await queryWrite(
      `UPDATE channel_accounts
       SET status = 'idle', disabled_at = NULL, error_count = 0
       WHERE id = $1`,
      [id],
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await queryWrite(
      `DELETE FROM channel_accounts WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Decryption helper

  /**
   * Decrypt the secret key for a channel account row.
   * Call only when you need the raw key (e.g. to sign a transaction).
   */
  decryptSecretKey(row: ChannelAccountRow): string {
    const key = getChannelKey();
    const payload = deserializePayload(row.encryptedKey);
    return decryptAES(payload, key);
  }
}

export const channelAccountModel = new ChannelAccountModel();
