/**
 * Advanced Dispute Routes
 *
 * Enhanced endpoints with evidence attachments, internal notes, and SLA management:
 *
 *   POST   /api/transactions/:id/dispute
 *     Open a dispute for a transaction.
 *     Body: { reason: string, reportedBy?: string, priority?: string, category?: string }
 *
 *   GET    /api/disputes/:disputeId
 *     Fetch dispute details including all notes.
 *
 *   GET    /api/disputes/:disputeId/details
 *     Fetch dispute with full details (notes, evidence, timeline).
 *
 *   PATCH  /api/disputes/:disputeId/status
 *     Transition dispute status.
 *     Body: { status: 'open'|'investigating'|'resolved'|'rejected', resolution?: string, assignedTo?: string }
 *
 *   PATCH  /api/disputes/:disputeId
 *     Update dispute fields.
 *     Body: { priority?: string, category?: string, internalNotes?: string }
 *
 *   POST   /api/disputes/:disputeId/assign
 *     Assign dispute to a support agent (auto-advances open → investigating).
 *     Body: { agentName: string }
 *
 *   POST   /api/disputes/:disputeId/notes
 *     Add a note/comment to a dispute.
 *     Body: { author: string, note: string }
 *
 *   POST   /api/disputes/:disputeId/evidence
 *     Upload evidence attachment.
 *     Form data: file (multipart), description (optional)
 *
 *   POST   /api/disputes/:disputeId/evidence/multiple
 *     Upload multiple evidence attachments.
 *     Form data: files[] (multipart), descriptions[] (optional)
 *
 *   GET    /api/disputes/:disputeId/evidence
 *     Get all evidence for a dispute.
 *
 *   GET    /api/disputes/report
 *     Aggregate dispute report.
 *     Query: from?, to?, assignedTo?
 *
 *   GET    /api/disputes/sla/report
 *     SLA compliance report.
 *     Query: days? (default: 30)
 *
 *   GET    /api/disputes/overdue
 *     Get overdue disputes.
 *
 *   POST   /api/disputes/sla/process
 *     Manually trigger SLA warning processing.
 */

import { Router, Request, Response } from "express";
import { DisputeService } from "../services/dispute";
import { DisputeStatus, DisputePriority } from "../models/dispute";
import { DisputeStateMachine } from "../services/disputeStateMachine";
import { uploadSingle, uploadMultiple } from "../middleware/disputeUpload";
import { uploadDisputeEvidenceToS3, uploadMultipleDisputeEvidenceToS3, validateDisputeEvidenceFile } from "../services/disputeS3Upload";
import { generateDisputeSlaReport, runDisputeSlaJob } from "../jobs/disputeSlaJob";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const VALID_STATUSES: DisputeStatus[] = [
  "open",
  "investigating",
  "resolved",
  "rejected",
];

const VALID_PRIORITIES: DisputePriority[] = [
  "low",
  "medium",
  "high",
  "critical",
];

const disputeService = new DisputeService();
const stateMachine = new DisputeStateMachine();

// ---------------------------------------------------------------------------
// Transaction-scoped router  (mounted at /api/transactions)
// ---------------------------------------------------------------------------

export const transactionDisputeRoutes = Router({ mergeParams: true });

/**
 * POST /api/transactions/:id/dispute
 *
 * Opens a dispute for a transaction and automatically creates a support ticket
 * (Zendesk/Intercom) with full transaction context.
 *
 * Body: {
 *   reason: string,
 *   reportedBy?: string,
 *   priority?: string,
 *   category?: string,
 *   requesterEmail?: string  // Email for support ticket requester
 * }
 *
 * Response includes:
 *   - supportTicketId: Instant ticket ID from support provider
 *   - supportTicketUrl: Direct link to the support ticket
 */
transactionDisputeRoutes.post(
  "/:id/dispute",
  requireAuth,
  requirePermission("dispute:create"),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason, reportedBy, priority, category, requesterEmail } = req.body;

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return res.status(400).json({
        error: 'Field "reason" is required and must be a non-empty string',
      });
    }

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`,
      });
    }

    // Validate requesterEmail if provided
    if (requesterEmail && typeof requesterEmail === "string") {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(requesterEmail)) {
        return res.status(400).json({
          error: 'Invalid "requesterEmail" format',
        });
      }
    }

    try {
      const dispute = await disputeService.openDispute(
        id,
        reason.trim(),
        reportedBy,
        priority,
        category,
      );
      return res.status(201).json(dispute);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open dispute";
      const status = message.includes("not found")
        ? 404
        : message.includes("already exists")
          ? 409
          : message.includes("only allowed for completed")
            ? 422
            : 500;
      return res.status(status).json({ error: message });
    }
  },
);

// ---------------------------------------------------------------------------
// Dispute management router  (mounted at /api/disputes)
// ---------------------------------------------------------------------------

export const disputeRoutes = Router();

/**
 * GET /api/disputes/report
 * Must be defined before /:disputeId so "report" is not treated as an ID.
 */
disputeRoutes.get(
  "/report",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    const { from, to, assignedTo } = req.query;

    const filter: { from?: Date; to?: Date; assignedTo?: string } = {};

    if (from) {
      const d = new Date(from as string);
      if (isNaN(d.getTime()))
        return res.status(400).json({ error: 'Invalid "from" date' });
      filter.from = d;
    }
    if (to) {
      const d = new Date(to as string);
      if (isNaN(d.getTime()))
        return res.status(400).json({ error: 'Invalid "to" date' });
      filter.to = d;
    }
    if (assignedTo) filter.assignedTo = assignedTo as string;

    try {
      const report = await disputeService.generateReport(filter);
      return res.json(report);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate report";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * GET /api/disputes/sla/report
 */
disputeRoutes.get(
  "/sla/report",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;

    if (isNaN(days) || days < 1 || days > 365) {
      return res.status(400).json({
        error: "Invalid days parameter. Must be between 1 and 365"
      });
    }

    try {
      const report = await generateDisputeSlaReport(days);
      return res.json(report);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate SLA report";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * GET /api/disputes/overdue
 */
disputeRoutes.get(
  "/overdue",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const overdue = await disputeService.getOverdueDisputes();
      return res.json(overdue);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to get overdue disputes";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/disputes/sla/process
 */
disputeRoutes.post(
  "/sla/process",
  requireAuth,
  requirePermission("dispute:manage"),
  async (req: Request, res: Response) => {
    try {
      const result = await runDisputeSlaJob();
      return res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process SLA warnings";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * GET /api/disputes/:disputeId
 */
disputeRoutes.get(
  "/:disputeId",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const dispute = await disputeService.getDispute(req.params.disputeId);
      return res.json(dispute);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch dispute";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * GET /api/disputes/:disputeId/details
 */
disputeRoutes.get(
  "/:disputeId/details",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const dispute = await disputeService.getDisputeWithDetails(req.params.disputeId);
      return res.json(dispute);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch dispute details";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * PATCH /api/disputes/:disputeId/status
 */
disputeRoutes.patch(
  "/:disputeId/status",
  requireAuth,
  requirePermission("dispute:update"),
  async (req: Request, res: Response) => {
    const { status, resolution, assignedTo } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Field "status" must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    try {
      // Get current dispute to validate transition
      const currentDispute = await disputeService.getDispute(req.params.disputeId);

      // Validate state transition
      const validation = stateMachine.validateTransition(
        currentDispute.status,
        status,
        { resolution, assignedTo }
      );

      if (!validation.valid) {
        return res.status(422).json({
          error: "Invalid state transition",
          details: validation.errors,
        });
      }

      const updated = await disputeService.updateStatus(
        req.params.disputeId,
        status as DisputeStatus,
        resolution,
        assignedTo,
      );
      return res.json(updated);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update dispute status";
      const code = message.includes("not found")
        ? 404
        : message.includes("Cannot transition") ||
        message.includes("resolution text")
          ? 422
          : 500;
      return res.status(code).json({ error: message });
    }
  },
);

/**
 * PATCH /api/disputes/:disputeId
 */
disputeRoutes.patch(
  "/:disputeId",
  requireAuth,
  requirePermission("dispute:update"),
  async (req: Request, res: Response) => {
    const { priority, category, internalNotes } = req.body;

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`,
      });
    }

    try {
      const updated = await disputeService.updateDispute(req.params.disputeId, {
        priority,
        category,
        internalNotes,
      });
      return res.json(updated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update dispute";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * POST /api/disputes/:disputeId/assign
 */
disputeRoutes.post(
  "/:disputeId/assign",
  requireAuth,
  requirePermission("dispute:assign"),
  async (req: Request, res: Response) => {
    const { agentName } = req.body;

    if (
      !agentName ||
      typeof agentName !== "string" ||
      agentName.trim().length === 0
    ) {
      return res.status(400).json({ error: 'Field "agentName" is required' });
    }

    try {
      const updated = await disputeService.assignToAgent(
        req.params.disputeId,
        agentName.trim(),
      );
      return res.json(updated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to assign dispute";
      const code = message.includes("not found")
        ? 404
        : message.includes("Cannot assign")
          ? 422
          : 500;
      return res.status(code).json({ error: message });
    }
  },
);

/**
 * POST /api/disputes/:disputeId/notes
 */
disputeRoutes.post(
  "/:disputeId/notes",
  requireAuth,
  requirePermission("dispute:update"),
  async (req: Request, res: Response) => {
    const { author, note } = req.body;

    if (!author || typeof author !== "string" || author.trim().length === 0) {
      return res.status(400).json({ error: 'Field "author" is required' });
    }
    if (!note || typeof note !== "string" || note.trim().length === 0) {
      return res.status(400).json({ error: 'Field "note" is required' });
    }

    try {
      const created = await disputeService.addNote(
        req.params.disputeId,
        author.trim(),
        note.trim(),
      );
      return res.status(201).json(created);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add note";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * POST /api/disputes/:disputeId/evidence
 */
disputeRoutes.post(
  "/:disputeId/evidence",
  requireAuth,
  requirePermission("dispute:update"),
  uploadSingle.single('file'),
  async (req: Request, res: Response) => {
    const { disputeId } = req.params;
    const { description } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Validate file
    const validation = validateDisputeEvidenceFile(file);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    try {
      // Upload to S3
      const uploadResult = await uploadDisputeEvidenceToS3({
        disputeId,
        file,
        uploadedBy: req.user?.id || 'unknown',
      });

      if (!uploadResult.success) {
        return res.status(500).json({ error: uploadResult.error });
      }

      // Save evidence record
      const evidence = await disputeService.addEvidence(
        disputeId,
        file.originalname,
        file.mimetype,
        file.size,
        uploadResult.key!,
        uploadResult.fileUrl!,
        req.user?.id || 'unknown',
        description,
      );

      return res.status(201).json(evidence);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to upload evidence";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * POST /api/disputes/:disputeId/evidence/multiple
 */
disputeRoutes.post(
  "/:disputeId/evidence/multiple",
  requireAuth,
  requirePermission("dispute:update"),
  uploadMultiple.array('files', 5),
  async (req: Request, res: Response) => {
    const { disputeId } = req.params;
    const { descriptions } = req.body;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // Validate all files
    for (const file of files) {
      const validation = validateDisputeEvidenceFile(file);
      if (!validation.valid) {
        return res.status(400).json({
          error: `File "${file.originalname}": ${validation.error}`
        });
      }
    }

    try {
      // Upload all files to S3
      const uploadResults = await uploadMultipleDisputeEvidenceToS3(
        disputeId,
        files,
        req.user?.id || 'unknown'
      );

      // Check for upload failures
      const failedUploads = uploadResults.filter(r => !r.success);
      if (failedUploads.length > 0) {
        return res.status(500).json({
          error: "Some files failed to upload",
          failures: failedUploads,
        });
      }

      // Save evidence records
      const evidenceRecords = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadResult = uploadResults[i];
        const description = Array.isArray(descriptions) ? descriptions[i] : descriptions;

        const evidence = await disputeService.addEvidence(
          disputeId,
          file.originalname,
          file.mimetype,
          file.size,
          uploadResult.key!,
          uploadResult.fileUrl!,
          req.user?.id || 'unknown',
          description,
        );
        evidenceRecords.push(evidence);
      }

      return res.status(201).json(evidenceRecords);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to upload evidence";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);

/**
 * GET /api/disputes/:disputeId/evidence
 */
disputeRoutes.get(
  "/:disputeId/evidence",
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const evidence = await disputeService.getEvidence(req.params.disputeId);
      return res.json(evidence);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to get evidence";
      return res
        .status(message.includes("not found") ? 404 : 500)
        .json({ error: message });
    }
  }
);
