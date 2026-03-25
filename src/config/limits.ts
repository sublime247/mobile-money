export enum KYCLevel {
  Unverified = 'unverified',
  Basic = 'basic',
  Full = 'full'
}

export interface LimitConfig {
  [KYCLevel.Unverified]: number;
  [KYCLevel.Basic]: number;
  [KYCLevel.Full]: number;
}

export const TRANSACTION_LIMITS: LimitConfig = {
  [KYCLevel.Unverified]: parseFloat(process.env.LIMIT_UNVERIFIED || '10000'),
  [KYCLevel.Basic]: parseFloat(process.env.LIMIT_BASIC || '100000'),
  [KYCLevel.Full]: parseFloat(process.env.LIMIT_FULL || '1000000')
};

// Per-transaction amount limits
export const MIN_TRANSACTION_AMOUNT = parseFloat(process.env.MIN_TRANSACTION_AMOUNT || '100');
export const MAX_TRANSACTION_AMOUNT = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '1000000');

// Validation on module load
function validateLimits(limits: LimitConfig): void {
  const values = Object.values(limits);
  if (values.some(v => v <= 0 || !isFinite(v))) {
    throw new Error('All transaction limits must be positive finite numbers');
  }
  if (limits[KYCLevel.Basic] < limits[KYCLevel.Unverified]) {
    throw new Error('Basic KYC limit must be >= Unverified limit');
  }
  if (limits[KYCLevel.Full] < limits[KYCLevel.Basic]) {
    throw new Error('Full KYC limit must be >= Basic limit');
  }
}

function validateAmountLimits(): void {
  if (MIN_TRANSACTION_AMOUNT <= 0 || !isFinite(MIN_TRANSACTION_AMOUNT)) {
    throw new Error('MIN_TRANSACTION_AMOUNT must be a positive finite number');
  }
  if (MAX_TRANSACTION_AMOUNT <= 0 || !isFinite(MAX_TRANSACTION_AMOUNT)) {
    throw new Error('MAX_TRANSACTION_AMOUNT must be a positive finite number');
  }
  if (MIN_TRANSACTION_AMOUNT > MAX_TRANSACTION_AMOUNT) {
    throw new Error('MIN_TRANSACTION_AMOUNT must be <= MAX_TRANSACTION_AMOUNT');
  }
}

validateLimits(TRANSACTION_LIMITS);
validateAmountLimits();
