declare global {
  namespace Express {
    interface User {
      [key: string]: unknown;
    }
    interface Request {
      samlLogoutRequest?: any;
      isNewDevice?: boolean;
    }
  }
}

export {};