export type PaymentMethod = 'cod' | 'bkash' | 'nagad';

export type PaymentStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'PAID'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface CheckoutStoreInfo {
  name: string;
  brand_color: string;
  logo_key: string | null;
}

export interface AssignedWallet {
  id: string;
  provider: string;
  number: string;
  label: string | null;
}

export interface CheckoutSessionData {
  id: string;
  amount: number;
  currency: string;
  external_order_id: string | null;
  status: PaymentStatus;
  store: CheckoutStoreInfo;
  available_methods: PaymentMethod[];
  method: PaymentMethod | null;
  assigned_wallet: AssignedWallet | null;
  trx_id: string | null;
  sender_number: string | null;
  attempts: number;
  attempts_remaining: number;
  expires_at: string;
  is_expired: boolean;
  can_late_submit: boolean;
  success_url: string;
  cancel_url: string | null;
}

export interface SubmitPaymentResult {
  status: PaymentStatus;
  message: string;
  payment_id: string;
  redirect_url: string;
  attempts_remaining: number;
}
