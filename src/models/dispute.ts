import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeStatus = "open" | "investigating" | "resolved" | "rejected";
export type DisputePriority = "low" | "medium" | "high" | "critical";

export interface Dispute {
  id: string;
  transactionId: string;
  reason: string;
  status: DisputeStatus;
  assignedTo: string | null;
  resolution: string | null;
  reportedBy: string | null;
  priority: DisputePriority;
  category: string | null;
  slaDueDate: Date | null;
  slaWarningSent: boolean;
  internalNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DisputeNote {
  id: string;
  disputeId: string;
  author: string;
  note: string;
  createdAt: Date;
}

export interface DisputeEvidence {
  id: string;
  disputeId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  s3Key: string;
  s3Url: string;
  uploadedBy: string;
  description: string | null;
  createdAt: Date;
}

export interface DisputeTimelineEvent {
  id: string;
  disputeId: string;
  eventType: string;
  oldStatus: string | null;
  newStatus: string | null;
  actor: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface DisputeWithDetails extends Dispute {
  notes: DisputeNote[];
  evidence: DisputeEvidence[];
  timeline: DisputeTimelineEvent[];
}

export interface DisputeWithNotes extends Dispute {
  notes: DisputeNote[];
}

export interface DisputeReportRow {
  status: DisputeStatus;
  count: string;
  avgResolutionHours: string | null;
}

export interface CreateDisputeInput {
  transactionId: string;
  reason: string;
  reportedBy?: string;
  priority?: DisputePriority;
  category?: string;
}

export interface UpdateDisputeInput {
  status?: DisputeStatus;
  resolution?: string;
  assignedTo?: string;
  priority?: DisputePriority;
  category?: string;
  internalNotes?: string;
}

export interface ReportFilter {
  from?: Date;
  to?: Date;
  assignedTo?: string;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export class DisputeModel {
  /** Create a new dispute record. */
  async create(input: CreateDisputeInput): Promise<Dispute> {
    const result = await pool.query<Dispute>(
      `INSERT INTO disputes (transaction_id, reason, reported_by, priority, category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"`,
      [
        input.transactionId, 
        input.reason, 
        input.reportedBy ?? null,
        input.priority ?? 'medium',
        input.category ?? null
      ],
    );
    const row = result.rows[0];
    return {
      ...row,
      reason: decrypt(row.reason) || "",
      resolution: decrypt(row.resolution) ?? null,
    };
  }

  /** Find a dispute by its ID (without notes). */
  async findById(disputeId: string): Promise<Dispute | null> {
    const result = await pool.query<Dispute>(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"
       FROM disputes
       WHERE id = $1`,
      [disputeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      reason: decrypt(row.reason) || "",
      resolution: decrypt(row.resolution) ?? null,
    };
  }

  /** Find a dispute with all its notes. */
  async findByIdWithNotes(disputeId: string): Promise<DisputeWithNotes | null> {
    const disputeResult = await pool.query<Dispute>(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"
       FROM disputes
       WHERE id = $1`,
      [disputeId],
    );

    const disputeRow = disputeResult.rows[0];
    if (!disputeRow) return null;

    const notesResult = await pool.query<DisputeNote>(
      `SELECT
         id,
         dispute_id  AS "disputeId",
         author,
         note,
         created_at  AS "createdAt"
       FROM dispute_notes
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId],
    );

    const notes = notesResult.rows.map((n) => ({
      ...n,
      note: decrypt(n.note) || "",
    }));

    return {
      ...disputeRow,
      reason: decrypt(disputeRow.reason) || "",
      resolution: decrypt(disputeRow.resolution) ?? null,
      notes,
    };
  }

  /** Find a dispute with all details (notes, evidence, timeline). */
  async findByIdWithDetails(disputeId: string): Promise<DisputeWithDetails | null> {
    const dispute = await this.findByIdWithNotes(disputeId);
    if (!dispute) return null;

    // Get evidence
    const evidenceResult = await pool.query<DisputeEvidence>(
      `SELECT
         id,
         dispute_id    AS "disputeId",
         file_name     AS "fileName",
         file_type     AS "fileType",
         file_size     AS "fileSize",
         s3_key        AS "s3Key",
         s3_url        AS "s3Url",
         uploaded_by   AS "uploadedBy",
         description,
         created_at    AS "createdAt"
       FROM dispute_evidence
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId],
    );

    // Get timeline
    const timelineResult = await pool.query<DisputeTimelineEvent>(
      `SELECT
         id,
         dispute_id    AS "disputeId",
         event_type    AS "eventType",
         old_status    AS "oldStatus",
         new_status    AS "newStatus",
         actor,
         description,
         metadata,
         created_at    AS "createdAt"
       FROM dispute_timeline
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId],
    );

    return {
      ...dispute,
      evidence: evidenceResult.rows,
      timeline: timelineResult.rows,
    };
  }

  /** Find active (open/investigating) dispute for a transaction. */
  async findActiveByTransactionId(
    transactionId: string,
  ): Promise<Dispute | null> {
    const result = await pool.query<Dispute>(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"
       FROM disputes
       WHERE transaction_id = $1
         AND status IN ('open', 'investigating')
       LIMIT 1`,
      [transactionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      reason: decrypt(row.reason) || "",
      resolution: decrypt(row.resolution) ?? null,
    };
  }

  /** Update dispute fields. */
  async update(disputeId: string, input: UpdateDisputeInput): Promise<Dispute> {
    const setParts: string[] = [];
    const params: any[] = [disputeId];
    let paramIdx = 2;

    if (input.status !== undefined) {
      setParts.push(`status = $${paramIdx++}`);
      params.push(input.status);
    }
    if (input.resolution !== undefined) {
      setParts.push(`resolution = $${paramIdx++}`);
      params.push(input.resolution);
    }
    if (input.assignedTo !== undefined) {
      setParts.push(`assigned_to = $${paramIdx++}`);
      params.push(input.assignedTo);
    }
    if (input.priority !== undefined) {
      setParts.push(`priority = $${paramIdx++}`);
      params.push(input.priority);
    }
    if (input.category !== undefined) {
      setParts.push(`category = $${paramIdx++}`);
      params.push(input.category);
    }
    if (input.internalNotes !== undefined) {
      setParts.push(`internal_notes = $${paramIdx++}`);
      params.push(input.internalNotes);
    }

    if (setParts.length === 0) {
      throw new Error('No fields to update');
    }

    const result = await pool.query<Dispute>(
      `UPDATE disputes
       SET ${setParts.join(', ')}
       WHERE id = $1
       RETURNING
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"`,
      params,
    );
    const row = result.rows[0];
    return {
      ...row,
      reason: decrypt(row.reason) || "",
      resolution: decrypt(row.resolution) ?? null,
    };
  }

  /** Assign a dispute to a support agent. */
  async assign(disputeId: string, agentName: string): Promise<Dispute> {
    const result = await pool.query<Dispute>(
      `UPDATE disputes
       SET assigned_to = $2
       WHERE id = $1
       RETURNING
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"`,
      [disputeId, agentName],
    );
    const row = result.rows[0];
    return {
      ...row,
      reason: decrypt(row.reason) || "",
      resolution: decrypt(row.resolution) ?? null,
    };
  }

  /** Add evidence attachment to a dispute. */
  async addEvidence(
    disputeId: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    s3Key: string,
    s3Url: string,
    uploadedBy: string,
    description?: string,
  ): Promise<DisputeEvidence> {
    const result = await pool.query<DisputeEvidence>(
      `INSERT INTO dispute_evidence (dispute_id, file_name, file_type, file_size, s3_key, s3_url, uploaded_by, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id,
         dispute_id    AS "disputeId",
         file_name     AS "fileName",
         file_type     AS "fileType",
         file_size     AS "fileSize",
         s3_key        AS "s3Key",
         s3_url        AS "s3Url",
         uploaded_by   AS "uploadedBy",
         description,
         created_at    AS "createdAt"`,
      [disputeId, fileName, fileType, fileSize, s3Key, s3Url, uploadedBy, description ?? null],
    );
    return result.rows[0];
  }

  /** Get all evidence for a dispute. */
  async getEvidence(disputeId: string): Promise<DisputeEvidence[]> {
    const result = await pool.query<DisputeEvidence>(
      `SELECT
         id,
         dispute_id    AS "disputeId",
         file_name     AS "fileName",
         file_type     AS "fileType",
         file_size     AS "fileSize",
         s3_key        AS "s3Key",
         s3_url        AS "s3Url",
         uploaded_by   AS "uploadedBy",
         description,
         created_at    AS "createdAt"
       FROM dispute_evidence
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId],
    );
    return result.rows;
  }

  /** Find disputes approaching SLA deadline. */
  async findSlaWarningCandidates(): Promise<Dispute[]> {
    const result = await pool.query<Dispute>(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"
       FROM disputes
       WHERE status IN ('open', 'investigating')
         AND sla_due_date IS NOT NULL
         AND sla_due_date <= NOW() + INTERVAL '2 hours'
         AND sla_warning_sent = FALSE`,
    );
    return result.rows;
  }

  /** Mark SLA warning as sent. */
  async markSlaWarningSent(disputeId: string): Promise<void> {
    await pool.query(
      `UPDATE disputes SET sla_warning_sent = TRUE WHERE id = $1`,
      [disputeId],
    );
  }

  /** Find overdue disputes. */
  async findOverdueDisputes(): Promise<Dispute[]> {
    const result = await pool.query<Dispute>(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         reason,
         status,
         assigned_to     AS "assignedTo",
         resolution,
         reported_by     AS "reportedBy",
         priority,
         category,
         sla_due_date    AS "slaDueDate",
         sla_warning_sent AS "slaWarningSent",
         internal_notes  AS "internalNotes",
         created_at      AS "createdAt",
         updated_at      AS "updatedAt"
       FROM disputes
       WHERE status IN ('open', 'investigating')
         AND sla_due_date IS NOT NULL
         AND sla_due_date < NOW()`,
    );
    return result.rows;
  }

  /** Add a note/comment to a dispute. */
  async addNote(
    disputeId: string,
    author: string,
    note: string,
  ): Promise<DisputeNote> {
    const result = await pool.query<DisputeNote>(
      `INSERT INTO dispute_notes (dispute_id, author, note)
       VALUES ($1, $2, $3)
       RETURNING
         id,
         dispute_id  AS "disputeId",
         author,
         note,
         created_at  AS "createdAt"`,
      [disputeId, author, encrypt(note)],
    );
    const row = result.rows[0];
    return {
      ...row,
      note: decrypt(row.note) as string,
    };
  }

  /** Aggregate report: counts and average resolution time, grouped by status. */
  async generateReport(filter: ReportFilter = {}): Promise<DisputeReportRow[]> {
    const conditions: string[] = [];
    const params: (Date | string)[] = [];
    let paramIdx = 1;

    if (filter.from) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(filter.to);
    }
    if (filter.assignedTo) {
      conditions.push(`assigned_to = $${paramIdx++}`);
      params.push(filter.assignedTo);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query<DisputeReportRow>(
      `SELECT
         status,
         COUNT(*)::text                                              AS count,
         ROUND(
           AVG(
             CASE WHEN status IN ('resolved','rejected')
               THEN EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600
             END
           )::NUMERIC, 2
         )::text                                                     AS "avgResolutionHours"
       FROM disputes
       ${where}
       GROUP BY status
       ORDER BY status`,
      params,
    );

    return result.rows;
  }
}