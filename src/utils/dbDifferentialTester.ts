import { v4 as uuidv4 } from "uuid";
import { pool, queryRead, queryWrite } from "../config/database";

export type KycLevel = "unverified" | "basic" | "full";
export type VaultStatus = "active" | "inactive" | "locked";
export type TransactionType = "deposit" | "withdraw";
export type TransactionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "review"
  | "dispute"
  | "reversed"
  | "clawed_back";
export type AmlSeverity = "medium" | "high";
export type AmlAlertStatus = "pending_review" | "reviewed" | "dismissed";

export interface UserRecord {
  id: string;
  phone_number: string;
  kyc_level: KycLevel;
  mcc?: string | null;
  profile_url?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VaultRecord {
  id: string;
  name: string;
  description?: string | null;
  owner_id: string;
  balance: number;
  status: VaultStatus;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRecord {
  id: string;
  user_id: string;
  reference_number: string;
  type: TransactionType;
  amount: number;
  phone_number: string;
  provider: string;
  stellar_address: string;
  status: TransactionStatus;
  tags?: string[];
  metadata?: Record<string, any>;
  vault_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AmlAlertRecord {
  id: string;
  transaction_id: string;
  user_id: string;
  severity: AmlSeverity;
  status: AmlAlertStatus;
  rule_hits: any[];
  reasons: string[];
  reviewed_at?: Date | null;
  reviewed_by?: string | null;
  review_notes?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AmlReviewHistoryRecord {
  id: string;
  alert_id: string;
  user_id: string;
  previous_status: AmlAlertStatus;
  new_status: AmlAlertStatus;
  reviewed_by: string;
  review_notes?: string | null;
  created_at: Date;
}

export interface DifferentialResult<T> {
  opName: string;
  mockResult: T | null;
  realResult: T | null;
  mockError: string | null;
  realError: string | null;
  isEqual: boolean;
  mismatchDetails?: string;
}

/**
 * In-Memory Mock Database State Store
 * Simulates schema constraints, default values, triggers, transactions, and lookups.
 */
export class MockDatabaseStore {
  public users: Map<string, UserRecord> = new Map();
  public vaults: Map<string, VaultRecord> = new Map();
  public transactions: Map<string, TransactionRecord> = new Map();
  public amlAlerts: Map<string, AmlAlertRecord> = new Map();
  public amlReviewHistory: AmlReviewHistoryRecord[] = [];

  private snapshotStack: Array<{
    users: Map<string, UserRecord>;
    vaults: Map<string, VaultRecord>;
    transactions: Map<string, TransactionRecord>;
    amlAlerts: Map<string, AmlAlertRecord>;
    amlReviewHistory: AmlReviewHistoryRecord[];
  }> = [];

  public clear(): void {
    this.users.clear();
    this.vaults.clear();
    this.transactions.clear();
    this.amlAlerts.clear();
    this.amlReviewHistory = [];
    this.snapshotStack = [];
  }

  public beginTransaction(): void {
    const cloneUserMap = new Map<string, UserRecord>();
    this.users.forEach((v, k) => cloneUserMap.set(k, { ...v }));

    const cloneVaultMap = new Map<string, VaultRecord>();
    this.vaults.forEach((v, k) => cloneVaultMap.set(k, { ...v }));

    const cloneTxMap = new Map<string, TransactionRecord>();
    this.transactions.forEach((v, k) =>
      cloneTxMap.set(k, {
        ...v,
        tags: v.tags ? [...v.tags] : undefined,
        metadata: v.metadata ? { ...v.metadata } : undefined,
      }),
    );

    const cloneAmlMap = new Map<string, AmlAlertRecord>();
    this.amlAlerts.forEach((v, k) =>
      cloneAmlMap.set(k, {
        ...v,
        rule_hits: [...v.rule_hits],
        reasons: [...v.reasons],
      }),
    );

    this.snapshotStack.push({
      users: cloneUserMap,
      vaults: cloneVaultMap,
      transactions: cloneTxMap,
      amlAlerts: cloneAmlMap,
      amlReviewHistory: this.amlReviewHistory.map((h) => ({ ...h })),
    });
  }

  public commitTransaction(): void {
    if (this.snapshotStack.length === 0) {
      throw new Error("No active transaction to commit");
    }
    this.snapshotStack.pop();
  }

  public rollbackTransaction(): void {
    const previousState = this.snapshotStack.pop();
    if (!previousState) {
      throw new Error("No active transaction to rollback");
    }
    this.users = previousState.users;
    this.vaults = previousState.vaults;
    this.transactions = previousState.transactions;
    this.amlAlerts = previousState.amlAlerts;
    this.amlReviewHistory = previousState.amlReviewHistory;
  }

  // --- Users ---
  public createUser(input: {
    id?: string;
    phone_number: string;
    kyc_level: KycLevel;
    mcc?: string | null;
    profile_url?: string | null;
  }): UserRecord {
    // Unique check on phone_number
    for (const u of this.users.values()) {
      if (u.phone_number === input.phone_number) {
        throw new Error(`Unique constraint violation: phone_number ${input.phone_number} already exists`);
      }
    }
    if (!["unverified", "basic", "full"].includes(input.kyc_level)) {
      throw new Error(`Invalid enum check for kyc_level: ${input.kyc_level}`);
    }

    const id = input.id || uuidv4();
    const now = new Date();
    const user: UserRecord = {
      id,
      phone_number: input.phone_number,
      kyc_level: input.kyc_level,
      mcc: input.mcc || null,
      profile_url: input.profile_url || null,
      created_at: now,
      updated_at: now,
    };
    this.users.set(id, user);
    return { ...user };
  }

  public getUserById(id: string): UserRecord | null {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  public getUserByPhone(phone: string): UserRecord | null {
    for (const u of this.users.values()) {
      if (u.phone_number === phone) {
        return { ...u };
      }
    }
    return null;
  }

  public updateUserKyc(id: string, newLevel: KycLevel): UserRecord {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User not found: ${id}`);
    }
    if (!["unverified", "basic", "full"].includes(newLevel)) {
      throw new Error(`Invalid enum check for kyc_level: ${newLevel}`);
    }
    user.kyc_level = newLevel;
    user.updated_at = new Date();
    this.users.set(id, user);
    return { ...user };
  }

  // --- Vaults ---
  public createVault(input: {
    id?: string;
    name: string;
    description?: string | null;
    owner_id: string;
    balance?: number;
    status?: VaultStatus;
  }): VaultRecord {
    if (!this.users.has(input.owner_id)) {
      throw new Error(`Foreign key constraint failure: owner_id ${input.owner_id} does not exist`);
    }
    const status = input.status || "active";
    if (!["active", "inactive", "locked"].includes(status)) {
      throw new Error(`Invalid enum check for vault status: ${status}`);
    }

    const id = input.id || uuidv4();
    const now = new Date();
    const vault: VaultRecord = {
      id,
      name: input.name,
      description: input.description || null,
      owner_id: input.owner_id,
      balance: input.balance ?? 0,
      status,
      created_at: now,
      updated_at: now,
    };
    this.vaults.set(id, vault);
    return { ...vault };
  }

  public getVaultById(id: string): VaultRecord | null {
    const v = this.vaults.get(id);
    return v ? { ...v } : null;
  }

  public updateVaultBalance(id: string, deltaAmount: number): VaultRecord {
    const vault = this.vaults.get(id);
    if (!vault) {
      throw new Error(`Vault not found: ${id}`);
    }
    if (vault.status === "locked") {
      throw new Error(`Vault operation failed: vault ${id} is locked`);
    }
    const newBalance = vault.balance + deltaAmount;
    if (newBalance < 0) {
      throw new Error(`Insufficient funds in vault: current balance ${vault.balance}, attempted ${deltaAmount}`);
    }
    vault.balance = newBalance;
    vault.updated_at = new Date();
    this.vaults.set(id, vault);
    return { ...vault };
  }

  public updateVaultStatus(id: string, newStatus: VaultStatus): VaultRecord {
    const vault = this.vaults.get(id);
    if (!vault) {
      throw new Error(`Vault not found: ${id}`);
    }
    if (!["active", "inactive", "locked"].includes(newStatus)) {
      throw new Error(`Invalid enum check for vault status: ${newStatus}`);
    }
    vault.status = newStatus;
    vault.updated_at = new Date();
    this.vaults.set(id, vault);
    return { ...vault };
  }

  // --- Transactions ---
  public createTransaction(input: {
    id?: string;
    user_id: string;
    reference_number: string;
    type: TransactionType;
    amount: number;
    phone_number: string;
    provider: string;
    stellar_address: string;
    status?: TransactionStatus;
    tags?: string[];
    metadata?: Record<string, any>;
    vault_id?: string | null;
  }): TransactionRecord {
    if (!this.users.has(input.user_id)) {
      throw new Error(`Foreign key constraint failure: user_id ${input.user_id} does not exist`);
    }
    if (input.vault_id && !this.vaults.has(input.vault_id)) {
      throw new Error(`Foreign key constraint failure: vault_id ${input.vault_id} does not exist`);
    }
    // Unique check reference_number + user_id
    for (const tx of this.transactions.values()) {
      if (tx.reference_number === input.reference_number && tx.user_id === input.user_id) {
        throw new Error(
          `Unique constraint violation: reference_number ${input.reference_number} already exists for user ${input.user_id}`,
        );
      }
    }
    if (!["deposit", "withdraw"].includes(input.type)) {
      throw new Error(`Invalid transaction type enum: ${input.type}`);
    }
    const status = input.status || "pending";
    const validStatuses: TransactionStatus[] = [
      "pending",
      "completed",
      "failed",
      "cancelled",
      "review",
      "dispute",
      "reversed",
      "clawed_back",
    ];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid transaction status enum: ${status}`);
    }

    const id = input.id || uuidv4();
    const now = new Date();
    const transaction: TransactionRecord = {
      id,
      user_id: input.user_id,
      reference_number: input.reference_number,
      type: input.type,
      amount: input.amount,
      phone_number: input.phone_number,
      provider: input.provider,
      stellar_address: input.stellar_address,
      status,
      tags: input.tags || [],
      metadata: input.metadata || {},
      vault_id: input.vault_id || null,
      created_at: now,
      updated_at: now,
    };
    this.transactions.set(id, transaction);
    return { ...transaction };
  }

  public getTransactionById(id: string): TransactionRecord | null {
    const tx = this.transactions.get(id);
    return tx ? { ...tx } : null;
  }

  public getTransactionByRef(ref: string): TransactionRecord | null {
    for (const tx of this.transactions.values()) {
      if (tx.reference_number === ref) {
        return { ...tx };
      }
    }
    return null;
  }

  public updateTransactionStatus(id: string, newStatus: TransactionStatus): TransactionRecord {
    const tx = this.transactions.get(id);
    if (!tx) {
      throw new Error(`Transaction not found: ${id}`);
    }
    tx.status = newStatus;
    tx.updated_at = new Date();
    this.transactions.set(id, tx);
    return { ...tx };
  }

  // --- AML Alerts ---
  public createAmlAlert(input: {
    id?: string;
    transaction_id: string;
    user_id: string;
    severity: AmlSeverity;
    status?: AmlAlertStatus;
    rule_hits?: any[];
    reasons?: string[];
  }): AmlAlertRecord {
    if (!this.users.has(input.user_id)) {
      throw new Error(`Foreign key constraint failure: user_id ${input.user_id} does not exist`);
    }
    if (!this.transactions.has(input.transaction_id)) {
      throw new Error(`Foreign key constraint failure: transaction_id ${input.transaction_id} does not exist`);
    }
    if (!["medium", "high"].includes(input.severity)) {
      throw new Error(`Invalid AML severity enum: ${input.severity}`);
    }

    const status = input.status || "pending_review";
    const id = input.id || uuidv4();
    const now = new Date();
    const alert: AmlAlertRecord = {
      id,
      transaction_id: input.transaction_id,
      user_id: input.user_id,
      severity: input.severity,
      status,
      rule_hits: input.rule_hits || [],
      reasons: input.reasons || [],
      reviewed_at: null,
      reviewed_by: null,
      review_notes: null,
      created_at: now,
      updated_at: now,
    };
    this.amlAlerts.set(id, alert);
    return { ...alert };
  }

  public getAmlAlertById(id: string): AmlAlertRecord | null {
    const alert = this.amlAlerts.get(id);
    return alert ? { ...alert } : null;
  }

  public reviewAmlAlert(input: {
    alert_id: string;
    reviewed_by: string;
    new_status: AmlAlertStatus;
    review_notes?: string;
  }): { alert: AmlAlertRecord; history: AmlReviewHistoryRecord } {
    const alert = this.amlAlerts.get(input.alert_id);
    if (!alert) {
      throw new Error(`AML Alert not found: ${input.alert_id}`);
    }
    if (!this.users.has(input.reviewed_by)) {
      throw new Error(`Foreign key constraint failure: reviewed_by user ${input.reviewed_by} does not exist`);
    }

    const previousStatus = alert.status;
    const now = new Date();
    alert.status = input.new_status;
    alert.reviewed_at = now;
    alert.reviewed_by = input.reviewed_by;
    alert.review_notes = input.review_notes || null;
    alert.updated_at = now;
    this.amlAlerts.set(input.alert_id, alert);

    const history: AmlReviewHistoryRecord = {
      id: uuidv4(),
      alert_id: input.alert_id,
      user_id: alert.user_id,
      previous_status: previousStatus,
      new_status: input.new_status,
      reviewed_by: input.reviewed_by,
      review_notes: input.review_notes || null,
      created_at: now,
    };
    this.amlReviewHistory.push(history);

    return { alert: { ...alert }, history: { ...history } };
  }
}

/**
 * Real SQL Execution State Evaluator / Adapter
 * Standardizes parameterized SQL queries against Postgres connection pool.
 */
export class RealDatabaseState {
  public async createUser(input: {
    id?: string;
    phone_number: string;
    kyc_level: KycLevel;
    mcc?: string | null;
    profile_url?: string | null;
  }): Promise<UserRecord> {
    const id = input.id || uuidv4();
    const text = `
      INSERT INTO users (id, phone_number, kyc_level, mcc, profile_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, phone_number, kyc_level, mcc, profile_url, created_at, updated_at;
    `;
    const params = [
      id,
      input.phone_number,
      input.kyc_level,
      input.mcc || null,
      input.profile_url || null,
    ];
    const res = await queryWrite<UserRecord>(text, params);
    return res.rows[0];
  }

  public async getUserById(id: string): Promise<UserRecord | null> {
    const text = `
      SELECT id, phone_number, kyc_level, mcc, profile_url, created_at, updated_at
      FROM users WHERE id = $1;
    `;
    const res = await queryRead<UserRecord>(text, [id]);
    return res.rows[0] || null;
  }

  public async getUserByPhone(phone: string): Promise<UserRecord | null> {
    const text = `
      SELECT id, phone_number, kyc_level, mcc, profile_url, created_at, updated_at
      FROM users WHERE phone_number = $1;
    `;
    const res = await queryRead<UserRecord>(text, [phone]);
    return res.rows[0] || null;
  }

  public async updateUserKyc(id: string, newLevel: KycLevel): Promise<UserRecord> {
    const text = `
      UPDATE users SET kyc_level = $2
      WHERE id = $1
      RETURNING id, phone_number, kyc_level, mcc, profile_url, created_at, updated_at;
    `;
    const res = await queryWrite<UserRecord>(text, [id, newLevel]);
    if (!res.rows[0]) {
      throw new Error(`User not found: ${id}`);
    }
    return res.rows[0];
  }

  public async createVault(input: {
    id?: string;
    name: string;
    description?: string | null;
    owner_id: string;
    balance?: number;
    status?: VaultStatus;
  }): Promise<VaultRecord> {
    const id = input.id || uuidv4();
    const text = `
      INSERT INTO vaults (id, name, description, owner_id, balance, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, description, owner_id, balance::float, status, created_at, updated_at;
    `;
    const params = [
      id,
      input.name,
      input.description || null,
      input.owner_id,
      input.balance ?? 0,
      input.status || "active",
    ];
    const res = await queryWrite<VaultRecord>(text, params);
    return res.rows[0];
  }

  public async getVaultById(id: string): Promise<VaultRecord | null> {
    const text = `
      SELECT id, name, description, owner_id, balance::float, status, created_at, updated_at
      FROM vaults WHERE id = $1;
    `;
    const res = await queryRead<VaultRecord>(text, [id]);
    return res.rows[0] || null;
  }

  public async updateVaultBalance(id: string, deltaAmount: number): Promise<VaultRecord> {
    const text = `
      UPDATE vaults
      SET balance = balance + $2
      WHERE id = $1 AND status != 'locked'
      RETURNING id, name, description, owner_id, balance::float, status, created_at, updated_at;
    `;
    const res = await queryWrite<VaultRecord>(text, [id, deltaAmount]);
    if (!res.rows[0]) {
      throw new Error(`Vault update failed or vault locked: ${id}`);
    }
    return res.rows[0];
  }

  public async updateVaultStatus(id: string, newStatus: VaultStatus): Promise<VaultRecord> {
    const text = `
      UPDATE vaults SET status = $2
      WHERE id = $1
      RETURNING id, name, description, owner_id, balance::float, status, created_at, updated_at;
    `;
    const res = await queryWrite<VaultRecord>(text, [id, newStatus]);
    if (!res.rows[0]) {
      throw new Error(`Vault not found: ${id}`);
    }
    return res.rows[0];
  }

  public async createTransaction(input: {
    id?: string;
    user_id: string;
    reference_number: string;
    type: TransactionType;
    amount: number;
    phone_number: string;
    provider: string;
    stellar_address: string;
    status?: TransactionStatus;
    tags?: string[];
    metadata?: Record<string, any>;
    vault_id?: string | null;
  }): Promise<TransactionRecord> {
    const id = input.id || uuidv4();
    const text = `
      INSERT INTO transactions (
        id, user_id, reference_number, type, amount, phone_number,
        provider, stellar_address, status, tags, metadata, vault_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, user_id, reference_number, type, amount::float, phone_number,
                provider, stellar_address, status, tags, metadata, vault_id, created_at, updated_at;
    `;
    const params = [
      id,
      input.user_id,
      input.reference_number,
      input.type,
      input.amount,
      input.phone_number,
      input.provider,
      input.stellar_address,
      input.status || "pending",
      input.tags || [],
      JSON.stringify(input.metadata || {}),
      input.vault_id || null,
    ];
    const res = await queryWrite<TransactionRecord>(text, params);
    return res.rows[0];
  }

  public async getTransactionById(id: string): Promise<TransactionRecord | null> {
    const text = `
      SELECT id, user_id, reference_number, type, amount::float, phone_number,
             provider, stellar_address, status, tags, metadata, vault_id, created_at, updated_at
      FROM transactions WHERE id = $1;
    `;
    const res = await queryRead<TransactionRecord>(text, [id]);
    return res.rows[0] || null;
  }

  public async getTransactionByRef(ref: string): Promise<TransactionRecord | null> {
    const text = `
      SELECT id, user_id, reference_number, type, amount::float, phone_number,
             provider, stellar_address, status, tags, metadata, vault_id, created_at, updated_at
      FROM transactions WHERE reference_number = $1;
    `;
    const res = await queryRead<TransactionRecord>(text, [ref]);
    return res.rows[0] || null;
  }

  public async updateTransactionStatus(id: string, newStatus: TransactionStatus): Promise<TransactionRecord> {
    const text = `
      UPDATE transactions SET status = $2
      WHERE id = $1
      RETURNING id, user_id, reference_number, type, amount::float, phone_number,
                provider, stellar_address, status, tags, metadata, vault_id, created_at, updated_at;
    `;
    const res = await queryWrite<TransactionRecord>(text, [id, newStatus]);
    if (!res.rows[0]) {
      throw new Error(`Transaction not found: ${id}`);
    }
    return res.rows[0];
  }

  public async createAmlAlert(input: {
    id?: string;
    transaction_id: string;
    user_id: string;
    severity: AmlSeverity;
    status?: AmlAlertStatus;
    rule_hits?: any[];
    reasons?: string[];
  }): Promise<AmlAlertRecord> {
    const id = input.id || uuidv4();
    const text = `
      INSERT INTO aml_alerts (id, transaction_id, user_id, severity, status, rule_hits, reasons)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, transaction_id, user_id, severity, status, rule_hits, reasons, reviewed_at, reviewed_by, review_notes, created_at, updated_at;
    `;
    const params = [
      id,
      input.transaction_id,
      input.user_id,
      input.severity,
      input.status || "pending_review",
      JSON.stringify(input.rule_hits || []),
      input.reasons || [],
    ];
    const res = await queryWrite<AmlAlertRecord>(text, params);
    return res.rows[0];
  }

  public async getAmlAlertById(id: string): Promise<AmlAlertRecord | null> {
    const text = `
      SELECT id, transaction_id, user_id, severity, status, rule_hits, reasons, reviewed_at, reviewed_by, review_notes, created_at, updated_at
      FROM aml_alerts WHERE id = $1;
    `;
    const res = await queryRead<AmlAlertRecord>(text, [id]);
    return res.rows[0] || null;
  }

  public async reviewAmlAlert(input: {
    alert_id: string;
    reviewed_by: string;
    new_status: AmlAlertStatus;
    review_notes?: string;
  }): Promise<{ alert: AmlAlertRecord; history: AmlReviewHistoryRecord }> {
    const alertRes = await queryWrite<AmlAlertRecord>(
      `UPDATE aml_alerts
       SET status = $2, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $3, review_notes = $4
       WHERE id = $1
       RETURNING id, transaction_id, user_id, severity, status, rule_hits, reasons, reviewed_at, reviewed_by, review_notes, created_at, updated_at;`,
      [input.alert_id, input.new_status, input.reviewed_by, input.review_notes || null],
    );

    if (!alertRes.rows[0]) {
      throw new Error(`AML Alert not found: ${input.alert_id}`);
    }
    const updatedAlert = alertRes.rows[0];

    const historyId = uuidv4();
    const historyRes = await queryWrite<AmlReviewHistoryRecord>(
      `INSERT INTO aml_alert_review_history (id, alert_id, user_id, previous_status, new_status, reviewed_by, review_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, alert_id, user_id, previous_status, new_status, reviewed_by, review_notes, created_at;`,
      [
        historyId,
        input.alert_id,
        updatedAlert.user_id,
        "pending_review",
        input.new_status,
        input.reviewed_by,
        input.review_notes || null,
      ],
    );

    return { alert: updatedAlert, history: historyRes.rows[0] };
  }
}

/**
 * Differential Database Tester Harness
 * Runs identical operations on mock state and real database state, comparing outputs and errors.
 */
export class DbDifferentialTester {
  public static async compare<T>(
    opName: string,
    opMock: () => Promise<T>,
    opReal: () => Promise<T>,
    options: { compareKeys?: string[]; ignoreTimestamps?: boolean; ignoreIds?: boolean } = { ignoreTimestamps: true },
  ): Promise<DifferentialResult<T>> {
    let mockResult: T | null = null;
    let realResult: T | null = null;
    let mockError: string | null = null;
    let realError: string | null = null;

    try {
      mockResult = await opMock();
    } catch (err: any) {
      mockError = err?.message || String(err);
    }

    try {
      realResult = await opReal();
    } catch (err: any) {
      realError = err?.message || String(err);
    }

    let isEqual = false;
    let mismatchDetails: string | undefined;

    if (mockError || realError) {
      // Both should have failed
      if (mockError && realError) {
        isEqual = true; // Both errored out as expected
      } else {
        isEqual = false;
        mismatchDetails = `Divergence in error handling: mockError="${mockError}", realError="${realError}"`;
      }
    } else {
      // Compare objects
      const normalizedMock = this.normalize(mockResult, options);
      const normalizedReal = this.normalize(realResult, options);

      const strMock = JSON.stringify(normalizedMock);
      const strReal = JSON.stringify(normalizedReal);

      isEqual = strMock === strReal;
      if (!isEqual) {
        mismatchDetails = `State disparity detected:\nMock: ${strMock}\nReal: ${strReal}`;
      }
    }

    return {
      opName,
      mockResult,
      realResult,
      mockError,
      realError,
      isEqual,
      mismatchDetails,
    };
  }

  private static normalize(
    obj: any,
    options: { compareKeys?: string[]; ignoreTimestamps?: boolean; ignoreIds?: boolean },
  ): any {
    if (!obj || typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.normalize(item, options));
    }

    const copy: Record<string, any> = {};
    for (const key of Object.keys(obj).sort()) {
      if (options.ignoreTimestamps && (key === "created_at" || key === "updated_at" || key === "reviewed_at")) {
        continue;
      }
      if (options.ignoreIds && key === "id") {
        continue;
      }
      if (options.compareKeys && options.compareKeys.length > 0 && !options.compareKeys.includes(key)) {
        continue;
      }

      let val = obj[key];
      if (val instanceof Date) {
        val = val.toISOString();
      } else if (typeof val === "number") {
        val = Number(val.toFixed(7));
      } else if (typeof val === "object" && val !== null) {
        val = this.normalize(val, options);
      }
      copy[key] = val;
    }
    return copy;
  }
}

export { createInMemoryDbMock } from "./mockDb";


