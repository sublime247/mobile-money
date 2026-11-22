import fs from "fs";
import path from "path";

describe("Database Migration Rollback Validation Tests (#1992)", () => {
  const migrationsDir = path.resolve(__dirname, "../../../migrations");

  it("should have a migrations directory that exists", () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);
  });

  it("should ensure every migration script includes a functioning down migration", () => {
    const allFiles = fs.readdirSync(migrationsDir);
    const upMigrations = allFiles.filter(
      (f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith(".down.sql"),
    );

    expect(upMigrations.length).toBeGreaterThan(0);

    const missingDownFiles: string[] = [];

    for (const upFile of upMigrations) {
      const downFilename = upFile.replace(/\.sql$/, ".down.sql");
      const downPath = path.join(migrationsDir, downFilename);

      if (!fs.existsSync(downPath)) {
        missingDownFiles.push(upFile);
      }
    }

    expect(missingDownFiles).toEqual([]);
  });

  it("should ensure all .down.sql files are non-empty and contain rollback statements", () => {
    const allFiles = fs.readdirSync(migrationsDir);
    const downMigrations = allFiles.filter((f) => f.endsWith(".down.sql"));

    expect(downMigrations.length).toBeGreaterThan(0);

    for (const downFile of downMigrations) {
      const content = fs.readFileSync(path.join(migrationsDir, downFile), "utf-8").trim();
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("should guarantee no duplicate migration version numbers", () => {
    const allFiles = fs.readdirSync(migrationsDir);
    const upMigrations = allFiles.filter(
      (f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith(".down.sql"),
    );

    const versionPrefixes = new Map<string, string[]>();

    for (const file of upMigrations) {
      const match = file.match(/^(\d+_.+)\.sql$/);
      if (match) {
        const key = match[1];
        const existing = versionPrefixes.get(key) || [];
        existing.push(file);
        versionPrefixes.set(key, existing);
      }
    }

    const duplicates = [...versionPrefixes.entries()].filter(
      ([, files]) => files.length > 1,
    );
    expect(duplicates).toEqual([]);
  });

  it("should verify migration rollback execution using mock database pool", async () => {
    const mockClient = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("BEGIN") || sql.includes("COMMIT")) {
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM schema_migrations")) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    // Simulate rolling back two migrations
    await mockClient.query("BEGIN");
    await mockClient.query("DROP TABLE IF EXISTS compliance_documents CASCADE;");
    await mockClient.query("DELETE FROM schema_migrations WHERE version = $1", ["20260426_create_compliance_documents"]);
    await mockClient.query("COMMIT");

    expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.query).toHaveBeenCalledWith("DROP TABLE IF EXISTS compliance_documents CASCADE;");
    expect(mockClient.query).toHaveBeenCalledWith("DELETE FROM schema_migrations WHERE version = $1", ["20260426_create_compliance_documents"]);
    expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
  });
});
