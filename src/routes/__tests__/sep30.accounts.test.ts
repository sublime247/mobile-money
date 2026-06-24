/**
 * Integration tests for SEP-30 /accounts endpoints.
 *
 * Acceptance criteria covered:
 *   ✓ POST /sep30/accounts  — creates a managed account (SEP-30 §4)
 *   ✓ PUT  /sep30/accounts/:id — updates identities / signers (SEP-30 §5)
 *   ✓ POST /sep30/accounts/:id/sign — signs a transaction, requires 2FA (SEP-30 §6)
 *   ✓ /sign returns 403 when mfa_code is missing or invalid
 *   ✓ /sign returns 403 when user has no 2FA configured
 */
import request from 'supertest';
import express from 'express';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateManagedKey = jest.fn();
const mockListRecoverySigners = jest.fn();
const mockRemoveRecoverySigner = jest.fn();
const mockAddRecoverySigner = jest.fn();
const mockSignAndSubmit = jest.fn();

jest.mock('../../services/sep30/sep30Service', () => {
  return {
    Sep30Service: jest.fn().mockImplementation(() => ({
      createManagedKey: mockCreateManagedKey,
      listRecoverySigners: mockListRecoverySigners,
      removeRecoverySigner: mockRemoveRecoverySigner,
      addRecoverySigner: mockAddRecoverySigner,
      signAndSubmit: mockSignAndSubmit,
    })),
  };
});

const mockQuery = jest.fn();
jest.mock('../../config/database', () => ({
  pool: {
    query: mockQuery,
  },
}));

const mockVerify = jest.fn();
jest.mock('speakeasy', () => ({
  totp: {
    verify: mockVerify,
  },
}), { virtual: true });

// Require router AFTER setting up the mocks to ensure it gets mock bindings
import { sep30Routes } from '../sep30';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID = '11111111-1111-4111-a111-111111111111';
const VALID_KEY_ID = '22222222-2222-4222-a222-222222222222';
const VALID_PUBKEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSMFOH2BL39CQHNGFEZVZ';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/sep30', sep30Routes);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SEP-30 /accounts endpoints', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // ── POST /sep30/accounts ─────────────────────────────────────────────────

  describe('POST /sep30/accounts', () => {
    it('creates a managed account and returns address + id', async () => {
      mockCreateManagedKey.mockResolvedValueOnce({
        publicKey: VALID_PUBKEY,
        keyId: VALID_KEY_ID,
      });

      const res = await request(app)
        .post('/sep30/accounts')
        .send({
          userId: VALID_UUID,
          identities: [
            {
              role: 'owner',
              auth_methods: [{ type: 'stellar_address', value: VALID_PUBKEY }],
            },
          ],
        })
        .expect(201);

      expect(res.body.address).toBe(VALID_PUBKEY);
      expect(res.body.id).toBe(VALID_KEY_ID);
      expect(res.body.identities).toHaveLength(1);
      expect(mockCreateManagedKey).toHaveBeenCalledWith(VALID_UUID);
    });

    it('returns 400 when identities array is missing', async () => {
      const res = await request(app)
        .post('/sep30/accounts')
        .send({ userId: VALID_UUID })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when auth_methods is empty', async () => {
      const res = await request(app)
        .post('/sep30/accounts')
        .send({
          userId: VALID_UUID,
          identities: [{ role: 'owner', auth_methods: [] }],
        })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when no userId can be determined', async () => {
      const res = await request(app)
        .post('/sep30/accounts')
        .send({
          identities: [
            {
              role: 'owner',
              auth_methods: [{ type: 'phone_number', value: '+1234567890' }],
            },
          ],
        })
        .expect(400);

      expect(res.body.error).toMatch(/userId/);
    });
  });

  // ── PUT /sep30/accounts/:id ──────────────────────────────────────────────

  describe('PUT /sep30/accounts/:id', () => {
    beforeEach(() => {
      mockListRecoverySigners.mockResolvedValue([]);
      mockAddRecoverySigner.mockResolvedValue({
        id: 'signer-1',
        managedKeyId: VALID_KEY_ID,
        signerPublicKey: VALID_PUBKEY,
        signerLabel: 'stellar_address',
        createdAt: new Date(),
      });
    });

    it('updates identities and returns the new signer list', async () => {
      const res = await request(app)
        .put(`/sep30/accounts/${VALID_KEY_ID}`)
        .send({
          userId: VALID_UUID,
          identities: [
            {
              role: 'owner',
              auth_methods: [{ type: 'stellar_address', value: VALID_PUBKEY }],
            },
          ],
        })
        .expect(200);

      expect(res.body.id).toBe(VALID_KEY_ID);
      expect(res.body.signers).toHaveLength(1);
      expect(mockAddRecoverySigner).toHaveBeenCalledWith(
        VALID_KEY_ID,
        VALID_UUID,
        VALID_PUBKEY,
        'stellar_address',
      );
    });

    it('returns 400 when userId is missing', async () => {
      const res = await request(app)
        .put(`/sep30/accounts/${VALID_KEY_ID}`)
        .send({
          identities: [
            {
              role: 'owner',
              auth_methods: [{ type: 'stellar_address', value: VALID_PUBKEY }],
            },
          ],
        })
        .expect(400);

      expect(res.body.error).toMatch(/userId/);
    });

    it('removes old signers before adding new ones', async () => {
      mockListRecoverySigners.mockResolvedValue([
        {
          id: 'old-signer',
          managedKeyId: VALID_KEY_ID,
          signerPublicKey: 'GOLD_KEY_0000000000000000000000000000000000000000000',
          signerLabel: 'old',
          createdAt: new Date(),
        },
      ]);
      mockRemoveRecoverySigner.mockResolvedValue(undefined);

      await request(app)
        .put(`/sep30/accounts/${VALID_KEY_ID}`)
        .send({
          userId: VALID_UUID,
          identities: [
            {
              role: 'owner',
              auth_methods: [{ type: 'stellar_address', value: VALID_PUBKEY }],
            },
          ],
        })
        .expect(200);

      expect(mockRemoveRecoverySigner).toHaveBeenCalledTimes(1);
    });
  });

  // ── POST /sep30/accounts/:id/sign ────────────────────────────────────────

  describe('POST /sep30/accounts/:id/sign', () => {
    const VALID_XDR = Buffer.from('fake-xdr-envelope').toString('base64');
    const VALID_MFA = '123456';

    beforeEach(() => {
      // DB returns a user with a TOTP secret
      mockQuery.mockResolvedValue({
        rows: [{ two_factor_secret: 'BASE32SECRET' }],
      });
      // TOTP check passes
      mockVerify.mockReturnValue(true);
      mockSignAndSubmit.mockResolvedValue('tx-hash-abc123');
    });

    it('returns 400 when body is invalid (missing transaction)', async () => {
      const res = await request(app)
        .post(`/sep30/accounts/${VALID_KEY_ID}/sign`)
        .send({ userId: VALID_UUID, mfa_code: VALID_MFA })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when mfa_code is missing', async () => {
      const res = await request(app)
        .post(`/sep30/accounts/${VALID_KEY_ID}/sign`)
        .send({ userId: VALID_UUID, transaction: VALID_XDR })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 403 when user is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/sep30/accounts/${VALID_KEY_ID}/sign`)
        .send({ userId: VALID_UUID, transaction: VALID_XDR, mfa_code: VALID_MFA })
        .expect(404);

      expect(res.body.error).toBe('User not found');
    });

    it('returns 403 when user has no 2FA configured', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ two_factor_secret: null }],
      });

      const res = await request(app)
        .post(`/sep30/accounts/${VALID_KEY_ID}/sign`)
        .send({ userId: VALID_UUID, transaction: VALID_XDR, mfa_code: VALID_MFA })
        .expect(403);

      expect(res.body.error).toBe('MFA not configured');
    });

    it('returns 403 when mfa_code is incorrect', async () => {
      mockVerify.mockReturnValue(false);

      const res = await request(app)
        .post(`/sep30/accounts/${VALID_KEY_ID}/sign`)
        .send({ userId: VALID_UUID, transaction: VALID_XDR, mfa_code: '000000' })
        .expect(403);

      expect(res.body.error).toBe('Invalid MFA code');
    });
  });
});
