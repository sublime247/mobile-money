import { isReadOnlyQuery, getQueryCommand } from "../../src/utils/readOnlyDetector";

describe("readOnlyDetector", () => {
  describe("isReadOnlyQuery", () => {
    it("should return true for a basic SELECT statement", () => {
      expect(isReadOnlyQuery("SELECT * FROM users;")).toBe(true);
    });

    it("should return true for a WITH ... SELECT statement", () => {
      expect(isReadOnlyQuery("WITH cte AS (SELECT * FROM users) SELECT * FROM cte;")).toBe(true);
    });

    it("should return false for an INSERT statement", () => {
      expect(isReadOnlyQuery("INSERT INTO users (name) VALUES ('John');")).toBe(false);
    });

    it("should return false for an UPDATE statement", () => {
      expect(isReadOnlyQuery("UPDATE users SET name = 'John' WHERE id = 1;")).toBe(false);
    });

    it("should return false for a DELETE statement", () => {
      expect(isReadOnlyQuery("DELETE FROM users WHERE id = 1;")).toBe(false);
    });

    it("should return false if SELECT contains a write pattern like UPDATE", () => {
      // Technically this might be a false positive depending on the context (e.g. column name 'update_time'),
      // but testing the current behavior
      expect(isReadOnlyQuery("SELECT id FROM updates;")).toBe(false);
    });

    it("should return false for transaction boundaries like BEGIN", () => {
      expect(isReadOnlyQuery("BEGIN;")).toBe(false);
      expect(isReadOnlyQuery("COMMIT;")).toBe(false);
    });

    it("should handle empty or null values", () => {
      expect(isReadOnlyQuery("")).toBe(false);
      // @ts-expect-error Testing invalid input
      expect(isReadOnlyQuery(null)).toBe(false);
    });
  });

  describe("getQueryCommand", () => {
    it("should extract SELECT", () => {
      expect(getQueryCommand("SELECT * FROM users")).toBe("SELECT");
    });

    it("should extract INSERT", () => {
      expect(getQueryCommand("INSERT INTO users (name) VALUES ('x')")).toBe("INSERT");
    });

    it("should extract UPDATE", () => {
      expect(getQueryCommand("UPDATE users SET x=1")).toBe("UPDATE");
    });

    it("should return UNKNOWN for empty or invalid query", () => {
      expect(getQueryCommand("")).toBe("UNKNOWN");
      // @ts-expect-error Testing invalid input
      expect(getQueryCommand(null)).toBe("UNKNOWN");
    });
  });
});
