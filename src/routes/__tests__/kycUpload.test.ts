import request from 'supertest';
import { Pool } from 'pg';
import express from 'express';
import { createKYCRoutes } from '../kycRoutes';
import * as s3Upload from '../../services/s3Upload';

// Mock dependencies
jest.mock('../../services/s3Upload');
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    req.jwtUser = { userId: 'test-user-id', role: 'user' } as any;
    req.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
    next();
  },
}));

describe('KYC Document Upload', () => {
  let app: express.Application;
  let mockPool: any;

  beforeEach(() => {
    // Create mock pool
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    // Create express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/kyc', createKYCRoutes(mockPool));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/kyc/documents/upload', () => {
    it('should upload a valid PDF document', async () => {
      // Mock database queries
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any) // Access check
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'doc-id',
              file_url: 'https://bucket.s3.amazonaws.com/file.pdf',
              created_at: new Date(),
            },
          ],
        } as any); // Insert document

      // Mock S3 upload
      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: true,
        fileUrl: 'https://bucket.s3.amazonaws.com/file.pdf',
        key: 'kyc-documents/2024/03/user-id/file.pdf',
      });

      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .attach('document', Buffer.from('test pdf content'), 'test.pdf')
        .field('applicant_id', 'test-applicant-id')
        .field('document_type', 'passport')
        .field('document_side', 'front');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.file_url).toBeDefined();
      expect(response.body.data.document_id).toBeDefined();
    });

    it('should reject upload without file', async () => {
      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .field('applicant_id', 'test-applicant-id');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('No file uploaded');
    });

    it('should reject invalid file type', async () => {
      (s3Upload.validateFile as jest.Mock).mockReturnValue({
        valid: false,
        error: 'Invalid file type',
      });

      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .attach('document', Buffer.from('test content'), 'test.txt')
        .field('applicant_id', 'test-applicant-id');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid file type');
    });

    it('should reject upload without applicant_id', async () => {
      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .attach('document', Buffer.from('test pdf content'), 'test.pdf');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('applicant_id is required');
    });

    it('should reject upload for non-owned applicant', async () => {
      // Mock database query to return no rows (no access)
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .attach('document', Buffer.from('test pdf content'), 'test.pdf')
        .field('applicant_id', 'other-applicant-id');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });

    it('should handle S3 upload failure', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] } as any); // Access check

      (s3Upload.validateFile as jest.Mock).mockReturnValue({ valid: true });
      (s3Upload.uploadToS3 as jest.Mock).mockResolvedValue({
        success: false,
        error: 'S3 upload failed',
      });

      const response = await request(app)
        .post('/api/kyc/documents/upload')
        .attach('document', Buffer.from('test pdf content'), 'test.pdf')
        .field('applicant_id', 'test-applicant-id');

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('File upload failed');
    });
  });

  describe('GET /api/kyc/documents', () => {
    it('should return user documents', async () => {
      const mockDocuments = [
        {
          id: 'doc-1',
          applicant_id: 'app-1',
          document_type: 'passport',
          document_side: 'front',
          file_url: 'https://bucket.s3.amazonaws.com/file1.pdf',
          original_filename: 'passport.pdf',
          file_size: 1024,
          mime_type: 'application/pdf',
          created_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValueOnce({ rows: mockDocuments } as any);

      const response = await request(app).get('/api/kyc/documents');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe('doc-1');
    });

    it('should return empty array when no documents', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const response = await request(app).get('/api/kyc/documents');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });
  });
});

describe('File Validation', () => {
  it('should validate PDF files', () => {
    const file = {
      mimetype: 'application/pdf',
      size: 1024 * 1024, // 1MB
    } as Express.Multer.File;

    const result = s3Upload.validateFile(file);
    expect(result.valid).toBe(true);
  });

  it('should validate JPEG files', () => {
    const file = {
      mimetype: 'image/jpeg',
      size: 1024 * 1024,
    } as Express.Multer.File;

    const result = s3Upload.validateFile(file);
    expect(result.valid).toBe(true);
  });

  it('should validate PNG files', () => {
    const file = {
      mimetype: 'image/png',
      size: 1024 * 1024,
    } as Express.Multer.File;

    const result = s3Upload.validateFile(file);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid file types', () => {
    const file = {
      originalname: 'notes.txt',
      mimetype: 'text/plain',
      size: 1024,
    } as Express.Multer.File;

    const result = s3Upload.validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid file type');
  });

  it('should reject files exceeding size limit', () => {
    const file = {
      originalname: 'large.pdf',
      mimetype: 'application/pdf',
      size: 6 * 1024 * 1024, // 6MB
    } as Express.Multer.File;

    const result = s3Upload.validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds maximum limit');
  });
});
