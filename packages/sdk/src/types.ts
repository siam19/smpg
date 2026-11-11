export type PaymentMethod = 'cod' | 'bkash' | 'nagad';

export type PaymentStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'PAID'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface CustomerInfo {
  name?: string;
  phone?: string;
}

export interface Payment {
  id: string;
  merchant_id: string;
  mode: 'test' | 'live';
  external_order_id?: string | null;
  method: PaymentMethod;
  wallet_id?: string | null;
  amount: number;
  status: PaymentStatus;
  trx_id?: string | null;
  sender_number?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  success_url: string;
  cancel_url?: string | null;
  checkout_url?: string;
  metadata?: Record<string, unknown> | null;
  pending_decision?: 'approve' | 'reject' | 'confirm' | 'cancel' | null;
  expires_at: string;
  created_at: string;
  updated_at?: string;
}

export interface CreatePaymentParams {
  amount: number;
  method?: PaymentMethod;
  external_order_id?: string;
  customer?: CustomerInfo;
  success_url: string;
  cancel_url?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentOptions {
  idempotencyKey?: string;
}

export interface ListPaymentsParams {
  external_order_id?: string;
  status?: PaymentStatus;
  limit?: number;
  cursor?: string;
}

export type WebhookEventType =
  | 'payment.created'
  | 'payment.submitted'
  | 'payment.confirmed'
  | 'payment.paid'
  | 'payment.rejected'
  | 'payment.reopened'
  | 'payment.expired'
  | 'payment.cancelled';

export interface WebhookEvent<T = Payment & { retry_url?: string }> {
  id: string;
  type: WebhookEventType;
  created: number;
  data: T;
}

export interface SMPGOptions {
  baseUrl: string;
  webhookSecret?: string;
  timeoutMs?: number;
}
