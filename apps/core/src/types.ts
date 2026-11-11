export interface Env {
  DB: D1Database;
  LOGOS: R2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ENCRYPTION_KEY?: string;
  PUBLIC_BASE_URL: string;
  UNDO_WINDOW_SECONDS: string;
  SUBMITTED_TTL_HOURS: string;
  CREATED_TTL_MINUTES: string;
  LATE_SUBMIT_HOURS: string;
}

export type PaymentMethod = 'cod' | 'bkash' | 'nagad';

export type PaymentStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'PAID'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type VerificationMethod = 'telegram' | 'sms';
