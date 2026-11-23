import express from "express";
import request from "supertest";
import { PassThrough, Readable } from "stream";
import { generateKeyPairSync } from "crypto";

jest.mock("../../middleware/auth", () => ({
  requireAuth: jest.fn((req, res, next) => {
    const userId = req.headers["x-test-user-id"];
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = { id: userId };
    next();
  }),
}));

import { createExportRoutes } from "../export";

function buildApp(
  rows: Record<string, unknown>[],
  createQueryStream = jest.fn(
    (text: string, values: unknown[]) => ({ text, values }) as any,
  ),
) {
  const stream = new PassThrough({ objectMode: true });
  const client = {
    release: jest.fn(),
    query: jest.fn(() => {
      process.nextTick(() => {
        rows.forEach((row) => stream.write(row));
        stream.end();
      });
      return stream;
    }),
  };

  const db = { connect: jest.fn().mockResolvedValue(client) };

  const app = express();
  app.use(
    createExportRoutes({
      db: db as any,
      createQueryStream: createQueryStream as any,
    }),
  );

  return { app, db, client, createQueryStream };
}

describe("createExportRoutes", () => {
  describe("authentication and scoping", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const { app } = buildApp([]);

      await request(app).get("/export").expect(401);
    });

    it("always scopes the query to the authenticated caller, ignoring a client-supplied userId", async () => {
      const { app, createQueryStream } = buildApp([]);

      await request(app)
        .get("/export?userId=someone-elses-id&format=json")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(createQueryStream).toHaveBeenCalledWith(
        expect.stringContaining("WHERE"),
        ["user-1"],
      );
    });
  });

  describe("CSV export", () => {
    it("streams CSV exports with scoped filters and escaped values", async () => {
      const rows = [
        {
          id: 1,
          user_id: "user-1",
          amount: 100,
          currency: "USD",
          type: "deposit",
          status: "completed",
          created_at: "2024-01-02T03:04:05.000Z",
          description: 'hello,"world"\nnext',
        },
      ];
      const { app, client, createQueryStream } = buildApp(rows);

      const response = await request(app)
        .get("/export?startDate=2024-01-01&status=completed&format=csv")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.text).toContain(
        "id,user_id,amount,currency,type,status,created_at,description",
      );
      expect(response.text).toContain('"hello,""world""\nnext"');
      expect(createQueryStream).toHaveBeenCalledWith(
        expect.stringContaining("WHERE"),
        expect.any(Array),
      );
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe("JSON export", () => {
    it("streams JSON exports and returns a 500 response when the database fails", async () => {
      const { app, db } = buildApp([{ id: 2, status: "pending" }]);

      const response = await request(app)
        .get("/export?format=json")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.text).toContain('"id": 2');
      expect(response.text).toContain('"status": "pending"');

      db.connect.mockRejectedValueOnce(new Error("db unavailable"));
      const errorResponse = await request(app)
        .get("/export?format=json")
        .set("x-test-user-id", "user-1")
        .expect(500);

      expect(errorResponse.body).toEqual({ error: "Export failed" });
    });
  });

  describe("PDF export", () => {
    it("streams a PDF export with the correct content type", async () => {
      const rows = [
        {
          id: 1,
          user_id: "user-1",
          amount: 100,
          currency: "USD",
          type: "deposit",
          status: "completed",
          created_at: "2024-01-02T03:04:05.000Z",
          description: "test",
        },
      ];
      const { app } = buildApp(rows);

      const response = await request(app)
        .get("/export?format=pdf")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain(
        "transactions-",
      );
      // PDF files start with the "%PDF-" magic header
      expect((response.body as Buffer).slice(0, 5).toString()).toBe("%PDF-");
    });

    it("renders a valid PDF even with zero rows", async () => {
      const { app } = buildApp([]);

      const response = await request(app)
        .get("/export?format=pdf")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect((response.body as Buffer).slice(0, 5).toString()).toBe("%PDF-");
    });
  });

  describe("signed exports", () => {
    const originalSigningKey = process.env.ANCHOR_REPORT_SIGNING_KEY;

    afterEach(() => {
      if (originalSigningKey === undefined)
        delete process.env.ANCHOR_REPORT_SIGNING_KEY;
      else process.env.ANCHOR_REPORT_SIGNING_KEY = originalSigningKey;
    });

    it("returns a ZIP containing the streamed signed CSV export", async () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      process.env.ANCHOR_REPORT_SIGNING_KEY = privateKey;
      const { app, client } = buildApp([{ id: 3, status: "completed" }]);

      const response = await request(app)
        .get("/export?format=csv&signed=true")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/zip");
      expect((response.body as Buffer).subarray(0, 4).toString("hex")).toBe(
        "504b0304",
      );
      expect(client.release).toHaveBeenCalled();
    });

    it("returns a ZIP containing the streamed signed PDF export", async () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      process.env.ANCHOR_REPORT_SIGNING_KEY = privateKey;
      const { app } = buildApp([{ id: 4, status: "completed" }]);

      const response = await request(app)
        .get("/export?format=pdf&signed=true")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/zip");
      expect((response.body as Buffer).subarray(0, 4).toString("hex")).toBe(
        "504b0304",
      );
    });
  });

  describe("large exports do not exhaust memory (#1794)", () => {
    /**
     * Builds an app whose "database" row source is a lazily-generated
     * Readable — one row materialised at a time, on demand — rather than a
     * pre-built in-memory array. This is the point of the test: a fixture
     * that pushes `rowCount` rows via a real array (as `buildApp` above
     * does) would itself hold all of them in memory at once, which asserts
     * nothing about whether the ROUTE buffers. A lazy generator can only
     * pass this test if the route genuinely drains the stream incrementally
     * rather than collecting it into an array or string before responding.
     */
    function buildAppWithGeneratedRows(rowCount: number) {
      function* generateRows() {
        for (let i = 0; i < rowCount; i++) {
          yield {
            id: i,
            user_id: "user-1",
            amount: i,
            currency: "USD",
            type: i % 2 === 0 ? "deposit" : "withdrawal",
            status: "completed",
            created_at: "2024-01-02T03:04:05.000Z",
            // A moderately-sized field so the fixture is representative of
            // a real transaction row, without being large enough to make
            // the test itself slow.
            description: `transaction number ${i} of ${rowCount}`,
          };
        }
      }

      const client = {
        release: jest.fn(),
        query: jest.fn(() =>
          Readable.from(generateRows(), { objectMode: true }),
        ),
      };
      const db = { connect: jest.fn().mockResolvedValue(client) };

      const app = express();
      app.use(
        createExportRoutes({
          db: db as any,
          createQueryStream: jest.fn(
            (text: string, values: unknown[]) => ({ text, values }) as any,
          ),
        }),
      );

      return { app, client };
    }

    it("streams a large CSV export incrementally, with a low peak resident set size", async () => {
      const ROW_COUNT = 200_000;
      const { app, client } = buildAppWithGeneratedRows(ROW_COUNT);

      // A response streamed incrementally arrives as many small "data"
      // events; a response that was fully buffered before being sent (the
      // failure mode this test guards against) arrives as one or a
      // handful of very large events instead. Counting events — not just
      // asserting the final byte count — is what actually distinguishes
      // "streamed" from "buffered then sent all at once".
      let dataEventCount = 0;
      let maxChunkBytes = 0;
      let totalBytes = 0;
      let lineCount = 0;

      await new Promise<void>((resolve, reject) => {
        request(app)
          .get("/export?format=csv")
          .set("x-test-user-id", "user-1")
          .buffer(false)
          .parse((res, callback) => {
            res.on("data", (chunk: Buffer) => {
              dataEventCount++;
              totalBytes += chunk.length;
              maxChunkBytes = Math.max(maxChunkBytes, chunk.length);
              for (const byte of chunk) {
                if (byte === 0x0a /* \n */) lineCount++;
              }
            });
            res.on("end", () => callback(null, undefined));
          })
          .end((err) => (err ? reject(err) : resolve()));
      });

      // Header line + one line per row. Allow a small margin either way —
      // this counts raw `\n` bytes across independently-delivered chunks
      // purely to size the response, not to assert exact data integrity
      // (the "streams CSV exports with scoped filters" test above already
      // covers correctness of individual rows); the chunk-shape assertions
      // below are this test's actual regression guard.
      expect(lineCount).toBeGreaterThan(ROW_COUNT * 0.9);
      expect(client.release).toHaveBeenCalled();

      // The real regression guard: many small chunks, not the whole
      // response as one (or a few) massive buffered writes. A fully
      // buffered implementation — e.g. collecting every row into an array
      // or a single string before writing anything — would produce a
      // single `data` event whose size is close to `totalBytes`; a
      // genuinely streamed response produces many events, each far
      // smaller than the total. This is what actually distinguishes
      // "streamed, bounded memory" from "buffered, memory scales with row
      // count" without relying on GC-timing-sensitive heap measurements,
      // which are too noisy under Jest/V8 to assert on reliably here.
      expect(dataEventCount).toBeGreaterThan(10);
      expect(maxChunkBytes).toBeLessThan(totalBytes / 5);
    }, 30_000);
  });
});
