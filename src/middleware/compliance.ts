import { checkAccountStatusStrict } from "./checkAccountStatus";
import { geoFencingMiddleware } from "./geoFencing";
import { geolocateMiddleware } from "./geolocate";
import { kycCheck } from "./kycCheck";
import { detectFraud } from "./fraudDetection";
import { validateNetworkMiddleware } from "./validateNetworkMiddleware";
import { complianceRulesMiddleware } from "./complianceRules";
import { velocityCheckMiddleware } from "./velocityCheck";

/**
 * Modularized compliance checking middleware chain.
 * This bundles all the necessary compliance and security checks
 * (KYC, Fraud Detection, Geo-Fencing, Account Status, Velocity / Structuring, etc.)
 * into a single reusable array for transaction endpoints.
 * 
 * Note: validateTransaction should typically run BEFORE this, 
 * but validateNetworkMiddleware is included here as part of compliance.
 */
export const complianceMiddlewares = [
  complianceRulesMiddleware,
  checkAccountStatusStrict,
  geoFencingMiddleware,
  validateNetworkMiddleware,
  geolocateMiddleware,
  kycCheck,
  detectFraud,
  velocityCheckMiddleware,
];

