import logger from "../utils/logger";
/**
 * Travel Rule compliance export routes.
 * All endpoints require admin authentication (X-API-Key or admin-role bearer token).
 */

import { Router, Request, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { travelRuleService, TravelRuleRecord } from "../compliance/travelRule";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { travelRuleCheckHandler } from "../controllers/complianceController";
import {
  buildIVMS101FromRecord,
  buildIVMS101Payload,
} from "../compliance/ivms101.js";
import {
  serializeIVMS101Payload,
  validateIVMS101Payload,
} from "../compliance/ivms101Validator.js";

export const travelRuleRoutes = Router();

function parseOptionalDate(value: unknown): Date | undefined {
  if (!value || typeof value !== "string") return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function requireAdmin(req: Request, res: Response): boolean {
  const user = (req as AuthRequest).user;
  if (!user || user.role !== "admin") {
    createError(ERROR_CODES.FORBIDDEN, "Admin access required", {
      error: "Forbidden",
    });
    return false;
  }
  return true;
}

/** Serialize a record for JSON/CSV — PII included (compliance use only) */
function serializeRecord(r: TravelRuleRecord) {
  return {
    id: r.id,
    transactionId: r.transactionId,
    amount: r.amount,
    currency: r.currency,
    sender: {
      name: r.sender.name,
      account: r.sender.account,
      address: r.sender.address ?? null,
      dob: r.sender.dob ?? null,
      idNumber: r.sender.idNumber ?? null,
    },
    receiver: {
      name: r.receiver.name,
      account: r.receiver.account,
      address: r.receiver.address ?? null,
    },
    originatingVasp: r.originatingVasp ?? null,
    beneficiaryVasp: r.beneficiaryVasp ?? null,
    createdAt: r.createdAt.toISOString(),
    exportedAt: r.exportedAt?.toISOString() ?? null,
    exportedBy: r.exportedBy ?? null,
  };
}

function setStructuredAddress(
  person: { geographicAddress?: unknown },
  addressInput: unknown,
): void {
  if (
    !addressInput ||
    typeof addressInput !== "object" ||
    Array.isArray(addressInput)
  ) {
    return;
  }

  const address = addressInput as Record<string, unknown>;
  const structuredAddress: Record<string, unknown> = {
    addressType: address.addressType || "GEOG",
    country: address.country,
  };
  const addressFields: Array<[string, string]> = [
    ["street", "streetName"],
    ["streetName", "streetName"],
    ["buildingNumber", "buildingNumber"],
    ["buildingName", "buildingName"],
    ["department", "department"],
    ["subDepartment", "subDepartment"],
    ["floor", "floor"],
    ["postBox", "postBox"],
    ["room", "room"],
    ["townName", "townName"],
    ["city", "townName"],
    ["postCode", "postCode"],
    ["townLocationName", "townLocationName"],
    ["districtName", "districtName"],
    ["countrySubDivision", "countrySubDivision"],
  ];

  for (const [source, target] of addressFields) {
    if (address[source] !== undefined)
      structuredAddress[target] = address[source];
  }

  Object.assign(person, { geographicAddress: [structuredAddress] });
}

/**
 * POST /api/v1/compliance/travel-rule/check
 * Checks whether a transaction amount triggers the Travel Rule and, if so,
 * captures the required identity data. Requires authentication.
 */
travelRuleRoutes.post("/check", requireAuth, travelRuleCheckHandler);

/**
 * GET /api/v1/compliance/travel-rule
 * Query params: from, to, onlyUnexported
 * Returns JSON array of Travel Rule records (decrypted).
 */
travelRuleRoutes.get("/", requireAuth, async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    const onlyUnexported = req.query.onlyUnexported === "true";
    const exportedBy = (req as AuthRequest).user!.id;

    const records = await travelRuleService.exportForCompliance({
      from,
      to,
      exportedBy,
      onlyUnexported,
    });

    res.json({ count: records.length, records: records.map(serializeRecord) });
  } catch (err) {
    logger.error(
      "[travel-rule] export error:",
      err instanceof Error ? err.message : err,
    );
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Export failed", {
      error: "Export failed",
    });
  }
});

/**
 * GET /api/v1/compliance/travel-rule/export.csv
 * Same filters as above but streams a CSV file.
 */
travelRuleRoutes.get(
  "/export.csv",
  requireAuth,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    try {
      const from = parseOptionalDate(req.query.from);
      const to = parseOptionalDate(req.query.to);
      const onlyUnexported = req.query.onlyUnexported === "true";
      const exportedBy = (req as AuthRequest).user!.id;

      const records = await travelRuleService.exportForCompliance({
        from,
        to,
        exportedBy,
        onlyUnexported,
      });

      const filename = `travel-rule-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      const headers = [
        "ID",
        "Transaction ID",
        "Amount",
        "Currency",
        "Sender Name",
        "Sender Account",
        "Sender Address",
        "Sender DOB",
        "Sender ID Number",
        "Receiver Name",
        "Receiver Account",
        "Receiver Address",
        "Originating VASP",
        "Beneficiary VASP",
        "Created At",
        "Exported At",
        "Exported By",
      ];

      const escape = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const s = String(v).replace(/"/g, '""');
        return /[",\r\n]/.test(s) ? `"${s}"` : s;
      };

      res.write(`${headers.map(escape).join(",")}\n`);

      for (const r of records) {
        const row = [
          r.id,
          r.transactionId,
          r.amount,
          r.currency,
          r.sender.name,
          r.sender.account,
          r.sender.address ?? "",
          r.sender.dob ?? "",
          r.sender.idNumber ?? "",
          r.receiver.name,
          r.receiver.account,
          r.receiver.address ?? "",
          r.originatingVasp ?? "",
          r.beneficiaryVasp ?? "",
          r.createdAt.toISOString(),
          r.exportedAt?.toISOString() ?? "",
          r.exportedBy ?? "",
        ];
        res.write(`${row.map(escape).join(",")}\n`);
      }

      res.end();
    } catch (err) {
      logger.error(
        "[travel-rule] csv export error:",
        err instanceof Error ? err.message : err,
      );
      if (!res.headersSent) {
        throw createError(ERROR_CODES.INTERNAL_ERROR, "CSV export failed", {
          error: "CSV export failed",
        });
      }
    }
  },
);

/**
 * GET /api/v1/compliance/travel-rule/:transactionId
 * Fetch a single Travel Rule record by transaction ID.
 */
travelRuleRoutes.post(
  "/ivms101",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { isTravelRuleRequired } = await import("../compliance/ivms101");

      const {
        originatorName,
        originatorAccount,
        originatorAddress,
        originatorDob,
        originatorIdNumber,
        beneficiaryName,
        beneficiaryAccount,
        beneficiaryAddress,
        originatingVaspName,
        beneficiaryVaspName,
        amount,
      } = req.body ?? {};

      if (!originatorName || !originatorAccount || !beneficiaryName || !beneficiaryAccount) {
        return res.status(400).json({ error: "Missing required originator or beneficiary details" });
      }

      const required = isTravelRuleRequired(Number(amount) || 0);
      const payload = buildIVMS101Payload(
        {
          name: originatorName,
          account: originatorAccount,
          address:
            typeof originatorAddress === "string"
              ? originatorAddress
              : undefined,
          dob: originatorDob,
          idNumber: originatorIdNumber,
        },
        {
          name: beneficiaryName,
          account: beneficiaryAccount,
          address:
            typeof beneficiaryAddress === "string"
              ? beneficiaryAddress
              : undefined,
        },
        {
          originatingVasp: originatingVaspName,
          beneficiaryVasp: beneficiaryVaspName,
          strict: false,
        },
      );

      setStructuredAddress(
        payload.originator.originatorPersons[0].naturalPerson,
        originatorAddress,
      );
      setStructuredAddress(
        payload.beneficiary.beneficiaryPersons[0].naturalPerson,
        beneficiaryAddress,
      );

      const validation = validateIVMS101Payload(payload);
      if (!validation.valid) {
        return res.status(422).json({
          error: "IVMS 101 validation failed",
          details: validation.errors,
        });
      }

      return res.status(200).json({
        travelRuleRequired: required,
        ivms101: JSON.parse(serializeIVMS101Payload(payload)),
      });
    } catch {
      logger.error("[travel-rule] IVMS 101 request could not be processed");
      return res
        .status(400)
        .json({ error: "Failed to generate IVMS 101 payload" });
    }
  },
);

/**
 * GET /api/v1/compliance/travel-rule/:transactionId
 * Fetch a single Travel Rule record by transaction ID.
 */
travelRuleRoutes.get(
  "/:transactionId",
  requireAuth,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    try {
      const record = await travelRuleService.findByTransactionId(
        req.params.transactionId,
      );
      if (!record) {
        return res
          .status(404)
          .json({ error: "No Travel Rule record for this transaction" });
      }
      res.json(serializeRecord(record));
    } catch (err) {
      logger.error(
        "[travel-rule] lookup error:",
        err instanceof Error ? err.message : err,
      );
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Lookup failed", {
        error: "Lookup failed",
      });
    }
  },
);

/**
 * GET /api/v1/compliance/travel-rule/:transactionId/ivms101
 *
 * Returns the IVMS 101 JSON payload for the Travel Rule record associated
 * with a transaction.  Useful for interVASP message exchange.
 */
travelRuleRoutes.get(
  "/:transactionId/ivms101",
  requireAuth,
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    try {
      const record = await travelRuleService.findByTransactionId(
        req.params.transactionId,
      );

      if (!record) {
        return res
          .status(404)
          .json({ error: "No Travel Rule record for this transaction" });
      }

      const payload = buildIVMS101FromRecord(record, { strict: false });
      const validation = validateIVMS101Payload(payload);
      if (!validation.valid) {
        return res.status(422).json({
          error: "IVMS 101 validation failed",
          details: validation.errors,
        });
      }

      res.type("application/json").send(serializeIVMS101Payload(payload));
    } catch {
      logger.error("[travel-rule] IVMS 101 export could not be processed");
      throw createError(ERROR_CODES.INTERNAL_ERROR, "IVMS 101 generation failed", {
        error: "IVMS 101 generation failed",
      });
    }
  },
);
