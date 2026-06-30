export interface WebhookEvent<T = any> {
  type: string;
  data: T;
}

export interface PaymentData {
  id: string;
  amount: number;
  status: string;
}
