import "express";

declare global {
  namespace Express {
    interface User {
      id?: string;
      role?: string;
      ssoUserId?: string;
      providerId?: string;
    }

    interface Request {
      jwtUser?: { userId?: string; role?: string };
      user?: User;
      isNewDevice?: boolean;
      twoFactorVerified?: boolean;
      clientIp?: string;
      geoLocation?: unknown;
      userRole?: string;
      locale?: string;
    }
  }
}

export {};
