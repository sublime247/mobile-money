/**
 * AML Travel Rule Service — FATF Recommendation 16
 * Captures encrypted sender/receiver identity for transactions >= $1,000.
 * PII is never written to logs — only redacted summaries.
 */

import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";

export const TRAVEL_RULE_THRESHOLD_USD = Number(
  process.env.TRAVEL_RULE_THRESHOLD_USD ?? 1000,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TravelRuleParty {
  name: string;
  account: string;
  address?: string;
  dob?: string;
  idNumber?: string;
}

export interface TravelRuleInput {
  transactionId: string;
  amount: number;
  currency?: string;
  sender: TravelRuleParty;
  receiver: TravelRuleParty;
  originatingVasp?: string;
  beneficiaryVasp?: string;
}

export interface TravelRuleRecord {
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  sender: TravelRuleParty;
  receiver: TravelRuleParty;
  originatingVasp?: string;
  beneficiaryVasp?: string;
  ivms101Payload?: Record<string, any>;
  createdAt: Date;
  exportedAt?: Date;
  exportedBy?: string;
}

/**
 * Build IVMS101 compliant metadata block structure (FATF Recommendation 16) (#1563).
 */
export function buildIvms101Payload(
  sender: TravelRuleParty,
  receiver: TravelRuleParty,
  amount: number,
  currency: string = "USD",
): Record<string, any> {
  return {
    originator: {
      originatorPersons: [
        {
          naturalPerson: {
            name: {
              nameIdentifier: [{ primaryIdentifier: sender.name, nameIdentifierType: "LEGL" }],
            },
            geographicAddress: sender.address
              ? [{ addressType: "HOME", addressLine: [sender.address] }]
              : undefined,
            dateAndPlaceOfBirth: sender.dob ? { dateOfBirth: sender.dob } : undefined,
            nationalIdentification: sender.idNumber
              ? { nationalIdentifier: sender.idNumber, nationalIdentifierType: "NATIONAL_ID" }
              : undefined,
          },
        },
      ],
      accountNumber: [sender.account],
    },
    beneficiary: {
      beneficiaryPersons: [
        {
          naturalPerson: {
            name: {
              nameIdentifier: [{ primaryIdentifier: receiver.name, nameIdentifierType: "LEGL" }],
            },
            geographicAddress: receiver.address
              ? [{ addressType: "HOME", addressLine: [receiver.address] }]
              : undefined,
          },
        },
      ],
      accountNumber: [receiver.account],
    },
    transferHeader: {
      transferType: "CROSS_BORDER",
      amount: amount.toString(),
      currency,
    },
  };
}

/**
 * Validate IVMS101 compliance metadata block format (#1563).
 */
export function validateIvms101Payload(payload: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Missing IVMS101 payload object"] };
  }

  const originator = payload.originator;
  if (!originator || !Array.isArray(originator.accountNumber) || originator.accountNumber.length === 0) {
    errors.push("IVMS101 originator must include accountNumber");
  }
  const origPerson = originator?.originatorPersons?.[0]?.naturalPerson;
  if (!origPerson?.name?.nameIdentifier?.[0]?.primaryIdentifier) {
    errors.push("IVMS101 originator must include valid primaryIdentifier name");
  }

  const beneficiary = payload.beneficiary;
  if (!beneficiary || !Array.isArray(beneficiary.accountNumber) || beneficiary.accountNumber.length === 0) {
    errors.push("IVMS101 beneficiary must include accountNumber");
  }
  const benPerson = beneficiary?.beneficiaryPersons?.[0]?.naturalPerson;
  if (!benPerson?.name?.nameIdentifier?.[0]?.primaryIdentifier) {
    errors.push("IVMS101 beneficiary must include valid primaryIdentifier name");
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redactAccount(account: string): string {
  if (account.length <= 4) return "****";
  return `****${account.slice(-4)}`;
}

function encryptParty(party: TravelRuleParty) {
  return {
    name: encrypt(party.name) as string,
    account: encrypt(party.account) as string,
    address: party.address ? (encrypt(party.address) as string) : null,
    dob: party.dob ? (encrypt(party.dob) as string) : null,
    idNumber: party.idNumber ? (encrypt(party.idNumber) as string) : null,
  };
}

function decryptParty(row: {
  name: string;
  account: string;
  address?: string | null;
  dob?: string | null;
  id_number?: string | null;
}): TravelRuleParty {
  return {
    name: (decrypt(row.name) as string) ?? row.name,
    account: (decrypt(row.account) as string) ?? row.account,
    address: row.address
      ? ((decrypt(row.address) as string) ?? undefined)
      : undefined,
    dob: row.dob ? ((decrypt(row.dob) as string) ?? undefined) : undefined,
    idNumber: row.id_number
      ? ((decrypt(row.id_number) as string) ?? undefined)
      : undefined,
  };
}

function mapRow(row: Record<string, unknown>): TravelRuleRecord {
  return {
    id: row.id as string,
    transactionId: row.transaction_id as string,
    amount: Number(row.amount),
    currency: row.currency as string,
    sender: decryptParty({
      name: row.sender_name as string,
      account: row.sender_account as string,
      address: row.sender_address as string | null,
      dob: row.sender_dob as string | null,
      id_number: row.sender_id_number as string | null,
    }),
    receiver: decryptParty({
      name: row.receiver_name as string,
      account: row.receiver_account as string,
      address: row.receiver_address as string | null,
    }),
    originatingVasp: row.originating_vasp as string | undefined,
    beneficiaryVasp: row.beneficiary_vasp as string | undefined,
    createdAt: row.created_at as Date,
    exportedAt: row.exported_at as Date | undefined,
    exportedBy: row.exported_by as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TravelRuleService {
  /** Returns true when the Travel Rule applies to this USD amount. */
  applies(amountUsd: number): boolean {
    return amountUsd >= TRAVEL_RULE_THRESHOLD_USD;
  }

  /**
   * Enforce Travel Rule IVMS101 compliance on outbound transactions (#1563).
   * Blocks qualifying transactions (amount >= $1000) failing compliance formatting.
   */
  enforceCompliance(input: TravelRuleInput): { compliant: boolean; ivms101Payload?: Record<string, any>; error?: string } {
    if (!this.applies(input.amount)) {
      return { compliant: true };
    }

    const ivms101Payload = buildIvms101Payload(input.sender, input.receiver, input.amount, input.currency);
    const validation = validateIvms101Payload(ivms101Payload);

    if (!validation.valid) {
      return {
        compliant: false,
        error: `Travel Rule compliance check failed: ${validation.errors.join("; ")}`,
      };
    }

    return { compliant: true, ivms101Payload };
  }

  /**
   * Persist a Travel Rule record. All PII is encrypted before storage.
   * Only a redacted summary is logged.
   */
  async capture(input: TravelRuleInput): Promise<TravelRuleRecord> {
    const encSender = encryptParty(input.sender);
    const encReceiver = encryptParty(input.receiver);

    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO travel_rule_records (
        transaction_id, amount, currency,
        sender_name, sender_account, sender_address, sender_dob, sender_id_number,
        receiver_name, receiver_account, receiver_address,
        originating_vasp, beneficiary_vasp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (transaction_id) DO NOTHING
      RETURNING id, created_at`,
      [
        input.transactionId,
        input.amount,
        input.currency ?? "USD",
        encSender.name,
        encSender.account,
        encSender.address ?? null,
        encSender.dob ?? null,
        encSender.idNumber ?? null,
        encReceiver.name,
        encReceiver.account,
        encReceiver.address ?? null,
        input.originatingVasp ?? null,
        input.beneficiaryVasp ?? null,
      ],
    );

    const row = result.rows[0];

    // Redacted log — no PII
    console.info("[travel-rule] captured", {
      id: row?.id,
      transactionId: input.transactionId,
      amount: input.amount,
      currency: input.currency ?? "USD",
      senderAccount: redactAccount(input.sender.account),
      receiverAccount: redactAccount(input.receiver.account),
    });

    return {
      id: row!.id,
      transactionId: input.transactionId,
      amount: input.amount,
      currency: input.currency ?? "USD",
      sender: input.sender,
      receiver: input.receiver,
      originatingVasp: input.originatingVasp,
      beneficiaryVasp: input.beneficiaryVasp,
      createdAt: row!.created_at,
    };
  }

  /** Fetch a single record by transaction ID (decrypted). */
  async findByTransactionId(
    transactionId: string,
  ): Promise<TravelRuleRecord | null> {
    const result = await pool.query(
      `SELECT * FROM travel_rule_records WHERE transaction_id = $1`,
      [transactionId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Export records for compliance officers.
   * Decrypts PII, marks records as exported, logs only metadata.
   */
  async exportForCompliance(options: {
    from?: Date;
    to?: Date;
    exportedBy: string;
    onlyUnexported?: boolean;
  }): Promise<TravelRuleRecord[]> {
    const to = options.to ?? new Date();
    const from =
      options.from ?? new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

    const whereClauses = ["created_at >= $1", "created_at <= $2"];
    const values: unknown[] = [from, to];

    if (options.onlyUnexported) {
      whereClauses.push("exported_at IS NULL");
    }

    const selectResult = await pool.query(
      `SELECT * FROM travel_rule_records
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY created_at ASC`,
      values,
    );

    const records = selectResult.rows.map(mapRow);

    if (records.length > 0) {
      const ids = records.map((r) => r.id);
      await pool.query(
        `UPDATE travel_rule_records
         SET exported_at = NOW(), exported_by = $1
         WHERE id = ANY($2::uuid[])`,
        [options.exportedBy, ids],
      );
    }

    // Log export event — no PII
    console.info("[travel-rule] compliance export", {
      exportedBy: options.exportedBy,
      count: records.length,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    return records;
  }
}

export const travelRuleService = new TravelRuleService();
