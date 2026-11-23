import { NextFunction, Request, Response, Router } from "express";
import logger from "../../utils/logger";
import {
  InvalidProviderError,
  ProviderQueueControl,
  normalizeProviderKey,
} from "../../queue/providerQueueControl";

/**
 * Per-provider transaction queue pause/resume (#2282).
 *
 * Mounted by src/routes/admin.ts behind `requireAdmin`; kept as a factory so
 * the control and audit dependencies can be swapped in tests.
 */

export type QueueAuditAction = "QUEUE_PAUSED" | "QUEUE_RESUMED";

export interface QueueAuditEntry {
  adminId: string;
  action: QueueAuditAction;
  resource: "transaction_queue";
  resourceId: string;
  diff: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface QueueControlRouterDeps {
  control: ProviderQueueControl;
  audit: (entry: QueueAuditEntry) => Promise<unknown>;
}

function actorId(req: Request): string {
  const user = (req as Request & { user?: { id?: string } }).user;
  return user?.id ?? req.jwtUser?.userId ?? "unknown_admin";
}

function parseProvider(req: Request, res: Response): string | null {
  try {
    return normalizeProviderKey(req.params.provider);
  } catch (err) {
    if (err instanceof InvalidProviderError) {
      res.status(400).json({
        error: "Invalid provider",
        message:
          "Provider must be 1-32 characters of letters, digits, '_' or '-'.",
      });
      return null;
    }
    throw err;
  }
}

export function createQueueControlRouter({
  control,
  audit,
}: QueueControlRouterDeps): Router {
  const router = Router();

  // The queue state change has already happened by the time we audit, so an
  // audit-store failure is logged loudly rather than failing the request.
  const recordAudit = async (
    req: Request,
    action: QueueAuditAction,
    provider: string,
    diff: Record<string, unknown>,
  ) => {
    try {
      await audit({
        adminId: actorId(req),
        action,
        resource: "transaction_queue",
        resourceId: provider,
        diff: { ...diff, reason: req.body?.reason ?? null },
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
    } catch (err) {
      logger.error(
        { err, action, provider },
        "[QueueControl] Failed to write audit log entry",
      );
    }
  };

  router.get("/paused", async (_req, res, next: NextFunction) => {
    try {
      res.json({ paused: await control.listPaused() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:provider/status", async (req, res, next) => {
    try {
      const provider = parseProvider(req, res);
      if (!provider) return;
      res.json(await control.status(provider));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:provider/pause", async (req, res, next) => {
    try {
      const provider = parseProvider(req, res);
      if (!provider) return;

      const result = await control.pause(provider);
      if (result.changed) {
        await recordAudit(req, "QUEUE_PAUSED", provider, {
          before: { paused: false },
          after: { paused: true },
          held: result.held,
        });
      }

      res.json({
        success: true,
        message: result.changed
          ? `Queue for provider '${provider}' paused`
          : `Queue for provider '${provider}' was already paused`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:provider/resume", async (req, res, next) => {
    try {
      const provider = parseProvider(req, res);
      if (!provider) return;

      const result = await control.resume(provider);
      if (result.changed) {
        await recordAudit(req, "QUEUE_RESUMED", provider, {
          before: { paused: true },
          after: { paused: false },
          released: result.released,
        });
      }

      res.json({
        success: true,
        message: result.changed
          ? `Queue for provider '${provider}' resumed; ${result.released} held job(s) re-queued`
          : `Queue for provider '${provider}' was not paused`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
