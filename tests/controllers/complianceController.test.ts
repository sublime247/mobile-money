import {
  ComplianceController,
  COMPLIANCE_THRESHOLD_USD,
  VerifyComplianceRequestSchema,
} from "../../src/controllers/complianceController";
import { Request, Response } from "express";

// Mock the database pool
jest.mock("../../src/config/database", () => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({}),
    release: jest.fn(),
  };
  return {
    pool: {
      query: jest.fn().mockResolvedValue({}),
      connect: jest.fn().mockResolvedValue(mockClient),
    },
  };
});

// Mock the notification router
jest.mock("../../src/services/notificationRouter", () => ({
  notificationRouter: {
    routeSystemNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

import { pool } from "../../src/config/database";
import { notificationRouter } from "../../src/services/notificationRouter";

const mockPoolQuery = pool.query as jest.Mock;
const mockPoolConnect = pool.connect as jest.Mock;
const mockRouteSystemNotification = notificationRouter.routeSystemNotification as jest.Mock;

describe("ComplianceController", () => {
  let controller: ComplianceController;

  beforeEach(() => {
    controller = new ComplianceController();
    jest.clearAllMocks();
  });

  describe("serializeToIVMS101()", () => {
    it("should serialize sender and receiver details correctly into the standard IVMS101 payload", () => {
      const sender = {
        name: "Alice Smith",
        account: "+1234567890",
        address: "123 Main St",
        dob: "1990-01-01",
        idNumber: "ID-12345",
      };
      const receiver = {
        name: "Bob Jones",
        account: "+0987654321",
        address: "456 Oak Ave",
      };

      const payload = controller.serializeToIVMS101(sender, receiver, "VASP-A", "VASP-B");

      expect(payload.originator.accountNumbers).toContain("+1234567890");
      expect(payload.beneficiary.accountNumbers).toContain("+0987654321");

      const origPerson = payload.originator.originatorPersons[0].naturalPerson;
      expect(origPerson?.name.nameIdentifier[0].primaryIdentifier).toBe("Alice Smith");
      expect(origPerson?.geographicAddress?.[0].streetName).toBe("123 Main St");
      expect(origPerson?.nationalIdentification?.nationalIdentifier).toBe("ID-12345");
      expect(origPerson?.dateAndPlaceOfBirth?.dateOfBirth).toBe("1990-01-01");

      const benefPerson = payload.beneficiary.beneficiaryPersons[0].naturalPerson;
      expect(benefPerson?.name.nameIdentifier[0].primaryIdentifier).toBe("Bob Jones");
      expect(benefPerson?.geographicAddress?.[0].streetName).toBe("456 Oak Ave");

      expect(payload.originatingVasp?.legalPerson.name.nameIdentifier[0].legalName).toBe("VASP-A");
      expect(payload.beneficiaryVasp?.legalPerson.name.nameIdentifier[0].legalName).toBe("VASP-B");
    });
  });

  describe("establishTLSConnection() in test mode", () => {
    it("should return success and a mock signature for general hosts", async () => {
      const payload = {} as any;
      const result = await controller.establishTLSConnection("localhost", 4001, payload);
      expect(result.status).toBe("success");
      expect(result.signature).toMatch(/^trisa_sig_[a-f0-9]{16}$/);
    });

    it("should return failed and error message when host represents a failing node", async () => {
      const payload = {} as any;
      const result = await controller.establishTLSConnection("failing-node.mock", 4001, payload);
      expect(result.status).toBe("failed");
      expect(result.error).toBe("TRISA compliance node rejected verification");
    });

    it("should return failed when localhost is called on port 9999", async () => {
      const payload = {} as any;
      const result = await controller.establishTLSConnection("localhost", 9999, payload);
      expect(result.status).toBe("failed");
      expect(result.error).toBe("TRISA compliance node rejected verification");
    });
  });

  describe("saveReceipt()", () => {
    it("should save verification exchange receipts to database", async () => {
      const mockQueryFn = jest.fn().mockResolvedValue({});
      mockPoolConnect.mockResolvedValueOnce({
        query: mockQueryFn,
        release: jest.fn(),
      });

      const payload = { originator: {}, beneficiary: {} } as any;
      await controller.saveReceipt(
        "txn_abc",
        "localhost:4001",
        payload,
        "success",
        "mock_sig_123"
      );

      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
        ["txn_abc", "localhost:4001", JSON.stringify(payload), "success", null, "mock_sig_123"]
      );
    });
  });

  describe("validateComplianceStatus() Express handler", () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let statusMock: jest.Mock;
    let jsonMock: jest.Mock;

    beforeEach(() => {
      statusMock = jest.fn().mockImplementation(() => mockRes);
      jsonMock = jest.fn().mockImplementation(() => mockRes);
      mockRes = {
        status: statusMock,
        json: jsonMock,
      };
      mockReq = {
        body: {
          transactionId: "txn_123",
          amount: 1500,
          sender: {
            name: "Alice Smith",
            account: "+1234567890",
            address: "123 Main St",
          },
          receiver: {
            name: "Bob Jones",
            account: "+0987654321",
          },
          originatingVasp: "VaspA",
          beneficiaryVasp: "VaspB",
        },
      };
    });

    it("should return compliant: true and bypass checking if transaction amount is below threshold", async () => {
      mockReq.body.amount = 500; // below $1,000 threshold

      await controller.validateComplianceStatus(mockReq as Request, mockRes as Response);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          compliant: true,
          message: expect.stringContaining("bypassed"),
        })
      );
      // DB shouldn't be queried
      expect(mockPoolConnect).not.toHaveBeenCalled();
    });

    it("should run compliance verification and return compliant: true for successful mock exchange above threshold", async () => {
      mockReq.body.beneficiaryHost = "localhost";
      mockReq.body.beneficiaryPort = 4001;

      await controller.validateComplianceStatus(mockReq as Request, mockRes as Response);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          compliant: true,
          message: "Compliance verification successful",
          signature: expect.any(String),
        })
      );

      // Verify db insertion of receipt
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
        expect.arrayContaining(["txn_123", "localhost:4001", "success"])
      );
    });

    it("should fail verification, log failed receipt, block transaction execution and alert admin on failure", async () => {
      mockReq.body.beneficiaryHost = "failing-node.mock";

      await controller.validateComplianceStatus(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          compliant: false,
          error: "Compliance verification failed",
          details: "TRISA compliance node rejected verification",
        })
      );

      // Verify db insertion of failed receipt
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO trisa_exchange_receipts"),
        expect.arrayContaining(["txn_123", "failing-node.mock:4001", "failed", "TRISA compliance node rejected verification"])
      );

      // Verify admin notification triggered
      expect(mockRouteSystemNotification).toHaveBeenCalledWith(
        "critical",
        "compliance",
        "Compliance Verification Failure",
        expect.stringContaining("TRISA compliance check failed for transaction txn_123"),
        expect.objectContaining({ transactionId: "txn_123" })
      );
    });

    it("should return status 400 validation error if body schema is invalid", async () => {
      mockReq.body = { invalid: "payload" };

      await controller.validateComplianceStatus(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Validation failed",
        })
      );
    });
  });
});
