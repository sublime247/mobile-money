import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    jwtUser?: { userId?: string; role?: string };
    user?: { id?: string; role?: string };
    isNewDevice?: boolean;
    twoFactorVerified?: boolean;
    clientIp?: string;
    geoLocation?: unknown;
    userRole?: string;
    /**
     * Aborts when this request's dynamic timeout elapses (see
     * middleware/requestTimeout.ts). Handlers that run cancellable work
     * (DB queries via `queryRead`/`queryWrite`'s `signal` option, or
     * provider HTTP calls) should pass this through so that work actually
     * stops instead of running to completion after the client has already
     * received a 504.
     */
    abortSignal?: AbortSignal;
  }
}
