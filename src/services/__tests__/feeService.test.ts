import { FeeService, feeService } from "../feeService";
import { pool } from "../../config/database";
import { layeredCache } from "../layeredCache";

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock("../layeredCache", () => ({
  layeredCache: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    delPattern: jest.fn(),
  },
}));

describe("FeeService Unit Tests", () => {
  let service: FeeService;

  const mockConfig = {
    id: "cfg_1",
    name: "Standard Tier",
    description: "Standard transfer fees",
    feePercentage: 2.5,
    feeMinimum: 1.0,
    feeMaximum: 50.0,
    isActive: true,
    createdBy: "admin_1",
    updatedBy: "admin_1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeeService();
  });

  describe("calculateFee", () => {
    it("should calculate standard percentage fee when within min and max", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      const result = await service.calculateFee(100);

      expect(result).toEqual({
        fee: 2.5,
        total: 102.5,
        configUsed: "Standard Tier",
      });
    });

    it("should apply feeMinimum when calculated fee is lower than min", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      // 10 * 2.5% = 0.25 < feeMinimum (1.0)
      const result = await service.calculateFee(10);

      expect(result).toEqual({
        fee: 1.0,
        total: 11.0,
        configUsed: "Standard Tier",
      });
    });

    it("should apply feeMaximum when calculated fee is higher than max", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      // 10000 * 2.5% = 250 > feeMaximum (50.0)
      const result = await service.calculateFee(10000);

      expect(result).toEqual({
        fee: 50.0,
        total: 10050.0,
        configUsed: "Standard Tier",
      });
    });
  });

  describe("getActiveConfiguration", () => {
    it("should return cached configuration if available", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      const config = await service.getActiveConfiguration();

      expect(config).toEqual(mockConfig);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("should query database and set cache if cache miss", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [mockConfig] });

      const config = await service.getActiveConfiguration();

      expect(config).toEqual(mockConfig);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("WHERE is_active = true"));
      expect(layeredCache.set).toHaveBeenCalledWith("fee_config:active", mockConfig, 3600);
    });

    it("should throw error if no active configuration exists in DB", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(service.getActiveConfiguration()).rejects.toThrow(
        "No active fee configuration found"
      );
    });
  });

  describe("getAllConfigurations", () => {
    it("should fetch all configurations ordered by created_at DESC", async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [mockConfig] });

      const res = await service.getAllConfigurations();

      expect(res).toEqual([mockConfig]);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY created_at DESC"));
    });
  });

  describe("getConfigurationById", () => {
    it("should return cached item if present", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      const res = await service.getConfigurationById("cfg_1");

      expect(res).toEqual(mockConfig);
      expect(layeredCache.get).toHaveBeenCalledWith("fee_config:cfg_1");
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("should fetch from database and cache if not in cache", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [mockConfig] });

      const res = await service.getConfigurationById("cfg_1");

      expect(res).toEqual(mockConfig);
      expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["cfg_1"]);
      expect(layeredCache.set).toHaveBeenCalledWith("fee_config:cfg_1", mockConfig, 3600);
    });

    it("should return null if configuration not found in DB", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const res = await service.getConfigurationById("non_existent");

      expect(res).toBeNull();
    });
  });

  describe("createConfiguration", () => {
    it("should insert configuration and log audit entry", async () => {
      const createReq = {
        name: "Premium Tier",
        description: "Premium fees",
        feePercentage: 1.5,
        feeMinimum: 0.5,
        feeMaximum: 25.0,
      };
      const createdConfig = { ...mockConfig, ...createReq, id: "cfg_2" };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [createdConfig] }) // INSERT query
        .mockResolvedValueOnce({}); // Audit log INSERT query

      const result = await service.createConfiguration(createReq, "admin_1");

      expect(result).toEqual(createdConfig);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_configurations"),
        ["Premium Tier", "Premium fees", 1.5, 0.5, 25.0, "admin_1"]
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_configuration_audit"),
        expect.arrayContaining(["cfg_2", "CREATE", null, JSON.stringify(createdConfig), "admin_1"])
      );
    });
  });

  describe("updateConfiguration", () => {
    it("should return null if target configuration does not exist", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const res = await service.updateConfiguration("cfg_non_existent", {}, "admin_1");

      expect(res).toBeNull();
    });

    it("should return old configuration if no update fields provided", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);

      const res = await service.updateConfiguration("cfg_1", {}, "admin_1");

      expect(res).toEqual(mockConfig);
    });

    it("should update configuration fields, invalidate cache, and write audit log", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);
      const updatedConfig = { ...mockConfig, feePercentage: 3.0, description: "Updated desc" };
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [updatedConfig] }) // UPDATE query
        .mockResolvedValueOnce({}); // Audit log INSERT query

      const res = await service.updateConfiguration(
        "cfg_1",
        {
          description: "Updated desc",
          feePercentage: 3.0,
          feeMinimum: 2.0,
          feeMaximum: 100.0,
          isActive: false,
        },
        "admin_2",
        "127.0.0.1",
        "jest-agent"
      );

      expect(res).toEqual(updatedConfig);
      expect(layeredCache.del).toHaveBeenCalledWith("fee_config:cfg_1");
      expect(layeredCache.del).toHaveBeenCalledWith("fee_config:active");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE fee_configurations"),
        expect.arrayContaining(["Updated desc", 3.0, 2.0, 100.0, false, "admin_2", "cfg_1"])
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_configuration_audit"),
        expect.arrayContaining(["cfg_1", "UPDATE", expect.any(String), expect.any(String), "admin_2", "127.0.0.1", "jest-agent"])
      );
    });

    it("should update individual fields and calculate correct parameter indices", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig);
      (pool.query as jest.Mock)
        .mockResolvedValue({ rows: [mockConfig] });

      await service.updateConfiguration("cfg_1", { description: "new desc" }, "admin_1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET description = $1, updated_by = $2"),
        ["new desc", "admin_1", "cfg_1"]
      );

      await service.updateConfiguration("cfg_1", { feePercentage: 5.0 }, "admin_1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET fee_percentage = $1, updated_by = $2"),
        [5.0, "admin_1", "cfg_1"]
      );

      await service.updateConfiguration("cfg_1", { feeMinimum: 2.0 }, "admin_1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET fee_minimum = $1, updated_by = $2"),
        [2.0, "admin_1", "cfg_1"]
      );

      await service.updateConfiguration("cfg_1", { feeMaximum: 100.0 }, "admin_1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET fee_maximum = $1, updated_by = $2"),
        [100.0, "admin_1", "cfg_1"]
      );

      await service.updateConfiguration("cfg_1", { isActive: true }, "admin_1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET is_active = $1, updated_by = $2"),
        [true, "admin_1", "cfg_1"]
      );
    });
  });

  describe("deleteConfiguration", () => {
    it("should return false if configuration does not exist", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(null);
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const res = await service.deleteConfiguration("cfg_none", "admin_1");
      expect(res).toBe(false);
    });

    it("should throw error when attempting to delete active configuration", async () => {
      (layeredCache.get as jest.Mock).mockResolvedValue(mockConfig); // isActive: true

      await expect(service.deleteConfiguration("cfg_1", "admin_1")).rejects.toThrow(
        "Cannot delete active fee configuration"
      );
    });

    it("should return false if delete query returns rowCount 0", async () => {
      const inactiveConfig = { ...mockConfig, isActive: false };
      (layeredCache.get as jest.Mock).mockResolvedValue(inactiveConfig);
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 0 });

      const result = await service.deleteConfiguration("cfg_1", "admin_1");
      expect(result).toBe(false);
    });

    it("should delete inactive configuration, invalidate cache, and write DELETE audit log", async () => {
      const inactiveConfig = { ...mockConfig, isActive: false };
      (layeredCache.get as jest.Mock).mockResolvedValue(inactiveConfig);
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rowCount: 1 }) // DELETE query
        .mockResolvedValueOnce({}); // Audit log INSERT query

      const result = await service.deleteConfiguration("cfg_1", "admin_1", "127.0.0.1", "jest-agent");

      expect(result).toBe(true);
      expect(pool.query).toHaveBeenCalledWith("DELETE FROM fee_configurations WHERE id = $1", ["cfg_1"]);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_configuration_audit"),
        expect.arrayContaining(["cfg_1", "DELETE", expect.any(String), null, "admin_1", "127.0.0.1", "jest-agent"])
      );
      expect(layeredCache.del).toHaveBeenCalledWith("fee_config:cfg_1");
      expect(layeredCache.del).toHaveBeenCalledWith("fee_config:active");
    });
  });

  describe("activateConfiguration", () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      (pool.connect as jest.Mock).mockResolvedValue(mockClient);
    });

    it("should activate configuration in transaction, invalidate all caches, and log ACTIVATE audit", async () => {
      const activatedConfig = { ...mockConfig, isActive: true };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // UPDATE false
        .mockResolvedValueOnce({ rows: [activatedConfig] }) // UPDATE true
        .mockResolvedValueOnce({}); // COMMIT

      (pool.query as jest.Mock).mockResolvedValueOnce({}); // Audit log INSERT query

      const res = await service.activateConfiguration("cfg_1", "admin_1", "127.0.0.1", "agent");

      expect(res).toEqual(activatedConfig);
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("UPDATE fee_configurations SET is_active = false");
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE fee_configurations \n        SET is_active = true, updated_by = $2"),
        ["cfg_1", "admin_1"]
      );
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO fee_configuration_audit"),
        expect.arrayContaining(["cfg_1", "ACTIVATE", null, expect.any(String), "admin_1", "127.0.0.1", "agent"])
      );
      expect(layeredCache.delPattern).toHaveBeenCalledWith("fee_config:*");
      expect(layeredCache.del).toHaveBeenCalledWith("fee_config:active");
    });

    it("should rollback transaction and return null if target configuration not found", async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // UPDATE false
        .mockResolvedValueOnce({ rows: [] }) // UPDATE true
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await service.activateConfiguration("non_existent", "admin_1");

      expect(res).toBeNull();
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should rollback and rethrow error if database query fails", async () => {
      const dbErr = new Error("DB Connection Error");
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(dbErr); // Failure

      await expect(service.activateConfiguration("cfg_1", "admin_1")).rejects.toThrow("DB Connection Error");
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("getAuditHistory", () => {
    it("should return audit history rows from database", async () => {
      const mockAuditRows = [
        {
          id: "audit_1",
          action: "CREATE",
          oldValues: null,
          newValues: JSON.stringify(mockConfig),
          changedAt: new Date(),
          ipAddress: "127.0.0.1",
          userAgent: "test",
          changedByUser: "+1234567890",
        },
      ];

      (pool.query as jest.Mock).mockResolvedValue({ rows: mockAuditRows });

      const res = await service.getAuditHistory("cfg_1");

      expect(res).toEqual(mockAuditRows);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM fee_configuration_audit"),
        ["cfg_1"]
      );
    });
  });
});
