// src/services/ledgerIngest.ts

import { Pool, PoolClient } from "pg";

const BATCH_SIZE = 500;

export interface LedgerOperation {
  ledgerSequence: number;
  transactionHash: string;
  operationId: string;

  account: string;
  assetCode: string;

  amount: string;

  operationType: string;

  createdAt: Date;
}
function chunk<T>(
  items: T[],
  size: number
): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(
      items.slice(i, i + size)
    );
  }

  return chunks;
}
function buildBatchInsert(
  operations: LedgerOperation[]
) {
  const values: unknown[] = [];

  const placeholders = operations.map(
    (operation, index) => {
      const offset = index * 9;

      values.push(
        operation.ledgerSequence,
        operation.transactionHash,
        operation.operationId,
        operation.account,
        operation.assetCode,
        operation.amount,
        operation.operationType,
        operation.createdAt
      );

      return `(
        $${offset + 1},
        $${offset + 2},
        $${offset + 3},
        $${offset + 4},
        $${offset + 5},
        $${offset + 6},
        $${offset + 7},
        $${offset + 8}
      )`;
    }
  );

  return {
    sql: `
      INSERT INTO ledger_operations (
        ledger_sequence,
        transaction_hash,
        operation_id,
        account,
        asset_code,
        amount,
        operation_type,
        created_at
      )
      VALUES
      ${placeholders.join(",")}
    `,
    values,
  };
}