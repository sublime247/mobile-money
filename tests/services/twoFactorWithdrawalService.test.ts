import { TwoFactorWithdrawalService, validate2FAForWithdrawal, twoFactorWithdrawalService } from '../../src/services/twoFactorWithdrawalService';
import { UserModel } from '../../src/models/users';
import * as twoFaAuth from '../../src/auth/2fa';
import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/models/users');
jest.mock('../../src/auth/2fa');
jest.mock('../../src/config/database', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/services/twoFactorRateLimiter', () => ({
  twoFactorRateLimiter: {
    isLocked: jest.fn().mockResolvedValue(false),
    getLockoutTimeRemaining: jest.fn().mockResolvedValue(0),
    resetFailures: jest.fn().mockResolvedValue(undefined),
    incrementFailures: jest.fn().mockResolvedValue(1),
  },
}));

const mockFindById = jest.fn();
const mockUpdateMandatory = jest.fn().mockResolvedValue(undefined);
(UserModel as jest.Mock).mockImplementation(() => ({
  findById: mockFindById,
  updateMandatory2FAWithdrawals: mockUpdateMandatory,
}));

const baseUser = {
  id: 'user-1',
  mandatory2FAWithdrawals: true,
  two_factor_secret: 'SECRET',
  two_factor_enabled: true,
};

describe('TwoFactorWithdrawalService', () => {
  let svc: TwoFactorWithdrawalService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new TwoFactorWithdrawalService();
  });

  describe('requires2FAForWithdrawal', () => {
    it('returns true when mandatory2FAWithdrawals is enabled', async () => {
      mockFindById.mockResolvedValue(baseUser);
      await expect(svc.requires2FAForWithdrawal('user-1')).resolves.toBe(true);
    });

    it('returns false when mandatory2FAWithdrawals is not set', async () => {
      mockFindById.mockResolvedValue({ ...baseUser, mandatory2FAWithdrawals: false });
      await expect(svc.requires2FAForWithdrawal('user-1')).resolves.toBe(false);
    });

    it('throws when user not found', async () => {
      mockFindById.mockResolvedValue(null);
      await expect(svc.requires2FAForWithdrawal('missing')).rejects.toThrow('User not found');
    });
  });

  describe('getWithdrawal2FASettings', () => {
    it('returns correct settings for a user with 2FA enabled', async () => {
      (twoFaAuth.is2FAEnabled as jest.Mock).mockReturnValue(true);
      mockFindById.mockResolvedValue(baseUser);

      const settings = await svc.getWithdrawal2FASettings('user-1');
      expect(settings).toEqual({ mandatory2FAWithdrawals: true, has2FAEnabled: true, canEnableMandatory: true });
    });

    it('throws when user not found', async () => {
      mockFindById.mockResolvedValue(null);
      await expect(svc.getWithdrawal2FASettings('missing')).rejects.toThrow('User not found');
    });
  });

  describe('updateMandatory2FAWithdrawals', () => {
    it('throws when user not found', async () => {
      mockFindById.mockResolvedValue(null);
      await expect(svc.updateMandatory2FAWithdrawals('missing', true)).rejects.toThrow('User not found');
    });

    it('throws when enabling without 2FA set up', async () => {
      (twoFaAuth.is2FAEnabled as jest.Mock).mockReturnValue(false);
      mockFindById.mockResolvedValue({ ...baseUser, two_factor_enabled: false });
      await expect(svc.updateMandatory2FAWithdrawals('user-1', true)).rejects.toThrow(
        'Cannot enable mandatory 2FA withdrawals without 2FA being enabled',
      );
    });
  });
});

describe('validate2FAForWithdrawal middleware', () => {
  const makeReq = (body = {}, userId?: string) =>
    ({ body, jwtUser: userId ? { userId } : undefined } as unknown as Request);

  const makeRes = () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    return res;
  };

  const next = jest.fn() as NextFunction;

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no authenticated user', async () => {
    const res = makeRes();
    await validate2FAForWithdrawal(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user does not require 2FA', async () => {
    jest.spyOn(twoFactorWithdrawalService, 'requires2FAForWithdrawal').mockResolvedValue(false);
    const res = makeRes();
    await validate2FAForWithdrawal(makeReq({}, 'user-1'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when 2FA required but verification fails', async () => {
    jest.spyOn(twoFactorWithdrawalService, 'requires2FAForWithdrawal').mockResolvedValue(true);
    jest.spyOn(twoFactorWithdrawalService, 'verifyWithdrawal2FA').mockResolvedValue({ success: false, error: 'Invalid token' });
    const res = makeRes();
    await validate2FAForWithdrawal(makeReq({ otpToken: 'bad' }, 'user-1'), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when 2FA verification succeeds', async () => {
    jest.spyOn(twoFactorWithdrawalService, 'requires2FAForWithdrawal').mockResolvedValue(true);
    jest.spyOn(twoFactorWithdrawalService, 'verifyWithdrawal2FA').mockResolvedValue({ success: true, method: 'totp' });
    const res = makeRes();
    await validate2FAForWithdrawal(makeReq({ otpToken: '123456' }, 'user-1'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when requires2FAForWithdrawal throws (graceful fallback)', async () => {
    jest.spyOn(twoFactorWithdrawalService, 'requires2FAForWithdrawal').mockRejectedValue(new Error('DB error'));
    const res = makeRes();
    await validate2FAForWithdrawal(makeReq({}, 'user-1'), res, next);
    // error caught via .catch(() => false) → proceeds as if not required
    expect(next).toHaveBeenCalled();
  });
});
