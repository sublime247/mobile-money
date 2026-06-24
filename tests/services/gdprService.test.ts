import { GDPRService } from '../../src/services/gdprService';
import * as userService from '../../src/services/userService';
import { TransactionService } from '../../src/services/transactionService';
import { TransactionStatus } from '../../src/models/transaction';

jest.mock('../../src/services/userService');
jest.mock('../../src/services/transactionService');
jest.mock('../../src/config/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../src/config/s3', () => ({ getS3Client: jest.fn(), s3Config: { bucket: 'test-bucket' } }));
jest.mock('../../src/utils/log-audit-event', () => ({ logAuditEvent: jest.fn() }));
jest.mock('../../src/services/auditlogService', () => ({
  auditService: { fetchAuditLogs: jest.fn().mockResolvedValue([]), updateAuditLog: jest.fn() },
}));
jest.mock('../../src/models/transaction');

const mockUser = {
  id: 'user-1',
  phone_number: '+237600000000',
  kyc_level: 'basic',
  role_name: 'user',
  display_name: 'Alice',
  created_at: new Date('2025-01-01'),
  updated_at: new Date('2025-06-01'),
  backup_codes: [],
};

const mockTx = {
  id: 'tx-1',
  referenceNumber: 'REF-1',
  type: 'deposit',
  amount: '5000',
  provider: 'MTN',
  status: TransactionStatus.Completed,
  createdAt: new Date('2025-03-01'),
  updatedAt: new Date('2025-03-02'),
  phoneNumber: '+237600000000',
  idempotencyKey: 'key-1',
  stellarAddress: 'GABC',
};

describe('GDPRService', () => {
  let svc: GDPRService;
  let findByUserIdMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    findByUserIdMock = jest.fn().mockResolvedValue([mockTx]);
    (TransactionService as jest.Mock).mockImplementation(() => ({ findByUserId: findByUserIdMock }));
    svc = new GDPRService();
  });

  describe('exportUserData', () => {
    it('returns a non-empty Buffer with ZIP magic bytes', async () => {
      (userService.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const buffer = await svc.exportUserData('user-1');
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
      // ZIP local file header signature: PK\x03\x04
      expect(buffer[0]).toBe(0x50); // P
      expect(buffer[1]).toBe(0x4b); // K
    });
  });

  describe('anonymizeTransaction', () => {
    it('hashes phoneNumber, idempotencyKey, and stellarAddress', () => {
      const result = svc.anonymizeTransaction(mockTx as any);
      expect(result.phoneNumber).not.toBe(mockTx.phoneNumber);
      expect(result.phoneNumber).toHaveLength(16);
      expect(result.stellarAddress).not.toBe(mockTx.stellarAddress);
      expect(result.idempotencyKey).not.toBe(mockTx.idempotencyKey);
    });

    it('preserves null/undefined fields without hashing', () => {
      const tx = { ...mockTx, phoneNumber: null, idempotencyKey: null, stellarAddress: null };
      const result = svc.anonymizeTransaction(tx as any);
      expect(result.phoneNumber).toBeNull();
      expect(result.stellarAddress).toBeNull();
      expect(result.idempotencyKey).toBeNull();
    });
  });

  describe('anonymizeEmail', () => {
    it('returns an anonymized local email address', () => {
      const result = svc.anonymizeEmail('alice@example.com');
      expect(result).toMatch(/@anonymized\.local$/);
      expect(result).not.toContain('alice');
    });
  });

  describe('anonymizePhoneNumber', () => {
    it('returns a 16-char lowercase hex string', () => {
      const result = svc.anonymizePhoneNumber('+237600000000');
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it('is deterministic for the same input', () => {
      expect(svc.anonymizePhoneNumber('+1234')).toBe(svc.anonymizePhoneNumber('+1234'));
    });
  });
});
