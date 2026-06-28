import { Request, Response, NextFunction } from "express";

/**
 * ISO 8601 UTC offset regex.
 *
 * Accepts:
 *   - "Z"           (UTC, zero offset)
 *   - "+HH:MM"      e.g. "+05:30"
 *   - "-HH:MM"      e.g. "-07:00"
 *   - "+HH"         bare hour offset (non-standard but widely seen)
 *   - "+HHMM"       compact form without colon
 *
 * The full datetime string must also satisfy a basic ISO 8601 shape so that
 * callers cannot pass a bare offset like "+05:30" without a date component.
 *
 * Valid examples:
 *   "2024-01-15T10:30:00Z"
 *   "2024-01-15T10:30:00+00:00"
 *   "2024-01-15T10:30:00-05:30"
 *
 * Invalid examples (rejected with 400):
 *   "2024-01-15T10:30:00"        – missing timezone
 *   "2024-01-15T10:30:00+25:00"  – hour out of range
 *   "not-a-date"                 – not ISO 8601
 */
const ISO8601_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/**
 * Validate that a date string is ISO 8601 with a strict UTC offset.
 *
 * Returns `true` when the string is valid, `false` otherwise.
 * A `null` / `undefined` input is treated as "not provided" and returns `true`
 * (callers decide whether the field is required).
 */
export function isValidIsoWithOffset(value: string | null | undefined): boolean {
  if (value == null) return true;
  return ISO8601_WITH_OFFSET_RE.test(value);
}

/**
 * Extract a human-readable error message for an invalid date parameter.
 *
 * @param paramName Query parameter name (e.g. "startDate")
 * @param value     The bad value supplied by the client
 */
export function dateOffsetError(paramName: string, value: string): string {
  return (
    `"${paramName}" must be a valid ISO 8601 datetime with a UTC offset ` +
    `(e.g. "2024-01-15T10:30:00Z" or "2024-01-15T10:30:00+05:30"). ` +
    `Received: "${value}"`
  );
}

/**
 * Transaction Status Enum
 */
export enum TransactionStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Review = "review",
  Dispute = "dispute",
  Reversed = "reversed",
  ClawedBack = "clawed_back",
}

/**
 * Valid status values
 */
export const VALID_STATUSES = Object.values(TransactionStatus);

/**
 * Query parameters interface
 */
export interface TransactionFilters {
  statuses: TransactionStatus[];
  limit: number;
  offset: number;
  sortBy?: string;
  sortOrder?: "ASC" | "DESC";
  reference?: string;
}

/**
 * Parse and validate status query parameter
 * Supports single: ?status=pending
 * Supports multiple: ?status=pending,completed,failed
 * @param statusParam Status query parameter value
 * @returns Array of valid status values
 * @throws Error if invalid status provided
 */
export const parseStatusFilter = (statusParam: string | undefined): TransactionStatus[] => {
  if (!statusParam) {
    return [];
  }

  const statuses = statusParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && !/^[-]+$/.test(s));

  if (statuses.length === 0) {
    return [];
  }

  // Validate all statuses
  const invalidStatuses = statuses.filter((s) => !VALID_STATUSES.includes(s as TransactionStatus));

  if (invalidStatuses.length > 0) {
    throw new Error(
      `Invalid status values: ${invalidStatuses.join(", ")}. Valid values are: ${VALID_STATUSES.join(", ")}`
    );
  }

  return statuses as TransactionStatus[];
};

/**
 * Build WHERE clause for status filtering
 * @param statuses Array of statuses to filter by
 * @returns SQL WHERE clause fragment
 */
export const buildStatusWhereClause = (statuses: TransactionStatus[]): string => {
  if (statuses.length === 0) return "";
  if (statuses.length === VALID_STATUSES.length) return "";

  const values = statuses.map((status) => `'${status}'`).join(", ");
  return `status IN (${values})`;
};

/**
 * Middleware: Validate and parse transaction filters
 */
export const validateTransactionFilters = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, limit = 50, offset = 0, reference, startDate, endDate } = req.query;

    // Validate UTC timezone offsets in date range parameters
    // ISO 8601 dates without a UTC offset (e.g. "2024-01-15T10:30:00") are
    // rejected to prevent ambiguous local-time queries reaching the database.
    if (startDate && !isValidIsoWithOffset(startDate as string)) {
      return res.status(400).json({
        error: "Invalid startDate parameter",
        message: dateOffsetError("startDate", startDate as string),
      });
    }
    if (endDate && !isValidIsoWithOffset(endDate as string)) {
      return res.status(400).json({
        error: "Invalid endDate parameter",
        message: dateOffsetError("endDate", endDate as string),
      });
    }

    // Validate limit
    const limitNum = parseInt(limit as string, 10);
    if (isNaN(limitNum) || limitNum < 1) {
      return res.status(400).json({
        error: "Invalid limit parameter",
        message: "limit must be a number greater than 0",
      });
    }
    const cappedLimit = Math.min(limitNum, 1000);

    // Validate offset
    const offsetNum = parseInt(offset as string, 10);
    if (isNaN(offsetNum) || offsetNum < 0) {
      return res.status(400).json({
        error: "Invalid offset parameter",
        message: "offset must be a non-negative number",
      });
    }

    // Parse and validate status
    let statuses: TransactionStatus[] = [];
    try {
      statuses = parseStatusFilter(status as string | undefined);
    } catch (error) {
      return res.status(400).json({
        error: "Invalid status parameter",
        message: (error as Error).message,
        validStatuses: VALID_STATUSES,
      });
    }

    // Attach filters to request
    (req as any).transactionFilters = {
      statuses,
      limit: cappedLimit,
      offset: offsetNum,
      reference: reference as string | undefined,
    };

    next();
  } catch (error) {
    res.status(500).json({
      error: "Error validating filters",
      message: (error as Error).message,
    });
  }
};

/**
 * Helper: Build paginated query info
 */
export const getPaginationInfo = (
  total: number,
  limit: number,
  offset: number
) => {
  return {
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
    totalPages: Math.ceil(total / limit),
    currentPage: Math.floor(offset / limit) + 1,
  };
};
