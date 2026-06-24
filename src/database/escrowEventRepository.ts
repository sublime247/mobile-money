// src/database/escrowEventRepository.ts
import { pool } from "../config/database";
import { QueryResult } from "pg";

export interface EscrowEvent {
  tx_hash: string;
  ledger: number;
  event_type: "lock" | "release";
  payload: Record<string, any>;
  created_at: Date;
}

export async function insertEscrowEvent(event: EscrowEvent): Promise<QueryResult<any>> {
  const query = `
    INSERT INTO escrow_events (tx_hash, ledger, event_type, payload, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING;
  `;
  const values = [
    event.tx_hash,
    event.ledger,
    event.event_type,
    JSON.stringify(event.payload),
    event.created_at,
  ];
  return pool.query(query, values);
}
