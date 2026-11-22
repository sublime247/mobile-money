import express from "express";
import request from "supertest";

jest.mock("@stellar/stellar-sdk", () => ({
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
  },
  Keypair: {
    random: jest.fn(),
    fromSecret: jest.fn(),
  },
}));

import {
  sep12DocumentUploadMiddleware,
  validateDocumentMagicBytes,
  SEP12_MAX_DOCUMENT_SIZE,
} from "../../src/routes/sep12";

describe("SEP-12 Binary Document Upload Verification (#2123)", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock endpoint using the SEP-12 document upload middleware
    app.put(
      "/sep12/customer",
      sep12DocumentUploadMiddleware,
      (req: express.Request, res: express.Response) => {
        res.status(200).json({
          status: "ACCEPTED",
          receivedBody: req.body,
        });
      },
    );
  });

  describe("Magic byte screening", () => {
    it("validates correct JPEG, PNG, and PDF magic bytes", () => {
      const validPdf = Buffer.from("%PDF-1.4 sample content");
      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

      expect(validateDocumentMagicBytes(validPdf, "application/pdf")).toBe(true);
      expect(validateDocumentMagicBytes(validPng, "image/png")).toBe(true);
      expect(validateDocumentMagicBytes(validJpg, "image/jpeg")).toBe(true);
    });

    it("rejects mismatched magic bytes", () => {
      const fakePng = Buffer.from("THIS IS NOT A REAL PNG FILE");
      expect(validateDocumentMagicBytes(fakePng, "image/png")).toBe(false);

      const fakePdf = Buffer.from("MZ\x90\x00 executable file");
      expect(validateDocumentMagicBytes(fakePdf, "application/pdf")).toBe(false);
    });
  });

  describe("Multipart document upload handling", () => {
    const validJpgBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const validPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const validPdfBuffer = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj");

    it("accepts valid photo_id_front and photo_id_back binary uploads and stores encrypted references", async () => {
      const res = await request(app)
        .put("/sep12/customer")
        .field("first_name", "Jane")
        .field("last_name", "Doe")
        .attach("photo_id_front", validJpgBuffer, {
          filename: "passport_front.jpg",
          contentType: "image/jpeg",
        })
        .attach("photo_id_back", validPngBuffer, {
          filename: "passport_back.png",
          contentType: "image/png",
        });

      expect(res.status).toBe(200);
      expect(res.body.receivedBody.first_name).toBe("Jane");
      expect(res.body.receivedBody.photo_id_front).toMatch(/^enc_ref:/);
      expect(res.body.receivedBody.photo_id_back).toMatch(/^enc_ref:/);
    });

    it("accepts valid application/pdf binary uploads", async () => {
      const res = await request(app)
        .put("/sep12/customer")
        .attach("photo_id_front", validPdfBuffer, {
          filename: "national_id.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(200);
      expect(res.body.receivedBody.photo_id_front).toMatch(/^enc_ref:/);
    });

    it("rejects unsupported MIME types with 400 Bad Request", async () => {
      const res = await request(app)
        .put("/sep12/customer")
        .attach("photo_id_front", Buffer.from("hello world"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unsupported MIME type");
    });

    it("rejects spoofed payloads that fail magic byte verification with 400 Bad Request", async () => {
      // Content is plain text, but claimed as application/pdf
      const spoofedPayload = Buffer.from("MALICIOUS EXECUTABLE SCRIPT CONTENT");
      const res = await request(app)
        .put("/sep12/customer")
        .attach("photo_id_front", spoofedPayload, {
          filename: "id.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid file content");
    });

    it("enforces 5MB file size limit per document", async () => {
      // Generate a buffer larger than 5MB
      const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 1024, 0x25);

      const res = await request(app)
        .put("/sep12/customer")
        .attach("photo_id_front", oversizedBuffer, {
          filename: "huge_id.pdf",
          contentType: "application/pdf",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("File size exceeds 5MB limit");
    });
  });
});
