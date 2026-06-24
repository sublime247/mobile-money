import { Request, Response } from "express";
import {
  ExchangeRateBufferService,
  exchangeRateBufferService,
} from "../services/exchangeRateBufferService";
import { currencyService } from "../services/currency";
import logger from "../utils/logger";
import { z } from "zod";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const CreateBufferSchema = z.object({
  provider: z.string().min(1),
  currencyPair: z
    .string()
    .regex(/^[A-Z]{3}_[A-Z]{3}$/, "Must be FORMAT: USD_XAF"),
  bufferPercent: z.number().min(0).max(50),
  minBufferPct: z.number().min(0).max(50).optional(),
  maxBufferPct: z.number().min(0).max(50).optional(),
  volatilityMode: z.enum(["static", "dynamic"]).optional(),
});

const UpdateBufferSchema = z.object({
  bufferPercent: z.number().min(0).max(50).optional(),
  minBufferPct: z.number().min(0).max(50).optional(),
  maxBufferPct: z.number().min(0).max(50).optional(),
  volatilityMode: z.enum(["static", "dynamic"]).optional(),
  isActive: z.boolean().optional(),
});

export class ExchangeRateBufferController {
  private service = exchangeRateBufferService;

  /**
   * GET /api/exchange-rate-buffers
   * List all buffer configs
   */
  listBuffers = async (_req: Request, res: Response) => {
    try {
      const buffers = await this.service.getAllBuffers();
      res.json({ success: true, data: buffers });
    } catch (err) {
      logger.error(err, "Failed to list buffers");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch exchange rate buffers",
      );
    }
  };
  /**
   * GET /api/exchange-rate-buffers/:id
   */
  getBuffer = async (req: Request, res: Response) => {
    try {
      const buffer = await this.service.getBufferById(req.params.id);
      if (!buffer) {
        throw createError(ERROR_CODES.NOT_FOUND, "Buffer not found", {
          error: "Buffer not found",
        });
      }
      res.json({ success: true, data: buffer });
    } catch (err) {
      logger.error(err, "Failed to get buffer");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch buffer");
    }
  };

  /**
   * GET /api/exchange-rate-buffers/provider/:provider
   */
  getByProvider = async (req: Request, res: Response) => {
    try {
      const buffers = await this.service.getBuffersByProvider(
        req.params.provider,
      );
      res.json({ success: true, data: buffers });
    } catch (err) {
      logger.error(err, "Failed to get buffers by provider");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch buffers");
    }
  };

  /**
   * POST /api/exchange-rate-buffers
   */
  createBuffer = async (req: Request, res: Response) => {
    try {
      const data = CreateBufferSchema.parse(req.body);
      const userId = req.jwtUser?.userId ?? "system";

      const buffer = await this.service.createBuffer(data, userId);
      res.status(201).json({ success: true, data: buffer });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: err.issues,
        });
      }
      logger.error(err, "Failed to create buffer");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to create buffer");
    }
  };

  /**
   * PATCH /api/exchange-rate-buffers/:id
   */
  updateBuffer = async (req: Request, res: Response) => {
    try {
      const data = UpdateBufferSchema.parse(req.body);
      const userId = req.jwtUser?.userId ?? "system";

      const buffer = await this.service.updateBuffer(
        req.params.id,
        data,
        userId,
        req.ip,
        req.headers["user-agent"],
      );

      if (!buffer) {
        throw createError(ERROR_CODES.NOT_FOUND, "Buffer not found", {
          error: "Buffer not found",
        });
      }
      res.json({ success: true, data: buffer });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: err.issues,
        });
      }
      logger.error(err, "Failed to update buffer");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to update buffer");
    }
  };

  /**
   * DELETE /api/exchange-rate-buffers/:id
   */
  deleteBuffer = async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId ?? "system";
      const deleted = await this.service.deleteBuffer(
        req.params.id,
        userId,
        req.ip,
      );

      if (!deleted) {
        throw createError(ERROR_CODES.NOT_FOUND, "Buffer not found", {
          error: "Buffer not found",
        });
      }
      res.json({ success: true, message: "Buffer deleted" });
    } catch (err) {
      logger.error(err, "Failed to delete buffer");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to delete buffer");
    }
  };
  /**
   * POST /api/exchange-rate-buffers/preview
   * Preview the buffered rate for a given conversion without actually transacting.
   */
  previewRate = async (req: Request, res: Response) => {
    try {
      const { from, to, amount, provider, direction } = req.body;

      if (!from || !to || !amount || !provider) {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "Required fields: from, to, amount, provider",
          {
            error: "Required fields: from, to, amount, provider",
          },
        );
      }

      const result = await currencyService.convertWithBuffer(
        parseFloat(amount),
        from,
        to,
        provider,
        direction ?? "sell",
      );

      res.json({
        success: true,
        data: {
          originalAmount: result.originalAmount,
          convertedAmount: result.convertedAmount,
          rawRate: result.buffer.rawRate,
          bufferedRate: result.rate,
          bufferPercent: result.buffer.bufferApplied,
          mode: result.buffer.mode,
          providerUsed: result.buffer.providerUsed,
        },
      });
    } catch (err) {
      logger.error(err, "Failed to preview buffered rate");
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to compute buffered rate",
      );
    }
  };
}
